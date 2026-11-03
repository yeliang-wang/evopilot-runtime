import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeSha256 as hash,NATIVE_CONTRACT_DIGEST} from '../../vendor/compatibility/v1/native.mjs';
import {createLegacyResponseProviders} from '../../dist/compat/response-providers.js';
import {createLocalCollector} from '../../dist/compat/collection/local.js';
import {nativeBytesDigest} from '../../vendor/compatibility/v1/native.mjs';
import {ServiceError} from '../../dist/server/errors.js';

function fixture(t){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'runtime-response-providers-')),workspaceId='synthetic-response',scope={visibility:'private',projectId:'synthetic'},actor={id:'operator',projects:[scope.projectId],permissions:['read','decision.record'],revision:1,expiresAt:'2030-01-01T00:00:00Z'},rows=new Map(),reads=[],controls={active:true,owner:undefined,hook:()=>{}};
 const current=(s=scope)=>{if(!controls.active)throw new ServiceError('AUTHORITY_CHANGED','synthetic revocation');assert.deepEqual(s,scope);return{actor,projectId:scope.projectId,permission:'decision.record'};};
 const context={current,async read(family,r){current(r.scope);assert.equal(family,'native');reads.push(r);await controls.hook();const v=rows.get(r.operation+':'+r.input.id);assert(v,'retained fixture record required');return structuredClone(v);}};
 const owners={harness:{async read(a,p,r){assert.equal(a.id,actor.id);assert.equal(p,scope.projectId);assert.deepEqual(r.scope,scope);reads.push(r);await controls.hook();if(controls.owner instanceof Error)throw controls.owner;return structuredClone(controls.owner);},mutate(){assert.fail('response readers never mutate owner state');}}};
 const providers=createLegacyResponseProviders({workspaceId,workspaceRoot:root,projectRoot:root,owners,current,context});t.after(()=>rmSync(root,{recursive:true,force:true}));
 function collection(id='owned',stage='RUNNING'){
  const claim={claimId:hash(id)},body={schema:'evopilot-collection-receipt/v1',claimId:claim.claimId,result:{endedAt:'2026-01-02T12:00:00Z'}},record={id,workspace:{id:workspaceId},scope,claim,stage,receipt:{...body,digest:hash(body)}};rows.set('collection.inspect:'+id,record);
  const artifactRoot=join(root,'state/runtime-native',claim.claimId.slice(7)),journal=join(artifactRoot,'.collector');mkdirSync(journal,{recursive:true,mode:0o700});writeFileSync(join(journal,'request.json'),JSON.stringify({schema:'evopilot-collection-worker/v1',artifactRoot,claim,binding:{synthetic:true}}),{mode:0o600});return{record,claim,journal,reference:{owner:'runtime',id:'collection:'+id,digest:record.receipt.digest}};
 }
 return{root,workspaceId,scope,actor,rows,reads,controls,providers,collection};
}
test('response service reads original collection evidence and retains UNKNOWN without selecting a new action',async t=>{
 const f=fixture(t),c=f.collection();const result=await f.providers.readResponseEvidence({scope:f.scope,reference:c.reference});assert.equal(result.status,'UNKNOWN');assert.equal(result.observedAt,1767355200);assert.equal(f.reads.length,1);
 c.record.stage='SUCCEEDED';assert.equal((await f.providers.readResponseEvidence({scope:f.scope,reference:c.reference})).status,'PASS');c.record.receipt.claimId=hash('other');await assert.rejects(()=>f.providers.readResponseEvidence({scope:f.scope,reference:c.reference}),{code:'RESPONSE_EVIDENCE_INTEGRITY'});
});
test('response cancellation only requests the exact owned claim journal and is idempotent',async t=>{
 const f=fixture(t),c=f.collection(),request={scope:f.scope,collectionId:c.record.id,claimId:c.claim.claimId},result=await f.providers.cancelResponseCollection(request);
 assert.deepEqual(result,{requested:true,claimId:c.claim.claimId});assert.equal(readFileSync(join(c.journal,'cancel'),'utf8'),'cancel\n');assert.deepEqual(await f.providers.cancelResponseCollection(request),result);assert.equal(c.record.stage,'RUNNING','journal request never asserts confirmed cancellation');
 c.record.stage='SUCCEEDED';await assert.rejects(()=>f.providers.cancelResponseCollection(request),{code:'RESPONSE_CANCEL_CLAIM'});
});
test('response cancellation rejects unrelated claims, changed journals and revoked invocation before writing',async t=>{
 const f=fixture(t),c=f.collection(),request={scope:f.scope,collectionId:c.record.id,claimId:c.claim.claimId};
 await assert.rejects(()=>f.providers.cancelResponseCollection({...request,claimId:hash('foreign')}),{code:'RESPONSE_CANCEL_CLAIM'});assert(!existsSync(join(c.journal,'cancel')));
 const path=join(c.journal,'request.json'),original=readFileSync(path);writeFileSync(path,JSON.stringify({...JSON.parse(original),claim:{claimId:hash('other')}}));await assert.rejects(()=>f.providers.cancelResponseCollection(request),{code:'RESPONSE_CANCEL_CLAIM'});assert(!existsSync(join(c.journal,'cancel')));writeFileSync(path,original);
 f.controls.hook=()=>{f.controls.active=false;};await assert.rejects(()=>f.providers.cancelResponseCollection(request),{code:'AUTHORITY_CHANGED'});assert(!existsSync(join(c.journal,'cancel')));
});
test('response cancellation never follows a preexisting cancellation symlink or rewrites foreign content',async t=>{
 const f=fixture(t),c=f.collection(),request={scope:f.scope,collectionId:c.record.id,claimId:c.claim.claimId},foreign=join(f.root,'foreign');writeFileSync(foreign,'keep',{mode:0o600});symlinkSync(foreign,join(c.journal,'cancel'));
 await assert.rejects(()=>f.providers.cancelResponseCollection(request));assert.equal(readFileSync(foreign,'utf8'),'keep');rmSync(join(c.journal,'cancel'));writeFileSync(join(c.journal,'cancel'),'other',{mode:0o600});await assert.rejects(()=>f.providers.cancelResponseCollection(request));assert.equal(readFileSync(join(c.journal,'cancel'),'utf8'),'other');
});
test('registered response owner reads preserve exact references and reject scope drift, outages and revocation',async t=>{
 const f=fixture(t),reference={owner:'harness',id:'finding:fixture',digest:hash('finding')},value={workspaceId:f.workspaceId,scope:f.scope,reference,status:'UNKNOWN',observedAt:1};f.controls.owner=value;
 assert.deepEqual(await f.providers.readResponseEvidence({scope:f.scope,reference}),value);assert.equal(f.reads[0].operation,'response.evidence.inspect');
 f.controls.owner={...value,scope:{...f.scope,projectId:'other'}};await assert.rejects(()=>f.providers.readResponseEvidence({scope:f.scope,reference}),{code:'RESPONSE_SCOPE'});
 f.controls.owner={...value,reference:{...reference,id:'different'}};await assert.rejects(()=>f.providers.readResponseEvidence({scope:f.scope,reference}),{code:'RESPONSE_EVIDENCE_DRIFT'});
 f.controls.owner=new ServiceError('SERVICE_UNAVAILABLE','synthetic outage');await assert.rejects(()=>f.providers.readResponseEvidence({scope:f.scope,reference}),{code:'SERVICE_UNAVAILABLE'});
 f.controls.owner=value;f.controls.hook=()=>{f.controls.active=false;};await assert.rejects(()=>f.providers.readResponseEvidence({scope:f.scope,reference}),{code:'AUTHORITY_CHANGED'});
});
test('original online finding reader validates scope and digest without collecting telemetry or approving a repair',async t=>{
 const f=fixture(t),policy={product:'harness',id:'synthetic-policy',version:'1.0.0',specVersion:'v1',visibility:'private',digest:hash('policy'),standardDigest:hash('standard'),standardLockDigest:hash('lock'),producer:{product:'harness',version:'0.3.0'},contractDigest:NATIVE_CONTRACT_DIGEST};
 const body={schema:'evopilot-online-finding/v1',id:hash('finding'),workspaceId:f.workspaceId,scope:f.scope,bindingId:'binding',bindingDigest:hash('binding'),serviceId:'service',environment:'test',deploymentRevision:'r1',policy,incidentId:hash('incident'),source:'evaluation',state:'FIRING',at:1767355200,evidenceDigest:hash('evidence'),causeId:hash('cause'),candidate:{kind:'regression',status:'REVIEW_REQUIRED'}};
 f.controls.owner={...body,digest:hash(body)};assert.equal((await f.providers.readOnlineFinding({scope:f.scope,id:body.id})).candidate.status,'REVIEW_REQUIRED');assert.equal(f.reads[0].operation,'online.finding.inspect');
 f.controls.owner.digest=hash('changed');await assert.rejects(()=>f.providers.readOnlineFinding({scope:f.scope,id:body.id}));
});

