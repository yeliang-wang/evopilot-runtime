import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {providerFixture} from '../fixtures/legacy-provider-v090.mjs';
import {readLegacyProviderConfiguration,openRegisteredLegacyProviders} from '../../dist/compat/registered-providers.js';
import {createLegacyFeedbackProviders} from '../../dist/compat/native-providers.js';
import {createLegacyOwnerProviders} from '../../dist/host/legacy-owner-providers.js';
import {ServiceError} from '../../dist/server/errors.js';
import {nativeSha256 as hash,NATIVE_CONTRACT_DIGEST} from '../../vendor/compatibility/v1/native.mjs';

test('registered provider factory has no ambient actor and reads exact original Runtime evidence through one gateway',async t=>{
 const f=await providerFixture(t);assert.throws(()=>f.context.current(),{code:'LEGACY_CONTEXT_REQUIRED'});await assert.rejects(()=>f.context.read('native',{operation:'workspace.inspect',scope:f.scope,input:{}}),{code:'LEGACY_CONTEXT_REQUIRED'});
 const r=await f.send(f.prepare);assert.equal(r.result.result.sourceScope.treeDigest,f.prepare.input.sourceScope.treeDigest);assert.equal(f.calls(),1);assert.deepEqual((await f.send(f.prepare)).result,r.result);assert.equal(f.calls(),1,'exact replay does not call a provider again');
 assert.throws(()=>f.context.current(),{code:'LEGACY_CONTEXT_REQUIRED'});
});

