import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,readFileSync,writeFileSync,mkdirSync,rmSync,existsSync,chmodSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openLegacyOwnerRoutes} from '../../dist/host/legacy-owners.js';
import {createLegacyTools} from '../../dist/host/legacy-tools.js';
import {createLegacyOwnerProviders} from '../../dist/host/legacy-owner-providers.js';
import {ServiceError} from '../../dist/server/errors.js';
import {syntheticReadinessMaterial} from '../fixtures/adapters-v090.mjs';
import {nativeSha256,nativeBytesDigest} from '../../vendor/compatibility/v1/native.mjs';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRuntimeService} from '../../dist/service.js';
import {startRuntimeServer} from '../../dist/server/http.js';
import {RuntimeStore} from '../../dist/server/store.js';
import {initializeCredentials,tokenDigest} from '../../dist/server/security.js';
import {inspectLegacyWorkspace,createLegacyBackup,adoptLegacyWorkspace} from '../../dist/installation/migration.js';
import {createRuntimeHttpClient} from '../../dist/host/client.js';
import {syntheticDecisionEvidence} from '../fixtures/native/decision-evidence.mjs';

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

function responseFixture(){
 const client=syntheticClient(),rows=new Map();let active=true,ownerEvidence=null;
 client.request=async request=>{client.requests.push(structuredClone(request));const e=request.input.envelope;assert.equal(request.operation,'runtime.legacy.read');assert.equal(request.input.family,'native');const row=rows.get(e.operation+':'+e.input.id);assert(row,'synthetic original record must exist');return{result:structuredClone(row)};};
 const providers=createLegacyOwnerProviders({workspaceId:'fixture',projectId:'alpha',client,guard:()=>{if(!active)throw new ServiceError('OWNER_HOST_CHANGED','revoked');return{scope};},readOwner:async(owner,envelope)=>{assert.equal(owner,'harness');assert.equal(envelope.operation,'response.evidence.inspect');return structuredClone(ownerEvidence);}});
 function collection(id,stage='SUCCEEDED',endedAt='2026-01-02T12:00:00Z'){
  const claim={claimId:'sha256:'+id.padEnd(64,'0')},body={schema:'evopilot-collection-receipt/v1',claimId:claim.claimId,result:{endedAt}},receipt={...body,digest:nativeSha256(body)};
  const c={id,scope,workspace:{id:'fixture'},claim,receipt,stage};rows.set('collection.inspect:'+id,c);return{owner:'runtime',id:'collection:'+id,digest:receipt.digest};
 }
 function run(id,collections,stage='SUCCEEDED'){
  const r={plan:{id,workspace:{id:'fixture'},scope,input:{collectionReceipts:collections.map(ref=>({id:ref.id.slice(11),digest:ref.digest}))}},claim:{claimId:'synthetic'},receipt:{ownerReceipts:Object.fromEntries(['ontology','harness'].map(owner=>[owner,{executionStatus:'SUCCEEDED',qualityStatus:'PASS'}]))},stage};rows.set('run.inspect:'+id,r);return{owner:'runtime',id:'run:'+id,digest:nativeSha256(r.receipt)};
 }
 return{client,rows,providers,collection,run,revoke:()=>{active=false;},setOwner:v=>{ownerEvidence=v;},read:reference=>providers.readResponseEvidence({scope,reference})};
}
test('response evidence preserves collection PASS, FAIL and UNKNOWN with original receipt time and only read transport',async()=>{
 const f=responseFixture();for(const [stage,status] of [['SUCCEEDED','PASS'],['FAILED','FAIL'],['UNKNOWN','UNKNOWN']]){const reference=f.collection(stage.toLowerCase(),stage);assert.deepEqual(await f.read(reference),{workspaceId:'fixture',scope,reference,status,observedAt:1767355200});}
 assert.equal(f.client.requests.length,3);assert(f.client.requests.every(r=>!Object.hasOwn(r,'requestId')&&!Object.hasOwn(r,'expectedRevision')));
});
test('response collection evidence rejects receipt, claim, time, workspace and reference substitution',async()=>{
 for(const [change,code] of [
  [c=>c.receipt=null,'RESPONSE_EVIDENCE_INCOMPLETE'],[c=>c.claim=null,'RESPONSE_EVIDENCE_INCOMPLETE'],[c=>c.id='other','RESPONSE_EVIDENCE_INCOMPLETE'],[c=>c.workspace.id='other','RESPONSE_EVIDENCE_INCOMPLETE'],[c=>c.scope={...scope,projectId:'other'},'RESPONSE_EVIDENCE_INCOMPLETE'],
  [c=>c.receipt.result.endedAt='2030-01-01','RESPONSE_EVIDENCE_INTEGRITY'],[c=>c.claim.claimId='other','RESPONSE_EVIDENCE_INTEGRITY'],
  [c=>{c.receipt.result.endedAt='invalid';const{digest,...body}=c.receipt;c.receipt.digest=nativeSha256(body);},'RESPONSE_EVIDENCE_TIME'],
 ]){const f=responseFixture(),ref=f.collection('first');change(f.rows.get('collection.inspect:first'));await assert.rejects(()=>f.read(ref),{code});}
 const f=responseFixture(),ref=f.collection('first');await assert.rejects(()=>f.read({...ref,digest:'sha256:'+'f'.repeat(64)}),{code:'RESPONSE_EVIDENCE_DRIFT'});
 await assert.rejects(()=>f.providers.readResponseEvidence({scope:{...scope,projectId:'other'},reference:ref}),{code:'OWNER_HOST_SCOPE'});
});
test('response Run evidence reads every bound collection and keeps the oldest observation and both owner outcomes',async()=>{
 const f=responseFixture(),refs=[f.collection('first','SUCCEEDED','2026-01-02T12:00:00Z'),f.collection('second','SUCCEEDED','2026-01-03T12:00:00Z')],reference=f.run('original',refs),run=f.rows.get('run.inspect:original');
 assert.equal((await f.read(reference)).observedAt,1767355200);assert.equal(f.client.requests.length,3);
 for(const [stage,executionStatus,qualityStatus,status] of [['SUCCEEDED','SUCCEEDED','PASS','PASS'],['UNKNOWN','SUCCEEDED','PASS','UNKNOWN'],['FAILED','SUCCEEDED','PASS','FAIL'],['SUCCEEDED','UNKNOWN','PASS','UNKNOWN'],['SUCCEEDED','SUCCEEDED','FAIL','FAIL'],['SUCCEEDED','SUCCEEDED','INDETERMINATE','UNKNOWN']]){
  run.stage=stage;Object.assign(run.receipt.ownerReceipts.harness,{executionStatus,qualityStatus});assert.equal((await f.read({...reference,digest:nativeSha256(run.receipt)})).status,status);
 }
 f.rows.get('collection.inspect:second').receipt.result.endedAt='changed';await assert.rejects(()=>f.read({...reference,digest:nativeSha256(run.receipt)}),{code:'RESPONSE_EVIDENCE_INTEGRITY'});
});
test('response Run rejects missing execution evidence, empty owner reports and changed reference digest',async()=>{
 const f=responseFixture(),reference=f.run('original',[]),run=f.rows.get('run.inspect:original');await assert.rejects(()=>f.read(reference),{code:'RESPONSE_EXECUTION_EVIDENCE_REQUIRED'});
 const collection=f.collection('first');run.plan.input.collectionReceipts=[{id:'first',digest:collection.digest}];run.receipt.ownerReceipts={};await assert.rejects(()=>f.read({...reference,digest:nativeSha256(run.receipt)}),{code:'INVALID_FIELDS'});
 run.receipt.ownerReceipts={ontology:{executionStatus:'SUCCEEDED',qualityStatus:'PASS'},harness:{executionStatus:'SUCCEEDED',qualityStatus:'PASS'}};
 await assert.rejects(()=>f.read({...reference,digest:'sha256:'+'f'.repeat(64)}),{code:'RESPONSE_EVIDENCE_DRIFT'});
});
test('response Harness evidence retains exact scope and UNKNOWN; unsupported owners do not become asserted PASS',async()=>{
 const f=responseFixture(),reference={owner:'harness',id:'finding:synthetic',digest:'sha256:'+'a'.repeat(64)},value={workspaceId:'fixture',scope,reference,status:'UNKNOWN',observedAt:1};f.setOwner(value);assert.deepEqual(await f.read(reference),value);assert.equal(f.client.requests.length,0);
 for(const patch of [{workspaceId:'other'},{scope:{...scope,visibility:'public'}},{reference:{...reference,id:'other'}}]){f.setOwner({...value,...patch});await assert.rejects(()=>f.read(reference),{code:'RESPONSE_EVIDENCE_DRIFT'});}
 for(const owner of ['ontology','workspace'])await assert.rejects(()=>f.read({...reference,owner}),{code:'RESPONSE_EVIDENCE_UNSUPPORTED'});
 f.setOwner(value);f.revoke();await assert.rejects(()=>f.read(reference),{code:'OWNER_HOST_CHANGED'});
});
test('response evidence reads retained raw output over the migrated HTTP service and rejects later byte tampering without execution',async t=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'runtime-response-migration-')),workspaceId='response-migration',workspaceRoot=join(root,'original'),stateRoot=join(root,'service'),put=(p,v)=>writeFileSync(p,JSON.stringify(v),{mode:0o600});
 let old,server;const results=new Map();let executions=0;
 t.after(async()=>{old?.close();await server?.close();rmSync(root,{recursive:true,force:true});});
 const requirements=[{criterionId:'isolated',variantIds:['isolated.01'],origin:'execution-result'}],sourceScope={direction:'forward',locator:'synthetic:'+root,revision:'fixture-r1',treeDigest:nativeSha256('fixture-source'),inventoryDigest:nativeSha256('fixture-inventory'),requirementsDigest:nativeSha256(requirements)},standards=Object.fromEntries(['ontology','harness'].map(owner=>[owner,{standardDigest:nativeSha256({owner,standard:true}),standardLockDigest:nativeSha256({owner,lock:true})}]));
 const providers={nativeStandards:standards,inspectSource:()=>sourceScope,resolveRequirements:()=>requirements,collect:({claim,artifactRoot})=>{
  executions++;const startedAt=new Date().toISOString(),bytes=execFileSync(process.execPath,['-e','process.stdout.write("{\\"observed\\":1}")'],{timeout:3000,maxBuffer:4096,env:{LANG:'C'}});writeFileSync(join(artifactRoot,'observation.json'),bytes,{mode:0o600});
  const result={claimId:claim.claimId,recipeDigest:claim.recipeDigest,sourceDigest:sourceScope.treeDigest,startedAt,endedAt:new Date().toISOString(),exitCode:0,signal:null,timedOut:false,interrupted:false,error:null,outputs:[{path:'observation.json',mediaType:'application/json',sha256:nativeBytesDigest(bytes).slice(7)}]};results.set(claim.claimId,result);return result;
 },inspectCollection:({claim})=>results.get(claim.claimId)??null};
 old=createRuntimeService({workspaceRoot,workspaceId},providers);old.initialize();old.execute({operation:'project.create',scope,input:{name:'Synthetic response migration'},requestId:'create',expectedRevision:0});old.execute({operation:'goal.create',scope,input:{id:'goal',description:'Isolated regression only'},requestId:'goal',expectedRevision:1});
 let serial=0;const write=async(operation,input)=>old.native({operation,scope,input,requestId:'fixture-'+(++serial),expectedRevision:(await old.native({operation:'workspace.inspect',scope,input:{}})).revision});
 await write('project.prepare',{id:'native-project',goalId:'goal',sourceScope,standardPins:standards,requirements});
 const recipe={schema:'evopilot-collection-recipe/v1',sourceScope,executable:process.execPath,executableDigest:nativeBytesDigest(readFileSync(process.execPath)),argv:['-e','process.stdout.write("{\\"observed\\":1}")'],cwd:root,environment:{LANG:'C'},toolchainLockDigest:nativeSha256('synthetic-node-toolchain'),timeoutMs:3000,maxOutputBytes:4096,allowedOutputs:['observation.json'],network:{mode:'none',hosts:[]},selectors:[{id:'observed',output:'observation.json',kind:'json-pointer',pointer:'/observed'}]};
 const prepared=(await write('collection.prepare',{id:'retained',projectId:'native-project',recipe})).result;
 await write('collection.decide',{id:'retained',reviewDigest:prepared.reviewDigest,decision:'APPROVE',humanEvidenceRef:syntheticDecisionEvidence(root,{owner:'runtime',operation:'collection.decide',workspaceId,scope,reviewDigest:prepared.reviewDigest,decision:'APPROVE'})});
 const collected=(await write('collection.execute',{id:'retained'})).result;assert.equal(collected.stage,'SUCCEEDED');assert.equal(executions,1);old.close();old=null;
 const token=randomBytes(32).toString('base64url');initializeCredentials(stateRoot,workspaceId,[{id:'reader',projects:['alpha'],permissions:['read'],revision:1,expiresAt:'2030-01-01T00:00:00Z',tokenDigest:tokenDigest(token)}]);
 const store=new RuntimeStore(stateRoot,workspaceId),serviceId=store.serviceId;store.close();
 const snapshot=inspectLegacyWorkspace(workspaceRoot,workspaceId),backupRoot=join(root,'backup'),backup=createLegacyBackup(workspaceRoot,workspaceId,snapshot.snapshotDigest,backupRoot),adoption=adoptLegacyWorkspace({workspaceRoot,workspaceId,serviceId,expectedSnapshotDigest:snapshot.snapshotDigest,backupRoot,expectedBackupDigest:backup.backupDigest}),bindingRef=join(root,'binding.json');put(bindingRef,adoption.binding);
 // The new service deliberately has no execution providers. Evidence reads
 // must use retained claims and raw bytes, without another collection.
 server=await startRuntimeServer({stateRoot,workspaceId,legacyBindingRef:bindingRef});
 const tokenRef=join(root,'token.json'),connectionRef=join(root,'connection.json');put(tokenRef,{schema:'runtime-client-credential/v1',workspaceId,projectId:'alpha',principalId:'reader',token});put(connectionRef,{schema:'runtime-host-connection/v1',origin:server.url,workspaceId,projectId:'alpha',principalId:'reader',serviceId,version:server.identity.version,tokenRef});
 const client=createRuntimeHttpClient(connectionRef),host=createLegacyOwnerProviders({workspaceId,projectId:'alpha',client,guard:()=>({scope}),readOwner:async()=>{throw Error('No owner call expected');}}),reference={owner:'runtime',id:'collection:retained',digest:collected.receipt.digest};
 const evidence=await host.readResponseEvidence({scope,reference});assert.equal(evidence.status,'PASS');assert.equal(evidence.observedAt,Math.floor(Date.parse(collected.receipt.result.endedAt)/1000));assert.equal(executions,1);assert.equal((await client.status()).result.revision,0,'reading evidence creates no transport mutation');
 writeFileSync(join(workspaceRoot,'state/runtime-native',collected.claim.claimId.slice(7),'observation.json'),'changed');await assert.rejects(()=>host.readResponseEvidence({scope,reference}),{code:'EVIDENCE_DRIFT'});assert.equal(executions,1);assert.equal((await client.status()).result.revision,0);
});
