import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {ReconstructionReceipt} from '../../service.js';
import {usabilityDigest} from '../../../vendor/usability/v1/contract.mjs';
import {reconstructionFile,reconstructionDirectory,durableReconstructionFile,reconstructionOutputs,reconstructionFail as fail} from './local-reconstruction.js';
import {verifyCodexRequest,codexTrace,codexCancellation} from './codex-reconstruction.js';
import type {CodexWorkerRequest} from './codex-reconstruction.js';
import {generateCodex} from './codex-generation.js';
import {codexStage} from './codex-stage.js';
import type {CodexStateResult} from './codex-state-phase.js';

async function statePhase(request:CodexWorkerRequest,remainingMs:number,streamBytes:number):Promise<CodexStateResult>{
  if(remainingMs<=0)fail('CODEX_TIMEOUT');
  const log=fs.openSync(path.join(request.directory,'state.stderr'),'wx',0o600);
  const child=spawn(process.execPath,[fileURLToPath(new URL('./codex-state-phase.js',import.meta.url)),path.join(request.directory,'request.json'),String(remainingMs),String(streamBytes)],{env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',HOME:os.homedir()},stdio:['pipe','ignore',log]});
  fs.closeSync(log);child.stdin!.on('error',()=>{});
  durableReconstructionFile(path.join(request.directory,'state.phase.json'),{claimId:request.claim.claimId,workerPid:process.pid,phasePid:child.pid??null});
  const exit=await new Promise<number|null>(resolve=>{child.on('error',()=>{});child.on('close',resolve);});
  if(exit!==0||!fs.existsSync(path.join(request.directory,'state.result.json')))fail('CODEX_STATE_UNKNOWN');
  const result=JSON.parse(reconstructionFile(path.join(request.directory,'state.result.json')).toString()) as CodexStateResult;
  if(result.claimId!==request.claim.claimId||result.cleanup!=='CLOSED')fail('CODEX_STATE_UNKNOWN');return result;
}
export async function runCodexWorker(request:CodexWorkerRequest){
  const {claim,directory}=request,p=claim.plan,begin=performance.now(),admissionMs=Math.max(0,Date.now()-Date.parse(claim.admittedAt)),elapsed=()=>admissionMs+Math.ceil(performance.now()-begin);let current:'generation'|'build'|'run'='generation';
  const body:Omit<ReconstructionReceipt,'digest'>={schema:'evopilot-reconstruction-receipt/v1',claimId:claim.claimId,planDigest:claim.planDigest,attemptId:claim.attemptId,status:'FAILED',origin:p.origin,executorDigest:usabilityDigest(p.executor),inputManifestDigest:p.inputManifestDigest,environmentDigest:p.environmentDigest,dependenciesDigest:p.dependenciesDigest,workspaceId:'codex-'+claim.claimId.slice(7),cleanStart:false,isolation:'DENY_BY_DEFAULT',networkDenied:true,stages:{generation:'NOT_RUN',build:'NOT_RUN',run:'NOT_RUN'},usage:{wallMs:0,tokens:null,costMicros:null,iterations:0},interventions:[],outputs:[],outputDigest:usabilityDigest([]),traceDigest:usabilityDigest([]),diagnostic:null};
  try{
    verifyCodexRequest(request);fs.mkdirSync(path.join(directory,'work'),{mode:0o700});fs.mkdirSync(path.join(directory,'work','output'),{mode:0o700});body.cleanStart=true;
    {const reason=codexCancellation(directory);if(reason)fail(reason);}
    const generated=await generateCodex(request,claim.remaining.wallMs-elapsed());
    body.usage.tokens=generated.tokens;body.usage.iterations=1;body.stages.generation='SUCCEEDED';
    for(const f of generated.files)fs.writeFileSync(path.join(directory,'work','output',f.path),f.content,{flag:'wx',mode:0o600});
    const streamBudget={remaining:p.budget.maxOutputBytes-['generation.events.jsonl','generation.stderr'].reduce((n,f)=>n+fs.statSync(path.join(directory,f)).size,0)};
    if(request.input.state){
      current='build';const result=await statePhase(request,claim.remaining.wallMs-elapsed(),streamBudget.remaining);
      body.stages.build=result.stages.build;body.stages.run=result.stages.run;current=result.stages.build==='SUCCEEDED'?'run':'build';
      if(result.diagnostic)fail(result.diagnostic);
    }else for(const name of ['build','run'] as const){current=name;{const reason=codexCancellation(directory);if(reason)fail(reason);}await codexStage(request,name,claim.remaining.wallMs-elapsed(),streamBudget);body.stages[name]='SUCCEEDED';}
    verifyCodexRequest(request);body.outputs=reconstructionOutputs(directory,p.budget.maxOutputBytes);body.outputDigest=usabilityDigest(body.outputs);body.status='SUCCEEDED';
  }catch(error){body.stages[current]='FAILED';body.diagnostic=error&&typeof error==='object'&&'code'in error?String(error.code):'CODEX_WORKER_ERROR';if(body.diagnostic==='CODEX_STATE_UNKNOWN'){durableReconstructionFile(path.join(directory,'worker.unknown.json'),{claimId:claim.claimId,diagnostic:body.diagnostic});return null;}if(body.diagnostic==='CODEX_CANCELLED')body.status='CANCELLED';}
  body.usage.wallMs=elapsed();if(body.status==='SUCCEEDED'&&body.usage.wallMs>claim.remaining.wallMs){body.status='FAILED';body.diagnostic='CODEX_TIMEOUT';}
  body.traceDigest=codexTrace(directory);const receipt={...body,digest:usabilityDigest(body)};durableReconstructionFile(path.join(directory,'receipt.json'),receipt);return receipt;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const file=process.argv[2];if(!file||!path.isAbsolute(file))fail('CODEX_REQUEST');reconstructionDirectory(path.dirname(file));const request=JSON.parse(reconstructionFile(file).toString()) as CodexWorkerRequest;
  if(path.join(request.directory,'request.json')!==file)fail('CODEX_REQUEST');await runCodexWorker(request);
}