function feedbackFixture(){
 const scope={visibility:'private',projectId:'synthetic'},workspaceId='fixture',claimId=hash('original-claim');
 const pin=owner=>({product:owner,id:'synthetic-'+owner,version:'1.0.0',specVersion:'v1',visibility:'private',digest:hash({owner,asset:true}),standardDigest:hash({owner,standard:true}),standardLockDigest:hash({owner,lock:true}),producer:{product:owner,version:'0.3.0'},contractDigest:NATIVE_CONTRACT_DIGEST});
 const body={schema:'evopilot-feedback-event/v1',id:hash({workspaceId,scope,claimId}),workspaceId,scope,projectId:'native-candidate',projectCandidateDigest:hash('candidate'),source:{direction:'forward',locator:'synthetic:feedback',revision:'r1',treeDigest:hash('tree'),inventoryDigest:hash('inventory'),requirementsDigest:hash('requirements')},runId:'original-run',runReviewDigest:hash('review'),claimId,inputDigest:hash('input'),receiptDigest:hash('receipt'),causeId:claimId,origin:'registered-runtime-run',stage:'SUCCEEDED',pins:{ontology:pin('ontology'),harness:pin('harness')},results:{ontology:{synthetic:true},harness:{synthetic:true}},collectionRefs:[],observation:{synthetic:true}},event={...body,digest:hash(body)};
 const actor={id:'operator',projects:['synthetic'],permissions:['read','execution.request'],revision:1,expiresAt:'2030-01-01T00:00:00Z'},inboxes=new Map(),calls=[],controls={revoked:false,unavailable:false,loss:false,inspect:()=>{}};
 function current(selected=scope){if(controls.revoked)throw new ServiceError('AUTHORITY_CHANGED','synthetic revocation');assert.deepEqual(selected,scope);return{actor,projectId:scope.projectId,permission:'execution.request'};}
 const context={current,async read(family,request){assert.equal(family,'feedback');assert.equal(request.operation,'feedback.event');assert.deepEqual(request.scope,scope);assert.equal(request.input.id,event.id);return event;}};
 const owners=Object.fromEntries(['ontology','harness'].map(owner=>[owner,{async read(a,projectId,request){assert.equal(a.id,actor.id);assert.equal(projectId,scope.projectId);assert.deepEqual(request.scope,scope);if(controls.unavailable)throw new ServiceError('SERVICE_UNAVAILABLE','synthetic outage');if(request.operation==='feedback.inspect'){await controls.inspect();return{owner,workspaceId,scope,revision:0};}assert.equal(request.operation,'feedback.read');const inbox=inboxes.get(owner);if(!inbox)throw new ServiceError('NOT_FOUND','synthetic empty inbox');return inbox;},async mutate(a,projectId,request,permit){calls.push({owner,request,permit});const r={eventId:event.id,eventDigest:event.digest,owner,workspaceId,scope,candidateId:event.id+':'+owner};inboxes.set(owner,{event,receipt:{...r,digest:hash(r)},candidate:{id:r.candidateId,kind:owner==='ontology'?'semantic-impact':'regression',evidenceDigest:event.receiptDigest,status:'REVIEW_REQUIRED'},review:null,disposition:null});if(controls.loss)throw new ServiceError('OWNER_OUTCOME_UNKNOWN','synthetic response loss');return inboxes.get(owner).receipt;}}]));
 const providers=createLegacyFeedbackProviders({workspaceId,expiresAt:'2030-01-01T00:00:00Z',owners,current,context});return{scope,workspaceId,event,actor,owners,context,providers,inboxes,calls,controls};
}
test('original feedback binds project scope separately from native candidate and reuses retained owner inbox',async()=>{
 const f=feedbackFixture();assert.notEqual(f.event.projectId,f.scope.projectId);
 for(const owner of ['ontology','harness']){const first=await f.providers.deliverFeedback({owner,event:f.event});assert.equal(first.candidate.status,'REVIEW_REQUIRED');assert.equal(first.disposition,null);assert.deepEqual(await f.providers.deliverFeedback({owner,event:f.event}),first);}
 assert.equal(f.calls.length,2);for(const call of f.calls){assert.equal(call.request.requestId,'feedback-'+f.event.id.slice(7,55));assert.deepEqual(call.request.input,{id:f.event.id,digest:f.event.digest});assert.equal(call.permit.projectId,f.scope.projectId);assert(call.permit.authorityRef.startsWith('legacy-feedback:'));}
});
test('lost original feedback response reads its retained receipt and never dispatches another owner mutation',async()=>{
 const f=feedbackFixture();f.controls.loss=true;await assert.rejects(()=>f.providers.deliverFeedback({owner:'ontology',event:f.event}),{code:'OWNER_OUTCOME_UNKNOWN'});
 assert.equal((await f.providers.readFeedbackInbox({owner:'ontology',scope:f.scope,id:f.event.id})).event.id,f.event.id);await f.providers.deliverFeedback({owner:'ontology',event:f.event});assert.equal(f.calls.length,1);
});
test('feedback rejects a changed event, owner receipt or current authority without inventing success',async()=>{
 const f=feedbackFixture();await assert.rejects(()=>f.providers.deliverFeedback({owner:'ontology',event:{...f.event,projectId:'other-candidate'}}),{code:'LEGACY_FEEDBACK_CHANGED'});assert.equal(f.calls.length,0);
 f.controls.inspect=()=>{f.controls.revoked=true;};await assert.rejects(()=>f.providers.deliverFeedback({owner:'ontology',event:f.event}),{code:'AUTHORITY_CHANGED'});assert.equal(f.calls.length,0);
 f.controls.revoked=false;f.controls.inspect=()=>{};await f.providers.deliverFeedback({owner:'ontology',event:f.event});f.inboxes.get('ontology').receipt.owner='harness';await assert.rejects(()=>f.providers.readFeedbackInbox({owner:'ontology',scope:f.scope,id:f.event.id}));assert.equal(f.calls.length,1);
});
test('unavailable owner feedback is never treated as an empty inbox or permission to dispatch',async()=>{
 const f=feedbackFixture();f.controls.unavailable=true;await assert.rejects(()=>f.providers.deliverFeedback({owner:'ontology',event:f.event}),{code:'SERVICE_UNAVAILABLE'});assert.equal(f.calls.length,0);
 f.controls.unavailable=false;f.controls.inspect=()=>{f.actor.permissions=['read'];};await assert.rejects(()=>f.providers.deliverFeedback({owner:'ontology',event:f.event}));assert.equal(f.calls.length,0);
});
test('historical owner Host reads exact feedback for a distinct native candidate and retains project isolation',async()=>{
 const f=feedbackFixture();let returned=f.event;const requests=[],client={connection:{projectId:f.scope.projectId},request:async request=>{requests.push(request);return{result:returned};}};
 const providers=createLegacyOwnerProviders({workspaceId:f.workspaceId,projectId:f.scope.projectId,client,guard:()=>({scope:f.scope}),readOwner:async()=>{throw Error('unused');}},'ontology');
 assert.deepEqual(await providers.readFeedback({scope:f.scope,id:f.event.id}),f.event);assert.equal(requests[0].operation,'runtime.legacy.read');assert.equal(requests[0].input.family,'feedback');
 await assert.rejects(()=>providers.readFeedback({scope:{...f.scope,projectId:'other'},id:f.event.id}),{code:'OWNER_HOST_SCOPE'});
 const body={...f.event,scope:{...f.scope,projectId:'other'}};delete body.digest;returned={...body,digest:hash(body)};await assert.rejects(()=>providers.readFeedback({scope:f.scope,id:f.event.id}));
});
test('original providers cannot use their internal read callback for writes or another project',async t=>{
 const f=await providerFixture(t);f.setHook(async c=>{
  await assert.rejects(()=>c.read('native',{operation:'project.prepare',scope:f.scope,input:{}}),{code:'LEGACY_PROVIDER_READ'});
  await assert.rejects(()=>c.read('native',{operation:'workspace.inspect',scope:{...f.scope,projectId:'other'},input:{}}),{code:'LEGACY_SCOPE'});
  assert.equal(c.current().permission,'draft.write');assert.equal(c.current().actor.id,'editor');
 });assert.equal((await f.send(f.prepare)).result.result.id,'prepared');
});
test('principal revision changed during awaited provider work prevents original completion and leaves no native project',async t=>{
 const f=await providerFixture(t),file=join(f.serviceRoot,'auth.json');f.setHook(async()=>{const data=JSON.parse(readFileSync(file));data.principals[0].revision++;writeFileSync(file,JSON.stringify(data),{mode:0o600});});
 await assert.rejects(()=>f.send(f.prepare),{code:'AUTHORITY_CHANGED'});
 await assert.rejects(()=>f.send({operation:'project.inspect',scope:f.scope,input:{id:'prepared'}}),{code:'NOT_FOUND'});
 assert.equal((await f.send({operation:'workspace.inspect',scope:f.scope,input:{}})).result.revision,0);
});
test('protected provider selection rejects missing migration binding, expired scope, caller programs and unknown fields before owner loading',async t=>{
 const f=await providerFixture(t),ownersRoot=join(f.root,'owners');mkdirSync(ownersRoot,{mode:0o700});const ref=join(f.root,'providers.json'),value={schema:'runtime-legacy-providers/v1',workspaceId:f.workspaceId,projects:['synthetic'],legacyBindingRef:f.bindingRef,projectRoot:f.projectRoot,expiresAt:'2030-01-01T00:00:00Z',owners:{ontology:{packageRoot:ownersRoot},harness:{packageRoot:ownersRoot}},nativeToolchain:{path:'/unused',digest:'unused',lockDigest:'unused'}};
 const put=v=>writeFileSync(ref,JSON.stringify(v),{mode:0o600});put(value);assert.deepEqual(readLegacyProviderConfiguration(ref),value);
 await assert.rejects(()=>openRegisteredLegacyProviders(ref,f.bindingRef,f.workspaceId,'0'.repeat(64)),{code:'LEGACY_PROVIDER_CHANGED'});
 await assert.rejects(()=>openRegisteredLegacyProviders(ref,f.bindingRef,'other'),{code:'LEGACY_PROVIDER_SCOPE'});
 for(const mutation of [v=>v.projects=['*'],v=>v.expiresAt='2000-01-01T00:00:00Z',v=>v.program='/bin/sh',v=>v.collection={kind:'shell',executable:'/bin/sh',sha256:'a'.repeat(64)}]){const changed=structuredClone(value);mutation(changed);put(changed);assert.throws(()=>readLegacyProviderConfiguration(ref));}
});
