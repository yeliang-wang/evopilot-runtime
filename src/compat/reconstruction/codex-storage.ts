import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {nativeExact,nativeBytesDigest} from '../../../vendor/compatibility/v1/native.mjs';
import {durableReconstructionFile,reconstructionDirectory,reconstructionFile,reconstructionFail as fail} from './local-reconstruction.js';

export interface CodexStateSeed {image:{path:string;digest:string};mountPoint:string}
export interface CodexStateStorage {kind:'fixed-hfs-v1';bytes:8388608|67108864;seeds?:CodexStateSeed[]}
export const STATE_BYTES=8388608;
const HDI='/usr/bin/hdiutil',PLUTIL='/usr/bin/plutil';
export function describeCodexStorage(state:CodexStateStorage){
  nativeExact(state,['kind','bytes'],['seeds']);if(state.kind!=='fixed-hfs-v1'||![STATE_BYTES,67108864].includes(state.bytes)||process.platform!=='darwin')fail('CODEX_STATE_PROFILE');
  if(state.seeds!==undefined){
    if(!Array.isArray(state.seeds)||state.seeds.length<2||state.seeds.length>4||new Set(state.seeds.map(s=>s.mountPoint)).size!==state.seeds.length||new Set(state.seeds.map(s=>s.image.path)).size!==state.seeds.length)fail('CODEX_STATE_SEEDS');
    for(const seed of state.seeds){nativeExact(seed,['image','mountPoint']);nativeExact(seed.image,['path','digest']);reconstructionDirectory(seed.mountPoint);reconstructionDirectory(path.dirname(seed.image.path));
      if(!path.isAbsolute(seed.image.path)||fs.realpathSync(seed.image.path)!==seed.image.path||state.seeds.some(s=>seed.image.path.startsWith(s.mountPoint+'/')))fail('CODEX_STATE_SEED_PIN');
      const bytes=reconstructionFile(seed.image.path,state.bytes);if(bytes.length!==state.bytes||nativeBytesDigest(bytes)!==seed.image.digest)fail('CODEX_STATE_SEED_PIN');
    }
  }
  return [HDI,PLUTIL].map(file=>{const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.mode&0o022||s.uid!==0||s.size>16777216)fail('CODEX_STATE_TOOL');return {path:file,digest:nativeBytesDigest(fs.readFileSync(file))};});
}
/** Fixed trusted commands only. A timed-out mount command has an unknown effect. */
async function command(executable:string,args:string[],input?:Buffer):Promise<Buffer>{
  const child=spawn(executable,args,{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe']});
  const chunks:Buffer[]=[];let count=0,problem:string|null=null;
  const timer=setTimeout(()=>{problem='CODEX_STATE_COMMAND_UNKNOWN';child.kill('SIGKILL');},15000);
  child.stdout.on('data',(b:Buffer)=>{count+=b.length;if(count>1048576){problem='CODEX_STATE_COMMAND_UNKNOWN';child.kill('SIGKILL');}else chunks.push(b);});
  child.stderr.on('data',(b:Buffer)=>{count+=b.length;if(count>1048576){problem='CODEX_STATE_COMMAND_UNKNOWN';child.kill('SIGKILL');}});
  child.stdin.on('error',()=>{problem??='CODEX_STATE_COMMAND_UNKNOWN';});child.stdin.end(input);
  try{const exit=await new Promise<number|null>(resolve=>{child.on('error',()=>{problem='CODEX_STATE_COMMAND_UNKNOWN';});child.on('close',resolve);});if(problem)fail(problem);if(exit!==0)fail('CODEX_STATE_COMMAND_FAILED');return Buffer.concat(chunks);}
  finally{clearTimeout(timer);}
}
async function plist(bytes:Buffer):Promise<Record<string,unknown>>{
  try{const result=JSON.parse((await command(PLUTIL,['-convert','json','-o','-','--','-'],bytes)).toString());if(!result||typeof result!=='object'||Array.isArray(result))fail('CODEX_STATE_METADATA');return result;}
  catch{return fail('CODEX_STATE_METADATA');}
}
type Entity={'dev-entry'?:unknown;'mount-point'?:unknown;'volume-kind'?:unknown};
export function ownedStateDevice(images:unknown,image:string,mount:string):string|null{
  if(!Array.isArray(images))return fail('CODEX_STATE_METADATA');
  const same=images.filter(x=>x&&typeof x==='object'&&x['image-path']===image);
  if(!same.length){if(images.some(x=>Array.isArray(x?.['system-entities'])&&x['system-entities'].some((e:Entity)=>e['mount-point']===mount)))fail('CODEX_STATE_IDENTITY');return null;}
  if(same.length!==1||same[0].writeable!==true||!Array.isArray(same[0]['system-entities']))fail('CODEX_STATE_IDENTITY');
  const entities=same[0]['system-entities'] as Entity[];
  if(entities.length!==1||entities[0]['mount-point']!==mount||(entities[0]['volume-kind']!==undefined&&entities[0]['volume-kind']!=='hfs')||typeof entities[0]['dev-entry']!=='string'||!/^\/dev\/disk\d+$/.test(entities[0]['dev-entry']))return fail('CODEX_STATE_IDENTITY');
  return entities[0]['dev-entry'];
}
async function currentDevice(image:string,mount:string){return ownedStateDevice((await plist(await command(HDI,['info','-plist']))).images,image,mount);}
export class CodexStorage {
  readonly image:string;readonly mount:string;
  private device:string|null=null;private attachStarted=false;private attachCompleted=false;private events:unknown[]=[];
  constructor(private directory:string,private claimId:string,private bytes:8388608|67108864=STATE_BYTES,private seed?:CodexStateSeed){this.image=path.join(directory,'state.dmg');this.mount=seed?.mountPoint??path.join(directory,'work','state');}
  private record(event:string,data:Record<string,unknown>={}){this.events.push({event,...data});durableReconstructionFile(path.join(this.directory,'state.storage.json'),{claimId:this.claimId,image:this.image,mount:this.mount,events:this.events});}
  async prepare(){
    reconstructionDirectory(this.directory);
    if(this.seed){reconstructionDirectory(this.mount);if(fs.readdirSync(this.mount).length)fail('CODEX_STATE_MOUNT_NOT_EMPTY');}
    else fs.mkdirSync(this.mount,{mode:0o700});
    if(fs.statSync(this.mount).dev!==fs.statSync(path.dirname(this.mount)).dev||await currentDevice(this.image,this.mount)!==null)fail('CODEX_STATE_IDENTITY');
    if(fs.existsSync(this.image))fail('CODEX_STATE_EXISTS');
    if(this.seed){
      if(await currentDevice(this.seed.image.path,this.mount)!==null)fail('CODEX_STATE_IDENTITY');
      this.record('SEED_COPY_INTENT',{bytes:this.bytes,seedDigest:this.seed.image.digest});
      const seed=reconstructionFile(this.seed.image.path,this.bytes);if(seed.length!==this.bytes||nativeBytesDigest(seed)!==this.seed.image.digest)fail('CODEX_STATE_SEED_PIN');
      fs.writeFileSync(this.image,seed,{flag:'wx',mode:0o600});
    }else{this.record('CREATE_INTENT',{bytes:this.bytes});await command(HDI,['create','-size',this.bytes===STATE_BYTES?'8m':'64m','-fs','Case-sensitive HFS+','-layout','NONE','-type','UDIF','-nospotlight',this.image]);}
    fs.chmodSync(this.image,0o600);if(reconstructionFile(this.image,this.bytes).length!==this.bytes)fail('CODEX_STATE_SIZE');
    this.record('ATTACH_INTENT');this.attachStarted=true;
    const attached=await plist(await command(HDI,['attach','-plist','-nobrowse','-noautoopen','-mountpoint',this.mount,this.image]));
    this.device=ownedStateDevice([{'image-path':this.image,writeable:true,'system-entities':attached['system-entities']}],this.image,this.mount);
    if(!this.device||await currentDevice(this.image,this.mount)!==this.device)fail('CODEX_STATE_IDENTITY');
    this.attachCompleted=true;fs.chmodSync(this.mount,0o700);reconstructionDirectory(this.mount);
    this.record('MOUNTED',{device:this.device,bytes:this.bytes});return this.mount;
  }
  async close(){
    // A command whose effect is unknown cannot be declared cleaned after one empty inventory.
    if(this.attachStarted&&!this.attachCompleted)fail('CODEX_STATE_CLEANUP_UNKNOWN');
    if(this.attachCompleted){
      if(await currentDevice(this.image,this.mount)!==this.device)fail('CODEX_STATE_IDENTITY');
      this.record('DETACH_INTENT',{device:this.device});await command(HDI,['detach',this.device!]);
      if(await currentDevice(this.image,this.mount)!==null)fail('CODEX_STATE_CLEANUP_UNKNOWN');
    }
    const image=fs.existsSync(this.image)?reconstructionFile(this.image,this.bytes):null;
    if(image&&image.length!==this.bytes)fail('CODEX_STATE_SIZE');
    this.record('CLOSED',{imageDigest:image?nativeBytesDigest(image):null,bytes:image?.length??0});
  }
}
