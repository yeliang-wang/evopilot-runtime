/** Operator-only, same-host preservation snapshots. No source business database
 * is opened by SQLite; validation runs on private copies. This is evidence of
 * byte/record preservation, never semantic acceptance or permission to restart. */
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {canonicalPath,codeRoot,fail,fields,outsideGit,readRegular} from '../../compat/project/files.js';
import {withWorkspaceLease} from '../../compat/workspace-lease.js';
import {legacyWorkspace,resolvedManagedBinding,acquireQuiescentManagedContext,type ManagedLegacyBinding} from '../../compat/managed-store.js';
import {readIdentity,readRelocations} from '../../location-lineage.js';
import {RuntimeStore} from '../../server/store.js';
import {inspectAllTables} from '../../compat/table-inventory.js';
import {copyMaintenanceFile,hashMaintenanceFile,inspectMaintenanceTree,maintenanceJSONDigest,type MaintenanceEntry} from './stream.js';

export interface WorkspaceSelection extends ManagedLegacyBinding {
  projectRoot:string;serviceRoot:string;referenceFiles:string[];
}
export interface PreservedReference {path:string;bytes:number;sha256:string;mode:number;}
export interface DatabaseInventory {
  owner:'runtime'|'ontology'|'harness'|'service';path:string;schemaVersion:number;schemaDigest:string;
  tables:{name:string;rows:number;sha256:string}[];requiredKeyIds:string[];
}
export interface ManagedWorkspaceSnapshot {
  schema:'runtime-managed-workspace-snapshot/v1';selection:WorkspaceSelection;
  roots:{project:MaintenanceEntry[];workspace:MaintenanceEntry[];service:MaintenanceEntry[]};
  databases:DatabaseInventory[];references:PreservedReference[];requiredKeyIds:string[];
  transientExclusions:{workspace:string[];service:string[]};
  coverage:'SELECTED_ROOTS_AND_REFERENCE_FILES';authority:false;snapshotDigest:string;
}
const execute=promisify(execFile),owners=['runtime','ontology','harness'] as const;
export function present(filename:string):boolean {
  try{fs.lstatSync(filename);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}
export function privateDirectory(root:string):void {
  canonicalPath(root);const st=fs.lstatSync(root);
  if(!st.isDirectory()||st.uid!==process.getuid!()||(st.mode&0o777)!==0o700)fail('MAINTENANCE_PERMISSIONS');
}
export function separateRoots(roots:string[]):void {
  for(let i=0;i<roots.length;i++)for(let j=i+1;j<roots.length;j++)if(roots[i]===roots[j]||roots[i].startsWith(roots[j]+path.sep)||roots[j].startsWith(roots[i]+path.sep))fail('MAINTENANCE_LOCATION');
}
export function maintenanceLocation(root:string,missing=false,installedService=false):void {
  canonicalPath(root,missing);outsideGit(root);
  if(root===path.parse(root).root||root===codeRoot||root.startsWith(codeRoot+path.sep))fail('MAINTENANCE_LOCATION');
  if(codeRoot.startsWith(root+path.sep)){
    // An installed operator must be able to preserve its own selected service
    // package. This narrow installer layout is not permission to back up a
    // source checkout, arbitrary ancestor or a parent product installation.
    if(!installedService||codeRoot!==path.join(root,'package')||present(path.join(codeRoot,'.git')))fail('MAINTENANCE_LOCATION');
    const spec=JSON.parse(readRegular(path.join(root,'service-specification.json'),1048576,true).toString()) as Record<string,unknown>;
    const pkg=JSON.parse(readRegular(path.join(codeRoot,'package.json')).toString()) as Record<string,unknown>;
    if(spec.schema!=='runtime-user-service/v1'||spec.root!==root||spec.packageRoot!==codeRoot||pkg.name!=='@evopilot-next/runtime'||spec.version!==pkg.version)fail('MAINTENANCE_LOCATION');
  }
  if(present(root))privateDirectory(root);
}
function selectionLocations(selection:WorkspaceSelection,missing=false):void {
  fields(selection,['projectRoot','workspaceRoot','workspaceId','serviceRoot','serviceId','migrationDigest','referenceFiles']);
  if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(selection.workspaceId)||typeof selection.serviceId!=='string'||!selection.serviceId||selection.serviceId.length>128||!/^[a-f0-9]{64}$/.test(selection.migrationDigest))fail('MAINTENANCE_IDENTITY');
  if(!Array.isArray(selection.referenceFiles)||selection.referenceFiles.length>128||selection.referenceFiles.some(v=>typeof v!=='string')||new Set(selection.referenceFiles).size!==selection.referenceFiles.length)fail('MAINTENANCE_REFERENCE');
  const roots=[selection.projectRoot,selection.workspaceRoot,selection.serviceRoot];roots.forEach((r,i)=>maintenanceLocation(r,missing,i===2));separateRoots(roots);
}
export function validateSelection(selection:WorkspaceSelection):void {
  selectionLocations(selection);
  const project=JSON.parse(readRegular(path.join(selection.projectRoot,'workspace-project.json')).toString()) as Record<string,unknown>;
  if(project.schema!=='evopilot-workspace-project/v1'||project.id!==selection.workspaceId)fail('MAINTENANCE_IDENTITY');
  readIdentity(selection.workspaceRoot,selection.workspaceId);
}
function quietDatabase(filename:string):void {
  for(const suffix of ['-wal','-shm','-journal'])if(present(filename+suffix))fail('MAINTENANCE_NOT_QUIESCENT','Stop writers and close their SQLite connections; never delete sidecars');
}
function references(selection:WorkspaceSelection):PreservedReference[] {
  const spec=JSON.parse(readRegular(path.join(selection.serviceRoot,'service-specification.json'),1048576,true).toString()) as Record<string,unknown>;
  if(spec.schema!=='runtime-user-service/v1'||spec.root!==selection.serviceRoot||spec.workspaceId!==selection.workspaceId||typeof spec.legacyRef!=='string')fail('MAINTENANCE_IDENTITY');
  const refs=[...selection.referenceFiles,spec.tokenRef,spec.integrationsRef,spec.legacyRef];
  if(spec.legacyProviders!=null){fields(spec.legacyProviders,['ref','digest']);refs.push(spec.legacyProviders.ref);}
  const binding=JSON.parse(readRegular(spec.legacyRef,16384,true).toString()) as Record<string,unknown>;
  for(const key of ['workspaceRoot','workspaceId','serviceId','migrationDigest'] as const)if(binding[key]!==selection[key])fail('MAINTENANCE_IDENTITY');
  const result:PreservedReference[]=[];
  for(const ref of [...new Set(refs.filter(v=>v!==null&&v!==undefined))]){
    if(typeof ref!=='string')fail('MAINTENANCE_REFERENCE');canonicalPath(ref);outsideGit(path.dirname(ref));
    // Files inside a selected tree are already covered in its exact inventory.
    const file=hashMaintenanceFile(ref);
    if([selection.projectRoot,selection.workspaceRoot,selection.serviceRoot].some(root=>ref.startsWith(root+path.sep)))continue;
    result.push({path:ref,...file});
  }
  return result.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
function copyDatabase(source:string,destination:string,entry:MaintenanceEntry):void {
  quietDatabase(source);copyMaintenanceFile(source,destination,entry);
}
function databases(selection:WorkspaceSelection,roots:ManagedWorkspaceSnapshot['roots']):DatabaseInventory[] {
  const scratch=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'runtime-workspace-snapshot-'));
  try{
    const result:DatabaseInventory[]=[],identity=readIdentity(selection.workspaceRoot,selection.workspaceId);
    for(const owner of [...owners,'service'] as const){
      const relative=owner==='service'?'data/service.sqlite':'state/'+owner+'/'+owner+'.db';
      const root=owner==='service'?selection.serviceRoot:selection.workspaceRoot;
      const entry=(owner==='service'?roots.service:roots.workspace).find(v=>v.path===relative);
      if(!entry||entry.kind!=='file')fail('MAINTENANCE_DATABASE');
      const directory=path.join(scratch,owner);fs.mkdirSync(directory,{mode:0o700});
      const copied=path.join(directory,'service.sqlite');copyDatabase(path.join(root,relative),copied,entry);
      const db=new DatabaseSync(copied,{readOnly:true,allowExtension:false});let inventory:DatabaseInventory;
      try{
        db.enableDefensive(true);db.exec('BEGIN');
        const schemaVersion=Number(db.prepare('PRAGMA user_version').get()?.user_version),all=inspectAllTables(db);
        if(owner==='runtime'){
          const seal=resolvedManagedBinding(db,identity);if(!seal)fail('MAINTENANCE_IDENTITY');
          for(const key of ['workspaceRoot','workspaceId','serviceId','migrationDigest'] as const)if(seal[key]!==selection[key])fail('MAINTENANCE_IDENTITY');
        }
        const lineage=owner==='service'?[]:readRelocations(db,identity,owner);
        inventory={owner,path:relative,schemaVersion,...all,requiredKeyIds:[...new Set(lineage.map(v=>v.keyId))].sort()};
      }finally{db.close();}
      if(owner==='service'){
        // RuntimeStore validates its complete receipt/audit/event ledger only
        // on this disposable copy, never on the original selected state.
        const store=new RuntimeStore(directory,selection.workspaceId);
        try{if(inventory.schemaVersion!==1||store.serviceId!==selection.serviceId)fail('MAINTENANCE_IDENTITY');}finally{store.close();}
      }
      result.push(inventory);
    }
    return result;
  }finally{fs.rmSync(scratch,{recursive:true,force:true});}
}
async function onlineWorkerStopped(selection:WorkspaceSelection):Promise<void> {
  if(process.platform!=='darwin'){
    if(present(selection.workspaceRoot+'.evopilot-online-worker'))fail('MAINTENANCE_WORKER_INSPECTION');return;
  }
  const label='io.evopilot.online.'+createHash('sha256').update(selection.workspaceRoot+'\0'+selection.workspaceId).digest('hex').slice(0,24);
  try{await execute('/bin/launchctl',['print','gui/'+process.getuid!()+'/'+label],{timeout:5000,maxBuffer:1048576});}
  catch(error){const e=error as {stderr?:string};if(e.stderr?.includes('Could not find service')&&e.stderr.includes('"'+label+'"'))return;fail('MAINTENANCE_WORKER_INSPECTION');}
  fail('ONLINE_WORKER_ACTIVE','Stop the separately owned online worker before maintenance');
}
/** Both normal capture and recovery hold the same original writer locks. */
type ManagedRunner=<T>(callback:()=>T)=>T;
async function withWriterLocks<T>(selection:WorkspaceSelection,callback:(capture:()=>ManagedWorkspaceSnapshot,managed:ManagedRunner)=>T|Promise<T>,signal?:AbortSignal,managed=false):Promise<T> {
    const originalLock=path.join(selection.workspaceRoot,'state/runtime-service/writer-lock.sqlite');
    const lockPath=path.join(selection.serviceRoot,'data/writer-lock.sqlite');
    const installer=path.join(selection.serviceRoot,'installer-lock.sqlite');
    const lockFiles=[originalLock,lockPath,...(present(installer)?[installer]:[])];
    for(const file of lockFiles){
      privateDirectory(path.dirname(file));
      const st=fs.lstatSync(canonicalPath(file));if(!st.isFile()||st.uid!==process.getuid!()||st.nlink!==1||(st.mode&0o777)!==0o600||st.size!==0)fail('MAINTENANCE_PERMISSIONS');
      for(const suffix of ['-wal','-shm','-journal'])if(present(file+suffix)){
        const sidecar=fs.lstatSync(canonicalPath(file+suffix));if(!sidecar.isFile()||sidecar.uid!==process.getuid!()||sidecar.nlink!==1||(sidecar.mode&0o777)!==0o600||sidecar.size>1048576)fail('MAINTENANCE_PERMISSIONS');
      }
    }
    const locks:DatabaseSync[]=[];let active=true,context:ReturnType<typeof acquireQuiescentManagedContext>|undefined;
    try{
      for(const [i,file] of lockFiles.entries()){
        if(i===0&&managed){const {workspaceRoot,workspaceId,serviceId,migrationDigest}=selection;context=acquireQuiescentManagedContext({workspaceRoot,workspaceId,serviceId,migrationDigest});continue;}
        const lock=new DatabaseSync(file,{allowExtension:false});locks.push(lock);lock.enableDefensive(true);
        try{lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}catch{fail(i===0?'LEGACY_WRITER_ACTIVE':i===1?'WRITER_ACTIVE':'INSTALLER_ACTIVE','Stop Runtime writers and installers before maintenance');}
      }
      const capture=():ManagedWorkspaceSnapshot=>{
        if(!active)fail('MAINTENANCE_CLOSED');
        signal?.throwIfAborted();validateSelection(selection);legacyWorkspace(selection.workspaceRoot,selection.workspaceId);
        for(const owner of owners)quietDatabase(path.join(selection.workspaceRoot,'state',owner,owner+'.db'));
        quietDatabase(path.join(selection.serviceRoot,'data/service.sqlite'));
        // BEGIN EXCLUSIVE on an empty lock file creates a temporary journal
        // with a fresh SQLite nonce. These live writer/installer lease journals contain no
        // business state and must not be copied into a stopped backup. Keep
        // every other file, including the zero-byte lock files themselves.
        const transientExclusions={workspace:['state/runtime-service/writer-lock.sqlite-journal'],service:['data/writer-lock.sqlite-journal',...(present(installer)?['installer-lock.sqlite-journal']:[])]};
        const trees=()=>({project:inspectMaintenanceTree(selection.projectRoot),workspace:inspectMaintenanceTree(selection.workspaceRoot).filter(e=>!transientExclusions.workspace.includes(e.path)),service:inspectMaintenanceTree(selection.serviceRoot).filter(e=>!transientExclusions.service.includes(e.path))});
        const roots=trees(),refs=references(selection),dbs=databases(selection,roots);
        if(maintenanceJSONDigest(roots)!==maintenanceJSONDigest(trees())||maintenanceJSONDigest(refs)!==maintenanceJSONDigest(references(selection)))fail('MAINTENANCE_DRIFT');
        const body={schema:'runtime-managed-workspace-snapshot/v1' as const,selection:structuredClone(selection),roots,databases:dbs,references:refs,requiredKeyIds:[...new Set(dbs.flatMap(d=>d.requiredKeyIds))].sort(),transientExclusions,coverage:'SELECTED_ROOTS_AND_REFERENCE_FILES' as const,authority:false as const};
        return{...body,snapshotDigest:maintenanceJSONDigest(body)};
      };
      const run:ManagedRunner=fn=>{if(!active||!context)fail('MAINTENANCE_CLOSED');return context.run(fn);};
      return await callback(capture,run);
    }finally{active=false;for(const lock of locks.reverse())lock.close();context?.close();}
}

