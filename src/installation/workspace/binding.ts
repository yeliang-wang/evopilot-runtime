/** Stopped, local installation transition. Consume exact preparation and a
 * verified original backup, retain adoption, then publish only operational
 * configuration. Original plans, credentials, service identity and business
 * records are never replaced. No service or Host is started here. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {canonical,digest,exact,record,reject,string} from '../../server/errors.js';
import {readHostConnection,readPrivateJson} from '../../server/security.js';
import {RuntimeStore} from '../../server/store.js';
import {withWorkspaceLease} from '../../compat/workspace-lease.js';
import {canonicalPath,readRegular} from '../../compat/project/files.js';
import {createFile,recoverProjectPublications} from '../../compat/project/upgrade.js';
import {readLegacyOwnerHostConfiguration} from '../../host/legacy-owners.js';
import {runtimePluginMaterial,type LegacyPluginSelection} from '../../host/plugin.js';
import {validateWorkspaceOperatorGrant,type WorkspaceOperatorGrant} from '../../host/workspace.js';
import {readWorkspaceSetupConfiguration} from '../../host/setup.js';
import {verifyInstalledRuntimePackage,type RuntimeInstallPlan} from '../installer.js';
import {adoptLegacyWorkspace,verifyLegacyBackup} from '../migration.js';
import {renderUserServicePlist,type UserServiceSpecification} from '../service.js';
import {mkdir,save,syncDirectory} from './backup.js';
import {maintenanceLocation,present,privateDirectory,requireRecoveryServicesStopped,separateRoots} from './snapshot.js';

export interface WorkspaceBindingRequest {
  schema:'runtime-workspace-binding/v1';requestId:string;serviceRoot:string;
  setupRequestId:string;setupResultDigest:string;installationPlanDigest:string;
  specificationDigest:string;connectionDigest:string;backupRoot:string;backupDigest:string;
  ownerHost:{ref:string;digest:string}|null;workspaceOperator:WorkspaceOperatorGrant|null;
  setupHost?:{ref:string;digest:string};
}
interface Patch {relative:string;before:string|null;after:string;content:string;}
interface Baseline {
  schema:'runtime-workspace-binding-baseline/v1';requestDigest:string;
  specification:UserServiceSpecification;immutable:Record<string,string>;
  before:Record<string,string|null>;
}
const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const json=(file:string)=>record(JSON.parse(readRegular(file,8388608,true).toString()));
const bytes=(v:unknown)=>canonical(v)+'\n';
const id=(v:unknown)=>{const s=string(v,64);if(!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(s))reject('INVALID_REQUEST','Use the retained binding request ID');return s;};
const hash=(v:unknown)=>{if(!/^[a-f0-9]{64}$/.test(string(v,64)))reject('WORKSPACE_BINDING_INPUT','Expected an exact SHA256 digest');};
const fileHash=(file:string)=>sha(readRegular(file,67108864,true));
const fail=():never=>reject('WORKSPACE_BINDING_CHANGED','Prepared Workspace or retained installation differs; inspect the original request',409);
const mutable=['legacy-adoption.json','legacy-binding.json','workspace-operator.json','plugin/.mcp.json','service.plist','service-specification.json'] as const;
function validate(request:WorkspaceBindingRequest):void {
  exact(record(request),['schema','requestId','serviceRoot','setupRequestId','setupResultDigest','installationPlanDigest','specificationDigest','connectionDigest','backupRoot','backupDigest','ownerHost','workspaceOperator'],['setupHost']);
  if(request.schema!=='runtime-workspace-binding/v1')reject('WORKSPACE_BINDING_INPUT','Unsupported binding request');id(request.requestId);id(request.setupRequestId);
  maintenanceLocation(request.serviceRoot,false,true);maintenanceLocation(request.backupRoot);
  for(const field of ['setupResultDigest','installationPlanDigest','specificationDigest','connectionDigest','backupDigest'] as const)hash(request[field]);
  if(request.ownerHost){exact(record(request.ownerHost),['ref','digest']);canonicalPath(request.ownerHost.ref);hash(request.ownerHost.digest);}
  if(request.workspaceOperator){validateWorkspaceOperatorGrant(request.workspaceOperator);if(Date.parse(request.workspaceOperator.expiresAt)<=Date.now())reject('WORKSPACE_OPERATOR_EXPIRED','Selected maintenance grant expired',403);}
  if(request.setupHost){exact(record(request.setupHost),['ref','digest']);const c=readWorkspaceSetupConfiguration(request.setupHost.ref);if(digest(c)!==request.setupHost.digest||c.serviceRoot!==request.serviceRoot||c.installationPlanDigest!==request.installationPlanDigest||c.specificationDigest!==request.specificationDigest||c.connectionDigest!==request.connectionDigest||canonical(c.ownerHost)!==canonical(request.ownerHost)||canonical(c.workspaceOperator)!==canonical(request.workspaceOperator)||Date.parse(c.expiresAt)<=Date.now())reject('SETUP_CONFIGURATION','Retained setup permission differs or expired');}
}
function preparation(request:WorkspaceBindingRequest):Record<string,unknown> {
  const root=request.serviceRoot+'.evopilot-setup',selected=json(path.join(root,'selection.json')),journal=json(path.join(root,'requests',request.setupRequestId+'.json'));
  const result=record(journal.result),{resultDigest,...body}=result,selection=record(body.selection);
  exact(selection,['projectRoot','workspaceRoot','workspaceId','serviceRoot','owners']);
  if(journal.status!=='VERIFIED'||result.schema!=='runtime-workspace-setup-result/v1'||resultDigest!==request.setupResultDigest||digest(body)!==resultDigest||body.requestId!==request.setupRequestId||body.status!=='PREPARED'||body.authority!==false||body.existingManagedBinding!==null||body.serviceBindingRequired!==true||selection.serviceRoot!==request.serviceRoot||selected.selectionDigest!==digest(selection)||journal.selectionDigest!==selected.selectionDigest||canonical(selected.selection)!==canonical(selection)||selected.requestId!==request.setupRequestId)fail();
  maintenanceLocation(string(selection.workspaceRoot));canonicalPath(string(selection.projectRoot));privateDirectory(String(selection.projectRoot));
  const marker=json(path.join(String(selection.projectRoot),'workspace-project.json'));if(marker.schema!=='evopilot-workspace-project/v1'||marker.id!==selection.workspaceId)fail();
  separateRoots([String(selection.projectRoot),String(selection.workspaceRoot),request.serviceRoot,request.backupRoot,root,request.serviceRoot+'.evopilot-binding']);
  return selection;
}
function originalFiles(root:string):Record<string,string> {
  return Object.fromEntries(['installation-plan.json','distribution-manifest.json','connection.json','client.json','data/auth.json','data/service.sqlite'].map(name=>[name,fileHash(path.join(root,name))]));
}
function checkImmutable(root:string,pins:Record<string,string>):void {for(const [name,pin] of Object.entries(pins))if(fileHash(path.join(root,name))!==pin)fail();}
function stoppedServiceIdentity(root:string,workspaceId:string):string {
  const database=path.join(root,'data/service.sqlite');
  for(const suffix of ['-wal','-shm','-journal'])if(present(database+suffix))reject('MAINTENANCE_NOT_QUIESCENT','Close the selected service database before binding');
  const scratch=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'runtime-binding-identity-'));
  try{
    fs.writeFileSync(path.join(scratch,'service.sqlite'),readRegular(database,67108864,true),{mode:0o600,flag:'wx'});
    const store=new RuntimeStore(scratch,workspaceId);try{return store.serviceId;}finally{store.close();}
  }finally{fs.rmSync(scratch,{recursive:true,force:true});}
}
/** Atomic replacement with exact old/new bytes; any other contents fail closed.
 * Pending bytes are retained before rename and can be reconciled by the original
 * request. A process loss cannot leave a partly written active configuration. */
