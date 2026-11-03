import {AsyncLocalStorage} from 'node:async_hooks';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,lstatSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {canonical,digest,exact,record,reject,slug,string} from '../server/errors.js';
import {privateFile} from '../server/security.js';
import {privatePath,readIdentity,safeAncestors} from '../location-lineage.js';

/** Internal capability, never obtained from an HTTP request or a legacy envelope.
 * Schema 9 preserves the old domain tables and prevents a fresh 0.8.x writer
 * from opening the adopted database. The operator must stop existing old writers
 * before adoption; a schema marker cannot revoke an already-open old binary. */
export interface ManagedLegacyBinding {
  workspaceRoot:string;workspaceId:string;serviceId:string;migrationDigest:string;
}
export interface LegacyMigrationSeal {
  schema:'runtime-legacy-adoption/v1';workspaceRoot:string;workspaceId:string;
  serviceId:string;sourceSchemaVersion:number;sourceSnapshotDigest:string;
  backupRoot:string;backupDigest:string;sealedAt:string;migrationDigest:string;
}
interface Context {binding:Readonly<ManagedLegacyBinding>;active:boolean;device:number;inode:number;}
const contexts=new AsyncLocalStorage<Context>();
export const LEGACY_MANAGED_SCHEMA=9;
export const legacyDatabasePath=(root:string):string=>join(root,'state','runtime','runtime.db');
export function legacyWorkspace(root:string,id:string):void {
  slug(id);const identity=readIdentity(root,id);
  if(identity.canonicalRoot!==root)reject('IDENTITY_MISMATCH','Legacy workspace must retain its exact canonical identity');
  privatePath(join(root,'state'),true);privatePath(join(root,'state','runtime'),true);
  privatePath(legacyDatabasePath(root),false);
  for(const suffix of ['-wal','-shm','-journal'])if(existsSync(legacyDatabasePath(root)+suffix))privatePath(legacyDatabasePath(root)+suffix,false);
}
export function migrationSeal(db:DatabaseSync):LegacyMigrationSeal|null {
  const present=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_service_migration'").get();
  const version=Number(db.prepare('PRAGMA user_version').get()?.user_version);
  if(!present){if(version===LEGACY_MANAGED_SCHEMA)reject('MIGRATION_CORRUPT','Managed schema lacks its immutable adoption record');return null;}
  if(version!==LEGACY_MANAGED_SCHEMA)reject('MIGRATION_DOWNGRADE','An adopted database cannot be downgraded in place');
  const rows=db.prepare('SELECT singleton,data FROM runtime_service_migration LIMIT 2').all();
  if(rows.length!==1||rows[0].singleton!==1||typeof rows[0].data!=='string'||rows[0].data.length>16384)reject('MIGRATION_CORRUPT','Invalid adoption record');
  const value=record(JSON.parse(rows[0].data));
  exact(value,['schema','workspaceRoot','workspaceId','serviceId','sourceSchemaVersion','sourceSnapshotDigest','backupRoot','backupDigest','sealedAt','migrationDigest']);
  slug(value.workspaceId);string(value.serviceId,128);safeAncestors(string(value.workspaceRoot,4096));safeAncestors(string(value.backupRoot,4096));
  if(value.schema!=='runtime-legacy-adoption/v1'||!Number.isInteger(value.sourceSchemaVersion)||Number(value.sourceSchemaVersion)<1||Number(value.sourceSchemaVersion)>8||typeof value.sealedAt!=='string'||!Number.isFinite(Date.parse(value.sealedAt)))reject('MIGRATION_CORRUPT','Invalid adoption metadata');
  for(const key of ['sourceSnapshotDigest','backupDigest','migrationDigest'])if(typeof value[key]!=='string'||!/^[a-f0-9]{64}$/.test(value[key]))reject('MIGRATION_CORRUPT','Invalid adoption digest');
  const {migrationDigest,...body}=value;
  if(digest(body)!==migrationDigest||canonical(value)!==rows[0].data)reject('MIGRATION_CORRUPT','Adoption record integrity differs');
  return value as unknown as LegacyMigrationSeal;
}
function matches(seal:LegacyMigrationSeal,binding:ManagedLegacyBinding):void {
  for(const key of ['workspaceRoot','workspaceId','serviceId','migrationDigest'] as const)if(seal[key]!==binding[key])reject('MIGRATION_BINDING_CHANGED','Legacy store does not belong to this exact Runtime service',409);
}
export function assertManagedStateAccess(db:DatabaseSync,root:string,id:string):LegacyMigrationSeal|null {
  if(![1,2,3,4,5,6,7,8,9].includes(Number(db.prepare('PRAGMA user_version').get()?.user_version)))reject('MIGRATION_CORRUPT','Unexpected managed database schema');
  const seal=migrationSeal(db);if(!seal)return null;
  const context=contexts.getStore();
  if(!context?.active||context.binding.workspaceRoot!==root||context.binding.workspaceId!==id)reject('MANAGED_SERVICE_REQUIRED','This database is owned by the independent Runtime service',409);
  matches(seal,context.binding);
  const stat=lstatSync(legacyDatabasePath(root));
  if(stat.dev!==context.device||stat.ino!==context.inode)reject('MIGRATION_BINDING_CHANGED','Managed database file was replaced',409);
  return seal;
}
/** OS lock only: it does not prove old 0.8.x processes have been stopped. */
export function acquireLegacyWriterLease(root:string,id:string):{close:()=>void} {
  legacyWorkspace(root,id);
  const control=join(root,'state','runtime-service');
  if(!existsSync(control))mkdirSync(control,{mode:0o700});
  privatePath(control,true);
  const path=join(control,'writer-lock.sqlite');privateFile(path,true);
  for(const suffix of ['-wal','-shm','-journal'])if(existsSync(path+suffix))privateFile(path+suffix);
  const lock=new DatabaseSync(path,{allowExtension:false});lock.enableDefensive(true);
  try {lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}
  catch {lock.close();reject('LEGACY_WRITER_ACTIVE','This legacy store already has a managed writer or migration',409);}
  let closed=false;return{close(){if(!closed){lock.close();closed=true;}}};
}
export function acquireManagedLegacyContext(input:ManagedLegacyBinding):{run:<T>(fn:()=>T)=>T;close:()=>void} {
  exact(record(input),['workspaceRoot','workspaceId','serviceId','migrationDigest']);
  string(input.serviceId,128);string(input.migrationDigest,64);
  const binding=Object.freeze({...input}),lease=acquireLegacyWriterLease(binding.workspaceRoot,binding.workspaceId);
  try {
    const db=new DatabaseSync(legacyDatabasePath(binding.workspaceRoot),{readOnly:true,allowExtension:false});
    try {const seal=migrationSeal(db);if(!seal)reject('MIGRATION_REQUIRED','Legacy store has not been adopted');matches(seal,binding);} finally {db.close();}
    const stat=lstatSync(legacyDatabasePath(binding.workspaceRoot));
    const context:Context={binding,active:true,device:stat.dev,inode:stat.ino};
    return{run<T>(fn:()=>T):T{if(!context.active)reject('CLOSED','Managed legacy service is closed');return contexts.run(context,fn);},close(){if(context.active){context.active=false;lease.close();}}};
  } catch(error) {lease.close();throw error;}
}
