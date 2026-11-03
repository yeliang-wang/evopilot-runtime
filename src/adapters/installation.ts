import {createHash} from 'node:crypto';
import {constants,closeSync,fstatSync,lstatSync,openSync,readSync,readdirSync,readlinkSync,realpathSync,type Stats} from 'node:fs';
import {isAbsolute,join,posix,resolve} from 'node:path';
import {exact,record,reject,ServiceError,string,evidenceValueDigest as valueDigest} from '../server/errors.js';
import {byteDigest} from '../lifecycle/base.js';
import {candidateDigest,type CandidateManifest} from '../lifecycle/instance.js';

const MAX_ENTRIES=65536,MAX_FILE_BYTES=128*1024*1024,MAX_TOTAL_BYTES=1024*1024*1024,MAX_MANIFEST_BYTES=8*1024*1024;
export type InstallationEntry={path:string;type:'file';digest:string;bytes:number;executable:boolean}|{path:string;type:'symlink';target:string};
export interface InstallationManifest {schema:'runtime-installation-manifest/v1';version:string;packages:CandidateManifest['artifacts'];entries:InstallationEntry[];}
export interface VerifiedInstallationManifest {schema:'runtime-verified-installation-manifest/v1';candidateDigest:string;artifact:{name:string;digest:string;bytes:number};manifest:InstallationManifest;digest:string;}
export interface InstallationObservation {
  schema:'runtime-installation-observation/v1';directory:string;candidateDigest:string;manifestDigest:string;
  status:'ABSENT'|'PARTIAL'|'MISMATCH'|'PASSED';directoryIdentity:string|null;
  entries:{path:string;status:'PASSED'|'MISSING'|'MISMATCH'|'UNKNOWN';actual:InstallationEntry|null;reason:string|null}[];
  unexpectedPaths:string[];reasons:string[];factsDigest:string;observedAt:string;
  softwareExecuted:false;deploymentAccepted:false;
}
function relativePath(value:unknown):string {
  const p=string(value,1024);
  if(p!==p.normalize('NFC')||p.startsWith('/')||/[\u0000-\u001f\u007f\\]/.test(p)||p.split('/').some(s=>!s||s==='.'||s==='..'||s==='.git'))reject('INSTALLATION_MANIFEST','Installation paths must be canonical and relative',409);
  return p;
}
function linkTarget(path:string,value:unknown):string {
  const target=string(value,1024);
  if(target!==target.normalize('NFC')||target.startsWith('/')||/[\u0000-\u001f\u007f\\]/.test(target)||target.split('/').some(s=>!s||s==='.git'))reject('INSTALLATION_MANIFEST','Installation links must use bounded relative targets',409);
  const destination=posix.normalize(posix.join(posix.dirname(path),target));
  if(destination==='..'||destination.startsWith('../')||destination==='.')reject('INSTALLATION_MANIFEST','Installation link escapes its package tree',409);relativePath(destination);return destination;
}
function validateManifest(value:unknown):InstallationManifest {
  const m=record(value);exact(m,['schema','version','packages','entries']);
  if(m.schema!=='runtime-installation-manifest/v1'||!Array.isArray(m.packages)||!m.packages.length||m.packages.length>64||!Array.isArray(m.entries)||!m.entries.length||m.entries.length>MAX_ENTRIES)reject('INSTALLATION_MANIFEST','A bounded nonempty package and installed-file inventory is required',409);
  string(m.version,128);const packages=new Set<string>();
  for(const raw of m.packages){const p=record(raw);exact(p,['name','digest','bytes']);if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(string(p.name,128))||packages.has(String(p.name))||!/^sha256:[a-f0-9]{64}$/.test(string(p.digest,71))||!Number.isSafeInteger(p.bytes)||Number(p.bytes)<1||Number(p.bytes)>MAX_FILE_BYTES)reject('INSTALLATION_MANIFEST','Package inventory must contain unique exact bounded artifacts',409);packages.add(String(p.name));}
  const entries=new Map<string,InstallationEntry>(),portable=new Set<string>();let total=0;
  for(const raw of m.entries){
    const e=record(raw),path=relativePath(e.path),key=path.toLowerCase();if(entries.has(path)||portable.has(key))reject('INSTALLATION_MANIFEST','Installed paths must be unique on supported hosts',409);portable.add(key);
    if(e.type==='file'){
      exact(e,['path','type','digest','bytes','executable']);if(!/^sha256:[a-f0-9]{64}$/.test(string(e.digest,71))||!Number.isSafeInteger(e.bytes)||Number(e.bytes)<0||Number(e.bytes)>MAX_FILE_BYTES||(total+=Number(e.bytes))>MAX_TOTAL_BYTES||typeof e.executable!=='boolean')reject('INSTALLATION_MANIFEST','Installed file metadata exceeds the supported exact profile',409);
    }else if(e.type==='symlink'){exact(e,['path','type','target']);linkTarget(path,e.target);}else reject('INSTALLATION_MANIFEST','Only regular installed files and internal symbolic links are supported',409);
    entries.set(path,e as unknown as InstallationEntry);
  }
  const directories=new Set<string>(),portableDirectories=new Map<string,string>();for(const path of entries.keys())for(let p=posix.dirname(path);p!=='.';p=posix.dirname(p)){
    if(entries.has(p)||portable.has(p.toLowerCase())||portableDirectories.has(p.toLowerCase())&&portableDirectories.get(p.toLowerCase())!==p)reject('INSTALLATION_MANIFEST','An inventory ancestor must be one unambiguous directory',409);directories.add(p);portableDirectories.set(p.toLowerCase(),p);
  }
  // Resolve links through both explicit entries and implicit directories. No
  // dangling target, circular chain or hidden linked ancestor is accepted.
  for(const entry of entries.values())if(entry.type==='symlink'){
    const seen=new Set<string>([entry.path]);let target=linkTarget(entry.path,entry.target),steps=0;
    for(;;){
      if(++steps>64)reject('INSTALLATION_MANIFEST','Symbolic link resolution exceeds its bound',409);
      const parts=target.split('/');let changed=false;
      for(let n=1;n<=parts.length;n++){
        const prefix=parts.slice(0,n).join('/'),next=entries.get(prefix);
        if(next?.type==='symlink'){
          if(seen.has(prefix))reject('INSTALLATION_MANIFEST','Circular installation link',409);seen.add(prefix);
          target=posix.normalize(posix.join(linkTarget(prefix,next.target),...parts.slice(n)));relativePath(target);changed=true;break;
        }
        if(next?.type==='file'&&n<parts.length)reject('INSTALLATION_MANIFEST','Installation link traverses a regular file',409);
      }
      if(changed)continue;
      if(!entries.has(target)&&!directories.has(target))reject('INSTALLATION_MANIFEST','Installation link target is absent from its exact inventory',409);break;
    }
  }
  return JSON.parse(JSON.stringify(value)) as InstallationManifest;
}
/** The manifest is itself an artifact of the already fixed candidate. Its
 * package references must match that candidate; caller-provided expected hashes
 * cannot bless arbitrary installed files. This function performs no install. */
