import { createHash } from 'node:crypto';
import { canonical, exact, record, reject, ServiceError, string } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import { valueDigest } from '../lifecycle/base.js';
import { validatePlatformRegistration, type PlatformRegistration } from './config.js';
import { containsInlineSecret } from '../lifecycle/compiler.js';
import { MAX_ARCHIVE_BYTES, validateCandidateInput, type CandidateInput } from './artifacts.js';
import type { SourceRequest, SourceObservation } from './source.js';
import type { ReleaseDocument, DocumentObservation } from './documents.js';
import type { SourceTreeObservation } from './source-tree.js';
import { validatePublicationInput, type PublicationInput, type DistributionRequest, type DistributionObservation } from './distribution.js';

/** Trusted process credential resolution; never provided by a lifecycle/API. */
export type PlatformCredentialReader=(binding:PlatformRegistration,actor:Principal,signal:AbortSignal)=>Promise<string>;
export interface PlatformReadiness {
  schema:'runtime-platform-readiness/v1'; provider:'github'|'gitlab'; projectId:string;
  bindingRef:string; bindingDigest:string; repositoryId:string; repository:string;
  branch:string; commit:string; workflowPath:string; workflowDigest:string;
  runner:{id:string;online:boolean|null}|null;
  evidenceRef:string; observedAt:string; expiresAt:string; factsDigest:string;
  executionAuthorized:false; workflowExecuted:false;
}
export interface PlatformJobObservation {
  schema:'runtime-platform-job-observation/v1'; provider:'github'|'gitlab'; projectId:string;
  repositoryId:string; runId:string; jobId:string; commit:string;
  status:'PENDING'|'RUNNING'|'PASSED'|'FAILED'|'UNKNOWN'; providerStatus:string;
  runnerId:string|null; evidenceRef:string; observedAt:string; factsDigest:string;
  artifactsVerified:false; lifecycleAcceptance:false;
}
export interface PlatformRevisionReadiness extends PlatformReadiness {sourceSelection:'exact-commit';branchHeadCommit:string;}
export interface PlatformClient {
  sourceTree(actor:Principal,request:{commit:string},signal:AbortSignal):Promise<SourceTreeObservation>;
  distribution(actor:Principal,request:DistributionRequest,signal:AbortSignal):Promise<DistributionObservation>;
  documents(actor:Principal,request:{commit:string;documents:ReleaseDocument[]},signal:AbortSignal):Promise<DocumentObservation>;
  source(actor:Principal,request:SourceRequest,signal:AbortSignal):Promise<SourceObservation>;
  readiness(actor:Principal,signal:AbortSignal):Promise<PlatformReadiness>;
  revision(actor:Principal,commit:string,signal:AbortSignal):Promise<PlatformRevisionReadiness>;
  job(actor:Principal,runId:string,jobId:string,commit:string,signal:AbortSignal,sourceRef?:string):Promise<PlatformJobObservation>;
  dispatch(request:PlatformRunRequest,permit:PlatformExecutionPermit,signal:AbortSignal):Promise<PlatformRunObservation>;
  run(actor:Principal,request:PlatformRunRequest,runId:string|null,signal:AbortSignal):Promise<PlatformRunObservation>;
  artifact(actor:Principal,request:PlatformRunRequest,runId:string,signal:AbortSignal):Promise<PlatformArtifactArchive>;
}
export interface PlatformArtifactArchive {
  provider:'github'|'gitlab'; repositoryId:string; requestId:string; inputDigest:string; bindingDigest:string;
  commit:string; runId:string; runStatus:PlatformJobObservation['status'];
  artifactId:string; jobId:string|null; name:'runtime-ci'; archiveDigest:string;
  archiveBytes:number; bytes:Buffer; evidenceRef:string;
}
export interface PlatformRunRequest {
  schema:'runtime-ci-request/v1'; requestId:string; projectId:string; bindingDigest:string;
  commit:string; workflowDigest:string; inputDigest:string; stageId:string;
  candidateDigest:string|null; requestedAt:string; deadlineAt:string;
  candidateInput?:CandidateInput;
  publicationInput?:PublicationInput;
}
export type PlatformExecutionPermit=(request:PlatformRunRequest)=>Promise<Principal>;
export interface PlatformRunObservation {
  schema:'runtime-ci-observation/v1'; requestId:string; inputDigest:string; provider:'github'|'gitlab';
  repositoryId:string; ref:string; commit:string; runId:string|null;
  status:PlatformJobObservation['status']; jobs:PlatformJobObservation[]; evidenceRef:string;
  observedAt:string; factsDigest:string; artifactsVerified:false; lifecycleAcceptance:false;
}
export function validateRunRequest(value:PlatformRunRequest,binding:PlatformRegistration):PlatformRunRequest{
  const r=record(value);exact(r,['schema','requestId','projectId','bindingDigest','commit','workflowDigest','inputDigest','stageId','candidateDigest','requestedAt','deadlineAt'],['candidateInput','publicationInput']);
  if(r.schema!=='runtime-ci-request/v1'||r.projectId!==binding.projectId||r.bindingDigest!==valueDigest(binding)||!/^[-a-z0-9]{1,64}$/.test(string(r.requestId,64)))reject('CI_REQUEST_MISMATCH','CI request does not match this exact registered scope');
  commitId(r.commit);for(const k of ['workflowDigest','inputDigest'])if(!/^sha256:[a-f0-9]{64}$/.test(string(r[k],71)))reject('CI_REQUEST_MISMATCH','CI request must pin exact workflow and stage input');
  if(r.candidateDigest!==null&&!/^sha256:[a-f0-9]{64}$/.test(string(r.candidateDigest,71)))reject('CI_REQUEST_MISMATCH','CI candidate must be exact');
  if(r.stageId==='verification'&&r.candidateDigest===null||r.candidateDigest!==null&&!value.candidateInput)reject('CI_CANDIDATE_INPUT_REQUIRED','Candidate verification requires its original archive and manifest',409);
  if(value.candidateInput){if(r.candidateDigest===null)reject('CI_CANDIDATE_INPUT_INVALID','Candidate input requires an existing candidate',409);validateCandidateInput(value.candidateInput,value,binding.provider,binding.repositoryId);}
  if(r.stageId==='publication'&&!value.publicationInput)reject('PUBLICATION_INPUT','Publication requires its exact reviewed channel and documents',409);
  if(value.publicationInput)validatePublicationInput(value.publicationInput,value,binding.provider);
  if(!/^(?:scope|plan|implementation|candidate|verification|release-decision|publication|closure|project\.[a-z][a-z0-9-]{0,62})$/.test(string(r.stageId,80))||!Number.isFinite(Date.parse(string(r.requestedAt,64)))||!Number.isFinite(Date.parse(string(r.deadlineAt,64)))||Date.parse(String(r.deadlineAt))<=Date.parse(String(r.requestedAt))||containsInlineSecret(canonical(r)))reject('CI_REQUEST_MISMATCH','Invalid exact CI stage/time metadata');
  return Object.freeze({...value});
}
/** Request-owned tag: never a product version, force update, moving branch or
 * release. Creation and dispatch are both covered by the retained action plan. */