/** No automatic stop/restart. The operator first stops the exact owned service. */
export async function withQuiescentWorkspace<T>(input:WorkspaceSelection,requestId:string,callback:(capture:()=>ManagedWorkspaceSnapshot)=>T|Promise<T>,signal?:AbortSignal):Promise<T> {
  const selection=structuredClone(input);validateSelection(selection);
  return withWorkspaceLease({workspaceRoot:selection.workspaceRoot,workspaceId:selection.workspaceId},requestId,async()=>{
    await onlineWorkerStopped(selection);signal?.throwIfAborted();legacyWorkspace(selection.workspaceRoot,selection.workspaceId);
    return withWriterLocks(selection,callback,signal);
  },signal);
}
/** Recovery of this macOS user-service deployment must not leave a loaded
 * KeepAlive job capable of starting against a partial restored tree. No job is
 * stopped or killed by this primitive, and no PID is selected by the caller. */
export async function requireRecoveryServicesStopped(selection:WorkspaceSelection):Promise<void> {
  if(process.platform!=='darwin')fail('MAINTENANCE_RESTORE_PLATFORM');
  await onlineWorkerStopped(selection);
  const label='io.evopilot.runtime.'+selection.workspaceId+'.'+createHash('sha256').update(selection.serviceRoot).digest('hex').slice(0,16);
  try{await execute('/bin/launchctl',['print','gui/'+process.getuid!()+'/'+label],{timeout:5000,maxBuffer:1048576});}
  catch(error){const e=error as {stderr?:string};if(e.stderr?.includes('Could not find service')&&e.stderr.includes('"'+label+'"'))return;fail('MAINTENANCE_SERVICE_INSPECTION');}
  fail('SERVICE_ACTIVE','Unload the exact selected Runtime user service before restoring');
}
/** Internal operator composition: prepare validates retained restore authority
 * and creates only its missing/empty destination scaffolding. Shared Host
 * exclusion is already held; no nested workspace lease is acquired. */