export function readInstallationManifest(candidate:CandidateManifest,artifactName:string,bytes:Buffer):VerifiedInstallationManifest {
  const digest=candidateDigest(candidate),artifact=candidate.artifacts.find(a=>a.name===artifactName);
  if(!artifact||bytes.length>MAX_MANIFEST_BYTES||artifact.bytes!==bytes.length||artifact.digest!==byteDigest(bytes))reject('INSTALLATION_CANDIDATE','Installation manifest must match its exact candidate artifact bytes',409);
  let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return reject('INSTALLATION_MANIFEST','Installation manifest must be bounded UTF-8 JSON',409);}
  const manifest=validateManifest(raw);
  if(manifest.version!==candidate.version||manifest.packages.some(p=>p.name===artifactName||!candidate.artifacts.some(a=>a.name===p.name&&a.digest===p.digest&&a.bytes===p.bytes)))reject('INSTALLATION_CANDIDATE','Installed layout must refer to this candidate version and original packages',409);
  const body={schema:'runtime-verified-installation-manifest/v1' as const,candidateDigest:digest,artifact,manifest};return{...body,digest:valueDigest(body)};
}
const identity=(s:Stats)=>({device:s.dev,inode:s.ino,uid:s.uid,mode:s.mode,links:s.nlink,size:s.size,mtime:s.mtimeMs,ctime:s.ctimeMs});
const same=(a:unknown,b:unknown)=>valueDigest(a)===valueDigest(b);
function missing(e:unknown):boolean{return(e as NodeJS.ErrnoException)?.code==='ENOENT';}
/** Read-only filesystem verification. The caller binds this directory in the
 * protected project configuration. No command, file write or package extraction
 * occurs, and this observation alone cannot establish deployment acceptance. */
