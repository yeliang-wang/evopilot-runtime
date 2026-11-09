import { crc32, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fromBufferPromise, type ZipFile } from 'yauzl';
import { canonical, exact, record, reject, ServiceError, string } from '../server/errors.js';
import { byteDigest, valueDigest } from '../lifecycle/base.js';
import { candidateDigest, type CandidateManifest } from '../lifecycle/instance.js';
import { containsInlineSecret } from '../lifecycle/compiler.js';
import type { PlatformArtifactArchive, PlatformRunObservation, PlatformRunRequest } from './platforms.js';
import type { SourceTreeObservation } from './source-tree.js';
import {validatePreparationInput,validatePreparationOutput,type CiPreparationOutput} from './ci-preparation.js';
import {EVIDENCE_INPUT_KINDS,LC20_VECTORS,LC20_CHILDREN,type Lc20ProducerContract,type Lc20ProducerPin,type EvidenceInputManifest,type RuntimeDistributionIdentity} from '../lifecycle/correction-contract.js';
import {constants,closeSync,fstatSync,lstatSync,openSync,readFileSync,readSync,realpathSync,readdirSync,readlinkSync} from 'node:fs';
import {dirname,join,resolve,posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {release as osRelease} from 'node:os';
import type {RuntimeStore} from '../server/store.js';
import {readRegisteredNativeToolchain,type IntegrationConfiguration} from './config.js';
import {verifyOwnerDistribution} from './published-owners.js';
import type {EvidenceScope,Lc20ProtocolObservation} from '../lifecycle/correction-contract.js';
import type {Principal} from '../server/security.js';

// Candidate archive parsing is bounded and in-memory. Service code must not
// import the operator installation subsystem or gain extraction/install APIs.
interface RuntimeArchiveFile { path: string; bytes: Buffer; mode: number }
interface RuntimeArchiveLink { path: string; target: string }
interface RuntimeArchiveContents { files: RuntimeArchiveFile[]; links: RuntimeArchiveLink[] }
const RUNTIME_TAR_LIMIT = 512 * 1024 * 1024;
function rejectRuntimeTar(message: string): never { throw new Error('RUNTIME_CANDIDATE_ARCHIVE: ' + message); }
function runtimeTarPath(value: string): string {
  const clean = value.replace(/\/$/, '');
  if (!clean || clean.includes('\\') || clean.startsWith('/') || clean.includes(':') || /[\u0000-\u001f]/.test(clean)
      || clean.split('/').some(p => !p || p === '.' || p === '..')) rejectRuntimeTar('unsafe path');
  return clean;
}
function tarText(bytes: Buffer): string { return bytes.toString('utf8').replace(/\0.*$/s, ''); }
function tarOctal(bytes: Buffer): number {
  const s = tarText(bytes).trim();
  if (s && !/^[0-7]+$/.test(s)) rejectRuntimeTar('non-octal tar value');
  const n = parseInt(s || '0', 8);
  if (!Number.isSafeInteger(n) || n < 0 || n > RUNTIME_TAR_LIMIT) rejectRuntimeTar('tar number limit');
  return n;
}
function tarPax(bytes: Buffer): Record<string, string> {
  const fields: Record<string, string> = {}; let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset), length = Number(bytes.subarray(offset, space).toString());
    if (space < offset || !Number.isSafeInteger(length) || length <= space - offset + 2 || offset + length > bytes.length) rejectRuntimeTar('pax bounds');
    const row = bytes.subarray(space + 1, offset + length - 1).toString('utf8'), eq = row.indexOf('=');
    if (eq < 1 || bytes[offset + length - 1] !== 10) rejectRuntimeTar('pax field');
    fields[row.slice(0, eq)] = row.slice(eq + 1); offset += length;
  }
  return fields;
}
/** Parse only the pinned distribution formats. No archive member executes. */
function readRuntimeTarGz(compressed: Buffer): RuntimeArchiveContents {
  const bytes = gunzipSync(compressed, { maxOutputLength: RUNTIME_TAR_LIMIT });
  const files: RuntimeArchiveFile[] = [], links: RuntimeArchiveLink[] = [], names = new Set<string>();
  let offset = 0, extended: Record<string, string> = {}, globals: Record<string, string> = {};
  while (offset + 512 <= bytes.length) {
    const h = bytes.subarray(offset, offset + 512); offset += 512;
    if (h.every(v => v === 0)) break;
    const expected = tarOctal(h.subarray(148, 156));
    const sum = h.reduce((s, v, i) => s + (i >= 148 && i < 156 ? 32 : v), 0);
    if (sum !== expected) rejectRuntimeTar('tar header checksum');
    const size = tarOctal(h.subarray(124, 136));
    if (offset + size > bytes.length) rejectRuntimeTar('truncated tar');
    const data = bytes.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
    const type = String.fromCharCode(h[156] || 48);
    if (type === 'x') { extended = tarPax(data); continue; }
    if (type === 'g') { globals = { ...globals, ...tarPax(data) }; continue; }
    const metadata = { ...globals, ...extended }; extended = {};
    if (metadata.size !== undefined && Number(metadata.size) !== size) rejectRuntimeTar('pax size mismatch');
    const prefix = tarText(h.subarray(345, 500));
    const name = runtimeTarPath(metadata.path ?? ((prefix ? prefix + '/' : '') + tarText(h.subarray(0, 100))));
    if (names.has(name) || names.size >= 20000) rejectRuntimeTar('duplicate tar member/limit'); names.add(name);
    if (type === '5') continue;
    if (type === '2') {
      const target = metadata.linkpath ?? tarText(h.subarray(157, 257));
      if (!target || posix.isAbsolute(target) || target.includes('\\')) rejectRuntimeTar('unsafe tar link');
      runtimeTarPath(posix.normalize(posix.join(posix.dirname(name), target)));
      links.push({ path: name, target });
    } else if (type === '0') files.push({ path: name, bytes: Buffer.from(data), mode: tarOctal(h.subarray(100, 108)) & 0o777 });
    else rejectRuntimeTar('unsupported tar member type ' + type);
  }
  if (!files.length) rejectRuntimeTar('empty tar');
  for (const link of links) {
    const target = posix.normalize(posix.join(posix.dirname(link.path), link.target));
    if (!names.has(target) || files.some(f => f.path.startsWith(link.path + '/'))) rejectRuntimeTar('dangling or parent tar link');
  }
  return { files, links };
}

export const MAX_ARCHIVE_BYTES=128*1024*1024;
const MAX_EXPANDED_BYTES=256*1024*1024,MAX_ENTRIES=512;
const hash=(v:unknown):string=>{const s=string(v,71);if(!/^sha256:[a-f0-9]{64}$/.test(s))reject('CI_ARTIFACT_INVALID','Expected exact content digest');return s;};
export function artifactPath(value:unknown):string{
  const path=string(value,512);
  if(!/^[-a-zA-Z0-9_./]+$/.test(path)||path.split('/').some(s=>!s||s==='.'||s==='..'))reject('CI_ARCHIVE_PATH','Artifact paths must be relative, unambiguous regular files',409);return path;
}
/** ZIP data never becomes a filesystem path or executable. Upstream validates
 * entry sizes; Runtime additionally bounds expansion and checks CRC, collisions
 * and regular-file types before returning any bytes to its fixed collector. */
