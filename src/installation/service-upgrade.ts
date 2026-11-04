/** Explicit, stopped independent-service upgrade. Original business databases
 * are never opened by SQLite: identity, pending work and ledger checks run on
 * private copies. A new installation retains original records verbatim and may
 * read the sealed old Base only through the internal historical reader. */
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {isDeepStrictEqual as equal} from 'node:util';
import {canonical,canonicalEvidence,exact,record,reject,slug,string} from '../server/errors.js';
import {privateFile,readPrivateJson} from '../server/security.js';
import {RuntimeStore} from '../server/store.js';
import {canonicalPath,readRegular} from '../compat/project/files.js';
import {inspectAllTables,type TableInventory} from '../compat/table-inventory.js';
import {byteDigest,loadPublisherBase,valueDigest,type BasePin} from '../lifecycle/base.js';
import {loadServiceUpgradeContext,validateServiceUpgradeContext,type ServiceUpgradeContext,type HistoricalRecord} from '../lifecycle/base-upgrade.js';
import {inspectInstalledServiceSelection,type InstalledServiceSelection} from './service-control.js';
import {inspectUserService,type UserServiceSpecification} from './service.js';
import {prepareStagedHostMaterial,runInstaller,verifyInstalledRuntimePackage,type RuntimeInstallPlan} from './installer.js';
import {copyInventory,mkdir,save,syncDirectory} from './workspace/backup.js';
import {copyMaintenanceFile,hashMaintenanceFile,inspectMaintenanceTree,type MaintenanceEntry} from './workspace/stream.js';
import {maintenanceLocation,separateRoots} from './workspace/snapshot.js';
// The server imports the passive helper directly from lifecycle/base-upgrade;
// no migration/installer function is reachable from the HTTP module graph.
export {acquireUpgradeSourceLease} from '../lifecycle/base-upgrade.js';

