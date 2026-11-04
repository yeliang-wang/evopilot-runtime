/** Explicit stopped local configuration transition. Retains the exact request
 * and original bytes, resumes matching partial publication, and never launches
 * services, registers a Host, dispatches business work or changes permissions. */
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {canonical,canonicalEvidence,digest,exact,record,reject,string} from '../../server/errors.js';
import {readRegular,canonicalPath} from '../../compat/project/files.js';
import {createFile,recoverProjectPublications} from '../../compat/project/upgrade.js';
import {withWorkspaceLease} from '../../compat/workspace-lease.js';
import {acquireQuiescentManagedContext} from '../../compat/managed-store.js';
import {RuntimeStore} from '../../server/store.js';
import {runtimePluginMaterial} from '../../host/plugin.js';
import {readRegisteredNativeToolchain} from '../../adapters/config.js';
import {verifyInstalledRuntimePackage,type RuntimeInstallPlan} from '../installer.js';
import {inspectInstalledServiceSelection} from '../service-control.js';
import {maintenanceLocation,present,requireRecoveryServicesStopped} from '../workspace/snapshot.js';
import {mkdir,save,syncDirectory} from '../workspace/backup.js';
import {hashMaintenanceFile} from '../workspace/stream.js';
import {inspectNativeToolchain} from './locked.js';
import {prepareInstalledToolchainRegistration,type ToolchainRegistrationMaterial,type ToolchainRegistrationPatch} from './registration.js';

