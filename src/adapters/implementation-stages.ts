import { randomUUID } from 'node:crypto';
import { canonical, record, reject } from '../server/errors.js';
import { authorize, currentPrincipal, type Principal } from '../server/security.js';
import { RuntimeStore } from '../server/store.js';
import { valueDigest } from '../lifecycle/base.js';
import {readPreparationPacket} from '../lifecycle/preparation.js';
import {resolvePreparationLineage,completedPreparationSource} from './ci-preparation.js';
import type { LifecycleInstance } from '../lifecycle/instance.js';
import type { StageAdapter, StageObservation, StageProgress, StageRequest } from '../lifecycle/execution.js';
import { readAgentHandoff, readAgentReport, AGENT_ADAPTER_DIGEST } from '../lifecycle/agent.js';
import { createImplementationReviewService, registeredImplementationReview } from '../lifecycle/implementation-review.js';
import { createCodexStageAdapter, inspectExternalAgent } from './external-agent.js';
import { createCiStageAdapter, type NativeStageConnections, type VerifiedStageSource } from './stages.js';

interface ImplementationDerivation {
  schema:'runtime-implementation-ci-derivation/v1';parentRequestId:string;parentRequestDigest:string;
  agentReportDigest:string;sourceReviewRef:string;sourceReviewDigest:string;sourceFactsDigest:string;
  request:StageRequest;digest:string;
}
interface ImplementationEvidence {schema:'runtime-implementation-stage-evidence/v1';parentRequestId:string;parentRequestDigest:string;derivationDigest:string;ciOutcome:StageObservation['outcome'];softwareRelease:false;}
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const childId=(r:StageRequest)=>'implementation-ci-'+valueDigest({parentRequestDigest:r.digest}).slice(7,47);
function derivation(store:RuntimeStore,r:StageRequest):ImplementationDerivation|null{
  const raw=store.object(r.projectId,'implementation-ci-derivation',r.id);if(!raw)return null;
  const d=raw as ImplementationDerivation,{digest,...body}=d,c=d.request,{digest:childDigest,...childBody}=c;
  if(d.schema!=='runtime-implementation-ci-derivation/v1'||valueDigest(body)!==digest||d.parentRequestId!==r.id||d.parentRequestDigest!==r.digest||c.schema!=='runtime-stage-request/v1'||valueDigest(childBody)!==childDigest||c.id!==childId(r)||c.stageId!=='implementation'||c.workspaceId!==r.workspaceId||c.projectId!==r.projectId||c.instanceId!==r.instanceId||c.pinsDigest!==r.pinsDigest||c.inputDigest!==r.inputDigest||c.authorityRef!==r.authorityRef||c.deadlineAt!==r.deadlineAt||c.requestedAt!==r.requestedAt||c.releaseAuthorityRef!==null||!same(c.initiatedBy,r.initiatedBy)||c.planDigest!==valueDigest(c.plan)||c.plan.bindingDigest!==valueDigest(c.plan.parameters)||!c.plan.parameters.source||record(c.plan.parameters.source).evidenceRef!==d.sourceReviewRef)reject('CORRUPT_IMPLEMENTATION_DERIVATION','Original implementation CI derivation changed',503);
  return d;
}
export function readImplementationEvidence(store:RuntimeStore,r:StageRequest){
  const d=derivation(store,r);return{derivation:d,ci:d?{run:store.object(r.projectId,'ci-stage-run',d.request.id),observation:store.object(r.projectId,'ci-stage-observation',d.request.id),artifact:store.object(r.projectId,'ci-stage-artifact',d.request.id),owners:Object.fromEntries(['ontology','harness'].map(kind=>[kind,{action:store.object(r.projectId,'stage-native-action',d.request.id+':'+kind),receipt:store.object(r.projectId,'stage-native-receipt',d.request.id+':'+kind)}]))}:null,executionAuthorized:false,releaseAuthorized:false};
}

/** The original coding request stays immutable. Explicit advance retains a
 * derived exact-source CI request under the same authority/deadline before any
 * CI effect. Restart observes that request; it cannot replace or redispatch it. */
