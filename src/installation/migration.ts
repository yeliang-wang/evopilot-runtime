/** Operator-only adoption of Runtime-owned legacy data. Original inspection
 * copies a quiescent database to private scratch before opening SQLite: even a
 * read-only SQLite connection can create WAL sidecars. No owner authoring state,
 * credentials, external evidence paths or legacy processes are migrated here. */
import {DatabaseSync} from 'node:sqlite';
import {constants,closeSync,existsSync,fstatSync,fsyncSync,linkSync,lstatSync,mkdirSync,mkdtempSync,openSync,readdirSync,readFileSync,readlinkSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {canonical,canonicalEvidence,digest,exact,record,reject,slug,string} from '../server/errors.js';
import {inspectBlobs,inspectRecords,privatePath,readIdentity,readRelocations,safeAncestors} from '../location-lineage.js';
import {inspectNativeSnapshot} from '../native-snapshot.js';
import {validateState} from '../state.js';
import {acquireLegacyWriterLease,legacyDatabasePath,legacyWorkspace,migrationSeal,type LegacyMigrationSeal,type ManagedLegacyBinding} from '../compat/managed-store.js';
import {mkdir,save,syncDirectory,verifyManagedWorkspaceBackup} from './workspace/backup.js';
import {heldMaintenanceTransients,maintenanceLocation,preservationSnapshotMatches,separateRoots,withRestoringWorkspace,type WorkspaceSelection,type ManagedWorkspaceSnapshot} from './workspace/snapshot.js';
import {hashMaintenanceFile,type MaintenanceEntry} from './workspace/stream.js';

interface Entry {path:string;kind:'file'|'directory';bytes:number;sha256:string|null;}
interface Table {name:string;rows:number;sha256:string;}
interface TableInventory {schemaDigest:string;tables:Table[];}
export interface LegacySnapshot {
  schema:'runtime-legacy-snapshot/v1';workspaceRoot:string;workspaceId:string;
  schemaVersion:number;entries:Entry[];database:TableInventory;
  recordsDigest:string;nativeRecordsDigest:string|null;lineageDigest:string;
  requiredKeyIds:string[];snapshotDigest:string;
}
export interface LegacyBackup {schema:'runtime-legacy-backup/v1';snapshot:LegacySnapshot;backupDigest:string;}
export interface AdoptLegacyRequest {
  workspaceRoot:string;workspaceId:string;serviceId:string;expectedSnapshotDigest:string;
  backupRoot:string;expectedBackupDigest:string;
}
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const largeDigest=(value:unknown)=>sha(canonicalEvidence(value));
const databaseRelative='state/runtime/runtime.db';
const maxFileBytes=64*1024*1024,maxTotalBytes=768*1024*1024;
function options(root:string,id:string):void {slug(id);legacyWorkspace(root,id);}
function noSidecars(root:string):void {
  if(readdirSync(join(root,'state','runtime')).some(name=>name!=='runtime.db'))reject('LEGACY_NOT_QUIESCENT','Stop and close the original Runtime before snapshotting; do not delete its sidecars',409);
}
function bytes(path:string):Buffer {
  privatePath(path,false);const before=lstatSync(path);
  if(before.size>maxFileBytes)reject('MIGRATION_LIMIT','Legacy file exceeds the migration profile');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const value=readFileSync(fd),after=lstatSync(path);if(value.length!==before.size||after.dev!==before.dev||after.ino!==before.ino||after.mtimeMs!==before.mtimeMs)reject('SNAPSHOT_DRIFT','Legacy file changed during inspection',409);return value;}
  finally {closeSync(fd);}
}
function inventory(root:string,whole=false):Entry[] {
  const entries:Entry[]=[],seen=new Set<string>();let total=0;
  function add(relative:string,depth=0):void {
    if(seen.has(relative))return;seen.add(relative);
    if(depth>32||entries.length>=10000)reject('MIGRATION_LIMIT','Legacy inventory exceeds the migration profile');
    const path=join(root,relative),stat=lstatSync(path);
    if(stat.isDirectory()){
      privatePath(path,true);entries.push({path:relative,kind:'directory',bytes:0,sha256:null});
      for(const name of readdirSync(path).sort())add(relative?relative+'/'+name:name,depth+1);
    }else{
      const content=bytes(path);total+=content.length;if(total>maxTotalBytes)reject('MIGRATION_LIMIT','Legacy inventory byte limit');
      entries.push({path:relative,kind:'file',bytes:content.length,sha256:sha(content)});
    }
  }
  if(whole){for(const name of readdirSync(root).sort())add(name);}
  else {
    add('workspace.json');
    // Include only Runtime-owned roots, plus necessary private parent directories.
    for(const dir of ['state','state/runtime']){privatePath(join(root,dir),true);seen.add(dir);entries.push({path:dir,kind:'directory',bytes:0,sha256:null});}
    add(databaseRelative);
    if(existsSync(join(root,'state/runtime-native')))add('state/runtime-native');
    inspectBlobs(root,'runtime'); // Validate legacy content-addressed blob names.
    const ownerRoots=['public/runtime'];
    const projects=join(root,'private/projects');if(existsSync(projects))for(const id of readdirSync(projects).sort())ownerRoots.push('private/projects/'+id+'/runtime');
    for(const ownerRoot of ownerRoots.filter(relative=>existsSync(join(root,relative)))){
      const parts=ownerRoot.split('/');for(let n=1;n<parts.length;n++){
        const relative=parts.slice(0,n).join('/');if(!seen.has(relative)){privatePath(join(root,relative),true);seen.add(relative);entries.push({path:relative,kind:'directory',bytes:0,sha256:null});}
      }
      add(ownerRoot);
    }
  }
  return entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
function quote(value:string):string{return'"'+value.replaceAll('"','""')+'"';}
/** Hash every original table, including later planning/readiness/reconstruction
 * domains. This verifies exact preservation, not semantic/domain acceptance. */
function tables(db:DatabaseSync):TableInventory {
  const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  if(schema.length>256||schema.some(row=>!['table','index'].includes(String(row.type))||/\bVIRTUAL\s+TABLE\b/i.test(String(row.sql))))reject('MIGRATION_SCHEMA','Unrecognized legacy SQLite schema');
  const result:Table[]=[];let total=0;
  for(const item of schema.filter(row=>row.type==='table')){
    const name=String(item.name),columns=db.prepare('PRAGMA table_info('+quote(name)+')').all().map(row=>String(row.name));
    if(!columns.length||columns.length>64)reject('MIGRATION_SCHEMA','Unsupported table shape');
    const statement=db.prepare('SELECT * FROM '+quote(name)+' ORDER BY '+columns.map(quote).join(',')+' LIMIT 100001');statement.setReadBigInts(true);
    const hash=createHash('sha256');let rows=0;
    for(const row of statement.iterate()){
      if(++rows>100000)reject('MIGRATION_LIMIT','Legacy table exceeds the migration row profile');
      const values=columns.map(key=>{const value=row[key];return value instanceof Uint8Array?{blob:Buffer.from(value).toString('hex')}:typeof value==='bigint'?{integer:value.toString()}:value;});
      const text=JSON.stringify(values);total+=Buffer.byteLength(text);if(total>maxTotalBytes)reject('MIGRATION_LIMIT','Legacy table byte limit');hash.update(text+'\n');
    }
    result.push({name,rows,sha256:hash.digest('hex')});
  }
  return{schemaDigest:largeDigest(schema),tables:result};
}
function retain(path:string,content:Buffer|string):void {
  const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,content);fsyncSync(fd);}finally{closeSync(fd);}
  const dir=openSync(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY);try{fsyncSync(dir);}finally{closeSync(dir);}
}
function copiedSeal(root:string):LegacyMigrationSeal|null {
  noSidecars(root);const scratch=mkdtempSync(join(realpathSync(tmpdir()),'runtime-legacy-seal-'));let db:DatabaseSync|undefined;
  try{const path=join(scratch,'snapshot.sqlite');retain(path,bytes(legacyDatabasePath(root)));db=new DatabaseSync(path,{readOnly:true,allowExtension:false});return migrationSeal(db);}
  finally{db?.close();rmSync(scratch,{recursive:true,force:true});}
}
export function inspectLegacyWorkspace(workspaceRoot:string,workspaceId:string):LegacySnapshot {
  options(workspaceRoot,workspaceId);noSidecars(workspaceRoot);
  const before=inventory(workspaceRoot),scratch=mkdtempSync(join(realpathSync(tmpdir()),'runtime-legacy-inspect-'));
  let db:DatabaseSync|undefined;
  try {
    const copy=join(scratch,'snapshot.sqlite');retain(copy,bytes(legacyDatabasePath(workspaceRoot)));
    if(sha(bytes(copy))!==before.find(entry=>entry.path===databaseRelative)!.sha256)reject('SNAPSHOT_DRIFT','Database changed during snapshot',409);
    db=new DatabaseSync(copy,{readOnly:true,allowExtension:false});db.enableDefensive(true);db.exec('BEGIN');
    if(migrationSeal(db))reject('ALREADY_MANAGED','Use the managed service for adopted data');
    const schemaVersion=Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if(![1,2,3,4,5,6,7,8].includes(schemaVersion))reject('MIGRATION_SCHEMA','Unsupported original Runtime schema');
    const identity=readIdentity(workspaceRoot,workspaceId),lineage=readRelocations(db,identity,'runtime');
    const records=inspectRecords(db,validateState),native=inspectNativeSnapshot(db,workspaceRoot);
    if(schemaVersion>=2&&!native)reject('MIGRATION_SCHEMA','Original native identity is missing');
    const database=tables(db);
    noSidecars(workspaceRoot);if(largeDigest(before)!==largeDigest(inventory(workspaceRoot)))reject('SNAPSHOT_DRIFT','Workspace changed during snapshot',409);
    const subject={schema:'runtime-legacy-snapshot/v1' as const,workspaceRoot,workspaceId,schemaVersion,entries:before,database,recordsDigest:records.recordsDigest,nativeRecordsDigest:native?.snapshot.recordsDigest??null,lineageDigest:largeDigest(lineage),requiredKeyIds:[...new Set(lineage.map(row=>row.keyId))].sort()};
    return{...subject,snapshotDigest:largeDigest(subject)};
  } finally {db?.close();rmSync(scratch,{recursive:true,force:true});}
}
function separateBackup(sourceRoot:string,backupRoot:string):void {
  safeAncestors(backupRoot);if(backupRoot===sourceRoot||backupRoot.startsWith(sourceRoot+sep)||sourceRoot.startsWith(backupRoot+sep))reject('MIGRATION_BACKUP_PATH','Backup must be separate from the original workspace');
}
export function createLegacyBackup(workspaceRoot:string,workspaceId:string,expectedSnapshotDigest:string,backupRoot:string):LegacyBackup {
  separateBackup(workspaceRoot,backupRoot);
  const snapshot=inspectLegacyWorkspace(workspaceRoot,workspaceId);
  if(snapshot.snapshotDigest!==expectedSnapshotDigest)reject('SNAPSHOT_DRIFT','Original snapshot differs from the selected migration',409);
  mkdirSync(backupRoot,{mode:0o700});const payload=join(backupRoot,'payload');mkdirSync(payload,{mode:0o700});
  for(const entry of snapshot.entries){const path=join(payload,entry.path);if(entry.kind==='directory')mkdirSync(path,{mode:0o700});else retain(path,bytes(join(workspaceRoot,entry.path)));}
  const body={schema:'runtime-legacy-backup/v1' as const,snapshot},manifest={...body,backupDigest:largeDigest(body)};
  if(largeDigest(inventory(payload,true))!==largeDigest(snapshot.entries)||inspectLegacyWorkspace(workspaceRoot,workspaceId).snapshotDigest!==snapshot.snapshotDigest)reject('SNAPSHOT_DRIFT','Backup or original changed; preserve partial backup for inspection',409);
  retain(join(backupRoot,'manifest.json'),canonicalEvidence(manifest)+'\n');
  return verifyLegacyBackup(backupRoot,manifest.backupDigest);
}
export function verifyLegacyBackup(backupRoot:string,expectedBackupDigest:string):LegacyBackup {
  safeAncestors(backupRoot);privatePath(backupRoot,true);
  if(readdirSync(backupRoot).sort().join(',')!=='manifest.json,payload')reject('MIGRATION_BACKUP_CHANGED','Unexpected backup contents');
  const raw=bytes(join(backupRoot,'manifest.json'));if(raw.length>8388608)reject('MIGRATION_LIMIT','Backup manifest exceeds the profile');
  const manifest=record(JSON.parse(raw.toString('utf8')));exact(manifest,['schema','snapshot','backupDigest']);
  const snapshot=record(manifest.snapshot);exact(snapshot,['schema','workspaceRoot','workspaceId','schemaVersion','entries','database','recordsDigest','nativeRecordsDigest','lineageDigest','requiredKeyIds','snapshotDigest']);
  const {snapshotDigest,...subject}=snapshot;
  if(manifest.schema!=='runtime-legacy-backup/v1'||snapshot.schema!=='runtime-legacy-snapshot/v1'||largeDigest(subject)!==snapshotDigest||manifest.backupDigest!==expectedBackupDigest||largeDigest({schema:manifest.schema,snapshot})!==expectedBackupDigest)reject('MIGRATION_BACKUP_CHANGED','Backup does not match its external digest anchor');
  privatePath(join(backupRoot,'payload'),true);
  if(largeDigest(inventory(join(backupRoot,'payload'),true))!==largeDigest(snapshot.entries))reject('MIGRATION_BACKUP_CHANGED','Backup bytes differ from the selected snapshot');
  return manifest as unknown as LegacyBackup;
}
export function adoptLegacyWorkspace(request:AdoptLegacyRequest):{binding:ManagedLegacyBinding;seal:LegacyMigrationSeal;authority:false} {
  exact(record(request),['workspaceRoot','workspaceId','serviceId','expectedSnapshotDigest','backupRoot','expectedBackupDigest']);
  const {workspaceRoot,workspaceId,serviceId,backupRoot}=request;string(serviceId,128);separateBackup(workspaceRoot,backupRoot);
  const lease=acquireLegacyWriterLease(workspaceRoot,workspaceId);let db:DatabaseSync|undefined,transaction=false;
  try {
    const backup=verifyLegacyBackup(backupRoot,request.expectedBackupDigest);
    if(backup.snapshot.workspaceRoot!==workspaceRoot||backup.snapshot.workspaceId!==workspaceId||backup.snapshot.snapshotDigest!==request.expectedSnapshotDigest)reject('MIGRATION_BACKUP_CHANGED','Backup belongs to a different original workspace');
    // An exact retry reads the committed seal, even after legitimate new writes.
    const existing=copiedSeal(workspaceRoot);
    const result=(seal:LegacyMigrationSeal)=>({binding:{workspaceRoot,workspaceId,serviceId,migrationDigest:seal.migrationDigest},seal,authority:false as const});
    if(existing){
      if(existing.workspaceRoot!==workspaceRoot||existing.workspaceId!==workspaceId||existing.serviceId!==serviceId||existing.sourceSnapshotDigest!==request.expectedSnapshotDigest||existing.backupRoot!==backupRoot||existing.backupDigest!==request.expectedBackupDigest)reject('MIGRATION_BINDING_CHANGED','A different migration already owns this workspace',409);
      return result(existing);
    }
    const snapshot=inspectLegacyWorkspace(workspaceRoot,workspaceId);
    if(snapshot.snapshotDigest!==request.expectedSnapshotDigest)reject('SNAPSHOT_DRIFT','Original differs from the verified backup',409);
    db=new DatabaseSync(legacyDatabasePath(workspaceRoot),{allowExtension:false,timeout:0});db.enableDefensive(true);db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');transaction=true;
    if(Number(db.prepare('PRAGMA user_version').get()?.user_version)!==snapshot.schemaVersion||largeDigest(tables(db))!==largeDigest(snapshot.database)||largeDigest(inventory(workspaceRoot))!==largeDigest(snapshot.entries))reject('SNAPSHOT_DRIFT','Original changed before exclusive adoption',409);
    const body={schema:'runtime-legacy-adoption/v1' as const,workspaceRoot,workspaceId,serviceId,sourceSchemaVersion:snapshot.schemaVersion,sourceSnapshotDigest:snapshot.snapshotDigest,backupRoot,backupDigest:backup.backupDigest,sealedAt:new Date().toISOString()};
    const seal={...body,migrationDigest:digest(body)};
    db.exec('CREATE TABLE runtime_service_migration (singleton INTEGER PRIMARY KEY CHECK(singleton=1), data TEXT NOT NULL)');
    db.prepare('INSERT INTO runtime_service_migration VALUES(1,?)').run(canonical(seal));
    db.exec('PRAGMA user_version=9; COMMIT');transaction=false;
    if(canonical(migrationSeal(db))!==canonical(seal))reject('MIGRATION_CORRUPT','Committed adoption readback differs');
    return result(seal);
  } finally {if(transaction)db!.exec('ROLLBACK');db?.close();lease.close();}
}