function apply(root:string,patch:Patch,stage:string):void {
  if(!mutable.includes(patch.relative as typeof mutable[number])||sha(patch.content)!==patch.after)fail();
  const target=path.join(root,patch.relative);canonicalPath(target,true);
  const current=present(target)?fileHash(target):null;if(current===patch.after)return;if(current!==patch.before)fail();
  if(patch.before===null){createFile(target,Buffer.from(patch.content),stage);return;}
  const temporary=path.join(stage,sha(target)+'.pending');
  if(present(temporary)){readRegular(temporary,8388608,true);fs.unlinkSync(temporary);syncDirectory(stage);}
  const fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try{fs.writeFileSync(fd,patch.content);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  if(fileHash(target)!==patch.before)fail();fs.renameSync(temporary,target);syncDirectory(path.dirname(target));syncDirectory(stage);
}

export async function bindPreparedWorkspace(input:WorkspaceBindingRequest,signal?:AbortSignal,assertCurrent:()=>void=()=>{}):Promise<Record<string,unknown>> {
  const request=structuredClone(input);validate(request);const requestDigest=digest(request),selection=preparation(request),workspaceId=string(selection.workspaceId,64),workspaceRoot=String(selection.workspaceRoot),control=request.serviceRoot+'.evopilot-binding';
  if(request.setupHost){const c=readWorkspaceSetupConfiguration(request.setupHost.ref);if(c.projectRoot!==selection.projectRoot||c.workspaceRoot!==workspaceRoot||c.workspaceId!==workspaceId||canonical(c.owners)!==canonical(selection.owners))reject('SETUP_SCOPE','Prepared Workspace differs from the installed first-use selection');}
  const current=()=>{signal?.throwIfAborted();assertCurrent();validate(request);if(canonical(preparation(request))!==canonical(selection))fail();};current();
  return withWorkspaceLease({workspaceRoot:control,workspaceId},request.requestId,async()=>{
    current();const chosen=path.join(control,'selection.json'),directory=path.join(control,request.requestId),requestRef=path.join(directory,'request.json'),resultRef=path.join(directory,'result.json');
    if(present(chosen)){const prior=json(chosen);if(prior.requestDigest!==requestDigest||prior.requestId!==request.requestId)reject('WORKSPACE_BINDING_PENDING','Retain the exact original Workspace binding request',409);}
    if(present(resultRef)){
      if(!present(chosen)||digest(json(requestRef))!==requestDigest)fail();const result=json(resultRef),{resultDigest,...body}=result;if(body.requestDigest!==requestDigest||digest(body)!==resultDigest)fail();return{...result,reused:true,currentEnvironmentVerified:false};
    }
    const location={workspaceRoot,workspaceId,serviceRoot:request.serviceRoot};await requireRecoveryServicesStopped(location);current();
    return withWorkspaceLease({workspaceRoot,workspaceId},request.requestId,async()=>{
      current();await requireRecoveryServicesStopped(location);current();
      const lockFile=path.join(request.serviceRoot,'installer-lock.sqlite');readRegular(lockFile,1048576,true);const lock=new DatabaseSync(lockFile,{allowExtension:false});let writer:DatabaseSync|undefined;
      try{
        try{lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}catch{reject('INSTALLER_ACTIVE','Another installer owns the selected installation',409);}
        const plan=readPrivateJson(path.join(request.serviceRoot,'installation-plan.json')) as RuntimeInstallPlan;
        if(digest(plan)!==request.installationPlanDigest||plan.root!==request.serviceRoot||plan.workspaceId!==workspaceId||plan.legacyMigration||plan.legacyProviders||plan.legacyOwnerHost||plan.workspaceOperator)fail();
        const originalSpec=verifyInstalledRuntimePackage(plan),connection=readHostConnection(path.join(request.serviceRoot,'connection.json'));
        if(digest(originalSpec)!==request.specificationDigest||digest(connection)!==request.connectionDigest||connection.workspaceId!==workspaceId||connection.projectId!==plan.projectId||connection.principalId!==plan.principalId||connection.version!==originalSpec.version||connection.origin!=='http://127.0.0.1:'+plan.port||connection.tokenRef!==originalSpec.tokenRef)fail();
        const backup=verifyLegacyBackup(request.backupRoot,request.backupDigest);
        if(backup.snapshot.workspaceRoot!==workspaceRoot||backup.snapshot.workspaceId!==workspaceId)fail();
        const owner=request.ownerHost?readLegacyOwnerHostConfiguration(request.ownerHost.ref):null;
        if(owner&&(digest(owner)!==request.ownerHost!.digest||owner.workspaceId!==workspaceId||owner.projectId!==plan.projectId||owner.legacyBindingRef!==path.join(request.serviceRoot,'legacy-binding.json')||Object.entries(owner.owners).some(([name,v])=>v.packageRoot!==record(selection.owners)[name])))fail();
        const grant=request.workspaceOperator;
        if(grant&&(grant.projectRoot!==selection.projectRoot||canonical(grant.owners)!==canonical(selection.owners)))fail();
        const writerFile=path.join(request.serviceRoot,'data/writer-lock.sqlite');readRegular(writerFile,1048576,true);writer=new DatabaseSync(writerFile,{allowExtension:false});
        try{writer.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}catch{reject('WRITER_ACTIVE','Stop the selected independent writer before binding',409);}
        const serviceId=stoppedServiceIdentity(request.serviceRoot,workspaceId);if(serviceId!==connection.serviceId)fail();
        mkdir(control);mkdir(directory);const stage=path.join(directory,'staging');mkdir(stage);
        const baselineRef=path.join(directory,'baseline.json');let baseline:Baseline;
        if(present(baselineRef)){
          baseline=json(baselineRef) as unknown as Baseline;
          if(baseline.schema!=='runtime-workspace-binding-baseline/v1'||baseline.requestDigest!==requestDigest||canonical(baseline.specification)!==canonical(originalSpec)||digest(json(requestRef))!==requestDigest)fail();
        }else{
          if(digest(json(path.join(request.serviceRoot,'service-specification.json')))!==request.specificationDigest)fail();
          for(const name of ['legacy-adoption.json','legacy-binding.json','workspace-operator.json'])if(present(path.join(request.serviceRoot,name)))fail();
          const before=Object.fromEntries(mutable.map(name=>[name,present(path.join(request.serviceRoot,name))?fileHash(path.join(request.serviceRoot,name)):null]));
          if(before['plugin/.mcp.json']===null)fail();
          baseline={schema:'runtime-workspace-binding-baseline/v1',requestDigest,specification:originalSpec,immutable:originalFiles(request.serviceRoot),before};
          save(requestRef,request,false);save(baselineRef,baseline,false);
        }
        save(chosen,{schema:'runtime-workspace-binding-selection/v1',requestId:request.requestId,requestDigest,authority:false},false);
        checkImmutable(request.serviceRoot,baseline.immutable);current();
        recoverProjectPublications(stage,mutable.map(name=>path.join(request.serviceRoot,name)));
        const liveSpecification=json(path.join(request.serviceRoot,'service-specification.json'));
        if(![request.specificationDigest,digest({...originalSpec,legacyRef:path.join(request.serviceRoot,'legacy-binding.json')})].includes(digest(liveSpecification)))fail();
        // Adoption's own committed seal reconciles process loss before any
        // configuration receipt was written. It never resets existing data.
        const adopted=adoptLegacyWorkspace({workspaceRoot,workspaceId,serviceId,expectedSnapshotDigest:backup.snapshot.snapshotDigest,backupRoot:request.backupRoot,expectedBackupDigest:request.backupDigest});
        const make=(relative:string,content:string):Patch=>({relative,before:baseline.before[relative],after:sha(content),content});
        const patch=(relative:string,content:string)=>apply(request.serviceRoot,make(relative,content),stage);
        patch('legacy-adoption.json',bytes(adopted));patch('legacy-binding.json',bytes(adopted.binding));
        const specification={...originalSpec,legacyRef:path.join(request.serviceRoot,'legacy-binding.json')},legacy:LegacyPluginSelection=owner?{ownerConfigRef:request.ownerHost!.ref,ownerConfigDigest:request.ownerHost!.digest}:{};
        if(grant){
          const config={schema:'runtime-workspace-operator/v1',selection:{...adopted.binding,projectRoot:grant.projectRoot,serviceRoot:request.serviceRoot,referenceFiles:grant.referenceFiles},specificationDigest:digest(specification),connectionRef:path.join(request.serviceRoot,'connection.json'),owners:grant.owners,ownerHost:{...legacy},calls:grant.calls,expiresAt:grant.expiresAt};
          patch('workspace-operator.json',bytes(config));legacy.workspaceConfigRef=path.join(request.serviceRoot,'workspace-operator.json');legacy.workspaceConfigDigest=digest(config);
        }
        if(request.setupHost){legacy.setupConfigRef=request.setupHost.ref;legacy.setupConfigDigest=request.setupHost.digest;}
        const material=runtimePluginMaterial(specification.packageRoot,path.join(request.serviceRoot,'connection.json'),specification.nodeExecutable,legacy);
        for(const [name,content] of material.files)if(name!=='.mcp.json'&&!readRegular(path.join(request.serviceRoot,'plugin',name),65536,true).equals(content))fail();
        // The service specification is last: until the complete local route
        // configuration exists, no new bound service may start successfully.
        const patches=[make('plugin/.mcp.json',material.files.get('.mcp.json')!.toString()),make('service.plist',renderUserServicePlist(specification)),make('service-specification.json',bytes(specification))];
        const materialRef=path.join(directory,'material.json');save(materialRef,{schema:'runtime-workspace-binding-material/v1',requestDigest,patches},false);
        for(const p of patches){current();checkImmutable(request.serviceRoot,baseline.immutable);apply(request.serviceRoot,p,stage);}
        for(const p of patches)if(fileHash(path.join(request.serviceRoot,p.relative))!==p.after)fail();checkImmutable(request.serviceRoot,baseline.immutable);
        const body={schema:'runtime-workspace-binding-result/v1',requestId:request.requestId,requestDigest,setupResultDigest:request.setupResultDigest,status:'BOUND',binding:adopted.binding,specificationDigest:digest(specification),connectionDigest:request.connectionDigest,originalInstallationPlanDigest:request.installationPlanDigest,backupDigest:request.backupDigest,ownerHost:legacy,serviceStarted:false,hostRegistered:false,sessionActivated:false,businessWorkDispatched:false,authority:false,at:new Date().toISOString()};
        const result={...body,resultDigest:digest(body)};save(resultRef,result,false);return{...result,reused:false,currentEnvironmentVerified:true};
      }catch(error){
        if(present(requestRef)&&digest(json(requestRef))===requestDigest){const code=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^[A-Z_]{1,64}$/.test(error.code)?error.code:'WORKSPACE_BINDING_FAILED';save(path.join(directory,'failure-'+randomBytes(12).toString('hex')+'.json'),{schema:'runtime-workspace-binding-failure/v1',requestDigest,code,at:new Date().toISOString(),automaticRedispatch:false},false);}
        throw error;
      }finally{writer?.close();lock.close();}
    },signal);
  },signal);
}