const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const hash=(v:unknown)=>{if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))reject('TOOLCHAIN_APPLICATION_INVALID','Expected an exact SHA256 binding');};
const json=(ref:string)=>JSON.parse(readRegular(ref,8388608,true).toString()) as unknown;
const fileHash=(ref:string)=>sha(readRegular(ref,8388608,true));
const equal=(a:unknown,b:unknown)=>canonicalEvidence(a)===canonicalEvidence(b);
const fail=():never=>reject('TOOLCHAIN_APPLICATION_CHANGED','Original material, selected configuration or partial publication differs; inspect the retained request',409);
const mutable=['plugin/.mcp.json','service.plist','service-specification.json'];
const control=(m:ToolchainRegistrationMaterial)=>path.join(m.selection.serviceRoot,'toolchain-bindings',m.materialDigest);
function validate(input:ToolchainRegistrationMaterial):void {
  exact(record(input),['schema','selection','registration','sourcePins','hostBefore','hostAfter','specification','patches','dependenciesVerified','authority','filesWritten','serviceStarted','hostReconnectRequired','materialDigest']);
  const {materialDigest,...body}=input;hash(materialDigest);
  if(input.schema!=='runtime-toolchain-registration-material/v1'||input.dependenciesVerified!==true||input.authority!==false||input.filesWritten!==false||input.serviceStarted!==false||input.hostReconnectRequired!==true||sha(canonicalEvidence(body))!==materialDigest)reject('TOOLCHAIN_APPLICATION_INVALID','Use the exact material returned by the fixed bundled dependency selector');
  const selection=record(input.selection);if(!selection.binding)reject('TOOLCHAIN_BINDING_UNBOUND','Select a bound installation');
  maintenanceLocation(string(selection.serviceRoot),false,true);
  const {selectionDigest,...selected}=input.selection;hash(selectionDigest);if(digest(selected)!==selectionDigest)fail();
  if(!Array.isArray(input.patches)||input.patches.length<4||input.patches.length>8)fail();
  const names=new Set<string>();
  for(const p of input.patches){
    exact(record(p),['path','before','after','content']);hash(p.after);if(p.before!==null)hash(p.before);
    if(typeof p.path!=='string'||names.has(p.path)||(!mutable.includes(p.path)&&!/^native-(toolchain|integrations|providers|owner-host|workspace-operator)-[a-f0-9]{64}\.json$/.test(p.path))||typeof p.content!=='string'||sha(p.content)!==p.after)fail();
    if(Buffer.byteLength(p.content)>2097152)reject('TOOLCHAIN_APPLICATION_LIMIT','Configuration patch exceeds its bounded profile',413);names.add(p.path);
  }
  if(!equal(input.patches.slice(-3).map(p=>p.path),mutable)||!equal(JSON.parse(input.patches.at(-1)!.content),input.specification)||input.specification.root!==selection.serviceRoot)fail();
  for(const [ref,pin] of Object.entries(record(input.sourcePins))){canonicalPath(ref);hash(pin);}
}
function retained(m:ToolchainRegistrationMaterial):Record<string,unknown>|null {
  const root=control(m),resultRef=path.join(root,'result.json');if(!present(resultRef))return null;
  const result=record(json(resultRef)),{resultDigest,...body}=result;
  if(body.schema!=='runtime-toolchain-application-result/v1'||body.materialDigest!==m.materialDigest||body.status!=='APPLIED'||resultDigest!==sha(canonicalEvidence(body))||!equal(json(path.join(root,'material.json')),m))fail();
  return{...result,reused:true,currentEnvironmentVerified:false};
}
function verifyCurrent(m:ToolchainRegistrationMaterial):void {
  const root=m.selection.serviceRoot;
  for(const [ref,pin] of Object.entries(m.sourcePins)){
    const patch=m.patches.find(p=>path.join(root,p.path)===ref),actual=fileHash(ref);
    if(actual!==pin&&actual!==patch?.after)fail();
  }
  for(const p of m.patches){const ref=path.join(root,p.path),actual=present(ref)?fileHash(ref):null;if(actual!==p.before&&actual!==p.after)fail();}
  const plan=json(path.join(root,'installation-plan.json')) as RuntimeInstallPlan;
  if(digest(plan)!==m.selection.installationPlanDigest)fail();verifyInstalledRuntimePackage(plan,root);
  const current=inspectNativeToolchain({cacheRoot:path.join(m.selection.binding!.workspaceRoot,'native-toolchain')});
  const manifest=m.patches.find(p=>path.join(root,p.path)===m.registration.path);
  if(!manifest||manifest.content!==canonicalEvidence(current)+'\n'||m.registration.digest!=='sha256:'+manifest.after||m.registration.lockDigest!==current.lockDigest)fail();
  // Expiration is not renewed by a local configuration transition or recovery.
  for(const p of m.patches)if(/^native-(owner-host|workspace-operator|providers)-/.test(p.path)){
    const value=record(JSON.parse(p.content));if(Date.parse(String(value.expiresAt))<=Date.now())reject('TOOLCHAIN_APPLICATION_EXPIRED','The original selected permission has expired',403);
  }
}
function publish(root:string,p:ToolchainRegistrationPatch,stage:string):void {
  const target=path.join(root,p.path);canonicalPath(target,true);
  const before=present(target)?fileHash(target):null;if(before===p.after)return;if(before!==p.before)fail();
  if(p.before===null){createFile(target,Buffer.from(p.content),stage);return;}
  const temporary=path.join(stage,sha(target)+'.pending');
  if(present(temporary)){readRegular(temporary,8388608,true);fs.unlinkSync(temporary);syncDirectory(stage);}
  const fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try{fs.writeFileSync(fd,p.content);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  if(fileHash(target)!==p.before)fail();fs.renameSync(temporary,target);syncDirectory(path.dirname(target));syncDirectory(stage);
}
function verifyLedger(m:ToolchainRegistrationMaterial):void {
  const original=path.join(m.selection.serviceRoot,'data/service.sqlite');
  if(hashMaintenanceFile(original).mode!==0o600)fail();for(const suffix of ['-wal','-shm','-journal'])if(present(original+suffix))reject('SERVICE_NOT_QUIESCENT','Close original service handles before configuration binding',409);
  const root=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'runtime-toolchain-identity-'));
  try{fs.copyFileSync(original,path.join(root,'service.sqlite'));const store=new RuntimeStore(root,m.selection.workspaceId);try{if(store.serviceId!==m.selection.serviceId)fail();}finally{store.close();}}
  finally{fs.rmSync(root,{recursive:true,force:true});}
}
export function inspectToolchainApplication(material:ToolchainRegistrationMaterial):Record<string,unknown> {
  validate(material);const result=retained(material);if(result)return result;
  const root=control(material),ref=path.join(root,'material.json');
  if(present(ref)&&!equal(json(ref),material))fail();
  return{schema:'runtime-toolchain-application-inspection/v1',materialDigest:material.materialDigest,status:present(ref)?'INCOMPLETE':'NOT_STARTED',serviceStarted:false,authority:false};
}
export async function applyInstalledToolchainRegistration(input:ToolchainRegistrationMaterial,signal?:AbortSignal):Promise<Record<string,unknown>> {
  const m=structuredClone(input);validate(m);const prior=retained(m);if(prior)return prior;
  const selection=m.selection,binding=selection.binding!,root=control(m),materialRef=path.join(root,'material.json');
  return withWorkspaceLease({workspaceRoot:binding.workspaceRoot,workspaceId:binding.workspaceId},m.materialDigest,async()=>{
    signal?.throwIfAborted();const completed=retained(m);if(completed)return completed;
    const locks:DatabaseSync[]=[];let legacy:ReturnType<typeof acquireQuiescentManagedContext>|undefined;
    try{
      for(const [relative,code] of [['installer-lock.sqlite','INSTALLER_ACTIVE'],['data/writer-lock.sqlite','WRITER_ACTIVE']]){
        const ref=path.join(selection.serviceRoot,relative);readRegular(ref,1048576,true);const lock=new DatabaseSync(ref,{allowExtension:false});locks.push(lock);
        try{lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}catch{reject(code,'Another operation owns the selected installation or service ledger',409);}
      }
      await requireRecoveryServicesStopped({...binding,serviceRoot:selection.serviceRoot});signal?.throwIfAborted();
      verifyLedger(m);legacy=acquireQuiescentManagedContext(binding);
      if(present(materialRef)){if(!equal(json(materialRef),m))fail();}
      else{
        // This is the only initial admission. Rebuild from verified current
        // bytes; a caller's true flag or recomputed material hash is insufficient.
        if(!equal(prepareInstalledToolchainRegistration(selection.serviceRoot),m))fail();
        mkdir(path.dirname(root));mkdir(root);save(materialRef,m,false);
      }
      const stage=path.join(root,'staging');mkdir(stage);recoverProjectPublications(stage,m.patches.map(p=>path.join(selection.serviceRoot,p.path)));verifyCurrent(m);
      const originalsRef=path.join(root,'originals.json');
      if(!present(originalsRef)){
        const originals=Object.fromEntries(m.patches.filter(p=>p.before!==null).map(p=>{
          const bytes=readRegular(path.join(selection.serviceRoot,p.path),8388608,true);if(sha(bytes)!==p.before)fail();return[p.path,bytes.toString()];
        }));save(originalsRef,{schema:'runtime-toolchain-original-config/v1',materialDigest:m.materialDigest,files:originals},false);
      }
      const originals=record(json(originalsRef));if(originals.materialDigest!==m.materialDigest)fail();
      const files=record(originals.files);if(!equal(Object.keys(files).sort(),m.patches.filter(p=>p.before!==null).map(p=>p.path).sort()))fail();
      for(const p of m.patches)if(p.before!==null&&(typeof files[p.path]!=='string'||sha(String(files[p.path]))!==p.before))fail();
      for(const p of m.patches){signal?.throwIfAborted();publish(selection.serviceRoot,p,stage);}
      verifyCurrent(m);
      const toolchain=readRegisteredNativeToolchain({schema:'runtime-integrations/v1',workspaceId:selection.workspaceId,revision:1,platforms:[],credentials:[],owners:[],resources:[],nativeToolchain:m.registration});
      const plugin=runtimePluginMaterial(m.specification.packageRoot,path.join(selection.serviceRoot,'connection.json'),m.specification.nodeExecutable,m.hostAfter);
      for(const [relative,bytes] of plugin.files)if(fileHash(path.join(selection.serviceRoot,'plugin',relative))!==sha(bytes))fail();
      const current=inspectInstalledServiceSelection(selection.serviceRoot);if(current.serviceId!==selection.serviceId||current.installationPlanDigest!==selection.installationPlanDigest||!equal(current.binding,binding))fail();
      const body={schema:'runtime-toolchain-application-result/v1',materialDigest:m.materialDigest,status:'APPLIED',serviceId:selection.serviceId,specificationDigest:digest(m.specification),registration:m.registration,dependencyFiles:toolchain.dependencyFiles!.length,hostAfter:m.hostAfter,hostReconnectRequired:true,serviceStarted:false,sessionActivated:false,businessWorkDispatched:false,authority:false,at:new Date().toISOString()};
      const result={...body,resultDigest:sha(canonicalEvidence(body))};save(path.join(root,'result.json'),result,false);return{...result,reused:false,currentEnvironmentVerified:true};
    }catch(error){
      if(present(materialRef)&&equal(json(materialRef),m)){const code=error&&typeof error==='object'&&'code'in error&&/^[A-Z_]{1,64}$/.test(String(error.code))?String(error.code):'TOOLCHAIN_APPLICATION_FAILED';save(path.join(root,'failure-'+randomBytes(12).toString('hex')+'.json'),{materialDigest:m.materialDigest,code,automaticRetry:false,at:new Date().toISOString()},false);}throw error;
    }finally{legacy?.close();for(const lock of locks.reverse())lock.close();}
  },signal);
}
export async function toolchainApplicationCommand(args:string[]):Promise<unknown>{
  const [operation,flag,ref,...extra]=args;
  if(extra.length||!ref)reject('TOOLCHAIN_APPLICATION_ARGUMENT','Use toolchain select --root DIR, or inspect|apply --material-ref FILE');
  if(operation==='select'&&flag==='--root')return prepareInstalledToolchainRegistration(ref);
  if(!['inspect','apply'].includes(operation)||flag!=='--material-ref')reject('TOOLCHAIN_APPLICATION_ARGUMENT','Use the exact protected material reference');
  const material=json(ref) as ToolchainRegistrationMaterial;
  return operation==='inspect'?inspectToolchainApplication(material):applyInstalledToolchainRegistration(material);
}
