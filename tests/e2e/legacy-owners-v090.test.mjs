import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,writeFileSync,mkdirSync,rmSync,existsSync,chmodSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openLegacyOwnerRoutes} from '../../dist/host/legacy-owners.js';
import {createLegacyTools} from '../../dist/host/legacy-tools.js';
import {createLegacyOwnerProviders} from '../../dist/host/legacy-owner-providers.js';
import {ServiceError} from '../../dist/server/errors.js';
import {syntheticReadinessMaterial} from '../fixtures/adapters-v090.mjs';
import {nativeSha256} from '../../vendor/compatibility/v1/native.mjs';

const scope={projectId:'alpha',visibility:'private'},connection={workspaceId:'fixture',projectId:'alpha',serviceId:'fixture-service',version:'0.8.3'},migrationDigest='a'.repeat(64);
function syntheticClient(){const requests=[];return{requests,connection,status:async()=>({requestId:'status',result:{...connection,legacy:{bound:true,migrationDigest}}}),async request(v){requests.push(structuredClone(v));return{requestId:'synthetic-transport',result:{original:'runtime-response',envelope:v}};}};}
const unwrap=v=>JSON.parse(v.content[0].text);
test('optional owner delegation preserves exact envelope and sends no owner mutation to Runtime HTTP',async()=>{
 const client=syntheticClient(),ownerCalls=[],owners={capabilities:()=>({origin:'synthetic-owner-test'}),async call(...args){ownerCalls.push(args);return{requestId:args[2].requestId,revision:19,synthetic:true};},async close(){}};
 const tools=createLegacyTools(client,owners),input={owner:'harness',envelope:{operation:'native.package.validate',scope,input:{id:'fixture',version:'1.0.0'},requestId:'original-owner-request',expectedRevision:18}};
 assert.equal(unwrap(await tools.call('evopilot_v01_native',input)).error.code,'SESSION_INACTIVE');assert.equal(ownerCalls.length,0);
 await tools.call('evopilot_v01_activate',{});const reply=unwrap(await tools.call('evopilot_v01_native',input));assert.equal(reply.result.requestId,input.envelope.requestId);assert.equal(reply.result.revision,19);assert.equal(reply.delegation.owner,'harness');assert.equal(reply.delegation.runtimeHttpAuthoring,false);assert.equal(client.requests.length,0);assert.deepEqual(ownerCalls[0].slice(0,3),['harness','native',input.envelope]);
 await tools.call('evopilot_v01_request',{owner:'runtime',envelope:{operation:'project.list',scope,input:{}}});assert.equal(client.requests.length,1);assert.equal(client.requests[0].operation,'runtime.legacy.read');
 const caps=unwrap(await tools.call('evopilot_v01_capabilities',{}));assert.deepEqual(caps.result.ownerEntries,{origin:'synthetic-owner-test'});
 await tools.call('evopilot_v01_deactivate',{});assert.equal(unwrap(await tools.call('evopilot_v01_native',input)).error.code,'SESSION_INACTIVE');assert.equal(ownerCalls.length,1);
});
test('unconfigured owner calls are explicit and unknown outcomes never retry an owner mutation',async()=>{
 const client=syntheticClient(),plain=createLegacyTools(client);await plain.call('evopilot_v01_activate',{});
 const input={owner:'ontology',envelope:{operation:'native.package.put',scope,input:{},requestId:'original',expectedRevision:4}};
 assert.equal(unwrap(await plain.call('evopilot_v01_native',input)).error.code,'OWNER_ENTRY_REQUIRED');
 assert.deepEqual(plain.definitions.find(v=>v.name==='evopilot_v01_native').inputSchema.properties.owner.enum,['runtime']);
 let count=0;const tools=createLegacyTools(client,{capabilities:()=>({}),async call(){count++;throw new ServiceError('OWNER_CALL_OUTCOME_UNKNOWN','Inspect original');},async close(){}});await tools.call('evopilot_v01_activate',{});
 assert.equal(unwrap(await tools.call('evopilot_v01_native',input)).error.code,'OWNER_CALL_OUTCOME_UNKNOWN');assert.equal(count,1);assert.equal(client.requests.length,0);
});
function fixture(){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'runtime-owner-host-')),ref=join(root,'host.json'),bindingRef=join(root,'binding.json'),packageRoot=join(root,'untrusted-package');mkdirSync(packageRoot,{mode:0o700});
 const binding={workspaceRoot:join(root,'workspace'),workspaceId:'fixture',serviceId:'fixture-service',migrationDigest};writeFileSync(bindingRef,JSON.stringify(binding),{mode:0o600});
 const config={schema:'runtime-legacy-owner-host/v1',workspaceId:'fixture',projectId:'alpha',legacyBindingRef:bindingRef,expiresAt:'2030-01-01T00:00:00Z',owners:Object.fromEntries(['ontology','harness'].map(owner=>[owner,{packageRoot,calls:['request:workspace.inspect','native:standard.inspect']}]))};
 const save=value=>writeFileSync(ref,JSON.stringify(value??config),{mode:0o600});save();return{root,ref,config,bindingRef,packageRoot,save,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('Host owner configuration fails closed before imports on scope, expiry, wildcard and unknown fields',async()=>{
 const f=fixture(),client=syntheticClient();try{
  for(const [change,code] of [[c=>c.projectId='other','OWNER_HOST_SCOPE'],[c=>c.workspaceId='other','OWNER_HOST_SCOPE'],[c=>c.expiresAt='2000-01-01T00:00:00Z','OWNER_HOST_EXPIRED'],[c=>c.owners.ontology.calls=['native:*'],'OWNER_HOST_CONFIGURATION'],[c=>c.owners.ontology.calls=['request:workspace.inspect','request:workspace.inspect'],'OWNER_HOST_CONFIGURATION'],[c=>c.ownerApprove=true,'INVALID_FIELDS'],[c=>c.owners.harness.module='/tmp/arbitrary.js','INVALID_FIELDS']]){const config=structuredClone(f.config);change(config);f.save(config);await assert.rejects(()=>openLegacyOwnerRoutes(f.ref,client),{code});}
  f.save();writeFileSync(f.bindingRef,JSON.stringify({workspaceRoot:'unused',workspaceId:'fixture',serviceId:'other',migrationDigest}));await assert.rejects(()=>openLegacyOwnerRoutes(f.ref,client),{code:'OWNER_HOST_SCOPE'});
  chmodSync(f.ref,0o644);await assert.rejects(()=>openLegacyOwnerRoutes(f.ref,client),{code:'UNSAFE_STATE'});chmodSync(f.ref,0o600);
  const alias=join(f.root,'link.json');symlinkSync(f.ref,alias);await assert.rejects(()=>openLegacyOwnerRoutes(alias,client),{code:'OWNER_HOST_CONFIGURATION'});
 }finally{f.cleanup();}
});
test('Host delegation never imports a fake owner or opens another Runtime store to replace disconnected HTTP',async()=>{
 const f=fixture(),client=syntheticClient();try{
  mkdirSync(join(f.packageRoot,'dist'));const marker=join(f.root,'IMPORTED');writeFileSync(join(f.packageRoot,'dist/service.js'),'throw new Error("must never import");');
  await assert.rejects(()=>openLegacyOwnerRoutes(f.ref,client),{code:'OWNER_DISTRIBUTION_CHANGED'});assert(!existsSync(marker));assert(!existsSync(join(f.root,'workspace')));
  client.status=async()=>{throw new ServiceError('SERVICE_UNAVAILABLE','offline');};await assert.rejects(()=>openLegacyOwnerRoutes(f.ref,client),{code:'SERVICE_UNAVAILABLE'});assert(!existsSync(join(f.root,'workspace')));
  client.status=async()=>({result:{...connection,legacy:{bound:true,migrationDigest:'b'.repeat(64)}}});await assert.rejects(()=>openLegacyOwnerRoutes(f.ref,client),{code:'OWNER_HOST_SCOPE'});
 }finally{f.cleanup();}
});
test('readiness provider reads original intent through Runtime HTTP and checks scope, digest and currentness shape',async()=>{
 const material=syntheticReadinessMaterial('fixture','alpha'),definition=material.definition,digest=nativeSha256(definition),client=syntheticClient();
 let value={definition,digest,current:true,authority:false};client.request=async request=>{client.requests.push(request);return{result:value};};
 let revoked=false;const providers=createLegacyOwnerProviders({workspaceId:'fixture',projectId:'alpha',client,guard:()=>{if(revoked)throw new ServiceError('OWNER_HOST_CHANGED','revoked');return{scope};},readOwner:async()=>{throw new Error('not used');}});
 assert.deepEqual(await providers.readReadinessIntent({workspaceId:'fixture',scope,digest}),value);assert.equal(client.requests.length,1);assert.equal(client.requests[0].operation,'runtime.legacy.read');assert.equal(client.requests[0].input.family,'readiness');assert.equal(client.requests[0].input.envelope.operation,'readiness.intent.read');
 await assert.rejects(()=>providers.readReadinessIntent({workspaceId:'other',scope,digest}),{code:'OWNER_HOST_SCOPE'});
 value={...value,digest:'sha256:'+'f'.repeat(64)};await assert.rejects(()=>providers.readReadinessIntent({workspaceId:'fixture',scope,digest}),{code:'OWNER_REFERENCE_CHANGED'});
 value={definition,digest,current:false,authority:false};assert.equal((await providers.readReadinessIntent({workspaceId:'fixture',scope,digest})).current,false,'stale intent remains stale for the published owner to evaluate');
 revoked=true;await assert.rejects(()=>providers.readReadinessIntent({workspaceId:'fixture',scope,digest}),{code:'OWNER_HOST_CHANGED'});
});
test('provider readback rechecks revocation after asynchronous Runtime reads and keeps recovery reference identity',async()=>{
 const client=syntheticClient();let active=true;const reference={owner:'runtime',id:'response:original',digest:'sha256:'+'a'.repeat(64)};
 const providers=createLegacyOwnerProviders({workspaceId:'fixture',projectId:'alpha',client,guard:()=>{if(!active)throw new ServiceError('OWNER_HOST_CHANGED','revoked');return{scope};},readOwner:async()=>({reference:{...reference,owner:'harness'}})});
 client.request=async()=>{active=false;return{result:{reference}};};await assert.rejects(()=>providers.readResponseExecution({scope,reference}),{code:'OWNER_HOST_CHANGED'});
 active=true;client.request=async()=>({result:{reference:{...reference,id:'response:other'}}});await assert.rejects(()=>providers.readResponseExecution({scope,reference}),{code:'OWNER_REFERENCE_CHANGED'});
 await assert.rejects(()=>providers.readResponseExecution({scope,reference:{...reference,owner:'harness'}}),{code:'OWNER_REFERENCE_CHANGED'});
});
test('Ontology Host supplies only its exact published provider descriptors, without Harness callbacks or an LLM',()=>{
 const context={workspaceId:'fixture',projectId:'alpha',client:syntheticClient(),guard:()=>({scope}),readOwner:async()=>({})};
 assert.deepEqual(Object.keys(createLegacyOwnerProviders(context,'ontology')).sort(),['readFeedback','resolveFeedbackMaterial']);
 const harness=createLegacyOwnerProviders(context,'harness');assert.equal(typeof harness.readReadinessIntent,'function');assert.equal(typeof harness.resolveNativeDependency,'function');assert(!Object.hasOwn(harness,'classificationModel'));assert(!Object.hasOwn(harness,'classificationAdvisor'));
});
