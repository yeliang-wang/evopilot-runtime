import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual as equal } from 'node:util';
import { canonical, canonicalEvidence, exact, record, reject, slug, string } from '../server/errors.js';
import { hostHeaders, privateFile, readHostConnection } from '../server/security.js';
import { byteDigest, loadPublisherBase, valueDigest, type BasePin, type FieldRule, type PublisherBase } from './base.js';
import type { Compilation, Issue } from './compiler.js';

export interface HistoricalRecord { projectId:string; kind:'definition-revision'|'lifecycle-instance'; id:string; valueDigest:string; }
/** Private migration evidence, never an HTTP input or a selectable Base registry. */
export interface ServiceUpgradeContext {
  schema:'runtime-service-upgrade-context/v1'; workspaceId:string; serviceId:string;
  sourceInstalledRoot:string; sourceManifestDigest:string; sourceArchiveDigest:string;
  sourceBasePin:BasePin; baseBytesSha256:string; sourceSnapshotDigest:string;
  backupRoot:string; backupDigest:string; historicalRecords:HistoricalRecord[];
}
export interface VerifiedServiceUpgrade { readonly context:ServiceUpgradeContext; readonly base:PublisherBase; }
export interface BaseTransition {
  from:BasePin; to:BasePin; sourceRevisionId:string; addedRequiredFields:string[]; removedSlots:string[];
  tightenedConstraints:{path:string;before:unknown;after:unknown}[]; schemaChanged:boolean;
  retainedExtensionIds:string[]; issues:Issue[]; previewDigest:string; sourceRewritten:false;
}
const verified=new WeakSet<object>();
const hash=(v:unknown):string=>{const s=string(v);if(!/^sha256:[a-f0-9]{64}$/.test(s))reject('INVALID_SERVICE_UPGRADE','Migration evidence needs exact digests',409);return s;};
function path(v:unknown):string{const s=string(v,4096);if(!isAbsolute(s)||resolve(s)!==s||s==='/')reject('INVALID_SERVICE_UPGRADE','Migration paths must be canonical absolute paths',409);return s;}
function pin(v:unknown):BasePin{const p=record(v);exact(p,['id','version','digest','schemaVersion']);return{id:slug(p.id),version:string(p.version,128),digest:hash(p.digest),schemaVersion:string(p.schemaVersion,128)};}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const item of Object.values(v))freeze(item);Object.freeze(v);}return v;}
export function validateServiceUpgradeContext(value:unknown):ServiceUpgradeContext{
  const v=record(value);exact(v,['schema','workspaceId','serviceId','sourceInstalledRoot','sourceManifestDigest','sourceArchiveDigest','sourceBasePin','baseBytesSha256','sourceSnapshotDigest','backupRoot','backupDigest','historicalRecords']);
  if(v.schema!=='runtime-service-upgrade-context/v1'||!Array.isArray(v.historicalRecords)||v.historicalRecords.length>16384)reject('INVALID_SERVICE_UPGRADE','Invalid migration context profile',409);
  const seen=new Set<string>();
  const historicalRecords=v.historicalRecords.map(item=>{const r=record(item);exact(r,['projectId','kind','id','valueDigest']);if(!['definition-revision','lifecycle-instance'].includes(String(r.kind)))reject('INVALID_SERVICE_UPGRADE','Unexpected historical record kind',409);const row={projectId:slug(r.projectId),kind:r.kind as HistoricalRecord['kind'],id:string(r.id,128),valueDigest:hash(r.valueDigest)},key=canonical([row.projectId,row.kind,row.id]);if(seen.has(key))reject('INVALID_SERVICE_UPGRADE','Duplicate historical record',409);seen.add(key);return row;});
  return freeze({schema:'runtime-service-upgrade-context/v1',workspaceId:slug(v.workspaceId),serviceId:string(v.serviceId,128),sourceInstalledRoot:path(v.sourceInstalledRoot),sourceManifestDigest:hash(v.sourceManifestDigest),sourceArchiveDigest:hash(v.sourceArchiveDigest),sourceBasePin:pin(v.sourceBasePin),baseBytesSha256:hash(v.baseBytesSha256),sourceSnapshotDigest:hash(v.sourceSnapshotDigest),backupRoot:path(v.backupRoot),backupDigest:hash(v.backupDigest),historicalRecords});
}
function bytes(file:string,max:number):Buffer{
  if(realpathSync(file)!==file)reject('INVALID_SERVICE_UPGRADE','Migration evidence cannot follow symlinks',409);
  privateFile(file);const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size>max||stat.nlink!==1||(stat.mode&0o777)!==0o600)reject('INVALID_SERVICE_UPGRADE','Invalid protected migration evidence',409);return readFileSync(fd);}finally{closeSync(fd);}
}
export function loadServiceUpgradeContext(stateRoot:string,workspaceId:string,serviceId:string):VerifiedServiceUpgrade|null{
  const file=join(stateRoot,'service-upgrade.json');if(!existsSync(file))return null;
  const context=validateServiceUpgradeContext(JSON.parse(bytes(file,8388608).toString('utf8')));
  if(context.workspaceId!==workspaceId||context.serviceId!==serviceId)reject('INVALID_SERVICE_UPGRADE','Migration context belongs to another service',409);
  const stat=lstatSync(context.backupRoot);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700||stat.uid!==process.getuid?.()||realpathSync(context.backupRoot)!==context.backupRoot)reject('INVALID_SERVICE_UPGRADE','Migration backup must be a private original directory',409);
  const baseBytes=bytes(join(context.backupRoot,'base.json'),131072),manifestBytes=bytes(join(context.backupRoot,'base-manifest.json'),131072),snapshotBytes=bytes(join(context.backupRoot,'snapshot.json'),8388608);
  if(byteDigest(baseBytes)!==context.baseBytesSha256||context.sourceBasePin.digest!==context.baseBytesSha256||byteDigest(snapshotBytes)!==context.sourceSnapshotDigest||valueDigest({baseBytesSha256:context.baseBytesSha256,baseManifestDigest:byteDigest(manifestBytes),sourceSnapshotDigest:context.sourceSnapshotDigest})!==context.backupDigest)reject('INVALID_SERVICE_UPGRADE','Sealed migration bytes changed',409);
  const snapshot=record(JSON.parse(snapshotBytes.toString('utf8')));
  for(const key of ['workspaceId','serviceId','sourceInstalledRoot','sourceManifestDigest','sourceArchiveDigest','sourceBasePin','historicalRecords'] as const)if(canonicalEvidence(snapshot[key])!==canonicalEvidence(context[key]))reject('INVALID_SERVICE_UPGRADE','Migration context differs from the sealed source snapshot',409);
  const manifest=record(JSON.parse(manifestBytes.toString('utf8'))),base=record(JSON.parse(baseBytes.toString('utf8')));
  if(manifest.schema!=='runtime-base-distribution/v1'||manifest.publisher!=='evopilot-runtime'||!Array.isArray(manifest.bases)||manifest.bases.length!==1)reject('INVALID_SERVICE_UPGRADE','Source package must contain its one publisher Base',409);
  const entry=record(manifest.bases[0]);exact(entry,['id','version','digest','schemaVersion','file']);const {file:unused,...sourcePin}=entry;
  if(canonical(sourcePin)!==canonical(context.sourceBasePin)||base.id!==sourcePin.id||base.version!==sourcePin.version||base.schema!==sourcePin.schemaVersion||base.publisher!=='evopilot-runtime'||!Array.isArray(base.fields)||!Array.isArray(base.stages)||!Array.isArray(base.actions)||!Array.isArray(base.extensionRequiredFields)||!base.slots||typeof base.slots!=='object')reject('INVALID_SERVICE_UPGRADE','Source Base does not match its verified package pin',409);
  const result=freeze({context,base:base as unknown as PublisherBase});verified.add(result);return result;
}
interface SealedTreeEntry {path:string;kind:'file'|'directory'|'symlink';bytes:number;sha256:string;mode?:number;target?:string;}
const sourceLockPaths=['installer-lock.sqlite','data/writer-lock.sqlite'];
const sourceTransients=sourceLockPaths.flatMap(name=>[name,...['-journal','-wal','-shm'].map(s=>name+s)]);
const sourceHashBuffer=Buffer.allocUnsafe(4*1024**2);
function existingPath(value:string):void{path(value);if(realpathSync(value)!==value)reject('INVALID_SERVICE_UPGRADE','Source evidence paths cannot traverse links',409);}
function sameFile(a:Stats,b:Stats):boolean{return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;}
function filePin(file:string,systemExecutable=false):{bytes:number;sha256:string;mode:number}{
  existingPath(file);const before=lstatSync(file);
  if(!before.isFile()||before.nlink!==1||(!systemExecutable||before.uid!==0)&&before.uid!==process.getuid?.()||(before.mode&0o022)!==0||before.size>(systemExecutable?268435456:2*1024**3))reject('INVALID_SERVICE_UPGRADE','Unsafe or oversized sealed source file',409);
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW),buffer=sourceHashBuffer,digest=createHash('sha256');let size=0;
  try{
    if(!sameFile(before,fstatSync(fd)))reject('SERVICE_UPGRADE_SOURCE_CHANGED','Source file changed during inspection',409);
    let count;while((count=readSync(fd,buffer,0,buffer.length,null))>0){size+=count;if(size>2*1024**3)reject('INVALID_SERVICE_UPGRADE','Sealed source file exceeds its bounded profile',409);digest.update(buffer.subarray(0,count));}
    if(size!==before.size||!sameFile(before,fstatSync(fd))||!sameFile(before,lstatSync(file)))reject('SERVICE_UPGRADE_SOURCE_CHANGED','Source file changed during inspection',409);
  }finally{closeSync(fd);}
  return{bytes:size,sha256:digest.digest('hex'),mode:before.mode&0o777};
}
/** Read-only mirror of the sealed native migration inventory. No copy, restore,
 * installer, credential creation or business SQLite opening is reachable here. */
