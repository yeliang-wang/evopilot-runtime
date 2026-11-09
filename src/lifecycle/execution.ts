import { randomUUID } from 'node:crypto';
import { canonical, exact, record, reject, ServiceError, slug, string } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import { RuntimeStore, type Receipt } from '../server/store.js';
import { valueDigest } from './base.js';
import { containsInlineSecret, type EffectiveDefinition } from './compiler.js';
import { validateBindings, type DefinitionBindingProvider } from './bindings.js';
import { inspectInstance, requestStage, recordStageOutcome, resolveAuthority, stageAdmission, stageBudget, type AuthorityResolver, type ExecutionAuthority, type LifecycleInstance, type ReleaseAuthority, type StageOutcome, type RecoveryLineageService } from './instance.js';
import { readImplementationEvidence } from '../adapters/implementation-stages.js';
import { readReleaseMaterial } from '../adapters/release-stages.js';
import { readPublicationEvidence } from '../adapters/publication-stage.js';
import {readClosureEvidence} from '../adapters/closure-stage.js';
import {EXTENSION_REVIEW_ADAPTER_ID,readExtensionReviewEvidence,type ExtensionReviewService} from './extension-review.js';
import {CI_PREPARATION_ADAPTER_ID,readCiPreparationEvidence} from '../adapters/ci-preparation.js';
import {readExtensionEvidence} from '../adapters/extension-stages.js';
import {readVerificationFeedbackForRequest} from '../adapters/stage-feedback.js';
import type { AuthorityPolicyProvider } from '../adapters/authority.js';

export const EXECUTION_READS=['lifecycle.stage.request.inspect','lifecycle.stage.observation.read','lifecycle.implementation.evidence.read','lifecycle.release.evidence.read','lifecycle.publication.evidence.read','lifecycle.verification.feedback.read','lifecycle.closure.evidence.read','lifecycle.extension.evidence.read'] as const;
export const EXECUTION_WRITES=['lifecycle.stage.request','lifecycle.stage.reconcile','lifecycle.stage.advance'] as const;
export interface StagePlan { adapterId:string; adapterDigest:string; action:string; bindingDigest:string; parameters:Record<string,unknown>; }
export interface StageRequest {
  schema:'runtime-stage-request/v1'; id:string; workspaceId:string; projectId:string;
  instanceId:string; stageId:string; pinsDigest:string; inputDigest:string;
  bindingStamp:string; authorityRef:string; releaseAuthorityRef:string|null;
  initiatedBy:{id:string;revision:number}; plan:StagePlan; planDigest:string;
  requestedAt:string; deadlineAt:string; digest:string;
}
export type StagePhase='DISPATCHING'|'WAITING_AGENT'|'CI_PENDING'|'CI_RUNNING'|'RUNNING'|'UNKNOWN'|'COMPLETE'|'FAILED';
export interface StageObservation { requestId:string; inputDigest:string; adapterDigest:string; phase:Exclude<StagePhase,'DISPATCHING'>; handle:Record<string,unknown>|null; outcome:StageOutcome; }
export interface StageProgress { requestId:string; phase:StagePhase; terminal:boolean; handle:Record<string,unknown>|null; observation:StageObservation|null; observationRef:string|null; reason:string|null; observedAt:string; }
export interface StageRepairInputs {
  sourceDigest:string; candidateDigest:string|null; toolchainDigest:string;
  /** Complete semantic dependency/input closure, including generated/build,
   * tests, assertions, locks, config, environment, fixtures, collector/prestate.
   * An incomplete/dynamic unknown closure cannot produce verified repair facts. */
  dependencyClosureDigest:string;
}
export interface StageRepairSubject {
  schema:'runtime-stage-repair-subject/v1'; workspaceId:string; projectId:string;
  instanceId:string; stageId:string; pinsDigest:string; authorityDigest:string;
  candidateDigest:string|null; history:{request:StageRequest;progress:StageProgress}[];
  preparedPlan:StagePlan;
}
export interface StageRepairFacts {
  schema:'runtime-stage-repair-facts/v1'; subjectDigest:string;
  failureClass:'DETERMINISTIC'|'TRANSIENT'|'UNKNOWN';
  before:StageRepairInputs; after:StageRepairInputs;
  /** Complete cumulative actual repair/verification rounds, not proposals. */
  rounds:{evidenceRef:string;beforeFactsDigest:string;afterFactsDigest:string}[];
  evidenceRef:string; expiresAt:string;
}
interface StageRepairAdmission {
  schema:'runtime-stage-repair-admission/v1'; requestId:string; requestDigest:string;
  subjectDigest:string; facts:StageRepairFacts; factsDigest:string; digest:string;
}
/** Fixed trusted adapters only. prepare and inspect must be read-only. dispatch
 * must call permit immediately before each authorized external side effect.
 * No API/YAML field can provide this implementation or a client PASS. */