test('response journal cancellation terminates one real isolated collector and retains its only result',async t=>{
 const f=fixture(t),cwd=join(f.root,'source');mkdirSync(cwd,{mode:0o700});writeFileSync(join(cwd,'fixed.txt'),'fixed');
 const executable=realpathSync(process.execPath),tool={path:executable,sha256:nativeBytesDigest(readFileSync(executable)).slice(7)},sourceScope={direction:'forward',locator:cwd,revision:'synthetic',treeDigest:hash('tree'),inventoryDigest:hash('inventory'),requirementsDigest:hash('requirements')};
 const recipe={schema:'evopilot-collection-recipe/v1',sourceScope,executable,executableDigest:'sha256:'+tool.sha256,argv:['-e','require("fs").appendFileSync("attempts.txt","one\\n");console.log("started");setInterval(()=>{},1000)'],cwd,environment:{LANG:'C'},toolchainLockDigest:hash([tool]),timeoutMs:5000,maxOutputBytes:4096,allowedOutputs:['stdout.txt','stderr.txt'],network:{mode:'none',hosts:[]},selectors:[]};
 const claim={schema:'evopilot-collection-claim/v1',id:'running',claimId:hash('real-cancel'),idempotencyKey:'running',workspace:{schema:'evopilot-workspace/v1',id:f.workspaceId,canonicalRoot:f.root},scope:f.scope,projectCandidateDigest:hash('candidate'),recipe,recipeDigest:hash(recipe),decision:{reviewDigest:hash(recipe),decision:'APPROVE',humanEvidenceRef:'synthetic-only',uid:process.getuid(),at:new Date().toISOString()},attemptCount:1};
 const artifactRoot=join(f.root,'state/runtime-native',claim.claimId.slice(7));mkdirSync(artifactRoot,{recursive:true,mode:0o700});f.rows.set('collection.inspect:running',{id:'running',workspace:claim.workspace,scope:f.scope,claim,stage:'RUNNING',receipt:null});
 const binding={cwd,sourceFiles:[{path:'fixed.txt',sha256:nativeBytesDigest('fixed').slice(7)}],toolchainLockDigest:recipe.toolchainLockDigest,toolFiles:[tool],readRoots:[]},collector=createLocalCollector({resolveExecution:()=>binding}),context={claim,artifactRoot,signal:AbortSignal.timeout(10000)},pending=collector.collect(context);
 const deadline=Date.now()+4000;while(!existsSync(join(cwd,'attempts.txt'))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert(existsSync(join(cwd,'attempts.txt')));
 const request=await f.providers.cancelResponseCollection({scope:f.scope,collectionId:'running',claimId:claim.claimId});assert.equal(request.requested,true);assert.equal(f.rows.get('collection.inspect:running').stage,'RUNNING');
 const result=await pending;assert.equal(result.interrupted,true);assert.equal(result.signal,'SIGKILL');assert.equal(result.timedOut,false);assert.equal(readFileSync(join(cwd,'attempts.txt'),'utf8'),'one\n');assert.deepEqual(await collector.inspectCollection(context),result);await assert.rejects(()=>collector.collect(context),{code:'COLLECTION_ALREADY_ATTEMPTED'});
});