export interface ServiceUpgradeSnapshot {
  schema:'runtime-service-upgrade-snapshot/v1';workspaceId:string;serviceId:string;
  sourceInstalledRoot:string;sourceManifestDigest:string;sourceArchiveDigest:string;sourceBasePin:BasePin;
  source:InstalledServiceSelection;historicalRecords:HistoricalRecord[];installation:MaintenanceEntry[];
  database:TableInventory;references:{path:string;bytes:number;sha256:string;mode:number}[];
  transientExclusions:string[];authority:false;
}
export interface ServiceUpgradePlan {
  schema:'runtime-service-upgrade-plan/v1';requestId:string;source:InstalledServiceSelection;
  expectedSourceSnapshotDigest:string;backupRoot:string;destinationInstallPlanRef:string;destinationInstallPlanSha256:string;
}
export interface ServiceUpgradeReceipt {
  schema:'runtime-service-upgrade-receipt/v1';requestId:string;planDigest:string;
  backupRoot:string;backupDigest:string;sourceSnapshotDigest:string;sourceInstalledRoot:string;
  destinationRoot:string;destinationSelectionDigest:string;workspaceId:string;serviceId:string;
  sourceBasePin:BasePin;destinationBasePin:BasePin;status:'STAGED';
  serviceStarted:false;hostRegistered:false;businessWorkDispatched:false;authority:false;receiptDigest:string;
}
export interface ServiceRollbackPlan {
  schema:'runtime-service-rollback-plan/v1';requestId:string;upgradeReceiptRef:string;upgradeReceiptSha256:string;
  destination:InstalledServiceSelection;expectedDestinationSnapshotDigest:string;preservationRoot:string;
}
const LOCK_PATHS=['installer-lock.sqlite','data/writer-lock.sqlite'];
const TRANSIENTS=LOCK_PATHS.flatMap(name=>[name,...['-journal','-wal','-shm'].map(s=>name+s)]);
const hash=(v:unknown):string=>{const h=string(v,71);if(!/^sha256:[a-f0-9]{64}$/.test(h))reject('SERVICE_UPGRADE_DIGEST','Use an exact sha256-prefixed digest');return h;};
const json=(ref:string,max=8388608):unknown=>JSON.parse(readRegular(ref,max,true).toString('utf8'));
const snapshotBytes=(snapshot:ServiceUpgradeSnapshot):string=>canonicalEvidence(snapshot)+'\n';
const snapshotDigest=(snapshot:ServiceUpgradeSnapshot):string=>byteDigest(snapshotBytes(snapshot));
const prefixed=(h:string):string=>'sha256:'+h;
function requestId(v:unknown):string{return slug(v);}
function independent(plan:RuntimeInstallPlan):void {
  if(plan.legacyMigration||plan.legacyOwnerHost||plan.legacyProviders||plan.workspaceOperator||plan.workspaceSetup)reject('SERVICE_UPGRADE_SCOPE','Only the selected independent service is supported; legacy Workspace migration is separate',409);
}
function selection(input:InstalledServiceSelection):InstalledServiceSelection {
  const current=inspectInstalledServiceSelection(string(record(input).serviceRoot,4096));
  if(!equal(current,input)||current.binding!==null)reject('SERVICE_UPGRADE_SOURCE_CHANGED','Select the exact independent installed service',409);
  independent(readPrivateJson(path.join(current.serviceRoot,'installation-plan.json')) as RuntimeInstallPlan);return current;
}
function inventory(root:string):MaintenanceEntry[]{return inspectMaintenanceTree(root).filter(e=>!TRANSIENTS.includes(e.path));}
function sourceBase(root:string):{pin:BasePin;base:Buffer;manifest:Buffer}{
  const directory=path.join(root,'package/lifecycle/base'),manifest=readRegular(path.join(directory,'manifest.json'),131072),m=record(JSON.parse(manifest.toString()));
  exact(m,['schema','publisher','bases']);if(m.schema!=='runtime-base-distribution/v1'||m.publisher!=='evopilot-runtime'||!Array.isArray(m.bases)||m.bases.length!==1)reject('SERVICE_UPGRADE_BASE','Select the source installation publisher Base',409);
  const entry=record(m.bases[0]);exact(entry,['id','version','schemaVersion','file','digest']);
  const name=string(entry.file,128);if(!/^[A-Za-z0-9.-]+\.json$/.test(name))reject('SERVICE_UPGRADE_BASE','Unsafe source Base filename');
  const {file:unused,...pin}=entry,base=readRegular(path.join(directory,name),131072);
  const p=pin as unknown as BasePin;slug(p.id);string(p.version,128);string(p.schemaVersion,128);hash(p.digest);
  const b=record(JSON.parse(base.toString()));if(byteDigest(base)!==p.digest||b.id!==p.id||b.version!==p.version||b.schema!==p.schemaVersion||b.publisher!=='evopilot-runtime')reject('SERVICE_UPGRADE_BASE','Source Base bytes differ from their installed publisher pin',409);
  return{pin:p,base,manifest};
}
function lock(ref:string,code:string,create=false):DatabaseSync{
  canonicalPath(ref,create);privateFile(ref,create);const db=new DatabaseSync(ref,{allowExtension:false});
  try{db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');return db;}catch{db.close();return reject(code,'Another process owns the selected installation or service writer',409);}
}
function releaseLocks(handles:(DatabaseSync|undefined)[],original?:unknown):void{
  const errors:unknown[]=original===undefined?[]:[original];
  for(const handle of handles)try{handle?.close();}catch(error){errors.push(error);}
  if(errors.length===1)throw errors[0];if(errors.length>1)throw new AggregateError(errors,'Service upgrade lock cleanup failed',{cause:errors[0]});
}
function closeLeases(handles:({close():void}|undefined)[],original?:unknown):void{
  const errors:unknown[]=[];for(const handle of handles)try{handle?.close();}catch(error){errors.push(error);}
  if(errors.length){if(original!==undefined)errors.unshift(original);if(errors.length===1)throw errors[0];throw new AggregateError(errors,'Service upgrade cleanup failed',{cause:errors[0]});}
}
/** Locks are coordination infrastructure. Their journals/SHM bytes are excluded
 * explicitly, never confused with immutable business evidence. */
async function stoppedLease(input:InstalledServiceSelection):Promise<{close():void;current:InstalledServiceSelection}>{
  const current=selection(input),root=current.serviceRoot;let installer:DatabaseSync|undefined,writer:DatabaseSync|undefined;
  try{
    installer=lock(path.join(root,'installer-lock.sqlite'),'INSTALLER_ACTIVE');
    const spec=readPrivateJson(path.join(root,'service-specification.json')) as UserServiceSpecification;
    const observed=await inspectUserService(spec);if(observed.registered||observed.running)reject('SERVICE_UPGRADE_NOT_STOPPED','Explicitly stop the original owned service before migration; no business work will be terminated',409);
    writer=lock(path.join(root,'data/writer-lock.sqlite'),'WRITER_ACTIVE');
    for(const suffix of ['-wal','-shm','-journal'])if(fs.existsSync(path.join(root,'data/service.sqlite')+suffix))reject('SERVICE_UPGRADE_NOT_QUIESCENT','Original database sidecars remain; inspect the original writer before retrying',409);
    selection(current);let closed=false;return{current,close(){if(!closed){closed=true;releaseLocks([writer,installer]);}}};
  }catch(error){releaseLocks([writer,installer],error);throw error;}
}
function copiedLedger(root:string,current:InstalledServiceSelection):{database:TableInventory;historicalRecords:HistoricalRecord[]}{
  const original=path.join(root,'data/service.sqlite'),pin=hashMaintenanceFile(original),scratch=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'runtime-service-upgrade-'));
  try{
    copyMaintenanceFile(original,path.join(scratch,'service.sqlite'),{path:'service.sqlite',kind:'file',...pin});
    // Capture the untouched copy first. RuntimeStore validates the ledger but
    // also ensures its indexes exist; that must never silently repair an
    // incomplete source and then describe the repaired schema as original.
    const untouched=new DatabaseSync(path.join(scratch,'service.sqlite'),{readOnly:true,allowExtension:false});let originalDatabase:TableInventory;
    try{originalDatabase=inspectAllTables(untouched);}finally{untouched.close();}
    const store=new RuntimeStore(scratch,current.workspaceId);try{if(store.serviceId!==current.serviceId)reject('SERVICE_UPGRADE_IDENTITY','Original database has a different service identity',409);}finally{store.close();}
    const db=new DatabaseSync(path.join(scratch,'service.sqlite'),{readOnly:true,allowExtension:false});
    try{
      const database=inspectAllTables(db);
      if(!equal(database,originalDatabase))reject('SERVICE_UPGRADE_DATABASE_CHANGED','Source schema or table inventory required repair during private-copy validation; the original remains unchanged',409);
      if(db.prepare("SELECT 1 AS n FROM objects WHERE kind='stage-progress' AND (json_extract(data,'$.terminal') IS NOT 1) LIMIT 1").get()||db.prepare("SELECT 1 AS n FROM objects r WHERE r.kind='stage-request' AND NOT EXISTS (SELECT 1 FROM objects p WHERE p.project_id=r.project_id AND p.kind='stage-progress' AND p.id=r.id AND json_extract(p.data,'$.terminal')=1) LIMIT 1").get())reject('SERVICE_UPGRADE_PENDING','Reconcile every original pending request before migration',409);
      const historicalRecords:HistoricalRecord[]=[];
      const rows=db.prepare("SELECT project_id,kind,id,data FROM objects WHERE kind IN ('definition-revision','lifecycle-instance') ORDER BY project_id,kind,id LIMIT 16385").all();
      if(rows.length>16384)reject('SERVICE_UPGRADE_LIMIT','Historical record inventory exceeds the supported bounded profile');
      for(const r of rows){
        const value=record(JSON.parse(String(r.data))),kind=String(r.kind) as HistoricalRecord['kind'];
        if(kind==='lifecycle-instance'&&Object.values(record(value.stages)).some(v=>['RUNNING','UNKNOWN'].includes(String(record(v).status))))reject('SERVICE_UPGRADE_PENDING','Original running or uncertain lifecycle work must be reconciled before migration',409);
        historicalRecords.push({projectId:String(r.project_id),kind,id:String(r.id),valueDigest:valueDigest(value)});
      }
      if(!equal(hashMaintenanceFile(original),pin))reject('SERVICE_UPGRADE_SOURCE_CHANGED','Original database changed while inspecting its private copy',409);
      return{database,historicalRecords};
    }finally{db.close();}
  }finally{fs.rmSync(scratch,{recursive:true,force:true});}
}
function capture(current:InstalledServiceSelection):ServiceUpgradeSnapshot{
  selection(current);const root=current.serviceRoot,before=inventory(root),base=sourceBase(root),plan=readPrivateJson(path.join(root,'installation-plan.json')) as RuntimeInstallPlan;
  const references=Object.keys(current.configurationPins).filter(ref=>!ref.startsWith(root+path.sep)).sort().map(ref=>({path:ref,...hashMaintenanceFile(ref)}));
  for(const r of references)if(r.sha256!==current.configurationPins[r.path])reject('SERVICE_UPGRADE_SOURCE_CHANGED','A selected external configuration changed',409);
  const ledger=copiedLedger(root,current);
  if(!equal(before,inventory(root)))reject('SERVICE_UPGRADE_SOURCE_CHANGED','Original installation changed during capture',409);
  const snapshot:ServiceUpgradeSnapshot={schema:'runtime-service-upgrade-snapshot/v1',workspaceId:current.workspaceId,serviceId:current.serviceId,sourceInstalledRoot:root,sourceManifestDigest:prefixed(plan.distribution.manifestDigest),sourceArchiveDigest:prefixed(plan.distribution.archiveDigest),sourceBasePin:base.pin,source:current,...ledger,installation:before,references,transientExclusions:[...TRANSIENTS],authority:false};
  snapshotBytes(snapshot);return snapshot;
}
/** Read-only inspection may acquire existing coordination locks, but never
 * opens the original business database, starts a service or creates a backup. */
