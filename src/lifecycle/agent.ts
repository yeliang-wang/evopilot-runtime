import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { canonical, exact, record, reject, string } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import { RuntimeStore, type Receipt } from '../server/store.js';
import { byteDigest, valueDigest } from './base.js';
import { containsInlineSecret } from './compiler.js';
import { inspectInstance, type LifecycleInstance } from './instance.js';
import type { StageRequest } from './execution.js';
import type { AgentIdentity } from '../adapters/external-agent.js';
import type { PreparationInput } from './preparation.js';

export const AGENT_READS=['lifecycle.agent.handoff.read','lifecycle.agent.report.read'] as const;
export const AGENT_WRITES=['lifecycle.agent.claim','lifecycle.agent.report'] as const;
export const AGENT_ADAPTER_ID='runtime-codex-handoff-v1';
export const AGENT_CAPABILITIES=['workspace.read','workspace.edit','local.validation','source.change.propose','runtime.read','runtime.request'] as const;
export const AGENT_ADAPTER_DIGEST=valueDigest({id:AGENT_ADAPTER_ID,handoff:'runtime-agent-handoff/v1',capabilities:AGENT_CAPABILITIES,execution:'external-host-only',reportedResults:'require-independent-verification'});
export interface AgentHandoff {
  schema:'runtime-agent-handoff/v1';workspaceId:string;projectId:string;instanceId:string;
  stageRequestId:string;requestDigest:string;inputDigest:string;planDigest:string;authorityRef:string;deadlineAt:string;
  agent:AgentIdentity;workspaceRoot:string;capabilities:readonly string[];hostPermissionPolicy:'host-managed';
  budget:LifecycleInstance['pins']['budget'];preparationRef:string;preparation:PreparationInput;
  runtimeStartsAgent:false;releaseAuthorized:false;digest:string;
}
export interface AgentClaim {schema:'runtime-agent-claim/v1';stageRequestId:string;handoffDigest:string;principalId:string;principalRevision:number;host:{hostId:string;version:string;sessionId:string;capabilities:string[];permissionMode:'host-managed'};claimedAt:string;deadlineAt:string;source:'authenticated-host-report';digest:string;}
export interface AgentReport {schema:'runtime-agent-report/v1';stageRequestId:string;claimDigest:string;previousReportDigest:string|null;state:'WORKING'|'WAITING'|'SUBMITTED'|'FAILED'|'UNKNOWN';summary:string;result:Record<string,unknown>|null;measurement:Record<string,unknown>|null;receivedAt:string;late:boolean;source:'authenticated-host-report';independentlyVerified:false;digest:string;}
export type OriginalAgentPermit=(actor:Principal,projectId:string,requestId:string)=>Promise<Principal>;
const hash=(v:unknown)=>{const s=string(v,71);if(!/^sha256:[a-f0-9]{64}$/.test(s))reject('INVALID_AGENT_PIN','Exact Agent evidence digest required');return s;};
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function intact<T>(value:unknown,schema:string):T{
  const r=record(value),{digest,...body}=r;if(r.schema!==schema||digest!==valueDigest(body))reject('CORRUPT_AGENT_EVIDENCE','Original Agent evidence changed',503);return r as T;
}
export function readAgentHandoff(store:RuntimeStore,projectId:string,id:string,mode:'current'|'historical'='current'):{handoff:AgentHandoff;request:StageRequest;instance:LifecycleInstance}{
  const raw=store.object(projectId,'agent-handoff',id),original=store.object(projectId,'stage-request',id);
  if(!raw||!original)reject('AGENT_HANDOFF_UNAVAILABLE','No dispatched original Agent handoff exists',409);
  const h=intact<AgentHandoff>(raw,'runtime-agent-handoff/v1'),r=intact<StageRequest>(original,'runtime-stage-request/v1');
  const saved=store.object(projectId,'lifecycle-instance',h.instanceId);if(!saved)reject('CORRUPT_AGENT_EVIDENCE','Original Agent instance is missing',503);const instance=inspectInstance(saved as LifecycleInstance);
  if(h.workspaceId!==store.workspaceId||h.projectId!==projectId||h.stageRequestId!==id||h.requestDigest!==r.digest||h.planDigest!==r.planDigest||h.inputDigest!==r.inputDigest||h.authorityRef!==r.authorityRef||h.deadlineAt!==r.deadlineAt||r.projectId!==projectId||r.workspaceId!==store.workspaceId||r.stageId!=='implementation'||r.instanceId!==h.instanceId||r.pinsDigest!==instance.pinsDigest||!instance.requestIds.includes(id)||(mode!=='historical'&&(instance.stages.implementation.requestId!==id||instance.stages.implementation.inputDigest!==r.inputDigest))||r.plan.adapterId!==AGENT_ADAPTER_ID||r.plan.adapterDigest!==AGENT_ADAPTER_DIGEST||r.planDigest!==valueDigest(r.plan)||!same(h.capabilities,AGENT_CAPABILITIES))reject('CORRUPT_AGENT_EVIDENCE','Handoff does not match the exact original implementation request',503);
  return{handoff:h,request:r,instance};
}
export function readAgentClaim(store:RuntimeStore,projectId:string,id:string):AgentClaim|null{
  const raw=store.object(projectId,'agent-claim',id);if(!raw)return null;
  const c=intact<AgentClaim>(raw,'runtime-agent-claim/v1');if(c.stageRequestId!==id)reject('CORRUPT_AGENT_EVIDENCE','Agent claim belongs to another request',503);return c;
}
export function readAgentReport(store:RuntimeStore,projectId:string,id:string):AgentReport|null{
  const pointer=store.object(projectId,'agent-report-pointer',id);if(!pointer)return null;const ref=hash(record(pointer).digest),raw=store.object(projectId,'agent-report',ref);
  if(!raw)reject('CORRUPT_AGENT_EVIDENCE','Original Agent report is missing',503);const r=intact<AgentReport>(raw,'runtime-agent-report/v1');if(r.stageRequestId!==id||r.digest!==ref)reject('CORRUPT_AGENT_EVIDENCE','Agent report belongs to another request',503);return r;
}
function measurement(value:unknown):Record<string,unknown>|null{
  if(value===null)return null;const m=record(value);exact(m,['provider','model','inputTokens','outputTokens','totalTokens','cost','source']);
  for(const k of ['provider','model'])if(m[k]!==null)string(m[k],256);
  for(const k of ['inputTokens','outputTokens','totalTokens'])if(m[k]!==null&&(!Number.isSafeInteger(m[k])||Number(m[k])<0))reject('INVALID_AGENT_MEASUREMENT','Usage must be a known nonnegative integer or null');
  if(m.inputTokens!==null&&m.outputTokens!==null&&m.totalTokens!==null&&Number(m.totalTokens)!==Number(m.inputTokens)+Number(m.outputTokens))reject('INVALID_AGENT_MEASUREMENT','Reported token totals disagree');
  if(m.cost!==null){const cost=record(m.cost);exact(cost,['amount','currency']);if(typeof cost.amount!=='number'||!Number.isFinite(cost.amount)||cost.amount<0||!/^[A-Z]{3}$/.test(string(cost.currency,3)))reject('INVALID_AGENT_MEASUREMENT','Invalid reported cost');}
  const source=record(m.source);exact(source,['reference','digest']);string(source.reference,1024);hash(source.digest);
  return JSON.parse(canonical(m)) as Record<string,unknown>;
}
/** Evidence bytes are hashed only inside the registered workspace. No reported
 * URL is fetched and no command or model task is run by this writer. */
