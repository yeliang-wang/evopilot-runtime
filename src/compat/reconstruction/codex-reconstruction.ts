import fs from 'node:fs';
import {inspectCodexRecovery} from './codex-recovery.js';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {ReconstructionClaim,ReconstructionPlan,ReconstructionProviders} from '../../service.js';
import {validateReconstructionReceipt} from '../../service.js';
import {nativeExact,nativeBytesDigest} from '../../../vendor/compatibility/v1/native.mjs';
import {usabilityDigest,usabilityStable} from '../../../vendor/usability/v1/contract.mjs';
import {describeLocalReconstruction,reconstructionDirectory,reconstructionFile,durableReconstructionFile,reconstructionOutputs,reconstructionFail as fail} from './local-reconstruction.js';
import type {LocalReconstructionInput} from './local-reconstruction.js';
import {describeCodexStorage} from './codex-storage.js';
import type {CodexStateStorage} from './codex-storage.js';

export interface CodexReconstructionInput {
  files:LocalReconstructionInput['files'];tools:LocalReconstructionInput['tools'];
  stages:Pick<LocalReconstructionInput['stages'],'build'|'run'>&{observe?:LocalReconstructionInput['stages']['run']};
  state?:CodexStateStorage;
  codex:{executable:string;version:string;model:string;effort:'low'|'medium'|'high';configuration:{path:string;digest:string};policyFiles:{path:string;digest:string}[];disabledServers:string[]};
}
export interface CodexWorkerRequest {claim:ReconstructionClaim;directory:string;input:CodexReconstructionInput}
export const CODEX_ADAPTER='codex-structured-node-v1';
export const CODEX_STATE_ADAPTER='codex-structured-node-state-v1';
export function codexCancellation(directory:string){const file=path.join(directory,'cancel');return fs.existsSync(file)?reconstructionFile(file,32).toString()==='timeout\n'?'CODEX_TIMEOUT':'CODEX_CANCELLED':null;}
/** No arbitrary command/config overrides: authenticated host generates text only. */
export const CODEX_FIXED_CONFIG:Readonly<Record<string,unknown>>=Object.freeze({
  'features.plugins':false,'features.apps':false,'features.remote_plugin':false,'features.hooks':false,'features.memories':false,
  'features.shell_snapshot':false,'features.shell_tool':false,'features.multi_agent':false,'features.multi_agent_v2':false,
  'agents.enabled':false,'features.goals':false,'features.skill_mcp_dependency_install':false,'skills.include_instructions':false,
  'project_doc_max_bytes':0,'web_search':'disabled','approval_policy':'never','notify':[],
  'analytics.enabled':false,'otel.exporter':'none','otel.metrics_exporter':'none',
  'shell_environment_policy.inherit':'none','shell_environment_policy.experimental_use_profile':false,
  'default_permissions':'evopilot_generate',
  'permissions.evopilot_generate':{filesystem:{':minimal':'read',':workspace_roots':'deny',':tmpdir':'deny',':slash_tmp':'deny'},network:{enabled:false}},
});
export function codexToml(value:unknown):string{
  if(typeof value==='string'||typeof value==='boolean'||typeof value==='number')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(codexToml).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).map(([k,v])=>JSON.stringify(k)+'='+codexToml(v)).join(',')+'}';
  return fail('CODEX_CONFIG');
}
export function codexConfig(input:CodexReconstructionInput){return {...CODEX_FIXED_CONFIG,...Object.fromEntries(input.codex.disabledServers.map(n=>['mcp_servers.'+n+'.enabled',false]))};}
function pinned(file:{path:string;digest:string},max:number){
  nativeExact(file,['path','digest']);if(!path.isAbsolute(file.path)||fs.realpathSync(file.path)!==file.path)fail('CODEX_PIN');
  const s=fs.lstatSync(file.path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>max||s.mode&0o022||![0,process.getuid!()].includes(s.uid)||nativeBytesDigest(fs.readFileSync(file.path))!==file.digest)fail('CODEX_PIN');
}
export function describeCodexReconstruction(input:CodexReconstructionInput){
  usabilityStable(input);nativeExact(input,['files','tools','stages','codex'],['state']);nativeExact(input.stages,['build','run'],['observe']);if(input.stages.observe&&!input.state)fail('CODEX_STATE_PROFILE');
  const storage=input.state?describeCodexStorage(input.state):null,adapter=storage?CODEX_STATE_ADAPTER:CODEX_ADAPTER;
  const node=describeLocalReconstruction({files:input.files,tools:input.tools,stages:{generation:input.stages.observe??input.stages.build,build:input.stages.build,run:input.stages.run}}),c=input.codex;
  nativeExact(c,['executable','version','model','effort','configuration','policyFiles','disabledServers']);
  if(!path.isAbsolute(c.executable)||fs.realpathSync(c.executable)!==c.executable||!/^0\.163\.0-alpha\.10\.2$/.test(c.version)||!/^gpt-[a-z0-9.-]+$/.test(c.model)||!['low','medium','high'].includes(c.effort))fail('CODEX_UNSUPPORTED');
  const s=fs.lstatSync(c.executable);if(!s.isFile()||s.mode&0o022||s.size>268435456||![0,process.getuid!()].includes(s.uid))fail('CODEX_EXECUTABLE');
  if(!Array.isArray(c.policyFiles)||c.policyFiles.length>8||new Set(c.policyFiles.map(f=>f.path)).size!==c.policyFiles.length||!Array.isArray(c.disabledServers)||c.disabledServers.length>64||new Set(c.disabledServers).size!==c.disabledServers.length||c.disabledServers.some(n=>!/^[A-Za-z0-9_-]+$/.test(n)))fail('CODEX_CONFIG');
  if(c.configuration.path!==path.join(os.homedir(),'.codex','config.toml')||(process.env.CODEX_HOME&&process.env.CODEX_HOME!==path.dirname(c.configuration.path)))fail('CODEX_AUTH_REFERENCE');
  pinned(c.configuration,1048576);c.policyFiles.forEach(f=>pinned(f,65536));
  return {inputManifestDigest:node.inputManifestDigest,dependenciesDigest:usabilityDigest({tools:input.tools,policies:c.policyFiles,node:node.executableDigest,...(storage?{storage}:{})}),
    environmentDigest:usabilityDigest({adapter,platform:process.platform,arch:process.arch,release:os.release(),node:process.version,configuration:c.configuration}),
    executableDigest:nativeBytesDigest(fs.readFileSync(c.executable)),configurationDigest:usabilityDigest({adapter,model:c.model,effort:c.effort,config:codexConfig(input),stages:input.stages,...(storage?{state:input.state}:{})}),nodeExecutable:node.executable,nodeExecutableDigest:node.executableDigest};
}
export function verifyCodexRequest(request:CodexWorkerRequest){
  const pins=describeCodexReconstruction(request.input),p=request.claim.plan;reconstructionDirectory(request.directory);
  if(p.executor.id!==(request.input.state?CODEX_STATE_ADAPTER:CODEX_ADAPTER)||p.executor.provider!=='openai'||p.executor.model!==request.input.codex.model||p.executor.version!==request.input.codex.version||p.budget.maxTokens<1||p.budget.maxCostMicros!==null||p.inputMode!=='ASSETS_ONLY')fail('CODEX_PLAN');
  const seeds=request.input.state?.seeds;if(seeds&&(p.budget.maxAttempts>seeds.length||!seeds[request.claim.ordinal-1]))fail('CODEX_STATE_SEEDS');
  if(seeds?.some(s=>s.mountPoint===request.directory||s.mountPoint.startsWith(request.directory+'/')||request.directory.startsWith(s.mountPoint+'/')||s.image.path.startsWith(request.directory+'/')))fail('CODEX_TOOL_OVERLAP');
  for(const k of ['inputManifestDigest','dependenciesDigest','environmentDigest'] as const)if(p[k]!==pins[k])fail('CODEX_PIN');
  for(const k of ['configurationDigest','executableDigest'] as const)if(p.executor[k]!==pins[k])fail('CODEX_PIN');
  for(const f of [...request.input.tools,...request.input.codex.policyFiles,request.input.codex.configuration])if(f.path.startsWith(request.directory+'/'))fail('CODEX_TOOL_OVERLAP');
  return pins;
}
export function verifyCodexVersion(input:CodexReconstructionInput){const r=spawnSync(input.codex.executable,['--version'],{encoding:'utf8',timeout:2000,maxBuffer:4096});if(r.status!==0||r.stdout.trim()!=='codex-cli '+input.codex.version)fail('CODEX_VERSION');}
export function codexTrace(directory:string){
  const names=['request.json','generation.process.json','generation.admission.json','generation.turn.json','generation.events.jsonl','generation.stderr','generation.result.json','build.process.json','build.stdout','build.stderr','run.process.json','run.stdout','run.stderr','state.phase.json','state.stderr','state.storage.json','state.result.json','state.dmg','observe.process.json','observe.stdout','observe.stderr'];
  return usabilityDigest(names.filter(n=>fs.existsSync(path.join(directory,n))).map(n=>({path:n,digest:nativeBytesDigest(reconstructionFile(path.join(directory,n),n==='state.dmg'?67108864:8388608))})));
}
export function createCodexReconstructionAdapter(options:{root:string;resolve:(plan:Readonly<ReconstructionPlan>,signal:AbortSignal)=>Promise<CodexReconstructionInput>;verify:NonNullable<ReconstructionProviders['verifyReconstructionPlan']>;observe?:ReconstructionProviders['observeReconstruction']}):ReconstructionProviders{
  reconstructionDirectory(options.root);const directory=(claim:ReconstructionClaim)=>path.join(options.root,claim.claimId.slice(7));
  const inspect:NonNullable<ReconstructionProviders['inspectReconstruction']>=async({claim})=>{
    const dir=directory(claim);if(!fs.existsSync(dir))return null;reconstructionDirectory(dir);
    const request=JSON.parse(reconstructionFile(path.join(dir,'request.json')).toString()) as CodexWorkerRequest;
    if(request.directory!==dir||usabilityDigest(request.claim)!==usabilityDigest(claim))fail('CODEX_CLAIM');
    if(!fs.existsSync(path.join(dir,'receipt.json')))return inspectCodexRecovery(request);
    verifyCodexRequest(request);
    const receipt=validateReconstructionReceipt(JSON.parse(reconstructionFile(path.join(dir,'receipt.json')).toString()),claim);
    if(receipt.traceDigest!==codexTrace(dir))fail('CODEX_TRACE_DRIFT');
    if(receipt.status==='SUCCEEDED'&&usabilityDigest(reconstructionOutputs(dir,claim.plan.budget.maxOutputBytes))!==receipt.outputDigest)fail('CODEX_OUTPUT_DRIFT');return receipt;
  };
  const stop=(dir:string,timeout=false)=>{reconstructionDirectory(dir);try{fs.writeFileSync(path.join(dir,'cancel'),timeout?'timeout\n':'cancel\n',{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}};
  return {verifyReconstructionPlan:options.verify,inspectReconstruction:inspect,cancelReconstruction:async context=>{const dir=directory(context.claim);if(fs.existsSync(dir))stop(dir);return inspect(context);},
    executeReconstruction:async context=>{
      const {claim,signal}=context,input=await options.resolve(claim.plan,signal);if(signal.aborted)fail('CODEX_ABORTED');
      const dir=directory(claim);fs.mkdirSync(dir,{mode:0o700});const request={claim,directory:dir,input};verifyCodexRequest(request);verifyCodexVersion(input);durableReconstructionFile(path.join(dir,'request.json'),request);
      const log=fs.openSync(path.join(dir,'worker.stderr'),'wx',0o600);let child:ReturnType<typeof spawn>;
      try{child=spawn(process.execPath,[fileURLToPath(new URL('./codex-worker.js',import.meta.url)),path.join(dir,'request.json')],{detached:true,stdio:['ignore','ignore',log],env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',HOME:os.homedir()}});}finally{fs.closeSync(log);}
      let startError=false;child.on('error',()=>{startError=true;});child.unref();const cancel=()=>stop(dir,signal.reason?.code==='RECONSTRUCTION_TIMEOUT');signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();const begin=performance.now();
      try{for(;;){if(startError)fail('CODEX_WORKER_START');const r=await inspect(context);if(r)return r;if(signal.aborted||performance.now()-begin>claim.remaining.wallMs+1000)fail('CODEX_UNKNOWN');await new Promise(r=>setTimeout(r,100));}}finally{signal.removeEventListener('abort',cancel);}
    },...(options.observe?{observeReconstruction:options.observe}:{})};
}
