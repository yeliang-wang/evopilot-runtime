import {nativeExact,nativeFrozenClone,nativeText} from '../vendor/compatibility/v1/native.mjs';
import {verifyDecisionEvidence} from '../vendor/compatibility/v1/decision-evidence.mjs';
import {createFeedbackStore,feedbackScope} from '../vendor/compatibility/feedback/v1/feedback.mjs';
import type {FeedbackEnvelope} from '../vendor/compatibility/feedback/v1/feedback.mjs';
import {usabilityStable,usabilityDigest,usabilityFail as fail} from '../vendor/usability/v1/contract.mjs';
import {validateEvaluationPlan,validateEvaluationReceipt} from '../vendor/usability/v1/evaluation.mjs';
import type {EvaluationPlan,EvaluationClaim,EvaluationReceipt,EvaluationEvidence} from '../vendor/usability/v1/evaluation.mjs';
import {validateReconstructionObservation} from '../vendor/usability/v1/oracle.mjs';
import type {ReconstructionObservation} from '../vendor/usability/v1/oracle.mjs';
import type {ReconstructionAttempt,ReconstructionWriteReceipt} from './reconstruction.js';
import type {Store,Scope} from './types.js';
export type {EvaluationPlan,EvaluationClaim,EvaluationReceipt,EvaluationEvidence};
export interface EvaluationBinding {plan:EvaluationPlan;digest:string;humanEvidenceRef:string}
export interface EvaluationSession {id:string;claim:EvaluationClaim;status:'RUNNING'|'UNKNOWN'|'SUCCEEDED'|'FAILED'|'CANCELLED';receipt:EvaluationReceipt|null;reason:string|null;cancelRequested:boolean}
export interface EvaluationContext {claim:Readonly<EvaluationClaim>;signal:AbortSignal}
/** Configured only by the trusted installation, never by request data. */
export interface EvaluationProviders {
  verifyEvaluationPlan?:(plan:Readonly<EvaluationPlan>,signal:AbortSignal)=>Promise<{planDigest:string;current:boolean;qualified:boolean}>;
  executeEvaluation?:(context:EvaluationContext)=>Promise<EvaluationReceipt>;
  inspectEvaluation?:(context:EvaluationContext)=>Promise<EvaluationReceipt|null>;
  cancelEvaluation?:(context:EvaluationContext)=>Promise<EvaluationReceipt|null>;
  observeEvaluation?:(context:EvaluationContext&{receipt:Readonly<EvaluationReceipt>})=>Promise<ReconstructionObservation>;
}
export interface EvaluationInputs {
  'reconstruction.evaluation.review':{plan:EvaluationPlan};
  'reconstruction.evaluation.freeze':{plan:EvaluationPlan;humanEvidenceRef:string};
  'reconstruction.evaluation.plan':{digest:string};
  'reconstruction.evaluation.dispatch':{planDigest:string};
  'reconstruction.evaluation.session':{id:string};
  'reconstruction.evaluation.list':{planDigest:string};
  'reconstruction.evaluation.reconcile':{id:string};
  'reconstruction.evaluation.cancel':{id:string};
  'reconstruction.evaluation.evidence':{id:string};
}
export interface EvaluationResults {
  'reconstruction.evaluation.review':{plan:EvaluationPlan;digest:string};
  'reconstruction.evaluation.freeze':ReconstructionWriteReceipt<EvaluationBinding>;
  'reconstruction.evaluation.plan':EvaluationBinding;
  'reconstruction.evaluation.dispatch':{admission:ReconstructionWriteReceipt<EvaluationSession>;session:EvaluationSession};
  'reconstruction.evaluation.session':EvaluationSession;
  'reconstruction.evaluation.list':EvaluationSession[];
  'reconstruction.evaluation.reconcile':{admission:ReconstructionWriteReceipt<EvaluationSession>;session:EvaluationSession};
  'reconstruction.evaluation.cancel':{admission:ReconstructionWriteReceipt<EvaluationSession>;session:EvaluationSession};
  'reconstruction.evaluation.evidence':ReconstructionObservation;
}
export type EvaluationWrite='reconstruction.evaluation.freeze'|'reconstruction.evaluation.dispatch'|'reconstruction.evaluation.reconcile'|'reconstruction.evaluation.cancel';
export type EvaluationRequest={[P in keyof EvaluationInputs]:{operation:P;scope:Scope;input:EvaluationInputs[P]}&(P extends EvaluationWrite?{requestId:string;expectedRevision:number}:{requestId?:never;expectedRevision?:never})}[keyof EvaluationInputs];
export const EVALUATION_FIELDS={
  'reconstruction.evaluation.review':['plan'],'reconstruction.evaluation.freeze':['plan','humanEvidenceRef'],
  'reconstruction.evaluation.plan':['digest'],'reconstruction.evaluation.dispatch':['planDigest'],'reconstruction.evaluation.session':['id'],
  'reconstruction.evaluation.list':['planDigest'],'reconstruction.evaluation.reconcile':['id'],'reconstruction.evaluation.cancel':['id'],'reconstruction.evaluation.evidence':['id'],
};
export const EVALUATION_WRITES:readonly string[]=['reconstruction.evaluation.freeze','reconstruction.evaluation.dispatch','reconstruction.evaluation.reconcile','reconstruction.evaluation.cancel'];
const same=(a:unknown,b:unknown)=>usabilityStable(a)===usabilityStable(b);
function id(value:unknown){nativeText(value);if(value.length>128||!/^[a-z0-9][a-z0-9._-]*$/.test(value))fail('EVALUATION_ID');}
async function bounded<T>(callback:(signal:AbortSignal)=>Promise<T>,ms:number,controller=new AbortController()):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([Promise.resolve().then(()=>callback(controller.signal)),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{const error=Object.assign(new Error('EVALUATION_TIMEOUT'),{code:'EVALUATION_TIMEOUT'});controller.abort(error);reject(error);},ms);})]);}finally{clearTimeout(timer);}
}
export function createEvaluationRuntime(store:Store,providers:EvaluationProviders,generation:{read:(scope:Scope,id:string)=>ReconstructionAttempt;current:(scope:Scope,id:string)=>Promise<ReconstructionAttempt>}){
  const records=createFeedbackStore(store,'runtime'),controllers=new Map<string,AbortController>();
  const get=<T>(scope:Scope,kind:string,key:string):T=>{const v=records.get<T>(scope,'evaluation-'+kind,key);if(!v)fail('EVALUATION_NOT_FOUND');return v;};
  const sessions=(scope:Scope,digest:string)=>records.list<EvaluationSession>(scope,'evaluation-session').filter(s=>s.claim.planDigest===digest);
  function source(plan:EvaluationPlan){
    const a=generation.read(plan.scope,plan.reconstruction.attemptId),r=a.receipt,p=a.claim.plan;
    if(a.status!=='SUCCEEDED'||a.cancelRequested||!r||r.schema!=='evopilot-reconstruction-receipt/v2'||p.schema!=='evopilot-reconstruction-plan/v2'||!same(plan.reconstruction,{attemptId:a.id,planDigest:a.claim.planDigest,claimId:a.claim.claimId,receiptDigest:r.digest,outputDigest:r.outputDigest})||plan.origin!==p.origin)fail('EVALUATION_GENERATION_BINDING');
    for(const key of ['oracleDigest','environmentDigest','dependenciesDigest'] as const)if(plan[key]!==p[key])fail('EVALUATION_GENERATION_BINDING');return a;
  }
  function review(scope:Scope,raw:unknown){const plan=validateEvaluationPlan(raw);if(plan.workspaceId!==store.identity.id||!same(plan.scope,scope))fail('EVALUATION_SCOPE');source(plan);return {plan,digest:usabilityDigest(plan)};}
  function decision(b:EvaluationBinding){review(b.plan.scope,b.plan);verifyDecisionEvidence(b.humanEvidenceRef,{owner:'runtime',operation:'reconstruction.evaluation.freeze',workspaceId:store.identity.id,scope:b.plan.scope,reviewDigest:b.digest,decision:'APPROVE'});}
  async function current(b:EvaluationBinding){decision(b);if(!providers.verifyEvaluationPlan)fail('EVALUATION_UNSUPPORTED');await generation.current(b.plan.scope,b.plan.reconstruction.attemptId);const proof=await bounded(signal=>providers.verifyEvaluationPlan!(nativeFrozenClone(b.plan),signal),2000);nativeExact(proof,['planDigest','current','qualified']);if(proof.planDigest!==b.digest||proof.current!==true||proof.qualified!==true)fail('EVALUATION_STALE_OR_UNQUALIFIED');decision(b);}
  function update(scope:Scope,id:string,fn:(s:EvaluationSession)=>EvaluationSession){store.guard();store.db.exec('BEGIN IMMEDIATE');try{const before=get<EvaluationSession>(scope,'session',id),next=fn(before);if(!same(before,next)){if(next.receipt)records.put(scope,'evaluation-receipt',next.receipt.digest,next.receipt);records.put(scope,'evaluation-session',id,next);records.recordTransition({operation:'evaluation.transition',scope,id},next);}store.db.exec('COMMIT');return nativeFrozenClone(next);}catch(e){store.db.exec('ROLLBACK');throw e;}}
  function finish(scope:Scope,id:string,raw:EvaluationReceipt){return update(scope,id,s=>{
    if(!['RUNNING','UNKNOWN'].includes(s.status))return s;const receipt=validateEvaluationReceipt(raw,s.claim),deps=s.claim.plan.policy.dependencies;
    const unresolved=receipt.effects.some(e=>e.outcome==='UNKNOWN')||deps.some(d=>!receipt.cleanup.some(c=>c.dependencyId===d.id&&c.confirmedAbsent))||receipt.containment.some(c=>!c.allProcessesClosed)||deps.filter(d=>d.kind==='OWNED_SUPERVISOR').length!==receipt.containment.length;
    return {...s,receipt,status:unresolved?'UNKNOWN':s.cancelRequested?'CANCELLED':receipt.status,reason:unresolved?'EVALUATION_EFFECTS_UNRESOLVED':s.cancelRequested?'CANCEL_REQUESTED':receipt.diagnostic};
  });}
  async function evaluation(raw:EvaluationRequest):Promise<unknown>{
    usabilityStable(raw);const r=nativeFrozenClone(raw),write=EVALUATION_WRITES.includes(r.operation);nativeExact(r,['operation','scope','input',...(write?['requestId','expectedRevision']:[])]);feedbackScope(r.scope);nativeExact(r.input,EVALUATION_FIELDS[r.operation]);store.guard();
    if(r.operation==='reconstruction.evaluation.review')return review(r.scope,r.input.plan);
    if(r.operation==='reconstruction.evaluation.plan')return get<EvaluationBinding>(r.scope,'plan',r.input.digest);
    if(r.operation==='reconstruction.evaluation.session')return get<EvaluationSession>(r.scope,'session',r.input.id);
    if(r.operation==='reconstruction.evaluation.list'){get(r.scope,'plan',r.input.planDigest);return sessions(r.scope,r.input.planDigest);}
    if(r.operation==='reconstruction.evaluation.freeze')return records.mutate(r as FeedbackEnvelope,()=>{
      const reviewed=review(r.scope,r.input.plan);verifyDecisionEvidence(r.input.humanEvidenceRef,{owner:'runtime',operation:r.operation,workspaceId:store.identity.id,scope:r.scope,reviewDigest:reviewed.digest,decision:'APPROVE'});
      const old=records.get<EvaluationBinding>(r.scope,'evaluation-plan',reviewed.digest);if(old)return old;const b={...reviewed,humanEvidenceRef:r.input.humanEvidenceRef};records.put(r.scope,'evaluation-plan',b.digest,b);if(Number(store.db.prepare('PRAGMA user_version').get()!.user_version)<9)store.db.exec('PRAGMA user_version=9');return b;
    });
    if(r.operation==='reconstruction.evaluation.evidence'){
      const s=get<EvaluationSession>(r.scope,'session',r.input.id),b=get<EvaluationBinding>(r.scope,'plan',s.claim.planDigest);if(s.status!=='SUCCEEDED'||s.cancelRequested||!s.receipt)fail('EVALUATION_NOT_SUCCEEDED');if(!providers.inspectEvaluation||!providers.observeEvaluation)fail('EVALUATION_UNSUPPORTED');await current(b);
      const receipt=validateEvaluationReceipt(await bounded(signal=>providers.inspectEvaluation!({claim:s.claim,signal}),2000),s.claim);if(!same(receipt,s.receipt))fail('EVALUATION_RECEIPT_DRIFT');
      const o=validateReconstructionObservation(await bounded(signal=>providers.observeEvaluation!({claim:s.claim,receipt,signal}),2000));const a=source(b.plan),p=a.claim.plan,r0=a.receipt!;
      if(o.schema!=='evopilot-reconstruction-observation/v3'||r0.schema!=='evopilot-reconstruction-receipt/v2'||!same(o.authority,r0.authority)||!same(o.evaluation,{plan:b.plan,claim:s.claim,receipt})||o.workspaceId!==store.identity.id||!same(o.scope,r.scope)||o.attemptId!==a.id||o.outputDigest!==r0.outputDigest||o.executorDigest!==r0.executorDigest||o.origin!==p.origin||o.inputMode!==p.inputMode||o.independent!==p.independentConsumer||!o.isolated||o.status!=='SUCCEEDED')fail('EVALUATION_OBSERVATION_BINDING');
      for(const key of ['inventoryDigest','specificationDigest','oracleDigest','inputManifestDigest','environmentDigest','dependenciesDigest'] as const)if(o[key]!==p[key])fail('EVALUATION_OBSERVATION_BINDING');
      const execution={planDigest:a.claim.planDigest,claimId:a.claim.claimId,cleanWorkspaceId:r0.workspaceId,receiptDigest:r0.digest};if(!same(o.execution,execution))fail('EVALUATION_OBSERVATION_BINDING');
      await current(b);if(get<EvaluationSession>(r.scope,'session',s.id).status!=='SUCCEEDED')fail('EVALUATION_NOT_SUCCEEDED');return nativeFrozenClone(o);
    }
    const dispatch=r.operation==='reconstruction.evaluation.dispatch';let fresh=false;
    const admission=records.mutate(r as FeedbackEnvelope,()=>{
      if(dispatch){id(r.requestId);const b=get<EvaluationBinding>(r.scope,'plan',r.input.planDigest);decision(b);if(!providers.verifyEvaluationPlan||!providers.executeEvaluation||!providers.inspectEvaluation||!providers.cancelEvaluation)fail('EVALUATION_UNSUPPORTED');
        if(store.db.prepare("SELECT data FROM feedback_records WHERE kind IN ('evaluation-session','reconstruction-attempt')").all().some(row=>['RUNNING','UNKNOWN'].includes((JSON.parse(String(row.data)) as {status:string}).status)))fail('EVALUATION_BUSY');
        const previous=sessions(r.scope,b.digest);if(previous.length>=b.plan.budget.maxSessions)fail('EVALUATION_SESSION_LIMIT');
        const remaining={wallMs:b.plan.budget.wallMs,maxConnections:b.plan.budget.maxConnections,maxRows:b.plan.budget.maxRows,maxOutputBytes:b.plan.budget.maxOutputBytes,maxOperations:b.plan.budget.maxOperations};
        const keys={wallMs:'wallMs',connections:'maxConnections',rows:'maxRows',outputBytes:'maxOutputBytes',operations:'maxOperations'} as const;
        for(const s of previous)if(s.receipt){for(const key of Object.keys(keys) as (keyof typeof keys)[]){const n=s.receipt.usage[key];if(n===null)fail('EVALUATION_BUDGET_UNKNOWN');remaining[keys[key]]-=n;}}
        if(remaining.wallMs<=0||Object.values(remaining).some(n=>n<0))fail('EVALUATION_BUDGET');
        const body={workspaceId:store.identity.id,scope:r.scope,sessionId:r.requestId,planDigest:b.digest,plan:b.plan,ordinal:previous.length+1,admittedAt:new Date().toISOString(),remaining},claim={...body,claimId:usabilityDigest(body)};
        const s:EvaluationSession={id:r.requestId,claim,status:'RUNNING',receipt:null,reason:null,cancelRequested:false};records.put(r.scope,'evaluation-session',s.id,s);fresh=true;return s;
      }
      const s=get<EvaluationSession>(r.scope,'session',r.input.id);if(!['RUNNING','UNKNOWN'].includes(s.status))return s;const next=r.operation==='reconstruction.evaluation.cancel'?{...s,cancelRequested:true}:s;records.put(r.scope,'evaluation-session',s.id,next);fresh=true;return next;
    });
    let s=get<EvaluationSession>(r.scope,'session',admission.result.id);if(!fresh)return {admission,session:s};const controller=new AbortController();if(dispatch)controllers.set(s.claim.claimId,controller);let dispatched=false;
    try{let receipt:EvaluationReceipt|null;
      if(dispatch){await current(get<EvaluationBinding>(r.scope,'plan',s.claim.planDigest));s=get(r.scope,'session',s.id);if(s.status!=='RUNNING')return {admission,session:s};if(s.cancelRequested){s=update(r.scope,s.id,x=>({...x,status:'CANCELLED',reason:'CANCELLED_BEFORE_DISPATCH'}));return {admission,session:s};}dispatched=true;receipt=await bounded(signal=>providers.executeEvaluation!({claim:s.claim,signal}),s.claim.remaining.wallMs,controller);}
      else{if(r.operation==='reconstruction.evaluation.cancel')controllers.get(s.claim.claimId)?.abort();const fn=r.operation==='reconstruction.evaluation.cancel'?providers.cancelEvaluation:providers.inspectEvaluation;if(!fn)fail('EVALUATION_UNSUPPORTED');receipt=await bounded(signal=>fn({claim:s.claim,signal}),2000);}
      s=receipt?finish(r.scope,s.id,receipt):update(r.scope,s.id,x=>['RUNNING','UNKNOWN'].includes(x.status)?{...x,status:'UNKNOWN',reason:'EVALUATION_RECEIPT_UNAVAILABLE'}:x);
    }catch(e){const code=e&&typeof e==='object'&&'code'in e?String(e.code):'EVALUATION_PROVIDER_ERROR';s=update(r.scope,s.id,x=>['RUNNING','UNKNOWN'].includes(x.status)?{...x,status:dispatch&&!dispatched?'FAILED':'UNKNOWN',reason:code}:x);}finally{if(dispatch)controllers.delete(s.claim.claimId);}
    return {admission,session:s};
  }
  return {evaluation};
}
