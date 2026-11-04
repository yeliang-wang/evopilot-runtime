import {createHash} from 'node:crypto';
import {lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve, sep} from 'node:path';
import {gzipSync} from 'node:zlib';
import {VERSION} from '../index.js';

type FilePin = {type:'file';sha256:string;bytes:number;mode:number} | {type:'symlink';target:string};
export interface StandaloneDistribution {
  schema:'runtime-standalone-distribution/v1';version:string;archiveDigest:string;files:Record<string,FilePin>;
}
export interface DistributionInput {packageRoot:string;npmArchive:string;outputDirectory:string;sourceCommit:string;}
const hash=(bytes:Buffer):string=>createHash('sha256').update(bytes).digest('hex');
const fail=(message:string):never=>{throw new Error('DISTRIBUTION: '+message);};
const requireValue=(condition:unknown,message:string):void=>{if(!condition)fail(message);};
const plain=(value:unknown):Record<string,unknown>=>{
  if(!value||typeof value!=='object'||Array.isArray(value))return fail('Expected object');
  return value as Record<string,unknown>;
};
function regular(path:string,maximum:number):Buffer {
  const stat=lstatSync(path);
  requireValue(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=maximum,'Invalid bounded file');
  return readFileSync(path);
}
function relative(name:string):void {
  requireValue(/^[A-Za-z0-9_@. /+-]+$/.test(name)&&!isAbsolute(name)&&name.split('/').every(p=>p&&p!=='.'&&p!=='..'),'Path is outside the installer distribution profile');
}

/** Deterministic USTAR. No shell, extraction, filesystem times or host user IDs. */
function tarHeader(name:string,mode:number,size:number,type:'0'|'2',link=''):Buffer {
  const b=Buffer.alloc(512);
  const field=(text:string,offset:number,length:number):void=>{
    const bytes=Buffer.from(text);requireValue(bytes.length<=length,'USTAR field exceeds portable bounds');bytes.copy(b,offset);
  };
  let leaf=name,prefix='';
  if(Buffer.byteLength(name)>100){
    let split=name.lastIndexOf('/');
    while(split>0&&(Buffer.byteLength(name.slice(0,split))>155||Buffer.byteLength(name.slice(split+1))>100))split=name.lastIndexOf('/',split-1);
    requireValue(split>0,'USTAR path exceeds portable bounds');prefix=name.slice(0,split);leaf=name.slice(split+1);
  }
  const octal=(n:number,offset:number,length:number):void=>{const value=n.toString(8);requireValue(value.length<length,'USTAR number exceeds bounds');field(value.padStart(length-1,'0')+'\0',offset,length);};
  field(leaf,0,100);octal(mode,100,8);octal(0,108,8);octal(0,116,8);octal(size,124,12);octal(0,136,12);
  b.fill(32,148,156);field(type,156,1);field(link,157,100);field('ustar\0',257,6);field('00',263,2);field('root',265,32);field('root',297,32);field(prefix,345,155);
  const sum=b.reduce((a,v)=>a+v,0);field(sum.toString(8).padStart(6,'0')+'\0 ',148,8);return b;
}

/** Inventory and archive share the same read bytes; links never leave the package. */
export function packStandaloneTree(root:string):{archive:Buffer;files:Record<string,FilePin>} {
  requireValue(isAbsolute(root)&&realpathSync(root)===root&&lstatSync(root).isDirectory(),'Expected a canonical package directory');
  const files:Record<string,FilePin>={},parts:Buffer[]=[];let total=0,count=0;
  function walk(directory:string):void {
    for(const name of readdirSync(directory).sort()){
      const path=join(directory,name),key=path.slice(root.length+1).split(sep).join('/');relative(key);
      const stat=lstatSync(path);
      if(stat.isDirectory()&&!stat.isSymbolicLink()){walk(path);continue;}
      requireValue(++count<=20000,'Too many distribution entries');
      if(stat.isSymbolicLink()){
        const target=readlinkSync(path);requireValue(!isAbsolute(target)&&!/[\x00-\x1f\x7f\\]/.test(target)&&resolve(dirname(path),target).startsWith(root+sep)&&realpathSync(path).startsWith(root+sep),'Link escapes or is unresolved');
        files[key]={type:'symlink',target};parts.push(tarHeader('package/'+key,0o777,0,'2',target));
      }else{
        const bytes=regular(path,33554432);total+=bytes.length;requireValue(total<=536870912,'Distribution exceeds expanded size bound');
        const mode=(stat.mode&0o111)?0o755:0o644;
        files[key]={type:'file',sha256:hash(bytes),bytes:bytes.length,mode};
        parts.push(tarHeader('package/'+key,mode,bytes.length,'0'),bytes,Buffer.alloc((512-bytes.length%512)%512));
      }
    }
  }
  walk(root);requireValue(count>0,'Empty distribution');parts.push(Buffer.alloc(1024));
  const archive=gzipSync(Buffer.concat(parts),{level:9});requireValue(archive.length<=268435456,'Compressed distribution exceeds size bound');
  return{archive,files};
}