export interface StageAdapter {
  prepare(instance:LifecycleInstance,stageId:string,actor:Principal,signal:AbortSignal):Promise<StagePlan>;
  dispatch(request:StageRequest,instance:LifecycleInstance,permit:()=>Promise<Principal>,signal:AbortSignal):Promise<StageObservation>;
  inspect(request:StageRequest,instance:LifecycleInstance,progress:StageProgress,actor:Principal,signal:AbortSignal):Promise<StageObservation>;
  /** Explicit continuation of the same retained plan, not a retry of dispatch.
   * Each remaining side effect still needs its own durable action/permit. */
  advance?(request:StageRequest,instance:LifecycleInstance,progress:StageProgress,permit:()=>Promise<Principal>,signal:AbortSignal):Promise<StageObservation>;
  /** Optional native recovery of this exact original request. Read-only owner
   * receipt lookup, with no permit callback: it may not dispatch or repeat an
   * action. Runtime persists the verified observation before permitting any
   * remaining continuation. An unresolved UNKNOWN never enters advance. */
  reconcileAdvance?(request:StageRequest,instance:LifecycleInstance,progress:StageProgress,actor:Principal,signal:AbortSignal):Promise<StageObservation>;
  /** Trusted native owner read. Independently verify original failure inputs,
   * prepared current semantic inputs and complete actual repair-round history.
   * Never infer these facts from proposal text, timestamps or a changed plan
   * digest. Missing evidence/contract returns null. No native adapter is assumed
   * to support this optional boundary; it cannot be configured through YAML. */
  verifyRepair?(subject:StageRepairSubject,actor:Principal,signal:AbortSignal):Promise<StageRepairFacts|null>;
}
export interface StageServices {
  releaseAuthority:(instance:LifecycleInstance,actor:Principal)=>ReleaseAuthority|undefined;
  authorityPolicy?:AuthorityPolicyProvider;
  extensionReviews?:ExtensionReviewService;
}
export interface ExecutionDependencies {
  bindings?:DefinitionBindingProvider; authorities?:AuthorityResolver; recovery?:RecoveryLineageService;
  verifyAuthority?:(grant:ExecutionAuthority,definition:EffectiveDefinition,actor:Principal)=>void;
  releaseAuthority?:(instance:LifecycleInstance,actor:Principal)=>ReleaseAuthority|undefined;
  principal:(id:string)=>Principal|null; adapter?:StageAdapter;
  verifyProjectReviews?:(instance:LifecycleInstance,actor:Principal,signal?:AbortSignal)=>Promise<void>;
  verifyProjectReviewState?:(instance:LifecycleInstance,actor:Principal,completingStageId?:string,completingDecision?:'APPROVE'|'REJECT')=>void;
}
const hash=(v:unknown)=>{const s=string(v,128);if(!/^sha256:[a-f0-9]{64}$/.test(s))reject('INVALID_EXECUTION_PIN','Exact content digest required');return s;};
function safeData(v:unknown):void{if(containsInlineSecret(canonical(v)))reject('INLINE_SECRET','Execution metadata cannot contain raw credentials');}
function immutable<T>(value:T):T{if(value&&typeof value==='object'){for(const item of Object.values(value))immutable(item);Object.freeze(value);}return value;}
const copy=<T>(v:T):T=>immutable(JSON.parse(canonical(v)) as T);
async function bounded<T>(operation:(signal:AbortSignal)=>Promise<T>,parent:AbortSignal,ms:number):Promise<T>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,onAbort:()=>void=()=>{};
  try{return await Promise.race([Promise.resolve().then(()=>{controller.signal.throwIfAborted();return operation(controller.signal);}),new Promise<never>((_r,fail)=>{
    onAbort=()=>{controller.abort();fail(new ServiceError('OBSERVATION_INTERRUPTED','Inspect the retained original request',409));};
    parent.addEventListener('abort',onAbort,{once:true});timer=setTimeout(onAbort,Math.max(1,ms));if(parent.aborted)onAbort();
  })]);}finally{if(timer)clearTimeout(timer);parent.removeEventListener('abort',onAbort);}
}

