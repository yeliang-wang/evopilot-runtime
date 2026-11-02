import { parseDocument } from 'yaml';
import { record, reject, ServiceError, string } from '../server/errors.js';
import type { PlatformRegistration } from './config.js';
import type { Principal } from '../server/security.js';
import { aggregateJobs, ciInputs, ciSourceRef, commitId, executionPrincipal, fileBytes, jobResult, matchRepository, platformReader, positiveId, readinessResult, runResult, safePlatformError, sha256, validateRunRequest, validateSourceRef, type PlatformClient, type PlatformCredentialReader, type PlatformJobObservation, type PlatformRunRequest } from './platforms.js';

/** GitLab v4 API, including the accepted self-managed 15.0 test instance. Only
 * explicit registered project/runner IDs are used; no admin runner discovery. */
export function gitlabClient(configuration:PlatformRegistration,credentials:PlatformCredentialReader):PlatformClient{
  const{binding,get,post,download}=platformReader(configuration,credentials);if(binding.provider!=='gitlab')reject('PLATFORM_MISMATCH','Expected GitLab registration');
  function observedJob(raw:unknown,runId:string,jobId:string,commit:string):PlatformJobObservation{
    const job=record(raw);if(positiveId(job.id)!==jobId||positiveId(record(job.pipeline).id)!==runId||record(job.commit).id!==commit)reject('PLATFORM_RECEIPT_MISMATCH','GitLab job identity or source differs',409);
    const runner=job.runner===null?null:record(job.runner),runnerId=runner?positiveId(runner.id):null;
    if(runnerId!==null&&runnerId!==binding.runner)reject('PLATFORM_RECEIPT_MISMATCH','Job used a different registered runner',409);
    let status:PlatformJobObservation['status']='UNKNOWN';
    if(['created','pending','preparing','waiting_for_resource','scheduled','manual'].includes(String(job.status)))status='PENDING';
    else if(job.status==='running')status='RUNNING';
    else if(job.status==='success'&&runnerId!==null)status='PASSED';
    else if(['failed','canceled','skipped'].includes(String(job.status)))status='FAILED';
    return jobResult(binding,runId,jobId,commit,status,status==='UNKNOWN'?'unknown':String(job.status),runnerId);
  }
  async function ownedRef(actor:Principal,r:PlatformRunRequest,signal:AbortSignal):Promise<boolean>{
    let value:unknown;try{value=await get(actor,'/repository/tags/'+encodeURIComponent(ciSourceRef(r)),signal);}catch(e){if(e instanceof ServiceError&&e.code==='PLATFORM_RESOURCE_MISSING')return false;throw e;}
    const ref=record(value);if(ref.name!==ciSourceRef(r)||ref.target!==r.commit||record(ref.commit).id!==r.commit)reject('CI_REF_CHANGED','Request-owned immutable source ref differs',409);return true;
  }
  async function contract(actor:Principal,r:PlatformRunRequest,signal:AbortSignal):Promise<void>{
    const file=record(await get(actor,'/repository/files/'+encodeURIComponent(binding.pipelinePath!)+'?ref='+r.commit,signal));
    if(file.file_path!==binding.pipelinePath||file.encoding!=='base64'||file.commit_id!==r.commit)reject('CI_CONTRACT_REQUIRED','Pipeline must be an exact versioned file',409);
    const bytes=fileBytes(file.content,file.size);if(sha256(bytes)!==r.workflowDigest||sha256(bytes)!=='sha256:'+String(file.content_sha256))reject('WORKFLOW_CONTENT_CHANGED','Exact CI workflow bytes changed',409);
    const document=parseDocument(bytes.toString('utf8'),{uniqueKeys:true});if(document.errors.length)reject('CI_CONTRACT_REQUIRED','Pipeline YAML must be valid',409);
    const doc=record(document.toJS({maxAliasCount:32})),rules=record(doc.workflow).rules;
    // Local workflow rules take precedence over included configuration. The
    // first matching rule must suppress automatic request-tag pipelines while
    // the API dispatch remains available (also supported by GitLab 15.0).
    if(!Array.isArray(rules)||rules.length<2||record(rules[0]).if!=='$CI_COMMIT_TAG =~ /^evopilot-runtime\\// && $CI_PIPELINE_SOURCE != "api"'||record(rules[0]).when!=='never'||Object.keys(record(rules[0])).some(k=>!['if','when'].includes(k))||record(rules[1]).if!=='$CI_PIPELINE_SOURCE == "api"'||record(rules[1]).when!=='always'||Object.keys(record(rules[1])).some(k=>!['if','when'].includes(k)))reject('CI_REF_AUTOTRIGGER','Pipeline workflow must exclude automatic request-tag triggers before allowing exact API dispatch',409);
  }
  async function correlated(actor:Principal,r:PlatformRunRequest,id:string,signal:AbortSignal):Promise<boolean>{
    const variables=await get(actor,'/pipelines/'+id+'/variables',signal);if(!Array.isArray(variables)||variables.length>1000)reject('PLATFORM_RESPONSE_INVALID','Invalid bounded pipeline variable list',502);
    return Object.entries(ciInputs(r)).every(([key,value])=>{const matches=variables.map(record).filter(v=>v.key===key);return matches.length===1&&matches[0]!.value===value&&matches[0]!.variable_type==='env_var';});
  }
  const client:PlatformClient={
    async readiness(actor,signal){try{
      const project=matchRepository(await get(actor,'',signal),binding);
      if(project.jobs_enabled!==true||(project.ci_config_path||'.gitlab-ci.yml')!==binding.pipelinePath)reject('WORKFLOW_NOT_READY','CI is disabled or its registered path differs',409);
      const branch=record(await get(actor,'/repository/branches/'+encodeURIComponent(binding.defaultBranch),signal));
      if(branch.name!==binding.defaultBranch)reject('PLATFORM_IDENTITY_CHANGED','Branch readback differs',409);
      const commit=commitId(record(branch.commit).id),path=binding.pipelinePath!;
      const file=record(await get(actor,'/repository/files/'+encodeURIComponent(path)+'?ref='+commit,signal));
      if(file.file_path!==path||file.encoding!=='base64'||file.commit_id!==commit)reject('WORKFLOW_NOT_READY','Pipeline file does not match the exact source revision',409);
      const bytes=fileBytes(file.content,file.size);if(sha256(bytes)!=='sha256:'+String(file.content_sha256))reject('WORKFLOW_CONTENT_CHANGED','Pipeline content integrity check failed',409);
      let runner:Record<string,unknown>|undefined;
      // Bound pagination, fail closed instead of mistaking a truncated list for
      // proof. A large installation should use a dedicated test project.
      for(let page=1;page<=10;page++){
        const list=await get(actor,'/runners?per_page=100&page='+page,signal);if(!Array.isArray(list)||list.length>100)reject('PLATFORM_RESPONSE_INVALID','Invalid project runner list',502);
        runner=list.map(record).find(r=>positiveId(r.id)===binding.runner);if(runner||list.length<100)break;
      }
      if(!runner||runner.active!==true||runner.paused===true||runner.online!==true||runner.status!=='online')reject('RUNNER_NOT_READY','Registered project runner is unavailable, paused or offline',409);
      return readinessResult(binding,commit,path,sha256(bytes),{id:binding.runner!,online:true});
    }catch(error){return safePlatformError(error);}},
    async job(actor,runId,jobId,commit,signal,sourceRef=binding.defaultBranch){try{
      positiveId(runId);positiveId(jobId);commitId(commit);validateSourceRef(sourceRef,binding);
      matchRepository(await get(actor,'',signal),binding);
      const pipeline=record(await get(actor,'/pipelines/'+runId,signal)),job=record(await get(actor,'/jobs/'+jobId,signal));
      if(positiveId(pipeline.id)!==runId||positiveId(pipeline.project_id)!==binding.repositoryId||pipeline.sha!==commit||pipeline.ref!==sourceRef||positiveId(job.id)!==jobId||positiveId(record(job.pipeline).id)!==runId||record(job.commit).id!==commit)reject('PLATFORM_RECEIPT_MISMATCH','GitLab observation does not match the exact repository/pipeline/job/source',409);
      return observedJob(job,runId,jobId,commit);
    }catch(error){return safePlatformError(error);}},
    async dispatch(input,permit,signal){
      const r=validateRunRequest(input,binding),actor=await executionPrincipal(r,binding,permit,signal);
      if(await ownedRef(actor,r,signal))return client.run(actor,r,null,signal);
      const ready=await client.readiness(actor,signal);if(ready.commit!==r.commit||ready.workflowDigest!==r.workflowDigest)reject('CI_SOURCE_CHANGED','Prepare the exact current source/workflow before requesting CI',409);
      await contract(actor,r,signal);const current=()=>executionPrincipal(r,binding,permit,signal);
      await post(actor,'/repository/tags',{tag_name:ciSourceRef(r),ref:r.commit},current,signal);
      if(!await ownedRef(actor,r,signal))reject('CI_REF_UNKNOWN','Inspect the original source-ref creation',409);
      const result=record(await post(actor,'/pipeline',{ref:ciSourceRef(r),variables:Object.entries(ciInputs(r)).map(([key,value])=>({key,value,variable_type:'env_var'}))},current,signal));
      return client.run(actor,r,positiveId(result.id),signal);
    },
    async artifact(actor,input,runId,signal){
      const r=validateRunRequest(input,binding),run=await client.run(actor,r,runId,signal);
      if(!['PASSED','FAILED'].includes(run.status))reject('CI_ARTIFACT_NOT_READY','Original pipeline must have a terminal observed result',409);
      const matches:Record<string,unknown>[]=[];
      for(const observed of run.jobs){const job=record(await get(actor,'/jobs/'+observed.jobId,signal));if(job.artifacts_file&&record(job.artifacts_file).filename==='runtime-ci.zip')matches.push(job);}
      if(matches.length!==1)reject('CI_ARTIFACT_AMBIGUOUS','Exactly one current runtime-ci archive is required',409);
      const job=matches[0]!,id=positiveId(job.id);observedJob(job,runId,id,r.commit);
      if(!Number.isFinite(Date.parse(String(job.artifacts_expire_at)))||Date.parse(String(job.artifacts_expire_at))<=Date.now())reject('CI_ARTIFACT_MISMATCH','Job artifact has no current retained expiry',409);
      const bytes=await download(actor,'/jobs/'+id+'/artifacts',signal);if(record(job.artifacts_file).size!==bytes.length)reject('CI_ARTIFACT_INTEGRITY','Downloaded archive differs from provider length',409);
      const current=record(await get(actor,'/jobs/'+id,signal));observedJob(current,runId,id,r.commit);
      if(record(current.artifacts_file).filename!=='runtime-ci.zip'||record(current.artifacts_file).size!==bytes.length||current.artifacts_expire_at!==job.artifacts_expire_at)reject('CI_ARTIFACT_MISMATCH','Job archive identity changed during download',409);
      await client.run(actor,r,runId,signal);
      return{provider:binding.provider,repositoryId:binding.repositoryId,requestId:r.requestId,inputDigest:r.inputDigest,bindingDigest:r.bindingDigest,commit:r.commit,runId,runStatus:run.status,artifactId:id,jobId:id,name:'runtime-ci',archiveDigest:sha256(bytes),archiveBytes:bytes.length,bytes,evidenceRef:binding.host+'/'+binding.repository+'/-/jobs/'+id+'/artifacts/download'};
    },
    async run(actor,input,knownRunId,signal){
      const r=validateRunRequest(input,binding);matchRepository(await get(actor,'',signal),binding);
      if(!await ownedRef(actor,r,signal))return runResult(binding,r,null,'UNKNOWN');
      let runId=knownRunId;
      if(runId===null){
        const matches:string[]=[];let complete=false;
        for(let page=1;page<=10;page++){const list=await get(actor,'/pipelines?ref='+encodeURIComponent(ciSourceRef(r))+'&sha='+r.commit+'&source=api&per_page=100&page='+page,signal);if(!Array.isArray(list)||list.length>100)reject('PLATFORM_RESPONSE_INVALID','Invalid bounded pipeline list',502);for(const raw of list){const p=record(raw);if(p.ref===ciSourceRef(r)&&p.sha===r.commit&&await correlated(actor,r,positiveId(p.id),signal))matches.push(positiveId(p.id));}if(list.length<100){complete=true;break;}}
        if(!complete)reject('CI_LOOKUP_INCOMPLETE','Original request lookup exceeded its bounded inventory',409);
        if(matches.length>1)reject('CI_DUPLICATE_RUNS','Multiple pipelines claim one request; inspect without redispatch',409);
        runId=matches[0]??null;if(runId===null)return runResult(binding,r,null,'UNKNOWN');
      }
      positiveId(runId);const pipeline=record(await get(actor,'/pipelines/'+runId,signal));
      if(positiveId(pipeline.id)!==runId||positiveId(pipeline.project_id)!==binding.repositoryId||pipeline.sha!==r.commit||pipeline.ref!==ciSourceRef(r)||pipeline.source!=='api'||!await correlated(actor,r,runId,signal))reject('CI_RUN_MISMATCH','Pipeline identity or correlation differs from the original request',409);
      const jobs:PlatformJobObservation[]=[],seen=new Set<string>();let complete=false;
      for(let page=1;page<=10;page++){const list=await get(actor,'/pipelines/'+runId+'/jobs?include_retried=true&per_page=100&page='+page,signal);if(!Array.isArray(list)||list.length>100)reject('PLATFORM_RESPONSE_INVALID','Invalid bounded pipeline job list',502);for(const raw of list){const job=record(raw),key=JSON.stringify([string(job.stage,128),string(job.name,512)]);if(seen.has(key))reject('CI_RUN_MISMATCH','Retried job cannot consume the original attempt',409);seen.add(key);jobs.push(observedJob(job,runId,positiveId(job.id),r.commit));}if(list.length<100){complete=true;break;}}
      if(!complete)reject('CI_LOOKUP_INCOMPLETE','Complete pipeline jobs must fit the bounded inventory',409);
      const bridges=await get(actor,'/pipelines/'+runId+'/bridges?per_page=100',signal);if(!Array.isArray(bridges)||bridges.length)reject('CI_DOWNSTREAM_UNVERIFIED','Downstream pipelines require separate exact evidence and cannot pass as local jobs',409);
      return runResult(binding,r,runId,aggregateJobs(jobs,String(pipeline.status)),jobs);
    },
  };return Object.freeze(client);
}