/** Produces candidate bytes only; no release, model, owner or installation authority. */
export function buildStandaloneDistribution(input:DistributionInput):{directory:string;version:string;files:Record<string,string>;productAcceptance:'NOT_EVALUATED';releaseAuthorized:false} {
  requireValue(process.version==='v24.14.0'&&process.platform==='darwin'&&process.arch==='arm64','Use the frozen Node/macOS arm64 build platform');
  requireValue(/^[a-f0-9]{40}$/.test(input.sourceCommit),'Invalid source commit');
  requireValue(isAbsolute(input.outputDirectory)&&resolve(input.outputDirectory)===input.outputDirectory&&realpathSync(dirname(input.outputDirectory))===dirname(input.outputDirectory),'Invalid output directory');
  const root=input.packageRoot;
  requireValue(isAbsolute(root)&&realpathSync(root)===root&&lstatSync(root).isDirectory(),'Expected a canonical package directory');
  const pkg=plain(JSON.parse(regular(join(root,'package.json'),1048576).toString()) as unknown);
  requireValue(pkg.name==='@evopilot-next/runtime'&&pkg.version===VERSION,'Wrong Runtime package identity');
  const lockBytes=regular(join(root,'package-lock.json'),2097152),lock=plain(JSON.parse(lockBytes.toString()) as unknown);
  requireValue(lock.name===pkg.name&&lock.version===pkg.version&&lock.lockfileVersion===3,'Wrong dependency lock identity');
  const lockRoot=plain(plain(lock.packages)['']);
  requireValue(JSON.stringify(lockRoot.dependencies)===JSON.stringify(pkg.dependencies),'Dependency lock mismatch');
  for(const [name,version] of Object.entries(plain(pkg.dependencies))){
    requireValue(/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(name)&&typeof version==='string'&&/^\d+\.\d+\.\d+$/.test(version),'Production dependency is not exactly pinned');
    const installed=plain(JSON.parse(regular(join(root,'node_modules',name,'package.json'),1048576).toString()) as unknown);
    requireValue(installed.name===name&&installed.version===version,'Missing or wrong production dependency');
  }
  for(const name of ['dist/index.js','dist/index.d.ts','dist/server/cli.js','dist/installation/installer.js','dist/host/header-helper.js','dist/dashboard/index.html','plugins/codex/.codex-plugin/plugin.json','plugins/codex/mcp.template.json','plugins/codex/skills/evopilot-runtime-expert/SKILL.md'])regular(join(root,name),33554432);
  const plugin=plain(JSON.parse(regular(join(root,'plugins/codex/.codex-plugin/plugin.json'),1048576).toString()) as unknown);
  requireValue(plugin.name==='evopilot-runtime'&&plugin.version===VERSION,'Plugin identity differs from Runtime');
  const npmBytes=regular(input.npmArchive,268435456),packed=packStandaloneTree(root);
  const manifest:StandaloneDistribution={schema:'runtime-standalone-distribution/v1',version:VERSION,archiveDigest:hash(packed.archive),files:packed.files};
  const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');requireValue(manifestBytes.length<=8388608,'Distribution inventory exceeds bound');
  const material:Record<string,Buffer>={
    [`evopilot-runtime-${VERSION}-darwin-arm64.tar.gz`]:packed.archive,
    [`evopilot-next-runtime-${VERSION}.tgz`]:npmBytes,
    'distribution-manifest.json':manifestBytes,
    'runtime-dependency-lock.json':lockBytes,
    'source-revision.txt':Buffer.from(input.sourceCommit+'\n'),
  };
  const files=Object.fromEntries(Object.entries(material).map(([name,bytes])=>[name,hash(bytes)]));
  material.SHA256SUMS=Buffer.from(Object.keys(files).sort().map(name=>files[name]+'  '+name+'\n').join(''));
  // Refuse an occupied output path, including an interrupted prior candidate.
  mkdirSync(input.outputDirectory,{mode:0o700});
  for(const [name,bytes] of Object.entries(material))writeFileSync(join(input.outputDirectory,name),bytes,{flag:'wx',mode:0o600});
  return{directory:input.outputDirectory,version:VERSION,files,productAcceptance:'NOT_EVALUATED',releaseAuthorized:false};
}