export async function withRestoringWorkspace<T>(input:WorkspaceSelection,requestId:string,prepare:()=>void,callback:(capture:()=>ManagedWorkspaceSnapshot)=>T|Promise<T>,signal?:AbortSignal):Promise<T> {
  const selection=structuredClone(input);selectionLocations(selection,true);
  return withWorkspaceLease({workspaceRoot:selection.workspaceRoot,workspaceId:selection.workspaceId},requestId,async()=>{
    await requireRecoveryServicesStopped(selection);signal?.throwIfAborted();prepare();
    return withWriterLocks(selection,callback,signal);
  },signal);
}
export async function inspectManagedWorkspace(selection:WorkspaceSelection,requestId:string,signal?:AbortSignal):Promise<ManagedWorkspaceSnapshot> {
  return withQuiescentWorkspace(selection,requestId,capture=>capture(),signal);
}

export interface RelocatingWorkspaceContext {
  captureSource:()=>ManagedWorkspaceSnapshot;
  captureDestination:(binding:ManagedLegacyBinding)=>ManagedWorkspaceSnapshot;
  runSource:ManagedRunner;
}
/** Operator composition only. Hold both shared leases in canonical order, then
 * the original managed writer, both service writers and available installer
 * locks. The callback may copy/attest destination data; it cannot keep a usable
 * managed capability after the leases are closed. No service is stopped here. */
