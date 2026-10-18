import type { Providers, ServiceOptions, Store, State, Request, Operation, SyncOperation, Response, ExternalRequest, Outcome, Receipt, Run } from './types.js';
export type * from './types.js';
import { exactFields, frozenClone, sha256, stableSerialize } from '../vendor/compatibility/v1/reference.mjs';
import { openState, bounded, fail, LIMITS, validateState } from './state.js';
import { operations, validateRequest, operate, findRun } from './operations.js';
import { claimRun, invoke } from './execution.js';
import { types } from 'node:util';
import { createNativeRuntime, NATIVE_RUNTIME_OPERATIONS } from './native.js';
import type { NativeRequest } from './native-types.js';
import type { FeedbackEnvelope } from './feedback.js';
import { RUNTIME_FEEDBACK_OPERATIONS } from './feedback.js';
export type * from './feedback.js';
export type * from './native-types.js';

function providerOptions(value: unknown): Readonly<Providers> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) fail('INVALID_PROVIDER','Expected plain provider object');
  const descriptors=Object.getOwnPropertyDescriptors(value), providers: Record<string,unknown>=Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !['resolveOntology','resolveHarness','execute','inspectReceipt','timeoutMs','nativeStandards','collect','inspectCollection','resolveNative','executeNative','inspectNative','readOwnerReceipt','inspectSource','resolveRequirements','verifyProject','deliverFeedback','readFeedbackInbox'].includes(key)) fail('INVALID_PROVIDER','Unknown provider option');
    const d=descriptors[key];
    if (!Object.hasOwn(d,'value') || !d.enumerable) fail('INVALID_PROVIDER','Provider data descriptors required');
    if (key === 'timeoutMs') {
      if (!Number.isInteger(d.value) || d.value<1 || d.value>30000) fail('INVALID_PROVIDER','Timeout must be 1..30000ms');
    } else if (key==='nativeStandards') { bounded(d.value); providers[key]=frozenClone(d.value);continue; }
    else if (typeof d.value !== 'function') fail('INVALID_PROVIDER','Provider callback must be a function');
    providers[key]=d.value;
  }
  return Object.freeze(providers) as Readonly<Providers>;
}

