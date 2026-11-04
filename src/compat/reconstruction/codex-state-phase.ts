import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CodexStorage} from './codex-storage.js';
import {codexStage} from './codex-stage.js';
import {verifyCodexRequest,codexCancellation} from './codex-reconstruction.js';
import type {CodexWorkerRequest} from './codex-reconstruction.js';
import {durableReconstructionFile,reconstructionFile,reconstructionFail as fail} from './local-reconstruction.js';

export interface CodexStateResult {claimId:string;stages:{build:'NOT_RUN'|'SUCCEEDED'|'FAILED';run:'NOT_RUN'|'SUCCEEDED'|'FAILED'};diagnostic:string|null;cleanup:'CLOSED'}
/** Own the mount and stage processes. Worker pipe loss cancels stages and closes the volume. */
async function runStatePhase(request:CodexWorkerRequest,remainingMs:number,streamBytes:number){
  process.umask(0o077);const begin=performance.now(),control=new AbortController();
  const lost=()=>control.abort('CODEX_WORKER_LOST');process.stdin.on('end',lost);process.stdin.on('error',lost);process.stdin.resume();
  const timer=setTimeout(()=>control.abort('CODEX_TIMEOUT'),remainingMs);
  const cancel=setInterval(()=>{const reason=codexCancellation(request.directory);if(reason)control.abort(reason);},25);
  const state=request.input.state,storage=new CodexStorage(request.directory,request.claim.claimId,state?.bytes,state?.seeds?.[request.claim.ordinal-1]),result:CodexStateResult={claimId:request.claim.claimId,stages:{build:'NOT_RUN',run:'NOT_RUN'},diagnostic:null,cleanup:'CLOSED'};
  let stage:'build'|'run'|null=null;
  try{
    verifyCodexRequest(request);if(!request.input.state)fail('CODEX_STATE_PROFILE');
    if(control.signal.aborted)fail(String(control.signal.reason));
    const mount=await storage.prepare(),streamBudget={remaining:streamBytes};
    for(const name of ['build','run'] as const){stage=name;await codexStage(request,name,remainingMs-Math.ceil(performance.now()-begin),streamBudget,{mount,signal:control.signal});result.stages[name]='SUCCEEDED';}
    // The observer never imports generated modules and has no state-write authority.
    if(request.input.stages.observe)await codexStage(request,'observe',remainingMs-Math.ceil(performance.now()-begin),streamBudget,{mount,signal:control.signal,readOnly:true});
  }catch(error){if(stage)result.stages[stage]='FAILED';result.diagnostic=error&&typeof error==='object'&&'code'in error?String(error.code):'CODEX_STATE_FAILED';}
  finally{
    clearTimeout(timer);clearInterval(cancel);process.stdin.removeListener('end',lost);process.stdin.removeListener('error',lost);process.stdin.destroy();
    try{await storage.close();}
    catch(error){durableReconstructionFile(path.join(request.directory,'state.cleanup-unknown.json'),{claimId:request.claim.claimId,diagnostic:error&&typeof error==='object'&&'code'in error?String(error.code):'CODEX_STATE_CLEANUP_UNKNOWN'});throw error;}
  }
  durableReconstructionFile(path.join(request.directory,'state.result.json'),result);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [file,wall,bytes]=process.argv.slice(2),remainingMs=Number(wall),streamBytes=Number(bytes);
  if(!file||!path.isAbsolute(file)||!Number.isSafeInteger(remainingMs)||remainingMs<=0||remainingMs>3600000||!Number.isSafeInteger(streamBytes)||streamBytes<0||streamBytes>8388608)fail('CODEX_STATE_REQUEST');
  const request=JSON.parse(reconstructionFile(file).toString()) as CodexWorkerRequest;
  if(path.join(request.directory,'request.json')!==file)fail('CODEX_STATE_REQUEST');await runStatePhase(request,remainingMs,streamBytes);
}
