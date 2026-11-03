/** Private operator preservation. Keeps original pending requests and adoption
 * seals unchanged. Relocation and Host routing are separate operations. */
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {canonicalPath,fail,fields,outsideGit,readRegular} from '../../compat/project/files.js';
import {keyDirectory} from '../../location-lineage.js';
import {copyMaintenanceFile,hashMaintenanceFile,inspectMaintenanceTree,maintenanceJSONDigest,writeMaintenanceJSON,type MaintenanceEntry} from './stream.js';
import {maintenanceLocation,present,privateDirectory,separateRoots,withQuiescentWorkspace,withRestoringWorkspace,type ManagedWorkspaceSnapshot,type WorkspaceSelection,type PreservedReference} from './snapshot.js';

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
function copyInventory(source:string,destination:string,entries:MaintenanceEntry[],requestId:string,transients:string[]=[]):void {
  mkdir(destination);const stageName='.evopilot-copy-'+requestId,stage=path.join(destination,stageName);
  const expected=new Map<string,MaintenanceEntry>();
  for(const entry of entries){safeRelative(entry.path);if(entry.path===stageName||entry.path.startsWith(stageName+'/')||expected.has(entry.path))fail('MAINTENANCE_PARTIAL_CONFLICT');expected.set(entry.path,entry);}
  const stageKey=(entry:MaintenanceEntry)=>maintenanceJSONDigest({destination,requestId,path:entry.path,sha256:entry.sha256});
  const stages=new Map(entries.filter(e=>e.kind==='file').map(e=>[stageKey(e),e]));
  for(const entry of inspectMaintenanceTree(destination)){
    if(transients.includes(entry.path))continue;
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
  if(!equal(inspectMaintenanceTree(destination).filter(e=>!transients.includes(e.path)),entries))fail('MAINTENANCE_COPY_DIFFERENT');
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

export interface ManagedRestoreResult {
  schema:'runtime-managed-workspace-restore/v1';requestId:string;backupRoot:string;backupDigest:string;
  selection:WorkspaceSelection;snapshotDigest:string;completedAt:string;status:'VERIFIED';
  serviceStarted:false;businessWorkDispatched:false;authority:false;resultDigest:string;
}
interface RestoreJournal {
  schema:'runtime-managed-restore-journal/v1';intentDigest:string;
  status:'PREPARED'|'COPYING'|'VERIFYING'|'VERIFIED'|'INTERRUPTED';
  missingReferences:string[];result:ManagedRestoreResult|null;lastError:string|null;
}
const referenceStage=(ref:PreservedReference,requestId:string,backupDigest:string)=>path.join(path.dirname(ref.path),'.evopilot-restore-'+maintenanceJSONDigest({path:ref.path,requestId,backupDigest}));
const expectedReference=(ref:PreservedReference)=>({bytes:ref.bytes,sha256:ref.sha256,mode:ref.mode});
function referenceMatches(ref:PreservedReference):boolean {return equal(hashMaintenanceFile(ref.path),expectedReference(ref));}
/** Only the two names created by our exclusive publish may share an inode.
 * Hash through an unchanged descriptor before removing the staged name. This
 * handles a crash after link(2) and before unlink without permitting other links. */
function finishReferencePair(ref:PreservedReference,stage:string,complete=true):void {
  canonicalPath(ref.path);canonicalPath(stage);
  const a=fs.lstatSync(stage),b=fs.lstatSync(ref.path);
  const same=(x:fs.Stats,y:fs.Stats)=>x.dev===y.dev&&x.ino===y.ino&&x.size===y.size&&x.mtimeMs===y.mtimeMs&&x.ctimeMs===y.ctimeMs&&x.nlink===y.nlink;
  if(!a.isFile()||!b.isFile()||a.uid!==process.getuid!()||b.uid!==process.getuid!()||a.nlink!==2||b.nlink!==2||!same(a,b)||a.size!==ref.bytes||(a.mode&0o777)!==ref.mode)fail('MAINTENANCE_REFERENCE_CONFLICT');
  const fd=fs.openSync(stage,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),buffer=Buffer.allocUnsafe(4*1024*1024),hash=createHash('sha256');let total=0;
  try{
    if(!same(a,fs.fstatSync(fd)))fail('MAINTENANCE_REFERENCE_CONFLICT');
    let count;while((count=fs.readSync(fd,buffer,0,Math.min(buffer.length,ref.bytes-total+1),null))>0){total+=count;if(total>ref.bytes)fail('MAINTENANCE_REFERENCE_CONFLICT');hash.update(buffer.subarray(0,count));}
    if(total!==ref.bytes||hash.digest('hex')!==ref.sha256||!same(a,fs.fstatSync(fd))||!same(a,fs.lstatSync(stage))||!same(a,fs.lstatSync(ref.path)))fail('MAINTENANCE_REFERENCE_CONFLICT');
  }finally{fs.closeSync(fd);}
  if(!complete)return;
  fs.unlinkSync(stage);syncDirectory(path.dirname(stage));
  if(!referenceMatches(ref))fail('MAINTENANCE_REFERENCE_CONFLICT');
}
function restoreReference(backupRoot:string,ref:PreservedReference,requestId:string,backupDigest:string,wasMissing:boolean):void {
  const stage=referenceStage(ref,requestId,backupDigest);
  if(present(ref.path)){
    if(wasMissing&&present(stage)&&fs.lstatSync(ref.path).nlink===2){finishReferencePair(ref,stage);return;}
    if(!referenceMatches(ref))fail('MAINTENANCE_REFERENCE_CONFLICT');
    if(present(stage)){
      if(!wasMissing)fail('MAINTENANCE_REFERENCE_CONFLICT');
      copyMaintenanceFile(path.join(backupRoot,'references',fileKey(ref.path)),stage,{...ref,kind:'file'});
      fs.unlinkSync(stage);syncDirectory(path.dirname(stage));
    }
    return;
  }
  if(!wasMissing)fail('MAINTENANCE_REFERENCE_CONFLICT','A previously existing external reference disappeared during recovery');
  copyMaintenanceFile(path.join(backupRoot,'references',fileKey(ref.path)),stage,{...ref,kind:'file'});
  try{fs.linkSync(stage,ref.path);syncDirectory(path.dirname(ref.path));}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(!referenceMatches(ref))fail('MAINTENANCE_REFERENCE_CONFLICT');fs.unlinkSync(stage);syncDirectory(path.dirname(stage));return;}
  finishReferencePair(ref,stage);
}
function retainedKeys(snapshot:ManagedWorkspaceSnapshot):void {
  if(snapshot.requiredKeyIds.length>192)fail('MAINTENANCE_KEYS');
  for(const id of snapshot.requiredKeyIds){
    if(!/^[a-f0-9]{64}$/.test(id))fail('MAINTENANCE_KEYS');
    const directory=keyDirectory();privateDirectory(directory);
    if(readRegular(path.join(directory,id+'.key'),32,true).length!==32)fail('MISSING_RELOCATION_KEY');
  }
}
/** Restore only the original locations from a known externally anchored backup.
 * An exact VERIFIED retry returns the original receipt, not a current-state
 * acceptance. It cannot overwrite newer work or restart a service. */
export async function restoreManagedWorkspaceBackup(backupRoot:string,expectedBackupDigest:string,requestId:string,signal?:AbortSignal):Promise<ManagedRestoreResult> {
  if(!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(requestId))fail('MAINTENANCE_ID');
  const manifest=verifyManagedWorkspaceBackup(backupRoot,expectedBackupDigest),snapshot=manifest.snapshot,selection=structuredClone(snapshot.selection);
  const control=selection.workspaceRoot+'.evopilot-maintenance';
  separateRoots([selection.projectRoot,selection.workspaceRoot,selection.serviceRoot,backupRoot,control]);
  privateDirectory(control);privateDirectory(path.join(control,'requests'));privateDirectory(path.join(control,'known-backups'));
  const anchor=JSON.parse(readRegular(path.join(control,'known-backups',fileKey(backupRoot)+'.json'),32768,true).toString()) as unknown;
  if(!equal(anchor,{schema:'runtime-managed-backup-anchor/v1',requestId:manifest.requestId,backupRoot,backupDigest:expectedBackupDigest,snapshotDigest:snapshot.snapshotDigest}))fail('MAINTENANCE_BACKUP_UNKNOWN');
  const journalPath=path.join(control,'requests',requestId+'.json');
  const intentDigest=maintenanceJSONDigest({operation:'restore',selection,requestId,backupRoot,backupDigest:expectedBackupDigest});
  const load=():RestoreJournal|null=>{
    if(!present(journalPath))return null;
    const value:unknown=JSON.parse(readRegular(journalPath,32*1048576,true).toString());fields(value,['schema','intentDigest','status','missingReferences','result','lastError']);
    const journal=value as unknown as RestoreJournal;
    if(journal.schema!=='runtime-managed-restore-journal/v1'||journal.intentDigest!==intentDigest||!['PREPARED','COPYING','VERIFYING','VERIFIED','INTERRUPTED'].includes(journal.status)||!Array.isArray(journal.missingReferences)||new Set(journal.missingReferences).size!==journal.missingReferences.length||journal.missingReferences.some(ref=>!snapshot.references.some(r=>r.path===ref)))fail('MAINTENANCE_CONFLICT');
    if(journal.status==='VERIFIED'){
      if(!journal.result)fail('MAINTENANCE_CONFLICT');
      const {resultDigest,...body}=journal.result;
      if(maintenanceJSONDigest(body)!==resultDigest||body.schema!=='runtime-managed-workspace-restore/v1'||body.requestId!==requestId||body.backupRoot!==backupRoot||body.backupDigest!==expectedBackupDigest||!equal(body.selection,selection)||body.snapshotDigest!==snapshot.snapshotDigest||body.status!=='VERIFIED'||body.authority!==false||body.serviceStarted!==false||body.businessWorkDispatched!==false)fail('MAINTENANCE_CONFLICT');
    }else if(journal.result!==null)fail('MAINTENANCE_CONFLICT');
    return journal;
  };
  const previous=load();if(previous?.status==='VERIFIED')return previous.result!;
  retainedKeys(snapshot);let journal:RestoreJournal|undefined;
  return withRestoringWorkspace(selection,requestId,()=>{
    const current=load();if(current?.status==='VERIFIED')fail('MAINTENANCE_ALREADY_COMPLETED','Read the completed original restore receipt');
    journal=current??undefined;
    const refs=snapshot.references;
    for(const ref of refs){
      canonicalPath(ref.path,true);outsideGit(path.dirname(ref.path));const parent=fs.lstatSync(path.dirname(ref.path));
      if(!parent.isDirectory()||parent.uid!==process.getuid!()||(parent.mode&0o022)||[selection.projectRoot,selection.workspaceRoot,selection.serviceRoot,backupRoot,control].some(root=>ref.path===root||ref.path.startsWith(root+path.sep)))fail('MAINTENANCE_REFERENCE_CONFLICT');
      const stage=referenceStage(ref,requestId,expectedBackupDigest);
      if(present(stage)&&!current?.missingReferences.includes(ref.path))fail('MAINTENANCE_REFERENCE_CONFLICT');
      if(present(ref.path)){
        if(current?.missingReferences.includes(ref.path)&&present(stage)&&fs.lstatSync(ref.path).nlink===2)finishReferencePair(ref,stage,false);
        else if(!referenceMatches(ref))fail('MAINTENANCE_REFERENCE_CONFLICT');
      }
    }
    if(!current){
      for(const root of [selection.projectRoot,selection.workspaceRoot,selection.serviceRoot])if(present(root)&&fs.readdirSync(root).length)fail('MAINTENANCE_DESTINATION_NOT_EMPTY');
      journal={schema:'runtime-managed-restore-journal/v1',intentDigest,status:'PREPARED',missingReferences:refs.filter(ref=>!present(ref.path)).map(ref=>ref.path),result:null,lastError:null};save(journalPath,journal,false);
    }else journal=current;
    // Guard each known empty lock path before any database bytes are restored.
    // Existing partial content is checked exactly by copyInventory below.
    for(const root of [selection.projectRoot,selection.workspaceRoot,selection.serviceRoot])mkdir(root);
    for(const root of [path.join(selection.workspaceRoot,'state'),path.join(selection.workspaceRoot,'state/runtime-service'),path.join(selection.serviceRoot,'data')])mkdir(root);
    for(const file of [path.join(selection.workspaceRoot,'state/runtime-service/writer-lock.sqlite'),path.join(selection.serviceRoot,'data/writer-lock.sqlite')]){
      canonicalPath(file,true);if(!present(file)){const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDirectory(path.dirname(file));}
    }
  },capture=>{
    try{
      const retained=journal!;retained.status='COPYING';retained.lastError=null;save(journalPath,retained);
      verifyManagedWorkspaceBackup(backupRoot,expectedBackupDigest);
      for(const role of roles){signal?.throwIfAborted();copyInventory(path.join(backupRoot,role),selection[role==='workspace'?'workspaceRoot':role==='project'?'projectRoot':'serviceRoot'],snapshot.roots[role],requestId,role==='project'?[]:snapshot.transientExclusions[role]);}
      for(const ref of snapshot.references){signal?.throwIfAborted();restoreReference(backupRoot,ref,requestId,expectedBackupDigest,retained.missingReferences.includes(ref.path));}
      retained.status='VERIFYING';save(journalPath,retained);signal?.throwIfAborted();
      if(capture().snapshotDigest!==snapshot.snapshotDigest)fail('MAINTENANCE_RESTORE_DIFFERENT');
      verifyManagedWorkspaceBackup(backupRoot,expectedBackupDigest);
      const body={schema:'runtime-managed-workspace-restore/v1' as const,requestId,backupRoot,backupDigest:expectedBackupDigest,selection,snapshotDigest:snapshot.snapshotDigest,completedAt:new Date().toISOString(),status:'VERIFIED' as const,serviceStarted:false as const,businessWorkDispatched:false as const,authority:false as const};
      const result={...body,resultDigest:maintenanceJSONDigest(body)};
      const completed={...retained,result,status:'VERIFIED' as const};save(journalPath,completed);journal=completed;return result;
    }catch(error){const retained=journal!;retained.status='INTERRUPTED';retained.lastError=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'?error.code:'MAINTENANCE_INTERRUPTED';save(journalPath,retained);throw error;}
  },signal).catch(error=>{
    if(journal&&journal.status!=='VERIFIED'){
      journal.status='INTERRUPTED';journal.lastError=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'?error.code:'MAINTENANCE_INTERRUPTED';save(journalPath,journal);
    }
    throw error;
  });
}
