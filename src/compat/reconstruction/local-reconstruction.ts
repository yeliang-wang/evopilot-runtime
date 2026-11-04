import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {ReconstructionClaim,ReconstructionPlan,ReconstructionProviders,ReconstructionReceipt} from '../../service.js';
import {validateReconstructionReceipt} from '../../service.js';
import {usabilityDigest,usabilityBytesDigest,usabilityStable} from '../../../vendor/usability/v1/contract.mjs';
import {nativeExact,nativeRelativePath,nativeBytesDigest} from '../../../vendor/compatibility/v1/native.mjs';

export interface LocalReconstructionInput {
  files:{path:string;content:string}[];
  tools:{path:string;digest:string}[];
  stages:Record<'generation'|'build'|'run',{entry:string;argv:string[]}>;
}
export interface ReconstructionWorkerRequest {claim:ReconstructionClaim;directory:string;input:LocalReconstructionInput}
export const reconstructionFail=(code:string):never=>{throw Object.assign(new Error(code),{code});};
export function reconstructionDirectory(directory:string){
  if(!path.isAbsolute(directory)||path.normalize(directory)!==directory)reconstructionFail('BUILDER_DIRECTORY');
  let current=path.parse(directory).root;
  for(const part of directory.split(path.sep).filter(Boolean)){current=path.join(current,part);const s=fs.lstatSync(current);if(!s.isDirectory()||s.isSymbolicLink())reconstructionFail('BUILDER_DIRECTORY');}
  const s=fs.statSync(directory);if(s.uid!==process.getuid!()||s.mode&0o077)reconstructionFail('BUILDER_DIRECTORY');
}
export function reconstructionFile(filename:string,max=8388608):Buffer{
  const s=fs.lstatSync(filename);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>max||s.uid!==process.getuid!()||s.mode&0o077)reconstructionFail('BUILDER_FILE');return fs.readFileSync(filename);
}
export function durableReconstructionFile(filename:string,value:unknown){
  const tmp=filename+'.tmp',fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,filename);
  const dir=fs.openSync(path.dirname(filename),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
}
export function describeLocalReconstruction(input:LocalReconstructionInput){
  usabilityStable(input);nativeExact(input,['files','tools','stages']);
  if(process.platform!=='darwin'||process.version!=='v24.14.0')reconstructionFail('BUILDER_UNSUPPORTED_HOST');
  if(!Array.isArray(input.files)||!input.files.length||input.files.length>128||!Array.isArray(input.tools)||!input.tools.length||input.tools.length>128)reconstructionFail('BUILDER_CLOSURE');
  let total=0;const names=new Set<string>();
  for(const file of input.files){nativeExact(file,['path','content']);nativeRelativePath(file.path);if(!/^[a-zA-Z0-9_.-]+$/.test(file.path)||names.has(file.path)||typeof file.content!=='string'||/\.(m?js|cjs|ts|py|sh|wasm|exe|dll|so|dylib|bin)$/i.test(file.path))reconstructionFail('BUILDER_INPUT');names.add(file.path);total+=Buffer.byteLength(file.content);}
  if(total>1048576)reconstructionFail('BUILDER_INPUT_LIMIT');
  names.clear();for(const tool of input.tools){nativeExact(tool,['path','digest']);if(!path.isAbsolute(tool.path)||fs.realpathSync(tool.path)!==tool.path||names.has(tool.path))reconstructionFail('BUILDER_TOOL');names.add(tool.path);const s=fs.lstatSync(tool.path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.mode&0o022||s.size>1048576||![0,process.getuid!()].includes(s.uid)||nativeBytesDigest(fs.readFileSync(tool.path))!==tool.digest)reconstructionFail('BUILDER_TOOL');}
  nativeExact(input.stages,['generation','build','run']);for(const stage of Object.values(input.stages)){nativeExact(stage,['entry','argv']);if(!names.has(stage.entry)||!Array.isArray(stage.argv)||stage.argv.length>32||stage.argv.some(x=>typeof x!=='string'||x.length>4096||x.includes('\0')))reconstructionFail('BUILDER_STAGE');}
  const executable=fs.realpathSync(process.execPath),s=fs.lstatSync(executable);if(!s.isFile()||s.mode&0o022||![0,process.getuid!()].includes(s.uid))reconstructionFail('BUILDER_EXECUTABLE');
  return {inputManifestDigest:usabilityDigest(input.files.map(f=>({path:f.path,digest:usabilityBytesDigest(f.content),bytes:Buffer.byteLength(f.content)}))),
    dependenciesDigest:usabilityDigest(input.tools),environmentDigest:usabilityDigest({adapter:'seatbelt-node-v1',platform:process.platform,arch:process.arch,release:os.release(),node:process.version}),
    executableDigest:nativeBytesDigest(fs.readFileSync(executable)),configurationDigest:usabilityDigest({adapter:'seatbelt-node-v1',stages:input.stages}),executable};
}
export function verifyLocalReconstruction(request:ReconstructionWorkerRequest){
  const pins=describeLocalReconstruction(request.input),p=request.claim.plan;reconstructionDirectory(request.directory);
  if(p.executor.provider!=='local-offline'||p.executor.model!=='none'||p.budget.maxTokens!==0||p.budget.maxCostMicros!==0)reconstructionFail('BUILDER_UNSUPPORTED_MODEL');
  if(p.inputMode!=='ASSETS_ONLY')reconstructionFail('BUILDER_INPUT_MODE');
  for(const key of ['inputManifestDigest','environmentDigest','dependenciesDigest'] as const)if(pins[key]!==p[key])reconstructionFail('BUILDER_PIN');
  for(const key of ['executableDigest','configurationDigest'] as const)if(pins[key]!==p.executor[key])reconstructionFail('BUILDER_PIN');
  if(request.input.tools.some(t=>t.path===request.directory||t.path.startsWith(request.directory+'/')))reconstructionFail('BUILDER_TOOL_OVERLAP');return pins;
}
export function reconstructionOutputs(directory:string,max:number){
  const root=path.join(directory,'work','output'),outputs:{path:string;bytes:number;digest:string}[]=[];let total=0;
  const visit=(current:string)=>{reconstructionDirectory(current);for(const name of fs.readdirSync(current).sort()){if(outputs.length>=1024||name.startsWith('.'))reconstructionFail('BUILDER_OUTPUT');const file=path.join(current,name),s=fs.lstatSync(file);if(s.isDirectory()){visit(file);continue;}const bytes=reconstructionFile(file,max);total+=bytes.length;if(total>max)reconstructionFail('BUILDER_OUTPUT_LIMIT');outputs.push({path:path.relative(root,file),bytes:bytes.length,digest:nativeBytesDigest(bytes)});}};
  visit(root);return outputs;
}
export function reconstructionTrace(directory:string){
  const names=['request.json','input/specification.json',...['generation','build','run'].flatMap(n=>[n+'.process.json',n+'.stdout',n+'.stderr'])];
  return usabilityDigest(names.filter(n=>fs.existsSync(path.join(directory,n))).map(n=>({path:n,digest:nativeBytesDigest(reconstructionFile(path.join(directory,n)))})));
}
/** Offline single-process Node adapter. No ambient credentials, network, shell or external Agent login. */
export function createLocalReconstructionAdapter(options:{root:string;resolve:(plan:Readonly<ReconstructionPlan>,signal:AbortSignal)=>Promise<LocalReconstructionInput>;verify:NonNullable<ReconstructionProviders['verifyReconstructionPlan']>;observe?:ReconstructionProviders['observeReconstruction']}):ReconstructionProviders{
  reconstructionDirectory(options.root);
  const directory=(claim:ReconstructionClaim)=>path.join(options.root,claim.claimId.slice(7));
  async function inspect({claim}:Parameters<NonNullable<ReconstructionProviders['inspectReconstruction']>>[0]){
    const dir=directory(claim);if(!fs.existsSync(dir))return null;reconstructionDirectory(dir);
    const request=JSON.parse(reconstructionFile(path.join(dir,'request.json')).toString()) as ReconstructionWorkerRequest;
    if(request.directory!==dir||usabilityDigest(request.claim)!==usabilityDigest(claim))reconstructionFail('BUILDER_CLAIM');verifyLocalReconstruction(request);
    if(!fs.existsSync(path.join(dir,'receipt.json')))return null;
    const r=validateReconstructionReceipt(JSON.parse(reconstructionFile(path.join(dir,'receipt.json')).toString()),claim);
    if(r.traceDigest!==reconstructionTrace(dir))reconstructionFail('BUILDER_TRACE_DRIFT');
    if(r.status==='SUCCEEDED'&&usabilityDigest(reconstructionOutputs(dir,claim.plan.budget.maxOutputBytes))!==r.outputDigest)reconstructionFail('BUILDER_OUTPUT_DRIFT');return r;
  }
  return {
    verifyReconstructionPlan:options.verify,
    executeReconstruction:async({claim,signal})=>{
      const input=await options.resolve(claim.plan,signal);if(signal.aborted)reconstructionFail('BUILDER_ABORTED');
      const dir=directory(claim);fs.mkdirSync(dir,{mode:0o700});const request:ReconstructionWorkerRequest={claim,directory:dir,input};verifyLocalReconstruction(request);
      durableReconstructionFile(path.join(dir,'request.json'),request);
      const log=fs.openSync(path.join(dir,'worker.stderr'),'wx',0o600);
      let child:ReturnType<typeof spawn>;try{child=spawn(process.execPath,[fileURLToPath(new URL('./reconstruction-worker.js',import.meta.url)),path.join(dir,'request.json')],{detached:true,stdio:['ignore','ignore',log],env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});}finally{fs.closeSync(log);}let error:Error|null=null;child.on('error',e=>{error=e;});child.unref();
      const stop=()=>{try{fs.writeFileSync(path.join(dir,'cancel'),'cancel\n',{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}};
      signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();const start=performance.now();
      try{for(;;){if(error)reconstructionFail('BUILDER_WORKER_START');const receipt=await inspect({claim,signal});if(receipt)return receipt;if(signal.aborted||performance.now()-start>claim.remaining.wallMs+1000)reconstructionFail('BUILDER_UNKNOWN');await new Promise(r=>setTimeout(r,25));}}finally{signal.removeEventListener('abort',stop);}
    },
    inspectReconstruction:inspect,
    cancelReconstruction:async context=>{const dir=directory(context.claim);if(fs.existsSync(dir)){reconstructionDirectory(dir);try{fs.writeFileSync(path.join(dir,'cancel'),'cancel\n',{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}}return inspect(context);},
    ...(options.observe?{observeReconstruction:options.observe}:{}),
  };
}
