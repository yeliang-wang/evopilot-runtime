import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {ReconstructionReceipt} from '../../service.js';
import {usabilityDigest,usabilityBytesDigest} from '../../../vendor/usability/v1/contract.mjs';
import {describeLocalReconstruction,verifyLocalReconstruction,reconstructionFile,reconstructionDirectory,durableReconstructionFile,reconstructionOutputs,reconstructionFail,reconstructionTrace} from './local-reconstruction.js';
import type {ReconstructionWorkerRequest} from './local-reconstruction.js';

function profile(request:ReconstructionWorkerRequest,executable:string,work:string){
  const read=[executable,...request.input.tools.map(t=>t.path),path.join(request.directory,'input','specification.json')].map(f=>`(literal ${JSON.stringify(f)})`).join(' ');
  // Root directory listing is required by this Node loader. No host file content,
  // external process, network, IPC delegation or arbitrary child exec is allowed.
  return `(version 1)\n(deny default)\n(allow file-read-metadata sysctl-read)\n(allow process-exec (literal ${JSON.stringify(executable)}))\n(allow file-read* (literal "/") (subpath "/usr/lib") (subpath "/System/Library") ${read} (subpath ${JSON.stringify(work)}))\n(allow file-write-data (literal "/dev/null"))\n`;
}
export async function runReconstructionWorker(request:ReconstructionWorkerRequest){
  const {claim,directory}=request,p=claim.plan,begin=performance.now(),work=path.join(directory,'work');
  const body:Omit<ReconstructionReceipt,'digest'>={schema:'evopilot-reconstruction-receipt/v1',claimId:claim.claimId,planDigest:claim.planDigest,attemptId:claim.attemptId,status:'FAILED',origin:p.origin,executorDigest:usabilityDigest(p.executor),inputManifestDigest:p.inputManifestDigest,environmentDigest:p.environmentDigest,dependenciesDigest:p.dependenciesDigest,workspaceId:'clean-'+claim.claimId.slice(7),cleanStart:false,isolation:'DENY_BY_DEFAULT',networkDenied:true,stages:{generation:'NOT_RUN',build:'NOT_RUN',run:'NOT_RUN'},usage:{wallMs:0,tokens:0,costMicros:0,iterations:0},interventions:[],outputs:[],outputDigest:usabilityDigest([]),traceDigest:usabilityDigest([]),diagnostic:null};
  try{
    const pins=verifyLocalReconstruction(request);const inputRoot=path.join(directory,'input');fs.mkdirSync(inputRoot,{mode:0o700});fs.mkdirSync(work,{mode:0o700});fs.mkdirSync(path.join(work,'output'),{mode:0o700});fs.mkdirSync(path.join(work,'home'),{mode:0o700});body.cleanStart=true;let streamTotal=0;
    const spec=path.join(inputRoot,'specification.json');durableReconstructionFile(spec,{schema:'evopilot-builder-input/v1',files:request.input.files});
    const sbpl=profile(request,pins.executable,work),env={PATH:'/usr/bin:/bin',LANG:'C.UTF-8',HOME:path.join(work,'home'),TMPDIR:path.join(work,'home'),EVOPILOT_SPECIFICATION:spec,EVOPILOT_OUTPUT:path.join(work,'output')};
    for(const name of ['generation','build','run'] as const){
      if(fs.existsSync(path.join(directory,'cancel'))){body.status='CANCELLED';reconstructionFail('BUILDER_CANCELLED');}
      const remaining=claim.remaining.wallMs-Math.ceil(performance.now()-begin);if(remaining<=0)reconstructionFail('BUILDER_TIMEOUT');
      describeLocalReconstruction(request.input);const stage=request.input.stages[name],out=path.join(directory,name+'.stdout'),err=path.join(directory,name+'.stderr');let problem:string|null=null;
      const stdout=fs.openSync(out,'wx',0o600),stderr=fs.openSync(err,'wx',0o600);
      const child=spawn('/usr/bin/sandbox-exec',['-p',sbpl,pins.executable,'--disallow-code-generation-from-strings',stage.entry,...stage.argv],{cwd:work,env,detached:true,stdio:['ignore','pipe','pipe']});
      durableReconstructionFile(path.join(directory,name+'.process.json'),{claimId:claim.claimId,pid:child.pid??null,profileDigest:usabilityBytesDigest(sbpl),executableDigest:pins.executableDigest,stage:name,entryDigest:request.input.tools.find(t=>t.path===stage.entry)!.digest,environmentDigest:usabilityDigest(env)});
      const kill=()=>{if(child.exitCode===null&&child.signalCode===null){try{child.kill('SIGKILL');}catch{problem='BUILDER_TERMINATION_UNKNOWN';}}};
      const stream=(fd:number,b:Buffer)=>{const room=Math.max(0,p.budget.maxOutputBytes-streamTotal);streamTotal+=b.length;if(room)fs.writeSync(fd,b.subarray(0,room));if(streamTotal>p.budget.maxOutputBytes){problem='BUILDER_STREAM_LIMIT';kill();}};
      child.stdout.on('data',b=>stream(stdout,b));child.stderr.on('data',b=>stream(stderr,b));
      const timer=setTimeout(()=>{problem='BUILDER_TIMEOUT';kill();},remaining);
      const cancel=setInterval(()=>{if(fs.existsSync(path.join(directory,'cancel'))){body.status='CANCELLED';problem='BUILDER_CANCELLED';kill();}},25);
      let code:number|null=null;
      try{code=await new Promise<number|null>(resolve=>{child.on('error',()=>{problem??='BUILDER_START';});child.on('close',exit=>resolve(exit));});fs.fsyncSync(stdout);fs.fsyncSync(stderr);}finally{clearTimeout(timer);clearInterval(cancel);fs.closeSync(stdout);fs.closeSync(stderr);}
      body.stages[name]=code===0&&!problem?'SUCCEEDED':'FAILED';if(problem||code!==0)reconstructionFail(problem??'BUILDER_STAGE_FAILED');
      // Builder stdout is a bounded file protocol. Untrusted code cannot write
      // the filesystem; only this parent worker materializes regular output files.
      if(name==='generation'){
        const result=JSON.parse(reconstructionFile(out,p.budget.maxOutputBytes).toString()) as {files:{path:string;content:string}[];usage:{tokens:number;costMicros:number;iterations:number}};
        if(Object.keys(result).sort().join(',')!=='files,usage'||!Array.isArray(result.files)||!result.files.length||result.files.length>128)reconstructionFail('BUILDER_GENERATION_FORMAT');
        const usage=result.usage;
        if(!usage||Object.keys(usage).sort().join(',')!=='costMicros,iterations,tokens'||usage.tokens!==0||usage.costMicros!==0||usage.iterations!==1)reconstructionFail('BUILDER_USAGE');
        body.usage={wallMs:0,...usage};let size=0;
        for(const f of result.files){if(Object.keys(f).sort().join(',')!=='content,path'||typeof f.path!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(f.path)||typeof f.content!=='string')reconstructionFail('BUILDER_OUTPUT');size+=Buffer.byteLength(f.content);if(size>p.budget.maxOutputBytes)reconstructionFail('BUILDER_OUTPUT_LIMIT');fs.writeFileSync(path.join(work,'output',f.path),f.content,{flag:'wx',mode:0o600});}
      }
    }
    verifyLocalReconstruction(request);body.outputs=reconstructionOutputs(directory,p.budget.maxOutputBytes);if(!body.outputs.length)reconstructionFail('BUILDER_EMPTY_OUTPUT');body.outputDigest=usabilityDigest(body.outputs);body.status='SUCCEEDED';
  }catch(error){body.diagnostic=error&&typeof error==='object'&&'code'in error?String(error.code):'BUILDER_ERROR';}
  body.usage.wallMs=Math.ceil(performance.now()-begin);if(body.status==='SUCCEEDED'&&body.usage.wallMs>claim.remaining.wallMs){body.status='FAILED';body.diagnostic='BUILDER_TIMEOUT';}
  body.traceDigest=reconstructionTrace(directory);
  const receipt={...body,digest:usabilityDigest(body)};durableReconstructionFile(path.join(directory,'receipt.json'),receipt);return receipt;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const file=process.argv[2];if(!file||!path.isAbsolute(file))reconstructionFail('BUILDER_REQUEST');reconstructionDirectory(path.dirname(file));
  const request=JSON.parse(reconstructionFile(file).toString()) as ReconstructionWorkerRequest;if(path.join(request.directory,'request.json')!==file)reconstructionFail('BUILDER_REQUEST');await runReconstructionWorker(request);
}
