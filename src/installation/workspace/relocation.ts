/** Same-host, stopped-service relocation. Originals and backup anchors survive;
 * a completed retry returns its historical receipt, never overwrites later work. */
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {canonicalPath,fail,fields,readRegular} from '../../compat/project/files.js';
import {inspectAllTables} from '../../compat/table-inventory.js';
import type {ManagedLegacyBinding} from '../../compat/managed-store.js';
import type {LegacyPluginSelection} from '../../host/plugin.js';
import {copyInventory,mkdir,save,syncDirectory,verifyManagedWorkspaceBackup} from './backup.js';
import {prepareRelocationConfiguration,type RelocationConfigurationMaterial} from './configuration.js';
import {publishedLocationOwners,type LocationOwners,type OwnerLocationSnapshot,type OwnerLocationResult} from './owners.js';
import {maintenanceLocation,preservationSnapshotMatches,heldMaintenanceTransients,present,privateDirectory,separateRoots,withRelocatingWorkspaces,type ManagedWorkspaceSnapshot,type WorkspaceSelection} from './snapshot.js';
import {hashMaintenanceFile,inspectMaintenanceTree,maintenanceJSONDigest,type MaintenanceEntry} from './stream.js';

export interface RelocateManagedWorkspaceRequest {
  source:WorkspaceSelection;destination:{projectRoot:string;workspaceRoot:string;serviceRoot:string};
  requestId:string;backupRoot:string;backupDigest:string;
  owners:{ontology:string;harness:string};ownerHost:LegacyPluginSelection;
}
export interface ManagedRelocationResult {
  schema:'runtime-managed-workspace-relocation/v1';requestId:string;intentDigest:string;
  source:WorkspaceSelection;destination:WorkspaceSelection;backupRoot:string;backupDigest:string;
  sourceSnapshotDigest:string;destinationSnapshotDigest:string;configurationDigest:string;
  ownerHost:LegacyPluginSelection;completedAt:string;status:'VERIFIED';
  serviceStarted:false;hostRegistered:false;businessWorkDispatched:false;authority:false;resultDigest:string;
}
interface Journal {
  schema:'runtime-managed-relocation-journal/v1';intentDigest:string;status:'PREPARED'|'COPYING'|'ATTESTING'|'CONFIGURING'|'VERIFYING'|'VERIFIED'|'INTERRUPTED';
  copied:boolean;snapshots:Record<string,OwnerLocationSnapshot>;relocations:Record<string,OwnerLocationResult>;
  configurationDigest:string|null;result:ManagedRelocationResult|null;lastError:string|null;
}
const roles=['project','workspace','service'] as const,ownerNames=['runtime','harness','ontology'] as const;
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const rootFor=(s:WorkspaceSelection,role:typeof roles[number])=>s[role==='project'?'projectRoot':role==='workspace'?'workspaceRoot':'serviceRoot'];
const errorCode=(e:unknown)=>e&&typeof e==='object'&&'code' in e&&typeof e.code==='string'?e.code:'MAINTENANCE_INTERRUPTED';
function rawTables(file:string,ignoreLocation=false):ReturnType<typeof inspectAllTables>&{schemaVersion:number} {
  const scratch=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'runtime-relocation-records-'));
  try{
    for(const suffix of ['-wal','-shm','-journal'])if(present(file+suffix))fail('MAINTENANCE_NOT_QUIESCENT');
    const copied=path.join(scratch,'state.db');fs.copyFileSync(file,copied);const db=new DatabaseSync(copied,{readOnly:true,allowExtension:false});
    try{return{schemaVersion:Number(db.prepare('PRAGMA user_version').get()?.user_version),...inspectAllTables(db,ignoreLocation?['workspace_relocations']:[])};}finally{db.close();}
  }finally{fs.rmSync(scratch,{recursive:true,force:true});}
}
function requireTerminalService(source:WorkspaceSelection):void {
  const scratch=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'runtime-relocation-pending-'));
  try{
    const file=path.join(scratch,'state.db');fs.copyFileSync(path.join(source.serviceRoot,'data/service.sqlite'),file);
    const db=new DatabaseSync(file,{readOnly:true,allowExtension:false});
    try{
      const rows=db.prepare("SELECT data FROM objects WHERE kind='stage-progress'").iterate();
      for(const row of rows){const value=JSON.parse(String(row.data)) as {terminal?:boolean};if(value.terminal!==true)fail('MAINTENANCE_UNRESOLVED','Reconcile the original lifecycle request before relocation');}
    }finally{db.close();}
  }finally{fs.rmSync(scratch,{recursive:true,force:true});}
}
/** Copy scaffolding contains only entries already present in the retained
 * inventory. Empty writer files are held before copying any business state. */