function sealedTree(root:string):SealedTreeEntry[]{
  existingPath(root);const top=lstatSync(root);if(!top.isDirectory()||top.uid!==process.getuid?.()||(top.mode&0o777)!==0o700)reject('INVALID_SERVICE_UPGRADE','Sealed source root must be private',409);
  const entries:SealedTreeEntry[]=[];let total=0;
  function walk(directory:string,depth:number):void{
    if(depth>64)reject('INVALID_SERVICE_UPGRADE','Source inventory depth exceeds its bound',409);
    for(const name of readdirSync(directory).sort()){
      if(!name||name==='.'||name==='..'||name.includes('\\')||entries.length>=128000)reject('INVALID_SERVICE_UPGRADE','Source inventory exceeds its bounded profile',409);
      const file=join(directory,name),key=relative(root,file),stat=lstatSync(file);if(stat.uid!==process.getuid?.())reject('INVALID_SERVICE_UPGRADE','Source ownership changed',409);
      if(stat.isSymbolicLink()){
        const target=readlinkSync(file),lexical=resolve(dirname(file),target),actual=realpathSync(file);
        if(!target||isAbsolute(target)||target.includes('\\')||(lexical!==root&&!lexical.startsWith(root+sep))||(actual!==root&&!actual.startsWith(root+sep)))reject('INVALID_SERVICE_UPGRADE','Source link escapes its original root',409);
        total+=Buffer.byteLength(target);entries.push({path:key,kind:'symlink',bytes:Buffer.byteLength(target),sha256:byteDigest(target).slice(7),target});
      }else{
        existingPath(file);if(stat.mode&0o022)reject('INVALID_SERVICE_UPGRADE','Source permissions changed',409);
        if(stat.isDirectory()){entries.push({path:key,kind:'directory',bytes:0,sha256:'',mode:stat.mode&0o777});walk(file,depth+1);}
        else{const pin=filePin(file);total+=pin.bytes;entries.push({path:key,kind:'file',...pin});}
      }
      if(total>8*1024**3)reject('INVALID_SERVICE_UPGRADE','Source inventory bytes exceed the bound',409);
    }
  }
  walk(root,0);return entries.sort((a,b)=>a.path.localeCompare(b.path));
}
function separateEvidenceRoots(roots:string[]):void{
  for(const root of roots)existingPath(root);
  if(roots.some((a,i)=>roots.some((b,j)=>i!==j&&(a===b||a.startsWith(b+sep)))))reject('INVALID_SERVICE_UPGRADE','Current service, original source and backup must be separate',409);
}
function sourceSelection(snapshot:Record<string,unknown>,context:ServiceUpgradeContext):void{
  const source=record(snapshot.source);exact(source,['schema','serviceRoot','serviceId','workspaceId','installationPlanDigest','distributionManifestDigest','specificationDigest','connectionDigest','configurationPins','binding','authority','selectionDigest']);
  const {selectionDigest,...identity}=source;
  if(source.schema!=='runtime-installed-service-selection/v1'||source.authority!==false||source.binding!==null||valueDigest(identity).slice(7)!==selectionDigest||source.serviceRoot!==context.sourceInstalledRoot||source.serviceId!==context.serviceId||source.workspaceId!==context.workspaceId)reject('SERVICE_UPGRADE_SOURCE_CHANGED','Original service selection differs from the sealed source',409);
  const root=context.sourceInstalledRoot,pins=record(source.configurationPins);
  const installedPlan=bytes(join(root,'installation-plan.json'),131072),spec=bytes(join(root,'service-specification.json'),131072),connection=bytes(join(root,'connection.json'),131072),manifest=bytes(join(root,'distribution-manifest.json'),8388608);
  if(valueDigest(JSON.parse(installedPlan.toString())).slice(7)!==source.installationPlanDigest||valueDigest(JSON.parse(spec.toString())).slice(7)!==source.specificationDigest||valueDigest(JSON.parse(connection.toString())).slice(7)!==source.connectionDigest||byteDigest(manifest)!==context.sourceManifestDigest||byteDigest(manifest).slice(7)!==source.distributionManifestDigest)reject('SERVICE_UPGRADE_SOURCE_CHANGED','Original installation identity bytes changed',409);
  const distribution=record(record(JSON.parse(installedPlan.toString())).distribution);
  if('sha256:'+distribution.manifestDigest!==context.sourceManifestDigest||'sha256:'+distribution.archiveDigest!==context.sourceArchiveDigest||record(JSON.parse(manifest.toString())).archiveDigest!==distribution.archiveDigest)reject('SERVICE_UPGRADE_SOURCE_CHANGED','Original package archive identity differs',409);
  const required=[join(root,'installation-plan.json'),join(root,'service-specification.json'),join(root,'connection.json'),join(root,'client.json'),join(root,'data/auth.json'),join(root,'distribution-manifest.json')];
  if(required.some(file=>!Object.hasOwn(pins,file))||Object.keys(pins).length>16384)reject('SERVICE_UPGRADE_SOURCE_CHANGED','Original protected configuration inventory is incomplete',409);
  for(const [file,expected]of Object.entries(pins))if(filePin(file).sha256!==expected)reject('SERVICE_UPGRADE_SOURCE_CHANGED','Original protected configuration changed',409);
  const service=record(JSON.parse(spec.toString())),node=filePin(string(service.nodeExecutable,4096),true);
  if(node.sha256!==service.nodeSha256||!(node.mode&0o111))reject('SERVICE_EXECUTABLE_CHANGED','The original pinned Node executable changed',409);
  const host=readHostConnection(join(root,'connection.json'));
  if(host.workspaceId!==context.workspaceId||host.serviceId!==context.serviceId||host.projectId!==service.projectId||host.principalId!==service.principalId||host.version!==service.version||host.tokenRef!==join(root,'client.json'))reject('SERVICE_UPGRADE_SOURCE_CHANGED','Original connection scope changed',409);
  hostHeaders(host); // Validates the retained scoped credential without exposing it.
}
async function requireSourceStopped(context:ServiceUpgradeContext):Promise<void>{
  if(process.platform!=='darwin')reject('SERVICE_PLATFORM','This source lease requires the original macOS user service',409);
  const label='io.evopilot.runtime.'+slug(context.workspaceId)+'.'+byteDigest(context.sourceInstalledRoot).slice(7,23);
  // Fixed inspection only. No program, operation or arguments come from an HTTP
  // request; the native migration pins the one original service identity.
  const observed=await new Promise<{code:number;stderr:string}>((resolve,rejectPromise)=>execFile('/bin/launchctl',['print','gui/'+process.getuid!()+'/'+label],{encoding:'utf8',timeout:10000,maxBuffer:262144,shell:false},(error,_stdout,stderr)=>{
    if(error&&(error.killed||typeof error.code!=='number')){rejectPromise(Object.assign(new Error('Original service inspection is uncertain'),{code:'SERVICE_INSPECTION_FAILED'}));return;}
    resolve({code:error?Number(error.code):0,stderr});
  }));
  if(observed.code===0)reject('SERVICE_UPGRADE_NOT_STOPPED','The original owned service is still registered',409);
  if(!/Could not find service/.test(observed.stderr)||!observed.stderr.includes('"'+label+'"'))reject('SERVICE_INSPECTION_FAILED','Could not prove the original service is unregistered',503);
}
/** Startup-only source lease. This is passive evidence verification plus two
 * pre-existing coordination locks; native migration/rollback remain operator-only. */