export function createExecutionService(store:RuntimeStore,deps:ExecutionDependencies){
  const active=new Map<string,{controller:AbortController;promise:Promise<void>}>();
  // A continuation must retain its worker slot while its read-only permission
  // checks await owners/providers. No receipt or adapter action exists yet.
  const advancing=new Map<string,{controller:AbortController;done:Promise<void>}>();
  const occupied=()=>active.size+advancing.size;
  const nextObservation=new Map<string,number>();
  let workerError:{projectId:string;requestId:string;code:string}|null=null;
  let scanError:string|null=null;
  let closed=false,cursor:{projectId:string;id:string}|undefined;
  const key=(projectId:string,id:string)=>projectId+'\0'+id;
  const system=(projectId:string):Principal=>({id:'runtime:observer',projects:[projectId],permissions:['read'],revision:1,expiresAt:new Date(Date.now()+60000).toISOString()});
  function instance(projectId:string,id:string):LifecycleInstance{
    const raw=store.object(projectId,'lifecycle-instance',id);if(!raw)reject('NOT_FOUND','Lifecycle instance not found',404);
    const value=inspectInstance(raw as LifecycleInstance);if(value.id!==id||value.pins.projectId!==projectId)reject('CORRUPT_INSTANCE','Instance scope differs',503);return value;
  }
  function request(projectId:string,id:string):StageRequest{
    const raw=store.object(projectId,'stage-request',id);if(!raw)reject('NOT_FOUND','Stage request not found',404);
    const r=raw as StageRequest,{digest,...content}=r;
    if(r.schema!=='runtime-stage-request/v1'||r.workspaceId!==store.workspaceId||r.projectId!==projectId||r.id!==id||valueDigest(content)!==digest||valueDigest(r.plan)!==r.planDigest)reject('CORRUPT_STAGE_REQUEST','Stage request pins changed',503);return copy(r);
  }
  function progress(r:StageRequest):StageProgress{
    const p=store.object(r.projectId,'stage-progress',r.id) as StageProgress|null;
    if(!p||p.requestId!==r.id)reject('CORRUPT_STAGE_REQUEST','Stage progress is missing or mismatched',503);return copy(p);
  }
  function stageRequests(saved:LifecycleInstance,stageId:string,excluding?:string):StageRequest[]{
    const selected:StageRequest[]=[];
    for(const id of saved.requestIds){
      if(id===excluding)continue;
      const raw=store.object(saved.pins.projectId,'stage-request',id);
      // Only selected-stage history is relevant here. Its complete count and
      // exact request contract remain mandatory; unrelated owner records are
      // not reinterpreted as current executor requests.
      if(raw&&typeof raw==='object'&&'stageId' in raw&&raw.stageId===stageId)selected.push(request(saved.pins.projectId,id));
    }
    if(selected.length!==saved.stages[stageId].attempts-(excluding?1:0))reject('REPAIR_HISTORY_REQUIRED','Complete retained same-stage attempt history is required',409);
    return selected;
  }
  function repairHistory(saved:LifecycleInstance,stageId:string,authorityRef:string,excluding?:string):StageRepairSubject['history']{
    const history=stageRequests(saved,stageId,excluding).map(r=>({request:r,progress:progress(r)}));
    if(!history.length)reject('REPAIR_HISTORY_REQUIRED','Complete retained same-stage attempt history is required',409);
    for(const {request:r,progress:p} of history){
      exact(record(p),['requestId','phase','terminal','handle','observation','observationRef','reason','observedAt']);
      if(r.instanceId!==saved.id||r.pinsDigest!==saved.pinsDigest||r.authorityRef!==authorityRef||p.phase!=='FAILED'||!p.observation||!p.observationRef)reject('REPAIR_HISTORY_REQUIRED','Only exact confirmed failures within the original instance/grant can be retried',409);
      if(p.terminal!==true||p.observation.phase!==p.phase||p.observation.outcome.status!=='FAILED'||canonical(p.handle)!==canonical(p.observation.handle)||!Number.isFinite(Date.parse(p.observedAt))||!Number.isFinite(Date.parse(r.deadlineAt)))reject('CORRUPT_STAGE_OBSERVATION','Failure progress, outcome and original observation disagree',503);
      validateObservation(r,p,p.observation);
      const observation=store.object(r.projectId,'stage-observation',p.observationRef);
      if(!observation)reject('REPAIR_HISTORY_REQUIRED','Original immutable failure observation is required',409);
      const envelope=record(observation);exact(envelope,['schema','requestId','observation','reason','observedAt']);
      if(envelope.schema!=='runtime-stage-observation/v1'||envelope.requestId!==r.id||valueDigest(envelope)!==p.observationRef||canonical(envelope.observation)!==canonical(p.observation)||envelope.reason!==p.reason||envelope.observedAt!==p.observedAt)reject('CORRUPT_STAGE_OBSERVATION','Mutable failure progress differs from the exact immutable observation envelope',503);
    }
    return history;
  }
  function repairSubject(saved:LifecycleInstance,stageId:string,plan:StagePlan,history:StageRepairSubject['history']):StageRepairSubject{
    return copy({schema:'runtime-stage-repair-subject/v1',workspaceId:store.workspaceId,projectId:saved.pins.projectId,instanceId:saved.id,stageId,pinsDigest:saved.pinsDigest,authorityDigest:saved.pins.authorityDigest,candidateDigest:saved.candidateDigest,history,preparedPlan:plan});
  }
  function repairAdmission(r:StageRequest):StageRepairAdmission{
    const raw=store.object(r.projectId,'lifecycle-recovery-admission',r.id);
    if(!raw)reject('REPAIR_ADMISSION_REQUIRED','Retry has no retained trusted repair admission',409);
    const v=record(raw);exact(v,['schema','requestId','requestDigest','subjectDigest','facts','factsDigest','digest']);
    const {digest,...body}=v;
    if(v.schema!=='runtime-stage-repair-admission/v1'||v.requestId!==r.id||v.requestDigest!==r.digest||valueDigest(body)!==digest||valueDigest(v.facts)!==v.factsDigest||record(v.facts).subjectDigest!==v.subjectDigest)reject('CORRUPT_REPAIR_ADMISSION','Retained repair admission changed',503);
    return copy(v as unknown as StageRepairAdmission);
  }
  function validateRepair(facts:StageRepairFacts,subject:StageRepairSubject):void{
    exact(record(facts),['schema','subjectDigest','failureClass','before','after','rounds','evidenceRef','expiresAt']);safeData(facts);
    if(facts.schema!=='runtime-stage-repair-facts/v1'||facts.subjectDigest!==valueDigest(subject))reject('REPAIR_FACTS_MISMATCH','Trusted repair facts must cover the exact original failures and prepared plan',409);
    if(!['DETERMINISTIC','TRANSIENT','UNKNOWN'].includes(facts.failureClass))reject('INVALID_REPAIR_FACTS','Unsupported failure classification');
    for(const inputs of [facts.before,facts.after]){
      exact(record(inputs),['sourceDigest','candidateDigest','toolchainDigest','dependencyClosureDigest']);
      hash(inputs.sourceDigest);hash(inputs.toolchainDigest);hash(inputs.dependencyClosureDigest);if(inputs.candidateDigest!==null)hash(inputs.candidateDigest);
      if(inputs.candidateDigest!==subject.candidateDigest)reject('REPAIR_CANDIDATE_CHANGED','Repair must preserve the immutable instance candidate',409);
    }
    string(facts.evidenceRef,512);
    if(!Number.isFinite(Date.parse(facts.expiresAt))||Date.parse(facts.expiresAt)<=Date.now())reject('REPAIR_EVIDENCE_EXPIRED','Current trusted repair evidence is required',409);
    if(!Array.isArray(facts.rounds)||facts.rounds.length>4096)reject('INVALID_REPAIR_FACTS','Bounded actual repair history required');
    const rounds=new Set<string>();
    for(const round of facts.rounds){exact(record(round),['evidenceRef','beforeFactsDigest','afterFactsDigest']);string(round.evidenceRef,512);hash(round.beforeFactsDigest);hash(round.afterFactsDigest);if(rounds.has(round.evidenceRef))reject('INVALID_REPAIR_FACTS','A repair round cannot be counted twice');rounds.add(round.evidenceRef);}
    if(facts.failureClass==='UNKNOWN')reject('REPAIR_FAILURE_UNKNOWN','Unknown failures require original observation or verified classification',409);
    if(facts.failureClass==='DETERMINISTIC'&&valueDigest(facts.before)===valueDigest(facts.after))reject('UNCHANGED_DETERMINISTIC_FAILURE','A new request or plan timestamp cannot repair identical semantic inputs',409);
    if(facts.failureClass==='DETERMINISTIC'&&!facts.rounds.length)reject('REPAIR_VERIFICATION_REQUIRED','Deterministic repair requires an actual completed minimal verification',409);
    if(facts.rounds.length>=2&&facts.rounds.slice(-2).every(r=>r.beforeFactsDigest===r.afterFactsDigest))reject('TWO_NO_PROGRESS_ROUNDS','Two completed repair rounds made no observed progress',409);
    // Later retries cannot relabel the preceding inputs or erase earlier rounds.
    for(const item of subject.history.slice(1)){
      const prior=repairAdmission(item.request);
      if(canonical(facts.rounds.slice(0,prior.facts.rounds.length))!==canonical(prior.facts.rounds))reject('REPAIR_HISTORY_CHANGED','Cumulative repair history cannot be reset by a new request',409);
    }
    if(subject.history.length>1&&valueDigest(repairAdmission(subject.history.at(-1)!.request).facts.after)!==valueDigest(facts.before))reject('REPAIR_HISTORY_CHANGED','Original failed semantic inputs differ from their retained admission',409);
  }
  async function verifyRepair(subject:StageRepairSubject,actor:Principal,signal:AbortSignal):Promise<StageRepairFacts>{
    if(!deps.adapter?.verifyRepair)reject('REPAIR_VERIFIER_UNAVAILABLE','This native adapter cannot independently verify repair; a proposal does not authorize retry',409);
    const facts=await deps.adapter.verifyRepair(subject,actor,signal);signal.throwIfAborted();
    if(!facts)reject('REPAIR_EVIDENCE_REQUIRED','Original failure and complete prepared repair facts could not be verified',409);
    const checked=copy(facts);validateRepair(checked,subject);return checked;
  }
  function fixedInstance(r:StageRequest):LifecycleInstance{
    const saved=instance(r.projectId,r.instanceId),stage=saved.stages[r.stageId];
    if(saved.pinsDigest!==r.pinsDigest||!stage||stage.requestId!==r.id||stage.inputDigest!==r.inputDigest)reject('STAGE_REQUEST_MISMATCH','Original request does not match the immutable instance attempt',409);return saved;
  }
  function actorFor(r:StageRequest):Principal{
    const actor=deps.principal(r.initiatedBy.id);
    if(!actor||actor.revision!==r.initiatedBy.revision)reject('AUTHORITY_CHANGED','Original execution principal changed',403);
    authorize(actor,r.projectId,'execution.request');if(r.stageId==='publication')authorize(actor,r.projectId,'release.request');return actor;
  }
  async function admission(saved:LifecycleInstance,stageId:string,actor:Principal,signal?:AbortSignal){
    signal?.throwIfAborted();
    const ref=store.object(saved.pins.projectId,'instance-authority',saved.id) as {evidenceRef:string}|null;
    if(!ref)reject('CORRUPT_INSTANCE','Instance authority reference missing',503);
    const authority=await resolveAuthority(deps.authorities,ref.evidenceRef,saved.definition,actor);
    signal?.throwIfAborted();
    const checked=await validateBindings(saved.definition,actor,deps.bindings);
    signal?.throwIfAborted();
    deps.verifyAuthority?.(authority,saved.definition,actor);
    if(saved.definition.nodes.some(n=>n.action?.actionRef==='runtime.review.scope'&&saved.stages[n.id].status==='PASSED')){if(!deps.verifyProjectReviews)reject('EXTENSION_REVIEW_UNAVAILABLE','Current project review verification is required',409);await deps.verifyProjectReviews(saved,actor,signal);}
    signal?.throwIfAborted();
    const release=stageId==='publication'?deps.releaseAuthority?.(saved,actor):undefined;
    return{authority,checked,release,context:{authority,bindingsCurrent:checked.ready,releaseAuthority:release}};
  }
  // observationOnly is internal advance preflight, never an adapter capability.
  // Every callback supplied to dispatch/advance uses the strict default.
  async function permit(r:StageRequest,signal?:AbortSignal,observationOnly=false):Promise<Principal>{
    signal?.throwIfAborted();
    if(closed)reject('STOPPING','Service is stopping',503);
    if(Date.parse(r.deadlineAt)<=Date.now())reject('EXECUTION_DEADLINE','This original request exhausted its dispatch time budget',409);
    const saved=fixedInstance(r),actor=actorFor(r),current=await admission(saved,r.stageId,actor,signal);
    signal?.throwIfAborted();
    if(!current.checked.ready||current.checked.stamp!==r.bindingStamp||valueDigest(current.authority)!==saved.pins.authorityDigest||current.authority.evidenceRef!==r.authorityRef||(current.release?.decisionRef??null)!==r.releaseAuthorityRef)reject('EXECUTION_BINDING_CHANGED','Current execution pins or authority differ from the retained request',409);
    if(!observationOnly&&progress(r).phase==='UNKNOWN')reject('RECONCILE_ORIGINAL_REQUEST','Unknown outcomes allow only observation of the original request',409);
    if(saved.stages[r.stageId].attempts>1){
      const retained=repairAdmission(r),history=repairHistory(saved,r.stageId,r.authorityRef,r.id),subject=repairSubject(saved,r.stageId,r.plan,history);
      if(retained.subjectDigest!==valueDigest(subject))reject('REPAIR_FACTS_MISMATCH','Retained repair does not match this original request history',409);
      validateRepair(retained.facts,subject);
      const observed=await bounded(s=>verifyRepair(subject,actor,s),signal??new AbortController().signal,Math.max(1,Math.min(5000,Date.parse(r.deadlineAt)-Date.now())));
      const stable=(f:StageRepairFacts)=>{const {expiresAt,...content}=f;return valueDigest(content);};
      if(stable(observed)!==stable(retained.facts))reject('REPAIR_FACTS_CHANGED','Semantic repair facts changed after admission',409);
      validateRepair(retained.facts,subject);
    }
    const lineage=deps.recovery?.admission(saved,current.authority,r.stageId,actor,r.id);if(lineage&&!lineage.allowed)reject('EXECUTION_RECOVERY_BLOCKED',lineage.reasons.join('; '),409);
    const fresh=actorFor(r);deps.verifyAuthority?.(current.authority,saved.definition,fresh);deps.verifyProjectReviewState?.(saved,fresh);
    if(closed||Date.parse(r.deadlineAt)<=Date.now())reject('EXECUTION_DEADLINE','This original request cannot dispatch now',409);return fresh;
  }
  function validateObservation(r:StageRequest,prior:StageProgress,observation:StageObservation):void{
    exact(record(observation),['requestId','inputDigest','adapterDigest','phase','handle','outcome']);safeData(observation);
    if(observation.requestId!==r.id||observation.inputDigest!==r.inputDigest||observation.adapterDigest!==r.plan.adapterDigest)reject('OBSERVATION_MISMATCH','Adapter observation belongs to another original request',409);
    if(!['WAITING_AGENT','CI_PENDING','CI_RUNNING','RUNNING','UNKNOWN','COMPLETE','FAILED'].includes(observation.phase))reject('INVALID_STAGE_PROGRESS','Unsupported adapter progress');
    if(observation.handle!==null){record(observation.handle);if(Buffer.byteLength(canonical(observation.handle))>8192)reject('INVALID_STAGE_PROGRESS','Provider handle is too large');}
    if(prior.handle!==null&&canonical(prior.handle)!==canonical(observation.handle))reject('PROVIDER_HANDLE_CHANGED','An original provider handle cannot be replaced',409);
    if(observation.outcome.requestId!==r.id||observation.outcome.inputDigest!==r.inputDigest||observation.outcome.status!==(observation.phase==='COMPLETE'?'COMPLETE':observation.phase==='FAILED'?'FAILED':observation.phase==='UNKNOWN'?'UNKNOWN':'RUNNING'))reject('INVALID_STAGE_PROGRESS','Phase and exact stage outcome disagree');
  }
  function recordObservation(r:StageRequest,observation:StageObservation,reason:string|null=null):void{
    const p=progress(r);if(p.terminal)return;
    validateObservation(r,p,observation);const saved=fixedInstance(r);if(observation.phase==='COMPLETE'||observation.phase==='FAILED'&&r.plan.action==='runtime.review.scope')deps.verifyProjectReviewState?.(saved,system(r.projectId),r.stageId,observation.phase==='FAILED'?'REJECT':'APPROVE');const next=recordStageOutcome(saved,r.stageId,observation.outcome);
    if(canonical(p.observation)===canonical(observation)&&p.reason===reason)return;
    const evidence={schema:'runtime-stage-observation/v1',requestId:r.id,observation,reason,observedAt:new Date().toISOString()},observationRef=valueDigest(evidence);
    const updated:StageProgress={requestId:r.id,phase:observation.phase,terminal:['COMPLETE','FAILED'].includes(observation.phase),handle:observation.handle,observation,observationRef,reason,observedAt:evidence.observedAt};
    // A service observation is not a user decision. This internal identity
    // cannot exist in auth.json (':' is not an allowed principal ID).
    store.mutate(system(r.projectId),{projectId:r.projectId,operation:'lifecycle.stage.observed',requestId:'observe-'+randomUUID(),expectedRevision:store.revision(r.projectId),input:{stageRequestId:r.id,observationRef,reason},permission:'read'},()=>({objects:[{kind:'lifecycle-instance',id:r.instanceId,value:next},{kind:'stage-progress',id:r.id,value:updated},{kind:'stage-observation',id:observationRef,value:evidence}],value:{stageRequestId:r.id,phase:updated.phase,observationRef},event:{type:'stage-observed',data:{instanceId:r.instanceId,stageId:r.stageId,stageRequestId:r.id,phase:updated.phase,reason,observationRef,initiatedBy:r.initiatedBy.id}}}));
    if(workerError?.projectId===r.projectId&&workerError.requestId===r.id)workerError=null;
  }
  function unknown(r:StageRequest,code:string):void{
    const p=progress(r);if(p.terminal)return;
    // Keep the last actual provider handle and receipt in history; uncertainty
    // does not imply a confirmed external failure or grant another attempt.
    const observation:StageObservation={requestId:r.id,inputDigest:r.inputDigest,adapterDigest:r.plan.adapterDigest,phase:'UNKNOWN',handle:p.handle,outcome:{requestId:r.id,inputDigest:r.inputDigest,receiptRef:'runtime:stage/'+r.id,status:'UNKNOWN',expiresAt:r.deadlineAt,checks:[]}};
    recordObservation(r,observation,code);
  }
  function start(r:StageRequest,mode:'dispatch'|'inspect'|'advance'):void{
    const id=key(r.projectId,r.id);if(closed||active.has(id)||advancing.has(id)||occupied()>=4||progress(r).terminal)return;
    if(!deps.adapter){unknown(r,'EXECUTOR_UNAVAILABLE');return;}
    const controller=new AbortController();
    const promise=Promise.resolve().then(async()=>{
      try{
        let saved=fixedInstance(r);
        const observed=await bounded(async signal=>{
          let observation:StageObservation;
          if(mode==='dispatch'){await permit(r,signal);observation=await deps.adapter!.dispatch(r,saved,()=>permit(r,signal),signal);}
          else if(mode==='advance'){
            const prior=progress(r);
            if(prior.phase==='UNKNOWN'){
              if(!deps.adapter!.reconcileAdvance)reject('RECONCILE_ORIGINAL_REQUEST','This adapter has no read-only original-receipt recovery',409);
              const reconciled=await deps.adapter!.reconcileAdvance(r,saved,prior,system(r.projectId),signal);
              await deps.verifyProjectReviews?.(fixedInstance(r),system(r.projectId),signal);signal.throwIfAborted();
              recordObservation(r,reconciled);
              if(['UNKNOWN','COMPLETE','FAILED'].includes(reconciled.phase))return reconciled;
              saved=fixedInstance(r);
            }
            await permit(r,signal);if(!deps.adapter!.advance)reject('STAGE_ADVANCE_UNAVAILABLE','This adapter has no explicitly requested continuation');
            observation=await deps.adapter!.advance(r,saved,progress(r),()=>permit(r,signal),signal);
          }
          else observation=await deps.adapter!.inspect(r,saved,progress(r),system(r.projectId),signal);
          await deps.verifyProjectReviews?.(fixedInstance(r),system(r.projectId),signal);signal.throwIfAborted();return observation;
        // Multi-request provider protocols include current permit checks and
        // immutable ref creation. Keep their transport window bounded without
        // replacing or extending the already approved original stage deadline.
        },controller.signal,mode!=='inspect'?Math.max(1,Math.min(60000,Date.parse(r.deadlineAt)-Date.now())):30000);
        recordObservation(r,observed);
      }catch(e){unknown(r,e instanceof ServiceError?e.code:'ADAPTER_OUTCOME_UNKNOWN');}
    }).catch(e=>{
      // A local persistence/integrity failure cannot be rewritten as PASS. The
      // durable request stays recoverable and subsequent inspection reports it.
      workerError={projectId:r.projectId,requestId:r.id,code:e instanceof ServiceError?e.code:'OBSERVATION_PERSISTENCE_FAILED'};
    }).finally(()=>{active.delete(id);nextObservation.set(id,Date.now()+2000);try{if(progress(r).terminal)nextObservation.delete(id);}catch{/* Retain the worker error and original request; do not reject an unowned promise. */}});
    active.set(id,{controller,promise});
  }
  function observePending():void{
    if(closed)return;
    try{
      const page=store.pendingStageRequests(cursor);scanError=null;let consumed=0;
      for(const item of page.rows){if(occupied()>=4)break;cursor=item;consumed++;const id=key(item.projectId,item.id);if(advancing.has(id)||(nextObservation.get(id)??0)>Date.now())continue;try{const r=request(item.projectId,item.id);start(r,'inspect');}catch(e){workerError={projectId:item.projectId,requestId:item.id,code:e instanceof ServiceError?e.code:'OBSERVATION_UNAVAILABLE'};}}
      if(consumed===page.rows.length&&!page.next)cursor=undefined;
    }catch(e){scanError=e instanceof ServiceError?e.code:'OBSERVATION_INDEX_UNAVAILABLE';}
  }
  // Before accepting requests, mark interrupted work as requiring original
  // request inspection. A process crash is never proof that dispatch failed.
  let after:{projectId:string;id:string}|undefined;
  do{const page=store.pendingStageRequests(after);for(const item of page.rows)unknown(request(item.projectId,item.id),'SERVICE_RESTART_RECONCILE');after=page.next??undefined;}while(after);
  const timer=setInterval(observePending,1000);timer.unref();
  function read(actor:Principal,projectId:string,operation:string,input:Record<string,unknown>):unknown{
    authorize(actor,projectId,'read');
    if(operation==='lifecycle.verification.feedback.read'){exact(input,['stageRequestId']);return{event:readVerificationFeedbackForRequest(store,actor,request(projectId,string(input.stageRequestId))),historical:true,feedbackDelivered:false,releaseAuthorized:false};}
    if(operation==='lifecycle.extension.evidence.read'){exact(input,['stageRequestId']);const r=request(projectId,string(input.stageRequestId));return r.plan.adapterId===EXTENSION_REVIEW_ADAPTER_ID?readExtensionReviewEvidence(store,r):r.plan.adapterId===CI_PREPARATION_ADAPTER_ID?readCiPreparationEvidence(store,r):readExtensionEvidence(store,r);}
    if(operation==='lifecycle.closure.evidence.read'){exact(input,['stageRequestId']);return readClosureEvidence(store,request(projectId,string(input.stageRequestId)));}
    if(operation==='lifecycle.publication.evidence.read'){exact(input,['stageRequestId']);return readPublicationEvidence(store,request(projectId,string(input.stageRequestId)));}
    if(operation==='lifecycle.release.evidence.read'){
      exact(input,['stageRequestId']);const r=request(projectId,string(input.stageRequestId));if(r.stageId!=='release-decision')reject('STAGE_SCOPE','Release material requires its original admission request',409);
      return{material:readReleaseMaterial(store,fixedInstance(r),false),historical:true,releaseAuthorized:false};
    }
    if(operation==='lifecycle.implementation.evidence.read'){exact(input,['stageRequestId']);const r=request(projectId,string(input.stageRequestId));if(r.stageId!=='implementation')reject('STAGE_SCOPE','Implementation evidence requires the original coding request',409);return readImplementationEvidence(store,r);}
    if(operation==='lifecycle.stage.observation.read'){
      exact(input,['stageRequestId','observationRef']);const r=request(projectId,string(input.stageRequestId)),ref=hash(input.observationRef),evidence=store.object(projectId,'stage-observation',ref);
      if(!evidence||record(evidence).requestId!==r.id)reject('NOT_FOUND','Observation not found for this exact request',404);
      if(valueDigest(evidence)!==ref)reject('CORRUPT_STAGE_OBSERVATION','Retained observation content changed',503);
      return{observationRef:ref,evidence,historical:true};
    }
    if(operation!=='lifecycle.stage.request.inspect')reject('UNKNOWN_OPERATION','Unsupported execution read',404);exact(input,['stageRequestId']);
    const r=request(projectId,string(input.stageRequestId));return{request:r,progress:progress(r),repairAdmission:store.object(projectId,'lifecycle-recovery-admission',r.id)?repairAdmission(r):null,workerError:workerError?.projectId===projectId&&workerError.requestId===r.id?workerError.code:null,projectRevision:store.revision(projectId),automaticRedispatch:false};
  }
  async function prepareAdmission(saved:LifecycleInstance,stageId:string,actor:Principal){
    const projectId=saved.pins.projectId,node=saved.definition.nodes.find(n=>n.id===stageId)!;
    // Fresh admission and the multi-read provider preparation share one bounded
    // response window. They do not create a receipt, attempt or external action.
    // The original instance/authority cutoff always wins over transport limits;
    // a late read-only promise cannot proceed to prepare or commit after abort.
    const previous=stageRequests(saved,stageId);
    const preparationDeadline=Math.min(Date.parse(saved.createdAt)+saved.pins.budget.timeoutSeconds*1000,Date.parse(saved.pins.authorityExpiresAt),previous.length?Date.parse(previous[0].deadlineAt):Infinity),preparationRemaining=preparationDeadline-Date.now();
    if(!Number.isFinite(preparationRemaining))reject('EXECUTION_DEADLINE','Original execution admission has an invalid deadline',409);
    // An already expired request still reads native admission so its existing
    // AUTHORITY_EXPIRED or STAGE_BLOCKED reasons remain authoritative. This
    // bounded diagnostic path can never proceed to prepare or persistence.
    const admissionWindow=preparationRemaining<=0?18000:Math.min(18000,preparationRemaining);
    const {current,admitted,plan,repair,effectiveDeadline}=await bounded(async signal=>{
      const current=await admission(saved,stageId,actor,signal);signal.throwIfAborted();
      const admitted=stageAdmission(saved,stageId,current.context);
      if(!admitted.allowed)reject('STAGE_BLOCKED',admitted.reasons.join('; '),409);
      const history=saved.stages[stageId].attempts>0?repairHistory(saved,stageId,current.authority.evidenceRef):null;
      const lineage=deps.recovery?.admission(saved,current.authority,stageId,actor);
      if(lineage&&!lineage.allowed)reject('STAGE_BLOCKED',lineage.reasons.join('; '),409);
      const effectiveDeadline=Math.min(preparationDeadline,Date.parse(current.authority.expiresAt),lineage?Date.parse(lineage.deadlineAt):Infinity);
      const remaining=effectiveDeadline-Date.now();
      if(!Number.isFinite(remaining)||remaining<=0)reject('EXECUTION_DEADLINE','Original execution admission has expired',409);
      const plan=copy(await bounded(preparing=>deps.adapter!.prepare(saved,stageId,actor,preparing),signal,Math.min(15000,remaining)));
      signal.throwIfAborted();
      exact(record(plan),['adapterId','adapterDigest','action','bindingDigest','parameters']);slug(plan.adapterId);hash(plan.adapterDigest);hash(plan.bindingDigest);record(plan.parameters);safeData(plan);
      if(plan.action!==(node.source==='base'?'base.'+node.id:node.action!.actionRef))reject('ACTION_MISMATCH','Adapter action does not match the fixed Base/extension action',409);
      let repair:{subject:StageRepairSubject;facts:StageRepairFacts}|null=null;
      if(saved.stages[stageId].attempts>0){
        if(saved.stages[stageId].status!=='FAILED')reject('REPAIR_HISTORY_REQUIRED','A new attempt requires the exact retained failed stage',409);
        const subject=repairSubject(saved,stageId,plan,history!);
        const facts=await bounded(s=>verifyRepair(subject,actor,s),signal,Math.max(1,Math.min(5000,effectiveDeadline-Date.now())));
        signal.throwIfAborted();repair={subject,facts};
      }
      return{current,admitted,plan,repair,effectiveDeadline};
    },new AbortController().signal,admissionWindow);
    return{current,admitted,plan,repair,preparationDeadline:effectiveDeadline};
  }
  async function write(actor:Principal,projectId:string,operation:string,input:Record<string,unknown>,requestId:string,expectedRevision:number,reauthorize:()=>Principal):Promise<Receipt>{
    if(closed)reject('STOPPING','Service is stopping',503);
    if(!EXECUTION_WRITES.includes(operation as typeof EXECUTION_WRITES[number]))reject('UNKNOWN_OPERATION','Unsupported execution operation',404);
    const reconciling=operation==='lifecycle.stage.reconcile',continuing=operation==='lifecycle.stage.advance',permission=reconciling?'read':'execution.request';authorize(actor,projectId,permission);
    exact(input,reconciling||continuing?['stageRequestId']:['instanceId','stageId']);
    const mutation={projectId,operation,requestId,expectedRevision,input,permission} as const;
    if(store.findReceipt(actor,projectId,requestId))return store.mutate(actor,mutation,()=>{throw new Error('Unreachable replay callback');},reauthorize);
    if(continuing){
      const r=request(projectId,string(input.stageRequestId)),p=progress(r);
      if(actor.id!==r.initiatedBy.id||actor.revision!==r.initiatedBy.revision)reject('AUTHORITY_CHANGED','Only the original current execution principal may continue this request',403);
      if(p.phase==='UNKNOWN'&&!deps.adapter?.reconcileAdvance)reject('RECONCILE_ORIGINAL_REQUEST','Unknown outcomes permit only original request observation',409);
      if(!deps.adapter?.advance)reject('STAGE_ADVANCE_UNAVAILABLE','This adapter has no explicitly requested continuation',409);
      const id=key(projectId,r.id);
      if(active.has(id)||advancing.has(id)||occupied()>=4)reject('EXECUTOR_BUSY','Wait for the retained original observation; do not create a replacement stage',429);
      let finished:()=>void=()=>{};
      const reservation={controller:new AbortController(),done:new Promise<void>(resolve=>{finished=resolve;})};
      advancing.set(id,reservation);
      try{
        if(!p.terminal){
          const remaining=Date.parse(r.deadlineAt)-Date.now();
          if(remaining<=0)reject('EXECUTION_DEADLINE','This original request exhausted its dispatch time budget',409);
          await bounded(signal=>permit(r,signal,p.phase==='UNKNOWN'),reservation.controller.signal,Math.min(18000,remaining));
        }
        if(closed||reservation.controller.signal.aborted)reject('STOPPING','Service is stopping',503);
        if(advancing.get(id)!==reservation||active.has(id))reject('EXECUTOR_BUSY','Original continuation reservation changed',429);
        const result=store.mutate(actor,mutation,()=>{
          if(closed||reservation.controller.signal.aborted)reject('STOPPING','Service is stopping',503);
          if(!p.terminal&&Date.parse(r.deadlineAt)<=Date.now())reject('EXECUTION_DEADLINE','Original continuation expired before request commit',409);
          return{value:{stageRequestId:r.id,status:p.terminal?'TERMINAL':'ADVANCE_REQUESTED',newAttempt:false,deadlineAt:r.deadlineAt},event:{type:'stage-advance-requested',data:{instanceId:r.instanceId,stageId:r.stageId,stageRequestId:r.id,newAttempt:false}}};
        },reauthorize);
        // Synchronous handoff: no observer or second request can acquire the
        // slot between the durable original receipt and start().
        advancing.delete(id);if(!p.terminal)start(r,'advance');return result;
      }finally{if(advancing.get(id)===reservation)advancing.delete(id);finished();}
    }
    if(reconciling){
      const r=request(projectId,string(input.stageRequestId)),p=progress(r);
      const result=store.mutate(actor,mutation,()=>({value:{stageRequestId:r.id,status:p.terminal?'TERMINAL':'INSPECT_ORIGINAL',automaticRedispatch:false},event:{type:'stage-inspection-requested',data:{instanceId:r.instanceId,stageId:r.stageId,stageRequestId:r.id,automaticRedispatch:false}}}),reauthorize);
      start(r,'inspect');return result;
    }
    if(!deps.adapter)reject('EXECUTOR_UNAVAILABLE','No fixed stage adapter is configured',409);
    if(occupied()>=4)reject('EXECUTOR_BUSY','The bounded service worker is busy',429);
    const saved=instance(projectId,slug(input.instanceId)),stageId=string(input.stageId),node=saved.definition.nodes.find(n=>n.id===stageId);
    if(!node)reject('UNKNOWN_STAGE','Stage does not belong to this immutable instance');
    if(stageId==='publication')authorize(actor,projectId,'release.request');
    const {current,admitted,plan,repair,preparationDeadline}=await prepareAdmission(saved,stageId,actor);
    const planned=copy(plan),now=Date.now(),limit=stageBudget(saved,node);
    const content:Omit<StageRequest,'digest'>={schema:'runtime-stage-request/v1',id:randomUUID(),workspaceId:store.workspaceId,projectId,instanceId:saved.id,stageId,pinsDigest:saved.pinsDigest,inputDigest:admitted.inputDigest,bindingStamp:current.checked.stamp!,authorityRef:current.authority.evidenceRef,releaseAuthorityRef:current.release?.decisionRef??null,initiatedBy:{id:actor.id,revision:actor.revision},plan:planned,planDigest:valueDigest(planned),requestedAt:new Date(now).toISOString(),deadlineAt:new Date(Math.min(now+limit.timeoutSeconds*1000,preparationDeadline,Date.parse(current.authority.expiresAt))).toISOString()};
    const r=copy({...content,digest:valueDigest(content)});
    const repairBody=repair?{schema:'runtime-stage-repair-admission/v1' as const,requestId:r.id,requestDigest:r.digest,subjectDigest:valueDigest(repair.subject),facts:repair.facts,factsDigest:valueDigest(repair.facts)}:null;
    const retainedRepair:StageRepairAdmission|null=repairBody?copy({...repairBody,digest:valueDigest(repairBody)}):null;
    const result=store.mutate(actor,mutation,()=>{
      if(closed)reject('STOPPING','Service is stopping',503);
      if(occupied()>=4)reject('EXECUTOR_BUSY','The bounded service worker is busy',429);
      const fresh=reauthorize();authorize(fresh,projectId,'execution.request');if(stageId==='publication')authorize(fresh,projectId,'release.request');
      deps.verifyAuthority?.(current.authority,saved.definition,fresh);deps.verifyProjectReviewState?.(saved,fresh);
      if(!current.checked.expiresAt||Date.parse(current.checked.expiresAt)<=Date.now()||Date.parse(r.deadlineAt)<=Date.now())reject('EXECUTION_DEADLINE','Execution admission expired before request commit',409);
      if(repair)validateRepair(repair.facts,repair.subject);
      if(stageId==='publication'&&deps.releaseAuthority?.(saved,fresh)?.decisionRef!==r.releaseAuthorityRef)reject('AUTHORITY_CHANGED','Release authority changed before request commit',409);
      const recoveryObjects=deps.recovery?.claim(saved,current.authority,r,fresh)??[];
      const next=requestStage(saved,stageId,r.id,current.context),p:StageProgress={requestId:r.id,phase:'DISPATCHING',terminal:false,handle:null,observation:null,observationRef:null,reason:null,observedAt:r.requestedAt};
      return{objects:[{kind:'lifecycle-instance',id:saved.id,value:next},{kind:'stage-request',id:r.id,value:r},{kind:'stage-progress',id:r.id,value:p},...recoveryObjects,...(retainedRepair?[{kind:'lifecycle-recovery-admission',id:r.id,value:retainedRepair}]:[])],value:{stageRequestId:r.id,instanceId:saved.id,stageId,inputDigest:r.inputDigest,status:'REQUEST_RETAINED',automaticRedispatch:false},event:{type:'stage-requested',data:{instanceId:saved.id,stageId,stageRequestId:r.id,inputDigest:r.inputDigest,planDigest:r.planDigest,initiatedBy:actor.id}}};
    },reauthorize);
    // The transaction, receipt and audit are durable before this promise can
    // perform an external action. Replays/restarts never enter this branch.
    start(r,'dispatch');return result;
  }
  return{read,write,async correctionAdmission(actor:Principal,projectId:string,id:string){
    authorize(actor,projectId,'execution.request');const original=request(projectId,id);
    if(original.stageId==='publication')authorize(actor,projectId,'release.request');
    const base={originalRequestId:id,originalRequestDigest:original.digest,executionAuthorized:false as const};
    try{
      if(closed)reject('STOPPING','Service is stopping',503);
      if(!deps.adapter)reject('EXECUTOR_UNAVAILABLE','No fixed stage adapter is configured',409);
      const saved=fixedInstance(original),p=progress(original);
      if(p.phase==='UNKNOWN'||!p.terminal)return{...base,allowed:false,reasons:['RECONCILE_ORIGINAL_REQUEST']};
      if(p.phase!=='FAILED')return{...base,allowed:false,reasons:['STAGE_ALREADY_COMPLETE']};
      const prepared=await prepareAdmission(saved,original.stageId,actor);
      const fresh=actorFor(original);deps.verifyAuthority?.(prepared.current.authority,saved.definition,fresh);deps.verifyProjectReviewState?.(saved,fresh);
      if(!prepared.repair)reject('REPAIR_EVIDENCE_REQUIRED','Exact trusted repair assessment required',409);
      if(Date.parse(prepared.repair.facts.expiresAt)<=Date.now()||prepared.preparationDeadline<=Date.now())reject('REPAIR_EVIDENCE_EXPIRED','Prepared repair evidence expired',409);
      fixedInstance(original);
      return{...base,allowed:true,reasons:[],subjectDigest:valueDigest(prepared.repair.subject),facts:prepared.repair.facts,deadlineAt:new Date(prepared.preparationDeadline).toISOString()};
    }catch(error){return{...base,allowed:false,reasons:[error instanceof ServiceError?error.code:'REPAIR_EVIDENCE_UNKNOWN']};}
  },async authorizeOriginal(actor:Principal,projectId:string,id:string):Promise<Principal>{
    authorize(actor,projectId,'execution.request');const r=request(projectId,id);
    if(actor.id!==r.initiatedBy.id||actor.revision!==r.initiatedBy.revision)reject('AUTHORITY_CHANGED','Only the original current principal may claim this task',403);
    if(progress(r).terminal)reject('STAGE_TERMINAL','Original stage has already ended',409);return permit(r);
  },health(projectId:string){const error=scanError??(workerError?.projectId===projectId?workerError.code:null);return{state:error?'DEGRADED':closed?'STOPPED':'READY',error,inFlight:[...active.keys(),...advancing.keys()].filter(k=>k.startsWith(projectId+'\0')).length,automaticRedispatch:false};},async close(){if(closed)return;closed=true;clearInterval(timer);for(const job of active.values())job.controller.abort();for(const reservation of advancing.values())reservation.controller.abort();await Promise.allSettled([...active.values()].map(job=>job.promise).concat([...advancing.values()].map(reservation=>reservation.done)));}};
}