export async function readArtifactArchive(bytes:Buffer,signal:AbortSignal):Promise<ReadonlyMap<string,Buffer>>{
  if(bytes.length<22||bytes.length>MAX_ARCHIVE_BYTES)reject('CI_ARCHIVE_LIMIT','Artifact archive exceeds the bounded transfer profile',409);
  let zip:ZipFile|undefined;
  try{
    signal.throwIfAborted();zip=await fromBufferPromise(bytes,{lazyEntries:true,strictFileNames:true,validateEntrySizes:true,decodeStrings:true});
    if(zip.entryCount<1||zip.entryCount>MAX_ENTRIES)reject('CI_ARCHIVE_LIMIT','Artifact entry count exceeds the bounded profile',409);
    const files=new Map<string,Buffer>(),paths=new Map<string,boolean>();let expanded=0,count=0;
    for await(const entry of zip.eachEntry()){
      signal.throwIfAborted();if(++count>MAX_ENTRIES)reject('CI_ARCHIVE_LIMIT','Artifact entry count exceeds the bounded profile',409);
      const directory=entry.fileName.endsWith('/'),path=artifactPath(directory?entry.fileName.slice(0,-1):entry.fileName),key=path.toLowerCase(),mode=(entry.externalFileAttributes>>>16)&0o170000;
      if(paths.has(key)||[...paths].some(([old,isDir])=>old.startsWith(key+'/')&&!directory||key.startsWith(old+'/')&&!isDir))reject('CI_ARCHIVE_PATH','Artifact paths overlap or collide',409);
      paths.set(key,directory);
      if(entry.generalPurposeBitFlag&1||![0,8].includes(entry.compressionMethod)||mode!==0&&mode!==(directory?0o040000:0o100000))reject('CI_ARCHIVE_TYPE','Encrypted, linked or special artifact entries are not supported',409);
      if(!Number.isSafeInteger(entry.uncompressedSize)||entry.uncompressedSize<0||entry.uncompressedSize>MAX_EXPANDED_BYTES||expanded+entry.uncompressedSize>MAX_EXPANDED_BYTES||directory&&entry.uncompressedSize!==0)reject('CI_ARCHIVE_LIMIT','Artifact expansion exceeds the bounded profile',409);
      if(directory)continue;
      expanded+=entry.uncompressedSize;const stream=await zip.openReadStreamPromise(entry),chunks:Buffer[]=[];let actual=0,crc=0;
      const abort=()=>stream.destroy(new ServiceError('CI_ARTIFACT_INTERRUPTED','Artifact verification was interrupted',409));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      try{for await(const part of stream){const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);actual+=chunk.length;if(actual>entry.uncompressedSize||actual>MAX_EXPANDED_BYTES)reject('CI_ARCHIVE_LIMIT','Artifact expanded beyond its declared size',409);crc=crc32(chunk,crc);chunks.push(chunk);}}
      finally{signal.removeEventListener('abort',abort);stream.destroy();}
      if(actual!==entry.uncompressedSize||crc!==entry.crc32)reject('CI_ARCHIVE_INTEGRITY','Artifact size or CRC differs from its ZIP metadata',409);
      files.set(path,Buffer.concat(chunks));
    }
    signal.throwIfAborted();if(!files.size||count!==zip.entryCount)reject('CI_ARCHIVE_INVALID','Artifact archive is incomplete or empty',409);return files;
  }catch(e){if(e instanceof ServiceError)throw e;return reject('CI_ARCHIVE_INVALID','Artifact archive could not be safely verified',409);}finally{zip?.close();}
}
export interface CiEvidenceFile { path:string; digest:string; bytes:number; }
export interface CandidateArchiveIdentity {
  provider:'github'|'gitlab';repositoryId:string;runId:string;artifactId:string;jobId:string|null;
  archiveDigest:string;archiveBytes:number;
}
export interface CandidateInput {schema:'runtime-ci-candidate-input/v1';manifest:CandidateManifest;archive:CandidateArchiveIdentity;}
/** An immutable provider identity, never an arbitrary download URL or token. */
export function validateCandidateInput(value:CandidateInput,request:Pick<PlatformRunRequest,'candidateDigest'|'commit'>,provider:string,repositoryId:string):CandidateInput{
  const v=record(value);exact(v,['schema','manifest','archive']);const a=record(v.archive);exact(a,['provider','repositoryId','runId','artifactId','jobId','archiveDigest','archiveBytes']);
  if(v.schema!=='runtime-ci-candidate-input/v1'||candidateDigest(v.manifest as CandidateManifest)!==request.candidateDigest||record(v.manifest).sourceDigest!==ciSourceDigest(request as PlatformRunRequest,provider,repositoryId)||a.provider!==provider||a.repositoryId!==repositoryId||!['runId','artifactId','repositoryId'].every(k=>/^[1-9][0-9]{0,19}$/.test(string(a[k],20)))||provider==='github'&&a.jobId!==null||provider==='gitlab'&&(a.jobId!==a.artifactId)||!Number.isSafeInteger(a.archiveBytes)||Number(a.archiveBytes)<22||Number(a.archiveBytes)>MAX_ARCHIVE_BYTES||Buffer.byteLength(canonical(v))>49152)reject('CI_CANDIDATE_INPUT_INVALID','Candidate input must pin the original bounded archive and manifest',409);
  hash(a.archiveDigest);return value;
}
export interface CiArtifactCheck { id:string; status:'PASS'|'FAIL'|'UNKNOWN'; evidence:CiEvidenceFile[]; }
export interface CiArtifactResult {
  schema:'runtime-ci/v1'; requestId:string; inputDigest:string; provider:'github'|'gitlab';
  repositoryId:string; runId:string; sourceCommit:string; workflowDigest:string;
  stageId:string; candidateDigest:string|null; checks:CiArtifactCheck[]; candidate?:CandidateManifest;
  candidateConsumption?:{inputDigest:string;artifacts:CandidateManifest['artifacts']};
  preparationOutput?:CiPreparationOutput;
}
export interface VerifiedCiArtifact {
  schema:'runtime-ci-verified-artifact/v1'; requestId:string; inputDigest:string;
  runId:string; archiveDigest:string; resultDigest:string; evidenceRef:string;
  status:'PASSED'|'FAILED'|'UNKNOWN'; checks:CiArtifactCheck[]; candidate:CandidateManifest|null;
  candidateDigest:string|null; files:CiEvidenceFile[]; artifactsVerified:true;
  ownerEvaluationsVerified:false; lifecycleAcceptance:false;
  sourceArchive:CandidateArchiveIdentity;
  preparationOutput?:CiPreparationOutput;
}
/** Optional private evidence, never a required runtime-ci/v1 field. The fixed
 * reader is called only after registered-provider capture and archive retention.
 * Its integrity findings do not authenticate arbitrary caller-supplied bytes. */
export const CI_ACCEPTANCE_REPORT_PATH='evidence/acceptance-report.json';
/** Runtime release candidate identity is the inner distribution manifest, not
 * its containing lifecycle artifact-set manifest. Both identities are retained.
 * No unbound/echoed manifest can establish the installed bytes. */
export function readRuntimeDistributionCandidate(files:ReadonlyMap<string,Buffer>,manifest:CandidateManifest,sourceCommit:string) {
  const lifecycleCandidateDigest=candidateDigest(manifest),pick=(name:string)=>{const item=manifest.artifacts.find(a=>a.name===name),raw=files.get('artifacts/'+name)??files.get('candidate/'+name);if(!item||!raw||raw.length!==item.bytes||byteDigest(raw)!==item.digest)reject('QUALIFICATION_RUNTIME_CANDIDATE_REQUIRED','Original lifecycle candidate must contain the exact Runtime distribution assets',409);return raw;};
  const manifestBytes=pick('distribution-manifest.json'),archive=pick('evopilot-runtime-0.9.0-darwin-arm64.tar.gz'),revision=pick('source-revision.txt'),v=record(JSON.parse(manifestBytes.toString('utf8')));exact(v,['schema','version','archiveDigest','files']);
  if(v.schema!=='runtime-standalone-distribution/v1'||v.version!=='0.9.0'||v.archiveDigest!==byteDigest(archive).slice(7)||revision.toString('utf8').trim()!==sourceCommit||!/^[a-f0-9]{40}$/.test(sourceCommit))reject('QUALIFICATION_RUNTIME_CANDIDATE_CHANGED','Runtime distribution source/archive differs from its actual original source',409);
  const unpacked=readRuntimeTarGz(archive),entries=record(v.files),seen=new Set<string>(),pins=new Map<string,string>();
  for(const f of unpacked.files){if(!f.path.startsWith('package/'))reject('QUALIFICATION_RUNTIME_CANDIDATE_CHANGED','Unexpected candidate archive root',409);const path=f.path.slice(8),p=record(entries[path]);exact(p,['type','sha256','bytes','mode']);if(p.type!=='file'||p.sha256!==byteDigest(f.bytes).slice(7)||p.bytes!==f.bytes.length||p.mode!==f.mode)reject('QUALIFICATION_RUNTIME_CANDIDATE_CHANGED','Distribution manifest does not describe original archive bytes',409);seen.add(path);pins.set(path,byteDigest(f.bytes));}
  for(const link of unpacked.links){if(!link.path.startsWith('package/'))reject('QUALIFICATION_RUNTIME_CANDIDATE_CHANGED','Unexpected candidate link root',409);const path=link.path.slice(8),p=record(entries[path]);exact(p,['type','target']);if(p.type!=='symlink'||p.target!==link.target)reject('QUALIFICATION_RUNTIME_CANDIDATE_CHANGED','Distribution link differs from its manifest',409);seen.add(path);}
  if(seen.size!==Object.keys(entries).length)reject('QUALIFICATION_RUNTIME_CANDIDATE_CHANGED','Distribution inventory is incomplete',409);
  const identity:RuntimeDistributionIdentity={schema:'runtime-distribution-execution-identity/v1',lifecycleCandidateDigest,manifestDigest:byteDigest(manifestBytes),archiveDigest:byteDigest(archive),sourceRevisionDigest:byteDigest(revision),sourceCommit};
  return{identity,candidateDigest:identity.manifestDigest,files:pins};
}
export const LC20_INPUT_PATH='evidence/lc20-input-snapshot.json';
export const LC20_EXECUTION_PATH='evidence/lc20-execution.json';
/** Fixed producer observation, not a caller-provided hermeticity assertion.
 * The accepted interface is installed Runtime code, registered native tools,
 * six closed children and their complete managed history. No shell/LLM/plugin
 * discovery runs here. Unknown loader/system inputs stay UNKNOWN. */
