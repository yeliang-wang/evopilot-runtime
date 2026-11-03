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
import {acquireLegacyWriterLease,migrationSeal,type ManagedLegacyBinding} from '../../compat/managed-store.js';
import {readIdentity,readRelocations} from '../../location-lineage.js';
import {RuntimeStore} from '../../server/store.js';
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
const quote=(v:string)=>'"'+v.replaceAll('"','""')+'"';
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
export function validateSelection(selection:WorkspaceSelection):void {
  fields(selection,['projectRoot','workspaceRoot','workspaceId','serviceRoot','serviceId','migrationDigest','referenceFiles']);
  if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(selection.workspaceId)||typeof selection.serviceId!=='string'||!selection.serviceId||selection.serviceId.length>128||!/^[a-f0-9]{64}$/.test(selection.migrationDigest))fail('MAINTENANCE_IDENTITY');
  if(!Array.isArray(selection.referenceFiles)||selection.referenceFiles.length>128||selection.referenceFiles.some(v=>typeof v!=='string')||new Set(selection.referenceFiles).size!==selection.referenceFiles.length)fail('MAINTENANCE_REFERENCE');
  const roots=[selection.projectRoot,selection.workspaceRoot,selection.serviceRoot];roots.forEach((r,i)=>maintenanceLocation(r,false,i===2));separateRoots(roots);
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
function tableInventory(db:DatabaseSync):Pick<DatabaseInventory,'schemaDigest'|'tables'> {
  if(db.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')fail('MAINTENANCE_DATABASE');
  const schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
  if(schema.length>256||schema.some(row=>!['table','index'].includes(String(row.type))||/\bVIRTUAL\s+TABLE\b/i.test(String(row.sql))))fail('MAINTENANCE_DATABASE');
  const tables:DatabaseInventory['tables']=[];let bytes=0;
  for(const row of schema.filter(v=>v.type==='table')){
    const name=String(row.name),columns=db.prepare('PRAGMA table_info('+quote(name)+')').all().map(v=>String(v.name));
    if(!columns.length||columns.length>64)fail('MAINTENANCE_DATABASE');
    const query=db.prepare('SELECT * FROM '+quote(name)+' ORDER BY '+columns.map(quote).join(',')+' LIMIT 100001');query.setReadBigInts(true);
    let rows=0;const hash=createHash('sha256');
    for(const record of query.iterate()){
      if(++rows>100000)fail('MAINTENANCE_LIMIT');
      const encoded=JSON.stringify(columns.map(key=>{const v=record[key];return v instanceof Uint8Array?{blob:Buffer.from(v).toString('hex')}:typeof v==='bigint'?{integer:v.toString()}:v;}));
      if((bytes+=Buffer.byteLength(encoded))>768*1024*1024)fail('MAINTENANCE_LIMIT');hash.update(encoded+'\n');
    }
    tables.push({name,rows,sha256:hash.digest('hex')});
  }
  return{schemaDigest:maintenanceJSONDigest(schema),tables};
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
        const schemaVersion=Number(db.prepare('PRAGMA user_version').get()?.user_version),all=tableInventory(db);
        if(owner==='runtime'){
          const seal=migrationSeal(db);if(!seal)fail('MAINTENANCE_IDENTITY');
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
/** No automatic stop/restart. The operator must first stop the exact owned
 * service. Shared Host exclusion and both writer leases remain held throughout
 * the callback. A second capture can verify drift after a long copy. */
export async function withQuiescentWorkspace<T>(input:WorkspaceSelection,requestId:string,callback:(capture:()=>ManagedWorkspaceSnapshot)=>T|Promise<T>,signal?:AbortSignal):Promise<T> {
  const selection=structuredClone(input);
  validateSelection(selection);
  return withWorkspaceLease({workspaceRoot:selection.workspaceRoot,workspaceId:selection.workspaceId},requestId,async()=>{
    await onlineWorkerStopped(selection);signal?.throwIfAborted();
    const originalLock=path.join(selection.workspaceRoot,'state/runtime-service/writer-lock.sqlite');
    const lockPath=path.join(selection.serviceRoot,'data/writer-lock.sqlite');
    for(const file of [originalLock,lockPath]){
      const st=fs.lstatSync(canonicalPath(file));if(!st.isFile()||st.uid!==process.getuid!()||st.nlink!==1||(st.mode&0o777)!==0o600||st.size!==0)fail('MAINTENANCE_PERMISSIONS');
      for(const suffix of ['-wal','-shm','-journal'])if(present(file+suffix)){
        const sidecar=fs.lstatSync(canonicalPath(file+suffix));if(!sidecar.isFile()||sidecar.uid!==process.getuid!()||sidecar.nlink!==1||(sidecar.mode&0o777)!==0o600||sidecar.size>1048576)fail('MAINTENANCE_PERMISSIONS');
      }
    }
    const legacy=acquireLegacyWriterLease(selection.workspaceRoot,selection.workspaceId);let lock:DatabaseSync|undefined,active=true;
    try{
      lock=new DatabaseSync(lockPath,{allowExtension:false});lock.enableDefensive(true);
      try{lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}catch{fail('WRITER_ACTIVE','Stop the independent Runtime service before maintenance');}
      const capture=():ManagedWorkspaceSnapshot=>{
        if(!active)fail('MAINTENANCE_CLOSED');
        signal?.throwIfAborted();validateSelection(selection);
        for(const owner of owners)quietDatabase(path.join(selection.workspaceRoot,'state',owner,owner+'.db'));
        quietDatabase(path.join(selection.serviceRoot,'data/service.sqlite'));
        // BEGIN EXCLUSIVE on an empty lock file creates a temporary journal
        // with a fresh SQLite nonce. These two live lease journals contain no
        // business state and must not be copied into a stopped backup. Keep
        // every other file, including the zero-byte lock files themselves.
        const transientExclusions={workspace:['state/runtime-service/writer-lock.sqlite-journal'],service:['data/writer-lock.sqlite-journal']};
        const trees=()=>({project:inspectMaintenanceTree(selection.projectRoot),workspace:inspectMaintenanceTree(selection.workspaceRoot).filter(e=>!transientExclusions.workspace.includes(e.path)),service:inspectMaintenanceTree(selection.serviceRoot).filter(e=>!transientExclusions.service.includes(e.path))});
        const roots=trees(),refs=references(selection),dbs=databases(selection,roots);
        if(maintenanceJSONDigest(roots)!==maintenanceJSONDigest(trees())||maintenanceJSONDigest(refs)!==maintenanceJSONDigest(references(selection)))fail('MAINTENANCE_DRIFT');
        const body={schema:'runtime-managed-workspace-snapshot/v1' as const,selection:structuredClone(selection),roots,databases:dbs,references:refs,requiredKeyIds:[...new Set(dbs.flatMap(d=>d.requiredKeyIds))].sort(),transientExclusions,coverage:'SELECTED_ROOTS_AND_REFERENCE_FILES' as const,authority:false as const};
        return{...body,snapshotDigest:maintenanceJSONDigest(body)};
      };
      return await callback(capture);
    }finally{active=false;lock?.close();legacy.close();}
  },signal);
}
export async function inspectManagedWorkspace(selection:WorkspaceSelection,requestId:string,signal?:AbortSignal):Promise<ManagedWorkspaceSnapshot> {
  return withQuiescentWorkspace(selection,requestId,capture=>capture(),signal);
}
