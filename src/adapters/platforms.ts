import { createHash } from 'node:crypto';
import { record, reject, ServiceError, string } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import { valueDigest } from '../lifecycle/base.js';
import { validatePlatformRegistration, type PlatformRegistration } from './config.js';

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
export interface PlatformClient {
  readiness(actor:Principal,signal:AbortSignal):Promise<PlatformReadiness>;
  job(actor:Principal,runId:string,jobId:string,commit:string,signal:AbortSignal):Promise<PlatformJobObservation>;
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
/** Only fixed provider route builders call this reader. No redirects, remote
 * URL input, retries, writes, response-body error echo or credential logging. */
export function platformReader(registration:PlatformRegistration,credentials:PlatformCredentialReader){
  const binding=validatePlatformRegistration(registration);
  const origin=binding.provider==='github'?'https://api.github.com':binding.host;
  const prefix=binding.provider==='github'?'/repos/'+binding.repository:'/api/v4/projects/'+binding.repositoryId;
  async function get(actor:Principal,suffix:string,signal:AbortSignal):Promise<unknown>{
    authorize(actor,binding.projectId,'read');if(Date.parse(binding.expiresAt)<=Date.now())reject('PLATFORM_NOT_REGISTERED','Platform registration has expired',409);
    if(suffix!==''&&!suffix.startsWith('/')||suffix.includes('..')||suffix.includes('#')||/[\u0000-\u0020\\]/.test(suffix))reject('INVALID_PLATFORM_ROUTE','Invalid fixed platform route');
    const controller=AbortSignal.any([signal,AbortSignal.timeout(10000)]);
    try{
      controller.throwIfAborted();
      let onAbort:()=>void=()=>{};let token:string;
      try{token=await Promise.race([credentials(binding,actor,controller),new Promise<never>((_resolve,reject)=>{onAbort=()=>reject(new Error('Credential lookup expired'));controller.addEventListener('abort',onAbort,{once:true});if(controller.aborted)onAbort();})]);}
      finally{controller.removeEventListener('abort',onAbort);}
      controller.throwIfAborted();
      if(!/^[A-Za-z0-9_.-]{16,4096}$/.test(token))reject('UNSAFE_PLATFORM_CREDENTIAL','Invalid scoped credential',503);
      const headers:Record<string,string>=binding.provider==='github'?{authorization:'Bearer '+token,accept:'application/vnd.github+json','x-github-api-version':'2022-11-28'}:{'private-token':token,accept:'application/json'};
      const response=await fetch(origin+prefix+suffix,{headers,redirect:'error',signal:controller});
      if(!response.ok){await response.body?.cancel();reject(response.status===401||response.status===403?'PLATFORM_PERMISSION_DENIED':response.status===404?'PLATFORM_RESOURCE_MISSING':'PLATFORM_HTTP_FAILURE','Platform rejected the scoped observation',response.status===401||response.status===403?403:502);}
      if(!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??'')){await response.body?.cancel();reject('PLATFORM_RESPONSE_INVALID','Expected provider JSON',502);}
      const reader=response.body?.getReader();if(!reader)reject('PLATFORM_RESPONSE_INVALID','Missing platform response body',502);
      let length=0;const chunks:Buffer[]=[];
      try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>2097152){await reader.cancel();reject('PLATFORM_RESPONSE_LIMIT','Platform response exceeds 2 MiB',502);}chunks.push(Buffer.from(part.value));}}finally{reader.releaseLock();}
      const value=JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      // Return only to the fixed adapter. Public results are an explicit projection.
      authorize(actor,binding.projectId,'read');controller.throwIfAborted();return value;
    }catch(error){return safePlatformError(error);}
  }
  return{binding,get};
}
export function readinessResult(binding:PlatformRegistration,commit:string,path:string,workflowDigest:string,runner:PlatformReadiness['runner']):PlatformReadiness{
  const facts={provider:binding.provider,projectId:binding.projectId,bindingRef:binding.ref,bindingDigest:valueDigest(binding),repositoryId:binding.repositoryId,repository:binding.repository,branch:binding.defaultBranch,commit,workflowPath:path,workflowDigest,runner};
  const now=Date.now();return{schema:'runtime-platform-readiness/v1',...facts,evidenceRef:binding.host+'/'+binding.repository,observedAt:new Date(now).toISOString(),expiresAt:new Date(Math.min(now+60000,Date.parse(binding.expiresAt))).toISOString(),factsDigest:valueDigest(facts),executionAuthorized:false,workflowExecuted:false};
}
export function jobResult(binding:PlatformRegistration,runId:string,jobId:string,commit:string,status:PlatformJobObservation['status'],providerStatus:string,runnerId:string|null):PlatformJobObservation{
  string(providerStatus,128);const facts={provider:binding.provider,projectId:binding.projectId,repositoryId:binding.repositoryId,runId,jobId,commit,status,providerStatus,runnerId};
  return{schema:'runtime-platform-job-observation/v1',...facts,evidenceRef:binding.host+'/'+binding.repository+(binding.provider==='github'?'/actions/runs/'+runId:'/-/jobs/'+jobId),observedAt:new Date().toISOString(),factsDigest:valueDigest(facts),artifactsVerified:false,lifecycleAcceptance:false};
}
export function matchRepository(actual:unknown,binding:PlatformRegistration):Record<string,unknown>{
  const r=record(actual),path=r.full_name??r.path_with_namespace;
  if(positiveId(r.id)!==binding.repositoryId||path!==binding.repository||r.default_branch!==binding.defaultBranch||r.archived!==false)reject('PLATFORM_IDENTITY_CHANGED','Repository identity, branch or archived state differs from its registered scope',409);return r;
}
