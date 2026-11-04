import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {validateReconstructionReceipt} from '../../service.js';
import type {ReconstructionReceipt} from '../../service.js';
import {nativeBytesDigest} from '../../../vendor/compatibility/v1/native.mjs';
import {usabilityDigest} from '../../../vendor/usability/v1/contract.mjs';
import {reconstructionDirectory,reconstructionFile,reconstructionOutputs,durableReconstructionFile,reconstructionFail} from './local-reconstruction.js';
import {verifyCodexRequest,codexTrace} from './codex-reconstruction.js';
import type {CodexWorkerRequest} from './codex-reconstruction.js';

// Exact reviewed pre-release implementation of the pre-storage 600000 ms rejection.
// This allowlist cannot certify another crash site, worker loss or uncertain mount.
const legacyModules:Record<string,string>={
  'codex-worker.js':'91c62d449f783917cf00ac2185a3644b56bd1ee13d7013da770eae8765c57d24',
  'codex-state-phase.js':'28e9793e0b2daec14063e90dd32a9342d4cb2a0a58a370addc0cd2a0237128f1',
  'local-reconstruction.js':'e89cd0d3dd1044ff288edbc6e8fe54c76cc54d695cf8bbae6511d3289c6f1700',
  'codex-generation.js':'db4f4caf8681a6610bc3e64f23930421464c03cd63691dc4326116de9e290135',
  'codex-storage.js':'1c56ff0b52716bf045faadabcdacc5871cda87427a9f204a74002cbd4a5ec04f'
};
const forbidden=['receipt.json','state.storage.json','state.dmg','state.result.json','state.cleanup-unknown.json',...['build','run','observe'].flatMap(s=>[s+'.process.json',s+'.stdout',s+'.stderr'])];
const sources=['request.json','generation.process.json','generation.admission.json','generation.turn.json','generation.events.jsonl','generation.stderr','generation.result.json','state.phase.json','state.stderr','worker.unknown.json','worker.stderr'];
type RecordValue=Record<string,unknown>;
function fail(code:string):never{return reconstructionFail(code);}
function object(v:unknown):RecordValue{if(!v||typeof v!=='object'||Array.isArray(v))fail('CODEX_RECOVERY_EVIDENCE');return v as RecordValue;}
function same(a:unknown,b:unknown){if(usabilityDigest(a)!==usabilityDigest(b))fail('CODEX_RECOVERY_EVIDENCE');}
const read=(dir:string,name:string):RecordValue=>object(JSON.parse(reconstructionFile(path.join(dir,name)).toString()));
function originalFiles(request:CodexWorkerRequest){
  for(const file of forbidden)if(fs.existsSync(path.join(request.directory,file)))fail('CODEX_RECOVERY_STAGE_OBSERVED');
  return sources.map(file=>({path:file,digest:nativeBytesDigest(reconstructionFile(path.join(request.directory,file)))}));
}
function verifyModules(root:string){
  if(!path.isAbsolute(root)||fs.realpathSync(root)!==root)fail('CODEX_RECOVERY_MODULE');
  for(const [name,sha] of Object.entries(legacyModules)){
    const file=path.join(root,name),s=fs.lstatSync(file);
    if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.mode&0o022||s.uid!==process.getuid!()||s.size>1048576||nativeBytesDigest(fs.readFileSync(file))!=='sha256:'+sha)fail('CODEX_RECOVERY_MODULE');
  }
}
function absentProcess(value:unknown):number{
  if(!Number.isSafeInteger(value)||(value as number)<=1)fail('CODEX_RECOVERY_PROCESS');const pid=value as number;
  try{process.kill(pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')return pid;return fail('CODEX_RECOVERY_PROCESS');}
  return fail('CODEX_RECOVERY_PROCESS');
}
function noOwnedMount(request:CodexWorkerRequest){
  const a=spawnSync('/usr/bin/hdiutil',['info','-plist'],{timeout:15000,maxBuffer:1048576,env:{PATH:'/usr/bin:/bin'}});
  if(a.error||a.status!==0)fail('CODEX_RECOVERY_MOUNT');
  const b=spawnSync('/usr/bin/plutil',['-convert','json','-o','-','--','-'],{input:a.stdout,timeout:2000,maxBuffer:1048576,env:{PATH:'/usr/bin:/bin'}});
  if(b.error||b.status!==0)fail('CODEX_RECOVERY_MOUNT');
  const images=object(JSON.parse(b.stdout.toString())).images;if(!Array.isArray(images))fail('CODEX_RECOVERY_MOUNT');
  const state=request.input.state!,seed=state.seeds?.[request.claim.ordinal-1],mount=seed?.mountPoint??path.join(request.directory,'work','state');
  const owned=new Set([path.join(request.directory,'state.dmg'),...(state.seeds??[]).map(s=>s.image.path)]);
  for(const raw of images){const im=object(raw);if(owned.has(String(im['image-path'])))fail('CODEX_RECOVERY_MOUNT');
    if(!Array.isArray(im['system-entities']))fail('CODEX_RECOVERY_MOUNT');
    if(im['system-entities'].some(e=>object(e)['mount-point']===mount))fail('CODEX_RECOVERY_MOUNT');
  }
  if(fs.existsSync(mount)){reconstructionDirectory(mount);if(fs.readdirSync(mount).length||fs.statSync(mount).dev!==fs.statSync(path.dirname(mount)).dev)fail('CODEX_RECOVERY_MOUNT');}
  return {inventoryDigest:nativeBytesDigest(b.stdout),image:path.join(request.directory,'state.dmg'),mount,ownedMountedImages:0};
}
function verifyGeneration(request:CodexWorkerRequest){
  const {directory:dir,claim}=request,g=read(dir,'generation.result.json'),turn=read(dir,'generation.turn.json'),admission=read(dir,'generation.admission.json'),proc=read(dir,'generation.process.json');
  same(turn,{claimId:claim.claimId,threadId:g.threadId,turnId:g.turnId});
  if(typeof g.threadId!=='string'||typeof g.turnId!=='string'||!Number.isSafeInteger(g.tokens)||(g.tokens as number)<0||(g.tokens as number)>claim.remaining.tokens)fail('CODEX_RECOVERY_GENERATION');
  same(proc,{claimId:claim.claimId,pid:proc.pid,executableDigest:claim.plan.executor.executableDigest,configurationDigest:claim.plan.executor.configurationDigest});
  if(admission.threadId!==g.threadId||admission.model!==claim.plan.executor.model||admission.provider!=='openai'||admission.configurationDigest!==claim.plan.executor.configurationDigest||object(admission.policy).id!=='evopilot_generate')fail('CODEX_RECOVERY_GENERATION');
  same(admission.policyPins,request.input.codex.policyFiles);same(admission.instructionSources,request.input.codex.policyFiles.map(f=>f.path));
  let tokens:unknown=null,final:unknown=null,completed=false;
  const admitted=new Set(['agentMessage','reasoning','userMessage','contextCompaction']);
  for(const line of reconstructionFile(path.join(dir,'generation.events.jsonl')).toString().trim().split('\n')){
    const event=object(JSON.parse(line)),p=object(event.params);if(p.threadId!==g.threadId)fail('CODEX_RECOVERY_GENERATION');
    if(event.method==='turn/started'){if(object(p.turn).id!==g.turnId)fail('CODEX_RECOVERY_GENERATION');}
    else if(event.method==='turn/completed'){const t=object(p.turn);if(t.id!==g.turnId||t.status!=='completed'||completed)fail('CODEX_RECOVERY_GENERATION');completed=true;}
    else if(event.method==='error'){if(p.willRetry!==true)fail('CODEX_RECOVERY_GENERATION');}
    else {
      if(p.turnId!==g.turnId)fail('CODEX_RECOVERY_GENERATION');
      if(event.method==='thread/tokenUsage/updated'){const n=object(object(p.tokenUsage).total).totalTokens;if(!Number.isSafeInteger(n)||(n as number)<0||(tokens!==null&&(n as number)<(tokens as number)))fail('CODEX_RECOVERY_GENERATION');tokens=n;}
      else if(['item/started','item/completed'].includes(String(event.method))){const item=object(p.item);if(!admitted.has(String(item.type)))fail('CODEX_RECOVERY_GENERATION');if(event.method==='item/completed'&&item.type==='agentMessage'&&item.phase==='final_answer'){if(final!==null||typeof item.text!=='string')fail('CODEX_RECOVERY_GENERATION');final=JSON.parse(item.text);}}
      else fail('CODEX_RECOVERY_GENERATION');
    }
  }
  if(!completed||tokens!==g.tokens||final===null)fail('CODEX_RECOVERY_GENERATION');same(final,{files:g.files});
  if(!Array.isArray(g.files)||!g.files.length||g.files.length>128)fail('CODEX_RECOVERY_GENERATION');
  const expected=g.files.map(raw=>{const f=object(raw);if(typeof f.path!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(f.path)||typeof f.content!=='string')fail('CODEX_RECOVERY_GENERATION');return {path:f.path,bytes:Buffer.byteLength(f.content),digest:nativeBytesDigest(Buffer.from(f.content))};}).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const output=reconstructionOutputs(dir,claim.plan.budget.maxOutputBytes);same(expected,output);return {tokens:g.tokens as number,output,pid:proc.pid};
}
function receiptFor(request:CodexWorkerRequest,evidence:RecordValue):ReconstructionReceipt{
  const {claim}=request,p=claim.plan,wallMs=Date.parse(String(evidence.completedAt))-Date.parse(claim.admittedAt);
  if(!Number.isSafeInteger(wallMs)||wallMs<claim.remaining.wallMs)fail('CODEX_RECOVERY_TIME');
  const body:Omit<ReconstructionReceipt,'digest'>={schema:'evopilot-reconstruction-receipt/v1',claimId:claim.claimId,planDigest:claim.planDigest,attemptId:claim.attemptId,status:'FAILED',origin:p.origin,executorDigest:usabilityDigest(p.executor),inputManifestDigest:p.inputManifestDigest,environmentDigest:p.environmentDigest,dependenciesDigest:p.dependenciesDigest,workspaceId:'codex-'+claim.claimId.slice(7),cleanStart:false,isolation:'DENY_BY_DEFAULT',networkDenied:true,stages:{generation:'SUCCEEDED',build:'NOT_RUN',run:'NOT_RUN'},usage:{wallMs,tokens:evidence.tokens as number,costMicros:null,iterations:1},interventions:['FORENSIC_PRE_STORAGE_RECOVERY; elapsed wall includes unresolved time until verified closure'],outputs:[],outputDigest:usabilityDigest([]),traceDigest:usabilityDigest(evidence),diagnostic:'CODEX_STATE_ADMISSION_RECOVERED_FAILURE'};
  return validateReconstructionReceipt({...body,digest:usabilityDigest(body)},claim);
}
/** Read-only validation of a separate recovery receipt. No worker receipt is invented or overwritten. */
export function inspectCodexRecovery(request:CodexWorkerRequest):ReconstructionReceipt|null{
  const dir=path.join(request.directory,'recovery');if(!fs.existsSync(dir))return null;reconstructionDirectory(dir);
  if(!fs.existsSync(path.join(dir,'receipt.json')))return null;
  verifyCodexRequest(request);const e=read(dir,'evidence.json');
  if(e.schema!=='evopilot-codex-pre-storage-recovery/v1'||e.claimDigest!==usabilityDigest(request.claim)||e.sourceTraceDigest!==codexTrace(request.directory))fail('CODEX_RECOVERY_DRIFT');
  same(e.sourceFiles,originalFiles(request));verifyModules(String(e.originalModules));same(e.legacyModules,legacyModules);
  const generation=verifyGeneration(request);same(e.tokens,generation.tokens);same(e.output,generation.output);
  const receipt=validateReconstructionReceipt(read(dir,'receipt.json'),request.claim);same(receipt,receiptFor(request,e));return receipt;
}
/** Explicit stopped-execution maintenance, restricted to the exact known pre-storage rejection. */
export function recoverCodexStateAdmission(request:CodexWorkerRequest,originalModules:string):ReconstructionReceipt{
  verifyCodexRequest(request);if(!request.input.state)fail('CODEX_RECOVERY_STATE');
  same(read(request.directory,'request.json'),request);
  const existing=inspectCodexRecovery(request);if(existing)return existing;
  if(fs.existsSync(path.join(request.directory,'recovery')))fail('CODEX_RECOVERY_INCOMPLETE');
  verifyModules(originalModules);const before=originalFiles(request),phase=read(request.directory,'state.phase.json');
  same(phase,{claimId:request.claim.claimId,workerPid:phase.workerPid,phasePid:phase.phasePid});
  same(read(request.directory,'worker.unknown.json'),{claimId:request.claim.claimId,diagnostic:'CODEX_STATE_UNKNOWN'});
  const stderr=reconstructionFile(path.join(request.directory,'state.stderr')).toString();
  if(!stderr.includes('\nError: CODEX_STATE_REQUEST\n')||!stderr.includes('    at '+pathToFileURL(path.join(originalModules,'codex-state-phase.js')).href+':60:9\n'))fail('CODEX_RECOVERY_REJECTION');
  const generation=verifyGeneration(request),pids=[phase.workerPid,phase.phasePid,generation.pid].map(absentProcess);
  const mounts=noOwnedMount(request);pids.forEach(absentProcess);same(originalFiles(request),before);
  const evidence={schema:'evopilot-codex-pre-storage-recovery/v1',claimDigest:usabilityDigest(request.claim),completedAt:new Date().toISOString(),sourceTraceDigest:codexTrace(request.directory),sourceFiles:before,originalModules,legacyModules,processesObservedAbsent:pids,mounts,tokens:generation.tokens,output:generation.output,classification:'FAILED_BEFORE_STORAGE',noGenerationOrStageRedispatch:true};
  const receipt=receiptFor(request,evidence),out=path.join(request.directory,'recovery');fs.mkdirSync(out,{mode:0o700});durableReconstructionFile(path.join(out,'evidence.json'),evidence);durableReconstructionFile(path.join(out,'receipt.json'),receipt);return receipt;
}
