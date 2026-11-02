import {createHash} from 'node:crypto';
import {constants,closeSync,fstatSync,fsyncSync,lstatSync,mkdirSync,openSync,readSync,readdirSync,realpathSync,writeFileSync,writeSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {canonical,reject,ServiceError,string} from '../server/errors.js';
import {byteDigest,valueDigest} from '../lifecycle/base.js';
import {containsInlineSecret} from '../lifecycle/compiler.js';
import {MAX_ARCHIVE_BYTES} from './artifacts.js';

export interface ClosureArchiveInput {
  workspaceId:string;projectId:string;instanceId:string;requestDigest:string;
  content:Record<string,unknown>;artifacts:{name:string;sourcePath:string;digest:string;bytes:number}[];
  documents?:{name:string;content:Record<string,unknown>}[];
}
export interface ClosureArchiveObservation {schema:'runtime-closure-archive-observation/v1';directory:string;specificationDigest:string;status:'ABSENT'|'PARTIAL'|'MISMATCH'|'COMPLETE';reasons:string[];factsDigest:string;}
interface Specification {schema:'runtime-closure-archive/v1';workspaceId:string;projectId:string;instanceId:string;requestDigest:string;files:{name:string;digest:string;bytes:number}[];}
const hash=(v:unknown)=>{const s=string(v,71);if(!/^sha256:[a-f0-9]{64}$/.test(s))reject('CLOSURE_ARCHIVE_INPUT','Exact archive digest required',409);return s;};
const missing=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';
function safeDirectory(path:string,privateMode=false):void{
  const s=lstatSync(path);if(!isAbsolute(path)||resolve(path)!==path||realpathSync(path)!==path||!s.isDirectory()||s.uid!==process.getuid?.()||(s.mode&(privateMode?0o077:0o022))!==0)reject('CLOSURE_ARCHIVE_SCOPE','Archive directories must be canonical and owned with safe permissions',409);
}
function prepared(root:string,input:ClosureArchiveInput){
  string(root,4096);safeDirectory(root);for(const k of ['workspaceId','projectId','instanceId'] as const)string(input[k],256);hash(input.requestDigest);
  const content=Buffer.from(canonical(input.content)+'\n');if(content.length>16777216||containsInlineSecret(content.toString('utf8'))||!Array.isArray(input.artifacts)||input.artifacts.length>32)reject('CLOSURE_ARCHIVE_INPUT','Closure evidence exceeds its bounded private archive profile',409);
  if(input.documents!==undefined&&(!Array.isArray(input.documents)||input.documents.length>128))reject('CLOSURE_ARCHIVE_INPUT','Archive document inventory exceeds its bound',409);
  const names=new Set<string>(['manifest.json','evidence.json','seal.json']);let total=content.length;
  const documents=(input.documents??[]).map(d=>{
    if(!/^[a-z0-9][a-z0-9._-]{0,100}\.json$/.test(d.name)||names.has(d.name))reject('CLOSURE_ARCHIVE_INPUT','Use unique exact archive document names',409);names.add(d.name);
    const bytes=Buffer.from(canonical(d.content)+'\n');if(bytes.length>16777216||(total+=bytes.length)>1073741824||containsInlineSecret(bytes.toString('utf8')))reject('CLOSURE_ARCHIVE_INPUT','Archive document exceeds its private evidence bounds',409);return{name:d.name,bytes};
  });
  for(const a of input.artifacts){
    if(!/^[a-z0-9][a-z0-9._-]{0,100}\.zip$/.test(a.name)||names.has(a.name)||!isAbsolute(a.sourcePath)||resolve(a.sourcePath)!==a.sourcePath||!Number.isSafeInteger(a.bytes)||a.bytes<22||a.bytes>MAX_ARCHIVE_BYTES||(total+=a.bytes)>1073741824)reject('CLOSURE_ARCHIVE_INPUT','Use unique bounded original CI archive files',409);names.add(a.name);hash(a.digest);
  }
  const files=[{name:'evidence.json',digest:byteDigest(content),bytes:content.length},...documents.map(d=>({name:d.name,digest:byteDigest(d.bytes),bytes:d.bytes.length})),...input.artifacts.map(a=>({name:a.name,digest:a.digest,bytes:a.bytes}))].sort((a,b)=>a.name.localeCompare(b.name));
  const spec:Specification={schema:'runtime-closure-archive/v1',workspaceId:input.workspaceId,projectId:input.projectId,instanceId:input.instanceId,requestDigest:input.requestDigest,files},specificationDigest=valueDigest(spec),manifest=Buffer.from(canonical(spec)+'\n'),seal=Buffer.from(canonical({schema:'runtime-closure-archive-seal/v1',specificationDigest})+'\n');
  const directory=join(root,'runtime-closure-'+valueDigest({workspaceId:input.workspaceId,projectId:input.projectId,requestDigest:input.requestDigest}).slice(7));return{spec,specificationDigest,directory,content,documents,manifest,seal};
}
function readExact(path:string,expected:{digest:string;bytes:number},signal:AbortSignal,deadline:number,copyTo?:number):void{
  signal.throwIfAborted();if(realpathSync(path)!==path)reject('CLOSURE_ARCHIVE_SCOPE','Archive files cannot be symbolic links',409);
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const before=fstatSync(fd);if(!before.isFile()||before.nlink!==1||before.uid!==process.getuid?.()||(before.mode&0o077)!==0||before.size!==expected.bytes)reject('CLOSURE_ARCHIVE_CONTENT','Archive file identity, permissions or size changed',409);
    const h=createHash('sha256'),chunk=Buffer.alloc(Math.min(Math.max(expected.bytes,1),1048576));let total=0;
    for(;;){signal.throwIfAborted();if(Date.now()>deadline)reject('CLOSURE_ARCHIVE_LIMIT','Archive readback exceeded 30 seconds',409);const n=readSync(fd,chunk,0,Math.min(chunk.length,expected.bytes-total+1),null);if(!n)break;total+=n;if(total>expected.bytes)reject('CLOSURE_ARCHIVE_CONTENT','Archive grew during readback',409);h.update(chunk.subarray(0,n));if(copyTo!==undefined){let done=0;while(done<n){const written=writeSync(copyTo,chunk,done,n-done);if(!written)reject('CLOSURE_ARCHIVE_CONTENT','Archive write did not advance',409);done+=written;}}}
    const after=fstatSync(fd),pathState=lstatSync(path);
    if(total!==expected.bytes||'sha256:'+h.digest('hex')!==expected.digest||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||pathState.ino!==after.ino||pathState.dev!==after.dev||realpathSync(path)!==path)reject('CLOSURE_ARCHIVE_CONTENT','Original archive bytes changed during verification',409);
  }finally{closeSync(fd);}
}
function syncDirectory(path:string){const fd=openSync(path,constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}}
/** Passive readback never creates or completes a partial archive. */
export function inspectClosureArchive(root:string,input:ClosureArchiveInput,signal:AbortSignal):ClosureArchiveObservation{
  const p=prepared(root,input),deadline=Date.now()+30000,reasons:string[]=[];
  function result(status:ClosureArchiveObservation['status']){const facts={directory:p.directory,specificationDigest:p.specificationDigest,status,reasons};return{schema:'runtime-closure-archive-observation/v1' as const,...facts,factsDigest:valueDigest(facts)};}
  try{safeDirectory(p.directory,true);}catch(e){if(missing(e))return result('ABSENT');throw e;}
  const expected=[{name:'manifest.json',digest:byteDigest(p.manifest),bytes:p.manifest.length},...p.spec.files,{name:'seal.json',digest:byteDigest(p.seal),bytes:p.seal.length}],names=new Set(expected.map(e=>e.name));
  if(readdirSync(p.directory).some(name=>!names.has(name))){reasons.push('ARCHIVE_EXTRA_FILES');return result('MISMATCH');}
  for(const f of expected)try{readExact(join(p.directory,f.name),f,signal,deadline);}catch(e){if(missing(e)){reasons.push('MISSING:'+f.name);continue;}if(e instanceof ServiceError&&e.code==='CLOSURE_ARCHIVE_CONTENT'){reasons.push('MISMATCH:'+f.name);return result('MISMATCH');}throw e;}
  if(readdirSync(p.directory).some(name=>!names.has(name))){reasons.push('ARCHIVE_EXTRA_FILES');return result('MISMATCH');}
  return result(reasons.length?'PARTIAL':'COMPLETE');
}
/** The closure adapter durably records permission/action before calling this
 * one-shot writer. Existing partial or foreign state is observed, never removed,
 * overwritten or silently restarted. A completed original archive is reusable. */
export function writeClosureArchive(root:string,input:ClosureArchiveInput,signal:AbortSignal):ClosureArchiveObservation{
  const p=prepared(root,input),old=inspectClosureArchive(root,input,signal);if(old.status!=='ABSENT')return old;
  signal.throwIfAborted();mkdirSync(p.directory,{mode:0o700});safeDirectory(p.directory,true);syncDirectory(root);const deadline=Date.now()+30000;
  function write(name:string,bytes:Buffer){signal.throwIfAborted();safeDirectory(p.directory,true);const fd=openSync(join(p.directory,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}
  write('manifest.json',p.manifest);write('evidence.json',p.content);
  for(const d of p.documents)write(d.name,d.bytes);
  for(const a of input.artifacts){signal.throwIfAborted();safeDirectory(p.directory,true);const fd=openSync(join(p.directory,a.name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{readExact(a.sourcePath,a,signal,deadline,fd);fsyncSync(fd);}finally{closeSync(fd);}}
  write('seal.json',p.seal);syncDirectory(p.directory);return inspectClosureArchive(root,input,signal);
}