export const ciSourceRef=(r:PlatformRunRequest):string=>'evopilot-runtime/'+r.requestId;
export const ciRunTitle=(r:PlatformRunRequest):string=>'evopilot:'+r.requestId+':'+r.inputDigest;
export const ciInputs=(r:PlatformRunRequest):Record<string,string>=>({runtime_request_id:r.requestId,runtime_input_digest:r.inputDigest,runtime_source_commit:r.commit,runtime_stage:r.stageId,runtime_candidate_digest:r.candidateDigest??'none',runtime_workflow_digest:r.workflowDigest,runtime_binding_digest:r.bindingDigest,runtime_candidate_input:r.candidateInput?canonical(r.candidateInput):'none',...(r.publicationInput?{runtime_publication_input:canonical(r.publicationInput)}:{})});
export function validateSourceRef(ref:string,binding:PlatformRegistration):void{if(ref!==binding.defaultBranch&&!/^evopilot-runtime\/[-a-z0-9]{1,64}$/.test(ref))reject('CI_REF_SCOPE','Only the registered branch or a request-owned source ref is supported');}
export function aggregateJobs(jobs:PlatformJobObservation[],providerStatus:string):PlatformJobObservation['status']{
  if(jobs.some(j=>j.status==='FAILED')||['failure','failed','cancelled','canceled','timed_out','skipped','neutral'].includes(providerStatus))return'FAILED';
  if(providerStatus==='success')return jobs.length&&jobs.every(j=>j.status==='PASSED')?'PASSED':'UNKNOWN';
  if(['in_progress','running'].includes(providerStatus)||jobs.some(j=>j.status==='RUNNING'))return'RUNNING';
  return['queued','pending','created','waiting','waiting_for_resource','preparing','scheduled','manual','requested'].includes(providerStatus)?'PENDING':'UNKNOWN';
}
async function bounded<T>(work:()=>Promise<T>,signal:AbortSignal):Promise<T>{
  signal.throwIfAborted();let onAbort:()=>void=()=>{};
  try{return await Promise.race([work(),new Promise<never>((_resolve,reject)=>{onAbort=()=>reject(new Error('Platform operation expired'));signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();})]);}finally{signal.removeEventListener('abort',onAbort);}
}
export async function executionPrincipal(r:PlatformRunRequest,binding:PlatformRegistration,permit:PlatformExecutionPermit,signal:AbortSignal):Promise<Principal>{
  if(Date.parse(r.deadlineAt)<=Date.now())reject('CI_DISPATCH_EXPIRED','The original CI dispatch deadline expired',409);
  let actor:Principal;try{actor=await bounded(()=>permit(r),AbortSignal.any([signal,AbortSignal.timeout(10000)]));}catch(error){return safePlatformError(error);}
  authorize(actor,binding.projectId,'execution.request');if(r.stageId==='publication')authorize(actor,binding.projectId,'release.request');
  if(Date.parse(r.deadlineAt)<=Date.now())reject('CI_DISPATCH_EXPIRED','The original CI dispatch deadline expired',409);return actor;
}
export function runResult(binding:PlatformRegistration,r:PlatformRunRequest,runId:string|null,status:PlatformRunObservation['status'],jobs:PlatformJobObservation[]=[]):PlatformRunObservation{
  const facts={requestId:r.requestId,inputDigest:r.inputDigest,provider:binding.provider,repositoryId:binding.repositoryId,ref:ciSourceRef(r),commit:r.commit,runId,status,jobs};
  return{schema:'runtime-ci-observation/v1',...facts,evidenceRef:binding.host+'/'+binding.repository+(runId?(binding.provider==='github'?'/actions/runs/':'/-/pipelines/')+runId:''),observedAt:new Date().toISOString(),factsDigest:valueDigest(facts),artifactsVerified:false,lifecycleAcceptance:false};
}
export function positiveId(value:unknown):string{
  const id=typeof value==='number'&&Number.isSafeInteger(value)?String(value):string(value,20);
  if(!/^[1-9][0-9]{0,19}$/.test(id))reject('PLATFORM_RESPONSE_INVALID','Invalid platform numeric identity',502);return id;
}
export function commitId(value:unknown):string{
  const id=string(value,64);if(!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(id))reject('PLATFORM_RESPONSE_INVALID','Invalid immutable source identity',502);return id;
}
export function fileBytes(encoded:unknown,size:unknown):Buffer{
  if(typeof encoded!=='string'||encoded.length>1400000||/[^A-Za-z0-9+/=\r\n]/.test(encoded))reject('PLATFORM_RESPONSE_INVALID','Invalid bounded base64 workflow content',502);
  const content=encoded.replace(/[\r\n]/g,'');
  if(!Number.isSafeInteger(size)||Number(size)<1||Number(size)>1048576||!/^[A-Za-z0-9+/]*={0,2}$/.test(content))reject('PLATFORM_RESPONSE_INVALID','Invalid bounded workflow content',502);
  const bytes=Buffer.from(content,'base64');if(bytes.length!==size||bytes.toString('base64')!==content)reject('PLATFORM_RESPONSE_INVALID','Workflow content encoding/size differs',502);return bytes;
}
export const sha256=(bytes:Buffer):string=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
export function safePlatformError(error:unknown):never{
  if(error instanceof ServiceError)throw error;
  return reject('PLATFORM_UNAVAILABLE','Platform observation did not complete; no execution or release authority is inferred',503);
}
/** Only fixed provider route builders call this transport. No redirects, remote
 * URL input, automatic retries, error-body echo or credential logging. */
