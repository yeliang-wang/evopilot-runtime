import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {usabilityDigest,usabilityBytesDigest} from '../../../vendor/usability/v1/contract.mjs';
import {durableReconstructionFile,reconstructionFail as fail} from './local-reconstruction.js';
import {verifyCodexRequest,codexCancellation} from './codex-reconstruction.js';
import type {CodexWorkerRequest} from './codex-reconstruction.js';

export async function codexStage(request:CodexWorkerRequest,name:'build'|'run'|'observe',remainingMs:number,streamBudget:{remaining:number},state?:{mount:string;signal:AbortSignal;readOnly?:boolean}){
  const {directory,input,claim}=request,pins=verifyCodexRequest(request),work=path.join(directory,'work'),entry=input.stages[name];
  if(!entry)return fail('CODEX_STAGE_MISSING');
  if(remainingMs<=0)fail('CODEX_TIMEOUT');if(state?.signal.aborted)fail(String(state.signal.reason));
  if(streamBudget.remaining<0)fail('CODEX_STREAM_LIMIT');
  const reads=[pins.nodeExecutable,...(name==='observe'?[entry.entry]:input.tools.map(f=>f.path))].map(f=>`(literal ${JSON.stringify(f)})`).join(' ');
  const stateAccess=state?`(allow file-read* ${state.readOnly?'':'file-write* '} (subpath ${JSON.stringify(state.mount)}))\n`:'';
  const outputAccess=name==='observe'?'':`(subpath ${JSON.stringify(path.join(work,'output'))})`;
  const profile=`(version 1)\n(deny default)\n(allow file-read-metadata sysctl-read)\n(allow process-exec (literal ${JSON.stringify(pins.nodeExecutable)}))\n(allow file-read* (literal "/") (subpath "/usr/lib") (subpath "/System/Library") ${reads} ${outputAccess})\n(allow file-write-data (literal "/dev/null"))\n${stateAccess}`;
  const env={PATH:'/usr/bin:/bin',LANG:'C.UTF-8',EVOPILOT_OUTPUT:path.join(work,'output'),...(state?{EVOPILOT_STATE_DIR:state.mount}:{})};
  const out=fs.openSync(path.join(directory,name+'.stdout'),'wx',0o600),err=fs.openSync(path.join(directory,name+'.stderr'),'wx',0o600);
  const child=spawn('/usr/bin/sandbox-exec',['-p',profile,pins.nodeExecutable,'--disallow-code-generation-from-strings',entry.entry,...entry.argv],{cwd:work,env,detached:true,stdio:['ignore','pipe','pipe']});
  durableReconstructionFile(path.join(directory,name+'.process.json'),{claimId:claim.claimId,pid:child.pid??null,profileDigest:usabilityBytesDigest(profile),nodeDigest:pins.nodeExecutableDigest,entryDigest:input.tools.find(f=>f.path===entry.entry)!.digest,environmentDigest:usabilityDigest(env)});
  let problem:string|null=null;
  const kill=()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');};
  const abort=()=>{problem=String(state!.signal.reason);kill();};state?.signal.addEventListener('abort',abort,{once:true});if(state?.signal.aborted)abort();
  const stream=(fd:number,b:Buffer)=>{const n=Math.max(0,Math.min(b.length,streamBudget.remaining));if(n)fs.writeSync(fd,b.subarray(0,n));streamBudget.remaining-=b.length;if(streamBudget.remaining<0){problem='CODEX_STREAM_LIMIT';kill();}};
  child.stdout.on('data',b=>stream(out,b));child.stderr.on('data',b=>stream(err,b));
  const timer=setTimeout(()=>{problem='CODEX_TIMEOUT';kill();},remainingMs),cancel=setInterval(()=>{const reason=codexCancellation(directory);if(reason){problem=reason;kill();}},25);
  try{const exit=await new Promise<number|null>(resolve=>{child.on('error',()=>{problem='CODEX_STAGE_START';});child.on('close',resolve);});if(problem||exit!==0)fail(problem??'CODEX_STAGE_FAILED');}
  finally{clearTimeout(timer);clearInterval(cancel);state?.signal.removeEventListener('abort',abort);fs.fsyncSync(out);fs.fsyncSync(err);fs.closeSync(out);fs.closeSync(err);}
}
