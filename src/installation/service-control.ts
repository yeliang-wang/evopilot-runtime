/** Explicit local service operations against a current, reviewable installation
 * selection. Does not replay the immutable install plan, register a plugin or
 * expose process control over Runtime HTTP. A selection is identity, not approval. */
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {canonical,digest,exact,record,reject,string} from '../server/errors.js';
import {readHostConnection,readPrivateJson} from '../server/security.js';
import {readRegular,canonicalPath} from '../compat/project/files.js';
import {readLegacyBinding} from '../compat/gateway.js';
import {acquireQuiescentManagedContext,type ManagedLegacyBinding} from '../compat/managed-store.js';
import {withWorkspaceLease} from '../compat/workspace-lease.js';
import {RuntimeStore} from '../server/store.js';
import {verifyInstalledRuntimePackage,type RuntimeInstallPlan} from './installer.js';
import {inspectUserService,observeUserService,startUserService,stopUserService,type UserServiceSpecification} from './service.js';
import {maintenanceLocation,requireRecoveryServicesStopped} from './workspace/snapshot.js';
import {mkdir,save} from './workspace/backup.js';

export interface InstalledServiceSelection {
  schema:'runtime-installed-service-selection/v1';serviceRoot:string;serviceId:string;
  workspaceId:string;installationPlanDigest:string;distributionManifestDigest:string;
  specificationDigest:string;connectionDigest:string;configurationPins:Record<string,string>;
  binding:ManagedLegacyBinding|null;authority:false;selectionDigest:string;
}
export type ServiceControlOperation='inspect'|'start'|'stop';
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const hash=(value:unknown)=>{if(!/^[a-f0-9]{64}$/.test(string(value,64)))reject('SERVICE_SELECTION_INVALID','Expected an exact SHA256 selection');};
const changed=():never=>reject('SERVICE_SELECTION_CHANGED','Current installed service differs from the selected identity; inspect before choosing a new operation',409);

/** Reads the retained original manifest and current bytes, even after disposable
 * downloads or the previous source location are gone. Does not query launchd,
 * open business databases, create a selection file or start a service. */
