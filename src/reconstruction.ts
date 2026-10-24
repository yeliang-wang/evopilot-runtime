import {nativeExact,nativeFrozenClone,nativeText} from '../vendor/compatibility/v1/native.mjs';
import {verifyDecisionEvidence} from '../vendor/compatibility/v1/decision-evidence.mjs';
import {createFeedbackStore,feedbackScope} from '../vendor/compatibility/feedback/v1/feedback.mjs';
import type {FeedbackEnvelope} from '../vendor/compatibility/feedback/v1/feedback.mjs';
import {usabilityStable,usabilityDigest,validateUsabilityDigest,usabilityFail as fail} from '../vendor/usability/v1/contract.mjs';
import {validateReconstructionObservation} from '../vendor/usability/v1/oracle.mjs';
import {validateExecutionPolicy,validateExecutionEvidence,executionIsolated} from '../vendor/usability/v1/execution.mjs';
import type {ExecutionPolicy,ExecutionEvidence} from '../vendor/usability/v1/execution.mjs';
import type {ReconstructionObservation} from '../vendor/usability/v1/oracle.mjs';
import type {Store,Scope} from './types.js';
import type {PlanningRevision,PlanningDecision} from './planning.js';

/** null explicitly declines a monetary ceiling when the provider cannot measure charges. */
export interface ReconstructionBudget {wallMs:number;maxAttempts:number;maxOutputBytes:number;maxTokens:number;maxCostMicros:number|null;maxIterations:number}
interface ReconstructionPlanFields {
  workspaceId:string;scope:Scope;
  planning:{id:string;digest:string;milestoneId:string};
  inventoryDigest:string;specificationDigest:string;oracleDigest:string;inputManifestDigest:string;environmentDigest:string;dependenciesDigest:string;
  executor:{id:string;version:string;executableDigest:string;configurationDigest:string;provider:string;model:string};
  inputMode:'ASSETS_ONLY'|'SOURCE_ASSISTED';origin:'ACTUAL'|'SYNTHETIC';independentConsumer:boolean;budget:ReconstructionBudget;
}
export type ReconstructionPlan=ReconstructionPlanFields&({schema:'evopilot-reconstruction-plan/v1'}|{schema:'evopilot-reconstruction-plan/v2';authority:ExecutionPolicy});
export interface ReconstructionBinding {plan:ReconstructionPlan;digest:string;humanEvidenceRef:string}
export interface ReconstructionClaim {workspaceId:string;scope:Scope;attemptId:string;claimId:string;planDigest:string;plan:ReconstructionPlan;ordinal:number;admittedAt:string;remaining:{tokens:number;costMicros:number|null;wallMs:number}}
interface ReconstructionReceiptFields {
  claimId:string;planDigest:string;attemptId:string;
  status:'SUCCEEDED'|'FAILED'|'CANCELLED';origin:'ACTUAL'|'SYNTHETIC';
  executorDigest:string;inputManifestDigest:string;environmentDigest:string;dependenciesDigest:string;
  workspaceId:string;cleanStart:boolean;isolation:'DENY_BY_DEFAULT'|'NONE';networkDenied:boolean;
  stages:{generation:'SUCCEEDED'|'FAILED'|'NOT_RUN';build:'SUCCEEDED'|'FAILED'|'NOT_RUN';run:'SUCCEEDED'|'FAILED'|'NOT_RUN'};
  usage:{wallMs:number;tokens:number|null;costMicros:number|null;iterations:number};
  interventions:string[];outputs:{path:string;bytes:number;digest:string}[];outputDigest:string;traceDigest:string;diagnostic:string|null;digest:string;
}
export type ReconstructionReceipt=ReconstructionReceiptFields&({schema:'evopilot-reconstruction-receipt/v1'}|{schema:'evopilot-reconstruction-receipt/v2';authority:ExecutionEvidence});
export interface ReconstructionAttempt {id:string;claim:ReconstructionClaim;status:'RUNNING'|'UNKNOWN'|'SUCCEEDED'|'FAILED'|'CANCELLED';receipt:ReconstructionReceipt|null;reason:string|null;cancelRequested:boolean}
export interface ReconstructionContext {claim:Readonly<ReconstructionClaim>;signal:AbortSignal}
/** Only installation-owned adapters may supply these callbacks. Request JSON cannot register a provider. */
export interface ReconstructionProviders {
  verifyReconstructionPlan?:(plan:Readonly<ReconstructionPlan>,signal:AbortSignal)=>Promise<{planDigest:string;current:boolean}>;
  executeReconstruction?:(context:ReconstructionContext)=>Promise<ReconstructionReceipt>;
  inspectReconstruction?:(context:ReconstructionContext)=>Promise<ReconstructionReceipt|null>;
  cancelReconstruction?:(context:ReconstructionContext)=>Promise<ReconstructionReceipt|null>;
  observeReconstruction?:(context:ReconstructionContext&{receipt:Readonly<ReconstructionReceipt>})=>Promise<ReconstructionObservation>;
}
export interface ReconstructionInputs {
  'reconstruction.inspect':Record<string,never>;
  'reconstruction.review':{plan:ReconstructionPlan};
  'reconstruction.freeze':{plan:ReconstructionPlan;humanEvidenceRef:string};
  'reconstruction.plan':{digest:string};
  'reconstruction.dispatch':{planDigest:string};
  'reconstruction.attempt':{id:string};
  'reconstruction.list':{planDigest:string};
  'reconstruction.reconcile':{id:string};
  'reconstruction.cancel':{id:string};
  'reconstruction.evidence':{id:string};
}
export interface ReconstructionWriteReceipt<T> {revision:number;result:T;requestId:string;digest:string}
export interface ReconstructionResults {
  'reconstruction.inspect':{workspaceId:string;scope:Scope;revision:number;authority:false};
  'reconstruction.review':{plan:ReconstructionPlan;digest:string};
  'reconstruction.freeze':ReconstructionWriteReceipt<ReconstructionBinding>;
  'reconstruction.plan':ReconstructionBinding;
  'reconstruction.dispatch':{admission:ReconstructionWriteReceipt<ReconstructionAttempt>;attempt:ReconstructionAttempt};
  'reconstruction.attempt':ReconstructionAttempt;
  'reconstruction.list':ReconstructionAttempt[];
  'reconstruction.reconcile':{admission:ReconstructionWriteReceipt<ReconstructionAttempt>;attempt:ReconstructionAttempt};
  'reconstruction.cancel':{admission:ReconstructionWriteReceipt<ReconstructionAttempt>;attempt:ReconstructionAttempt};
  'reconstruction.evidence':ReconstructionObservation;
}
type Operation=keyof ReconstructionInputs;
type Write='reconstruction.freeze'|'reconstruction.dispatch'|'reconstruction.reconcile'|'reconstruction.cancel';
export type ReconstructionRequest<K extends Operation=Operation>={[P in K]:{operation:P;scope:Scope;input:ReconstructionInputs[P]}&(P extends Write?{requestId:string;expectedRevision:number}:{requestId?:never;expectedRevision?:never})}[K];
const fields={
  'reconstruction.inspect':[],'reconstruction.review':['plan'],'reconstruction.freeze':['plan','humanEvidenceRef'],'reconstruction.plan':['digest'],
  'reconstruction.dispatch':['planDigest'],'reconstruction.attempt':['id'],'reconstruction.list':['planDigest'],
  'reconstruction.reconcile':['id'],'reconstruction.cancel':['id'],'reconstruction.evidence':['id'],
};
export const RECONSTRUCTION_OPERATIONS=Object.freeze(Object.keys(fields));
const writes:readonly string[]=['reconstruction.freeze','reconstruction.dispatch','reconstruction.reconcile','reconstruction.cancel'];
const same=(a:unknown,b:unknown)=>usabilityStable(a)===usabilityStable(b);
function id(value:unknown):asserts value is string{nativeText(value);if(value.length>128||!/^[a-z0-9][a-z0-9:._-]*$/.test(value))fail('RECONSTRUCTION_ID');}
function integer(value:unknown,max:number,min=0):asserts value is number{if(!Number.isSafeInteger(value)||(value as number)<min||(value as number)>max)fail('RECONSTRUCTION_BUDGET');}
function bool(value:unknown){if(typeof value!=='boolean')fail('RECONSTRUCTION_SCHEMA');}
export function validateReconstructionPlan(value:unknown):ReconstructionPlan{
  usabilityStable(value);const v2=!!value&&typeof value==='object'&&'schema'in value&&value.schema==='evopilot-reconstruction-plan/v2';nativeExact(value,['schema','workspaceId','scope','planning','inventoryDigest','specificationDigest','oracleDigest','inputManifestDigest','environmentDigest','dependenciesDigest','executor','inputMode','origin','independentConsumer','budget',...(v2?['authority']:[])]);
  if(!['evopilot-reconstruction-plan/v1','evopilot-reconstruction-plan/v2'].includes(String(value.schema))||!['ASSETS_ONLY','SOURCE_ASSISTED'].includes(String(value.inputMode))||!['ACTUAL','SYNTHETIC'].includes(String(value.origin)))fail('RECONSTRUCTION_SCHEMA');
  if(v2)validateExecutionPolicy(value.authority);
  id(value.workspaceId);feedbackScope(value.scope);bool(value.independentConsumer);nativeExact(value.planning,['id','digest','milestoneId']);id(value.planning.id);id(value.planning.milestoneId);validateUsabilityDigest(value.planning.digest);
  for(const key of ['inventoryDigest','specificationDigest','oracleDigest','inputManifestDigest','environmentDigest','dependenciesDigest'] as const)validateUsabilityDigest(value[key]);
  nativeExact(value.executor,['id','version','executableDigest','configurationDigest','provider','model']);
  for(const key of ['id','version','provider','model'] as const){nativeText(value.executor[key]);if((value.executor[key] as string).length>256)fail('RECONSTRUCTION_SCHEMA');}
  validateUsabilityDigest(value.executor.executableDigest);validateUsabilityDigest(value.executor.configurationDigest);
  nativeExact(value.budget,['wallMs','maxAttempts','maxOutputBytes','maxTokens','maxCostMicros','maxIterations']);
  integer(value.budget.wallMs,3600000,1);integer(value.budget.maxAttempts,4,2);integer(value.budget.maxOutputBytes,8388608,1);integer(value.budget.maxTokens,1000000);if(value.budget.maxCostMicros!==null)integer(value.budget.maxCostMicros,100000000);integer(value.budget.maxIterations,100,1);
  return nativeFrozenClone(value) as unknown as ReconstructionPlan;
}
export function validateReconstructionReceipt(raw:unknown,claim:ReconstructionClaim):ReconstructionReceipt{
  usabilityStable(raw);const v2=claim.plan.schema==='evopilot-reconstruction-plan/v2';nativeExact(raw,['schema','claimId','planDigest','attemptId','status','origin','executorDigest','inputManifestDigest','environmentDigest','dependenciesDigest','workspaceId','cleanStart','isolation','networkDenied','stages','usage','interventions','outputs','outputDigest','traceDigest','diagnostic','digest',...(v2?['authority']:[])]);
  validateUsabilityDigest(raw.traceDigest);const {digest,...body}=raw;
  if(digest!==usabilityDigest(body))fail('RECONSTRUCTION_RECEIPT_DIGEST');
  const p=claim.plan;
  if(raw.schema!==(v2?'evopilot-reconstruction-receipt/v2':'evopilot-reconstruction-receipt/v1')||raw.claimId!==claim.claimId||raw.planDigest!==claim.planDigest||raw.attemptId!==claim.attemptId||raw.origin!==p.origin||raw.executorDigest!==usabilityDigest(p.executor))fail('RECONSTRUCTION_RECEIPT_BINDING');
  for(const key of ['inputManifestDigest','environmentDigest','dependenciesDigest'] as const)if(raw[key]!==p[key])fail('RECONSTRUCTION_RECEIPT_BINDING');
  if(!['SUCCEEDED','FAILED','CANCELLED'].includes(String(raw.status))||!['DENY_BY_DEFAULT','NONE'].includes(String(raw.isolation)))fail('RECONSTRUCTION_SCHEMA');
  id(raw.workspaceId);bool(raw.cleanStart);bool(raw.networkDenied);nativeExact(raw.stages,['generation','build','run']);
  if(Object.values(raw.stages).some(s=>!['SUCCEEDED','FAILED','NOT_RUN'].includes(String(s))))fail('RECONSTRUCTION_SCHEMA');
  nativeExact(raw.usage,['wallMs','tokens','costMicros','iterations']);integer(raw.usage.wallMs,Number.MAX_SAFE_INTEGER);if(raw.usage.tokens!==null)integer(raw.usage.tokens,1000000);if(raw.usage.costMicros!==null)integer(raw.usage.costMicros,100000000);integer(raw.usage.iterations,100);
  if(!Array.isArray(raw.interventions)||raw.interventions.length>100)fail('RECONSTRUCTION_SCHEMA');raw.interventions.forEach(nativeText);
  if(raw.diagnostic!==null)nativeText(raw.diagnostic);
  if(!Array.isArray(raw.outputs)||raw.outputs.length>1024)fail('RECONSTRUCTION_OUTPUT');
  const paths=new Set<string>();let size=0;
  for(const file of raw.outputs){nativeExact(file,['path','bytes','digest']);nativeText(file.path);if(!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(file.path)||file.path.split('/').some(p=>p==='.'||p==='..')||paths.has(file.path))fail('RECONSTRUCTION_OUTPUT');paths.add(file.path);integer(file.bytes,p.budget.maxOutputBytes);size+=file.bytes;validateUsabilityDigest(file.digest);}
  if(size>p.budget.maxOutputBytes||raw.outputDigest!==usabilityDigest(raw.outputs))fail('RECONSTRUCTION_OUTPUT');
  if(raw.status==='SUCCEEDED'&&(!raw.cleanStart||Object.values(raw.stages).some(s=>s!=='SUCCEEDED')||!raw.outputs.length||raw.usage.wallMs>claim.remaining.wallMs||raw.usage.tokens===null||raw.usage.tokens>claim.remaining.tokens||(claim.remaining.costMicros!==null&&(raw.usage.costMicros===null||raw.usage.costMicros>claim.remaining.costMicros))||raw.usage.iterations>p.budget.maxIterations))fail('RECONSTRUCTION_INCOMPLETE');
  let authority:ExecutionEvidence|undefined;
  if(p.schema==='evopilot-reconstruction-plan/v2'){authority=validateExecutionEvidence(raw.authority);if(!same(authority.policy,p.authority))fail('RECONSTRUCTION_AUTHORITY_BINDING');}
  if(raw.status==='SUCCEEDED'&&authority&&(raw.networkDenied!==(authority.policy.internalTransport==='NONE')||!executionIsolated(authority)))fail('RECONSTRUCTION_ISOLATION');
  if(raw.status==='SUCCEEDED'&&p.inputMode==='ASSETS_ONLY'&&(raw.isolation!=='DENY_BY_DEFAULT'||(!authority&&!raw.networkDenied)))fail('RECONSTRUCTION_ISOLATION');
  return nativeFrozenClone(raw) as unknown as ReconstructionReceipt;
}
async function bounded<T>(callback:(signal:AbortSignal)=>Promise<T>,ms:number,controller=new AbortController()):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([Promise.resolve().then(()=>callback(controller.signal)),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{const error=Object.assign(new Error('RECONSTRUCTION_TIMEOUT'),{code:'RECONSTRUCTION_TIMEOUT'});controller.abort(error);reject(error);},ms);})]);}finally{clearTimeout(timer);}
}
export function createReconstructionRuntime(store:Store,providers:ReconstructionProviders){
  const records=createFeedbackStore(store,'runtime'),controllers=new Map<string,AbortController>();let active=0;
  const get=<T>(scope:Scope,kind:string,key:string):T=>{const value=records.get<T>(scope,'reconstruction-'+kind,key);if(!value)fail('RECONSTRUCTION_NOT_FOUND');return value;};
  const attempts=(scope:Scope,digest:string)=>records.list<ReconstructionAttempt>(scope,'reconstruction-attempt').filter(a=>a.claim.planDigest===digest);
  const mark=(version=7)=>{if(Number(store.db.prepare('PRAGMA user_version').get()!.user_version)<version)store.db.exec('PRAGMA user_version='+version);};
  function planning(plan:ReconstructionPlan){
    const h=records.get<{latestDigest:string;acceptedDigest:string|null}>(plan.scope,'planning-head',plan.planning.id);
    const r=records.get<PlanningRevision>(plan.scope,'planning-revision',plan.planning.digest),d=records.get<PlanningDecision>(plan.scope,'planning-decision',plan.planning.digest);
    if(!h||h.latestDigest!==plan.planning.digest||h.acceptedDigest!==plan.planning.digest||!r||!d||d.decision!=='APPROVE'||!r.draft.milestones.some(m=>m.id===plan.planning.milestoneId))fail('RECONSTRUCTION_PLANNING_STALE');
    verifyDecisionEvidence(d.humanEvidenceRef,{owner:'runtime',operation:'planning.decide',workspaceId:store.identity.id,scope:plan.scope,reviewDigest:plan.planning.digest,decision:'APPROVE'});
  }
  function review(scope:Scope,value:unknown){const plan=validateReconstructionPlan(value);if(plan.workspaceId!==store.identity.id||!same(plan.scope,scope))fail('RECONSTRUCTION_SCOPE');planning(plan);return {plan,digest:usabilityDigest(plan)};}
  function decision(binding:ReconstructionBinding){review(binding.plan.scope,binding.plan);verifyDecisionEvidence(binding.humanEvidenceRef,{owner:'runtime',operation:'reconstruction.freeze',workspaceId:store.identity.id,scope:binding.plan.scope,reviewDigest:binding.digest,decision:'APPROVE'});}
  async function current(binding:ReconstructionBinding){decision(binding);if(!providers.verifyReconstructionPlan)fail('RECONSTRUCTION_UNSUPPORTED');const proof=await bounded(s=>providers.verifyReconstructionPlan!(nativeFrozenClone(binding.plan),s),2000);nativeExact(proof,['planDigest','current']);if(proof.planDigest!==binding.digest||proof.current!==true)fail('RECONSTRUCTION_STALE');decision(binding);}
  function update(scope:Scope,id:string,fn:(a:ReconstructionAttempt)=>ReconstructionAttempt){
    store.guard();store.db.exec('BEGIN IMMEDIATE');try{const a=get<ReconstructionAttempt>(scope,'attempt',id),next=fn(a);if(!same(a,next)){records.put(scope,'reconstruction-attempt',id,next);records.recordTransition({operation:'reconstruction.transition',scope,id},next);}store.db.exec('COMMIT');return nativeFrozenClone(next);}catch(error){store.db.exec('ROLLBACK');throw error;}
  }
  function finish(scope:Scope,id:string,value:ReconstructionReceipt){return update(scope,id,a=>{
    if(!['RUNNING','UNKNOWN'].includes(a.status))return a;
    const receipt=validateReconstructionReceipt(value,a.claim);
    if(attempts(scope,a.claim.planDigest).some(other=>other.id!==id&&other.receipt?.workspaceId===receipt.workspaceId))fail('RECONSTRUCTION_WORKSPACE_REUSED');
    // Cancellation is sticky even when an external adapter finishes before acknowledging it.
    return {...a,status:a.cancelRequested?'CANCELLED':receipt.status,receipt,reason:a.cancelRequested?'CANCEL_REQUESTED':receipt.diagnostic};
  });}
  async function reconstruction<K extends Operation>(raw:ReconstructionRequest<K>):Promise<ReconstructionResults[K]>{
    active++;try{return await operate(raw as ReconstructionRequest) as ReconstructionResults[K];}finally{active--;}
  }
  async function operate(raw:ReconstructionRequest):Promise<unknown>{
    usabilityStable(raw);const r=nativeFrozenClone(raw);if(!RECONSTRUCTION_OPERATIONS.includes(r.operation))fail('RECONSTRUCTION_OPERATION');const write=writes.includes(r.operation);nativeExact(r,['operation','scope','input',...(write?['requestId','expectedRevision']:[])]);feedbackScope(r.scope);nativeExact(r.input,fields[r.operation]);store.guard();
    if(r.operation==='reconstruction.inspect')return records.inspect(r.scope);
    if(r.operation==='reconstruction.review')return review(r.scope,r.input.plan);
    if(r.operation==='reconstruction.plan')return get<ReconstructionBinding>(r.scope,'plan',r.input.digest);
    if(r.operation==='reconstruction.attempt')return get<ReconstructionAttempt>(r.scope,'attempt',r.input.id);
    if(r.operation==='reconstruction.list'){get(r.scope,'plan',r.input.planDigest);return attempts(r.scope,r.input.planDigest);}
    if(r.operation==='reconstruction.freeze')return records.mutate(r as FeedbackEnvelope,()=>{
      const reviewed=review(r.scope,r.input.plan);verifyDecisionEvidence(r.input.humanEvidenceRef,{owner:'runtime',operation:r.operation,workspaceId:store.identity.id,scope:r.scope,reviewDigest:reviewed.digest,decision:'APPROVE'});
      const old=records.get<ReconstructionBinding>(r.scope,'reconstruction-plan',reviewed.digest);if(old)return old;
      const binding={...reviewed,humanEvidenceRef:r.input.humanEvidenceRef};records.put(r.scope,'reconstruction-plan',binding.digest,binding);mark(binding.plan.schema==='evopilot-reconstruction-plan/v2'?8:7);return binding;
    });
    if(r.operation==='reconstruction.evidence'){
      const a=get<ReconstructionAttempt>(r.scope,'attempt',r.input.id),b=get<ReconstructionBinding>(r.scope,'plan',a.claim.planDigest);if(a.status!=='SUCCEEDED'||!a.receipt||a.cancelRequested)fail('RECONSTRUCTION_NOT_SUCCEEDED');
      if(!providers.inspectReconstruction||!providers.observeReconstruction)fail('RECONSTRUCTION_UNSUPPORTED');await current(b);
      const retained=validateReconstructionReceipt(await bounded(signal=>providers.inspectReconstruction!({claim:a.claim,signal}),2000),a.claim);if(!same(retained,a.receipt))fail('RECONSTRUCTION_RECEIPT_DRIFT');
      const o=validateReconstructionObservation(await bounded(signal=>providers.observeReconstruction!({claim:a.claim,receipt:retained,signal}),2000)),p=b.plan;
      if(retained.schema==='evopilot-reconstruction-receipt/v2'){if(o.schema!=='evopilot-reconstruction-observation/v2'||!same(o.authority,retained.authority))fail('RECONSTRUCTION_OBSERVATION_BINDING');}else if(o.schema!=='evopilot-reconstruction-observation/v1')fail('RECONSTRUCTION_OBSERVATION_BINDING');
      if(o.workspaceId!==store.identity.id||!same(o.scope,r.scope)||o.attemptId!==a.id||o.origin!==p.origin||o.inputMode!==p.inputMode||o.independent!==p.independentConsumer||o.isolated!==(retained.isolation==='DENY_BY_DEFAULT'&&(retained.schema==='evopilot-reconstruction-receipt/v2'?executionIsolated(retained.authority):retained.networkDenied))||o.outputDigest!==retained.outputDigest||o.executorDigest!==retained.executorDigest||o.status!=='SUCCEEDED')fail('RECONSTRUCTION_OBSERVATION_BINDING');
      for(const k of ['inventoryDigest','specificationDigest','oracleDigest','inputManifestDigest','environmentDigest','dependenciesDigest'] as const)if(o[k]!==p[k])fail('RECONSTRUCTION_OBSERVATION_BINDING');
      const execution={planDigest:a.claim.planDigest,claimId:a.claim.claimId,cleanWorkspaceId:retained.workspaceId,receiptDigest:retained.digest};
      if(o.execution&&!same(o.execution,execution))fail('RECONSTRUCTION_OBSERVATION_BINDING');
      await current(b);if(get<ReconstructionAttempt>(r.scope,'attempt',a.id).status!=='SUCCEEDED')fail('RECONSTRUCTION_NOT_SUCCEEDED');
      const {digest:_digest,...observation}=o,body={...observation,execution};return nativeFrozenClone({...body,digest:usabilityDigest(body)});
    }
    let fresh=false;const dispatch=r.operation==='reconstruction.dispatch';
    const admission=records.mutate(r as FeedbackEnvelope,()=>{
      mark();if(dispatch){
        id(r.requestId);const b=get<ReconstructionBinding>(r.scope,'plan',r.input.planDigest);decision(b);
        if(!providers.executeReconstruction||!providers.inspectReconstruction||!providers.cancelReconstruction||!providers.verifyReconstructionPlan)fail('RECONSTRUCTION_UNSUPPORTED');
        // The one-builder bound applies across every scope and across service restarts.
        if(store.db.prepare("SELECT data FROM feedback_records WHERE kind='reconstruction-attempt'").all().some(row=>['RUNNING','UNKNOWN'].includes((JSON.parse(String(row.data)) as ReconstructionAttempt).status)))fail('RECONSTRUCTION_BUSY');
        const previous=attempts(r.scope,b.digest);if(previous.length>=b.plan.budget.maxAttempts)fail('RECONSTRUCTION_ATTEMPT_LIMIT');
        // An absent measurement is not zero. No-receipt terminal records here
        // are exclusively failures/cancellations before provider invocation.
        if(previous.some(a=>a.receipt&&(a.receipt.usage.tokens===null||(b.plan.budget.maxCostMicros!==null&&a.receipt.usage.costMicros===null))))fail('RECONSTRUCTION_BUDGET_UNAVAILABLE');
        const spent=previous.reduce((s,a)=>({tokens:s.tokens+(a.receipt?.usage.tokens??0),costMicros:s.costMicros+(a.receipt?.usage.costMicros??0),wallMs:s.wallMs+(a.receipt?.usage.wallMs??0)}),{tokens:0,costMicros:0,wallMs:0});
        const remaining={tokens:b.plan.budget.maxTokens-spent.tokens,costMicros:b.plan.budget.maxCostMicros===null?null:b.plan.budget.maxCostMicros-spent.costMicros,wallMs:b.plan.budget.wallMs-spent.wallMs};if(remaining.tokens<0||(remaining.costMicros!==null&&remaining.costMicros<0)||remaining.wallMs<=0)fail('RECONSTRUCTION_BUDGET');
        const body={workspaceId:store.identity.id,scope:r.scope,attemptId:r.requestId,planDigest:b.digest,plan:b.plan,ordinal:previous.length+1,admittedAt:new Date().toISOString(),remaining},claim={...body,claimId:usabilityDigest(body)};
        const a:ReconstructionAttempt={id:r.requestId,claim,status:'RUNNING',receipt:null,reason:null,cancelRequested:false};records.put(r.scope,'reconstruction-attempt',a.id,a);fresh=true;return a;
      }
      const a=get<ReconstructionAttempt>(r.scope,'attempt',r.input.id);if(!['RUNNING','UNKNOWN'].includes(a.status))return a;
      const next=r.operation==='reconstruction.cancel'?{...a,cancelRequested:true}:a;records.put(r.scope,'reconstruction-attempt',a.id,next);fresh=true;return next;
    });
    let a=get<ReconstructionAttempt>(r.scope,'attempt',admission.result.id);if(!fresh)return {admission,attempt:a};
    const controller=new AbortController();if(dispatch)controllers.set(a.claim.claimId,controller);
    let dispatched=false;
    try{
      let receipt:ReconstructionReceipt|null;
      if(dispatch){
        await current(get<ReconstructionBinding>(r.scope,'plan',a.claim.planDigest));a=get(r.scope,'attempt',a.id);
        if(a.status!=='RUNNING')return {admission,attempt:a};
        if(a.cancelRequested){a=update(r.scope,a.id,x=>({...x,status:'CANCELLED',reason:'CANCELLED_BEFORE_DISPATCH'}));return {admission,attempt:a};}
        dispatched=true;
        receipt=await bounded(signal=>providers.executeReconstruction!({claim:nativeFrozenClone(a.claim),signal}),a.claim.remaining.wallMs,controller);
      }else{
        if(r.operation==='reconstruction.cancel')controllers.get(a.claim.claimId)?.abort();
        const fn=r.operation==='reconstruction.cancel'?providers.cancelReconstruction:providers.inspectReconstruction;if(!fn)fail('RECONSTRUCTION_UNSUPPORTED');receipt=await bounded(signal=>fn({claim:nativeFrozenClone(a.claim),signal}),2000);
      }
      a=receipt?finish(r.scope,a.id,receipt):update(r.scope,a.id,x=>['RUNNING','UNKNOWN'].includes(x.status)?{...x,status:'UNKNOWN',reason:'RECEIPT_UNAVAILABLE'}:x);
    }catch(error){const code=error&&typeof error==='object'&&'code'in error?String(error.code):'RECONSTRUCTION_PROVIDER_ERROR';a=update(r.scope,a.id,x=>['RUNNING','UNKNOWN'].includes(x.status)?{...x,status:dispatch&&!dispatched?'FAILED':'UNKNOWN',reason:code}:x);}
    finally{if(dispatch)controllers.delete(a.claim.claimId);}
    return {admission,attempt:a};
  }
  return {reconstruction,assertQuiescent(){if(active)fail('BUSY');}};
}
