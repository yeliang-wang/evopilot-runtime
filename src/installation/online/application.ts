/** Stopped, journaled online configuration publication. The original request
 * and original bytes survive interruption; this never changes an owner grant. */
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {canonicalEvidence,digest,exact,record,reject} from '../../server/errors.js';
import {readRegular,canonicalPath} from '../../compat/project/files.js';
import {withWorkspaceLease} from '../../compat/workspace-lease.js';
import {createFile,recoverProjectPublications} from '../../compat/project/upgrade.js';
import {acquireQuiescentManagedContext} from '../../compat/managed-store.js';
import {RuntimeStore} from '../../server/store.js';
import {runtimePluginMaterial} from '../../host/plugin.js';
import {readOnlineConfiguration} from '../../host/online.js';
import {nativeSha256} from '../../../vendor/compatibility/v1/native.mjs';
import {verifyInstalledRuntimePackage,type RuntimeInstallPlan} from '../installer.js';
import {inspectInstalledServiceSelection} from '../service-control.js';
import {inspectInstalledHostSelection} from '../host-selection.js';
import {maintenanceLocation,present,requireRecoveryServicesStopped} from '../workspace/snapshot.js';
import {mkdir,save,syncDirectory} from '../workspace/backup.js';
import {hashMaintenanceFile} from '../workspace/stream.js';
import {prepareOnlineConfiguration,validateOnlineConfigurationInput,onlineConfigurationControl,onlineOutputPath,type OnlineConfigurationMaterial,type OnlineConfigurationPatch,type OnlineConfigurationInput} from './configuration.js';

