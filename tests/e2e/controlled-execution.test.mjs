import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {reconstructionFixture,receipt,observation,hash} from '../fixtures/reconstruction.mjs';
const policy=()=>({schema:'evopilot-execution-policy/v1',externalNetwork:'DENY',internalTransport:'OWNED_LOOPBACK',childProcesses:'BROKERED_OWNED',originalSource:'DENY',hiddenOracle:'DENY',priorOutputs:'DENY',hostCredentials:'DENY',brokerDigest:hash('synthetic-broker'),dependencyManifestDigest:hash('synthetic-dependencies')});
const evidence=p=>({policy:p,policyDigest:hash(p),enforcementDigest:hash('synthetic-enforcement'),externalConnections:0,unrelatedPeerConnections:0,allOwnedProcessesClosed:true});
const v2receipt=(claim,overrides={})=>receipt(claim,{schema:'evopilot-reconstruction-receipt/v2',networkDenied:false,authority:evidence(claim.plan.authority),...overrides});
function v2observation(claim,r){const {digest,...body}=observation(claim,r);body.schema='evopilot-reconstruction-observation/v2';body.authority=r.authority;return{...body,digest:hash(body)};}
async function fixture(t,{override=()=>({}),lose=false}={}){let executions=0;const receipts=new Map();const f=await reconstructionFixture(t,{prepare:false,providerOverrides:{executeReconstruction:async({claim})=>{executions++;const r=v2receipt(claim,override(claim));receipts.set(claim.claimId,r);if(lose)throw Error('synthetic-response-loss');return r;},inspectReconstruction:async({claim})=>receipts.get(claim.claimId),observeReconstruction:async({claim,receipt:r})=>v2observation(claim,r)}});const plan={...f.plan,schema:'evopilot-reconstruction-plan/v2',authority:policy()},binding=await f.freeze(plan);return{...f,plan,binding,executions:()=>executions,receipts};}
test('CE-R01 v2 permits only explicitly bound internal authority and seals its evidence across restart',async t=>{
 const f=await fixture(t),a=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;assert.equal(a.status,'SUCCEEDED');assert.equal(a.receipt.networkDenied,false);
 const o=await f.read('reconstruction.evidence',{id:a.id});assert.equal(o.schema,'evopilot-reconstruction-observation/v2');assert.deepEqual(o.authority,a.receipt.authority);assert.equal(o.execution.receiptDigest,a.receipt.digest);assert.equal(o.isolated,true);assert.equal(o.origin,'SYNTHETIC');
 f.close();const db=new DatabaseSync(path.join(f.options.workspaceRoot,'state/runtime/runtime.db'),{readOnly:true});try{assert.equal(db.prepare('PRAGMA user_version').get().user_version,8)}finally{db.close()}f.open();assert.deepEqual((await f.read('reconstruction.attempt',{id:a.id})).receipt,a.receipt);
});
test('CE-R02 false offline claims, unauthorized connections and incomplete cleanup stay UNKNOWN',async t=>{
 for(const override of [()=>({networkDenied:true}),c=>({authority:{...evidence(c.plan.authority),externalConnections:1}}),c=>({authority:{...evidence(c.plan.authority),unrelatedPeerConnections:1}}),c=>({authority:{...evidence(c.plan.authority),allOwnedProcessesClosed:false}}),c=>({authority:evidence({...c.plan.authority,brokerDigest:hash('different')})})]){
  const f=await fixture(t,{override}),a=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;assert.equal(a.status,'UNKNOWN');assert(['RECONSTRUCTION_ISOLATION','RECONSTRUCTION_AUTHORITY_BINDING'].includes(a.reason));await assert.rejects(f.read('reconstruction.evidence',{id:a.id}));
 }
});
test('CE-R03 v1 cannot smuggle authority and still rejects any successful network-enabled receipt',async t=>{
 const f=await reconstructionFixture(t,{prepare:false});await assert.rejects(f.read('reconstruction.review',{plan:{...f.plan,authority:policy()}}));
 for(const authority of [{...policy(),externalNetwork:'ALLOW'},{...policy(),childProcesses:'DENY'}])await assert.rejects(f.read('reconstruction.review',{plan:{...f.plan,schema:'evopilot-reconstruction-plan/v2',authority}}));
 const g=await reconstructionFixture(t,{providerOverrides:{executeReconstruction:async({claim})=>receipt(claim,{networkDenied:false})}});const a=(await g.write('reconstruction.dispatch',{planDigest:g.binding.digest})).attempt;assert.equal(a.status,'UNKNOWN');assert.equal(a.reason,'RECONSTRUCTION_ISOLATION');
});
test('CE-R04 lost v2 response reconciles original claim without another execution',async t=>{
 const f=await fixture(t,{lose:true}),a=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;assert.equal(a.status,'UNKNOWN');f.close();f.open();const r=(await f.write('reconstruction.reconcile',{id:a.id})).attempt;assert.equal(r.status,'SUCCEEDED');assert.equal(r.claim.claimId,a.claim.claimId);assert.equal(f.executions(),1);
 f.receipts.set(r.claim.claimId,v2receipt(r.claim,{authority:{...r.receipt.authority,enforcementDigest:hash('modified-journal')}}));await assert.rejects(f.read('reconstruction.evidence',{id:r.id}),{code:'RECONSTRUCTION_RECEIPT_DRIFT'});
});