export interface LegacyRollbackRequest {
  schema:'runtime-legacy-rollback-plan/v1';requestId:string;selection:WorkspaceSelection;
  backupRoot:string;expectedBackupDigest:string;expectedSourceSnapshotDigest:string;
  preservationRoot:string;expectedPreservationBackupDigest:string;expectedManagedSnapshotDigest:string;
}
export interface LegacyRollbackResult {
  schema:'runtime-legacy-rollback-result/v1';requestId:string;requestDigest:string;
  backupDigest:string;sourceSnapshotDigest:string;preservationBackupDigest:string;managedSnapshotDigest:string;
  migrationDigest:string;sourceSchemaVersion:number;managedSchemaVersion:9;
  restoredSnapshot:LegacySnapshot;additiveEntries:Entry[];preservedDatabase:string;preservedDatabaseSha256:string;
  status:'OLD_FORMAT_RESTORED';completedAt:string;currentStateAttestation:false;
  serviceStarted:false;hostRegistered:false;businessWorkDispatched:false;authority:false;resultDigest:string;
}
interface RollbackDatabase {dev:number;ino:number;bytes:number;sha256:string;}
interface RollbackJournal {
  schema:'runtime-legacy-rollback-journal/v1';requestDigest:string;
  phase:'PREPARED'|'STAGED'|'PRESERVED'|'PUBLISHED'|'VERIFIED';
  managed:RollbackDatabase;seal:LegacyMigrationSeal;lastError:string|null;result:LegacyRollbackResult|null;
}
function rollbackConflict():never {return reject('LEGACY_ROLLBACK_CONFLICT','Retain and inspect the changed or unknown rollback state',409);}
const same=(a:unknown,b:unknown)=>largeDigest(a)===largeDigest(b);
/** The only exception to ordinary nlink=1 reads is this protocol's exact pair.
 * Never pass either linked path to an ordinary writer or weaken privatePath. */
