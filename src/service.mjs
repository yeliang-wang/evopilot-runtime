import { exactFields, frozenClone, sha256, stableSerialize } from '../vendor/compatibility/v1/reference.mjs';
import { openState, bounded, fail, LIMITS, validateState } from './state.mjs';
import { operations, validateRequest, operate, findRun } from './operations.mjs';
import { claimRun, invoke } from './execution.mjs';
import { types } from 'node:util';

function providerOptions(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) fail('INVALID_PROVIDER','Expected plain provider object');
  const descriptors=Object.getOwnPropertyDescriptors(value), providers=Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (!['resolveOntology','resolveHarness','execute','inspectReceipt','timeoutMs'].includes(key)) fail('INVALID_PROVIDER','Unknown provider option');
    const d=descriptors[key];
    if (!Object.hasOwn(d,'value') || !d.enumerable) fail('INVALID_PROVIDER','Provider data descriptors required');
    if (key === 'timeoutMs') {
      if (!Number.isInteger(d.value) || d.value<1 || d.value>30000) fail('INVALID_PROVIDER','Timeout must be 1..30000ms');
    } else if (typeof d.value !== 'function') fail('INVALID_PROVIDER','Provider callback must be a function');
    providers[key]=d.value;
  }
  return Object.freeze(providers);
}