export async function withRelocatingWorkspaces<T>(sourceInput:WorkspaceSelection,destinationInput:WorkspaceSelection,requestId:string,prepare:()=>void,callback:(context:RelocatingWorkspaceContext)=>T|Promise<T>,signal?:AbortSignal):Promise<T> {
  const source=structuredClone(sourceInput),destination=structuredClone(destinationInput);
  validateSelection(source);selectionLocations(destination,true);
  if(source.workspaceId!==destination.workspaceId||source.serviceId!==destination.serviceId)fail('MAINTENANCE_IDENTITY');
  separateRoots([source.projectRoot,source.workspaceRoot,source.serviceRoot,destination.projectRoot,destination.workspaceRoot,destination.serviceRoot]);
  const ordered=[source,destination].sort((a,b)=>a.workspaceRoot.localeCompare(b.workspaceRoot));
  const lease=(i:number,fn:()=>Promise<T>)=>withWorkspaceLease({workspaceRoot:ordered[i].workspaceRoot,workspaceId:ordered[i].workspaceId},requestId,fn,signal);
  return lease(0,()=>lease(1,async()=>{
    await requireRecoveryServicesStopped(source);await requireRecoveryServicesStopped(destination);signal?.throwIfAborted();
    return withWriterLocks(source,(captureSource,runSource)=>{
      prepare();signal?.throwIfAborted();
      return withWriterLocks(destination,capture=>callback({captureSource,runSource,captureDestination(binding){
        fields(binding,['workspaceRoot','workspaceId','serviceId','migrationDigest']);
        if(binding.workspaceRoot!==destination.workspaceRoot||binding.workspaceId!==destination.workspaceId||binding.serviceId!==destination.serviceId||!/^[a-f0-9]{64}$/.test(binding.migrationDigest))fail('MAINTENANCE_IDENTITY');
        destination.migrationDigest=binding.migrationDigest;return capture();
      }}),signal);
    },signal,true);
  }));
}