function rollbackDatabase(file:string,links:1|2):RollbackDatabase {
  safeAncestors(dirname(file));const before=lstatSync(file);
  if(!before.isFile()||before.uid!==process.getuid!()||(before.mode&0o777)!==0o600||before.nlink!==links||before.size>maxFileBytes)rollbackConflict();
  const stable=(s:NonNullable<ReturnType<typeof lstatSync>>)=>s.dev===before.dev&&s.ino===before.ino&&s.size===before.size&&s.mtimeMs===before.mtimeMs&&s.ctimeMs===before.ctimeMs&&s.nlink===links&&s.uid===before.uid&&s.mode===before.mode;
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{if(!stable(fstatSync(fd)))rollbackConflict();const content=readFileSync(fd);if(content.length!==before.size||!stable(fstatSync(fd))||!stable(lstatSync(file)))rollbackConflict();return{dev:before.dev,ino:before.ino,bytes:content.length,sha256:sha(content)};}
  finally{closeSync(fd);}
}
/** Check complete unaffected inventories, including unknown additions. The DB
 * alone may have two names or old bytes during exact recovery. */
function unchangedRollbackTree(root:string,expected:MaintenanceEntry[],excluded:string[]):void {
  const pending=new Map(expected.filter(e=>!excluded.includes(e.path)).map(e=>[e.path,e]));let count=0;
  function visit(relative:string):void {
    const directory=join(root,relative);for(const name of readdirSync(directory)){
      const key=relative?relative+'/'+name:name;if(excluded.includes(key))continue;
      if(++count>expected.length)rollbackConflict();const entry=pending.get(key);if(!entry)rollbackConflict();pending.delete(key);
      const file=join(root,key),st=lstatSync(file);if(st.uid!==process.getuid!())rollbackConflict();
      if(entry.kind==='directory'){
        if(!st.isDirectory()||(st.mode&0o777)!==entry.mode)rollbackConflict();visit(key);
      }else if(entry.kind==='symlink'){
        if(!st.isSymbolicLink()||readlinkSync(file)!==entry.target||!realpathSync(file).startsWith(root+sep))rollbackConflict();
      }else{
        if(!same(hashMaintenanceFile(file),{bytes:entry.bytes,sha256:entry.sha256,mode:entry.mode}))rollbackConflict();
      }
    }
  }
  visit('');if(pending.size)rollbackConflict();
}
function unchangedRollbackEvidence(snapshot:ManagedWorkspaceSnapshot):void {
  const selection=snapshot.selection;
  for(const role of ['project','workspace','service'] as const){
    const root=selection[role==='project'?'projectRoot':role==='workspace'?'workspaceRoot':'serviceRoot'];
    unchangedRollbackTree(root,snapshot.roots[role],role==='project'?[]:[...heldMaintenanceTransients(snapshot,role),...(role==='workspace'?[databaseRelative]:[])]);
  }
  for(const ref of snapshot.references)if(!same(hashMaintenanceFile(ref.path),{bytes:ref.bytes,sha256:ref.sha256,mode:ref.mode}))rollbackConflict();
}
/** Original non-DB bytes must remain compatible; additive evidence stays live.
 * This is intentionally not a general file/owner/budget rollback operation. */