function scaffold(destination:WorkspaceSelection,snapshot:ManagedWorkspaceSnapshot):void {
  for(const role of roles)mkdir(rootFor(destination,role));
  const directories:{role:typeof roles[number];name:string}[]=[{role:'workspace',name:'state'},{role:'workspace',name:'state/runtime-service'},{role:'service',name:'data'}];
  for(const {role,name} of directories){const entry=snapshot.roots[role].find(e=>e.path===name);if(entry?.kind!=='directory'||entry.mode!==0o700)fail('MAINTENANCE_PERMISSIONS');mkdir(path.join(rootFor(destination,role),name));}
  for(const [role,name] of [['workspace','state/runtime-service/writer-lock.sqlite'],['service','data/writer-lock.sqlite'],...snapshot.roots.service.some(e=>e.path==='installer-lock.sqlite')?[['service','installer-lock.sqlite']]:[]] as [typeof roles[number],string][]){
    const entry=snapshot.roots[role].find(e=>e.path===name);if(entry?.kind!=='file'||entry.bytes!==0||entry.mode!==0o600)fail('MAINTENANCE_PERMISSIONS');
    const file=path.join(rootFor(destination,role),name);canonicalPath(file,true);
    if(!present(file)){const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDirectory(path.dirname(file));}
  }
}
function compareTrees(source:ManagedWorkspaceSnapshot,destination:WorkspaceSelection,material:RelocationConfigurationMaterial|null,requestId:string):void {
  for(const role of roles){
    const expected=new Map(source.roots[role].map(e=>[e.path,e]));
    const entries=inspectMaintenanceTree(rootFor(destination,role));
    const transients=role==='project'?[]:heldMaintenanceTransients(source,role);
    for(const e of entries){
      if(transients.includes(e.path))continue;
      if(role==='workspace'&&(e.path==='workspace.json'||ownerNames.some(o=>e.path==='state/'+o+'/'+o+'.db'||['-wal','-shm','-journal'].some(s=>e.path==='state/'+o+'/'+o+'.db'+s)))){
        if(e.kind!=='file'||e.mode!==0o600)fail('MAINTENANCE_PARTIAL_CONFLICT');expected.delete(e.path);continue;
      }
      const patch=material?.patches.find(p=>(p.role??'service')===role&&p.path===e.path);
      if(patch){if(e.kind!=='file'||e.mode!==(patch.mode??0o600)||![patch.previousSha256,patch.sha256].includes(e.sha256))fail('MAINTENANCE_PARTIAL_CONFLICT');expected.delete(e.path);continue;}
      if(role==='service'&&material&&(e.path==='.evopilot-relocation-'+requestId||e.path.startsWith('.evopilot-relocation-'+requestId+'/')))continue;
      if(!equal(expected.get(e.path),e))fail('MAINTENANCE_PARTIAL_CONFLICT');expected.delete(e.path);
    }
    if(expected.size)fail('MAINTENANCE_PARTIAL_CONFLICT');
  }
}
function applyConfiguration(destination:WorkspaceSelection,material:RelocationConfigurationMaterial,requestId:string,signal?:AbortSignal):void {
  const stage=path.join(destination.serviceRoot,'.evopilot-relocation-'+requestId);mkdir(stage);
  const stageName=(p:RelocationConfigurationMaterial['patches'][number])=>sha(p.role==='workspace'?'workspace:'+p.path:p.path);
  const names=new Set(material.patches.map(stageName));
  if(fs.readdirSync(stage).some(name=>!names.has(name)))fail('MAINTENANCE_PARTIAL_CONFLICT');
  for(const patch of material.patches){
    signal?.throwIfAborted();const file=path.join(patch.role==='workspace'?destination.workspaceRoot:destination.serviceRoot,patch.path),temporary=path.join(stage,stageName(patch)),mode=patch.mode??0o600;canonicalPath(file,true);
    const current=present(file)?hashMaintenanceFile(file):null;
    if(current&&current.sha256===patch.sha256){if(current.mode!==mode)fail('MAINTENANCE_PARTIAL_CONFLICT');if(present(temporary)){const bytes=readRegular(temporary,2097152,mode===0o600);if(!bytes.equals(patch.bytes))fail('MAINTENANCE_PARTIAL_CONFLICT');fs.unlinkSync(temporary);}continue;}
    if((current?.sha256??null)!==patch.previousSha256)fail('MAINTENANCE_PARTIAL_CONFLICT');
    if(patch.role==='workspace'){if(current?.mode!==mode)fail('MAINTENANCE_PARTIAL_CONFLICT');canonicalPath(path.dirname(file));}else privateDirectory(path.dirname(file));
    const prior=present(temporary)?readRegular(temporary,2097152,mode===0o600):Buffer.alloc(0);
    if(prior.length>patch.bytes.length||!prior.equals(patch.bytes.subarray(0,prior.length)))fail('MAINTENANCE_PARTIAL_CONFLICT');
    const fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW,0o600);
    try{let offset=prior.length;while(offset<patch.bytes.length)offset+=fs.writeSync(fd,patch.bytes,offset,patch.bytes.length-offset,offset);fs.fchmodSync(fd,mode);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temporary,file);syncDirectory(path.dirname(file));syncDirectory(stage);
  }
  fs.rmdirSync(stage);syncDirectory(destination.serviceRoot);
}