export function observeLc20Protocol(store:RuntimeStore,configuration:Readonly<IntegrationConfiguration>,scope:EvidenceScope,policyReferenceDigest:string,actor:Principal):Lc20ProtocolObservation {
  const result:Lc20ProtocolObservation={schema:'runtime-lc20-protocol-observation/v1',scope,status:'UNKNOWN',reasons:[],installedCandidateDigest:null,inputs:[],files:[],childHistory:[]};
  const add=(id:string,kind:Lc20ProtocolObservation['inputs'][number]['kind'],value:unknown)=>{const raw=canonical(value);result.inputs.push({id,kind,raw,digest:byteDigest(raw)});};
  const files=new Map<string,{path:string;digest:string;bytes:number}>();let total=0;
  const file=(path:string)=>{path=realpathSync(path);const old=files.get(path);if(old)return old;const before=lstatSync(path);if(!before.isFile()||before.nlink!==1||(before.mode&0o022)!==0||before.size<1||before.size>268435456||(total+=before.size)>536870912)reject('LC20_RUNTIME_INPUT_UNKNOWN','Runtime input is not a bounded immutable regular file',409);const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),h=createHash('sha256'),buffer=Buffer.alloc(65536);let size=0;const same=(s:ReturnType<typeof fstatSync>)=>['dev','ino','uid','gid','mode','nlink','size','mtimeMs','ctimeMs'].every(k=>s[k as keyof typeof s]===before[k as keyof typeof before]);try{if(!same(fstatSync(fd)))reject('LC20_RUNTIME_INPUT_UNKNOWN','Runtime input changed',409);for(;;){const n=readSync(fd,buffer,0,Math.min(buffer.length,before.size-size+1),null);if(!n)break;size+=n;if(size>before.size)reject('LC20_RUNTIME_INPUT_UNKNOWN','Runtime input grew',409);h.update(buffer.subarray(0,n));}if(size!==before.size||!same(fstatSync(fd))||!same(lstatSync(path)))reject('LC20_RUNTIME_INPUT_UNKNOWN','Runtime input changed',409);}finally{closeSync(fd);}const pin={path,digest:'sha256:'+h.digest('hex'),bytes:size};files.set(path,pin);return pin;};
  try{
    if(scope.workspaceId!==store.workspaceId||scope.projectId!==configuration.resources.find(r=>r.projectId===scope.projectId)?.projectId)reject('LC20_RUNTIME_INPUT_UNKNOWN','Exact registered scope required',409);
    // Source loaders, preloads and arbitrary import search paths are outside
    // this finite installed protocol. They cannot certify their own source run.
    // Diagnostic observation only: preload flags never supply configuration,
    // paths or credentials, and the full report/environment is never retained.
    const report=record(process.report.getReport()),environment=record(report.environmentVariables);
    if(process.version!=='v24.14.0'||environment.NODE_OPTIONS||environment.NODE_PATH||process.execArgv.length)reject('LC20_RUNTIME_INPUT_UNKNOWN','Use the fixed installed Node invocation without preloads',409);
    const modulePath=fileURLToPath(import.meta.url);if(!modulePath.endsWith('/package/dist/adapters/artifacts.js'))reject('LC20_RUNTIME_INPUT_UNKNOWN','An actual installed package is required',409);
    const root=resolve(dirname(modulePath),'../../..'),manifestPath=join(root,'distribution-manifest.json'),manifestBytes=readFileSync(manifestPath),manifest=record(JSON.parse(manifestBytes.toString('utf8'))),inventory=record(manifest.files),code:Record<string,string>={},connection=record(JSON.parse(readFileSync(join(root,'connection.json'),'utf8')));
    if(connection.workspaceId!==scope.workspaceId||connection.serviceId!==store.serviceId||connection.projectId!==scope.projectId||!(realpathSync(store.root)===root+'/data'||realpathSync(store.root).startsWith(root+'/data/')))reject('LC20_RUNTIME_INPUT_UNKNOWN','This is not the selected installed service',409);
    if(manifest.schema!=='runtime-standalone-distribution/v1'||manifest.version!=='0.9.0')reject('LC20_RUNTIME_INPUT_UNKNOWN','Current Runtime distribution identity required',409);result.installedCandidateDigest=byteDigest(manifestBytes);
    const selected=(p:string)=>p==='package.json'||['dist/','vendor/','node_modules/','provenance/'].some(prefix=>p.startsWith(prefix));
    for(const [path,raw]of Object.entries(inventory)){if(!selected(path))continue;artifactPath(path);const p=record(raw),absolute=join(root,'package',path);if(p.type==='symlink'){if(!lstatSync(absolute).isSymbolicLink()||readlinkSync(absolute)!==p.target||!realpathSync(absolute).startsWith(root+'/package/'))reject('LC20_RUNTIME_INPUT_UNKNOWN','Installed dependency link changed',409);code[path]=valueDigest({target:p.target});continue;}const actual=file(absolute);if(p.type!=='file'||actual.digest!=='sha256:'+p.sha256||actual.bytes!==p.bytes)reject('LC20_RUNTIME_INPUT_UNKNOWN','Installed executable bytes differ from the original manifest',409);code[path]=actual.digest;}
    const seen=new Set<string>(),walk=(relative:string)=>{const dir=join(root,'package',relative);for(const name of readdirSync(dir)){const path=relative?relative+'/'+name:name;if(!relative&&!selected(path)&&!['dist','vendor','node_modules','provenance'].includes(path))continue;const stat=lstatSync(join(root,'package',path));if(stat.isDirectory()&&!stat.isSymbolicLink())walk(path);else{if(!Object.hasOwn(code,path))reject('LC20_RUNTIME_INPUT_UNKNOWN','Unlisted installed code could affect resolution',409);seen.add(path);}}};walk('');if(seen.size!==Object.keys(code).length)reject('LC20_RUNTIME_INPUT_UNKNOWN','Installed code inventory is incomplete',409);
    if(!code['dist/adapters/artifacts.js']||!code['dist/lifecycle/evidence-qualification.js']||!code['package.json'])reject('LC20_RUNTIME_INPUT_UNKNOWN','Installed code inventory is incomplete',409);add('runtime:installed-code','generated',code);
    const node=file(process.execPath),shared=report.sharedObjects;if(!Array.isArray(shared)||shared.length>512)reject('LC20_RUNTIME_INPUT_UNKNOWN','Runtime shared-object inventory is unavailable',409);const libraries=shared.map(p=>file(string(p,2048))).sort((a,b)=>a.path<b.path?-1:1);
    add('runtime:environment','environment',{schema:'runtime-lc20-environment/v1',node,versions:process.versions,platform:process.platform,arch:process.arch,osRelease:osRelease(),libraries,preloads:[]});
    const toolchain=readRegisteredNativeToolchain(configuration),tools=Object.fromEntries(Object.entries(toolchain.tools).map(([id,t])=>{const actual=file(t.executable);if(actual.digest!=='sha256:'+t.sha256)reject('LC20_RUNTIME_INPUT_UNKNOWN','Native executable changed',409);return[id,{...actual,version:t.version}];})),dependencies=toolchain.dependencyFiles!.map(p=>{const actual=file(p.path);if(actual.digest!=='sha256:'+p.sha256)reject('LC20_RUNTIME_INPUT_UNKNOWN','Native dependency changed',409);return actual;});
    const owners=configuration.owners.filter(o=>o.owner==='harness'&&o.projects.includes(scope.projectId));if(!owners.length)reject('LC20_RUNTIME_INPUT_UNKNOWN','Registered Harness owner required',409);const identities=owners.map(o=>verifyOwnerDistribution('harness',o.packageRoot));add('runtime:toolchain','toolchain',{schema:'runtime-lc20-tools/v1',tools,dependencies,owners:identities,lockDigest:toolchain.lockDigest,dependencyLockDigest:toolchain.dependencyLockDigest});
    const registrations=configuration.resources.filter(r=>r.projectId===scope.projectId&&r.role==='runtime.qualification'&&record(r.definition.reference).digest===policyReferenceDigest),prefixes=new Set<string>();
    for(const child of LC20_CHILDREN){const selected=registrations.flatMap(r=>(Array.isArray(r.definition.probes)?r.definition.probes:[]).map(record).filter(p=>p.caseId==='LC20'&&p.lc20Child===child).map(p=>({r,p})));if(selected.length!==1||Date.parse(selected[0].r.expiresAt)<=Date.now())reject('LC20_RUNTIME_INPUT_UNKNOWN','Exactly six current registered children are required',409);
      const key='closed-fixture:'+valueDigest({scope,caseId:'LC20',lc20Child:child}),ledger=store.object(scope.projectId,'lifecycle-evidence-qualification',key),history=ledger===null?[]:record(ledger).attempts;if(!Array.isArray(history)||history.length+10>4096)reject('LC20_PRESTATE_UNKNOWN','The fixed full protocol lacks original child capacity',409);
      for(let i=0;i<history.length;i++){const a=record(history[i]),o=record(a.original),raw=string(a.rawReceipt,131072),receipt=record(JSON.parse(raw));if(o.mode!=='EXECUTED'||o.outcome!=='PASS'||o.caseId!=='LC20'||canonical(o.scope)!==canonical(scope)||o.runId!==a.requestId||o.rawReceiptDigest!==byteDigest(raw)||receipt.requestId!==a.requestId||receipt.formalCaseCredit!==0||record(receipt.result).outcome!=='PASS')reject('LC20_PRESTATE_UNKNOWN','Every actual child attempt, including failures and uncertainty, is retained',409);const prefix=history.slice(0,i+1);prefixes.add(valueDigest({schema:'runtime-closed-fixture-history/v2',attempts:prefix}));prefixes.add(valueDigest({schema:'runtime-closed-fixture-history/v2',attempts:[...prefix.slice(0,-1),{...a,original:null,inputs:null,rawReceipt:null}]}));}
      result.childHistory.push({child,ledgerRef:key,digest:valueDigest(history),attempts:history.length});
    }
    let cursor:string|undefined,count=0;for(;;){const page=store.events(actor,scope.projectId,cursor);for(const raw of page.events){if(++count>32768)reject('LC20_PRESTATE_UNKNOWN','Complete child audit exceeds fixed read bound',409);const e=record(raw);if(e.type==='closed-fixture-execution'&&!prefixes.has(String(record(e.data).historyDigest)))reject('LC20_PRESTATE_UNKNOWN','A child claim is absent from the complete retained history',409);}if(!page.events.length)break;cursor=page.cursor;}
    add('runtime:prestate','prestate',{schema:'runtime-lc20-prestate-projection/v1',children:[...LC20_CHILDREN],allOriginalAttemptsTerminalPass:true,remainingFixedProtocolCapacity:true});
    add('runtime:configuration','config',{schema:'runtime-lc20-configuration/v1',scope,children:[...LC20_CHILDREN],protocol:'runtime-lc20-local-installed/v1',executionOperation:'CANONICAL_JSON_DIGEST_EQUALS',subcaseFormalCredit:0});
    result.status='COMPLETE';
  }catch(error){result.reasons.push(error instanceof ServiceError?error.code:'LC20_RUNTIME_INPUT_UNKNOWN');}
  result.files=[...files.values()].sort((a,b)=>a.path<b.path?-1:1);return result;
}
/** Asset syntax is not semantic approval. Only the actual published package
 * reader may choose this fixed contract for a protected original StagePlan. */
