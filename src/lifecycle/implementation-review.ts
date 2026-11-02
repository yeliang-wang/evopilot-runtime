import { verifyDecisionEvidence } from '../../vendor/compatibility/v1/decision-evidence.mjs';
import { canonical, exact, record, reject, string } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import { RuntimeStore, type Receipt } from '../server/store.js';
import { valueDigest } from './base.js';
import { atPath, containsInlineSecret } from './compiler.js';
import { readAgentHandoff, readAgentClaim, readAgentReport, type AgentReport } from './agent.js';
import type { LifecycleInstance } from './instance.js';
import { configuredPlatform, readIntegrationConfiguration } from '../adapters/config.js';
import { validateResourceDefinition, type BindingConnections } from '../adapters/bindings.js';
import type { SourceRequest, SourceObservation } from '../adapters/source.js';

export const IMPLEMENTATION_REVIEW_READS=['lifecycle.implementation.review.preview','lifecycle.implementation.review.inspect'] as const;
export const IMPLEMENTATION_REVIEW_WRITES=['lifecycle.implementation.review.record','lifecycle.implementation.review.revoke'] as const;
export interface ImplementationReviewPolicy {digest:string;bindingDigest:string;reviewerIds:readonly string[];expiresAt:string;}
export interface ImplementationReviewBindings {
  policy(instance:LifecycleInstance,actor:Principal):ImplementationReviewPolicy;
  source(instance:LifecycleInstance,input:SourceRequest,actor:Principal,signal:AbortSignal):Promise<SourceObservation>;
}
interface ReviewSubject {schema:'runtime-implementation-review/v1';workspaceId:string;projectId:string;stageRequestId:string;requestDigest:string;pinsDigest:string;agentReportDigest:string;sourceFactsDigest:string;policyDigest:string;reviewerId:string;reviewerRevision:number;}
interface SourceDecision {schema:'runtime-implementation-decision/v1';ref:string;review:ReviewSubject;reviewDigest:string;source:SourceObservation;choice:'APPROVE'|'REJECT';evidenceRef:string;at:string;}
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const hash=(v:unknown)=>{const s=string(v,71);if(!/^sha256:[a-f0-9]{64}$/.test(s))reject('INVALID_REVIEW_DIGEST','An exact review digest is required');return s;};
const reference=(v:unknown)=>{const s=string(v,100);if(!/^source-review:sha256:[a-f0-9]{64}$/.test(s))reject('INVALID_SOURCE_REVIEW','An exact retained source review reference is required');return s;};

export function registeredImplementationReview(configPath:string,workspaceId:string,connections:Pick<BindingConnections,'platform'>):ImplementationReviewBindings{
  function selected(instance:LifecycleInstance,actor:Principal){
    authorize(actor,instance.pins.projectId,'read');const c=readIntegrationConfiguration(configPath,workspaceId),role='config.implementation.reviewPolicyRef',ref=atPath(instance.definition.semantic,role);
    const resource=c.resources.find(r=>r.projectId===instance.pins.projectId&&r.ref===ref&&r.role===role);if(!resource||Date.parse(resource.expiresAt)<=Date.now())reject('IMPLEMENTATION_REVIEW_POLICY','Current implementation review policy is required',409);validateResourceDefinition(resource);
    const implementation=record(atPath(instance.definition.semantic,'config.implementation')),matches=c.platforms.filter(p=>p.projectId===instance.pins.projectId&&(['provider','host','repository','repositoryId','defaultBranch','credentialRef','workflowPath','pipelinePath','runner'] as const).every(k=>p[k]===implementation[k]));
    if(matches.length!==1)reject('PLATFORM_SCOPE','Source review must match one exact configured implementation connection',409);
    const binding=configuredPlatform(c,actor,instance.pins.projectId,matches[0]!.ref);
    return{resource,binding};
  }
  return{policy(instance,actor){const{resource,binding}=selected(instance,actor);return{digest:valueDigest({resource,binding}),bindingDigest:valueDigest(binding),reviewerIds:resource.definition.reviewerIds as string[],expiresAt:new Date(Math.min(Date.parse(resource.expiresAt),Date.parse(binding.expiresAt))).toISOString()};},
    async source(instance,input,actor,signal){const{binding}=selected(instance,actor);return connections.platform(binding).source(actor,input,signal);}};
}