export async function acquireUpgradeSourceLease(stateRoot:string):Promise<{close():void}|null>{
  const ref=join(stateRoot,'service-upgrade.json');if(!existsSync(ref))return null;
  const context=validateServiceUpgradeContext(JSON.parse(bytes(ref,8388608).toString('utf8')));
  separateEvidenceRoots([dirname(stateRoot),context.sourceInstalledRoot,context.backupRoot]);
  const snapshotBytes=bytes(join(context.backupRoot,'snapshot.json'),8388608),baseBytes=bytes(join(context.backupRoot,'base.json'),131072),manifestBytes=bytes(join(context.backupRoot,'base-manifest.json'),131072);
  if(byteDigest(snapshotBytes)!==context.sourceSnapshotDigest||byteDigest(baseBytes)!==context.baseBytesSha256||valueDigest({baseBytesSha256:byteDigest(baseBytes),baseManifestDigest:byteDigest(manifestBytes),sourceSnapshotDigest:byteDigest(snapshotBytes)})!==context.backupDigest)reject('SERVICE_UPGRADE_BACKUP_CHANGED','Sealed migration bytes changed',409);
  const snapshot=record(JSON.parse(snapshotBytes.toString()));
  for(const key of ['workspaceId','serviceId','sourceInstalledRoot','sourceManifestDigest','sourceArchiveDigest','sourceBasePin','historicalRecords'] as const)if(canonicalEvidence(snapshot[key])!==canonicalEvidence(context[key]))reject('SERVICE_UPGRADE_SOURCE_CHANGED','Historical context differs from its original source',409);
  if(!loadServiceUpgradeContext(stateRoot,context.workspaceId,context.serviceId))reject('INVALID_SERVICE_UPGRADE','Sealed historical context is missing',409);
  exact(snapshot,['schema','workspaceId','serviceId','sourceInstalledRoot','sourceManifestDigest','sourceArchiveDigest','sourceBasePin','source','historicalRecords','installation','database','references','transientExclusions','authority']);
  if(snapshot.schema!=='runtime-service-upgrade-snapshot/v1'||snapshot.authority!==false||!equal(snapshot.transientExclusions,sourceTransients)||!Array.isArray(snapshot.installation)||!Array.isArray(snapshot.references))reject('INVALID_SERVICE_UPGRADE','Invalid sealed source inventory',409);
  if(!equal(sealedTree(join(context.backupRoot,'service')),snapshot.installation))reject('SERVICE_UPGRADE_BACKUP_CHANGED','Sealed original installation bytes changed',409);
  const references=snapshot.references.map(value=>{const r=record(value);exact(r,['path','bytes','sha256','mode']);return{path:valueDigest(r.path).slice(7),kind:'file',bytes:r.bytes,sha256:r.sha256,mode:r.mode};}).sort((a,b)=>a.path.localeCompare(b.path));
  if(!equal(sealedTree(join(context.backupRoot,'references')),references))reject('SERVICE_UPGRADE_BACKUP_CHANGED','Sealed original reference bytes changed',409);
  const handles:DatabaseSync[]=[];
  const close=(original?:unknown)=>{const errors:unknown[]=original===undefined?[]:[original];for(const handle of handles.splice(0).reverse())try{handle.close();}catch(error){errors.push(error);}if(errors.length===1)throw errors[0];if(errors.length>1)throw new AggregateError(errors,'Source lease cleanup failed',{cause:errors[0]});};
  function lockSource(name:string,code:string):void{
    const file=join(context.sourceInstalledRoot,name);existingPath(file);privateFile(file);const db=new DatabaseSync(file,{allowExtension:false});handles.push(db);
    try{db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}catch{reject(code,'Another writer owns the selected original service',409);}
  }
  try{
    sourceSelection(snapshot,context);lockSource('installer-lock.sqlite','INSTALLER_ACTIVE');await requireSourceStopped(context);lockSource('data/writer-lock.sqlite','WRITER_ACTIVE');
    for(const suffix of ['-wal','-shm','-journal'])if(existsSync(join(context.sourceInstalledRoot,'data/service.sqlite')+suffix))reject('SERVICE_UPGRADE_NOT_QUIESCENT','Original business database sidecars remain',409);
    sourceSelection(snapshot,context);
    if(!equal(sealedTree(context.sourceInstalledRoot).filter(e=>!sourceTransients.includes(e.path)),snapshot.installation))reject('SERVICE_UPGRADE_SOURCE_CHANGED','Original installation changed after migration',409);
    return{close:()=>close()};
  }catch(error){close(error);throw error;}
}
function requireVerified(context:VerifiedServiceUpgrade):void{if(!verified.has(context))reject('INVALID_SERVICE_UPGRADE','Only the native verified migration context permits historical readback',409);}
export function verifyHistoricalRecord(context:VerifiedServiceUpgrade,projectId:string,kind:HistoricalRecord['kind'],id:string,value:unknown):boolean{
  requireVerified(context);const row=context.context.historicalRecords.find(r=>r.projectId===projectId&&r.kind===kind&&r.id===id);
  if(!row)return false;if(valueDigest(value)!==row.valueDigest)reject('CORRUPT_HISTORICAL_RECORD','An original migration record changed',503);return true;
}
/** Internal compiler access is limited to an exact, sealed original source. */
export function historicalBaseForRevision(context:VerifiedServiceUpgrade,projectId:string,id:string,value:unknown):Readonly<{pin:BasePin;base:PublisherBase}>{
  if(!verifyHistoricalRecord(context,projectId,'definition-revision',id,value))reject('HISTORICAL_RECORD_REQUIRED','Historical Base is restricted to the sealed original revision',409);
  return{pin:context.context.sourceBasePin,base:context.base};
}
function tightened(before:FieldRule,after:FieldRule):boolean{
  const a=before.rules,b=after.rules;
  return before.type!==after.type||before.policy!==after.policy||(!before.required&&after.required)||
    (b.minimum!==undefined&&Number(b.minimum)>Number(a.minimum??-Infinity))||(b.maximum!==undefined&&Number(b.maximum)<Number(a.maximum??Infinity))||
    (b.minItems!==undefined&&Number(b.minItems)>Number(a.minItems??0))||(b.fixed!==undefined&&b.fixed!==a.fixed)||
    (Array.isArray(b.values)&&(!Array.isArray(a.values)||a.values.some(v=>!(b.values as unknown[]).includes(v))))||
    (Array.isArray(b.contains)&&b.contains.some(v=>!Array.isArray(a.contains)||!a.contains.includes(v)));
}
export function baseTransition(context:VerifiedServiceUpgrade,projectId:string,id:string,revision:unknown,compilation:Compilation):BaseTransition|null{
  const from=historicalBaseForRevision(context,projectId,id,revision),to=loadPublisherBase();if(canonical(from.pin)===canonical(to.pin))return null;
  const oldFields=new Map(from.base.fields.map(f=>[f.path,f]));
  const original=record(revision),semantic=(record(original.compilation).effective as {semantic?:Record<string,unknown>}|null)?.semantic;
  const extensions=Array.isArray(semantic?.extensions)?semantic.extensions:[];
  const preview={from:from.pin,to:to.pin,sourceRevisionId:id,addedRequiredFields:to.base.fields.filter(f=>f.required&&!oldFields.get(f.path)?.required).map(f=>f.path).sort(),removedSlots:Object.keys(from.base.slots).filter(s=>!Object.hasOwn(to.base.slots,s)).sort(),tightenedConstraints:to.base.fields.flatMap(f=>{const before=oldFields.get(f.path);return before&&tightened(before,f)?[{path:f.path,before:{type:before.type,policy:before.policy,required:before.required,rules:before.rules},after:{type:f.type,policy:f.policy,required:f.required,rules:f.rules}}]:[];}),schemaChanged:from.pin.schemaVersion!==to.pin.schemaVersion||oldFields.get('schema')?.rules.fixed!==to.base.fields.find(f=>f.path==='schema')?.rules.fixed,retainedExtensionIds:extensions.map(e=>String(record(e).id)).sort(),issues:compilation.issues,sourceRewritten:false as const};
  return{...preview,previewDigest:valueDigest({...preview,sourceDigest:compilation.sourceDigest})};
}