export function readLc20ProducerContract(value:unknown):Lc20ProducerContract {
  const p=record(value);exact(p,['schema','caseId','phase','catalogDigest','collector','workflows','roots','nodes','vectors','children','maxAgeSeconds','protocol']);
  if(p.schema!=='runtime-lc20-producer-contract/v1'||p.protocol!=='runtime-lc20-local-installed/v1'||p.caseId!=='LC20'||p.phase!=='PRE_RELEASE'||canonical(p.vectors)!==canonical(LC20_VECTORS)||canonical(p.children)!==canonical(LC20_CHILDREN))reject('LC20_PRODUCER_CONTRACT','Only the complete fixed LC20 protocol is supported',409);
  hash(p.catalogDigest);const collector=record(p.collector);exact(collector,['sourcePath','digest']);if(collector.sourcePath!=='tests/acceptance/v090/correction.test.mjs')reject('LC20_PRODUCER_CONTRACT','The fixed correction collector is required',409);hash(collector.digest);
  const workflows=record(p.workflows);exact(workflows,['EXECUTE','INVENTORY']);for(const v of Object.values(workflows)){const w=record(v);exact(w,['sourcePath','digest']);artifactPath(w.sourcePath);hash(w.digest);}
  if(!Number.isSafeInteger(p.maxAgeSeconds)||Number(p.maxAgeSeconds)<1||Number(p.maxAgeSeconds)>86400||!Array.isArray(p.nodes)||p.nodes.length<12||p.nodes.length>128||!Array.isArray(p.roots)||!p.roots.length)reject('LC20_PRODUCER_CONTRACT','Bounded existing validity and complete reviewed inventory required',409);
  const ids=new Set<string>(),kinds=new Set<string>();for(const raw of p.nodes){const n=record(raw);exact(n,['id','kind','digest','sourcePath','candidatePath','dependsOn']);const id=string(n.id,128);if(ids.has(id)||!EVIDENCE_INPUT_KINDS.includes(n.kind as never)||['policy','ttl'].includes(String(n.kind))||!Array.isArray(n.dependsOn)||n.dependsOn.length>128||new Set(n.dependsOn).size!==n.dependsOn.length)reject('LC20_PRODUCER_CONTRACT','Duplicate, absent or unsupported input declaration',409);ids.add(id);kinds.add(String(n.kind));if(id.startsWith('runtime:')){if(!['runtime:installed-code','runtime:environment','runtime:toolchain','runtime:configuration','runtime:prestate'].includes(id)||n.digest!==null)reject('LC20_PRODUCER_CONTRACT','Only five protected observed inputs may have a dynamic digest',409);}else hash(n.digest);if(n.sourcePath!==null)artifactPath(n.sourcePath);if(n.candidatePath!==null)artifactPath(n.candidatePath);n.dependsOn.forEach(v=>string(v,128));}
  if(kinds.size!==12||!p.nodes.some(raw=>{const n=record(raw);return n.kind==='collector'&&n.sourcePath===collector.sourcePath&&n.digest===collector.digest;})||!p.nodes.some(raw=>record(raw).kind==='source'&&record(raw).sourcePath!==null)||!p.nodes.some(raw=>record(raw).kind==='generated'&&record(raw).candidatePath!==null))reject('LC20_PRODUCER_CONTRACT','All twelve concrete inputs, original source and actual candidate bytes are required',409);
  for(const [id,kind]of [['runtime:installed-code','generated'],['runtime:environment','environment'],['runtime:toolchain','toolchain'],['runtime:configuration','config'],['runtime:prestate','prestate']])if(!p.nodes.some(raw=>{const n=record(raw);return n.id===id&&n.kind===kind&&n.sourcePath===null&&n.candidatePath===null;}))reject('LC20_PRODUCER_CONTRACT','Runtime protocol observations cannot be supplied by arbitrary archived JSON',409);
  const pending=p.roots.map(v=>string(v,128)),seen=new Set<string>();while(pending.length){const id=pending.pop()!;if(seen.has(id))continue;const n=p.nodes.map(record).find(n=>n.id===id);if(!n)reject('LC20_PRODUCER_CONTRACT','Unknown dependency edge',409);seen.add(id);pending.push(...n.dependsOn as string[]);}if(seen.size!==ids.size)reject('LC20_PRODUCER_CONTRACT','Unreachable input cannot prove a complete protocol',409);
  return structuredClone(p) as unknown as Lc20ProducerContract;
}
/** Read original archive files under an already authenticated plan. There is no
 * completeness/trust/sandbox-success field that an API caller can set. */