export function createImplementationStageAdapters(store:RuntimeStore,configPath:string,connections:NativeStageConnections,identify:typeof inspectExternalAgent=inspectExternalAgent):{implementation:StageAdapter;ci:StageAdapter;source:(instance:LifecycleInstance,actor:Principal,stageId?:string)=>VerifiedStageSource}{
  const reviews=createImplementationReviewService(store,registeredImplementationReview(configPath,store.workspaceId,connections),id=>currentPrincipal(store.root,store.workspaceId,id));
  const codex=createCodexStageAdapter(store,configPath,identify);
  function retain(r:StageRequest,kind:string,id:string,value:unknown){
    const old=store.object(r.projectId,kind,id);if(old){if(!same(old,value))reject('IMPLEMENTATION_EVIDENCE_CHANGED','Original implementation evidence cannot be replaced',409);return;}
    const actor:Principal={id:'runtime:implementation-adapter',projects:[r.projectId],permissions:['read'],revision:1,expiresAt:new Date(Date.now()+60000).toISOString()};
    store.mutate(actor,{projectId:r.projectId,operation:'lifecycle.implementation.evidence',requestId:'implementation-evidence-'+randomUUID(),expectedRevision:store.revision(r.projectId),input:{kind,id,digest:valueDigest(value)},permission:'read'},()=>({objects:[{kind,id,value}],value:{kind,id},event:{type:'implementation-evidence-retained',data:{stageRequestId:r.id,kind,id,digest:valueDigest(value)}}}));
  }
  function completedSource(instance:LifecycleInstance,actor:Principal):VerifiedStageSource{
    const stage=instance.stages.implementation;if(stage.status!=='PASSED'||!stage.requestId)reject('VERIFIED_IMPLEMENTATION_REQUIRED','Candidate requires completed implementation evidence',409);
    const{request:r}=readAgentHandoff(store,instance.pins.projectId,stage.requestId),d=derivation(store,r),p=record(store.object(r.projectId,'stage-progress',r.id));
    if(!d||p.phase!=='COMPLETE'||p.terminal!==true)reject('VERIFIED_IMPLEMENTATION_REQUIRED','Original implementation outcome is incomplete',409);
    const outcome=record(record(p.observation).outcome),checks=outcome.checks;if(outcome.requestId!==r.id||valueDigest(outcome)!==stage.outcomeDigest||outcome.status!=='COMPLETE'||!Array.isArray(checks)||!checks.length||checks.some(c=>record(c).status!=='PASS'))reject('VERIFIED_IMPLEMENTATION_REQUIRED','Exact passing implementation checks are required',409);
    const refs=new Set(checks.map(c=>String(record(c).evidenceRef))),ref=[...refs][0]!,raw=store.object(r.projectId,'implementation-stage-evidence',ref);if(refs.size!==1||!raw||valueDigest(raw)!==ref)reject('VERIFIED_IMPLEMENTATION_REQUIRED','Implementation source proof is missing or changed',409);
    const e=raw as ImplementationEvidence;
    const required=instance.definition.nodes.find(n=>n.id==='implementation')!.checks;
    if(e.schema!=='runtime-implementation-stage-evidence/v1'||e.parentRequestId!==r.id||e.parentRequestDigest!==r.digest||e.derivationDigest!==d.digest||e.ciOutcome.requestId!==d.request.id||e.ciOutcome.inputDigest!==r.inputDigest||e.ciOutcome.status!=='COMPLETE'||!same(e.ciOutcome.checks.map(c=>c.id).sort(),[...required].sort())||e.ciOutcome.checks.some(c=>c.status!=='PASS'))reject('VERIFIED_IMPLEMENTATION_REQUIRED','Source proof does not match the original implementation CI',409);
    const current=reviews.recorded(actor,r.projectId,r.id);if(current.ref!==d.sourceReviewRef||current.reviewDigest!==d.sourceReviewDigest||current.review.agentReportDigest!==d.agentReportDigest||current.source.factsDigest!==d.sourceFactsDigest)reject('VERIFIED_SOURCE_CHANGED','Completed implementation source review is no longer current',409);
    return{commit:current.source.commit,evidenceRef:ref};
  }
  function sourceForStage(instance:LifecycleInstance,actor:Principal,stageId='candidate'):VerifiedStageSource{return resolvePreparationLineage(instance.definition.nodes,stageId,completedSource(instance,actor),id=>completedPreparationSource(store,instance,id));}
  const ci=createCiStageAdapter(store,configPath,{...connections,async preparationInput(instance,stageId,source,actor,signal){
    signal.throwIfAborted();if(!same(source,sourceForStage(instance,actor,stageId)))reject('CI_PREPARATION_SOURCE','Preparation source differs from its complete dependency lineage',409);
    const id=instance.stages.implementation.requestId;if(!id)reject('IMPLEMENTATION_REQUEST_REQUIRED','Original implementation request is required',409);const original=reviews.recorded(actor,instance.pins.projectId,id),packet=readPreparationPacket(store,instance.pins.projectId,instance.pins.targetRef);
    return{schema:'runtime-ci-preparation-input/v1',baselineCommit:packet.input.source.commit,parentCommit:source.commit,change:original.source.change,requirementsDigest:instance.pins.requirementsDigest};
  },async source(instance,stageId,actor,signal){
    signal.throwIfAborted();if(stageId!=='implementation')return sourceForStage(instance,actor,stageId);
    const id=instance.stages.implementation.requestId;if(!id)reject('IMPLEMENTATION_REQUEST_REQUIRED','Original coding task must exist before implementation CI',409);
    const approved=await reviews.resolve(actor,instance.pins.projectId,id);signal.throwIfAborted();return{commit:approved.source.commit,evidenceRef:approved.ref};
  }});
  function translated(r:StageRequest,base:StageObservation,d:ImplementationDerivation,child:StageObservation):StageObservation{
    if(child.requestId!==d.request.id||child.inputDigest!==r.inputDigest||child.outcome.requestId!==d.request.id)reject('IMPLEMENTATION_CI_MISMATCH','CI observation does not belong to this original coding task',409);
    let checks=child.outcome.checks;
    if(child.phase==='COMPLETE'){
      const e:ImplementationEvidence={schema:'runtime-implementation-stage-evidence/v1',parentRequestId:r.id,parentRequestDigest:r.digest,derivationDigest:d.digest,ciOutcome:child.outcome,softwareRelease:false},ref=valueDigest(e);retain(r,'implementation-stage-evidence',ref,e);checks=checks.map(c=>({...c,evidenceRef:ref}));
    }
    return{...base,adapterDigest:AGENT_ADAPTER_DIGEST,phase:child.phase,outcome:{...child.outcome,requestId:r.id,inputDigest:r.inputDigest,receiptRef:'runtime:implementation-stage/'+r.id,checks}};
  }
  const implementation:StageAdapter={prepare:codex.prepare,dispatch:codex.dispatch,async inspect(r,instance,progress,actor,signal){
    const base=await codex.inspect(r,instance,progress,actor,signal),d=derivation(store,r);if(!d)return base;
    return translated(r,base,d,await ci.inspect(d.request,instance,progress,actor,signal));
  },async advance(r,instance,progress,permit,signal){
    let actor=await permit();const base=await codex.inspect(r,instance,progress,actor,signal),report=readAgentReport(store,r.projectId,r.id);if(report?.state!=='SUBMITTED')return base;
    const approved=await reviews.resolve(actor,r.projectId,r.id);signal.throwIfAborted();let d=derivation(store,r);
    if(d){
      if(d.agentReportDigest!==report.digest||d.sourceReviewRef!==approved.ref||d.sourceReviewDigest!==approved.reviewDigest)reject('IMPLEMENTATION_DERIVATION_CHANGED','An existing CI request cannot be rebound or replaced',409);
      return translated(r,base,d,await ci.advance!(d.request,instance,progress,permit,signal));
    }
    const plan=await ci.prepare(instance,'implementation',actor,signal);
    if(record(plan.parameters.source).evidenceRef!==approved.ref||plan.parameters.commit!==approved.source.commit)reject('IMPLEMENTATION_REVIEW_STALE','Source changed during implementation CI planning',409);
    const{digest:unused,...original}=r,body={...original,id:childId(r),plan,planDigest:valueDigest(plan),releaseAuthorityRef:null},request={...body,digest:valueDigest(body)};
    const fields={schema:'runtime-implementation-ci-derivation/v1' as const,parentRequestId:r.id,parentRequestDigest:r.digest,agentReportDigest:report.digest,sourceReviewRef:approved.ref,sourceReviewDigest:approved.reviewDigest,sourceFactsDigest:approved.source.factsDigest,request};d={...fields,digest:valueDigest(fields)};
    actor=await permit();signal.throwIfAborted();authorize(actor,r.projectId,'execution.request');retain(r,'implementation-ci-derivation',r.id,d);
    // The retained derivation is the one-shot dispatch marker. A lost response,
    // cancellation or process death must be reconciled, never dispatched again.
    return translated(r,base,d,await ci.dispatch(request,instance,permit,signal));
  }};
  return{implementation,ci,source:sourceForStage};
}
