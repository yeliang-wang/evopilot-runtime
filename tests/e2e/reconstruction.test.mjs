import {DatabaseSync} from 'node:sqlite';
import {createRuntimeService} from '@evopilot-next/runtime/service';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {reconstructionFixture,receipt,hash,observation} from '../fixtures/reconstruction.mjs';

test('T4-R01 exact plan decision, independent clean attempts and durable request replay',async t=>{
 const f=await reconstructionFixture(t),req=await f.request('reconstruction.dispatch',{planDigest:f.binding.digest});
 const a=await f.service.reconstruction(req);assert.equal(a.attempt.status,'SUCCEEDED');assert.equal(f.calls,1);
 assert.deepEqual(await f.service.reconstruction(req),a);f.close();f.open();assert.deepEqual(await f.service.reconstruction(req),a);assert.equal(f.calls,1);
 const b=await f.write('reconstruction.dispatch',{planDigest:f.binding.digest});assert.equal(b.attempt.claim.ordinal,2);assert.notEqual(b.attempt.receipt.workspaceId,a.attempt.receipt.workspaceId);assert.equal(b.attempt.claim.remaining.tokens,90);
 assert.equal((await f.read('reconstruction.list',{planDigest:f.binding.digest})).length,2);
 await assert.rejects(f.service.reconstruction({...req,input:{planDigest:hash('changed')}}),{code:'REQUEST_CONFLICT'});
});
test('T4-R02 API rejects forged decisions, cross scope, unknown fields and unsupported executors',async t=>{
 const f=await reconstructionFixture(t,{prepare:false});
 await assert.rejects(f.write('reconstruction.freeze',{plan:f.plan,humanEvidenceRef:'approved in chat'}));
 await assert.rejects(f.read('reconstruction.review',{plan:{...f.plan,scope:{...f.scope,projectId:'foreign'}}}),{code:'RECONSTRUCTION_SCOPE'});
 await assert.rejects(f.read('reconstruction.review',{plan:{...f.plan,approved:true}}));
 const b=await f.freeze();f.close();delete f.providers.executeReconstruction;f.open();
 await assert.rejects(f.write('reconstruction.dispatch',{planDigest:b.digest}),{code:'RECONSTRUCTION_UNSUPPORTED'});
 assert.equal((await f.read('reconstruction.list',{planDigest:b.digest})).length,0);
 await assert.rejects(f.read('reconstruction.plan',{digest:b.digest},{...f.scope,projectId:'foreign'}),{code:'RECONSTRUCTION_NOT_FOUND'});
});
test('T4-R03 timeout retains claim; reconciliation never redispatches or silently frees the global lock',async t=>{
 let executed=0,claim;
 const f=await reconstructionFixture(t,{budget:{wallMs:35},providerOverrides:{executeReconstruction:async c=>{executed++;claim=c.claim;return new Promise(()=>{});}}});
 const a=await f.write('reconstruction.dispatch',{planDigest:f.binding.digest});assert.equal(a.attempt.status,'UNKNOWN');assert.equal(a.attempt.reason,'RECONSTRUCTION_TIMEOUT');
 await assert.rejects(f.write('reconstruction.dispatch',{planDigest:f.binding.digest}),{code:'RECONSTRUCTION_BUSY'});
 const r=await f.write('reconstruction.reconcile',{id:a.attempt.id});assert.equal(r.attempt.status,'UNKNOWN');assert.equal(executed,1);
 f.receipts.set(claim.claimId,receipt(claim,{status:'FAILED',diagnostic:'Killed after timeout'}));f.close();f.open();
 const recovered=await f.write('reconstruction.reconcile',{id:a.attempt.id});assert.equal(recovered.attempt.status,'FAILED');assert.equal(executed,1);
});
test('T4-R04 cancellation remains sticky and late completion cannot replace a reconciled result',async t=>{
 let release,started;const begun=new Promise(r=>{started=r;});
 const f=await reconstructionFixture(t,{providerOverrides:{executeReconstruction:async({claim})=>{started(claim);return new Promise(r=>{release=r;});},cancelReconstruction:async({claim})=>receipt(claim,{status:'CANCELLED',diagnostic:'Process terminated'})}});
 const pending=f.write('reconstruction.dispatch',{planDigest:f.binding.digest}),claim=await begun;
 assert.throws(()=>f.close(),{code:'BUSY'});
 const cancelled=await f.write('reconstruction.cancel',{id:claim.attemptId});assert.equal(cancelled.attempt.status,'CANCELLED');
 release(receipt(claim));const returned=await pending;assert.equal(returned.attempt.status,'CANCELLED');assert.equal(returned.attempt.receipt.status,'CANCELLED');
 await assert.rejects(f.read('reconstruction.evidence',{id:claim.attemptId}),{code:'RECONSTRUCTION_NOT_SUCCEEDED'});
});
test('T4-R05 budget is cumulative; invalid receipt, repeated workspace and input drift fail closed',async t=>{
 const f=await reconstructionFixture(t,{budget:{maxTokens:10}});
 const a=await f.write('reconstruction.dispatch',{planDigest:f.binding.digest});assert.equal(a.attempt.status,'SUCCEEDED');
 const b=await f.write('reconstruction.dispatch',{planDigest:f.binding.digest});assert.equal(b.attempt.status,'UNKNOWN');assert.equal(b.attempt.reason,'RECONSTRUCTION_INCOMPLETE');
 const bad=await reconstructionFixture(t,{providerOverrides:{executeReconstruction:async({claim})=>receipt(claim,{inputManifestDigest:hash('wrong')})}});
 assert.equal((await bad.write('reconstruction.dispatch',{planDigest:bad.binding.digest})).attempt.reason,'RECONSTRUCTION_RECEIPT_BINDING');
 const reused=await reconstructionFixture(t,{providerOverrides:{executeReconstruction:async({claim})=>receipt(claim,{workspaceId:'same-workspace'})}});
 await reused.write('reconstruction.dispatch',{planDigest:reused.binding.digest});assert.equal((await reused.write('reconstruction.dispatch',{planDigest:reused.binding.digest})).attempt.reason,'RECONSTRUCTION_WORKSPACE_REUSED');
});
test('T4-R06 frozen plan and current evidence become unusable on accepted planning drift',async t=>{
 const f=await reconstructionFixture(t);const a=await f.write('reconstruction.dispatch',{planDigest:f.binding.digest});
 await f.planningWrite('planning.revise',{id:f.planning.id,parentDigest:f.planning.digest,draft:{...f.draft,title:'Changed plan'}});
 await assert.rejects(f.write('reconstruction.dispatch',{planDigest:f.binding.digest}),{code:'RECONSTRUCTION_PLANNING_STALE'});
 await assert.rejects(f.read('reconstruction.evidence',{id:a.attempt.id}),{code:'RECONSTRUCTION_PLANNING_STALE'});
 assert.equal((await f.read('reconstruction.attempt',{id:a.attempt.id})).receipt.digest,a.attempt.receipt.digest);
});
test('T4-R07 evidence requires adapter reinspection and exact observation; request cannot supply PASS',async t=>{
 const f=await reconstructionFixture(t);const a=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;
 const o=await f.read('reconstruction.evidence',{id:a.id});assert.equal(o.origin,'SYNTHETIC');assert.equal(o.outputDigest,a.receipt.outputDigest);
 await assert.rejects(f.read('reconstruction.evidence',{id:a.id,observation:o}));
 f.receipts.set(a.claim.claimId,receipt(a.claim,{diagnostic:'tampered'}));await assert.rejects(f.read('reconstruction.evidence',{id:a.id}),{code:'RECONSTRUCTION_RECEIPT_DRIFT'});
});
test('T4-R08 SIGKILL after durable claim survives reopen and only original receipt can reconcile',async t=>{
 const f=await reconstructionFixture(t),request=await f.request('reconstruction.dispatch',{planDigest:f.binding.digest});f.close();
 const child=fork(new URL('../fixtures/reconstruction.mjs',import.meta.url),['interrupt',JSON.stringify({options:f.options,request})],{stdio:['ignore','ignore','pipe','ipc']});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 const [claim]=await once(child,'message');child.kill('SIGKILL');await once(child,'exit');f.open();
 assert.equal((await f.read('reconstruction.attempt',{id:request.requestId})).status,'RUNNING');
 assert.equal((await f.service.reconstruction(request)).attempt.status,'RUNNING');assert.equal(f.calls,0);
 f.receipts.set(claim.claimId,receipt(claim));const r=await f.write('reconstruction.reconcile',{id:request.requestId});assert.equal(r.attempt.status,'SUCCEEDED');assert.equal(f.calls,0);
});
test('T4-R09 stale trusted input before dispatch fails without starting a builder',async t=>{
 const f=await reconstructionFixture(t,{providerOverrides:{verifyReconstructionPlan:async p=>({planDigest:hash(p),current:false})}});
 const a=await f.write('reconstruction.dispatch',{planDigest:f.binding.digest});assert.equal(a.attempt.status,'FAILED');assert.equal(a.attempt.reason,'RECONSTRUCTION_STALE');assert.equal(f.calls,0);
});