export function readLc20InputSnapshot(files:ReadonlyMap<string,Buffer>,pin:Lc20ProducerPin,expected:{requestId:string;inputDigest:string;sourceCommit:string;candidateDigest:string;producerJobId:string},source:SourceTreeObservation,candidateFiles:ReadonlyMap<string,string>):EvidenceInputManifest {
  const b=files.get(LC20_INPUT_PATH);if(!b||b.length>131072)reject('LC20_INPUT_UNAVAILABLE','Original bounded input snapshot required',409);
  const v=record(JSON.parse(b.toString('utf8')));exact(v,['schema','contractDigest','mode','requestId','inputDigest','sourceCommit','candidateDigest','producerJobId','inputs']);
  if(v.schema!=='runtime-lc20-input-snapshot/v1'||v.contractDigest!==pin.contractDigest||pin.contractDigest!==valueDigest(pin.contract)||v.mode!==pin.mode||Object.entries(expected).some(([k,x])=>v[k]!==x)||!Array.isArray(v.inputs)||v.inputs.length!==pin.contract.nodes.length)reject('LC20_INPUT_UNAVAILABLE','Snapshot must belong to the exact original protected plan and complete protocol',409);
  const ids=new Set<string>(),paths=new Set<string>(),nodes:EvidenceInputManifest['nodes']=[];
  for(const item of v.inputs){const r=record(item);exact(r,['id','file']);const id=string(r.id,128),n=pin.contract.nodes.find(n=>n.id===id),f=record(r.file);exact(f,['path','digest','bytes']);const path=artifactPath(f.path),raw=files.get(path);
    if(!n||ids.has(id)||paths.has(path)||!raw||raw.length!==f.bytes||raw.length===0||byteDigest(raw)!==f.digest||n.digest!==null&&f.digest!==n.digest)reject('LC20_INPUT_UNAVAILABLE','Unknown, omitted or changed input bytes require full execution',409);ids.add(id);paths.add(path);
    if(n.sourcePath!==null){const e=source.entries.find(e=>e.path===n.sourcePath);if(!e||e.type!=='blob'||e.mode==='120000'||e.objectId!==createHash('sha1').update(Buffer.from('blob '+raw.length+'\0')).update(raw).digest('hex'))reject('LC20_SOURCE_CHANGED','Input bytes differ from protected committed source',409);}
    if(n.candidatePath!==null&&candidateFiles.get(n.candidatePath)!==n.digest)reject('LC20_CANDIDATE_CHANGED','Actual generated input differs from the protected candidate archive',409);
    if(n.id.startsWith('runtime:')){const observed=pin.protocolObservation.inputs.find(i=>i.id===n.id);if(!observed||observed.kind!==n.kind||observed.digest!==f.digest||observed.raw!==raw.toString('utf8'))reject('LC20_INPUT_UNAVAILABLE','Runtime input must equal the actual pre-dispatch protected observation',409);}
    nodes.push({id,kind:n.kind,digest:hash(f.digest),dependsOn:[...n.dependsOn]});
  }
  const proven=pin.protocolObservation.status==='COMPLETE'&&pin.protocolObservation.installedCandidateDigest===expected.candidateDigest;
  return{schema:'runtime-evidence-input-manifest/v1',candidateDigest:expected.candidateDigest,completeness:proven?'COMPLETE':'UNKNOWN',dynamicInputs:proven?'RESOLVED':'UNKNOWN',externalInputs:proven?'RESOLVED':'UNKNOWN',roots:[...pin.contract.roots],nodes,notApplicable:[]};
}
/** This parser is deliberately whole-case: six child receipts or a single
 * passing vector can never stand for the formal LC20 original execution. */