export async function inspectServiceUpgradeSource(input:InstalledServiceSelection):Promise<{snapshot:ServiceUpgradeSnapshot;sourceSnapshotDigest:string}>{
  const lease=await stoppedLease(structuredClone(input));let failure:unknown;try{const snapshot=capture(lease.current);return{snapshot,sourceSnapshotDigest:snapshotDigest(snapshot)};}catch(error){failure=error;throw error;}finally{closeLeases([lease],failure);}
}
function absentOrEmpty(root:string):void{maintenanceLocation(root,true);if(fs.existsSync(root)&&fs.readdirSync(root).length)reject('SERVICE_UPGRADE_DESTINATION','A new empty, private destination is required; existing material will not be overwritten',409);}
function retainBytes(ref:string,bytes:Buffer|string):void{
  if(fs.existsSync(ref)){if(!readRegular(ref,8388608,true).equals(Buffer.from(bytes)))reject('SERVICE_UPGRADE_BACKUP_CHANGED','Retained evidence differs',409);return;}
  const fd=fs.openSync(ref,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDirectory(path.dirname(ref));
}
function makeBackup(snapshot:ServiceUpgradeSnapshot,backupRoot:string,id:string):{backupDigest:string;sourceSnapshotDigest:string}{
  absentOrEmpty(backupRoot);mkdir(backupRoot);const root=snapshot.sourceInstalledRoot,base=sourceBase(root);
  copyInventory(root,path.join(backupRoot,'service'),snapshot.installation,id);mkdir(path.join(backupRoot,'references'));
  for(const ref of snapshot.references)copyMaintenanceFile(ref.path,path.join(backupRoot,'references',valueDigest(ref.path).slice(7)),{kind:'file',...ref});
  retainBytes(path.join(backupRoot,'base.json'),base.base);retainBytes(path.join(backupRoot,'base-manifest.json'),base.manifest);retainBytes(path.join(backupRoot,'snapshot.json'),snapshotBytes(snapshot));
  const sourceSnapshotDigest=snapshotDigest(snapshot),backupDigest=valueDigest({baseBytesSha256:byteDigest(base.base),baseManifestDigest:byteDigest(base.manifest),sourceSnapshotDigest});
  verifyBackup(backupRoot,backupDigest,sourceSnapshotDigest);return{backupDigest,sourceSnapshotDigest};
}
function verifyBackup(backupRoot:string,expectedBackupDigest:string,expectedSnapshotDigest:string):ServiceUpgradeSnapshot{
  maintenanceLocation(backupRoot);hash(expectedBackupDigest);hash(expectedSnapshotDigest);
  const raw=readRegular(path.join(backupRoot,'snapshot.json'),8388608,true);if(byteDigest(raw)!==expectedSnapshotDigest)reject('SERVICE_UPGRADE_BACKUP_CHANGED','Original snapshot digest differs',409);
  const snapshot=record(JSON.parse(raw.toString())) as unknown as ServiceUpgradeSnapshot;
  exact(record(snapshot),['schema','workspaceId','serviceId','sourceInstalledRoot','sourceManifestDigest','sourceArchiveDigest','sourceBasePin','source','historicalRecords','installation','database','references','transientExclusions','authority']);
  if(snapshot.schema!=='runtime-service-upgrade-snapshot/v1'||snapshot.authority!==false||!equal(snapshot.transientExclusions,TRANSIENTS)||snapshot.source.serviceRoot!==snapshot.sourceInstalledRoot||snapshot.source.serviceId!==snapshot.serviceId||snapshot.source.workspaceId!==snapshot.workspaceId)reject('SERVICE_UPGRADE_BACKUP_CHANGED','Invalid original snapshot identity',409);
  const base=readRegular(path.join(backupRoot,'base.json'),131072,true),manifest=readRegular(path.join(backupRoot,'base-manifest.json'),131072,true);
  if(byteDigest(base)!==snapshot.sourceBasePin.digest||valueDigest({baseBytesSha256:byteDigest(base),baseManifestDigest:byteDigest(manifest),sourceSnapshotDigest:expectedSnapshotDigest})!==expectedBackupDigest||!equal(inspectMaintenanceTree(path.join(backupRoot,'service')),snapshot.installation))reject('SERVICE_UPGRADE_BACKUP_CHANGED','Original backup bytes differ',409);
  const refs=snapshot.references.map(r=>({path:valueDigest(r.path).slice(7),kind:'file' as const,bytes:r.bytes,sha256:r.sha256,mode:r.mode})).sort((a,b)=>a.path.localeCompare(b.path));
  if(!equal(inspectMaintenanceTree(path.join(backupRoot,'references')),refs))reject('SERVICE_UPGRADE_BACKUP_CHANGED','Original external-reference backup differs',409);
  return snapshot;
}
function validateUpgrade(input:ServiceUpgradePlan):RuntimeInstallPlan{
  exact(record(input),['schema','requestId','source','expectedSourceSnapshotDigest','backupRoot','destinationInstallPlanRef','destinationInstallPlanSha256']);
  if(input.schema!=='runtime-service-upgrade-plan/v1')reject('SERVICE_UPGRADE_PLAN','Invalid upgrade plan');requestId(input.requestId);hash(input.expectedSourceSnapshotDigest);hash(input.destinationInstallPlanSha256);
  canonicalPath(input.destinationInstallPlanRef);const raw=readRegular(input.destinationInstallPlanRef,131072,true);if(byteDigest(raw)!==input.destinationInstallPlanSha256)reject('SERVICE_UPGRADE_PLAN_CHANGED','Selected destination installation plan changed',409);
  const target=JSON.parse(raw.toString()) as RuntimeInstallPlan;independent(target);selection(input.source);
  const previous=readPrivateJson(path.join(input.source.serviceRoot,'installation-plan.json')) as RuntimeInstallPlan;independent(previous);
  const current=readPrivateJson(path.join(input.source.serviceRoot,'service-specification.json')) as UserServiceSpecification;
  for(const key of ['schema','workspaceId','projectId','principalId','role','credentialExpiresAt','nodeExecutable','nodeSha256','codex'] as const)if(!equal(previous[key],target[key]))reject('SERVICE_UPGRADE_AUTHORITY','Upgrade must preserve the exact existing service identity, credentials and configuration authority',409);
  // A native configuration transition may have superseded the original plan's
  // integration reference. Preserve the selected current specification instead
  // of silently resetting it to its original installation value.
  if(target.integrationsRef!==current.integrationsRef)reject('SERVICE_UPGRADE_AUTHORITY','Upgrade must preserve the selected current integration configuration',409);
  separateRoots([input.source.serviceRoot,target.root,input.backupRoot]);maintenanceLocation(target.root,true);maintenanceLocation(input.backupRoot,true);
  if(target.distribution.manifestDigest===previous.distribution.manifestDigest)reject('SERVICE_UPGRADE_CANDIDATE','Select a distinct exact destination package',409);return target;
}
function receipt(ref:string,expected?:string):ServiceUpgradeReceipt{
  const raw=readRegular(ref,131072,true);if(expected&&byteDigest(raw)!==hash(expected))reject('SERVICE_UPGRADE_RECEIPT_CHANGED','Selected upgrade receipt bytes changed',409);
  const v=record(JSON.parse(raw.toString()));exact(v,['schema','requestId','planDigest','backupRoot','backupDigest','sourceSnapshotDigest','sourceInstalledRoot','destinationRoot','destinationSelectionDigest','workspaceId','serviceId','sourceBasePin','destinationBasePin','status','serviceStarted','hostRegistered','businessWorkDispatched','authority','receiptDigest']);
  const {receiptDigest,...body}=v;
  if(v.schema!=='runtime-service-upgrade-receipt/v1'||v.status!=='STAGED'||v.serviceStarted!==false||v.hostRegistered!==false||v.businessWorkDispatched!==false||v.authority!==false||valueDigest(body)!==receiptDigest)reject('SERVICE_UPGRADE_RECEIPT_CHANGED','Invalid original upgrade receipt',409);return v as unknown as ServiceUpgradeReceipt;
}
/** One explicit, exact plan. Partial output is retained and rejected on a new
 * attempt; only a completed identical request can replay its original receipt. */
export async function migrateStoppedService(value:ServiceUpgradePlan):Promise<ServiceUpgradeReceipt>{
  const input=structuredClone(value),target=validateUpgrade(input),planDigest=valueDigest(input),receiptRef=path.join(input.backupRoot,'upgrade-receipt.json');
  if(fs.existsSync(receiptRef)){const previous=receipt(receiptRef);if(previous.planDigest!==planDigest)reject('SERVICE_UPGRADE_REQUEST_CONFLICT','A different request already owns this backup',409);verifyBackup(previous.backupRoot,previous.backupDigest,previous.sourceSnapshotDigest);return previous;}
  absentOrEmpty(target.root);absentOrEmpty(input.backupRoot);
  const lease=await stoppedLease(input.source);let failure:unknown;try{
    if(fs.existsSync(path.join(input.source.serviceRoot,'data/service-upgrade.json')))reject('SERVICE_UPGRADE_CHAIN','This bounded upgrade accepts an original independent installation; chained upgrades require a separately supported migration',409);
    const snapshot=capture(lease.current);if(snapshotDigest(snapshot)!==input.expectedSourceSnapshotDigest)reject('SERVICE_UPGRADE_SOURCE_CHANGED','Reviewed source snapshot changed',409);
    const backup=makeBackup(snapshot,input.backupRoot,input.requestId);
    if(snapshotDigest(capture(lease.current))!==backup.sourceSnapshotDigest)reject('SERVICE_UPGRADE_SOURCE_CHANGED','Original source changed while making its backup',409);
    mkdir(target.root);retainBytes(path.join(target.root,'installation-plan.json'),canonical(target)+'\n');
    const data=snapshot.installation.filter(e=>e.path.startsWith('data/')).map(e=>({...e,path:e.path.slice(5)}));
    copyInventory(path.join(input.backupRoot,'service/data'),path.join(target.root,'data'),data,input.requestId);
    const client=snapshot.installation.find(e=>e.path==='client.json');if(!client||client.kind!=='file')reject('SERVICE_UPGRADE_CREDENTIAL','Original retained client credential is missing',409);
    copyMaintenanceFile(path.join(input.backupRoot,'service/client.json'),path.join(target.root,'client.json'),client);
    const context:ServiceUpgradeContext=validateServiceUpgradeContext({schema:'runtime-service-upgrade-context/v1',workspaceId:snapshot.workspaceId,serviceId:snapshot.serviceId,sourceInstalledRoot:snapshot.sourceInstalledRoot,sourceManifestDigest:snapshot.sourceManifestDigest,sourceArchiveDigest:snapshot.sourceArchiveDigest,sourceBasePin:snapshot.sourceBasePin,baseBytesSha256:snapshot.sourceBasePin.digest,...backup,backupRoot:input.backupRoot,historicalRecords:snapshot.historicalRecords});
    retainBytes(path.join(target.root,'data/service-upgrade.json'),canonicalEvidence(context)+'\n');
    await runInstaller(target,'stage');privateFile(path.join(target.root,'data/writer-lock.sqlite'),true);const spec=verifyInstalledRuntimePackage(target),destinationBase=sourceBase(target.root);
    if(!equal(destinationBase.pin,loadPublisherBase().pin)||equal(destinationBase.pin,snapshot.sourceBasePin))reject('SERVICE_UPGRADE_BASE','Destination must use this Runtime publisher current Base, distinct from the source',409);
    if((await inspectUserService(spec)).registered)reject('SERVICE_UPGRADE_NOT_STOPPED','Destination must remain stopped during upgrade',409);
    prepareStagedHostMaterial(target,snapshot.serviceId);const installed=selection(inspectInstalledServiceSelection(target.root));
    const copied=copiedLedger(target.root,installed);if(!equal(copied.database,snapshot.database)||!equal(copied.historicalRecords,snapshot.historicalRecords)||hashMaintenanceFile(path.join(target.root,'data/service.sqlite')).sha256!==snapshot.installation.find(e=>e.path==='data/service.sqlite')?.sha256)reject('SERVICE_UPGRADE_PRESERVATION','Copied business history differs from its exact original',409);
    if(!loadServiceUpgradeContext(path.join(target.root,'data'),snapshot.workspaceId,snapshot.serviceId))reject('SERVICE_UPGRADE_PRESERVATION','Historical context could not be verified',409);
    if(snapshotDigest(capture(lease.current))!==backup.sourceSnapshotDigest)reject('SERVICE_UPGRADE_SOURCE_CHANGED','Original source changed before completion',409);
    const body={schema:'runtime-service-upgrade-receipt/v1' as const,requestId:input.requestId,planDigest,backupRoot:input.backupRoot,...backup,sourceInstalledRoot:input.source.serviceRoot,destinationRoot:target.root,destinationSelectionDigest:installed.selectionDigest,workspaceId:snapshot.workspaceId,serviceId:snapshot.serviceId,sourceBasePin:snapshot.sourceBasePin,destinationBasePin:destinationBase.pin,status:'STAGED' as const,serviceStarted:false as const,hostRegistered:false as const,businessWorkDispatched:false as const,authority:false as const};
    const result={...body,receiptDigest:valueDigest(body)};save(receiptRef,result,false);return result;
  }catch(error){failure=error;throw error;}finally{closeLeases([lease],failure);}
}
/** Preserve all B evidence first. Recovery never overwrites B or an occupied A,
 * changes permissions, dispatches pending work or starts either installation. */
export async function rollbackStoppedService(value:ServiceRollbackPlan):Promise<Record<string,unknown>>{
  const input=structuredClone(value);exact(record(input),['schema','requestId','upgradeReceiptRef','upgradeReceiptSha256','destination','expectedDestinationSnapshotDigest','preservationRoot']);
  if(input.schema!=='runtime-service-rollback-plan/v1')reject('SERVICE_UPGRADE_PLAN','Invalid rollback plan');requestId(input.requestId);hash(input.expectedDestinationSnapshotDigest);hash(input.upgradeReceiptSha256);
  const original=receipt(input.upgradeReceiptRef,input.upgradeReceiptSha256),source=verifyBackup(original.backupRoot,original.backupDigest,original.sourceSnapshotDigest);
  if(input.upgradeReceiptRef!==path.join(original.backupRoot,'upgrade-receipt.json')||input.destination.serviceRoot!==original.destinationRoot||input.destination.workspaceId!==original.workspaceId||input.destination.serviceId!==original.serviceId||input.destination.selectionDigest!==original.destinationSelectionDigest)reject('SERVICE_UPGRADE_RECEIPT_CHANGED','Rollback selects another service or original upgrade',409);
  separateRoots([source.sourceInstalledRoot,original.destinationRoot,original.backupRoot,input.preservationRoot]);maintenanceLocation(input.preservationRoot,true);
  const planDigest=valueDigest(input),resultRef=path.join(input.preservationRoot,'rollback-receipt.json');
  if(fs.existsSync(resultRef)){const v=record(json(resultRef)),{receiptDigest,...body}=v;if(v.planDigest!==planDigest||valueDigest(body)!==receiptDigest||v.status!=='ORIGINAL_READY')reject('SERVICE_UPGRADE_REQUEST_CONFLICT','A different rollback owns this preservation directory',409);verifyBackup(input.preservationRoot,string(v.backupDigest),string(v.sourceSnapshotDigest));return v;}
  absentOrEmpty(input.preservationRoot);const lease=await stoppedLease(input.destination);let restoredLease:{close():void}|undefined,failure:unknown;
  try{
    const destination=capture(lease.current);if(snapshotDigest(destination)!==input.expectedDestinationSnapshotDigest)reject('SERVICE_UPGRADE_SOURCE_CHANGED','Destination history changed before rollback',409);
    const preserved=makeBackup(destination,input.preservationRoot,input.requestId);
    if(snapshotDigest(capture(lease.current))!==preserved.sourceSnapshotDigest)reject('SERVICE_UPGRADE_SOURCE_CHANGED','Destination changed while preserving its evidence',409);
    const root=source.sourceInstalledRoot;maintenanceLocation(root,true);
    if(fs.existsSync(root)&&fs.readdirSync(root).length){
      restoredLease=await stoppedLease(source.source);if(!equal(inventory(root),source.installation))reject('SERVICE_UPGRADE_RESTORE_CONFLICT','Original installation has newer or different evidence; it will not be overwritten',409);
    }else{
      mkdir(root);mkdir(path.join(root,'data'));let installer:DatabaseSync|undefined,writer:DatabaseSync|undefined;
      try{installer=lock(path.join(root,'installer-lock.sqlite'),'INSTALLER_ACTIVE',true);writer=lock(path.join(root,'data/writer-lock.sqlite'),'WRITER_ACTIVE',true);restoredLease={close(){releaseLocks([writer,installer]);}};}
      catch(error){releaseLocks([writer,installer],error);throw error;}
      copyInventory(path.join(original.backupRoot,'service'),root,source.installation,input.requestId,TRANSIENTS);
    }
    selection(source.source);for(const r of source.references)if(!equal(hashMaintenanceFile(r.path),{bytes:r.bytes,sha256:r.sha256,mode:r.mode}))reject('SERVICE_UPGRADE_REFERENCE_CHANGED','An original external dependency changed; it will not be overwritten',409);
    if(snapshotDigest(capture(source.source))!==original.sourceSnapshotDigest)reject('SERVICE_UPGRADE_RESTORE_CONFLICT','Restored original differs from its original snapshot',409);
    const body={schema:'runtime-service-rollback-receipt/v1',requestId:input.requestId,planDigest,upgradeReceiptDigest:original.receiptDigest,originalRoot:root,preservationRoot:input.preservationRoot,...preserved,destinationRetained:true,serviceStarted:false,hostRegistered:false,businessWorkDispatched:false,authority:false,status:'ORIGINAL_READY'};
    const result={...body,receiptDigest:valueDigest(body)};save(resultRef,result,false);return result;
  }catch(error){failure=error;throw error;}finally{closeLeases([restoredLease,lease],failure);}
}
export async function serviceUpgradeCommand(argv:string[]):Promise<unknown>{
  const [operation,flag,ref,...extra]=argv;
  if(extra.length||!ref||!['inspect','migrate','rollback'].includes(operation)||flag!==(operation==='inspect'?'--selection-ref':'--plan-ref'))reject('SERVICE_UPGRADE_ARGUMENT','Use inspect --selection-ref or migrate|rollback --plan-ref with a protected exact selection');
  canonicalPath(ref);const value=json(ref);
  if(operation==='inspect')return inspectServiceUpgradeSource(value as InstalledServiceSelection);
  return operation==='migrate'?migrateStoppedService(value as ServiceUpgradePlan):rollbackStoppedService(value as ServiceRollbackPlan);
}
