import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { record, reject, ServiceError, string } from '../server/errors.js';
import type { PlatformRegistration } from './config.js';
import { aggregateJobs, ciInputs, ciRunTitle, ciSourceRef, commitId, executionPrincipal, fileBytes, jobResult, matchRepository, platformReader, positiveId, readinessResult, revisionReadinessResult, runResult, safePlatformError, sha256, validateRunRequest, validateSourceRef, type PlatformClient, type PlatformCredentialReader, type PlatformJobObservation, type PlatformRunRequest } from './platforms.js';
import type { Principal } from '../server/security.js';
import { sourceReader } from './source.js';
import { documentReader } from './documents.js';

/** GitHub.com REST observations. A successful old job is not evidence for a new
 * candidate or authority to dispatch another workflow. */
export function githubClient(configuration:PlatformRegistration,credentials:PlatformCredentialReader):PlatformClient{
  const{binding,get,post,download}=platformReader(configuration,credentials);if(binding.provider!=='github')reject('PLATFORM_MISMATCH','Expected GitHub registration');
  const workflowRoute='/actions/workflows/'+encodeURIComponent(binding.workflowPath!.split('/').at(-1)!);
  function observedJob(raw:unknown,runId:string,jobId:string,commit:string,originalAttempt:boolean):PlatformJobObservation{
    const job=record(raw);
    if(positiveId(job.id)!==jobId||positiveId(job.run_id)!==runId||job.head_sha!==commit||originalAttempt&&job.run_attempt!==1)reject('PLATFORM_RECEIPT_MISMATCH','GitHub job identity, source or attempt differs',409);
    if(!Array.isArray(job.labels)||!job.labels.includes(binding.runner))reject('PLATFORM_RECEIPT_MISMATCH','GitHub job did not select the registered runner label',409);
    let status:PlatformJobObservation['status']='UNKNOWN';
    if(job.status==='queued'||job.status==='waiting'||job.status==='pending')status='PENDING';
    else if(job.status==='in_progress')status='RUNNING';
    else if(job.status==='completed')status=job.conclusion==='success'&&typeof job.runner_id==='number'&&job.runner_id>0?'PASSED':['failure','cancelled','timed_out','action_required','startup_failure','skipped','neutral','stale'].includes(String(job.conclusion))?'FAILED':'UNKNOWN';
    return jobResult(binding,runId,jobId,commit,status,status==='UNKNOWN'?'unknown':String(job.status)+':'+(job.status==='completed'?String(job.conclusion):'pending'),typeof job.runner_id==='number'&&job.runner_id>0?positiveId(job.runner_id):null);
  }
  async function ownedRef(actor:Principal,r:PlatformRunRequest,signal:AbortSignal):Promise<boolean>{
    let value:unknown;try{value=await get(actor,'/git/ref/tags/'+ciSourceRef(r),signal);}catch(e){if(e instanceof ServiceError&&e.code==='PLATFORM_RESOURCE_MISSING')return false;throw e;}
    const ref=record(value);if(ref.ref!=='refs/tags/'+ciSourceRef(r)||record(ref.object).type!=='commit'||record(ref.object).sha!==r.commit)reject('CI_REF_CHANGED','Request-owned immutable source ref differs',409);return true;
  }
  async function workflowDocument(actor:Principal,path:string,r:PlatformRunRequest,signal:AbortSignal):Promise<Record<string,unknown>>{
    const file=record(await get(actor,'/contents/'+path+'?ref='+r.commit,signal));
    if(file.type!=='file'||file.path!==path||file.encoding!=='base64')reject('CI_CONTRACT_REQUIRED','CI workflow must be an exact versioned file',409);
    const bytes=fileBytes(file.content,file.size);if(file.sha!==createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex')||path===binding.workflowPath&&sha256(bytes)!==r.workflowDigest)reject('WORKFLOW_CONTENT_CHANGED','Exact CI workflow bytes changed',409);
    const doc=parseDocument(bytes.toString('utf8'),{uniqueKeys:true});if(doc.errors.length)reject('CI_CONTRACT_REQUIRED','CI workflow is not valid YAML',409);return record(doc.toJS({maxAliasCount:32}));
  }
  async function contract(actor:Principal,r:PlatformRunRequest,signal:AbortSignal):Promise<void>{
    const files=await get(actor,'/contents/.github/workflows?ref='+r.commit,signal);
    if(!Array.isArray(files)||files.length>64)reject('CI_CONTRACT_REQUIRED','A bounded complete workflow inventory is required',409);
    let selected=false;
    for(const raw of files){const file=record(raw),path=string(file.path,512);if(!/\.ya?ml$/.test(path))continue;
      if(!/^\.github\/workflows\/[-A-Za-z0-9_.]+\.ya?ml$/.test(path)||file.type!=='file')reject('CI_CONTRACT_REQUIRED','Workflow inventory contains unsupported entries',409);
      const doc=await workflowDocument(actor,path,r,signal),events=doc.on;
      if(typeof events==='string'&&['create','push'].includes(events)||Array.isArray(events)&&events.some(e=>['create','push'].includes(String(e))))reject('CI_REF_AUTOTRIGGER','Request-owned source refs must not auto-trigger CI',409);
      if(events&&typeof events==='object'&&!Array.isArray(events)){
        const on=record(events);if(Object.hasOwn(on,'create'))reject('CI_REF_AUTOTRIGGER','create-event workflows cannot safely isolate Runtime source refs',409);
        if(Object.hasOwn(on,'push')){const push=on.push===null?{}:record(on.push);const branchOnly=Array.isArray(push.branches)&&push.branches.length>0&&!Object.hasOwn(push,'tags')&&!Object.hasOwn(push,'tags-ignore');const ignored=Array.isArray(push['tags-ignore'])&&push['tags-ignore'].includes('evopilot-runtime/**');if(!branchOnly&&!ignored)reject('CI_REF_AUTOTRIGGER','Push workflows must exclude request-owned source tags',409);}
      }
      if(path!==binding.workflowPath)continue;selected=true;
      const dispatch=record(record(events).workflow_dispatch),inputs=record(dispatch.inputs);
      for(const name of Object.keys(ciInputs(r))){const input=record(inputs[name]);if(input.type!=='string'||input.required!==true)reject('CI_CONTRACT_REQUIRED','Runtime workflow requires its fixed string correlation inputs',409);}
      for(const [name,rawInput]of Object.entries(inputs)){const input=record(rawInput);if(!Object.hasOwn(ciInputs(r),name)&&input.required===true&&!Object.hasOwn(input,'default'))reject('CI_CONTRACT_REQUIRED','Unsupported required workflow input',409);}
      if(doc['run-name']!=='evopilot:${{ inputs.runtime_request_id }}:${{ inputs.runtime_input_digest }}')reject('CI_CONTRACT_REQUIRED','Workflow must expose the exact request correlation title',409);
    }
    if(!selected)reject('CI_CONTRACT_REQUIRED','Registered workflow is missing from the fixed inventory',409);
  }
  async function ready(actor:Principal,signal:AbortSignal,requestedCommit?:string){try{
      matchRepository(await get(actor,'',signal),binding);
      const branch=record(await get(actor,'/branches/'+encodeURIComponent(binding.defaultBranch),signal));
      if(branch.name!==binding.defaultBranch)reject('PLATFORM_IDENTITY_CHANGED','Branch readback differs',409);
      const branchHeadCommit=commitId(record(branch.commit).sha),commit=requestedCommit===undefined?branchHeadCommit:commitId(requestedCommit),path=binding.workflowPath!;
      if(requestedCommit!==undefined&&record(await get(actor,'/commits/'+commit,signal)).sha!==commit)reject('CI_SOURCE_CHANGED','Exact source commit is unavailable in the registered repository',409);
      const workflow=record(await get(actor,'/actions/workflows/'+encodeURIComponent(path.split('/').at(-1)!),signal));
      if(workflow.path!==path||workflow.state!=='active')reject('WORKFLOW_NOT_READY','Registered workflow is absent or disabled',409);
      const file=record(await get(actor,'/contents/'+path+'?ref='+commit,signal));
      if(file.type!=='file'||file.path!==path||file.encoding!=='base64')reject('WORKFLOW_NOT_READY','Registered workflow is not a versioned file',409);
      const bytes=fileBytes(file.content,file.size),blob=createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');
      if(file.sha!==blob)reject('WORKFLOW_CONTENT_CHANGED','Workflow blob integrity check failed',409);
      const document=parseDocument(bytes.toString('utf8'),{uniqueKeys:true});if(document.errors.length)reject('WORKFLOW_NOT_READY','Workflow YAML could not be inspected',409);
      const jobs=record(record(document.toJS({maxAliasCount:32})).jobs);
      const matches=Object.values(jobs).some(raw=>{const job=record(raw),labels=job['runs-on'];return labels===binding.runner||Array.isArray(labels)&&labels.includes(binding.runner);});
      if(!matches)reject('RUNNER_NOT_READY','Registered runner label is not present in a concrete workflow job',409);
      // Hosted capacity is established by an actual job, not by configuration.
      return{observation:readinessResult(binding,commit,path,sha256(bytes),{id:'label:'+binding.runner,online:null}),branchHeadCommit};
    }catch(error){return safePlatformError(error);}}
  const client:PlatformClient={
    source:sourceReader(binding,get),documents:documentReader(binding,get),
    async readiness(actor,signal){return(await ready(actor,signal)).observation;},
    async revision(actor,commit,signal){commitId(commit);const r=await ready(actor,signal,commit);return revisionReadinessResult(r.observation,r.branchHeadCommit);},
    async job(actor,runId,jobId,commit,signal,sourceRef=binding.defaultBranch){try{
      positiveId(runId);positiveId(jobId);commitId(commit);validateSourceRef(sourceRef,binding);
      matchRepository(await get(actor,'',signal),binding);
      const run=record(await get(actor,'/actions/runs/'+runId,signal)),job=record(await get(actor,'/actions/jobs/'+jobId,signal));
      if(positiveId(run.id)!==runId||positiveId(record(run.repository).id)!==binding.repositoryId||run.head_sha!==commit||run.head_branch!==sourceRef||run.path!==binding.workflowPath||positiveId(job.id)!==jobId||positiveId(job.run_id)!==runId||job.head_sha!==commit)reject('PLATFORM_RECEIPT_MISMATCH','GitHub observation does not match the exact repository/workflow/run/job/source',409);
      return observedJob(job,runId,jobId,commit,sourceRef!==binding.defaultBranch);
    }catch(error){return safePlatformError(error);}},
    async dispatch(input,permit,signal){
      const r=validateRunRequest(input,binding),actor=await executionPrincipal(r,binding,permit,signal);
      if(await ownedRef(actor,r,signal))return client.run(actor,r,null,signal);
      const ready=await client.revision(actor,r.commit,signal);if(ready.commit!==r.commit||ready.workflowDigest!==r.workflowDigest||ready.bindingDigest!==r.bindingDigest)reject('CI_SOURCE_CHANGED','Exact requested source/workflow differs from its retained plan',409);
      await contract(actor,r,signal);
      const current=()=>executionPrincipal(r,binding,permit,signal);
      await post(actor,'/git/refs',{ref:'refs/tags/'+ciSourceRef(r),sha:r.commit},current,signal);
      if(!await ownedRef(actor,r,signal))reject('CI_REF_UNKNOWN','Inspect the original source-ref creation',409);
      const result=await post(actor,workflowRoute+'/dispatches',{ref:ciSourceRef(r),inputs:ciInputs(r),return_run_details:true},current,signal);
      const runId=result===null?null:positiveId(record(result).workflow_run_id);
      return client.run(actor,r,runId,signal);
    },
    async artifact(actor,input,runId,signal){
      const r=validateRunRequest(input,binding),run=await client.run(actor,r,runId,signal);
      if(!['PASSED','FAILED'].includes(run.status))reject('CI_ARTIFACT_NOT_READY','Original workflow must have a terminal observed result',409);
      const matches:Record<string,unknown>[]=[];let complete=false;
      for(let page=1;page<=10;page++){const value=record(await get(actor,'/actions/runs/'+runId+'/artifacts?per_page=100&page='+page,signal));if(!Array.isArray(value.artifacts)||value.artifacts.length>100)reject('PLATFORM_RESPONSE_INVALID','Invalid bounded artifact inventory',502);for(const raw of value.artifacts){const a=record(raw);if(a.name==='runtime-ci')matches.push(a);}if(value.artifacts.length<100){complete=true;break;}}
      if(!complete||matches.length!==1)reject('CI_ARTIFACT_AMBIGUOUS','Exactly one current runtime-ci archive is required',409);
      const a=matches[0]!,workflow=record(a.workflow_run),id=positiveId(a.id);
      if(a.expired!==false||!Number.isFinite(Date.parse(String(a.expires_at)))||Date.parse(String(a.expires_at))<=Date.now()||positiveId(workflow.id)!==runId||positiveId(workflow.repository_id)!==binding.repositoryId||workflow.head_sha!==r.commit||workflow.head_branch!==ciSourceRef(r)||!/^sha256:[a-f0-9]{64}$/.test(String(a.digest)))reject('CI_ARTIFACT_MISMATCH','Artifact metadata is stale or belongs to another workflow/source',409);
      const bytes=await download(actor,'/actions/artifacts/'+id+'/zip',signal),digest=sha256(bytes);
      if(digest!==a.digest||a.size_in_bytes!==bytes.length)reject('CI_ARTIFACT_INTEGRITY','Downloaded archive differs from provider digest/length',409);
      const current=record(await get(actor,'/actions/artifacts/'+id,signal));if(current.expired!==false||current.digest!==a.digest||current.size_in_bytes!==a.size_in_bytes||current.name!==a.name||positiveId(record(current.workflow_run).id)!==runId)reject('CI_ARTIFACT_MISMATCH','Artifact identity changed during download',409);
      await client.run(actor,r,runId,signal);
      return{provider:binding.provider,repositoryId:binding.repositoryId,requestId:r.requestId,inputDigest:r.inputDigest,bindingDigest:r.bindingDigest,commit:r.commit,runId,runStatus:run.status,artifactId:id,jobId:null,name:'runtime-ci',archiveDigest:digest,archiveBytes:bytes.length,bytes,evidenceRef:binding.host+'/'+binding.repository+'/actions/runs/'+runId+'/artifacts/'+id};
    },
    async run(actor,input,knownRunId,signal){
      const r=validateRunRequest(input,binding);matchRepository(await get(actor,'',signal),binding);
      if(!await ownedRef(actor,r,signal))return runResult(binding,r,null,'UNKNOWN');
      let runId=knownRunId;
      if(runId===null){
        const matches:string[]=[];let complete=false;
        for(let page=1;page<=10;page++){const result=record(await get(actor,workflowRoute+'/runs?event=workflow_dispatch&head_sha='+r.commit+'&per_page=100&page='+page,signal));if(!Array.isArray(result.workflow_runs)||result.workflow_runs.length>100)reject('PLATFORM_RESPONSE_INVALID','Invalid bounded workflow run list',502);for(const raw of result.workflow_runs){const run=record(raw);if(run.head_branch===ciSourceRef(r)&&run.display_title===ciRunTitle(r))matches.push(positiveId(run.id));}if(result.workflow_runs.length<100){complete=true;break;}}
        if(!complete)reject('CI_LOOKUP_INCOMPLETE','Original request lookup exceeded its bounded inventory',409);
        if(matches.length>1)reject('CI_DUPLICATE_RUNS','Multiple workflows claim one exact request; inspect without redispatch',409);
        runId=matches[0]??null;if(runId===null)return runResult(binding,r,null,'UNKNOWN');
      }
      positiveId(runId);const run=record(await get(actor,'/actions/runs/'+runId,signal));
      if(positiveId(run.id)!==runId||positiveId(record(run.repository).id)!==binding.repositoryId||run.event!=='workflow_dispatch'||run.head_branch!==ciSourceRef(r)||run.head_sha!==r.commit||run.path!==binding.workflowPath||run.display_title!==ciRunTitle(r)||run.run_attempt!==1)reject('CI_RUN_MISMATCH','Workflow identity, attempt or correlation differs from the original request',409);
      const jobs:PlatformJobObservation[]=[];let complete=false;
      for(let page=1;page<=10;page++){const value=record(await get(actor,'/actions/runs/'+runId+'/jobs?filter=all&per_page=100&page='+page,signal));if(!Array.isArray(value.jobs)||value.jobs.length>100)reject('PLATFORM_RESPONSE_INVALID','Invalid workflow job list',502);for(const raw of value.jobs){const job=record(raw);if(job.run_attempt!==1)reject('CI_RUN_MISMATCH','Rerun job cannot consume the original attempt',409);jobs.push(observedJob(job,runId,positiveId(job.id),r.commit,true));}if(value.jobs.length<100){complete=true;break;}}
      if(!complete)reject('CI_LOOKUP_INCOMPLETE','Complete workflow jobs must fit the bounded inventory',409);
      return runResult(binding,r,runId,aggregateJobs(jobs,String(run.status==='completed'?run.conclusion:run.status)),jobs);
    },
  };return Object.freeze(client);
}