export function createRuntimeService(options: ServiceOptions,trustedProviders: Providers={}) {
  bounded(options); exactFields(options,['workspaceRoot','workspaceId']);
  const providers=providerOptions(trustedProviders);
  const timeoutMs=providers.timeoutMs??30000;
  let store: Store|null=null,closed=false;
  let nativeRuntime: ReturnType<typeof createNativeRuntime>|null=null;
  const controllers=new Set<AbortController>();
  const capabilities=()=>frozenClone({product:'runtime',version:'0.4.0',stage:'NATIVE_STANDARDS',operations:operations.filter(op=>!['run.prepare','run.decide'].includes(op)),historicalRunsReadOnly:true,nativeOperations:NATIVE_RUNTIME_OPERATIONS,feedbackOperations:RUNTIME_FEEDBACK_OPERATIONS,asyncOperations:['reconcile','native'],authority:false,softwareRelease:false,limits:LIMITS});
  function initialize() { if(closed) fail('CLOSED','Service closed'); if(!store) store=openState(options.workspaceRoot,options.workspaceId); return frozenClone({workspaceId:options.workspaceId,initialized:true,authority:false}); }
  function transact<K extends Operation>(request: Request<K>, internal?: (state: State, request: Request)=>unknown, completion=false): Response<K> {
    bounded(request); const r=frozenClone(request) as Request,write=validateRequest(r);
    if(closed) fail('CLOSED','Service closed'); if(!store) fail('NOT_INITIALIZED','Explicit initialize required');
    store.guard(); const db=store.db; let active=false;
    try {
      db.exec(write?'BEGIN IMMEDIATE':'BEGIN'); active=true;
      const scope=stableSerialize(r.scope),digest=sha256({operation:r.operation,scope:r.scope,input:r.input});
      const row=db.prepare('SELECT revision,data FROM state WHERE singleton=1').get();
      if(!row||typeof row.revision !== 'number' || typeof row.data !== 'string' || !Number.isSafeInteger(row.revision)||Buffer.byteLength(row.data)>LIMITS.stateBytes) fail('CORRUPT_STATE','Invalid state');
      const state=validateState(JSON.parse(row.data));
      for(const run of state.runs) if(!store.acceptsWorkspace(run.plan.workspace, run.reviewDigest)) fail('CORRUPT_STATE','Stored workspace binding differs');
      // Validate every retained receipt, not just the requested row.
      const retained=db.prepare('SELECT scope,request_id,digest,receipt FROM receipts').all();
      if(retained.length>LIMITS.receipts || retained.reduce((n,r)=>n+Buffer.byteLength(sqlText(r.receipt)),0)>LIMITS.receiptBytes) fail('CORRUPT_STATE','Receipt storage bound');
      for(const saved of retained) {
        if(Buffer.byteLength(sqlText(saved.receipt))>LIMITS.requestBytes*2) fail('CORRUPT_STATE','Oversized receipt');
        const value=JSON.parse(sqlText(saved.receipt)); exactFields(value,['requestId','scope','operation','requestDigest','revision','uid','timestamp','result']);
        if(stableSerialize(value.scope)!==saved.scope||value.requestId!==saved.request_id||value.requestDigest!==saved.digest) fail('CORRUPT_STATE','Receipt binding mismatch');
        const audit=db.prepare('SELECT uid,operation,request_digest,result_digest FROM audit WHERE revision=?').get(sqlNumber(value.revision));
        if(!audit || audit.uid!==value.uid || audit.operation!==value.operation || audit.request_digest!==value.requestDigest || audit.result_digest!==sha256(value.result)) fail('CORRUPT_STATE','Audit receipt mismatch');
      }
      if(db.prepare('SELECT count(*) AS n FROM audit').get()!.n!==retained.length || row.revision!==retained.length) fail('CORRUPT_STATE','Revision history mismatch');
      let result;
      const old=write?db.prepare('SELECT digest,receipt FROM receipts WHERE scope=? AND request_id=?').get(scope,r.requestId!):null;
      if(old) { if(old.digest!==digest) fail('REQUEST_CONFLICT','Request id binds different input'); result=JSON.parse(sqlText(old.receipt)); }
      else {
        if(write&&!completion&&row.revision!==r.expectedRevision) fail('REVISION_CONFLICT','Global Runtime revision changed');
        if(internal) result=internal(state,r);
        else if(r.operation==='workspace.inspect') { exactFields(r.input,[]); result={workspaceId:options.workspaceId,revision:row.revision,scope:r.scope,authority:false}; }
        else if(r.operation==='receipt.inspect') { exactFields(r.input,['requestId']); const saved=db.prepare('SELECT receipt FROM receipts WHERE scope=? AND request_id=?').get(scope,r.input.requestId); if(!saved) fail('NOT_FOUND','Receipt not found'); result=JSON.parse(sqlText(saved.receipt)); }
        else result=operate(store,state,r,providers,row.revision);
        if(write) {
          validateState(state); const data=stableSerialize(state),revision=row.revision+1;
          if(Buffer.byteLength(data)>LIMITS.stateBytes||!Number.isSafeInteger(revision)||sqlNumber(db.prepare('SELECT count(*) AS n FROM receipts').get()!.n)>=LIMITS.receipts) fail('LIMIT','Storage bound');
          const receipt={requestId:r.requestId,scope:r.scope,operation:r.operation,requestDigest:digest,revision,uid:store.uid,timestamp:new Date().toISOString(),result};
          const bytes=stableSerialize(receipt);
          if(Buffer.byteLength(bytes)>LIMITS.requestBytes*2 || (db.prepare('SELECT coalesce(sum(length(CAST(receipt AS BLOB))),0) AS n FROM receipts').get()!.n as number)+Buffer.byteLength(bytes)>LIMITS.receiptBytes) fail('LIMIT','Receipt bound');
          db.prepare('UPDATE state SET revision=?,data=? WHERE singleton=1 AND revision=?').run(revision,data,row.revision);
          db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run(scope,r.requestId!,digest,bytes);
          db.prepare('INSERT INTO audit VALUES(?,?,?,?,?)').run(revision,store.uid,r.operation,digest,sha256(result)); result=receipt;
        }
      }
      db.exec('COMMIT'); active=false; return frozenClone(result) as Response<K>;
    } finally { if(active) db.exec('ROLLBACK'); }
  }
  function execute<K extends SyncOperation>(request: Request<K>): Response<K> { bounded(request); if(!operations.includes(request.operation)) fail('INVALID_OPERATION','Use explicit async dispatch/reconcile'); if(['run.prepare','run.decide'].includes(request.operation))fail('HISTORICAL_READ_ONLY','Retired JSON validation accepts no new work; use native API');return transact(request); }
  async function external(args: ExternalRequest,reconcile: boolean): Promise<Receipt<Run>> {
    if(!reconcile)fail('HISTORICAL_READ_ONLY','Retired JSON dispatch disabled; inspect/reconcile original claim only');
    bounded(args); exactFields(args,['scope','id','requestId','expectedRevision']);
    const operation=reconcile?'run.reconcile':'run.dispatch';
    let invokeNeeded=false;
    const start=transact({operation,scope:args.scope,input:{id:args.id},requestId:args.requestId,expectedRevision:args.expectedRevision},(state,r)=>{
      const run=findRun(state,r);
      if(reconcile) { if(!run.claim) fail('NO_CLAIM','No original claim'); invokeNeeded=['RUNNING','UNKNOWN'].includes(run.stage); }
      else invokeNeeded=claimRun(store!,state,run,providers);
      return run;
    });
    if(!invokeNeeded) return start;
    const original=start.result.claim!;
    const fn=reconcile?providers.inspectReceipt:providers.execute;
    const outcome: Outcome=typeof fn==='function'?await invoke(fn,original,timeoutMs,controllers):{status:'UNKNOWN',receipt:null,reason:'RECEIPT_UNAVAILABLE'};
    if(closed) return frozenClone({...start,unresolved:true});
    // Completion has its own idempotent atomic receipt. No transaction spans await.
    const revision=execute({operation:'workspace.inspect',scope:args.scope,input:{}}).revision;
    return transact({operation,scope:args.scope,input:{id:args.id,outcome},requestId:'done-'+sha256({requestId:args.requestId,operation,scope:args.scope}).slice(7,55),expectedRevision:revision},(state,r)=>{
      const run=findRun(state,r);
      if(run.claim?.claimId!==original.claimId) fail('CLAIM_MISMATCH','Original claim changed');
      if((reconcile&&['RUNNING','UNKNOWN'].includes(run.stage))||(!reconcile&&run.stage==='RUNNING')) { run.stage=outcome.status; run.outcome=outcome; }
      else if(run.stage==='CANCELLED' && run.outcome===null) run.outcome=outcome;
      return run;
    },true);
  }
  async function native(request: NativeRequest):Promise<unknown> {if(closed)fail('CLOSED','Service closed');if(!store)fail('NOT_INITIALIZED','Explicit initialize required');if(!nativeRuntime)nativeRuntime=createNativeRuntime(store,providers);return nativeRuntime.native(request);}
  async function feedback(request:FeedbackEnvelope):Promise<unknown>{if(closed)fail('CLOSED','Service closed');if(!store)fail('NOT_INITIALIZED','Explicit initialize required');if(!nativeRuntime)nativeRuntime=createNativeRuntime(store,providers);return nativeRuntime.feedback(request);}
  function close() { nativeRuntime?.close();for(const c of controllers)c.abort(); if(store){store.db.close();store=null;} closed=true; }
  return Object.freeze({capabilities,initialize,execute,native,feedback,dispatch:(args: ExternalRequest)=>external(args,false),reconcile:(args: ExternalRequest)=>external(args,true),close});
}

function sqlText(value: unknown): string { if (typeof value !== 'string') fail('CORRUPT_STATE','Invalid stored text'); return value; }

function sqlNumber(value: unknown): number { if (typeof value !== 'number') fail('CORRUPT_STATE','Invalid stored number'); return value; }