export function inspectInstalledServiceSelection(serviceRoot:string):InstalledServiceSelection {
  maintenanceLocation(serviceRoot,false,true);
  const pins:Record<string,string>={};
  const pin=(ref:string)=>{canonicalPath(ref);const bytes=readRegular(ref,8388608,true),h=sha(bytes);if(pins[ref]&&pins[ref]!==h)changed();pins[ref]=h;return bytes;};
  const json=(ref:string)=>record(JSON.parse(pin(ref).toString()));
  const plan=json(path.join(serviceRoot,'installation-plan.json')) as unknown as RuntimeInstallPlan;
  const original=verifyInstalledRuntimePackage(plan,serviceRoot);
  const spec=json(path.join(serviceRoot,'service-specification.json')) as unknown as UserServiceSpecification;
  exact(record(spec),['schema','root','packageRoot','version','nodeExecutable','nodeSha256','workspaceId','projectId','principalId','tokenRef','port','integrationsRef'],['legacyRef','legacyProviders']);
  for(const key of ['schema','version','nodeExecutable','nodeSha256','workspaceId','projectId','principalId','port'] as const)if(spec[key]!==original[key])changed();
  if(spec.root!==serviceRoot||spec.packageRoot!==path.join(serviceRoot,'package')||spec.tokenRef!==path.join(serviceRoot,'client.json'))changed();
  if((spec.legacyRef??null)!==null&&spec.legacyRef!==path.join(serviceRoot,'legacy-binding.json'))changed();
  if(original.legacyRef&&!spec.legacyRef||Boolean(original.legacyProviders)!==Boolean(spec.legacyProviders))changed();
  const connectionRef=path.join(serviceRoot,'connection.json');pin(connectionRef);const connection=readHostConnection(connectionRef);
  if(connection.workspaceId!==spec.workspaceId||connection.projectId!==spec.projectId||connection.principalId!==spec.principalId||connection.version!==spec.version||connection.origin!=='http://127.0.0.1:'+spec.port||connection.tokenRef!==spec.tokenRef)changed();
  pin(spec.tokenRef);pin(path.join(serviceRoot,'data/auth.json'));
  if(spec.integrationsRef!==null)json(spec.integrationsRef);
  if(spec.legacyProviders){exact(record(spec.legacyProviders),['ref','digest']);hash(spec.legacyProviders.digest);if(digest(json(spec.legacyProviders.ref))!==spec.legacyProviders.digest)changed();}
  let binding:ManagedLegacyBinding|null=null;
  if(spec.legacyRef){
    pin(spec.legacyRef);binding=readLegacyBinding(spec.legacyRef);
    if(binding.serviceId!==connection.serviceId||binding.workspaceId!==spec.workspaceId)changed();
    // Preserve the original adoption record after relocation. Its location may
    // differ; the signed current database binding is checked before startup.
    const adoption=json(path.join(serviceRoot,'legacy-adoption.json')),seal=record(adoption.seal),{migrationDigest,...body}=seal;
    if(adoption.authority!==false||seal.schema!=='runtime-legacy-adoption/v1'||digest(body)!==migrationDigest||seal.serviceId!==binding.serviceId||seal.workspaceId!==binding.workspaceId)changed();
  }else if(serviceRoot!==plan.root)changed();
  const manifestRef=path.join(serviceRoot,'distribution-manifest.json');pin(manifestRef);
  for(const [ref,pinned] of Object.entries(pins))if(sha(readRegular(ref,8388608,true))!==pinned)changed();
  const body={schema:'runtime-installed-service-selection/v1' as const,serviceRoot,serviceId:connection.serviceId,workspaceId:spec.workspaceId,installationPlanDigest:digest(plan),distributionManifestDigest:pins[manifestRef],specificationDigest:digest(spec),connectionDigest:digest(connection),configurationPins:pins,binding,authority:false as const};
  return{...body,selectionDigest:digest(body)};
}
function validateSelection(input:InstalledServiceSelection):void {
  exact(record(input),['schema','serviceRoot','serviceId','workspaceId','installationPlanDigest','distributionManifestDigest','specificationDigest','connectionDigest','configurationPins','binding','authority','selectionDigest']);
  const {selectionDigest,...body}=input;
  if(input.schema!=='runtime-installed-service-selection/v1'||input.authority!==false||digest(body)!==selectionDigest)reject('SERVICE_SELECTION_INVALID','Select the exact current installed-service descriptor');
  hash(selectionDigest);
  if(canonical(inspectInstalledServiceSelection(input.serviceRoot))!==canonical(input))changed();
}
/** Check identity on a private copy while the installed writer lock is held.
 * Starting a service must never create a replacement ledger to satisfy a file
 * descriptor, or touch the original SQLite file merely to inspect identity. */