function output(h:AgentHandoff,value:unknown):Record<string,unknown>{
  const o=record(value);exact(o,['commit','change','artifacts']);if(!/^[a-f0-9]{40}$/.test(string(o.commit,40)))reject('INVALID_AGENT_RESULT','An exact source commit is required');
  const change=record(o.change);exact(change,['kind','id']);if(change.kind!==(h.preparation.source.provider==='github'?'pull-request':'merge-request')||! /^[1-9]\d{0,9}$/.test(string(change.id,10)))reject('INVALID_AGENT_RESULT','Use the selected provider change reference');
  if(!Array.isArray(o.artifacts)||!o.artifacts.length||o.artifacts.length>128)reject('INVALID_AGENT_RESULT','A bounded output inventory is required');
  if(!isAbsolute(h.workspaceRoot)||realpathSync(h.workspaceRoot)!==h.workspaceRoot)reject('AGENT_WORKSPACE_CHANGED','Registered workspace identity changed',409);
  let total=0;const paths=new Set<string>();
  for(const raw of o.artifacts){const a=record(raw);exact(a,['path','digest','bytes']);const path=string(a.path,1024);hash(a.digest);
    if(path.startsWith('/')||path.includes('\\')||/[\u0000-\u001f]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..'||p==='.git')||paths.has(path))reject('AGENT_OUTPUT_SCOPE','Output must be a unique regular file inside its workspace',403);paths.add(path);
    if(!Number.isSafeInteger(a.bytes)||Number(a.bytes)<0||Number(a.bytes)>16777216||(total+=Number(a.bytes))>67108864)reject('AGENT_OUTPUT_LIMIT','Output inventory exceeds its byte limit');
    const absolute=join(h.workspaceRoot,path);if(realpathSync(absolute)!==absolute)reject('AGENT_OUTPUT_SCOPE','Linked output paths are not accepted',403);
    const fd=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);try{
      const st=fstatSync(fd);if(!st.isFile()||st.nlink!==1||st.uid!==process.getuid?.()||st.size!==a.bytes||st.size>16777216||(st.mode&0o022)!==0)reject('AGENT_OUTPUT_CHANGED','Output differs from the reported original bytes',409);
      const bytes=Buffer.alloc(st.size+1);let length=0,n=0;do{n=readSync(fd,bytes,length,bytes.length-length,null);length+=n;}while(n>0&&length<bytes.length);
      const after=fstatSync(fd);if(length!==st.size||st.size!==after.size||st.mtimeMs!==after.mtimeMs||st.ctimeMs!==after.ctimeMs||byteDigest(bytes.subarray(0,length))!==a.digest||realpathSync(absolute)!==absolute)reject('AGENT_OUTPUT_CHANGED','Output changed during its bounded read',409);
    }finally{closeSync(fd);}
  }
  return JSON.parse(canonical(o)) as Record<string,unknown>;
}
export function createAgentService(store:RuntimeStore,permit:OriginalAgentPermit){
  function read(actor:Principal,projectId:string,operation:string,input:Record<string,unknown>):unknown{
    authorize(actor,projectId,'read');exact(input,['stageRequestId'],operation==='lifecycle.agent.report.read'?['reportDigest']:[]);const id=string(input.stageRequestId),{handoff}=readAgentHandoff(store,projectId,id,'historical'),claim=readAgentClaim(store,projectId,id),latest=readAgentReport(store,projectId,id);
    if(operation==='lifecycle.agent.handoff.read')return{handoff,claim,latestReport:latest,executionAuthorityMustBeCurrent:true,hostSessionAttested:false,softwareReleaseAuthorized:false};
    if(operation!=='lifecycle.agent.report.read')reject('UNKNOWN_OPERATION','Unsupported Agent read',404);
    const report=input.reportDigest===undefined?latest:intact<AgentReport>(store.object(projectId,'agent-report',hash(input.reportDigest))??reject('NOT_FOUND','Agent report not found',404),'runtime-agent-report/v1');
    if(report&&report.stageRequestId!==id)reject('NOT_FOUND','Agent report not found in this request',404);
    return{report,independentlyVerified:false,measurementSource:report?.measurement?'host-reported':'unavailable',authorityGranted:false};
  }
  async function write(actor:Principal,projectId:string,operation:string,input:Record<string,unknown>,requestId:string,expectedRevision:number,reauthorize:()=>Principal):Promise<Receipt>{
    authorize(actor,projectId,'execution.request');if(!AGENT_WRITES.includes(operation as typeof AGENT_WRITES[number]))reject('UNKNOWN_OPERATION','Unsupported Agent write',404);
    const mutation={projectId,operation,requestId,expectedRevision,input,permission:'execution.request' as const};
    if(store.findReceipt(actor,projectId,requestId))return store.mutate(actor,mutation,()=>{throw Error('Unreachable replay');},reauthorize);
    if(containsInlineSecret(canonical(input)))reject('INLINE_SECRET','Agent reports use evidence references, not credentials');
    const claiming=operation==='lifecycle.agent.claim';exact(input,claiming?['stageRequestId','handoffDigest','host']:['stageRequestId','claimDigest','previousReportDigest','state','summary','result','measurement']);
    const id=string(input.stageRequestId),{handoff:h,request:r}=readAgentHandoff(store,projectId,id);
    if(actor.id!==r.initiatedBy.id||actor.revision!==r.initiatedBy.revision)reject('AGENT_PRINCIPAL_MISMATCH','Only the original current execution principal can report this task',403);
    let claim=readAgentClaim(store,projectId,id),latest=readAgentReport(store,projectId,id),value:AgentClaim|AgentReport;
    if(claiming){
      if(hash(input.handoffDigest)!==h.digest)reject('AGENT_HANDOFF_MISMATCH','Claim must bind the exact handoff',409);if(claim)reject('AGENT_ALREADY_CLAIMED','Read and resume the original claim; do not create another coding task',409);
      const host=record(input.host);exact(host,['hostId','version','sessionId','capabilities','permissionMode']);string(host.sessionId,256);
      if(host.hostId!==h.agent.hostId||host.version!==h.agent.version||host.permissionMode!=='host-managed'||!same(host.capabilities,h.capabilities))reject('AGENT_HOST_MISMATCH','Claim cannot change the configured Host/version/capabilities or bypass Host permissions',409);
      await permit(actor,projectId,id);
      const body={schema:'runtime-agent-claim/v1' as const,stageRequestId:id,handoffDigest:h.digest,principalId:actor.id,principalRevision:actor.revision,host:JSON.parse(canonical(host)) as AgentClaim['host'],claimedAt:new Date().toISOString(),deadlineAt:r.deadlineAt,source:'authenticated-host-report' as const};value={...body,digest:valueDigest(body)};
    }else{
      if(!claim||hash(input.claimDigest)!==claim.digest||claim.handoffDigest!==h.digest)reject('AGENT_CLAIM_REQUIRED','Report needs the original exact claim',409);
      if(input.previousReportDigest!==(latest?.digest??null))reject('AGENT_REPORT_CONFLICT','Read the latest original report before updating',409);
      if(latest&&['SUBMITTED','FAILED'].includes(latest.state))reject('AGENT_RESULT_FROZEN','Submitted outputs or known failures cannot be replaced',409);
      const state=string(input.state);if(!['WORKING','WAITING','SUBMITTED','FAILED','UNKNOWN'].includes(state))reject('INVALID_AGENT_STATE','A Host report cannot declare lifecycle PASS or completion');
      if(state==='WORKING')await permit(actor,projectId,id);
      const result=state==='SUBMITTED'?output(h,input.result):null;if(state!=='SUBMITTED'&&input.result!==null)reject('INVALID_AGENT_RESULT','Only a submitted result can carry source outputs');
      const body={schema:'runtime-agent-report/v1' as const,stageRequestId:id,claimDigest:claim.digest,previousReportDigest:latest?.digest??null,state:state as AgentReport['state'],summary:string(input.summary,8192),result,measurement:measurement(input.measurement),receivedAt:new Date().toISOString(),late:Date.parse(r.deadlineAt)<=Date.now(),source:'authenticated-host-report' as const,independentlyVerified:false as const};value={...body,digest:valueDigest(body)};
    }
    return store.mutate(actor,mutation,()=>{
      const current=reauthorize();authorize(current,projectId,'execution.request');if(current.id!==r.initiatedBy.id||current.revision!==r.initiatedBy.revision)reject('AGENT_PRINCIPAL_MISMATCH','Current Agent principal changed',403);
      readAgentHandoff(store,projectId,id);
      if(claiming){if(readAgentClaim(store,projectId,id))reject('AGENT_ALREADY_CLAIMED','Original claim already exists',409);if(Date.parse(r.deadlineAt)<=Date.now())reject('EXECUTION_DEADLINE','Original task budget is exhausted',409);}
      else if(readAgentReport(store,projectId,id)?.digest!==latest?.digest)reject('AGENT_REPORT_CONFLICT','Agent report changed before commit',409);
      if(!claiming&&(value as AgentReport).state==='WORKING'&&Date.parse(r.deadlineAt)<=Date.now())reject('EXECUTION_DEADLINE','Original task budget is exhausted',409);
      const objects=claiming?[{kind:'agent-claim',id,value}]:[{kind:'agent-report',id:value.digest,value},{kind:'agent-report-pointer',id,value:{digest:value.digest}}];
      return{objects,value:{stageRequestId:id,...(claiming?{claimDigest:value.digest}:{reportDigest:value.digest}),deadlineAt:r.deadlineAt,independentlyVerified:false,lifecycleCompleted:false},event:{type:claiming?'agent-claimed':'agent-reported',data:{stageRequestId:id,instanceId:r.instanceId,digest:value.digest,state:claiming?'CLAIMED':(value as AgentReport).state,principalId:current.id}}};
    },reauthorize);
  }
  return{read,write};
}