/** This internal composition seam accepts only trusted owning APIs. The public
 * operator below supplies distribution-verified fixed package entries. */
export async function relocateWithOwners(input:RelocateManagedWorkspaceRequest,owners:LocationOwners,signal?:AbortSignal):Promise<ManagedRelocationResult> {
  const request=structuredClone(input);fields(request,['source','destination','requestId','backupRoot','backupDigest','owners','ownerHost']);fields(request.destination,['projectRoot','workspaceRoot','serviceRoot']);fields(request.owners,['ontology','harness']);
  if(!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(request.requestId))fail('MAINTENANCE_ID');
  const {source,requestId,backupRoot,backupDigest}=request,saved=verifyManagedWorkspaceBackup(backupRoot,backupDigest),snapshot=saved.snapshot;
  if(!equal(snapshot.selection,source))fail('MAINTENANCE_BACKUP_CHANGED');
  const map=(file:string)=>{for(const role of ['projectRoot','workspaceRoot','serviceRoot'] as const)if(file===source[role]||file.startsWith(source[role]+path.sep))return request.destination[role]+file.slice(source[role].length);return file;};
  const destination:WorkspaceSelection={...source,...request.destination,referenceFiles:source.referenceFiles.map(map)};
  const control=source.workspaceRoot+'.evopilot-maintenance',destinationControl=destination.workspaceRoot+'.evopilot-maintenance';
  separateRoots([source.projectRoot,source.workspaceRoot,source.serviceRoot,destination.projectRoot,destination.workspaceRoot,destination.serviceRoot,control,destinationControl,backupRoot]);
  for(const role of roles)maintenanceLocation(rootFor(destination,role),true);
  privateDirectory(control);privateDirectory(path.join(control,'requests'));
  const anchor=JSON.parse(readRegular(path.join(control,'known-backups',sha(backupRoot)+'.json'),32768,true).toString()) as unknown;
  if(!equal(anchor,{schema:'runtime-managed-backup-anchor/v1',requestId:saved.requestId,backupRoot,backupDigest,snapshotDigest:snapshot.snapshotDigest}))fail('MAINTENANCE_BACKUP_UNKNOWN');
  const intentDigest=maintenanceJSONDigest(request),journalPath=path.join(control,'requests',requestId+'.json');
  const load=():Journal|null=>{
    if(!present(journalPath))return null;
    const journal=JSON.parse(readRegular(journalPath,32*1048576,true).toString()) as Journal;
    fields(journal,['schema','intentDigest','status','copied','snapshots','relocations','configurationDigest','result','lastError']);
    if(journal.schema!=='runtime-managed-relocation-journal/v1'||journal.intentDigest!==intentDigest||!['PREPARED','COPYING','ATTESTING','CONFIGURING','VERIFYING','VERIFIED','INTERRUPTED'].includes(journal.status)||typeof journal.copied!=='boolean')fail('MAINTENANCE_CONFLICT');
    if(journal.status==='VERIFIED'){
      if(!journal.result)fail('MAINTENANCE_CONFLICT');const {resultDigest,...body}=journal.result;
      if(body.schema!=='runtime-managed-workspace-relocation/v1'||body.intentDigest!==intentDigest||body.requestId!==requestId||body.status!=='VERIFIED'||body.authority!==false||body.serviceStarted!==false||body.hostRegistered!==false||body.businessWorkDispatched!==false||maintenanceJSONDigest(body)!==resultDigest)fail('MAINTENANCE_CONFLICT');
    }else if(journal.result!==null)fail('MAINTENANCE_CONFLICT');
    return journal;
  };
  const previous=load();if(previous?.status==='VERIFIED')return previous.result!;
  let journal:Journal|undefined;
  return withRelocatingWorkspaces(source,destination,requestId,()=>{
    journal=load()??undefined;if(journal?.status==='VERIFIED')fail('MAINTENANCE_ALREADY_COMPLETED');
    const claim={schema:'runtime-relocation-destination-claim/v1',intentDigest,source:source.workspaceRoot,requestId};
    if(!journal){
      for(const role of roles){const root=rootFor(destination,role);if(present(root)&&fs.readdirSync(root).length)fail('MAINTENANCE_DESTINATION_NOT_EMPTY');}
      if(present(destinationControl))fail('MAINTENANCE_DESTINATION_NOT_EMPTY');
      journal={schema:'runtime-managed-relocation-journal/v1',intentDigest,status:'PREPARED',copied:false,snapshots:{},relocations:{},configurationDigest:null,result:null,lastError:null};save(journalPath,journal,false);
    }
    mkdir(destinationControl);save(path.join(destinationControl,'relocation-claim.json'),claim,false);
    scaffold(destination,snapshot);
  },async context=>{
    const current=journal!;
    const unchanged=()=>{if(!preservationSnapshotMatches(context.captureSource(),snapshot))fail('MAINTENANCE_DRIFT');};
    try{
      unchanged();requireTerminalService(source);
      for(const owner of ownerNames){
        signal?.throwIfAborted();const read=()=>owners[owner].inspectWorkspaceSnapshot({workspaceRoot:source.workspaceRoot,workspaceId:source.workspaceId});
        const observed=owner==='runtime'?context.runSource(read):read();
        if(observed.product!==owner||observed.identity.canonicalRoot!==source.workspaceRoot||observed.identity.id!==source.workspaceId||observed.unresolved.some(v=>v.nextAction==='RECONCILE_OR_CANCEL'))fail('MAINTENANCE_UNRESOLVED');
        if(current.snapshots[owner]&&!equal(current.snapshots[owner],observed))fail('MAINTENANCE_DRIFT');current.snapshots[owner]=observed;
      }
      unchanged();save(journalPath,current);
      if(!current.copied){
        current.status='COPYING';current.lastError=null;save(journalPath,current);
        for(const role of roles){signal?.throwIfAborted();copyInventory(rootFor(source,role),rootFor(destination,role),snapshot.roots[role],requestId,role==='project'?[]:heldMaintenanceTransients(snapshot,role));}
        unchanged();current.copied=true;save(journalPath,current);
      }
      // Earlier partial configuration is permitted only after all owning
      // attestations have been journaled; material is regenerated exactly.
      const priorBinding=current.relocations.runtime?.managedBinding;
      if(priorBinding)Object.assign(destination,priorBinding);
      let material=current.configurationDigest?prepareRelocationConfiguration(source,destination,request.ownerHost):null;
      if(material&&material.materialDigest!==current.configurationDigest)fail('MAINTENANCE_CONFLICT');
      compareTrees(snapshot,destination,material,requestId);
      current.status='ATTESTING';save(journalPath,current);
      for(const owner of ownerNames){
        signal?.throwIfAborted();const relocate=()=>owners[owner].relocateWorkspaceSnapshot({sourceRoot:source.workspaceRoot,destinationRoot:destination.workspaceRoot,workspaceId:source.workspaceId,expectedSnapshotDigest:current.snapshots[owner].snapshotDigest});
        const result=owner==='runtime'?context.runSource(relocate):relocate();
        if(result.product!==owner||result.sourceSnapshotDigest!==current.snapshots[owner].snapshotDigest||result.snapshot.identity.canonicalRoot!==destination.workspaceRoot||result.snapshot.identity.id!==destination.workspaceId)fail('MAINTENANCE_RELOCATION_DIFFERENT');
        if(current.relocations[owner]&&!equal(current.relocations[owner],result))fail('MAINTENANCE_RELOCATION_DIFFERENT');
        current.relocations[owner]=result;save(journalPath,current);
      }
      const binding=current.relocations.runtime.managedBinding;if(!binding)fail('MAINTENANCE_IDENTITY');Object.assign(destination,binding);
      for(const owner of ownerNames){
        const relative='state/'+owner+'/'+owner+'.db';
        if(!equal(rawTables(path.join(source.workspaceRoot,relative),true),rawTables(path.join(destination.workspaceRoot,relative),true)))fail('MAINTENANCE_RELOCATION_DIFFERENT');
      }
      unchanged();material=prepareRelocationConfiguration(source,destination,request.ownerHost);
      if(current.configurationDigest&&current.configurationDigest!==material.materialDigest)fail('MAINTENANCE_CONFLICT');
      current.configurationDigest=material.materialDigest;current.status='CONFIGURING';save(journalPath,current);
      compareTrees(snapshot,destination,material,requestId);applyConfiguration(destination,material,requestId,signal);
      current.status='VERIFYING';save(journalPath,current);signal?.throwIfAborted();
      if(prepareRelocationConfiguration(source,destination,request.ownerHost).materialDigest!==material.materialDigest)fail('MAINTENANCE_CONFLICT');
      compareTrees(snapshot,destination,material,requestId);const restored=context.captureDestination(binding);unchanged();
      const body={schema:'runtime-managed-workspace-relocation/v1' as const,requestId,intentDigest,source,destination,backupRoot,backupDigest,sourceSnapshotDigest:snapshot.snapshotDigest,destinationSnapshotDigest:restored.snapshotDigest,configurationDigest:material.materialDigest,ownerHost:material.ownerHost,completedAt:new Date().toISOString(),status:'VERIFIED' as const,serviceStarted:false as const,hostRegistered:false as const,businessWorkDispatched:false as const,authority:false as const};
      const result={...body,resultDigest:maintenanceJSONDigest(body)};save(journalPath,{...current,result,status:'VERIFIED',lastError:null});return result;
    }catch(error){current.status='INTERRUPTED';current.lastError=errorCode(error);save(journalPath,current);throw error;}
  },signal);
}
/** No arbitrary owner code, HTTP exposure, service launch or Codex registration. */
export async function relocateManagedWorkspace(input:RelocateManagedWorkspaceRequest,signal?:AbortSignal):Promise<ManagedRelocationResult> {
  return relocateWithOwners(input,await publishedLocationOwners(input.owners),signal);
}
