import { canonical, exact, record, reject, ServiceError, slug, string } from '../server/errors.js';
import { isCurrentBase, requireCurrentBase, valueDigest, type BasePin } from './base.js';
import { atPath, compileLifecycle, type EffectiveDefinition, type EffectiveNode } from './compiler.js';
import type { Principal } from '../server/security.js';
import type { StoredObject } from '../server/store.js';
import type { StageRequest } from './execution.js';

export interface Budget { timeoutSeconds:number; maxAttempts:number; maxConcurrency:number; maxLoops:number; }
/** Obtained from a trusted authority adapter, never directly from API/YAML data. */
export interface ExecutionAuthority {
  projectId:string; instanceId:string; definitionRevisionId:string; semanticDigest:string;
  goalRef:string; targetRef:string; loopRef:string; requirementsDigest:string;
  budget:Budget; evidenceRef:string; revision:string; expiresAt:string;
  recoveryRootRef?:string; recoveryRootDigest?:string;
}
/** Native reviewed authority integration only. Legacy/injected grants do not
 * acquire a fabricated original recovery root. No method dispatches work. */
export interface RecoveryLineageService {
  create(instance:LifecycleInstance,authority:ExecutionAuthority,actor:Principal):StoredObject[];
  admission(instance:LifecycleInstance,authority:ExecutionAuthority,stageId:string,actor:Principal,requestId?:string):{allowed:boolean;reasons:string[];deadlineAt:string;rootRef:string|null;stageAttempts:number};
  claim(instance:LifecycleInstance,authority:ExecutionAuthority,request:StageRequest,actor:Principal):StoredObject[];
  inspect(instance:LifecycleInstance):unknown;
}
export type AuthorityResolver=(authorityRef:string,definition:EffectiveDefinition,actor:Principal,signal:AbortSignal)=>Promise<ExecutionAuthority|null>;
export async function resolveAuthority(provider:AuthorityResolver|undefined,authorityRef:string,definition:EffectiveDefinition,actor:Principal):Promise<ExecutionAuthority>{
  if(!provider)reject('AUTHORITY_UNAVAILABLE','No trusted execution authority adapter is configured',409);
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  let authority:ExecutionAuthority|null;
  try{authority=await Promise.race([provider(authorityRef,definition,actor,controller.signal),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Authority lookup timed out'));},5000);})]);}
  catch(e){if(e instanceof ServiceError)throw e;return reject('AUTHORITY_UNKNOWN','Inspect authority configuration before attempting execution',409);}
  finally{if(timer)clearTimeout(timer);}
  if(!authority||authority.evidenceRef!==authorityRef)reject('AUTHORITY_REQUIRED','No exact execution authority was found',403);
  validateAuthority(authority);return authority;
}
export interface CandidateManifest {
  schema:'runtime-candidate/v1'; version:string; profile:'candidate-verification';
  sourceDigest:string; buildDigest:string;
  artifacts:{name:string;digest:string;bytes:number}[];
}
export interface ReleaseAuthority {
  projectId:string; instanceId:string; pinsDigest:string; definitionRevisionId:string;
  semanticDigest:string; requirementsDigest:string; candidateDigest:string; channel:string;
  decisionRef:string; expiresAt:string;
}
/** Current facts from server-side adapters; client assertions cannot fill this. */
export interface AdmissionContext {
  authority:ExecutionAuthority|null; bindingsCurrent:boolean;
  releaseAuthority?:ReleaseAuthority; now?:number;
}
export interface StageState {
  status:'PENDING'|'RUNNING'|'UNKNOWN'|'FAILED'|'PASSED'; attempts:number;
  requestId:string|null; inputDigest:string|null; requestedAt:string|null;
  receiptRef:string|null; outcomeDigest:string|null; expiresAt:string|null;
}
export interface InstancePins {
  projectId:string; definitionRevisionId:string; semanticDigest:string; base:BasePin;
  requirementsDigest:string; graphDigest:string; authorityDigest:string;
  goalRef:string; targetRef:string; loopRef:string; budget:Budget; authorityExpiresAt:string;
}
export interface LifecycleInstance {
  schema:'runtime-lifecycle-instance/v1'; id:string; pins:InstancePins; pinsDigest:string;
  definition:EffectiveDefinition; stages:Record<string,StageState>;
  requestIds:string[];
  candidate:CandidateManifest|null; candidateDigest:string|null;
  createdAt:string;
}
export interface StageOutcome {
  requestId:string; inputDigest:string; receiptRef:string;
  status:'RUNNING'|'COMPLETE'|'FAILED'|'UNKNOWN'; expiresAt:string;
  checks:{id:string;status:'PASS'|'FAIL'|'UNKNOWN';evidenceRef:string}[];
  candidate?:CandidateManifest;
}
const hash=(v:unknown)=>typeof v==='string'&&/^sha256:[a-f0-9]{64}$/.test(v);
function immutable<T>(value:T):T{if(value&&typeof value==='object'){for(const item of Object.values(value))immutable(item);Object.freeze(value);}return value;}
const cloned=<T>(v:T):T=>JSON.parse(canonical(v)) as T;
export const requiredChecksDigest=(definition:EffectiveDefinition):string=>valueDigest(definition.nodes.map(n=>({id:n.id,checks:[...n.checks].sort()})).sort((a,b)=>a.id.localeCompare(b.id)));
function budget(value:unknown):Budget{
  const v=record(value);exact(v,['timeoutSeconds','maxAttempts','maxConcurrency','maxLoops']);
  for(const key of Object.keys(v))if(!Number.isSafeInteger(v[key])||Number(v[key])<1||Number(v[key])>(key==='timeoutSeconds'?3600:4))reject('INVALID_BUDGET','Execution budget is outside the publisher bounds');
  return v as unknown as Budget;
}
function validateAuthority(a:ExecutionAuthority):void{
  const v=record(a);exact(v,['projectId','instanceId','definitionRevisionId','semanticDigest','goalRef','targetRef','loopRef','requirementsDigest','budget','evidenceRef','revision','expiresAt'],['recoveryRootRef','recoveryRootDigest']);
  slug(a.projectId);slug(a.instanceId);for(const k of ['definitionRevisionId','semanticDigest','requirementsDigest'])if(!hash(v[k]))reject('INVALID_AUTHORITY','Authority must pin exact content');
  for(const s of [a.goalRef,a.targetRef,a.loopRef,a.evidenceRef,a.revision])string(s,512);
  if(!Number.isFinite(Date.parse(a.expiresAt)))reject('INVALID_AUTHORITY','Authority needs an exact expiry');budget(a.budget);
  if(a.recoveryRootRef!==undefined||a.recoveryRootDigest!==undefined){if(typeof a.recoveryRootRef!=='string'||!/^recovery-root:sha256:[a-f0-9]{64}$/.test(a.recoveryRootRef)||!hash(a.recoveryRootDigest))reject('INVALID_AUTHORITY','Recovery authority requires the exact native root reference and digest');}
}
function verify(instance:LifecycleInstance):void{
  if(instance.schema!=='runtime-lifecycle-instance/v1'||valueDigest(instance.pins)!==instance.pinsDigest||valueDigest(instance.definition.semantic)!==instance.pins.semanticDigest||instance.definition.semanticDigest!==instance.pins.semanticDigest||valueDigest(instance.definition.nodes)!==instance.pins.graphDigest||requiredChecksDigest(instance.definition)!==instance.pins.requirementsDigest||canonical(instance.definition.base)!==canonical(instance.pins.base)||instance.definition.projectId!==instance.pins.projectId)reject('CORRUPT_INSTANCE','Instance pins or required obligations changed',503);
  if(Object.keys(instance.stages).sort().join(',')!==instance.definition.nodes.map(n=>n.id).sort().join(','))reject('CORRUPT_INSTANCE','Instance stage set changed',503);
  if(instance.candidateDigest!==(instance.candidate?candidateDigest(instance.candidate):null))reject('CORRUPT_INSTANCE','Candidate identity changed',503);
  if(!Array.isArray(instance.requestIds)||new Set(instance.requestIds).size!==instance.requestIds.length||Object.values(instance.stages).some(s=>s.requestId&&!instance.requestIds.includes(s.requestId))||Object.values(instance.stages).reduce((n,s)=>n+s.attempts,0)!==instance.requestIds.length)reject('CORRUPT_INSTANCE','Request/attempt history is inconsistent',503);
}
export function inspectInstance(instance:LifecycleInstance):LifecycleInstance{verify(instance);return immutable(cloned(instance));}
export function candidateDigest(candidate:CandidateManifest):string{
  const v=record(candidate);exact(v,['schema','version','profile','sourceDigest','buildDigest','artifacts']);
  if(candidate.schema!=='runtime-candidate/v1'||candidate.profile!=='candidate-verification'||typeof candidate.version!=='string'||!candidate.version.length||candidate.version.length>128||!hash(candidate.sourceDigest)||!hash(candidate.buildDigest)||!Array.isArray(candidate.artifacts)||!candidate.artifacts.length||candidate.artifacts.length>64)reject('INVALID_CANDIDATE','A complete exact candidate manifest is required');
  const names=new Set<string>();
  for(const item of candidate.artifacts){exact(record(item),['name','digest','bytes']);string(item.name,128);if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(item.name)||names.has(item.name)||!hash(item.digest)||!Number.isSafeInteger(item.bytes)||item.bytes<=0)reject('INVALID_CANDIDATE','Candidate artifacts need unique names, exact digests and positive byte lengths');names.add(item.name);}
  return valueDigest({...candidate,artifacts:[...candidate.artifacts].sort((a,b)=>a.name.localeCompare(b.name))});
}
/** Creates an inert snapshot. Caller must have independently verified authority
 * and current definition admission; this function neither dispatches nor grants it. */
export function pinInstance(id:string,definitionRevisionId:string,definition:EffectiveDefinition,authority:ExecutionAuthority,now=Date.now()):LifecycleInstance{
  requireCurrentBase(definition.base);
  slug(id);if(!hash(definitionRevisionId))reject('INVALID_DEFINITION','An immutable definition revision is required');
  const compilation=compileLifecycle(canonical(definition.semantic),definition.projectId);
  if(!compilation.valid||compilation.effective!.semanticDigest!==definition.semanticDigest)reject('INVALID_DEFINITION','Instance requires a valid publisher-resolved definition');
  // Derive the graph again from trusted Base instead of trusting supplied nodes.
  const effective=compilation.effective!;validateAuthority(authority);
  if(authority.instanceId!==id||authority.projectId!==effective.projectId||authority.definitionRevisionId!==definitionRevisionId||authority.semanticDigest!==effective.semanticDigest||authority.requirementsDigest!==requiredChecksDigest(effective)||Date.parse(authority.expiresAt)<=now)reject('AUTHORITY_MISMATCH','Current authority does not cover these exact pins');
  for(const phase of ['plan','verification']){
    const configured=budget(atPath(effective.semantic,'config.'+phase+'.budget'));
    for(const key of Object.keys(configured) as (keyof Budget)[])if(configured[key]>authority.budget[key])reject('BUDGET_AUTHORITY','Definition budget exceeds current exact execution authority');
  }
  const pins:InstancePins={projectId:effective.projectId,definitionRevisionId,semanticDigest:effective.semanticDigest,base:effective.base,requirementsDigest:requiredChecksDigest(effective),graphDigest:valueDigest(effective.nodes),authorityDigest:valueDigest(authority),goalRef:authority.goalRef,targetRef:authority.targetRef,loopRef:authority.loopRef,budget:cloned(authority.budget),authorityExpiresAt:authority.expiresAt};
  return immutable({schema:'runtime-lifecycle-instance/v1',id,pins,pinsDigest:valueDigest(pins),definition:cloned(effective),stages:Object.fromEntries(effective.nodes.map(n=>[n.id,{status:'PENDING',attempts:0,requestId:null,inputDigest:null,requestedAt:null,receiptRef:null,outcomeDigest:null,expiresAt:null}])),requestIds:[],candidate:null,candidateDigest:null,createdAt:new Date(now).toISOString()});
}
export function stageBudget(instance:LifecycleInstance,node:EffectiveNode):Budget{
  if(node.source==='project')return budget(node.action!.budget);
  return budget(atPath(instance.definition.semantic,'config.'+(['verification','release-decision','publication','closure'].includes(node.id)?'verification':'plan')+'.budget'));
}
function needsCandidate(node:EffectiveNode):boolean{return ['candidate-checks','verification','before-release-decision','release-decision','publication','closure'].includes(node.stage);}
export function stageAdmission(instance:LifecycleInstance,stageId:string,context:AdmissionContext):{allowed:boolean;reasons:string[];inputDigest:string}{
  verify(instance);const now=context.now??Date.now(),node=instance.definition.nodes.find(n=>n.id===stageId);
  if(!node)reject('UNKNOWN_STAGE','Stage is not in the fixed instance');
  const state=instance.stages[stageId],reasons:string[]=[],limit=stageBudget(instance,node);
  if(!isCurrentBase(instance.pins.base))reasons.push('HISTORICAL_BASE_READ_ONLY');
  if(!context.authority)reasons.push('AUTHORITY_REQUIRED');
  else{validateAuthority(context.authority);if(valueDigest(context.authority)!==instance.pins.authorityDigest||Date.parse(context.authority.expiresAt)<=now)reasons.push('AUTHORITY_STALE');}
  if(!context.bindingsCurrent)reasons.push('BINDINGS_NOT_CURRENT');
  if(['RUNNING','UNKNOWN'].includes(state.status))reasons.push('RECONCILE_ORIGINAL_REQUEST');
  if(state.status==='PASSED')reasons.push('STAGE_ALREADY_COMPLETE');
  if(state.attempts>=Math.min(limit.maxAttempts,instance.pins.budget.maxAttempts))reasons.push('ATTEMPT_BUDGET_EXHAUSTED');
  if(now-Date.parse(instance.createdAt)>=instance.pins.budget.timeoutSeconds*1000)reasons.push('INSTANCE_TIME_BUDGET_EXHAUSTED');
  const inFlight=Object.values(instance.stages).filter(s=>['RUNNING','UNKNOWN'].includes(s.status)).length;
  if(inFlight>=Math.min(limit.maxConcurrency,instance.pins.budget.maxConcurrency))reasons.push('CONCURRENCY_BUDGET_EXHAUSTED');
  for(const dependency of node.dependsOn){const prior=instance.stages[dependency];if(prior.status!=='PASSED')reasons.push('PREDECESSOR_NOT_PASSED:'+dependency);else if(!prior.expiresAt||Date.parse(prior.expiresAt)<=now)reasons.push('PREDECESSOR_EVIDENCE_STALE:'+dependency);}
  if(needsCandidate(node)&&!instance.candidate)reasons.push('CANDIDATE_REQUIRED');
  if(stageId==='publication'){
    const decision=context.releaseAuthority;
    if(!decision||decision.projectId!==instance.pins.projectId||decision.instanceId!==instance.id||decision.pinsDigest!==instance.pinsDigest||decision.definitionRevisionId!==instance.pins.definitionRevisionId||decision.requirementsDigest!==instance.pins.requirementsDigest||decision.semanticDigest!==instance.pins.semanticDigest||decision.candidateDigest!==instance.candidateDigest||decision.channel!==atPath(instance.definition.semantic,'config.publication.channel')||typeof decision.decisionRef!=='string'||!decision.decisionRef.length||!Number.isFinite(Date.parse(decision.expiresAt))||Date.parse(decision.expiresAt)<=now)reasons.push('EXACT_RELEASE_AUTHORITY_REQUIRED');
  }
  return{allowed:reasons.length===0,reasons,inputDigest:valueDigest({instanceId:instance.id,pinsDigest:instance.pinsDigest,stageId,checks:node.checks,candidateDigest:needsCandidate(node)?instance.candidateDigest:null})};
}
/** Pure transition; the caller must persist this request before external dispatch. */
export function requestStage(instance:LifecycleInstance,stageId:string,requestId:string,context:AdmissionContext):LifecycleInstance{
  string(requestId);const admission=stageAdmission(instance,stageId,context);
  if(!admission.allowed)reject('STAGE_BLOCKED',admission.reasons.join('; '),409);
  if(instance.requestIds.includes(requestId))reject('REQUEST_CONFLICT','Request ID already belongs to a stage/attempt',409);
  const next=cloned(instance),stage=next.stages[stageId];stage.status='RUNNING';stage.attempts++;stage.requestId=requestId;stage.inputDigest=admission.inputDigest;stage.requestedAt=new Date(context.now??Date.now()).toISOString();stage.receiptRef=null;stage.outcomeDigest=null;stage.expiresAt=null;
  next.requestIds.push(requestId);
  return immutable(next);
}
/** Only adapter-observed receipts reach this reducer. A client PASS is not one.
 * UNKNOWN can be resolved only against its original request/input, never retried. */
export function recordStageOutcome(instance:LifecycleInstance,stageId:string,outcome:StageOutcome,now=Date.now()):LifecycleInstance{
  verify(instance);requireCurrentBase(instance.pins.base);const node=instance.definition.nodes.find(n=>n.id===stageId),stage=instance.stages[stageId];
  if(!node||!stage)reject('UNKNOWN_STAGE','Stage is not in the fixed instance');
  exact(record(outcome),['requestId','inputDigest','receiptRef','status','expiresAt','checks'],['candidate']);
  string(outcome.receiptRef,512);if(outcome.requestId!==stage.requestId||outcome.inputDigest!==stage.inputDigest)reject('RECEIPT_MISMATCH','Receipt belongs to another exact request/input',409);
  const outcomeDigest=valueDigest(outcome);
  if(stage.outcomeDigest===outcomeDigest)return instance;
  if(!['RUNNING','UNKNOWN'].includes(stage.status))reject('STAGE_OUTCOME_CONFLICT','Completed stage cannot be rewritten by another receipt',409);
  if(!['RUNNING','COMPLETE','FAILED','UNKNOWN'].includes(outcome.status)||!Array.isArray(outcome.checks)||outcome.checks.length>128||!Number.isFinite(Date.parse(outcome.expiresAt)))reject('INVALID_STAGE_OUTCOME','Invalid bounded stage observation');
  const next=cloned(instance),updated=next.stages[stageId],ids=new Set<string>();
  for(const check of outcome.checks){exact(record(check),['id','status','evidenceRef']);string(check.id);string(check.evidenceRef,512);if(ids.has(check.id)||!node.checks.includes(check.id)||!['PASS','FAIL','UNKNOWN'].includes(check.status))reject('CHECK_SCOPE','Evidence check is duplicate or outside the fixed set');ids.add(check.id);}
  const complete=ids.size===node.checks.length&&outcome.checks.every(c=>c.status==='PASS')&&Date.parse(outcome.expiresAt)>now;
  if(outcome.status==='COMPLETE'&&!complete)reject('CHECKS_NOT_PASSED','Every fixed required check needs current passing evidence',409);
  if(outcome.status==='COMPLETE'&&stageId==='candidate'){
    if(!outcome.candidate)reject('CANDIDATE_REQUIRED','Candidate completion requires actual manifest evidence');
    next.candidateDigest=candidateDigest(outcome.candidate);next.candidate=cloned(outcome.candidate);
  }else if(outcome.candidate!==undefined)reject('CANDIDATE_MUTATION','Only candidate completion may bind a candidate');
  updated.status=outcome.status==='COMPLETE'?'PASSED':outcome.status==='FAILED'?'FAILED':outcome.status==='RUNNING'?'RUNNING':'UNKNOWN';updated.receiptRef=outcome.receiptRef;updated.outcomeDigest=outcomeDigest;updated.expiresAt=outcome.expiresAt;
  return immutable(next);
}
