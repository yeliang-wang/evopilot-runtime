/** Private operator backup only. Keeps original pending requests and adoption
 * seals unchanged. Restore, relocation and Host routing are separate operations. */
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {canonicalPath,fail,fields,readRegular} from '../../compat/project/files.js';
import {copyMaintenanceFile,hashMaintenanceFile,inspectMaintenanceTree,maintenanceJSONDigest,writeMaintenanceJSON,type MaintenanceEntry} from './stream.js';
import {maintenanceLocation,present,privateDirectory,separateRoots,withQuiescentWorkspace,type ManagedWorkspaceSnapshot,type WorkspaceSelection} from './snapshot.js';

export interface ManagedBackup {
  schema:'runtime-managed-workspace-backup/v1';requestId:string;createdAt:string;ownerUid:number;
  backupRoot:string;snapshot:ManagedWorkspaceSnapshot;backupDigest:string;
}
interface BackupJournal {
  schema:'runtime-managed-backup-journal/v1';intentDigest:string;
  status:'PREPARED'|'COPYING'|'VERIFYING'|'VERIFIED'|'INTERRUPTED';manifest:ManagedBackup;lastError:string|null;
}
const roles=['project','workspace','service'] as const;
const fileKey=(name:string)=>createHash('sha256').update(name).digest('hex');
function syncDirectory(root:string):void {
  const fd=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function mkdir(root:string):void {
  canonicalPath(root,true);if(!present(root)){fs.mkdirSync(root,{mode:0o700});syncDirectory(path.dirname(root));}privateDirectory(root);
}
function save(filename:string,value:unknown,replace=true):void {
  canonicalPath(filename,true);
  if(present(filename)){
    readRegular(filename,32*1048576,true);
    if(!replace){if(hashMaintenanceFile(filename).sha256!==maintenanceJSONDigest(value,true))fail('MAINTENANCE_CONFLICT');return;}
  }
  const temporary=filename+'.pending-'+randomBytes(12).toString('hex');
  const fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try{writeMaintenanceJSON(fd,value);fs.fsyncSync(fd);}catch(error){fs.unlinkSync(temporary);throw error;}finally{fs.closeSync(fd);}
  try{fs.renameSync(temporary,filename);syncDirectory(path.dirname(filename));}catch(error){try{fs.unlinkSync(temporary);}catch{}throw error;}
}
function safeRelative(value:string):void {
  if(typeof value!=='string'||!value||path.isAbsolute(value)||value.includes('\\')||value.includes('\0')||value.split('/').some(part=>!part||part==='.'||part==='..'))fail('MAINTENANCE_PATH');
}
/** Resume only an exact retained prefix. Foreign partials are never erased. */
function copyInventory(source:string,destination:string,entries:MaintenanceEntry[],requestId:string):void {
  mkdir(destination);const stageName='.evopilot-copy-'+requestId,stage=path.join(destination,stageName);
  const expected=new Map<string,MaintenanceEntry>();
  for(const entry of entries){safeRelative(entry.path);if(entry.path===stageName||entry.path.startsWith(stageName+'/')||expected.has(entry.path))fail('MAINTENANCE_PARTIAL_CONFLICT');expected.set(entry.path,entry);}
  const stageKey=(entry:MaintenanceEntry)=>maintenanceJSONDigest({destination,requestId,path:entry.path,sha256:entry.sha256});
  const stages=new Map(entries.filter(e=>e.kind==='file').map(e=>[stageKey(e),e]));
  for(const entry of inspectMaintenanceTree(destination)){
    if(entry.path===stageName||entry.path.startsWith(stageName+'/'))continue;
    if(!equal(expected.get(entry.path),entry))fail('MAINTENANCE_PARTIAL_CONFLICT');
  }
  mkdir(stage);
  for(const name of fs.readdirSync(stage)){
    const entry=stages.get(name);if(!entry)fail('MAINTENANCE_PARTIAL_CONFLICT');
    if(present(path.join(destination,entry.path)))copyMaintenanceFile(path.join(source,entry.path),path.join(stage,name),entry);
  }
  const identityFiles=new Set(['workspace-project.json','workspace.json']);
  const ordered=[...entries].sort((a,b)=>Number(a.kind==='symlink')-Number(b.kind==='symlink')||Number(identityFiles.has(b.path))-Number(identityFiles.has(a.path))||a.path.split('/').length-b.path.split('/').length||a.path.localeCompare(b.path));
  const dirty=new Set<string>();let renamed=0;
  const flush=()=>{for(const root of dirty)syncDirectory(root);dirty.clear();renamed=0;};
  for(const entry of ordered){
    const from=path.join(source,entry.path),to=path.join(destination,entry.path);
    if(entry.kind==='directory'){
      if(!present(to)){fs.mkdirSync(to,{mode:entry.mode??0o700});fs.chmodSync(to,entry.mode??0o700);syncDirectory(path.dirname(to));}
      canonicalPath(to);continue;
    }
    if(present(to)||entry.kind==='symlink')continue;
    const temporary=path.join(stage,stageKey(entry));copyMaintenanceFile(from,temporary,entry);
    if(present(to))fail('MAINTENANCE_PARTIAL_CONFLICT');fs.renameSync(temporary,to);dirty.add(path.dirname(to));dirty.add(stage);if(++renamed>=128)flush();
  }
  flush();const links=entries.filter(e=>e.kind==='symlink'&&!present(path.join(destination,e.path)));
  while(links.length){let made=false;for(let i=links.length-1;i>=0;i--){
    const entry=links[i],to=path.join(destination,entry.path);
    if(!entry.target||fs.readlinkSync(path.join(source,entry.path))!==entry.target)fail('MAINTENANCE_DRIFT');
    if(!fs.existsSync(path.resolve(path.dirname(to),entry.target)))continue;
    fs.symlinkSync(entry.target,to);syncDirectory(path.dirname(to));links.splice(i,1);made=true;
  }if(!made)fail('MAINTENANCE_LINK');}
  for(const name of fs.readdirSync(stage)){if(!stages.has(name))fail('MAINTENANCE_PARTIAL_CONFLICT');fs.unlinkSync(path.join(stage,name));}
  fs.rmdirSync(stage);syncDirectory(destination);
  if(!equal(inspectMaintenanceTree(destination),entries))fail('MAINTENANCE_COPY_DIFFERENT');
}
function manifestDigest(manifest:ManagedBackup):string {const {backupDigest,...body}=manifest;return maintenanceJSONDigest(body);}
function readManifest(filename:string,expectedDigest:string,backupRoot:string):ManagedBackup {
  const value:unknown=JSON.parse(readRegular(filename,32*1048576,true).toString());
  fields(value,['schema','requestId','createdAt','ownerUid','backupRoot','snapshot','backupDigest']);
  const manifest=value as unknown as ManagedBackup;
  fields(manifest.snapshot,['schema','selection','roots','databases','references','requiredKeyIds','transientExclusions','coverage','authority','snapshotDigest']);
  fields(manifest.snapshot.roots,['project','workspace','service']);
  const {snapshotDigest,...snapshot}=manifest.snapshot;
  if(!/^[a-f0-9]{64}$/.test(expectedDigest)||manifest.schema!=='runtime-managed-workspace-backup/v1'||manifest.backupRoot!==backupRoot||manifest.ownerUid!==process.getuid!()||manifest.backupDigest!==expectedDigest||manifestDigest(manifest)!==expectedDigest||manifest.snapshot.schema!=='runtime-managed-workspace-snapshot/v1'||snapshot.coverage!=='SELECTED_ROOTS_AND_REFERENCE_FILES'||snapshot.authority!==false||maintenanceJSONDigest(snapshot)!==snapshotDigest)fail('MAINTENANCE_BACKUP_CHANGED');
  return manifest;
}
/** Verification requires the external retained digest, not a checksum supplied
 * by the backup itself. It does not access original databases or start services. */
export function verifyManagedWorkspaceBackup(backupRoot:string,expectedDigest:string):ManagedBackup {
  maintenanceLocation(backupRoot);
  if(fs.readdirSync(backupRoot).sort().join('|')!=='manifest.json|project|references|service|workspace')fail('MAINTENANCE_BACKUP_CHANGED');
  const manifest=readManifest(path.join(backupRoot,'manifest.json'),expectedDigest,backupRoot);
  for(const role of roles)if(!equal(inspectMaintenanceTree(path.join(backupRoot,role)),manifest.snapshot.roots[role]))fail('MAINTENANCE_BACKUP_CHANGED');
  const refs=manifest.snapshot.references.map(ref=>({path:fileKey(ref.path),kind:'file' as const,bytes:ref.bytes,sha256:ref.sha256,mode:ref.mode})).sort((a,b)=>a.path.localeCompare(b.path));
  if(!equal(inspectMaintenanceTree(path.join(backupRoot,'references')),refs))fail('MAINTENANCE_BACKUP_CHANGED');
  return manifest;
}
export async function createManagedWorkspaceBackup(input:WorkspaceSelection,requestId:string,expectedSnapshotDigest:string,backupRoot:string,signal?:AbortSignal):Promise<ManagedBackup> {
  const selection=structuredClone(input);
  if(!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(requestId)||!/^[a-f0-9]{64}$/.test(expectedSnapshotDigest))fail('MAINTENANCE_ID');
  maintenanceLocation(backupRoot,true);
  const control=selection.workspaceRoot+'.evopilot-maintenance';
  separateRoots([selection.projectRoot,selection.workspaceRoot,selection.serviceRoot,backupRoot,control]);
  return withQuiescentWorkspace(selection,requestId,async capture=>{
    mkdir(control);mkdir(path.join(control,'requests'));mkdir(path.join(control,'known-backups'));
    const journalPath=path.join(control,'requests',requestId+'.json');
    const intentDigest=maintenanceJSONDigest({selection,requestId,expectedSnapshotDigest,backupRoot});
    let journal:BackupJournal;
    if(present(journalPath)){
      const value:unknown=JSON.parse(readRegular(journalPath,32*1048576,true).toString());fields(value,['schema','intentDigest','status','manifest','lastError']);
      journal=value as unknown as BackupJournal;
      if(journal.schema!=='runtime-managed-backup-journal/v1'||journal.intentDigest!==intentDigest||!['PREPARED','COPYING','VERIFYING','VERIFIED','INTERRUPTED'].includes(journal.status)||journal.manifest.backupRoot!==backupRoot||manifestDigest(journal.manifest)!==journal.manifest.backupDigest||journal.manifest.snapshot.snapshotDigest!==expectedSnapshotDigest)fail('MAINTENANCE_CONFLICT');
      if(journal.status==='VERIFIED')return verifyManagedWorkspaceBackup(backupRoot,journal.manifest.backupDigest);
    }else{
      if(present(backupRoot)&&fs.readdirSync(backupRoot).length)fail('MAINTENANCE_DESTINATION_NOT_EMPTY');
      const snapshot=capture();if(snapshot.snapshotDigest!==expectedSnapshotDigest)fail('MAINTENANCE_DRIFT');
      const body={schema:'runtime-managed-workspace-backup/v1' as const,requestId,createdAt:new Date().toISOString(),ownerUid:process.getuid!(),backupRoot,snapshot};
      journal={schema:'runtime-managed-backup-journal/v1',intentDigest,status:'PREPARED',manifest:{...body,backupDigest:maintenanceJSONDigest(body)},lastError:null};save(journalPath,journal,false);
    }
    try{
      if(capture().snapshotDigest!==expectedSnapshotDigest)fail('MAINTENANCE_DRIFT');
      mkdir(backupRoot);
      if(fs.readdirSync(backupRoot).some(name=>!['project','workspace','service','references','manifest.json'].includes(name)))fail('MAINTENANCE_PARTIAL_CONFLICT');
      journal.status='COPYING';journal.lastError=null;save(journalPath,journal);
      for(const role of roles){signal?.throwIfAborted();copyInventory(selection[role==='workspace'?'workspaceRoot':role==='project'?'projectRoot':'serviceRoot'],path.join(backupRoot,role),journal.manifest.snapshot.roots[role],requestId);}
      const refsRoot=path.join(backupRoot,'references');mkdir(refsRoot);
      const refs=journal.manifest.snapshot.references;
      if(fs.readdirSync(refsRoot).some(name=>!refs.some(ref=>fileKey(ref.path)===name)))fail('MAINTENANCE_PARTIAL_CONFLICT');
      for(const ref of refs){signal?.throwIfAborted();copyMaintenanceFile(ref.path,path.join(refsRoot,fileKey(ref.path)),{...ref,kind:'file'});}syncDirectory(refsRoot);
      journal.status='VERIFYING';save(journalPath,journal);signal?.throwIfAborted();
      if(capture().snapshotDigest!==expectedSnapshotDigest)fail('MAINTENANCE_DRIFT');
      save(path.join(backupRoot,'manifest.json'),journal.manifest,false);
      const verified=verifyManagedWorkspaceBackup(backupRoot,journal.manifest.backupDigest);
      save(path.join(control,'known-backups',fileKey(backupRoot)+'.json'),{schema:'runtime-managed-backup-anchor/v1',requestId,backupRoot,backupDigest:verified.backupDigest,snapshotDigest:expectedSnapshotDigest},false);
      journal.status='VERIFIED';save(journalPath,journal);return verified;
    }catch(error){journal.status='INTERRUPTED';journal.lastError=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'?error.code:'MAINTENANCE_INTERRUPTED';save(journalPath,journal);throw error;}
  },signal);
}