test('T4-R10 read-only reconstruction discovery leaves a fresh database at its original schema',async t=>{
 const f=await reconstructionFixture(t),options={...f.options,workspaceRoot:path.join(f.root,'read-only-state')},r=createRuntimeService(options);r.initialize();
 assert.equal((await r.reconstruction({operation:'reconstruction.inspect',scope:f.scope,input:{}})).revision,0);r.close();
 const db=new DatabaseSync(path.join(options.workspaceRoot,'state/runtime/runtime.db'),{readOnly:true});try{assert.equal(db.prepare('PRAGMA user_version').get().user_version,1);assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='feedback_identity'").get(),undefined);}finally{db.close();}
});
test('T4-R11 unknown cost stays unknown with an explicit null ceiling and cumulative known tokens',async t=>{
 const f=await reconstructionFixture(t,{budget:{maxCostMicros:null},providerOverrides:{executeReconstruction:async({claim})=>receipt(claim,{usage:{wallMs:10,tokens:11,costMicros:null,iterations:1}})}});
 const a=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;
 assert.equal(a.status,'SUCCEEDED');assert.equal(a.receipt.usage.costMicros,null);assert.equal(a.claim.remaining.costMicros,null);
 f.close();f.open();const b=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;
 assert.equal(b.status,'SUCCEEDED');assert.equal(b.claim.remaining.tokens,89);assert.equal(b.claim.remaining.costMicros,null);
});
test('T4-R12 an unknown monetary charge cannot satisfy a numeric ceiling',async t=>{
 const f=await reconstructionFixture(t,{providerOverrides:{executeReconstruction:async({claim})=>receipt(claim,{usage:{wallMs:10,tokens:11,costMicros:null,iterations:1}})}});
 const a=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;
 assert.equal(a.status,'UNKNOWN');assert.equal(a.reason,'RECONSTRUCTION_INCOMPLETE');
 await assert.rejects(f.write('reconstruction.dispatch',{planDigest:f.binding.digest}),{code:'RECONSTRUCTION_BUSY'});
});
test('T4-R13 failed usage remains unknown across reopen and prevents resetting cumulative budget',async t=>{
 for(const [status,usage,budget] of [
  ['FAILED',{wallMs:10,tokens:null,costMicros:null,iterations:1},{maxCostMicros:null}],
  ['CANCELLED',{wallMs:10,tokens:11,costMicros:null,iterations:1},{maxCostMicros:100}],
 ]){
  const f=await reconstructionFixture(t,{budget,providerOverrides:{executeReconstruction:async({claim})=>receipt(claim,{status,usage,diagnostic:'Provider stopped without final usage'})}});
  const a=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;assert.equal(a.status,status);assert.deepEqual(a.receipt.usage,usage);
  f.close();f.open();await assert.rejects(f.write('reconstruction.dispatch',{planDigest:f.binding.digest}),{code:'RECONSTRUCTION_BUDGET_UNAVAILABLE'});
  assert.equal((await f.read('reconstruction.list',{planDigest:f.binding.digest})).length,1);
 }
});
test('T4-R14 unknown tokens cannot support success; omitted or malformed cost is not explicit unknown',async t=>{
 const f=await reconstructionFixture(t,{prepare:false});
 for(const value of [undefined,'unknown',-1,NaN])await assert.rejects(f.read('reconstruction.review',{plan:{...f.plan,budget:{...f.plan.budget,maxCostMicros:value}}}));
 const u=await reconstructionFixture(t,{budget:{maxCostMicros:null},providerOverrides:{executeReconstruction:async({claim})=>receipt(claim,{usage:{wallMs:10,tokens:null,costMicros:null,iterations:1}})}});
 assert.equal((await u.write('reconstruction.dispatch',{planDigest:u.binding.digest})).attempt.reason,'RECONSTRUCTION_INCOMPLETE');
});
test('T4-R15 failed cleanup duration is retained without truncation and cannot reset the wall budget',async t=>{
 const usage={wallMs:600019,tokens:11,costMicros:null,iterations:1};
 const f=await reconstructionFixture(t,{budget:{maxCostMicros:null},providerOverrides:{executeReconstruction:async({claim})=>receipt(claim,{status:'FAILED',usage,diagnostic:'Deadline exceeded during cleanup'})}});
 const a=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;assert.equal(a.status,'FAILED');assert.equal(a.receipt.usage.wallMs,600019);
 f.close();f.open();await assert.rejects(f.write('reconstruction.dispatch',{planDigest:f.binding.digest}),{code:'RECONSTRUCTION_BUDGET'});
 const g=await reconstructionFixture(t,{budget:{maxCostMicros:null},providerOverrides:{executeReconstruction:async({claim})=>receipt(claim,{usage})}});
 assert.equal((await g.write('reconstruction.dispatch',{planDigest:g.binding.digest})).attempt.reason,'RECONSTRUCTION_INCOMPLETE');
});
test('T4-R16 Runtime seals execution identity from its retained claim and refuses observer-supplied replacements',async t=>{
 const f=await reconstructionFixture(t),a=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;
 const o=await f.read('reconstruction.evidence',{id:a.id});assert.deepEqual(o.execution,{planDigest:a.claim.planDigest,claimId:a.claim.claimId,cleanWorkspaceId:a.receipt.workspaceId,receiptDigest:a.receipt.digest});
 const {digest,...body}=o;assert.equal(digest,hash(body));f.close();
 f.providers.observeReconstruction=async({claim,receipt:r})=>{const {digest,...base}=observation(claim,r),forged={...base,execution:{...o.execution,cleanWorkspaceId:'forged'}};return {...forged,digest:hash(forged)};};f.open();
 await assert.rejects(f.read('reconstruction.evidence',{id:a.id}),{code:'RECONSTRUCTION_OBSERVATION_BINDING'});
});


test('T4-R17 reviewed cumulative wall limit admits 60 minutes and rejects unbounded values',async t=>{
 const f=await reconstructionFixture(t,{prepare:false});
 for(const wallMs of [1,600000,1800000,1800001,3600000])assert.equal((await f.read('reconstruction.review',{plan:{...f.plan,budget:{...f.plan.budget,wallMs}}})).plan.budget.wallMs,wallMs);
 for(const wallMs of [0,3600001,-1,1.5,Number.MAX_SAFE_INTEGER])await assert.rejects(f.read('reconstruction.review',{plan:{...f.plan,budget:{...f.plan.budget,wallMs}}}),{code:'RECONSTRUCTION_BUDGET'});
 assert.equal(f.calls,0);
});