function stoppedIdentity(selection:InstalledServiceSelection):void {
  const root=selection.serviceRoot,lockFile=path.join(root,'data/writer-lock.sqlite');readRegular(lockFile,1048576,true);
  const lock=new DatabaseSync(lockFile,{allowExtension:false});let scratch:string|undefined;
  try{
    try{lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}catch{reject('WRITER_ACTIVE','The selected service ledger has another writer',409);}
    const original=path.join(root,'data/service.sqlite');
    for(const suffix of ['-wal','-shm','-journal'])if(fs.existsSync(original+suffix))reject('SERVICE_NOT_QUIESCENT','Stop original writers and close their database handles',409);
    const before=fs.lstatSync(original);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.uid!==process.getuid!()||(before.mode&0o777)!==0o600)reject('SERVICE_SELECTION_INVALID','Unsafe original service ledger');
    scratch=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'runtime-service-identity-'));fs.copyFileSync(original,path.join(scratch,'service.sqlite'));
    const copied=new RuntimeStore(scratch,selection.workspaceId);try{if(copied.serviceId!==selection.serviceId)changed();}finally{copied.close();}
    if(selection.binding){const lease=acquireQuiescentManagedContext(selection.binding);lease.close();}
  }finally{lock.close();if(scratch)fs.rmSync(scratch,{recursive:true,force:true});}
}
export async function operateInstalledService(input:InstalledServiceSelection,operation:ServiceControlOperation):Promise<Record<string,unknown>> {
  const selection=structuredClone(input);if(!['inspect','start','stop'].includes(operation))reject('SERVICE_OPERATION_INVALID','Use inspect, start or stop');validateSelection(selection);
  const spec=readPrivateJson(path.join(selection.serviceRoot,'service-specification.json')) as UserServiceSpecification;
  const verify=()=>validateSelection(selection);
  if(operation==='inspect'){
    const service=await observeUserService(spec);verify();if(service.identity&&service.identity.serviceId!==selection.serviceId)changed();
    return{schema:'runtime-installed-service-observation/v1',selectionDigest:selection.selectionDigest,service,serviceStarted:false,hostRegistered:false,authority:false};
  }
  // A fresh independent install has no legacy Workspace. Its package is inside
  // serviceRoot, so that ancestor must never be passed as a Workspace lease.
  // Reuse the separate operator coordination identity instead; retain both the
  // strict code-directory exclusion and the installed service's exclusive lock.
  const requestId=randomUUID(),context=selection.binding?{workspaceRoot:selection.binding.workspaceRoot,workspaceId:selection.workspaceId}:{workspaceRoot:selection.serviceRoot+'.evopilot-operations',workspaceId:selection.workspaceId};
  return withWorkspaceLease(context,requestId,async()=>{
    verify();const lockFile=path.join(selection.serviceRoot,'installer-lock.sqlite');readRegular(lockFile,1048576,true);
    const lock=new DatabaseSync(lockFile,{allowExtension:false});
    try{
      try{lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}catch{reject('INSTALLER_ACTIVE','Another installer owns the selected service',409);}
      const audit=path.join(selection.serviceRoot,'service-operations');mkdir(audit);
      save(path.join(audit,requestId+'-request.json'),{schema:'runtime-installed-service-operation/v1',requestId,operation,selection,at:new Date().toISOString(),authority:false},false);
      try{
        const before=await inspectUserService(spec);verify();
        if(operation==='start'&&!before.running){
          if(before.registered){await stopUserService(spec);verify();}
          if(selection.binding)await requireRecoveryServicesStopped({...selection.binding,serviceRoot:selection.serviceRoot});
          verify();stoppedIdentity(selection);
        }
        const service=operation==='start'?await startUserService(spec):await stopUserService(spec);verify();
        if('identity' in service&&record(service.identity).serviceId!==selection.serviceId)changed();
        const result={schema:'runtime-installed-service-operation-result/v1',requestId,operation,selectionDigest:selection.selectionDigest,service,hostRegistered:false,businessWorkDispatched:false,authority:false,at:new Date().toISOString()};save(path.join(audit,requestId+'-result.json'),result,false);return result;
      }catch(error){save(path.join(audit,requestId+'-failure.json'),{requestId,operation,code:error&&typeof error==='object'&&'code' in error?String(error.code):'SERVICE_OPERATION_UNKNOWN',automaticRetry:false,at:new Date().toISOString()},false);throw error;}
    }finally{lock.close();}
  });
}
export async function serviceControlCommand(args:string[]):Promise<unknown>{
  const [operation,flag,ref,...extra]=args;
  if(extra.length||!ref)reject('SERVICE_OPERATION_INVALID','Use service select --root DIR, or service inspect|start|stop --selection-ref FILE');
  if(operation==='select'&&flag==='--root')return inspectInstalledServiceSelection(ref);
  if(!['inspect','start','stop'].includes(operation)||flag!=='--selection-ref')reject('SERVICE_OPERATION_INVALID','Use an exact protected current service selection');
  return operateInstalledService(readPrivateJson(ref) as InstalledServiceSelection,operation as ServiceControlOperation);
}