export function observeInstallation(directory:string,verified:VerifiedInstallationManifest,signal:AbortSignal):InstallationObservation {
  const {digest,...body}=verified;
  if(verified.schema!=='runtime-verified-installation-manifest/v1'||digest!==valueDigest(body))reject('INSTALLATION_CANDIDATE','Verified installation manifest changed',409);
  const manifest=validateManifest(verified.manifest);string(directory,4096);
  if(!isAbsolute(directory)||resolve(directory)!==directory)reject('INSTALLATION_SCOPE','Installed directory must be an exact canonical absolute path',409);
  const deadline=Date.now()+15000,entries:InstallationObservation['entries']=[],reasons:string[]=[],unexpectedPaths:string[]=[];let directoryIdentity:string|null=null;
  function bounded(){signal.throwIfAborted();if(Date.now()>deadline)reject('INSTALLATION_READ_LIMIT','Installation readback exceeded 15 seconds',409);}
  function result(status:InstallationObservation['status']):InstallationObservation {
    const facts={directory,candidateDigest:verified.candidateDigest,manifestDigest:verified.digest,status,directoryIdentity,entries,unexpectedPaths,reasons};
    return{schema:'runtime-installation-observation/v1',...facts,factsDigest:valueDigest(facts),observedAt:new Date().toISOString(),softwareExecuted:false,deploymentAccepted:false};
  }
  function scan():Map<string,{stat:Stats;target:string|null}> {
    const found=new Map<string,{stat:Stats;target:string|null}>(),pending=[''];let visited=0;
    while(pending.length){bounded();const rel=pending.pop()!,path=rel?join(directory,rel):directory,stat=lstatSync(path);
      if(!stat.isDirectory()||realpathSync(path)!==path||stat.uid!==process.getuid?.()||(stat.mode&0o022)!==0)reject('INSTALLATION_SCOPE','Installed directories must be owned canonical directories',409);
      if(++visited>MAX_ENTRIES)reject('INSTALLATION_READ_LIMIT','Installed directory inventory exceeds its bound',409);
      found.set(rel,{stat,target:null});const children=readdirSync(path);if(children.length>MAX_ENTRIES)reject('INSTALLATION_READ_LIMIT','Installed directory exceeds its entry bound',409);
      for(const child of children.sort()){
        bounded();const name=rel?rel+'/'+child:child;relativePath(name);const file=join(directory,name),s=lstatSync(file);
        if(s.isDirectory())pending.push(name);else{if(found.size>=MAX_ENTRIES)reject('INSTALLATION_READ_LIMIT','Installed file inventory exceeds its bound',409);found.set(name,{stat:s,target:s.isSymbolicLink()?readlinkSync(file):null});}
      }
      if(!same(identity(stat),identity(lstatSync(path)))||realpathSync(path)!==path)reject('INSTALLATION_CHANGED','Installation directory changed during enumeration',409);
    }
    return found;
  }
  let before:ReturnType<typeof scan>;
  try{bounded();const root=lstatSync(directory);directoryIdentity=valueDigest({device:root.dev,inode:root.ino,uid:root.uid});before=scan();}
  catch(e){if(missing(e)){reasons.push('INSTALLATION_MISSING');return result(directoryIdentity?'PARTIAL':'ABSENT');}throw e;}
  const expected=new Set(manifest.entries.map(e=>e.path));for(const[path,value]of before)if(path&&!value.stat.isDirectory()&&!expected.has(path))unexpectedPaths.push(path);unexpectedPaths.sort();
  if(unexpectedPaths.length)reasons.push('INSTALLATION_EXTRA_FILES');
  for(const entry of manifest.entries){
    bounded();const actual=before.get(entry.path),fact:InstallationObservation['entries'][number]={path:entry.path,status:'UNKNOWN',actual:null,reason:null};entries.push(fact);
    if(!actual){fact.status='MISSING';fact.reason='INSTALLATION_MISSING';continue;}
    const path=join(directory,entry.path);
    try{
      if(actual.stat.uid!==process.getuid?.())reject('INSTALLATION_SCOPE','Installed entry owner differs',409);
      if(entry.type==='symlink'){
        if(!actual.stat.isSymbolicLink()||actual.target!==entry.target)reject('INSTALLATION_TYPE','Installed symbolic link differs',409);
        const resolved=realpathSync(path);if(!resolved.startsWith(directory+'/'))reject('INSTALLATION_SCOPE','Installed symbolic link leaves its package tree',409);
        fact.actual={...entry,target:actual.target};
      }else{
        if(!actual.stat.isFile()||actual.stat.nlink!==1||actual.stat.size!==entry.bytes||(actual.stat.mode&0o022)!==0||Boolean(actual.stat.mode&0o111)!==entry.executable||realpathSync(path)!==path)reject('INSTALLATION_TYPE','Installed file type, size or permissions differ',409);
        const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
        try{
          const start=fstatSync(fd);if(!same(identity(start),identity(actual.stat)))reject('INSTALLATION_CHANGED','Installed file changed before its read',409);
          const h=createHash('sha256'),chunk=Buffer.alloc(Math.min(Math.max(entry.bytes,1),1024*1024));let length=0;
          for(;;){bounded();const n=readSync(fd,chunk,0,Math.min(chunk.length,entry.bytes-length+1),null);if(!n)break;length+=n;if(length>entry.bytes)reject('INSTALLATION_CHANGED','Installed file grew during its read',409);h.update(chunk.subarray(0,n));}
          fact.actual={path:entry.path,type:'file',bytes:length,digest:'sha256:'+h.digest('hex'),executable:Boolean(start.mode&0o111)};
          if(!same(identity(start),identity(fstatSync(fd)))||realpathSync(path)!==path||!same(entry,fact.actual))reject('INSTALLATION_CONTENT','Installed bytes differ from the exact candidate layout',409);
        }finally{closeSync(fd);}
      }
      fact.status='PASSED';
    }catch(e){fact.reason=e instanceof ServiceError?e.code:missing(e)?'INSTALLATION_MISSING':'INSTALLATION_UNAVAILABLE';fact.status=fact.reason==='INSTALLATION_MISSING'?'MISSING':fact.reason==='INSTALLATION_UNAVAILABLE'?'UNKNOWN':'MISMATCH';}
  }
  try{const after=scan();const snapshot=(m:ReturnType<typeof scan>)=>[...m].sort(([a],[b])=>a.localeCompare(b)).map(([path,v])=>({path,stat:identity(v.stat),target:v.target}));if(!same(snapshot(before),snapshot(after)))reject('INSTALLATION_CHANGED','Installed tree changed during readback',409);}
  catch(e){reasons.push(e instanceof ServiceError?e.code:missing(e)?'INSTALLATION_CHANGED':'INSTALLATION_UNAVAILABLE');}
  return result(unexpectedPaths.length||entries.some(e=>e.status==='MISMATCH')||reasons.includes('INSTALLATION_CHANGED')?'MISMATCH':reasons.length||entries.some(e=>e.status!=='PASSED')?'PARTIAL':'PASSED');
}