export function createRuntimeService(options,trustedProviders={}) {
  bounded(options); exactFields(options,['workspaceRoot','workspaceId']);
  const providers=providerOptions(trustedProviders);
  const timeoutMs=providers.timeoutMs??30000;
  let store=null,closed=false;
  const controllers=new Set();
  const capabilities=()=>frozenClone({product:'runtime',version:'0.1.0',stage:'M2_DURABLE_SERVICE',operations,asyncOperations:['dispatch','reconcile'],authority:false,softwareRelease:false,limits:LIMITS});
  function initialize() { if(closed) fail('CLOSED','Service closed'); if(!store) store=openState(options.workspaceRoot,options.workspaceId); return frozenClone({workspaceId:options.workspaceId,initialized:true,authority:false}); }
  function transact(request,internal,completion=false) {
    bounded(request); const r=frozenClone(request),write=validateRequest(r);
    if(closed) fail('CLOSED','Service closed'); if(!store) fail('NOT_INITIALIZED','Explicit initialize required');
    store.guard(); const db=store.db; let active=false;
    try {
      db.exec(write?'BEGIN IMMEDIATE':'BEGIN'); active=true;
      const scope=stableSerialize(r.scope),digest=sha256({operation:r.operation,scope:r.scope,input:r.input});
      const row=db.prepare('SELECT revision,data FROM state WHERE singleton=1').get();
      if(!row||!Number.isSafeInteger(row.revision)||Buffer.byteLength(row.data)>LIMITS.stateBytes) fail('CORRUPT_STATE','Invalid state');
      const state=validateState(JSON.parse(row.data));
      for(const run of state.runs) if(stableSerialize(run.plan.workspace)!==stableSerialize(store.identity)) fail('CORRUPT_STATE','Stored workspace binding differs');
      // Validate every retained receipt, not just the requested row.
      const retained=db.prepare('SELECT scope,request_id,digest,receipt FROM receipts').all();
      if(retained.length>LIMITS.receipts || retained.reduce((n,r)=>n+Buffer.byteLength(r.receipt),0)>LIMITS.receiptBytes) fail('CORRUPT_STATE','Receipt storage bound');
      for(const saved of retained) {
        if(Buffer.byteLength(saved.receipt)>LIMITS.requestBytes*2) fail('CORRUPT_STATE','Oversized receipt');
        const value=JSON.parse(saved.receipt); exactFields(value,['requestId','scope','operation','requestDigest','revision','uid','timestamp','result']);
        if(stableSerialize(value.scope)!==saved.scope||value.requestId!==saved.request_id||value.requestDigest!==saved.digest) fail('CORRUPT_STATE','Receipt binding mismatch');
        const audit=db.prepare('SELECT uid,operation,request_digest,result_digest FROM audit WHERE revision=?').get(value.revision);
        if(!audit || audit.uid!==value.uid || audit.operation!==value.operation || audit.request_digest!==value.requestDigest || audit.result_digest!==sha256(value.result)) fail('CORRUPT_STATE','Audit receipt mismatch');
      }
      if(db.prepare('SELECT count(*) AS n FROM audit').get().n!==retained.length || row.revision!==retained.length) fail('CORRUPT_STATE','Revision history mismatch');
      let result;
      const old=write?db.prepare('SELECT digest,receipt FROM receipts WHERE scope=? AND request_id=?').get(scope,r.requestId):null;
      if(old) { if(old.digest!==digest) fail('REQUEST_CONFLICT','Request id binds different input'); result=JSON.parse(old.receipt); }
      else {
        if(write&&!completion&&row.revision!==r.expectedRevision) fail('REVISION_CONFLICT','Global Runtime revision changed');
        if(internal) result=internal(state,r);
        else if(r.operation==='workspace.inspect') { exactFields(r.input,[]); result={workspaceId:options.workspaceId,revision:row.revision,scope:r.scope,authority:false}; }
        else if(r.operation==='receipt.inspect') { exactFields(r.input,['requestId']); const saved=db.prepare('SELECT receipt FROM receipts WHERE scope=? AND request_id=?').get(scope,r.input.requestId); if(!saved) fail('NOT_FOUND','Receipt not found'); result=JSON.parse(saved.receipt); }
        else result=operate(store,state,r,providers,row.revision);
        if(write) {
          validateState(state); const data=stableSerialize(state),revision=row.revision+1;
          if(Buffer.byteLength(data)>LIMITS.stateBytes||!Number.isSafeInteger(revision)||db.prepare('SELECT count(*) AS n FROM receipts').get().n>=LIMITS.receipts) fail('LIMIT','Storage bound');
          const receipt={requestId:r.requestId,scope:r.scope,operation:r.operation,requestDigest:digest,revision,uid:store.uid,timestamp:new Date().toISOString(),result};
          const bytes=stableSerialize(receipt);
          if(Buffer.byteLength(bytes)>LIMITS.requestBytes*2 || db.prepare('SELECT coalesce(sum(length(CAST(receipt AS BLOB))),0) AS n FROM receipts').get().n+Buffer.byteLength(bytes)>LIMITS.receiptBytes) fail('LIMIT','Receipt bound');
          db.prepare('UPDATE state SET revision=?,data=? WHERE singleton=1 AND revision=?').run(revision,data,row.revision);
          db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run(scope,r.requestId,digest,bytes);
          db.prepare('INSERT INTO audit VALUES(?,?,?,?,?)').run(revision,store.uid,r.operation,digest,sha256(result)); result=receipt;
        }
      }
      db.exec('COMMIT'); active=false; return frozenClone(result);
    } finally { if(active) db.exec('ROLLBACK'); }
  }
  function execute(request) { bounded(request); if(!operations.includes(request.operation)) fail('INVALID_OPERATION','Use explicit async dispatch/reconcile'); return transact(request); }
  async function external(args,reconcile) {
    bounded(args); exactFields(args,['scope','id','requestId','expectedRevision']);
    const operation=reconcile?'run.reconcile':'run.dispatch';
    let invokeNeeded=false;
    const start=transact({operation,scope:args.scope,input:{id:args.id},requestId:args.requestId,expectedRevision:args.expectedRevision},(state,r)=>{
      const run=findRun(state,r);
      if(reconcile) { if(!run.claim) fail('NO_CLAIM','No original claim'); invokeNeeded=['RUNNING','UNKNOWN'].includes(run.stage); }
      else invokeNeeded=claimRun(store,state,run,providers);
      return run;
    });
    if(!invokeNeeded) return start;
    const original=start.result.claim;
    const fn=reconcile?providers.inspectReceipt:providers.execute;
    const outcome=typeof fn==='function'?await invoke(fn,original,timeoutMs,controllers):{status:'UNKNOWN',receipt:null,reason:'RECEIPT_UNAVAILABLE'};
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
  function close() { for(const c of controllers)c.abort(); if(store){store.db.close();store=null;} closed=true; }
  return Object.freeze({capabilities,initialize,execute,dispatch:args=>external(args,false),reconcile:args=>external(args,true),close});
}
