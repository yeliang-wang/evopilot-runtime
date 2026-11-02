import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { byteDigest } from '../lifecycle/base.js';
import { exact, record, reject, string } from '../server/errors.js';
import { canonical } from '../server/errors.js';
import { valueDigest } from '../lifecycle/base.js';
import { RuntimeStore } from '../server/store.js';
import { authorize, type Principal } from '../server/security.js';
import { atPath } from '../lifecycle/compiler.js';
import { inspectInstance, type LifecycleInstance } from '../lifecycle/instance.js';
import type { StageAdapter, StageObservation, StageRequest } from '../lifecycle/execution.js';
import { readPreparationPacket } from '../lifecycle/preparation.js';
import { AGENT_ADAPTER_ID, AGENT_ADAPTER_DIGEST, AGENT_CAPABILITIES, readAgentHandoff, readAgentClaim, readAgentReport, type AgentHandoff } from '../lifecycle/agent.js';
import { readIntegrationConfiguration } from './config.js';
import { validateResourceDefinition } from './bindings.js';

const execute=promisify(execFile);
export interface AgentIdentity { adapter:'codex';version:string;executableDigest:string;hostId:string;modelInvoked:false; }
/** A fixed version query establishes identity only. Runtime receives no model
 * profile/key, starts no coding task and cannot take authority from CLI output. */
export async function inspectExternalAgent(definition:Record<string,unknown>,signal:AbortSignal):Promise<AgentIdentity>{
  exact(definition,['kind','adapter','executable','version','hostId','workspaceRoot']);
  if(definition.kind!=='agent'||definition.adapter!=='codex')reject('UNSUPPORTED_AGENT','Only the registered external Codex adapter is available');
  const file=record(definition.executable);exact(file,['path','digest']);const path=string(file.path,4096),expected=string(file.digest,71),version=string(definition.version,128),hostId=string(definition.hostId,256);
  function verify(){
    if(!isAbsolute(path)||realpathSync(path)!==path)reject('AGENT_IDENTITY_CHANGED','Agent executable must be canonical');
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o022)!==0||(stat.mode&0o111)===0||stat.size<1||stat.size>268435456||byteDigest(readFileSync(fd))!==expected)reject('AGENT_IDENTITY_CHANGED','Agent executable differs from its registered bytes');}finally{closeSync(fd);}
  }
  signal.throwIfAborted();verify();let stdout:string;
  try{({stdout}=await execute(path,['--version'],{encoding:'utf8',timeout:3000,maxBuffer:8192,signal,windowsHide:true}));}
  catch{return reject('AGENT_UNAVAILABLE','Registered Codex version query did not complete',409);}
  if(stdout.trim()!=='codex-cli '+version)reject('AGENT_IDENTITY_CHANGED','External Agent does not report the exact configured Codex version',409);
  signal.throwIfAborted();verify();return{adapter:'codex',version,executableDigest:expected,hostId,modelInvoked:false};
}

interface CodexPlan {agent:AgentIdentity;registrationDigest:string;workspaceRoot:string;preparationRef:string;preparationDigest:string;planStageRequestId:string;planEvidenceRef:string;}
/** A deterministic handoff, never an embedded coding Agent. All coding/model
 * work remains in the external Host. Reports cannot complete implementation. */