import fs from 'node:fs';import {homedir} from 'node:os';
import {inspectWorkspaceSnapshot,relocateWorkspaceSnapshot} from '@evopilot-next/runtime/workspace-migration';
import {createRuntimeService} from '@evopilot-next/runtime/service';

test('CE-M01 marker 8 relocation preserves exact authority evidence and all owner records',async t=>{
 const f=await fixture(t),a=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;const expected=await f.read('reconstruction.attempt',{id:a.id});
 f.close();const before=inspectWorkspaceSnapshot(f.options),destinationRoot=path.join(f.root,'relocated');
 fs.cpSync(f.options.workspaceRoot,destinationRoot,{recursive:true,preserveTimestamps:true});
 const privateCopy=p=>{const stat=fs.lstatSync(p);assert(!stat.isSymbolicLink());fs.chmodSync(p,stat.isDirectory()?0o700:0o600);if(stat.isDirectory())for(const child of fs.readdirSync(p))privateCopy(path.join(p,child));};privateCopy(destinationRoot);
 const relocation=relocateWorkspaceSnapshot({sourceRoot:f.options.workspaceRoot,destinationRoot,workspaceId:f.options.workspaceId,expectedSnapshotDigest:before.snapshotDigest});
 t.after(()=>{for(const id of relocation.requiredKeyIds)fs.rmSync(path.join(homedir(),'.local/share/evopilot/relocation-keys',id+'.key'),{force:true})});
 assert.equal(relocation.snapshot.recordsDigest,before.recordsDigest);assert.equal(relocation.snapshot.blobsDigest,before.blobsDigest);assert.deepEqual(inspectWorkspaceSnapshot(f.options),before);
 const service=createRuntimeService({...f.options,workspaceRoot:destinationRoot},f.providers);service.initialize();
 try{assert.deepEqual(await service.reconstruction({operation:'reconstruction.attempt',scope:f.scope,input:{id:a.id}}),expected)}finally{service.close()}
 const db=new DatabaseSync(path.join(destinationRoot,'state/runtime/runtime.db'),{readOnly:true});try{assert.equal(db.prepare('PRAGMA user_version').get().user_version,8)}finally{db.close()}
 assert.equal(relocateWorkspaceSnapshot({sourceRoot:f.options.workspaceRoot,destinationRoot,workspaceId:f.options.workspaceId,expectedSnapshotDigest:before.snapshotDigest}).relocationDigest,relocation.relocationDigest);
});