function legacySubset(original:LegacySnapshot,current:ManagedWorkspaceSnapshot):void {
  const entries=new Map(current.roots.workspace.map(e=>[e.path,e]));
  for(const old of original.entries){
    if(old.path===databaseRelative)continue;const now=entries.get(old.path);
    if(!now||now.kind!==old.kind||now.bytes!==old.bytes||(old.kind==='file'&&now.sha256!==old.sha256))reject('LEGACY_ROLLBACK_ASSET_CHANGED','An original non-database Runtime entry changed; no asset will be rolled back',409);
  }
}
/** Explicit stopped operator restoration at the original location only. A
 * completed retry reports its historical receipt, never current-state approval.
 * The new service ledger/budgets and all owner/evidence files remain untouched. */
export async function rollbackLegacyWorkspace(value:LegacyRollbackRequest,signal?:AbortSignal):Promise<LegacyRollbackResult> {
  const request=structuredClone(value);
  exact(record(request),['schema','requestId','selection','backupRoot','expectedBackupDigest','expectedSourceSnapshotDigest','preservationRoot','expectedPreservationBackupDigest','expectedManagedSnapshotDigest']);
  if(request.schema!=='runtime-legacy-rollback-plan/v1')rollbackConflict();slug(request.requestId);
  for(const h of [request.expectedBackupDigest,request.expectedSourceSnapshotDigest,request.expectedPreservationBackupDigest,request.expectedManagedSnapshotDigest])if(typeof h!=='string'||!/^[a-f0-9]{64}$/.test(h))rollbackConflict();
  const {selection,backupRoot,preservationRoot,requestId}=request,{workspaceRoot,workspaceId}=selection;
  const control=workspaceRoot+'.evopilot-legacy-rollback',operation=join(control,requestId),journalRef=join(operation,'journal.json'),stage=join(operation,'old.sqlite'),preserved=join(operation,'managed.sqlite'),live=legacyDatabasePath(workspaceRoot);
  separateRoots([selection.projectRoot,workspaceRoot,selection.serviceRoot,backupRoot,preservationRoot,control]);maintenanceLocation(control,true);
  const requestDigest=largeDigest(request),original=verifyLegacyBackup(backupRoot,request.expectedBackupDigest),managed=verifyManagedWorkspaceBackup(preservationRoot,request.expectedPreservationBackupDigest),snapshot=managed.snapshot;
  if(original.snapshot.workspaceRoot!==workspaceRoot||original.snapshot.workspaceId!==workspaceId||original.snapshot.snapshotDigest!==request.expectedSourceSnapshotDigest||snapshot.snapshotDigest!==request.expectedManagedSnapshotDigest||!same(snapshot.selection,selection))rollbackConflict();
  const oldEntry=original.snapshot.entries.find(e=>e.path===databaseRelative),managedEntry=snapshot.roots.workspace.find(e=>e.path===databaseRelative);
  if(oldEntry?.kind!=='file'||managedEntry?.kind!=='file'||![1,2,3,4,5,6,7,8].includes(original.snapshot.schemaVersion))rollbackConflict();
  const oldHash=oldEntry.sha256,managedHash=managedEntry.sha256;
  legacySubset(original.snapshot,snapshot);
  const sealMatches=(seal:LegacyMigrationSeal)=>seal.workspaceRoot===workspaceRoot&&seal.workspaceId===workspaceId&&seal.serviceId===selection.serviceId&&seal.migrationDigest===selection.migrationDigest&&seal.backupRoot===backupRoot&&seal.backupDigest===request.expectedBackupDigest&&seal.sourceSnapshotDigest===request.expectedSourceSnapshotDigest&&seal.sourceSchemaVersion===original.snapshot.schemaVersion;
  const load=():RollbackJournal|null=>{
    if(!existsSync(operation))return null;privatePath(operation,true);
    if(readdirSync(operation).some(name=>!['journal.json','old.sqlite','managed.sqlite'].includes(name))||!existsSync(journalRef))rollbackConflict();
    const raw=record(JSON.parse(bytes(journalRef).toString())),{journalDigest,...body}=raw;
    exact(raw,['schema','requestDigest','phase','managed','seal','lastError','result','journalDigest']);
    const journal=body as unknown as RollbackJournal;
    if(journalDigest!==largeDigest(body)||journal.schema!=='runtime-legacy-rollback-journal/v1'||journal.requestDigest!==requestDigest||!['PREPARED','STAGED','PRESERVED','PUBLISHED','VERIFIED'].includes(journal.phase)||!sealMatches(journal.seal)||journal.managed.sha256!==managedHash||journal.managed.bytes!==managedEntry.bytes)rollbackConflict();
    if(journal.phase==='VERIFIED'){
      if(!journal.result)rollbackConflict();const {resultDigest,...result}=journal.result;
      if(resultDigest!==largeDigest(result)||result.requestDigest!==requestDigest||result.status!=='OLD_FORMAT_RESTORED'||result.currentStateAttestation!==false||result.authority!==false||result.serviceStarted!==false||result.hostRegistered!==false||result.businessWorkDispatched!==false||result.preservedDatabase!==preserved||!same(rollbackDatabase(preserved,1),journal.managed))rollbackConflict();
    }else if(journal.result!==null)rollbackConflict();
    return journal;
  };
  const previous=load();if(previous?.phase==='VERIFIED')return previous.result!;
  let journal:RollbackJournal|undefined;
  const persist=()=>{if(!journal)rollbackConflict();save(journalRef,{...journal,journalDigest:largeDigest(journal)});};
  return withRestoringWorkspace(selection,requestId,()=>{},capture=>{
    journal=load()??undefined;if(journal?.phase==='VERIFIED')return journal.result!;
    try{
      signal?.throwIfAborted();verifyLegacyBackup(backupRoot,request.expectedBackupDigest);verifyManagedWorkspaceBackup(preservationRoot,request.expectedPreservationBackupDigest);noSidecars(workspaceRoot);
      if(!journal){
        if(!preservationSnapshotMatches(capture(),snapshot))rollbackConflict();const seal=copiedSeal(workspaceRoot);
        if(!seal||!sealMatches(seal))rollbackConflict();const current=rollbackDatabase(live,1);
        if(current.sha256!==managedHash)rollbackConflict();
        // Validate the original in scratch before retaining any publication state.
        const scratch=mkdtempSync(join(realpathSync(tmpdir()),'runtime-rollback-validate-'));let db:DatabaseSync|undefined;
        try{
          const file=join(scratch,'old.sqlite');retain(file,bytes(join(backupRoot,'payload',databaseRelative)));db=new DatabaseSync(file,{readOnly:true,allowExtension:false});
          if(migrationSeal(db)||Number(db.prepare('PRAGMA user_version').get()?.user_version)!==original.snapshot.schemaVersion||!same(tables(db),original.snapshot.database)||inspectRecords(db,validateState).recordsDigest!==original.snapshot.recordsDigest||(inspectNativeSnapshot(db,workspaceRoot)?.snapshot.recordsDigest??null)!==original.snapshot.nativeRecordsDigest||largeDigest(readRelocations(db,readIdentity(workspaceRoot,workspaceId),'runtime'))!==original.snapshot.lineageDigest)rollbackConflict();
        }finally{db?.close();rmSync(scratch,{recursive:true,force:true});}
        mkdir(control);if(lstatSync(control).dev!==current.dev)rollbackConflict();mkdirSync(operation,{mode:0o700});syncDirectory(control);
        journal={schema:'runtime-legacy-rollback-journal/v1',requestDigest,phase:'PREPARED',managed:current,seal,lastError:null,result:null};persist();
      }
      unchangedRollbackEvidence(snapshot);signal?.throwIfAborted();
      const linked=existsSync(preserved)&&lstatSync(live).ino===lstatSync(preserved).ino&&lstatSync(live).dev===lstatSync(preserved).dev;
      const current=rollbackDatabase(live,linked?2:1),retained=existsSync(preserved)?rollbackDatabase(preserved,linked?2:1):null;
      const published=current.sha256===oldHash&&current.bytes===oldEntry.bytes;
      if(published){
        if(existsSync(stage)||!retained||!same(retained,journal.managed))rollbackConflict();
      }else{
        if(!same(current,journal.managed)||retained&&!same(retained,current)||['PUBLISHED','VERIFIED'].includes(journal.phase))rollbackConflict();
        if(!existsSync(stage)){
          if(retained||journal.phase!=='PREPARED')rollbackConflict();retain(stage,bytes(join(backupRoot,'payload',databaseRelative)));
        }
        const staged=rollbackDatabase(stage,1);if(staged.sha256!==oldHash||staged.bytes!==oldEntry.bytes||staged.dev!==current.dev)rollbackConflict();
        journal.phase='STAGED';journal.lastError=null;persist();signal?.throwIfAborted();
        if(!retained){linkSync(live,preserved);syncDirectory(operation);}
        if(!same(rollbackDatabase(live,2),journal.managed)||!same(rollbackDatabase(preserved,2),journal.managed))rollbackConflict();
        journal.phase='PRESERVED';persist();signal?.throwIfAborted();
        unchangedRollbackEvidence(snapshot);
        if(!same(rollbackDatabase(live,2),journal.managed)||!same(rollbackDatabase(preserved,2),journal.managed)||!same(rollbackDatabase(stage,1),staged))rollbackConflict();
        renameSync(stage,live);
      }
      syncDirectory(dirname(live));syncDirectory(operation);
      journal.phase='PUBLISHED';persist();signal?.throwIfAborted();
      if(!same(rollbackDatabase(preserved,1),journal.managed)||rollbackDatabase(live,1).sha256!==oldHash)rollbackConflict();
      unchangedRollbackEvidence(snapshot);const restoredSnapshot=inspectLegacyWorkspace(workspaceRoot,workspaceId);
      if(restoredSnapshot.schemaVersion!==original.snapshot.schemaVersion||!same(restoredSnapshot.database,original.snapshot.database)||restoredSnapshot.recordsDigest!==original.snapshot.recordsDigest||restoredSnapshot.nativeRecordsDigest!==original.snapshot.nativeRecordsDigest||restoredSnapshot.lineageDigest!==original.snapshot.lineageDigest)rollbackConflict();
      verifyLegacyBackup(backupRoot,request.expectedBackupDigest);verifyManagedWorkspaceBackup(preservationRoot,request.expectedPreservationBackupDigest);
      const oldPaths=new Set(original.snapshot.entries.map(e=>e.path)),additiveEntries=restoredSnapshot.entries.filter(e=>!oldPaths.has(e.path));
      const body={schema:'runtime-legacy-rollback-result/v1' as const,requestId,requestDigest,backupDigest:request.expectedBackupDigest,sourceSnapshotDigest:request.expectedSourceSnapshotDigest,preservationBackupDigest:request.expectedPreservationBackupDigest,managedSnapshotDigest:request.expectedManagedSnapshotDigest,migrationDigest:journal.seal.migrationDigest,sourceSchemaVersion:original.snapshot.schemaVersion,managedSchemaVersion:9 as const,restoredSnapshot,additiveEntries,preservedDatabase:preserved,preservedDatabaseSha256:managedHash,status:'OLD_FORMAT_RESTORED' as const,completedAt:new Date().toISOString(),currentStateAttestation:false as const,serviceStarted:false as const,hostRegistered:false as const,businessWorkDispatched:false as const,authority:false as const};
      const result={...body,resultDigest:largeDigest(body)};journal={...journal,phase:'VERIFIED',lastError:null,result};persist();return result;
    }catch(error){if(journal&&journal.phase!=='VERIFIED'){journal.lastError=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:'LEGACY_ROLLBACK_INTERRUPTED';persist();}throw error;}
  },signal);
}
