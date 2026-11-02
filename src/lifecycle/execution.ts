import { randomUUID } from 'node:crypto';
import { canonical, exact, record, reject, ServiceError, slug, string } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import { RuntimeStore, type Receipt } from '../server/store.js';
import { valueDigest } from './base.js';
import { containsInlineSecret, type EffectiveDefinition } from './compiler.js';
import { validateBindings, type DefinitionBindingProvider } from './bindings.js';
import { inspectInstance, requestStage, recordStageOutcome, resolveAuthority, stageAdmission, stageBudget, type AuthorityResolver, type ExecutionAuthority, type LifecycleInstance, type ReleaseAuthority, type StageOutcome } from './instance.js';

export const EXECUTION_READS=['lifecycle.stage.request.inspect','lifecycle.stage.observation.read'] as const;
export const EXECUTION_WRITES=['lifecycle.stage.request','lifecycle.stage.reconcile'] as const;
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
/** Fixed trusted adapters only. prepare and inspect must be read-only. dispatch
 * must call permit immediately before each authorized external side effect.
 * No API/YAML field can provide this implementation or a client PASS. */
export interface StageAdapter {
  prepare(instance:LifecycleInstance,stageId:string,actor:Principal,signal:AbortSignal):Promise<StagePlan>;
  dispatch(request:StageRequest,instance:LifecycleInstance,permit:()=>Promise<Principal>,signal:AbortSignal):Promise<StageObservation>;
  inspect(request:StageRequest,instance:LifecycleInstance,progress:StageProgress,actor:Principal,signal:AbortSignal):Promise<StageObservation>;
}
export interface ExecutionDependencies {
  bindings?:DefinitionBindingProvider; authorities?:AuthorityResolver;
  verifyAuthority?:(grant:ExecutionAuthority,definition:EffectiveDefinition,actor:Principal)=>void;
  releaseAuthority?:(instance:LifecycleInstance,actor:Principal)=>ReleaseAuthority|undefined;
  principal:(id:string)=>Principal|null; adapter?:StageAdapter;
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
  function fixedInstance(r:StageRequest):LifecycleInstance{
    const saved=instance(r.projectId,r.instanceId),stage=saved.stages[r.stageId];
    if(saved.pinsDigest!==r.pinsDigest||!stage||stage.requestId!==r.id||stage.inputDigest!==r.inputDigest)reject('STAGE_REQUEST_MISMATCH','Original request does not match the immutable instance attempt',409);return saved;
  }
  function actorFor(r:StageRequest):Principal{
    const actor=deps.principal(r.initiatedBy.id);
    if(!actor||actor.revision!==r.initiatedBy.revision)reject('AUTHORITY_CHANGED','Original execution principal changed',403);
    authorize(actor,r.projectId,'execution.request');if(r.stageId==='publication')authorize(actor,r.projectId,'release.request');return actor;
  }
  async function admission(saved:LifecycleInstance,stageId:string,actor:Principal){
    const ref=store.object(saved.pins.projectId,'instance-authority',saved.id) as {evidenceRef:string}|null;
    if(!ref)reject('CORRUPT_INSTANCE','Instance authority reference missing',503);
    const authority=await resolveAuthority(deps.authorities,ref.evidenceRef,saved.definition,actor);
    const checked=await validateBindings(saved.definition,actor,deps.bindings);
    deps.verifyAuthority?.(authority,saved.definition,actor);
    const release=stageId==='publication'?deps.releaseAuthority?.(saved,actor):undefined;
    return{authority,checked,release,context:{authority,bindingsCurrent:checked.ready,releaseAuthority:release}};
  }
  async function permit(r:StageRequest):Promise<Principal>{
    if(closed)reject('STOPPING','Service is stopping',503);
    if(Date.parse(r.deadlineAt)<=Date.now())reject('EXECUTION_DEADLINE','This original request exhausted its dispatch time budget',409);
    const saved=fixedInstance(r),actor=actorFor(r),current=await admission(saved,r.stageId,actor);
    if(!current.checked.ready||current.checked.stamp!==r.bindingStamp||valueDigest(current.authority)!==saved.pins.authorityDigest||current.authority.evidenceRef!==r.authorityRef||(current.release?.decisionRef??null)!==r.releaseAuthorityRef)reject('EXECUTION_BINDING_CHANGED','Current execution pins or authority differ from the retained request',409);
    const fresh=actorFor(r);deps.verifyAuthority?.(current.authority,saved.definition,fresh);
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
    validateObservation(r,p,observation);const saved=fixedInstance(r),next=recordStageOutcome(saved,r.stageId,observation.outcome);
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
  function start(r:StageRequest,mode:'dispatch'|'inspect'):void{
    const id=key(r.projectId,r.id);if(closed||active.has(id)||progress(r).terminal)return;
    if(!deps.adapter){unknown(r,'EXECUTOR_UNAVAILABLE');return;}
    const controller=new AbortController();
    const promise=Promise.resolve().then(async()=>{
      try{
        const saved=fixedInstance(r);
        const observed=await bounded(async signal=>{
          if(mode==='dispatch'){await permit(r);return deps.adapter!.dispatch(r,saved,()=>permit(r),signal);}
          return deps.adapter!.inspect(r,saved,progress(r),system(r.projectId),signal);
        // Multi-request provider protocols include current permit checks and
        // immutable ref creation. Keep their transport window bounded without
        // replacing or extending the already approved original stage deadline.
        },controller.signal,mode==='dispatch'?Math.max(1,Math.min(60000,Date.parse(r.deadlineAt)-Date.now())):30000);
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
      for(const item of page.rows){if(active.size>=4)break;cursor=item;consumed++;const id=key(item.projectId,item.id);if((nextObservation.get(id)??0)>Date.now())continue;try{const r=request(item.projectId,item.id);start(r,'inspect');}catch(e){workerError={projectId:item.projectId,requestId:item.id,code:e instanceof ServiceError?e.code:'OBSERVATION_UNAVAILABLE'};}}
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
    if(operation==='lifecycle.stage.observation.read'){
      exact(input,['stageRequestId','observationRef']);const r=request(projectId,string(input.stageRequestId)),ref=hash(input.observationRef),evidence=store.object(projectId,'stage-observation',ref);
      if(!evidence||record(evidence).requestId!==r.id)reject('NOT_FOUND','Observation not found for this exact request',404);
      if(valueDigest(evidence)!==ref)reject('CORRUPT_STAGE_OBSERVATION','Retained observation content changed',503);
      return{observationRef:ref,evidence,historical:true};
    }
    if(operation!=='lifecycle.stage.request.inspect')reject('UNKNOWN_OPERATION','Unsupported execution read',404);exact(input,['stageRequestId']);
    const r=request(projectId,string(input.stageRequestId));return{request:r,progress:progress(r),workerError:workerError?.projectId===projectId&&workerError.requestId===r.id?workerError.code:null,projectRevision:store.revision(projectId),automaticRedispatch:false};
  }
  async function write(actor:Principal,projectId:string,operation:string,input:Record<string,unknown>,requestId:string,expectedRevision:number,reauthorize:()=>Principal):Promise<Receipt>{
    if(closed)reject('STOPPING','Service is stopping',503);
    if(!EXECUTION_WRITES.includes(operation as typeof EXECUTION_WRITES[number]))reject('UNKNOWN_OPERATION','Unsupported execution operation',404);
    const reconciling=operation==='lifecycle.stage.reconcile',permission=reconciling?'read':'execution.request';authorize(actor,projectId,permission);
    exact(input,reconciling?['stageRequestId']:['instanceId','stageId']);
    const mutation={projectId,operation,requestId,expectedRevision,input,permission} as const;
    if(store.findReceipt(actor,projectId,requestId))return store.mutate(actor,mutation,()=>{throw new Error('Unreachable replay callback');},reauthorize);
    if(reconciling){
      const r=request(projectId,string(input.stageRequestId)),p=progress(r);
      const result=store.mutate(actor,mutation,()=>({value:{stageRequestId:r.id,status:p.terminal?'TERMINAL':'INSPECT_ORIGINAL',automaticRedispatch:false},event:{type:'stage-inspection-requested',data:{instanceId:r.instanceId,stageId:r.stageId,stageRequestId:r.id,automaticRedispatch:false}}}),reauthorize);
      start(r,'inspect');return result;
    }
    if(!deps.adapter)reject('EXECUTOR_UNAVAILABLE','No fixed stage adapter is configured',409);
    if(active.size>=4)reject('EXECUTOR_BUSY','The bounded service worker is busy',429);
    const saved=instance(projectId,slug(input.instanceId)),stageId=string(input.stageId),node=saved.definition.nodes.find(n=>n.id===stageId);
    if(!node)reject('UNKNOWN_STAGE','Stage does not belong to this immutable instance');
    if(stageId==='publication')authorize(actor,projectId,'release.request');
    const current=await admission(saved,stageId,actor),admitted=stageAdmission(saved,stageId,current.context);
    if(!admitted.allowed)reject('STAGE_BLOCKED',admitted.reasons.join('; '),409);
    const plan=await bounded(signal=>deps.adapter!.prepare(saved,stageId,actor,signal),new AbortController().signal,5000);
    exact(record(plan),['adapterId','adapterDigest','action','bindingDigest','parameters']);slug(plan.adapterId);hash(plan.adapterDigest);hash(plan.bindingDigest);record(plan.parameters);safeData(plan);
    if(plan.action!==(node.source==='base'?'base.'+node.id:node.action!.actionRef))reject('ACTION_MISMATCH','Adapter action does not match the fixed Base/extension action',409);
    const planned=copy(plan),now=Date.now(),limit=stageBudget(saved,node);
    const content:Omit<StageRequest,'digest'>={schema:'runtime-stage-request/v1',id:randomUUID(),workspaceId:store.workspaceId,projectId,instanceId:saved.id,stageId,pinsDigest:saved.pinsDigest,inputDigest:admitted.inputDigest,bindingStamp:current.checked.stamp!,authorityRef:current.authority.evidenceRef,releaseAuthorityRef:current.release?.decisionRef??null,initiatedBy:{id:actor.id,revision:actor.revision},plan:planned,planDigest:valueDigest(planned),requestedAt:new Date(now).toISOString(),deadlineAt:new Date(Math.min(now+limit.timeoutSeconds*1000,Date.parse(saved.createdAt)+saved.pins.budget.timeoutSeconds*1000,Date.parse(current.authority.expiresAt))).toISOString()};
    const r=copy({...content,digest:valueDigest(content)});
    const result=store.mutate(actor,mutation,()=>{
      if(closed)reject('STOPPING','Service is stopping',503);
      const fresh=reauthorize();authorize(fresh,projectId,'execution.request');if(stageId==='publication')authorize(fresh,projectId,'release.request');
      deps.verifyAuthority?.(current.authority,saved.definition,fresh);
      if(!current.checked.expiresAt||Date.parse(current.checked.expiresAt)<=Date.now()||Date.parse(r.deadlineAt)<=Date.now())reject('EXECUTION_DEADLINE','Execution admission expired before request commit',409);
      if(stageId==='publication'&&deps.releaseAuthority?.(saved,fresh)?.decisionRef!==r.releaseAuthorityRef)reject('AUTHORITY_CHANGED','Release authority changed before request commit',409);
      const next=requestStage(saved,stageId,r.id,current.context),p:StageProgress={requestId:r.id,phase:'DISPATCHING',terminal:false,handle:null,observation:null,observationRef:null,reason:null,observedAt:r.requestedAt};
      return{objects:[{kind:'lifecycle-instance',id:saved.id,value:next},{kind:'stage-request',id:r.id,value:r},{kind:'stage-progress',id:r.id,value:p}],value:{stageRequestId:r.id,instanceId:saved.id,stageId,inputDigest:r.inputDigest,status:'REQUEST_RETAINED',automaticRedispatch:false},event:{type:'stage-requested',data:{instanceId:saved.id,stageId,stageRequestId:r.id,inputDigest:r.inputDigest,planDigest:r.planDigest,initiatedBy:actor.id}}};
    },reauthorize);
    // The transaction, receipt and audit are durable before this promise can
    // perform an external action. Replays/restarts never enter this branch.
    start(r,'dispatch');return result;
  }
  return{read,write,health(projectId:string){const error=scanError??(workerError?.projectId===projectId?workerError.code:null);return{state:error?'DEGRADED':closed?'STOPPED':'READY',error,inFlight:[...active.keys()].filter(k=>k.startsWith(projectId+'\0')).length,automaticRedispatch:false};},async close(){if(closed)return;closed=true;clearInterval(timer);for(const job of active.values())job.controller.abort();await Promise.allSettled([...active.values()].map(job=>job.promise));}};
}
