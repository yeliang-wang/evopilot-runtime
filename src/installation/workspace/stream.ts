/** Bounded same-host file operations. No link is traversed while copying. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalPath,fail} from '../../compat/project/files.js';

export const MAINTENANCE_BUDGET=Object.freeze({entries:128000,rootBytes:8*1024**3,fileBytes:2*1024**3,chunkBytes:4*1024**2});
export interface MaintenanceEntry {path:string;kind:'file'|'directory'|'symlink';bytes:number;sha256:string;mode?:number;target?:string}
const hashBuffer=Buffer.allocUnsafe(MAINTENANCE_BUDGET.chunkBytes);
// These synchronous operations never overlap; reuse bounded buffers across large trees.
const copyBuffer=Buffer.allocUnsafe(MAINTENANCE_BUDGET.chunkBytes),comparisonBuffer=Buffer.allocUnsafe(MAINTENANCE_BUDGET.chunkBytes);
function sameFile(a:fs.Stats,b:fs.Stats){return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;}
function regular(filename:string){canonicalPath(filename);const s=fs.lstatSync(filename);if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid?.()||(s.mode&0o022))fail('MAINTENANCE_PERMISSIONS');if(s.size>MAINTENANCE_BUDGET.fileBytes)fail('MAINTENANCE_LIMIT');return s;}
function openRead(filename:string){const before=regular(filename),fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);if(!sameFile(before,fs.fstatSync(fd))){fs.closeSync(fd);fail('MAINTENANCE_DRIFT');}return{fd,before};}
export function hashMaintenanceFile(filename:string):{bytes:number;sha256:string;mode:number}{
  const {fd,before}=openRead(filename),buffer=hashBuffer,hash=createHash('sha256');let bytes=0;
  try{let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0){bytes+=n;if(bytes>MAINTENANCE_BUDGET.fileBytes)fail('MAINTENANCE_LIMIT');hash.update(buffer.subarray(0,n));}if(bytes!==before.size||!sameFile(before,fs.fstatSync(fd))||!sameFile(before,regular(filename)))fail('MAINTENANCE_DRIFT');}
  finally{fs.closeSync(fd);}return{bytes,sha256:hash.digest('hex'),mode:before.mode&0o777};
}
export function inspectMaintenanceTree(root:string,legacy=false):MaintenanceEntry[]{
  canonicalPath(root);const rootStat=fs.lstatSync(root);if(!rootStat.isDirectory()||rootStat.uid!==process.getuid?.()||(rootStat.mode&0o777)!==0o700)fail('MAINTENANCE_PERMISSIONS');
  let total=0;const entries:MaintenanceEntry[]=[];
  function visit(directory:string,depth:number){if(depth>64)fail('MAINTENANCE_LIMIT');for(const name of fs.readdirSync(directory).sort()){
    const filename=path.join(directory,name),relative=path.relative(root,filename);if(!name||name==='.'||name==='..'||name.includes('\\'))fail('MAINTENANCE_PATH');
    if(entries.length>=MAINTENANCE_BUDGET.entries)fail('MAINTENANCE_LIMIT');const st=fs.lstatSync(filename);if(st.uid!==process.getuid?.())fail('MAINTENANCE_PERMISSIONS');
    if(st.isSymbolicLink()){
      if(legacy)fail('MAINTENANCE_PERMISSIONS');const target=fs.readlinkSync(filename);if(!target||path.isAbsolute(target)||target.includes('\\'))fail('MAINTENANCE_LINK');
      const lexical=path.resolve(path.dirname(filename),target);if(lexical!==root&&!lexical.startsWith(root+path.sep))fail('MAINTENANCE_LINK');
      let resolved;try{resolved=fs.realpathSync(filename);}catch{fail('MAINTENANCE_LINK');}if(resolved!==root&&!resolved.startsWith(root+path.sep))fail('MAINTENANCE_LINK');
      if((total+=Buffer.byteLength(target))>MAINTENANCE_BUDGET.rootBytes)fail('MAINTENANCE_LIMIT');
      entries.push({path:relative,kind:'symlink',bytes:Buffer.byteLength(target),sha256:createHash('sha256').update(target).digest('hex'),target});continue;
    }
    canonicalPath(filename);if(st.mode&0o022)fail('MAINTENANCE_PERMISSIONS');
    if(st.isDirectory()){entries.push({path:relative,kind:'directory',bytes:0,sha256:'',...(!legacy?{mode:st.mode&0o777}:{})});visit(filename,depth+1);}
    else{if(!st.isFile()||st.nlink!==1||(total+=st.size)>MAINTENANCE_BUDGET.rootBytes)fail('MAINTENANCE_LIMIT');const file=hashMaintenanceFile(filename);entries.push({path:relative,kind:'file',bytes:file.bytes,sha256:file.sha256,...(!legacy?{mode:file.mode}:{})});}
  }}visit(root,0);return entries.sort((a,b)=>a.path.localeCompare(b.path));
}
/** Validate the exact persisted prefix, then resume in chunks. Source is rehashed after transfer. */
export function copyMaintenanceFile(from:string,partial:string,entry:MaintenanceEntry):void{
  const source=openRead(from),buffer=copyBuffer,comparison=comparisonBuffer;let target:number|undefined;
  try{
    if(source.before.size!==entry.bytes)fail('MAINTENANCE_DRIFT');let offset=0;
    if(fs.existsSync(partial)){
      const prev=openRead(partial);try{if(prev.before.size>entry.bytes)fail('MAINTENANCE_PARTIAL_CONFLICT');let n;while((n=fs.readSync(prev.fd,comparison,0,comparison.length,null))>0){if(fs.readSync(source.fd,buffer,0,n,offset)!==n||!buffer.subarray(0,n).equals(comparison.subarray(0,n)))fail('MAINTENANCE_PARTIAL_CONFLICT');offset+=n;}if(!sameFile(prev.before,fs.fstatSync(prev.fd)))fail('MAINTENANCE_PARTIAL_CONFLICT');
        if(offset===entry.bytes){
          const actual=hashMaintenanceFile(partial);
          if(actual.sha256!==entry.sha256||!sameFile(source.before,fs.fstatSync(source.fd))||!sameFile(source.before,regular(from)))fail('MAINTENANCE_PARTIAL_CONFLICT');
          // A fully copied read-only asset may remain in staging after a crash.
          // Its verified bytes need no writable reopen to finish the rename.
          fs.fchmodSync(prev.fd,entry.mode??0o600);fs.fsyncSync(prev.fd);return;
        }
      }finally{fs.closeSync(prev.fd);}
      target=fs.openSync(partial,fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW);if(!sameFile(prev.before,fs.fstatSync(target))||!sameFile(prev.before,regular(partial)))fail('MAINTENANCE_PARTIAL_CONFLICT');
    }else target=fs.openSync(partial,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    while(offset<entry.bytes){const n=fs.readSync(source.fd,buffer,0,Math.min(buffer.length,entry.bytes-offset),offset);if(!n)fail('MAINTENANCE_DRIFT');let done=0;while(done<n){const written=fs.writeSync(target,buffer,done,n-done,offset+done);if(!written)fail('MAINTENANCE_COPY_FAILED');done+=written;}offset+=n;}
    fs.fchmodSync(target,entry.mode??0o600);fs.fsyncSync(target);fs.closeSync(target);target=undefined;
    if(!sameFile(source.before,fs.fstatSync(source.fd))||!sameFile(source.before,regular(from)))fail('MAINTENANCE_DRIFT');
    const actual=hashMaintenanceFile(partial);if(actual.bytes!==entry.bytes||actual.sha256!==entry.sha256)fail('MAINTENANCE_PARTIAL_CONFLICT');
  }finally{if(target!==undefined)fs.closeSync(target);fs.closeSync(source.fd);}
}

/** Byte-compatible with canonicalJSON, without recursively cloning the complete manifest. */
export function* maintenanceJSONChunks(value:unknown,depth=0):Generator<string> {
 if(depth>64)fail('MAINTENANCE_LIMIT');
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)){yield JSON.stringify(value);return;}
 if(Array.isArray(value)){yield '[';for(let i=0;i<value.length;i++){if(i)yield ',';yield* maintenanceJSONChunks(value[i],depth+1);}yield ']';return;}
 if(value&&typeof value==='object'&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null)){
  // JSON.stringify enumerates array-index object keys numerically even after a
  // lexical insertion sort. Match the existing canonical format exactly.
  const integer=(k:string)=>String(Number(k))===k&&Number.isInteger(Number(k))&&Number(k)>=0&&Number(k)<4294967295;
  const keys=Object.keys(value).sort((a,b)=>integer(a)&&integer(b)?Number(a)-Number(b):integer(a)?-1:integer(b)?1:a<b?-1:a>b?1:0);
  yield '{';for(let i=0;i<keys.length;i++){if(i)yield ',';const key=keys[i];yield JSON.stringify(key)+':';yield* maintenanceJSONChunks((value as Record<string,unknown>)[key],depth+1);}yield '}';return;
 }
 fail('MAINTENANCE_JSON');
}
export function maintenanceJSONDigest(value:unknown,newline=false):string {const hash=createHash('sha256');for(const chunk of maintenanceJSONChunks(value))hash.update(chunk);if(newline)hash.update('\n');return hash.digest('hex');}
export function writeMaintenanceJSON(fd:number,value:unknown):void {
 let pending='',bytes=0;
 const flush=()=>{const buffer=Buffer.from(pending);bytes+=buffer.length;if(bytes>32*1048576)fail('MAINTENANCE_LIMIT');let offset=0;while(offset<buffer.length){const n=fs.writeSync(fd,buffer,offset,buffer.length-offset,null);if(!n)fail('MAINTENANCE_COPY_FAILED');offset+=n;}pending='';};
 for(const chunk of maintenanceJSONChunks(value)){pending+=chunk;if(pending.length>=32768)flush();}
 pending+='\n';flush();
}