export function createCodexStageAdapter(store:RuntimeStore,configPath:string,identify:typeof inspectExternalAgent=inspectExternalAgent):StageAdapter{
  function registration(instance:LifecycleInstance){
    const config=readIntegrationConfiguration(configPath,store.workspaceId),r=config.resources.find(r=>r.projectId===instance.pins.projectId&&r.role==='config.implementation.agentBindingRef'&&r.ref===atPath(instance.definition.semantic,r.role));
    if(!r||Date.parse(r.expiresAt)<=Date.now())reject('AGENT_BINDING_UNAVAILABLE','Register a current scoped external Codex binding',409);validateResourceDefinition(r);return r;
  }
  function preparation(instance:LifecycleInstance){
    inspectInstance(instance);const p=readPreparationPacket(store,instance.pins.projectId,instance.pins.targetRef);
    if(p.semanticDigest!==instance.pins.semanticDigest||p.input.definitionRevisionId!==instance.pins.definitionRevisionId||p.input.goalRef!==instance.pins.goalRef||p.input.loopRef!==instance.pins.loopRef)reject('PREPARATION_SCOPE','Coding must bind the exact reviewed preparation',409);return p;
  }
  function completedPlan(instance:LifecycleInstance,preparationDigest:string){
    const stage=instance.stages.plan,id=stage.requestId;
    if(stage.status!=='PASSED'||!id)reject('PLAN_EVIDENCE_REQUIRED','Coding requires the completed original plan',409);
    const request=record(store.object(instance.pins.projectId,'stage-request',id)),progress=record(store.object(instance.pins.projectId,'stage-progress',id)),observation=record(progress.observation),outcome=record(observation.outcome);
    if(request.instanceId!==instance.id||request.pinsDigest!==instance.pinsDigest||progress.phase!=='COMPLETE'||outcome.requestId!==id||valueDigest(outcome)!==stage.outcomeDigest||!Array.isArray(outcome.checks)||!outcome.checks.length)reject('PLAN_EVIDENCE_REQUIRED','Original plan outcome is unavailable',409);
    const refs=new Set(outcome.checks.map(c=>string(record(c).evidenceRef))),ref=[...refs][0],evidence=store.object(instance.pins.projectId,'plan-stage-evidence',ref);
    if(refs.size!==1||!evidence||valueDigest(evidence)!==ref||record(evidence).preparationDigest!==preparationDigest||record(evidence).requestDigest!==request.digest||record(evidence).planDigest!==request.planDigest)reject('PLAN_EVIDENCE_REQUIRED','Exact native plan evidence is required',409);
    return{requestId:id,evidenceRef:ref};
  }
  function original(r:StageRequest,instance:LifecycleInstance):CodexPlan{
    const packet=preparation(instance),p=r.plan.parameters as unknown as CodexPlan,prior=completedPlan(instance,packet.digest);
    if(r.workspaceId!==store.workspaceId||r.projectId!==instance.pins.projectId||r.instanceId!==instance.id||r.stageId!=='implementation'||r.pinsDigest!==instance.pinsDigest||r.plan.adapterId!==AGENT_ADAPTER_ID||r.plan.adapterDigest!==AGENT_ADAPTER_DIGEST||r.plan.action!=='base.implementation'||r.planDigest!==valueDigest(r.plan)||r.plan.bindingDigest!==valueDigest(p)||p.preparationRef!==instance.pins.targetRef||p.preparationDigest!==packet.digest||prior.requestId!==p.planStageRequestId||prior.evidenceRef!==p.planEvidenceRef)reject('STAGE_PLAN_MISMATCH','Codex handoff differs from the original reviewed implementation request',409);
    return p;
  }
  async function inspect(r:StageRequest,instance:LifecycleInstance,_progress:unknown,actor:Principal,signal:AbortSignal):Promise<StageObservation>{
    authorize(actor,r.projectId,'read');signal.throwIfAborted();const p=original(r,instance),handle={handoffId:r.id,hostId:p.agent.hostId};
    let phase:StageObservation['phase']='UNKNOWN';
    if(store.object(r.projectId,'agent-handoff',r.id)){
      const{handoff}=readAgentHandoff(store,r.projectId,r.id),claim=readAgentClaim(store,r.projectId,r.id),report=readAgentReport(store,r.projectId,r.id);
      if(claim&&claim.handoffDigest!==handoff.digest||report&&report.claimDigest!==claim?.digest)reject('CORRUPT_AGENT_EVIDENCE','Agent claim/report does not match this original handoff',503);
      phase=!claim||!report?'WAITING_AGENT':report.state==='FAILED'?'FAILED':report.state==='UNKNOWN'?'UNKNOWN':report.state==='SUBMITTED'?'RUNNING':report.state==='WORKING'&&Date.now()-Date.parse(report.receivedAt)<30000&&Date.parse(r.deadlineAt)>Date.now()?'RUNNING':'WAITING_AGENT';
    }
    return{requestId:r.id,inputDigest:r.inputDigest,adapterDigest:AGENT_ADAPTER_DIGEST,phase,handle,outcome:{requestId:r.id,inputDigest:r.inputDigest,receiptRef:'runtime:agent-stage/'+r.id,status:phase==='FAILED'?'FAILED':phase==='UNKNOWN'?'UNKNOWN':'RUNNING',expiresAt:r.deadlineAt,checks:[]}};
  }
  return{async prepare(instance,stageId,actor,signal){
    if(stageId!=='implementation')reject('STAGE_ADAPTER_UNAVAILABLE','This fixed adapter owns external Codex handoff only',409);authorize(actor,instance.pins.projectId,'read');
    const packet=preparation(instance),prior=completedPlan(instance,packet.digest);
    const r=registration(instance),agent=await identify(r.definition,signal),p:CodexPlan={agent,registrationDigest:valueDigest(r),workspaceRoot:string(r.definition.workspaceRoot,4096),preparationRef:instance.pins.targetRef,preparationDigest:packet.digest,planStageRequestId:prior.requestId,planEvidenceRef:prior.evidenceRef};
    signal.throwIfAborted();if(valueDigest(registration(instance))!==p.registrationDigest)reject('AGENT_BINDING_CHANGED','Agent binding changed during preparation',409);
    return{adapterId:AGENT_ADAPTER_ID,adapterDigest:AGENT_ADAPTER_DIGEST,action:'base.implementation',bindingDigest:valueDigest(p),parameters:p as unknown as Record<string,unknown>};
  },inspect,async dispatch(r,instance,permit,signal){
    let actor=await permit();const p=original(r,instance);if(store.object(r.projectId,'agent-handoff',r.id))return inspect(r,instance,null,actor,signal);
    const current=registration(instance);if(valueDigest(current)!==p.registrationDigest||canonical(await identify(current.definition,signal))!==canonical(p.agent))reject('AGENT_BINDING_CHANGED','Original external Agent identity changed',409);
    actor=await permit();signal.throwIfAborted();authorize(actor,r.projectId,'execution.request');
    if(valueDigest(registration(instance))!==p.registrationDigest||Date.parse(r.deadlineAt)<=Date.now())reject('AGENT_BINDING_CHANGED','Original Agent registration or deadline changed before handoff',409);
    const packet=preparation(instance),body={schema:'runtime-agent-handoff/v1' as const,workspaceId:store.workspaceId,projectId:r.projectId,instanceId:instance.id,stageRequestId:r.id,requestDigest:r.digest,inputDigest:r.inputDigest,planDigest:r.planDigest,authorityRef:r.authorityRef,deadlineAt:r.deadlineAt,agent:p.agent,workspaceRoot:p.workspaceRoot,capabilities:AGENT_CAPABILITIES,hostPermissionPolicy:'host-managed' as const,budget:instance.pins.budget,preparationRef:p.preparationRef,preparation:packet.input,runtimeStartsAgent:false as const,releaseAuthorized:false as const},h:AgentHandoff={...body,digest:valueDigest(body)};
    store.mutate(actor,{projectId:r.projectId,operation:'lifecycle.agent.handoff',requestId:'agent-handoff-'+r.id,expectedRevision:store.revision(r.projectId),input:{stageRequestId:r.id,digest:h.digest},permission:'execution.request'},()=>({objects:[{kind:'agent-handoff',id:r.id,value:h}],value:{stageRequestId:r.id,handoffDigest:h.digest,startsAgent:false},event:{type:'agent-handoff-retained',data:{instanceId:r.instanceId,stageRequestId:r.id,handoffDigest:h.digest,startsAgent:false}}}));
    return inspect(r,instance,null,actor,signal);
  },async advance(r,instance,_progress,permit,signal){
    const actor=await permit();const state=await inspect(r,instance,null,actor,signal);
    if(readAgentReport(store,r.projectId,r.id)?.state==='SUBMITTED')reject('IMPLEMENTATION_VERIFICATION_REQUIRED','Submitted Agent outputs require independent source review and CI verification',409);
    return state;
  }};
}