/** The earlier v1 manifest listed only the two writer journals. Adding an
 * installer lease changes no preserved payload. Permit only that exact metadata
 * difference; selections, every file/table/reference and all other fields match. */
export function preservationSnapshotMatches(actual:ManagedWorkspaceSnapshot,expected:ManagedWorkspaceSnapshot):boolean {
  if(actual.snapshotDigest===expected.snapshotDigest)return true;
  if(maintenanceJSONDigest(actual.transientExclusions.workspace)!==maintenanceJSONDigest(expected.transientExclusions.workspace))return false;
  const expectedService=expected.transientExclusions.service,actualService=actual.transientExclusions.service;
  if(expectedService.length!==1||expectedService[0]!=='data/writer-lock.sqlite-journal'||actualService.length!==2||actualService[0]!==expectedService[0]||actualService[1]!=='installer-lock.sqlite-journal')return false;
  const {snapshotDigest,...body}=actual;
  return maintenanceJSONDigest({...body,transientExclusions:expected.transientExclusions})===expected.snapshotDigest;
}
export function heldMaintenanceTransients(snapshot:ManagedWorkspaceSnapshot,role:'workspace'|'service'):string[] {
  const paths=[...snapshot.transientExclusions[role]];
  if(role==='service'&&snapshot.roots.service.some(e=>e.path==='installer-lock.sqlite'&&e.kind==='file'&&e.bytes===0&&e.mode===0o600)&&!paths.includes('installer-lock.sqlite-journal'))paths.push('installer-lock.sqlite-journal');
  return paths;
}