export function readLc20Execution(files:ReadonlyMap<string,Buffer>,pin:Lc20ProducerPin,expected:{requestId:string;inputDigest:string;sourceCommit:string;candidateDigest:string}) {
  const raw=files.get(LC20_EXECUTION_PATH);if(!raw||raw.length>131072||pin.mode!=='EXECUTE')reject('LC20_EXECUTION_REQUIRED','Whole original LC20 execution required',409);
  const v=record(JSON.parse(raw.toString('utf8')));exact(v,['schema','caseId','phase','mode','contractDigest','requestId','inputDigest','sourceCommit','candidateDigest','startedAt','completedAt','inputSnapshotDigest','protocol','vectors','outcome']);
  const start=Date.parse(string(v.startedAt,64)),end=Date.parse(string(v.completedAt,64));if(v.schema!=='runtime-lc20-complete-execution/v1'||v.caseId!=='LC20'||v.phase!=='PRE_RELEASE'||v.mode!=='EXECUTED'||v.contractDigest!==pin.contractDigest||Object.entries(expected).some(([k,x])=>v[k]!==x)||v.inputSnapshotDigest!==byteDigest(files.get(LC20_INPUT_PATH)??Buffer.alloc(0))||!Number.isFinite(start)||!Number.isFinite(end)||end<start||end>Date.now()||!['PASS','FAIL','UNKNOWN'].includes(String(v.outcome))||!Array.isArray(v.vectors)||canonical(v.vectors.map(r=>record(r).id).sort())!==canonical([...LC20_VECTORS].sort()))reject('LC20_EXECUTION_REQUIRED','Four actual original vectors and their exact candidate are required',409);
  const read=(ref:unknown,limit=131072)=>{const f=record(ref);exact(f,['path','digest','bytes']);const b=files.get(artifactPath(f.path));if(!b||b.length!==f.bytes||b.length>limit||byteDigest(b)!==f.digest)reject('LC20_EXECUTION_REQUIRED','Original child/decision bytes are missing',409);return record(JSON.parse(b.toString('utf8')));};
  const protocol=record(v.protocol);exact(protocol,['before','after']);const before=read(protocol.before,2097152),after=read(protocol.after,2097152);
  for(const observation of [before,after])if(observation.schema!=='runtime-lc20-protocol-readback/v1'||observation.stageRequestId!==expected.requestId||observation.inputDigest!==expected.inputDigest||observation.contractDigest!==pin.contractDigest||canonical(observation.contract)!==canonical(pin.contract)||canonical(observation.original)!==canonical(pin.protocolObservation)||record(observation.current).installedCandidateDigest!==expected.candidateDigest||record(observation.current).status!=='COMPLETE'||record(observation.original).status!=='COMPLETE'||observation.stageRequestDigest!==before.stageRequestDigest||observation.disposition!=='PROVEN_FIXED_INPUTS'||canonical(record(observation.current).inputs)!==canonical(pin.protocolObservation.inputs))reject('LC20_EXECUTION_REQUIRED','Actual pre-bound before/after Runtime observations are required',409);
  const usedExecutions=new Set<string>(),validity:number[]=[];
  for(const rawVector of v.vectors){const vector=record(rawVector);exact(vector,['id','baseline','selective','full','decisions','outcome']);if(!Array.isArray(vector.baseline)||!Array.isArray(vector.selective)||!Array.isArray(vector.full)||!Array.isArray(vector.decisions)||canonical(vector.baseline.map(x=>record(x).id).sort())!==canonical(LC20_CHILDREN)||canonical(vector.full.map(x=>record(x).id).sort())!==canonical(LC20_CHILDREN)||canonical(vector.decisions.map(x=>record(x).id).sort())!==canonical(LC20_CHILDREN))reject('LC20_EXECUTION_REQUIRED','All six children must have real baseline, full and Runtime decisions',409);
    const child=(item:unknown)=>{const r=record(item);exact(r,['id','receipt']);if(!LC20_CHILDREN.includes(r.id as never))reject('LC20_EXECUTION_REQUIRED','Unknown fixture child',409);const proof=read(r.receipt);exact(proof,['schema','id','originalExecutionDigest','original','rawReceipt']);const original=record(proof.original),receipt=record(JSON.parse(string(proof.rawReceipt,131072)));if(proof.schema!=='runtime-lc20-child-observation/v1'||proof.id!==r.id||valueDigest(original)!==proof.originalExecutionDigest||original.schema!=='runtime-original-evidence-execution/v1'||original.mode!=='EXECUTED'||original.caseId!=='LC20'||original.outcome!=='PASS'||byteDigest(String(proof.rawReceipt))!==original.rawReceiptDigest||receipt.schema!=='runtime-closed-fixture-execution/v2'||receipt.requestId!==original.runId||receipt.candidateDigest!==original.candidateDigest||canonical(receipt.scope)!==canonical(original.scope)||record(receipt.result).outcome!=='PASS'||receipt.formalCaseCredit!==0||canonical(original.scope)!==canonical(pin.protocolObservation.scope)||receipt.inputManifestDigest!==original.inputManifestDigest||usedExecutions.has(String(original.runId))||Date.parse(String(receipt.startedAt))<start||Date.parse(String(receipt.completedAt))>end)reject('LC20_EXECUTION_REQUIRED','Subordinate fixtures must remain actual executed, distinct, passing and nonformal',409);usedExecutions.add(String(original.runId));validity.push(Date.parse(string(original.expiresAt,64)));return{id:String(r.id),proof,original,receipt};};
    const baseline=new Map(vector.baseline.map(child).map(c=>[c.id,c])),full=new Map(vector.full.map(child).map(c=>[c.id,c])),selected=new Map(vector.selective.map(child).map(c=>[c.id,c]));if(selected.size!==vector.selective.length)reject('LC20_EXECUTION_REQUIRED','Duplicate selective child',409);
    const baselineCandidate=valueDigest({candidate:expected.candidateDigest,vector:vector.id,fixture:'baseline'}),currentCandidate=valueDigest({candidate:expected.candidateDigest,vector:vector.id,fixture:'current'});if([...baseline.values()].some(c=>c.original.candidateDigest!==baselineCandidate)||[...full.values(),...selected.values()].some(c=>c.original.candidateDigest!==currentCandidate))reject('LC20_EXECUTION_REQUIRED','Child identities must belong to this exact whole-case candidate/vector',409);
    const required=vector.id==='unrelated'?[]:vector.id==='direct'?['f']:vector.id==='transitive'?['a','b','c']:[...LC20_CHILDREN];if(canonical([...selected.keys()].sort())!==canonical(required))reject('LC20_EXECUTION_REQUIRED','The fixed vector did not really select its direct/transitive/full set',409);
    for(const item of vector.decisions){const d=record(item);exact(d,['id','qualification']);const q=read(d.qualification),id=String(d.id),chosen=selected.get(id),old=baseline.get(id)!,oracle=full.get(id)!;
      if(q.schema==='runtime-evidence-qualification/v2'){
        if(q.caseId!=='LC20'||q.phase!=='PRE_RELEASE'||q.hasFailureHistory!==false||q.formalAcceptanceEligible!==false||q.status!=='QUALIFIED'||q.mode!=='PASS_REUSED'||q.originalExecutionDigest!==old.proof.originalExecutionDigest||q.rawReceiptDigest!==old.original.rawReceiptDigest||q.originalCandidateDigest!==old.original.candidateDigest||q.currentCandidateDigest!==oracle.original.candidateDigest||canonical(q.scope)!==canonical(old.original.scope)||!q.nativeReceiptDigest||!q.nativeReportDigest||chosen)reject('LC20_EXECUTION_REQUIRED','Reuse requires the original real nonformal native assessment',409);
        hash(q.nativeReceiptDigest);hash(q.nativeReportDigest);string(q.actionRef,512);validity.push(Date.parse(string(q.expiresAt,64)));
      }else{
        const selection=record(q.selection);if(q.schema!=='runtime-probe-input-preview/v1'||q.formalAcceptanceEligible!==false||q.disposition!=='EXECUTION_REQUIRED'||selection.originalExecutionDigest!==old.proof.originalExecutionDigest||selection.currentCandidateDigest!==oracle.original.candidateDigest||!chosen||!Array.isArray(q.reasons)||!q.reasons.length)reject('LC20_EXECUTION_REQUIRED','An actual Runtime input rejection and real execution are required',409);
        if(vector.id==='missing-edge-fallback'&&(q.fallback!=='FULL'||!q.reasons.includes('INPUT_CLOSURE_UNKNOWN')))reject('LC20_EXECUTION_REQUIRED','Unknown graph must fall back to full execution',409);
      }
      if(oracle.original.runId===old.original.runId||chosen&&(chosen.original.runId===old.original.runId||chosen.original.runId===oracle.original.runId)||canonical((chosen??old).receipt.result)!==canonical(oracle.receipt.result))reject('LC20_EXECUTION_REQUIRED','Distinct actual selective and full executions must agree',409);
    }
    if(vector.outcome!=='PASS')reject('LC20_EXECUTION_REQUIRED','A nonpassing vector cannot establish original PASS',409);
  }
  if(v.outcome!=='PASS')reject('LC20_EXECUTION_REQUIRED','The whole original case must really pass',409);
  const expires=Math.min(...validity);if(!Number.isFinite(expires)||expires<=end)reject('LC20_EXECUTION_REQUIRED','Every original child/assessment must remain valid through case completion',409);
  return{rawReceipt:raw.toString('utf8'),rawReceiptDigest:byteDigest(raw),startedAt:String(v.startedAt),completedAt:String(v.completedAt),expiresAt:new Date(expires).toISOString(),stageRequestDigest:hash(before.stageRequestDigest)};
}
/** Fixed actual collector protocol. This parser establishes structure only;
 * registered provider provenance and published collector approval are checked
 * by the protected stage reader before any EXECUTED capture is retained. */
export function readCurrentCaseReceipt(bytes:Buffer,expected:{caseId:string;sourceCommit:string;candidateDigest:string;requestId:string;inputDigest:string;lifecycleCandidateDigest?:string}){
  if(bytes.length<1||bytes.length>131072)reject('CI_CASE_RECEIPT_INVALID','Bounded original case receipt required',409);
  let r:Record<string,unknown>;try{r=record(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}catch{return reject('CI_CASE_RECEIPT_INVALID','Original case receipt must be UTF-8 JSON',409);}
  exact(r,['schema','caseId','sourceCommit','candidateDigest','requestId','inputDigest','startedAt','completedAt','outcome','assertions',...(expected.lifecycleCandidateDigest?['lifecycleCandidateDigest']:[])]);
  if(r.schema!==(expected.lifecycleCandidateDigest?'runtime-case-execution-receipt/v2':'runtime-case-execution-receipt/v1')||Object.entries(expected).some(([key,value])=>r[key]!==value)||r.outcome!=='PASS'||!Object.keys(record(r.assertions)).length)reject('CI_CASE_RECEIPT_INVALID','Original executed case and candidate differ',409);
  const start=Date.parse(string(r.startedAt,64)),end=Date.parse(string(r.completedAt,64));if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||end>Date.now())reject('CI_CASE_RECEIPT_INVALID','Actual execution times required',409);
  return{startedAt:String(r.startedAt),completedAt:String(r.completedAt),rawReceiptDigest:byteDigest(bytes)};
}
export interface CiAcceptanceReportCapture {
  status:'ABSENT'|'INVALID'|'OBSERVED'|'UNAVAILABLE'; reasons:string[];
  report:CiEvidenceFile|null;
  producerJobId:string|null;
  producerBinding:'MATCHED_ORIGINAL_JOB'|'UNVERIFIED';
  workflowSource:'COMMITTED_BYTES_MATCHED'|'UNVERIFIED';
  collectorSource:'COMMITTED_BYTES_MATCHED'|'UNVERIFIED';
  collectorSemanticApproval:'UNKNOWN'; caseCatalog:'UNKNOWN';
  cases:{caseId:string;observedOutcome:'PASS'|'FAIL'|'NOT_RUN'|'CANCELLED'|'UNKNOWN'|'SKIPPED';rawReceipt:CiEvidenceFile}[];
}
export function unavailableCiAcceptanceReport(reason:string):CiAcceptanceReportCapture{
  return{status:'UNAVAILABLE',reasons:[reason],report:null,producerJobId:null,producerBinding:'UNVERIFIED',workflowSource:'UNVERIFIED',collectorSource:'UNVERIFIED',collectorSemanticApproval:'UNKNOWN',caseCatalog:'UNKNOWN',cases:[]};
}
/** Retain references to original ZIP bytes, never a rewritten receipt or an
 * OriginalEvidenceExecution. A matched committed blob is not semantic approval. */
