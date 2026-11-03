import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {providerFixture} from '../fixtures/legacy-provider-v090.mjs';
import {readLegacyProviderConfiguration,openRegisteredLegacyProviders} from '../../dist/compat/registered-providers.js';

test('registered provider factory has no ambient actor and reads exact original Runtime evidence through one gateway',async t=>{
 const f=await providerFixture(t);assert.throws(()=>f.context.current(),{code:'LEGACY_CONTEXT_REQUIRED'});await assert.rejects(()=>f.context.read('native',{operation:'workspace.inspect',scope:f.scope,input:{}}),{code:'LEGACY_CONTEXT_REQUIRED'});
 const r=await f.send(f.prepare);assert.equal(r.result.result.sourceScope.treeDigest,f.prepare.input.sourceScope.treeDigest);assert.equal(f.calls(),1);assert.deepEqual((await f.send(f.prepare)).result,r.result);assert.equal(f.calls(),1,'exact replay does not call a provider again');
 assert.throws(()=>f.context.current(),{code:'LEGACY_CONTEXT_REQUIRED'});
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
 await assert.rejects(()=>openRegisteredLegacyProviders(ref,f.bindingRef,'other'),{code:'LEGACY_PROVIDER_SCOPE'});
 for(const mutation of [v=>v.projects=['*'],v=>v.expiresAt='2000-01-01T00:00:00Z',v=>v.program='/bin/sh',v=>v.collection={kind:'shell',executable:'/bin/sh',sha256:'a'.repeat(64)}]){const changed=structuredClone(value);mutation(changed);put(changed);assert.throws(()=>readLegacyProviderConfiguration(ref));}
});