/** One exact source decision under the existing project review policy, with
 * retained decision evidence. No provider username is mapped to a principal,
 * and source approval neither completes implementation nor grants execution. */
export function createImplementationReviewService(store:RuntimeStore,bindings:ImplementationReviewBindings|undefined,principals:(id:string)=>Principal|null){
  function context(projectId:string,id:string){
    const h=readAgentHandoff(store,projectId,id),claim=readAgentClaim(store,projectId,id),report=readAgentReport(store,projectId,id);
    if(!report||report.state!=='SUBMITTED'||!report.result)reject('IMPLEMENTATION_RESULT_REQUIRED','Exact submitted Agent output is required before source review',409);
    if(!claim||claim.handoffDigest!==h.handoff.digest||report.claimDigest!==claim.digest)reject('IMPLEMENTATION_RESULT_REQUIRED','Source review requires the original claimed Agent result',409);
    return{...h,report};
  }
  function policy(instance:LifecycleInstance,actor:Principal){
    if(!bindings)reject('IMPLEMENTATION_REVIEW_UNAVAILABLE','Registered exact-source review bindings are required',409);
    const p=bindings.policy(instance,actor);hash(p.digest);hash(p.bindingDigest);if(!p.reviewerIds.length||!Number.isFinite(Date.parse(p.expiresAt))||Date.parse(p.expiresAt)<=Date.now())reject('IMPLEMENTATION_REVIEW_POLICY','Current configured reviewers are required',409);return p;
  }
  function reviewer(actor:Principal,projectId:string,p:ImplementationReviewPolicy){authorize(actor,projectId,'decision.record');if(!p.reviewerIds.includes(actor.id))reject('IMPLEMENTATION_REVIEWER','Only a configured current reviewer can decide this source',403);}
  function sourceInput(report:AgentReport,baselineCommit:string):SourceRequest{return{baselineCommit,...report.result} as SourceRequest;}
  async function preview(actor:Principal,projectId:string,id:string,decider:Principal=actor){
    authorize(actor,projectId,'read');const c=context(projectId,id),p=policy(c.instance,actor),input=sourceInput(c.report,c.handoff.preparation.source.commit),source=await bindings!.source(c.instance,input,actor,AbortSignal.timeout(30000));
    const{schema,observedAt,evidenceRef,factsDigest,sourceReviewApproved,ciVerified,releaseAuthorized,...facts}=source;
    if(schema!=='runtime-source-observation/v1'||factsDigest!==valueDigest(facts)||source.bindingDigest!==p.bindingDigest||source.projectId!==projectId||source.provider!==c.handoff.preparation.source.provider||source.repositoryId!==c.handoff.preparation.source.repositoryId||source.baselineCommit!==input.baselineCommit||source.commit!==input.commit||!same(source.change,input.change)||!same(source.artifacts,input.artifacts)||sourceReviewApproved!==false||ciVerified!==false||releaseAuthorized!==false)reject('IMPLEMENTATION_SOURCE_MISMATCH','Independent source observation differs from the submitted exact change',409);
    if(!Number.isFinite(Date.parse(observedAt))||Math.abs(Date.now()-Date.parse(observedAt))>30000)reject('IMPLEMENTATION_SOURCE_STALE','A fresh independent source observation is required',409);
    const after=context(projectId,id);if(after.report.digest!==c.report.digest||policy(after.instance,actor).digest!==p.digest)reject('IMPLEMENTATION_REVIEW_STALE','Report or policy changed during source observation',409);
    const review:ReviewSubject={schema:'runtime-implementation-review/v1',workspaceId:store.workspaceId,projectId,stageRequestId:id,requestDigest:c.request.digest,pinsDigest:c.instance.pinsDigest,agentReportDigest:c.report.digest,sourceFactsDigest:source.factsDigest,policyDigest:p.digest,reviewerId:decider.id,reviewerRevision:decider.revision};
    return{review,reviewDigest:valueDigest(review),source,report:c.report,policy:p,deadlineAt:c.request.deadlineAt,executionAuthorized:false,implementationComplete:false,releaseAuthorized:false};
  }
  function evidence(d:SourceDecision){try{verifyDecisionEvidence(d.evidenceRef,{owner:'runtime',operation:'lifecycle.implementation.review',workspaceId:store.workspaceId,scope:{visibility:'private',projectId:d.review.projectId},reviewDigest:d.reviewDigest,decision:d.choice});}catch{reject('DECISION_EVIDENCE_REQUIRED','Source review needs retained evidence for this exact authenticated decision',409);}}
  function saved(projectId:string,ref:unknown):SourceDecision{
    const key=reference(ref),raw=store.object(projectId,'implementation-review',key);if(!raw)reject('NOT_FOUND','Source review not found',404);const d=raw as SourceDecision,{ref:unused,...body}=d;
    if(d.schema!=='runtime-implementation-decision/v1'||d.ref!==key||'source-review:'+valueDigest(body)!==key||d.review.workspaceId!==store.workspaceId||d.review.projectId!==projectId||valueDigest(d.review)!==d.reviewDigest)reject('CORRUPT_SOURCE_REVIEW','Original source review content or scope changed',503);return d;
  }
  async function resolve(actor:Principal,projectId:string,id:string):Promise<SourceDecision>{
    authorize(actor,projectId,'read');const pointer=store.object(projectId,'implementation-review-pointer',id);if(!pointer)reject('IMPLEMENTATION_REVIEW_REQUIRED','Source approval is still required',409);const d=saved(projectId,record(pointer).ref);
    if(d.review.stageRequestId!==id||d.choice!=='APPROVE'||store.object(projectId,'implementation-review-revocation',d.ref))reject('IMPLEMENTATION_REVIEW_REJECTED','Source review is rejected or revoked',409);
    const decider=principals(d.review.reviewerId);if(!decider||decider.revision!==d.review.reviewerRevision)reject('IMPLEMENTATION_REVIEWER_CHANGED','Original reviewer is no longer current',403);
    reviewer(decider,projectId,policy(context(projectId,id).instance,actor));evidence(d);
    const now=await preview(actor,projectId,id,decider);if(now.reviewDigest!==d.reviewDigest||now.source.state!=='OPEN'||Date.parse(now.deadlineAt)<=Date.now())reject('IMPLEMENTATION_REVIEW_STALE','Exact source review is no longer usable for this original task',409);return d;
  }
  async function read(actor:Principal,projectId:string,operation:string,input:Record<string,unknown>):Promise<unknown>{
    authorize(actor,projectId,'read');if(operation==='lifecycle.implementation.review.preview'){exact(input,['stageRequestId']);return preview(actor,projectId,string(input.stageRequestId));}
    if(operation!=='lifecycle.implementation.review.inspect')reject('UNKNOWN_OPERATION','Unknown implementation review operation',404);exact(input,['reviewRef']);const d=saved(projectId,input.reviewRef);let usable=false,reason:string|null=null;
    try{usable=(await resolve(actor,projectId,d.review.stageRequestId)).ref===d.ref;if(!usable)reason='IMPLEMENTATION_REVIEW_SUPERSEDED';}catch(e){reason=e&&typeof e==='object'&&'code'in e?String(e.code):'IMPLEMENTATION_REVIEW_UNKNOWN';}
    return{decision:d,revocation:store.object(projectId,'implementation-review-revocation',d.ref),usable,reason,executionAuthorized:false,implementationComplete:false,releaseAuthorized:false};
  }
  async function write(actor:Principal,projectId:string,operation:string,input:Record<string,unknown>,requestId:string,expectedRevision:number,reauthorize:()=>Principal):Promise<Receipt>{
    authorize(actor,projectId,'decision.record');if(!IMPLEMENTATION_REVIEW_WRITES.includes(operation as typeof IMPLEMENTATION_REVIEW_WRITES[number]))reject('UNKNOWN_OPERATION','Unknown implementation review operation',404);
    const revoking=operation==='lifecycle.implementation.review.revoke';exact(input,revoking?['reviewRef','reason']:['stageRequestId','reviewDigest','decision','evidenceRef']);if(containsInlineSecret(canonical(input)))reject('INLINE_SECRET','Review decisions use evidence references, never raw credentials');
    const mutation={projectId,operation,input,requestId,expectedRevision,permission:'decision.record' as const};if(store.findReceipt(actor,projectId,requestId))return store.mutate(actor,mutation,()=>{throw Error('Unreachable replay');},reauthorize);
    if(revoking){const d=saved(projectId,input.reviewRef),reason=string(input.reason,2048);return store.mutate(actor,mutation,()=>{
      const fresh=reauthorize();reviewer(fresh,projectId,policy(context(projectId,d.review.stageRequestId).instance,fresh));if(store.object(projectId,'implementation-review-revocation',d.ref))reject('IMPLEMENTATION_REVIEW_REVOKED','Original source review already revoked',409);
      const value={reviewRef:d.ref,principalId:fresh.id,principalRevision:fresh.revision,reason,at:new Date().toISOString()};return{objects:[{kind:'implementation-review-revocation',id:d.ref,value}],value:{reviewRef:d.ref,status:'REVOKED',executionAuthorized:false},event:{type:'implementation-review-revoked',data:value}};
    },reauthorize);}
    const id=string(input.stageRequestId);reviewer(actor,projectId,policy(context(projectId,id).instance,actor));const p=await preview(actor,projectId,id);
    if(hash(input.reviewDigest)!==p.reviewDigest)reject('IMPLEMENTATION_REVIEW_STALE','Review must bind the exact observed source, report, reviewer and policy',409);
    if(input.decision!=='APPROVE'&&input.decision!=='REJECT')reject('INVALID_DECISION','Explicit source review decision is required');
    if(p.source.state!=='OPEN'||Date.parse(p.deadlineAt)<=Date.now())reject('IMPLEMENTATION_REVIEW_STALE','Only the original open unexpired source task can receive a new decision',409);
    const body={schema:'runtime-implementation-decision/v1' as const,review:p.review,reviewDigest:p.reviewDigest,source:p.source,choice:input.decision as SourceDecision['choice'],evidenceRef:string(input.evidenceRef,8192),at:new Date().toISOString()},d:SourceDecision={...body,ref:'source-review:'+valueDigest(body)};evidence(d);
    return store.mutate(actor,mutation,()=>{
      const fresh=reauthorize(),c=context(projectId,id),currentPolicy=policy(c.instance,fresh);reviewer(fresh,projectId,currentPolicy);
      if(fresh.id!==p.review.reviewerId||fresh.revision!==p.review.reviewerRevision||currentPolicy.digest!==p.review.policyDigest||c.report.digest!==p.review.agentReportDigest||Date.parse(c.request.deadlineAt)<=Date.now())reject('IMPLEMENTATION_REVIEW_STALE','Source review authority changed before commit',409);evidence(d);
      return{objects:[{kind:'implementation-review',id:d.ref,value:d},{kind:'implementation-review-pointer',id,value:{ref:d.ref}}],value:{reviewRef:d.ref,decision:d.choice,stageRequestId:id,reviewDigest:d.reviewDigest,executionAuthorized:false,implementationComplete:false,releaseAuthorized:false},event:{type:'implementation-review-recorded',data:{stageRequestId:id,reviewRef:d.ref,reviewerId:fresh.id,choice:d.choice}}};
    },reauthorize);
  }
  return{read,write,resolve};
}