export async function inspectCiAcceptanceReport(archive:PlatformArtifactArchive,request:PlatformRunRequest,verified:VerifiedCiArtifact,proof:{run:PlatformRunObservation;workflowPath:string;requirementsDigest:string;sourceTree?:SourceTreeObservation},signal:AbortSignal):Promise<CiAcceptanceReportCapture>{
  if(verified.requestId!==request.requestId||verified.inputDigest!==request.inputDigest||verified.runId!==archive.runId||verified.archiveDigest!==archive.archiveDigest||archive.archiveDigest!==byteDigest(archive.bytes))reject('CI_CAPTURE_ORIGIN_CHANGED','Acceptance capture requires the exact verified original archive',409);
  const files=await readArtifactArchive(archive.bytes,signal),bytes=files.get(CI_ACCEPTANCE_REPORT_PATH),capture=unavailableCiAcceptanceReport('REPORT_ABSENT');
  capture.status='ABSENT';if(!bytes)return capture;
  capture.report={path:CI_ACCEPTANCE_REPORT_PATH,digest:byteDigest(bytes),bytes:bytes.length};capture.status='INVALID';capture.reasons=[];
  const declared=new Map(verified.checks.flatMap(c=>c.evidence).map(f=>[f.path,f]));
  const file=(value:unknown):CiEvidenceFile=>{
    const f=record(value);exact(f,['path','digest','bytes']);const path=artifactPath(f.path),raw=files.get(path),expected=declared.get(path);
    if(path===CI_ACCEPTANCE_REPORT_PATH||!raw||!expected||raw.length!==f.bytes||raw.length>131072||raw.length===0||hash(f.digest)!==byteDigest(raw)||expected.digest!==f.digest||expected.bytes!==f.bytes)reject('CI_CAPTURE_FILE_INVALID','Acceptance raw evidence must match a bounded declared original file',409);
    return{path,digest:String(f.digest),bytes:raw.length};
  };
  try{
    const reportPin=declared.get(CI_ACCEPTANCE_REPORT_PATH);
    if(!reportPin||reportPin.digest!==capture.report.digest||reportPin.bytes!==bytes.length||bytes.length<1||bytes.length>131072)reject('CI_CAPTURE_REPORT_INVALID','Optional acceptance report must be bounded declared check evidence',409);
    const r=record(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
    exact(r,['schema','requestId','inputDigest','sourceCommit','workflowDigest','candidateDigest','requirementsDigest','producerJobId','workflow','collector','cases']);
    if(r.schema!=='runtime-ci-acceptance-report/v1'||r.requestId!==request.requestId||r.inputDigest!==request.inputDigest||r.sourceCommit!==request.commit||r.workflowDigest!==request.workflowDigest||r.candidateDigest!==verified.candidateDigest||r.requirementsDigest!==proof.requirementsDigest)reject('CI_CAPTURE_REPORT_MISMATCH','Acceptance report differs from original request/source/candidate requirements',409);
    if(!/^[1-9][0-9]{0,19}$/.test(string(r.producerJobId,20)))reject('CI_CAPTURE_REPORT_INVALID','Exact producer job identifier required',409);
    if(!Array.isArray(r.cases)||!r.cases.length||r.cases.length>64)reject('CI_CAPTURE_REPORT_INVALID','A bounded nonempty observed case set is required',409);
    const ids=new Set<string>(),paths=new Set<string>();
    const cases=r.cases.map(raw=>{
      const c=record(raw);exact(c,['caseId','outcome','rawReceipt']);const caseId=string(c.caseId,256);
      if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(caseId)||ids.has(caseId)||!['PASS','FAIL','NOT_RUN','CANCELLED','UNKNOWN','SKIPPED'].includes(String(c.outcome)))reject('CI_CAPTURE_REPORT_INVALID','Duplicate case or unsupported raw outcome',409);
      ids.add(caseId);const rawReceipt=file(c.rawReceipt);if(paths.has(rawReceipt.path))reject('CI_CAPTURE_REPORT_INVALID','Each observed case requires its distinct original receipt',409);paths.add(rawReceipt.path);
      return{caseId,observedOutcome:c.outcome as CiAcceptanceReportCapture['cases'][number]['observedOutcome'],rawReceipt};
    });
    // The report may identify a file, but the expected Git object comes only
    // from the original protected plan's authenticated source inventory.
    const tree=proof.sourceTree,treeValid=!!tree&&tree.commit===request.commit&&tree.provider===archive.provider&&tree.repositoryId===archive.repositoryId&&tree.projectId===request.projectId&&tree.bindingDigest===request.bindingDigest&&tree.inventoryDigest===valueDigest(tree.entries)&&tree.contentRead===false&&tree.sourceApproved===false;
    const source=(value:unknown,workflow:boolean):boolean=>{
      const s=record(value);exact(s,['sourcePath','file']);const sourcePath=artifactPath(s.sourcePath),pin=file(s.file),raw=files.get(pin.path)!;
      if(paths.has(pin.path))reject('CI_CAPTURE_REPORT_INVALID','Collector proof cannot replace a case receipt',409);paths.add(pin.path);
      const entry=treeValid?tree!.entries.find(e=>e.path===sourcePath):undefined;
      return !!entry&&entry.type==='blob'&&['100644','100755'].includes(entry.mode)&&entry.objectId===createHash('sha1').update(Buffer.from('blob '+raw.length+'\0')).update(raw).digest('hex')&&(!workflow||sourcePath===proof.workflowPath&&pin.digest===request.workflowDigest);
    };
    const workflow=source(r.workflow,true),collector=source(r.collector,false),run=proof.run;
    const sameRun=run.requestId===request.requestId&&run.inputDigest===request.inputDigest&&run.provider===archive.provider&&run.repositoryId===archive.repositoryId&&run.commit===request.commit&&run.runId===archive.runId;
    const matching=run.jobs.filter(j=>j.jobId===r.producerJobId&&j.provider===archive.provider&&j.repositoryId===archive.repositoryId&&j.projectId===request.projectId&&j.runId===archive.runId&&j.commit===request.commit);
    const producer=sameRun&&matching.length===1&&(archive.provider==='github'?archive.jobId===null&&run.jobs.length===1:archive.jobId===r.producerJobId&&archive.artifactId===r.producerJobId);
    return{status:'OBSERVED',reasons:[...(!producer?['PRODUCER_JOB_UNVERIFIED']:[]),...(!workflow?['WORKFLOW_SOURCE_UNVERIFIED']:[]),...(!collector?['COLLECTOR_SOURCE_UNVERIFIED']:[]),'COLLECTOR_SEMANTIC_APPROVAL_UNKNOWN','CASE_CATALOG_UNKNOWN'],report:capture.report,producerJobId:producer?String(r.producerJobId):null,producerBinding:producer?'MATCHED_ORIGINAL_JOB':'UNVERIFIED',workflowSource:workflow?'COMMITTED_BYTES_MATCHED':'UNVERIFIED',collectorSource:collector?'COMMITTED_BYTES_MATCHED':'UNVERIFIED',collectorSemanticApproval:'UNKNOWN',caseCatalog:'UNKNOWN',cases};
  }catch(error){
    signal.throwIfAborted();capture.reasons=[error instanceof ServiceError&&error.code.startsWith('CI_CAPTURE_')?error.code:'CI_CAPTURE_REPORT_INVALID'];return capture;
  }
}
export const ciSourceDigest=(request:PlatformRunRequest,provider:string,repositoryId:string):string=>valueDigest({provider,repositoryId,commit:request.commit});
export const ciBuildDigest=(request:PlatformRunRequest,runId:string):string=>valueDigest({requestId:request.requestId,inputDigest:request.inputDigest,bindingDigest:request.bindingDigest,workflowDigest:request.workflowDigest,runId});
/** The CI contract is evidence from the exact workflow, not a generic client
 * PASS endpoint. Owner evaluations and release authority are separate checks. */