const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex'),equal=(a:unknown,b:unknown)=>canonicalEvidence(a)===canonicalEvidence(b);
const json=(ref:string)=>JSON.parse(readRegular(ref,8388608,true).toString()) as unknown,fileHash=(ref:string)=>sha(readRegular(ref,8388608,true));
const hash=(v:unknown)=>{if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))reject('ONLINE_APPLICATION_INVALID','Expected exact configuration byte pins');};
const fail=():never=>reject('ONLINE_APPLICATION_CHANGED','Inspect the original request: configuration or partial publication differs',409);
function validate(m:OnlineConfigurationMaterial):void{
  exact(record(m),['schema','input','selection','configuration','registration','sourcePins','hostsAfter','hostBefore','hostAfter','patches','authority','filesWritten','serviceStarted','workerStarted','hostReconnectRequired','materialDigest']);
  validateOnlineConfigurationInput(m.input);const {materialDigest,...body}=m;hash(materialDigest);
  if(m.schema!=='runtime-online-configuration-material/v1'||sha(canonicalEvidence(body))!==materialDigest||m.authority!==false||m.filesWritten!==false||m.serviceStarted!==false||m.workerStarted!==false||m.hostReconnectRequired!==true)reject('ONLINE_APPLICATION_INVALID','Use the original exact online configuration material');
  const {selectionDigest,...selected}=m.selection;hash(selectionDigest);
  if(digest(selected)!==selectionDigest||m.selection.serviceRoot!==m.input.serviceRoot||!m.selection.binding)fail();maintenanceLocation(m.input.serviceRoot,false,true);
  const {digest:configDigest,...config}=m.configuration;
  if(configDigest!==nativeSha256(config)||config.workspaceId!==m.selection.workspaceId||!equal(config.settings,m.input.settings)||digest(m.configuration)!==m.registration.digest)fail();
  if(!Array.isArray(m.patches)||m.patches.length<3||m.patches.length>67||!Array.isArray(m.hostsAfter)||m.hostsAfter.length!==m.input.hosts.length)fail();
  const refs=new Set<string>(),configuration=m.patches[0],plugin=m.patches.at(-1)!;
  if(configuration.ref!==m.registration.ref||!equal(JSON.parse(configuration.content),m.configuration)||plugin.ref!==path.join(m.input.serviceRoot,'plugin/.mcp.json'))fail();
  for(const p of m.patches){
    exact(record(p),['ref','before','after','content']);onlineOutputPath(p.ref);hash(p.after);if(p.before!==null)hash(p.before);
    if(refs.has(p.ref)||typeof p.content!=='string'||Buffer.byteLength(p.content)>2097152||sha(p.content)!==p.after)fail();refs.add(p.ref);
    if(p!==configuration&&p!==plugin&&(path.dirname(p.ref)!==m.input.serviceRoot||!/^online-(owner-host|workspace-operator)-[a-f0-9]{64}\.json$/.test(path.basename(p.ref))))fail();
  }
  for(const [ref,pin] of Object.entries(record(m.sourcePins))){canonicalPath(ref);hash(pin);}
}
function retained(m:OnlineConfigurationMaterial):Record<string,unknown>|null {
  const root=onlineConfigurationControl(m.input),ref=path.join(root,'result.json');if(!present(ref))return null;
  const result=record(json(ref)),{resultDigest,...body}=result;
  if(body.schema!=='runtime-online-application-result/v1'||body.materialDigest!==m.materialDigest||body.status!=='APPLIED'||resultDigest!==sha(canonicalEvidence(body))||!equal(json(path.join(root,'material.json')),m))fail();
  return{...result,reused:true,currentEnvironmentVerified:false};
}
function verifyCurrent(m:OnlineConfigurationMaterial):void {
  for(const [ref,pin] of Object.entries(m.sourcePins)){const p=m.patches.find(p=>p.ref===ref),actual=fileHash(ref);if(actual!==pin&&actual!==p?.after)fail();}
  for(const p of m.patches){const actual=present(p.ref)?fileHash(p.ref):null;if(actual!==p.before&&actual!==p.after)fail();}
  const plan=json(path.join(m.input.serviceRoot,'installation-plan.json')) as RuntimeInstallPlan;
  if(digest(plan)!==m.selection.installationPlanDigest)fail();verifyInstalledRuntimePackage(plan,m.input.serviceRoot);
  for(const p of m.patches)if(/^online-(owner-host|workspace-operator)-/.test(path.basename(p.ref))&&Date.parse(String(record(JSON.parse(p.content)).expiresAt))<=Date.now())reject('ONLINE_APPLICATION_EXPIRED','The original selected grant has expired',403);
}
function publish(p:OnlineConfigurationPatch,stage:string):void {
  onlineOutputPath(p.ref);const before=present(p.ref)?fileHash(p.ref):null;if(before===p.after)return;if(before!==p.before)fail();
  mkdir(path.dirname(p.ref));if(p.before===null){createFile(p.ref,Buffer.from(p.content),stage);return;}
  const temporary=path.join(stage,sha(p.ref)+'.pending');if(present(temporary)){readRegular(temporary,8388608,true);fs.unlinkSync(temporary);syncDirectory(stage);}
  const fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try{fs.writeFileSync(fd,p.content);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  if(fileHash(p.ref)!==p.before)fail();fs.renameSync(temporary,p.ref);syncDirectory(path.dirname(p.ref));syncDirectory(stage);
}
function verifyLedger(m:OnlineConfigurationMaterial):void {
  const original=path.join(m.input.serviceRoot,'data/service.sqlite');if(hashMaintenanceFile(original).mode!==0o600)fail();
  for(const suffix of ['-wal','-shm','-journal'])if(present(original+suffix))reject('SERVICE_NOT_QUIESCENT','Close original service handles before configuring online monitoring',409);
  const scratch=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'runtime-online-identity-'));
  try{fs.copyFileSync(original,path.join(scratch,'service.sqlite'));const store=new RuntimeStore(scratch,m.selection.workspaceId);try{if(store.serviceId!==m.selection.serviceId)fail();}finally{store.close();}}finally{fs.rmSync(scratch,{recursive:true,force:true});}
}
export function inspectOnlineApplication(m:OnlineConfigurationMaterial):Record<string,unknown>{
  validate(m);const prior=retained(m);if(prior)return prior;
  const ref=path.join(onlineConfigurationControl(m.input),'material.json');if(present(ref)&&!equal(json(ref),m))reject('REQUEST_CONFLICT','The original request contains different material',409);
  return{schema:'runtime-online-application-inspection/v1',requestId:m.input.requestId,materialDigest:m.materialDigest,status:present(ref)?'INCOMPLETE':'NOT_STARTED',serviceStarted:false,workerStarted:false,authority:false};
}
export async function applyOnlineConfiguration(input:OnlineConfigurationMaterial,signal?:AbortSignal):Promise<Record<string,unknown>>{
  const m=structuredClone(input);validate(m);const prior=retained(m);if(prior)return prior;
  const root=onlineConfigurationControl(m.input),materialRef=path.join(root,'material.json'),binding=m.selection.binding!;
  return withWorkspaceLease({workspaceRoot:binding.workspaceRoot,workspaceId:binding.workspaceId},m.materialDigest,async()=>{
    signal?.throwIfAborted();const completed=retained(m);if(completed)return completed;
    const locks:DatabaseSync[]=[];let legacy:ReturnType<typeof acquireQuiescentManagedContext>|undefined;
    try{
      for(const [relative,code] of [['installer-lock.sqlite','INSTALLER_ACTIVE'],['data/writer-lock.sqlite','WRITER_ACTIVE']]){
        const ref=path.join(m.input.serviceRoot,relative);readRegular(ref,1048576,true);const lock=new DatabaseSync(ref,{allowExtension:false});locks.push(lock);
        try{lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}catch{reject(code,'Stop the original installation operation or service before configuring monitoring',409);}
      }
      await requireRecoveryServicesStopped({...binding,serviceRoot:m.input.serviceRoot});signal?.throwIfAborted();verifyLedger(m);legacy=acquireQuiescentManagedContext(binding);
      if(present(materialRef)){if(!equal(json(materialRef),m))reject('REQUEST_CONFLICT','The original requestId has different configuration material',409);}
      else{
        if(!equal(await prepareOnlineConfiguration(m.input),m))fail();mkdir(path.dirname(root));mkdir(root);save(materialRef,m,false);
      }
      const stage=path.join(root,'staging');mkdir(stage);recoverProjectPublications(stage,m.patches.map(p=>p.ref));verifyCurrent(m);
      const originalsRef=path.join(root,'originals.json');
      if(!present(originalsRef)){const originals=Object.fromEntries(m.patches.filter(p=>p.before!==null).map(p=>{const bytes=readRegular(p.ref,8388608,true);if(sha(bytes)!==p.before)fail();return[p.ref,bytes.toString()];}));save(originalsRef,{schema:'runtime-online-original-config/v1',materialDigest:m.materialDigest,files:originals},false);}
      const originals=record(json(originalsRef)),files=record(originals.files);
      if(originals.materialDigest!==m.materialDigest||!equal(Object.keys(files).sort(),m.patches.filter(p=>p.before!==null).map(p=>p.ref).sort()))fail();
      for(const p of m.patches)if(p.before!==null&&(typeof files[p.ref]!=='string'||sha(String(files[p.ref]))!==p.before))fail();
      for(const p of m.patches){signal?.throwIfAborted();publish(p,stage);}verifyCurrent(m);
      readOnlineConfiguration(m.registration,m.selection.workspaceId);
      const current=inspectInstalledServiceSelection(m.input.serviceRoot);if(!equal(current,m.selection))fail();
      const host=inspectInstalledHostSelection(current);if(!equal(host.before,m.hostAfter))fail();
      const plugin=runtimePluginMaterial(host.spec.packageRoot,path.join(m.input.serviceRoot,'connection.json'),host.spec.nodeExecutable,m.hostAfter);
      for(const [relative,bytes] of plugin.files)if(fileHash(path.join(m.input.serviceRoot,'plugin',relative))!==sha(bytes))fail();
      const body={schema:'runtime-online-application-result/v1',requestId:m.input.requestId,materialDigest:m.materialDigest,status:'APPLIED',configured:true,configurationDigest:m.configuration.digest,workspaceId:m.selection.workspaceId,providerIds:m.configuration.settings.prometheus.map(p=>p.id),alertSourceIds:m.configuration.settings.alertmanager.map(p=>p.id),scopeCount:m.configuration.settings.scopes.length,registration:m.registration,hostsAfter:m.hostsAfter,hostAfter:m.hostAfter,hostReconnectRequired:true,serviceStarted:false,workerStarted:false,businessWorkDispatched:false,authority:false,at:new Date().toISOString()};
      const result={...body,resultDigest:sha(canonicalEvidence(body))};save(path.join(root,'result.json'),result,false);return{...result,reused:false,currentEnvironmentVerified:true};
    }catch(error){
      if(present(materialRef)&&equal(json(materialRef),m)){const code=error&&typeof error==='object'&&'code'in error&&/^[A-Z_]{1,80}$/.test(String(error.code))?String(error.code):'ONLINE_APPLICATION_FAILED';save(path.join(root,'failure-'+randomBytes(12).toString('hex')+'.json'),{materialDigest:m.materialDigest,code,automaticRetry:false,at:new Date().toISOString()},false);}throw error;
    }finally{legacy?.close();for(const lock of locks.reverse())lock.close();}
  },signal);
}
export async function onlineConfigurationCommand(argv:string[]):Promise<unknown>{
  const [operation,flag,ref,...rest]=argv;
  if(rest.length||!ref||!['select','inspect','apply'].includes(operation)||flag!==(operation==='select'?'--input-ref':'--material-ref'))reject('ONLINE_CONFIGURATION_ARGUMENTS','Use online select --input-ref, or inspect|apply --material-ref with the protected original material');
  return operation==='select'?prepareOnlineConfiguration(json(ref) as OnlineConfigurationInput):operation==='inspect'?inspectOnlineApplication(json(ref) as OnlineConfigurationMaterial):applyOnlineConfiguration(json(ref) as OnlineConfigurationMaterial);
}
