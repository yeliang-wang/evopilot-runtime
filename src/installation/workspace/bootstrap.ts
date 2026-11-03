/** Explicit stopped-workspace preparation. This core creates no Runtime
 * connection, does not activate a Host, and never restores the parent daemon. */
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {canonical,digest,exact,record,reject,slug,string} from '../../server/errors.js';
import {canonicalPath,codeRoot,outsideGit,readRegular} from '../../compat/project/files.js';
import {withWorkspaceLease} from '../../compat/workspace-lease.js';
import {acquireLegacyWriterLease,acquireQuiescentManagedContext,type ManagedLegacyBinding} from '../../compat/managed-store.js';
import {readLegacyBinding} from '../../compat/gateway.js';
import {inspectProjectTemplate} from '../../compat/project/templates.js';
import {createFile,recoverProjectPublications} from '../../compat/project/upgrade.js';
import {readIdentity} from '../../location-lineage.js';
import {mkdir,save,syncDirectory} from './backup.js';
import {maintenanceLocation,present,privateDirectory,requireRecoveryServicesStopped,separateRoots} from './snapshot.js';
import {publishedBootstrapOwners,type WorkspaceBootstrapOwners} from './bootstrap-owners.js';

export interface WorkspaceSetupRequest {
  requestId:string;mode:'initialize'|'attach';projectRoot:string;workspaceRoot:string;
  workspaceId:string;serviceRoot:string;owners:{ontology:string;harness:string};
}
interface SetupJournal {
  schema:'runtime-workspace-setup-request/v1';intentDigest:string;selectionDigest:string;
  status:'PREPARED'|'OWNERS_READY'|'PROJECT_READY'|'VERIFIED'|'INTERRUPTED';
  templateDigest:string;result:Record<string,unknown>|null;lastError:string|null;
}
const order=['runtime','ontology','harness'] as const;
const json=(file:string)=>record(JSON.parse(readRegular(file,2097152,true).toString()));
const requestId=(value:unknown)=>{const id=string(value,64);if(!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(id))reject('INVALID_REQUEST','Use an exact retained setup request ID');return id;};
const errorCode=(value:unknown)=>value&&typeof value==='object'&&'code' in value&&typeof value.code==='string'&&/^[A-Z_]{1,64}$/.test(value.code)?value.code:'WORKSPACE_SETUP_FAILED';
function locations(request:WorkspaceSetupRequest):void {
  exact(record(request),['requestId','mode','projectRoot','workspaceRoot','workspaceId','serviceRoot','owners']);requestId(request.requestId);slug(request.workspaceId);
  if(!['initialize','attach'].includes(request.mode))reject('WORKSPACE_SETUP_MODE','Choose initialize or attach');
  canonicalPath(string(request.projectRoot,4096),true);if(present(request.projectRoot))privateDirectory(request.projectRoot);
  maintenanceLocation(string(request.workspaceRoot,4096),true);outsideGit(request.workspaceRoot);
  maintenanceLocation(string(request.serviceRoot,4096),true,true);
  separateRoots([request.projectRoot,request.workspaceRoot,request.serviceRoot,request.workspaceRoot+'.evopilot-control',request.workspaceRoot+'.evopilot-coordination',request.serviceRoot+'.evopilot-setup',request.serviceRoot+'.evopilot-setup.evopilot-coordination']);
  for(const root of [request.projectRoot,request.workspaceRoot])separateRoots([root,codeRoot]);
  exact(record(request.owners),['ontology','harness']);
  for(const owner of ['ontology','harness'] as const){const root=string(request.owners[owner],4096);canonicalPath(root);if(!fs.lstatSync(root).isDirectory())reject('OWNER_CAPABILITY','An exact published owner directory is required');for(const target of [request.projectRoot,request.workspaceRoot])separateRoots([target,root]);}
}
function projectMarker(root:string,id:string):void {
  const marker=json(path.join(root,'workspace-project.json'));exact(marker,['schema','id','templateVersion','specifications']);const specs=record(marker.specifications);exact(specs,['ontology','harness']);
  if(marker.schema!=='evopilot-workspace-project/v1'||marker.id!==id||!['0.1.1','0.2.0'].includes(String(marker.templateVersion))||specs.ontology!=='v1'||specs.harness!=='v1')reject('WORKSPACE_PROJECT_IDENTITY','Project belongs to another Workspace or template contract');
}
function managedBinding(request:WorkspaceSetupRequest):ManagedLegacyBinding|null {
  const ref=path.join(request.serviceRoot,'service-specification.json');
  if(!present(ref)){if(present(request.serviceRoot)&&fs.readdirSync(request.serviceRoot).length)reject('WORKSPACE_SERVICE_UNKNOWN','Finish or reconcile the existing installation before setup');return null;}
  const spec=json(ref);if(spec.schema!=='runtime-user-service/v1'||spec.root!==request.serviceRoot||spec.workspaceId!==request.workspaceId)reject('WORKSPACE_ALREADY_BOUND','The selected service belongs to another Workspace');
  if(spec.legacyRef==null)return null;
  if(spec.legacyRef!==path.join(request.serviceRoot,'legacy-binding.json'))reject('WORKSPACE_ALREADY_BOUND','Service binding is outside the selected installation');
  const binding=readLegacyBinding(spec.legacyRef),connection=json(path.join(request.serviceRoot,'connection.json'));
  if(binding.workspaceRoot!==request.workspaceRoot||binding.workspaceId!==request.workspaceId||connection.serviceId!==binding.serviceId||connection.workspaceId!==request.workspaceId)reject('WORKSPACE_ALREADY_BOUND','An existing service binding cannot switch Workspace');return binding;
}
function noRetiredConnection(request:WorkspaceSetupRequest):void {
  if(present(path.join(request.workspaceRoot+'.evopilot-control','instance.json')))reject('CONNECTION_MUST_STOP','Inspect and stop the original selected connection before setup');
}
function emptyOrAttach(request:WorkspaceSetupRequest):void {
  for(const [root,kind] of [[request.projectRoot,'project'],[request.workspaceRoot,'state']] as const){
    if(!present(root))continue;privateDirectory(root);if(!fs.readdirSync(root).length)continue;
    if(request.mode==='initialize')reject(kind==='project'?'PROJECT_OCCUPIED':'WORKSPACE_OCCUPIED','Initialization cannot adopt occupied locations');
    if(kind==='project')projectMarker(root,request.workspaceId);
  }
  if(request.mode==='attach'){const identity=readIdentity(request.workspaceRoot,request.workspaceId);if(identity.canonicalRoot!==request.workspaceRoot)reject('IDENTITY_MISMATCH','Attach requires the original or verified relocated Workspace identity');}
}
async function withServiceLocks<T>(request:WorkspaceSetupRequest,work:()=>Promise<T>):Promise<T>{
  const locks:DatabaseSync[]=[];
  try{
    for(const [relative,code] of [['data/writer-lock.sqlite','WRITER_ACTIVE'],['installer-lock.sqlite','INSTALLER_ACTIVE']]){
      const file=path.join(request.serviceRoot,relative!);if(!present(file))continue;
      readRegular(file,1048576,true);const lock=new DatabaseSync(file,{allowExtension:false});locks.push(lock);lock.enableDefensive(true);
      try{lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}catch{reject(code!,'Stop the selected Runtime writer or installer before setup',409);}
    }
    return await work();
  }finally{for(const lock of locks.reverse())lock.close();}
}
function makeProject(request:WorkspaceSetupRequest,staging:string):void {
  const template=inspectProjectTemplate(),marker=path.join(request.projectRoot,'workspace-project.json');mkdir(request.projectRoot);mkdir(staging);
  recoverProjectPublications(staging,[marker,...template.files.map(f=>path.join(request.projectRoot,f.relative))]);
  if(present(marker))projectMarker(request.projectRoot,request.workspaceId);
  const directory=(relative:string)=>{let current=request.projectRoot;for(const part of relative.split('/').filter(Boolean)){current=path.join(current,part);mkdir(current);}};
  // Validate all pre-existing destinations before publishing any template file.
  for(const f of template.files){let current=request.projectRoot;for(const part of f.relative.split('/').slice(0,-1)){current=path.join(current,part);if(!present(current))break;privateDirectory(current);}const target=path.join(request.projectRoot,f.relative);if(present(target))readRegular(target);}
  for(const f of template.files){const parent=path.posix.dirname(f.relative);if(parent!=='.')directory(parent);const file=path.join(request.projectRoot,f.relative);if(present(file))readRegular(file);else createFile(file,f.bytes,staging);}
  for(const dir of ['public/ontology','public/harness','private/governance','private/projects'])directory(dir);
  if(!present(marker))createFile(marker,Buffer.from(canonical({schema:'evopilot-workspace-project/v1',id:request.workspaceId,templateVersion:'0.2.0',specifications:{ontology:'v1',harness:'v1'}})+'\n'),staging);
  projectMarker(request.projectRoot,request.workspaceId);syncDirectory(request.projectRoot);
}
/** Public operator entry: dependencies are fixed verified published packages. */
export async function prepareWorkspaceSetup(input:WorkspaceSetupRequest,signal?:AbortSignal,assertCurrent:()=>void=()=>{}):Promise<Record<string,unknown>> {
  locations(input);const owners=await publishedBootstrapOwners(input.owners);return prepareWorkspaceSetupWithOwners(input,owners,signal,assertCurrent);
}
/** Internal trusted composition seam. Synthetic tests do not certify owners. */
export async function prepareWorkspaceSetupWithOwners(input:WorkspaceSetupRequest,owners:WorkspaceBootstrapOwners,signal?:AbortSignal,assertCurrent:()=>void=()=>{}):Promise<Record<string,unknown>> {
  const request=structuredClone(input);locations(request);const current=()=>{signal?.throwIfAborted();assertCurrent();locations(request);noRetiredConnection(request);};current();
  const {requestId:id,mode,...selection}=request,selectionDigest=digest(selection),templateDigest=inspectProjectTemplate().digest,intentDigest=digest({request,templateDigest}),control=request.serviceRoot+'.evopilot-setup';
  const selected=path.join(control,'selection.json'),requests=path.join(control,'requests'),journalPath=path.join(requests,id+'.json');
  return withWorkspaceLease({workspaceRoot:control,workspaceId:request.workspaceId},id,async()=>{
    current();const binding=managedBinding(request);await requireRecoveryServicesStopped(request);current();
    if(present(selected)){
      const prior=json(selected);exact(prior,['schema','selectionDigest','selection','requestId','authority']);if(prior.authority!==false||prior.schema!=='runtime-workspace-setup-selection/v1'||prior.selectionDigest!==selectionDigest||canonical(prior.selection)!==canonical(selection))reject('WORKSPACE_ALREADY_BOUND','This installation already selected a different Workspace');
      if(!present(journalPath)&&prior.requestId!==id){
        const original=json(path.join(requests,requestId(prior.requestId)+'.json'));
        if(original.status!=='VERIFIED'||original.selectionDigest!==selectionDigest)reject('WORKSPACE_SETUP_PENDING','Inspect and continue the exact original setup request');
        const result=record(original.result),{resultDigest,...body}=result;if(resultDigest!==digest(body)||body.selectionDigest!==selectionDigest)reject('WORKSPACE_SETUP_CONFLICT','Retained setup result changed');
        return{...result,reused:true,currentEnvironmentVerified:false};
      }
    }
    let journal:SetupJournal;
    if(present(journalPath)){
      const prior=json(journalPath);exact(prior,['schema','intentDigest','selectionDigest','status','templateDigest','result','lastError']);
      if(prior.schema!=='runtime-workspace-setup-request/v1'||prior.intentDigest!==intentDigest||prior.selectionDigest!==selectionDigest||prior.templateDigest!==templateDigest||!['PREPARED','OWNERS_READY','PROJECT_READY','VERIFIED','INTERRUPTED'].includes(String(prior.status)))reject('WORKSPACE_SETUP_CONFLICT','Original setup request differs');journal=prior as unknown as SetupJournal;
      if(journal.status==='VERIFIED'){const result=record(journal.result),{resultDigest,...body}=result;if(!present(selected)||resultDigest!==digest(body)||body.intentDigest!==intentDigest)reject('WORKSPACE_SETUP_CONFLICT','Original setup result changed');return{...result,reused:true,currentEnvironmentVerified:false};}
    }else{
      emptyOrAttach(request);mkdir(control);mkdir(requests);journal={schema:'runtime-workspace-setup-request/v1',intentDigest,selectionDigest,status:'PREPARED',templateDigest,result:null,lastError:null};save(journalPath,journal,false);
    }
    if(!present(selected))save(selected,{schema:'runtime-workspace-setup-selection/v1',selectionDigest,selection,requestId:id,authority:false},false);
    try{return await withWorkspaceLease({workspaceRoot:request.workspaceRoot,workspaceId:request.workspaceId},'setup-'+intentDigest.slice(0,32),async()=>withServiceLocks(request,async()=>{
      current();await requireRecoveryServicesStopped(request);current();
      const now=managedBinding(request);if(canonical(now)!==canonical(binding))reject('WORKSPACE_SETUP_CONFLICT','Service selection changed during setup');
      let lease:{close:()=>void}|undefined,managed:ReturnType<typeof acquireQuiescentManagedContext>|undefined;
      try{
        if(binding)managed=acquireQuiescentManagedContext(binding);
        else{
          if(present(path.join(request.workspaceRoot,'state/runtime/runtime.db')))lease=acquireLegacyWriterLease(request.workspaceRoot,request.workspaceId);
          await owners.initialize('runtime',{workspaceRoot:request.workspaceRoot,workspaceId:request.workspaceId});current();
          lease??=acquireLegacyWriterLease(request.workspaceRoot,request.workspaceId);
          for(const owner of ['ontology','harness'] as const){await owners.initialize(owner,{workspaceRoot:request.workspaceRoot,workspaceId:request.workspaceId});current();}
        }
        const snapshots:Record<string,unknown>={};
        for(const owner of order){const inspect=()=>owners.inspect(owner,{workspaceRoot:request.workspaceRoot,workspaceId:request.workspaceId}),snapshot=owner==='runtime'&&managed?managed.run(inspect):inspect();
          if(snapshot.product!==owner||snapshot.identity.id!==request.workspaceId||snapshot.identity.canonicalRoot!==request.workspaceRoot)reject('WORKSPACE_SETUP_IDENTITY','An owner returned a different Workspace');snapshots[owner]=snapshot;
        }
        current();journal.status='OWNERS_READY';save(journalPath,journal);
        makeProject(request,path.join(control,'staging-'+intentDigest.slice(0,32)));current();journal.status='PROJECT_READY';save(journalPath,journal);
        const body={schema:'runtime-workspace-setup-result/v1',requestId:id,intentDigest,selectionDigest,selection,mode,status:'PREPARED',templateDigest,ownerSnapshots:snapshots,existingManagedBinding:binding,serviceBindingRequired:binding===null,serviceStarted:false,hostRegistered:false,sessionActivated:false,businessWorkDispatched:false,authority:false,at:new Date().toISOString()},result={...body,resultDigest:digest(body)};
        save(journalPath,{...journal,status:'VERIFIED',result,lastError:null});return{...result,reused:false,currentEnvironmentVerified:true};
      }finally{managed?.close();lease?.close();}
    }),signal);}catch(error){journal.status='INTERRUPTED';journal.lastError=errorCode(error);save(journalPath,journal);throw error;}
  },signal);
}