export async function verifyCiArtifact(archive:PlatformArtifactArchive,request:PlatformRunRequest,expectedChecks:readonly string[],signal:AbortSignal):Promise<VerifiedCiArtifact>{
  if(archive.requestId!==request.requestId||archive.inputDigest!==request.inputDigest||archive.bindingDigest!==request.bindingDigest||archive.commit!==request.commit||archive.name!=='runtime-ci'||archive.archiveDigest!==byteDigest(archive.bytes)||archive.archiveBytes!==archive.bytes.length)reject('CI_ARTIFACT_MISMATCH','Archive does not match the original request and downloaded bytes',409);
  if(expectedChecks.length>128||new Set(expectedChecks).size!==expectedChecks.length||expectedChecks.some(id=>typeof id!=='string'||!id.length))reject('CI_CHECK_SCOPE','Expected checks must be a fixed unique set',409);
  const files=await readArtifactArchive(archive.bytes,signal),resultBytes=files.get('runtime-result.json');
  if(!resultBytes||resultBytes.length>2097152)reject('CI_RESULT_MISSING','Bounded runtime-result.json is required at archive root',409);
  let result:Record<string,unknown>;try{result=record(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(resultBytes)));}catch{return reject('CI_RESULT_INVALID','CI result must be valid UTF-8 JSON',409);}
  exact(result,['schema','requestId','inputDigest','provider','repositoryId','runId','sourceCommit','workflowDigest','stageId','candidateDigest','checks'],['candidate','candidateConsumption','preparationOutput']);
  if(result.schema!=='runtime-ci/v1'||result.requestId!==request.requestId||result.inputDigest!==request.inputDigest||result.provider!==archive.provider||result.repositoryId!==archive.repositoryId||result.runId!==archive.runId||result.sourceCommit!==request.commit||result.workflowDigest!==request.workflowDigest||result.stageId!==request.stageId||result.candidateDigest!==request.candidateDigest)reject('CI_RESULT_MISMATCH','CI evidence belongs to different request/source/stage/candidate pins',409);
  if(containsInlineSecret(canonical(result)))reject('CI_RESULT_INVALID','CI result metadata contains inline credentials',409);
  if(!Array.isArray(result.checks)||result.checks.length>128)reject('CI_CHECK_SCOPE','CI result check set must be bounded',409);
  const declared=new Set<string>(['runtime-result.json']),ids=new Set<string>();
  const verifyFile=(raw:unknown):CiEvidenceFile=>{const f=record(raw);exact(f,['path','digest','bytes']);const path=artifactPath(f.path),bytes=files.get(path);if(!bytes||!Number.isSafeInteger(f.bytes)||f.bytes!==bytes.length||hash(f.digest)!==byteDigest(bytes))reject('CI_ARTIFACT_INTEGRITY','Required artifact content differs or is missing',409);declared.add(path);return{path,digest:String(f.digest),bytes:Number(f.bytes)};};
  const checks:CiArtifactCheck[]=result.checks.map(raw=>{const c=record(raw);exact(c,['id','status','evidence']);const id=string(c.id,256);if(ids.has(id)||!expectedChecks.includes(id)||!['PASS','FAIL','UNKNOWN'].includes(String(c.status))||!Array.isArray(c.evidence)||!c.evidence.length||c.evidence.length>64)reject('CI_CHECK_SCOPE','CI evidence contains duplicate, unexpected or unsupported checks',409);ids.add(id);return{id,status:c.status as CiArtifactCheck['status'],evidence:c.evidence.map(verifyFile)};});
  if(ids.size!==expectedChecks.length)reject('CI_CHECK_SCOPE','CI result omits a fixed required check',409);
  let candidate:CandidateManifest|null=null,newDigest:string|null=request.candidateDigest;
  if(result.candidate!==undefined){
    if(request.stageId!=='candidate'||request.candidateDigest!==null)reject('CI_CANDIDATE_MUTATION','Only candidate creation may introduce a candidate manifest',409);
    candidate=result.candidate as CandidateManifest;newDigest=candidateDigest(candidate);
    if(candidate.sourceDigest!==ciSourceDigest(request,archive.provider,archive.repositoryId)||candidate.buildDigest!==ciBuildDigest(request,archive.runId))reject('CI_CANDIDATE_MISMATCH','Candidate source/build identities differ from the actual CI request',409);
    for(const item of candidate.artifacts)verifyFile({path:'artifacts/'+item.name,digest:item.digest,bytes:item.bytes});
  }else if(request.stageId==='candidate')reject('CI_CANDIDATE_MISSING','Candidate stage needs its exact built artifact manifest',409);
  if(request.candidateDigest!==null){
    if(!request.candidateInput)reject('CI_CANDIDATE_INPUT_REQUIRED','Verification needs the original candidate archive, not only its digest',409);
    const input=validateCandidateInput(request.candidateInput,request,archive.provider,archive.repositoryId),consumed=record(result.candidateConsumption??{});
    exact(consumed,['inputDigest','artifacts']);
    if(consumed.inputDigest!==valueDigest(input)||canonical(consumed.artifacts)!==canonical(input.manifest.artifacts))reject('CI_CANDIDATE_CONSUMPTION','Evidence must identify every consumed artifact from the original candidate',409);
    for(const item of input.manifest.artifacts)verifyFile({path:'candidate/'+item.name,digest:item.digest,bytes:item.bytes});
  }else if(result.candidateConsumption!==undefined||request.candidateInput!==undefined)reject('CI_CANDIDATE_CONSUMPTION','A pre-candidate stage cannot claim candidate consumption',409);
  let preparationOutput:CiPreparationOutput|undefined;
  if(request.preparationInput){
    validatePreparationInput(request.preparationInput,request,archive.provider);
    preparationOutput=validatePreparationOutput(result.preparationOutput as CiPreparationOutput,request.preparationInput,archive.provider);
    for(const file of preparationOutput.source.artifacts)verifyFile({...file,path:'prepared-source/'+file.path});
  }else if(result.preparationOutput!==undefined)reject('CI_PREPARATION_OUTPUT','A non-preparation request cannot introduce a source output',409);
  for(const path of files.keys())if(!declared.has(path))reject('CI_ARTIFACT_UNDECLARED','CI archive includes undeclared files',409);
  const status=archive.runStatus==='FAILED'||checks.some(c=>c.status==='FAIL')?'FAILED':archive.runStatus==='PASSED'&&checks.every(c=>c.status==='PASS')?'PASSED':'UNKNOWN';
  const sourceArchive:CandidateArchiveIdentity={provider:archive.provider,repositoryId:archive.repositoryId,runId:archive.runId,artifactId:archive.artifactId,jobId:archive.jobId,archiveDigest:archive.archiveDigest,archiveBytes:archive.archiveBytes};
  return{schema:'runtime-ci-verified-artifact/v1',requestId:request.requestId,inputDigest:request.inputDigest,runId:archive.runId,archiveDigest:archive.archiveDigest,resultDigest:byteDigest(resultBytes),evidenceRef:archive.evidenceRef,status,checks,candidate,candidateDigest:newDigest,files:[...files].map(([path,bytes])=>({path,digest:byteDigest(bytes),bytes:bytes.length})),artifactsVerified:true,ownerEvaluationsVerified:false,lifecycleAcceptance:false,sourceArchive,...(preparationOutput?{preparationOutput}:{})};
}