export function platformReader(registration:PlatformRegistration,credentials:PlatformCredentialReader){
  const binding=validatePlatformRegistration(registration);
  const origin=binding.provider==='github'?'https://api.github.com':binding.host;
  const prefix=binding.provider==='github'?'/repos/'+binding.repository:'/api/v4/projects/'+binding.repositoryId;
  async function request(actor:Principal,suffix:string,signal:AbortSignal,payload?:Record<string,unknown>,permit?:()=>Promise<Principal>):Promise<unknown>{
    authorize(actor,binding.projectId,'read');if(Date.parse(binding.expiresAt)<=Date.now())reject('PLATFORM_NOT_REGISTERED','Platform registration has expired',409);
    const exactComparison=binding.provider==='github'&&/^\/compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}\?per_page=1$/.test(suffix);
    if(suffix!==''&&!suffix.startsWith('/')||suffix.includes('..')&&!exactComparison||suffix.includes('#')||/[\u0000-\u0020\\]/.test(suffix))reject('INVALID_PLATFORM_ROUTE','Invalid fixed platform route');
    const controller=AbortSignal.any([signal,AbortSignal.timeout(10000)]);
    try{
      controller.throwIfAborted();
      const token=await bounded(()=>credentials(binding,actor,controller),controller);
      controller.throwIfAborted();
      if(!/^[A-Za-z0-9_.-]{16,4096}$/.test(token))reject('UNSAFE_PLATFORM_CREDENTIAL','Invalid scoped credential',503);
      const headers:Record<string,string>=binding.provider==='github'?{authorization:'Bearer '+token,accept:'application/vnd.github+json','x-github-api-version':'2022-11-28'}:{'private-token':token,accept:'application/json'};
      if(payload!==undefined){
        if(!permit)reject('CI_AUTHORITY_REQUIRED','Writes require an exact current execution permit',403);
        const allowed=binding.provider==='github'?['/git/refs','/actions/workflows/'+encodeURIComponent(binding.workflowPath!.split('/').at(-1)!)+'/dispatches']:['/repository/tags','/pipeline'];
        if(!allowed.includes(suffix)||containsInlineSecret(canonical(payload)))reject('INVALID_PLATFORM_ROUTE','Only fixed CI source-ref/dispatch writes are supported');
        const fresh=await bounded(permit,controller);authorize(fresh,binding.projectId,'execution.request');if(fresh.id!==actor.id||fresh.revision!==actor.revision)reject('AUTHORITY_CHANGED','CI execution principal changed before dispatch',409);
        headers['content-type']='application/json';controller.throwIfAborted();
      }
      const response=await fetch(origin+prefix+suffix,{headers,redirect:'error',signal:controller,...(payload===undefined?{}:{method:'POST',body:canonical(payload)})});
      if(!response.ok){await response.body?.cancel();reject(response.status===401||response.status===403?'PLATFORM_PERMISSION_DENIED':response.status===404?'PLATFORM_RESOURCE_MISSING':'PLATFORM_HTTP_FAILURE','Platform rejected the scoped observation',response.status===401||response.status===403?403:502);}
      if(response.status===204&&payload!==undefined){await response.body?.cancel();return null;}
      if(!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??'')){await response.body?.cancel();reject('PLATFORM_RESPONSE_INVALID','Expected provider JSON',502);}
      const reader=response.body?.getReader();if(!reader)reject('PLATFORM_RESPONSE_INVALID','Missing platform response body',502);
      let length=0;const chunks:Buffer[]=[];
      try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>2097152){await reader.cancel();reject('PLATFORM_RESPONSE_LIMIT','Platform response exceeds 2 MiB',502);}chunks.push(Buffer.from(part.value));}}finally{reader.releaseLock();}
      const value=JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      // Return only to the fixed adapter. Public results are an explicit projection.
      authorize(actor,binding.projectId,'read');controller.throwIfAborted();return value;
    }catch(error){if(payload!==undefined&&!(error instanceof ServiceError))reject('CI_DISPATCH_OUTCOME_UNKNOWN','Inspect the original CI request; do not dispatch it again',409);return safePlatformError(error);}
  }
  async function download(actor:Principal,suffix:string,signal:AbortSignal):Promise<Buffer>{
    authorize(actor,binding.projectId,'read');if(Date.parse(binding.expiresAt)<=Date.now())reject('PLATFORM_NOT_REGISTERED','Platform registration has expired',409);
    const releaseAsset=binding.provider==='github'&&/^\/releases\/assets\/[1-9][0-9]{0,19}$/.test(suffix),packageFile=binding.provider==='gitlab'&&/^\/packages\/generic\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9](?:[A-Za-z0-9._-]|%2B){0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(suffix)&&!suffix.includes('..');
    if(!releaseAsset&&!packageFile&&!(binding.provider==='github'?/^\/actions\/artifacts\/[1-9][0-9]{0,19}\/zip$/:/^\/jobs\/[1-9][0-9]{0,19}\/artifacts$/).test(suffix))reject('INVALID_PLATFORM_ROUTE','Only an exact provider artifact or registered distribution file can be downloaded');
    const controller=AbortSignal.any([signal,AbortSignal.timeout(30000)]);
    try{
      const token=await bounded(()=>credentials(binding,actor,controller),AbortSignal.any([controller,AbortSignal.timeout(10000)]));
      if(!/^[A-Za-z0-9_.-]{16,4096}$/.test(token))reject('UNSAFE_PLATFORM_CREDENTIAL','Invalid scoped credential',503);
      const headers:Record<string,string>=binding.provider==='github'?{authorization:'Bearer '+token,'x-github-api-version':'2022-11-28',...(releaseAsset?{accept:'application/octet-stream'}:{})}:{'private-token':token};
      controller.throwIfAborted();let response=await fetch(origin+prefix+suffix,{headers,redirect:'manual',signal:controller});
      if(response.status===302){
        const location=response.headers.get('location')??'';await response.body?.cancel();let url:URL;try{url=new URL(location);}catch{return reject('CI_ARTIFACT_REDIRECT','Artifact redirect is not a valid provider location',502);}
        // GitHub's authenticated API returns a short-lived signed blob URL.
        // Never forward a credential, echo that URL or follow another redirect.
        const trustedStorage=releaseAsset?url.hostname==='release-assets.githubusercontent.com':/^[a-z0-9-]+\.blob\.core\.windows\.net$/.test(url.hostname)||/^(?:[a-z0-9-]+\.)?actions\.githubusercontent\.com$/.test(url.hostname);
        if(binding.provider!=='github'||location.length>16384||url.protocol!=='https:'||url.port||url.username||url.password||url.hash||!trustedStorage)reject('CI_ARTIFACT_REDIRECT','Artifact redirect leaves the supported provider storage boundary',502);
        controller.throwIfAborted();response=await fetch(url,{redirect:'error',signal:controller});
      }
      if(response.status!==200){await response.body?.cancel();reject('CI_ARTIFACT_UNAVAILABLE','Exact artifact download did not succeed',409);}
      const declared=response.headers.get('content-length');if(declared!==null&&(!/^[0-9]+$/.test(declared)||Number(declared)>MAX_ARCHIVE_BYTES)){await response.body?.cancel();reject('CI_ARCHIVE_LIMIT','Artifact transfer exceeds the bounded profile',409);}
      const reader=response.body?.getReader();if(!reader)reject('CI_ARTIFACT_UNAVAILABLE','Artifact download has no body',502);
      const chunks:Buffer[]=[];let length=0;try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>MAX_ARCHIVE_BYTES){await reader.cancel();reject('CI_ARCHIVE_LIMIT','Artifact transfer exceeds the bounded profile',409);}chunks.push(Buffer.from(part.value));}}finally{reader.releaseLock();}
      if(declared!==null&&Number(declared)!==length)reject('CI_ARTIFACT_INTEGRITY','Artifact transfer length differs from its response',409);
      controller.throwIfAborted();authorize(actor,binding.projectId,'read');return Buffer.concat(chunks);
    }catch(e){if(e instanceof ServiceError)throw e;return reject('CI_ARTIFACT_UNAVAILABLE','Exact artifact transfer did not complete',503);}
  }
  return{binding,get:(actor:Principal,suffix:string,signal:AbortSignal)=>request(actor,suffix,signal),post:(actor:Principal,suffix:string,payload:Record<string,unknown>,permit:()=>Promise<Principal>,signal:AbortSignal)=>request(actor,suffix,signal,payload,permit),download};
}
export function readinessResult(binding:PlatformRegistration,commit:string,path:string,workflowDigest:string,runner:PlatformReadiness['runner']):PlatformReadiness{
  const facts={provider:binding.provider,projectId:binding.projectId,bindingRef:binding.ref,bindingDigest:valueDigest(binding),repositoryId:binding.repositoryId,repository:binding.repository,branch:binding.defaultBranch,commit,workflowPath:path,workflowDigest,runner};
  const now=Date.now();return{schema:'runtime-platform-readiness/v1',...facts,evidenceRef:binding.host+'/'+binding.repository,observedAt:new Date(now).toISOString(),expiresAt:new Date(Math.min(now+60000,Date.parse(binding.expiresAt))).toISOString(),factsDigest:valueDigest(facts),executionAuthorized:false,workflowExecuted:false};
}
export function revisionReadinessResult(observation:PlatformReadiness,branchHeadCommit:string):PlatformRevisionReadiness{
  commitId(branchHeadCommit);const{schema,observedAt,expiresAt,evidenceRef,executionAuthorized,workflowExecuted,factsDigest,...facts}=observation;
  const selected={...facts,sourceSelection:'exact-commit' as const,branchHeadCommit};
  return{...observation,...selected,factsDigest:valueDigest(selected)};
}
export function jobResult(binding:PlatformRegistration,runId:string,jobId:string,commit:string,status:PlatformJobObservation['status'],providerStatus:string,runnerId:string|null):PlatformJobObservation{
  string(providerStatus,128);const facts={provider:binding.provider,projectId:binding.projectId,repositoryId:binding.repositoryId,runId,jobId,commit,status,providerStatus,runnerId};
  return{schema:'runtime-platform-job-observation/v1',...facts,evidenceRef:binding.host+'/'+binding.repository+(binding.provider==='github'?'/actions/runs/'+runId:'/-/jobs/'+jobId),observedAt:new Date().toISOString(),factsDigest:valueDigest(facts),artifactsVerified:false,lifecycleAcceptance:false};
}
export function matchRepository(actual:unknown,binding:PlatformRegistration):Record<string,unknown>{
  const r=record(actual),path=r.full_name??r.path_with_namespace;
  if(positiveId(r.id)!==binding.repositoryId||path!==binding.repository||r.default_branch!==binding.defaultBranch||r.archived!==false)reject('PLATFORM_IDENTITY_CHANGED','Repository identity, branch or archived state differs from its registered scope',409);return r;
}
