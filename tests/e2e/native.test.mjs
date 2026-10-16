import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, chmodSync, cpSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRuntimeService } from '@evopilot-next/runtime/service';
import { nativeSha256 as hash, nativeBytesDigest, NATIVE_CONTRACT_DIGEST } from '../../vendor/compatibility/v1/native.mjs';
import { inspectWorkspaceSnapshot, relocateWorkspaceSnapshot } from '@evopilot-next/runtime/workspace-migration';
import { DatabaseSync } from 'node:sqlite';

const scope={visibility:'private',projectId:'native-fixture'};
const pins=Object.fromEntries(['ontology','harness'].map(p=>[p,{standardDigest:hash({p,spec:'synthetic'}),standardLockDigest:hash({p,lock:'synthetic'})}]));
const reference=owner=>({product:owner,id:'fixture-'+owner,version:'1.0.0',specVersion:'v1',visibility:'private',digest:hash({owner,package:'synthetic'}),...pins[owner],producer:{product:owner,version:'0.3.0'},contractDigest:NATIVE_CONTRACT_DIGEST});
function fixture(t,overrides={}) {
  const root=mkdtempSync(join(realpathSync(tmpdir()),'evopilot-native-runtime-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=join(root,'fixture.mjs');writeFileSync(source,"process.stdout.write(JSON.stringify({count:3})+'\\n')\n",{mode:0o600});
  const requirements=[{criterionId:'O',variantIds:['O.01'],origin:'execution-result'},{criterionId:'H',variantIds:['H.01'],origin:'execution-result'}];
  const sourceScope={direction:'reverse',locator:'synthetic:'+root,revision:'fixture-r1',treeDigest:nativeBytesDigest(readFileSync(source)),inventoryDigest:hash(['fixture.mjs']),requirementsDigest:hash(requirements)};
  const recipe={schema:'evopilot-collection-recipe/v1',sourceScope,executable:process.execPath,executableDigest:nativeBytesDigest(readFileSync(process.execPath)),argv:[source],cwd:root,environment:{LANG:'C'},toolchainLockDigest:hash('fixture-node-lock'),timeoutMs:1000,maxOutputBytes:65536,allowedOutputs:['stdout.json','stderr.txt'],network:{mode:'none',hosts:[]},selectors:[{id:'count',output:'stdout.json',kind:'json-pointer',pointer:'/count'},{id:'exit',output:'stdout.json',kind:'exit-code',pointer:''}]};
  const stored=new Map();let collectionCalls=0,runCalls=0;
  const provider={nativeStandards:pins,resolveRequirements:()=>requirements,inspectSource:()=>({...sourceScope,treeDigest:nativeBytesDigest(readFileSync(source))}),resolveNative:({reference,workspace,scope})=>({reference,workspace,scope,published:true,materialDigest:reference.digest,descriptor:{kind:reference.product+'-composition/v1',digest:reference.digest}}),
    collect:async({claim,artifactRoot,signal})=>{collectionCalls++;const startedAt=new Date().toISOString(),stdout=[],stderr=[];const child=spawn(claim.recipe.executable,claim.recipe.argv,{cwd:claim.recipe.cwd,env:claim.recipe.environment,stdio:['ignore','pipe','pipe'],signal});let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},claim.recipe.timeoutMs);child.stdout.on('data',b=>stdout.push(b));child.stderr.on('data',b=>stderr.push(b));const [exitCode,exitSignal]=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(a,b)=>{clearTimeout(timer);resolve([a,b]);});});const outputs=[];for(const [path,parts]of[['stdout.json',stdout],['stderr.txt',stderr]]){const bytes=Buffer.concat(parts);writeFileSync(join(artifactRoot,path),bytes,{mode:0o600});outputs.push({path,mediaType:path.endsWith('json')?'application/json':'text/plain',sha256:nativeBytesDigest(bytes).slice(7)});}const result={claimId:claim.claimId,recipeDigest:claim.recipeDigest,sourceDigest:sourceScope.treeDigest,startedAt,endedAt:new Date().toISOString(),exitCode,signal:exitSignal,timedOut,interrupted:false,error:null,outputs};stored.set(claim.claimId,result);return result;},
    inspectCollection:({claim})=>stored.get(claim.claimId)??null,
    executeNative:({claim})=>{runCalls++;const ownerReceipts=Object.fromEntries(['ontology','harness'].map((owner,i)=>{const row={owner,requestId:owner+'-'+claim.id,receiptDigest:hash({owner,claim:claim.claimId}),reference:claim.pins[owner],context:claim.context,executionStatus:'SUCCEEDED',qualityStatus:'PASS',reportDigest:hash({owner,report:true}),criteria:[{criterionId:i?'H':'O',variantId:i?'H.01':'O.01',status:'PASS',evidenceDigest:hash({owner,evidence:true})}]};stored.set(row.requestId,row);return[owner,row];}));const receipt={schema:'runtime-receipt/v1',contractDigest:NATIVE_CONTRACT_DIGEST,producer:{product:'runtime',version:'0.3.0'},claimId:claim.claimId,inputDigest:claim.inputDigest,projectCandidateDigest:claim.input.projectCandidateDigest,pins:claim.pins,standardPins:claim.input.standardPins,ownerReceipts};stored.set('run:'+claim.claimId,receipt);return receipt;},
    inspectNative:({claim})=>stored.get('run:'+claim.claimId)??null,readOwnerReceipt:({requestId})=>stored.get(requestId),...overrides};
  const options={workspaceRoot:join(root,'state-root'),workspaceId:'native-fixture'};let service=createRuntimeService(options,provider);service.initialize();let serial=0;
  const read=(operation,input={})=>service.native({operation,scope,input});
  const write=async(operation,input)=>service.native({operation,scope,input,requestId:'native-'+ ++serial,expectedRevision:(await read('workspace.inspect')).revision});
  async function setup(){const p=(await write('project.prepare',{id:'project-r1',goalId:'goal',sourceScope,standardPins:pins,requirements})).result;const c=(await write('collection.prepare',{id:'collect',projectId:p.id,recipe})).result;await write('collection.decide',{id:c.id,reviewDigest:c.reviewDigest,decision:'APPROVE',humanEvidenceRef:'synthetic:unit-fixture-only'});const collected=(await write('collection.execute',{id:c.id})).result;assert.equal(collected.stage,'SUCCEEDED');const input={schema:'runtime-composition/v1',contractDigest:NATIVE_CONTRACT_DIGEST,projectCandidateDigest:p.candidateDigest,standardPins:pins,sourceScope,requirements,effectiveConfig:{synthetic:true},nativeInputs:{ontology:{synthetic:true},harness:{observation:{schema:'evopilot-observation/v1',origin:'execution-result',source:{revision:sourceScope.revision,digest:sourceScope.treeDigest},values:collected.receipt.observations,sourceScopeDigest:hash(sourceScope),collectionReceiptRef:{id:c.id,digest:collected.receipt.digest,claimId:collected.claim.claimId}}}},collectionReceipts:[{id:c.id,digest:collected.receipt.digest}]};return{p,c:collected,input};}
  async function prepare(input){return(await write('run.prepare',{id:'run',projectId:'project-r1',goalId:'goal',ontology:reference('ontology'),harness:reference('harness'),input})).result;}
  const restart=()=>{service.close();service=createRuntimeService(options,provider);service.initialize();};t.after(()=>service.close());
  return{root,options,provider,source,recipe,requirements,sourceScope,read,write,setup,prepare,restart,stored,close:()=>service.close(),counts:()=>({collectionCalls,runCalls}),service:()=>service};
}
test('native public API: actual collection, owner readback, exact completion, restart and no redispatch',async t=>{
  const f=fixture(t),{p,c,input}=await f.setup();assert.equal(c.receipt.observations.count,3);assert.equal(c.receipt.observations.exit,0);
  const r=await f.prepare(input);await f.write('run.decide',{id:'run',reviewDigest:r.reviewDigest,decision:'APPROVE',humanEvidenceRef:'synthetic:review-only'});
  const run=(await f.write('run.dispatch',{id:'run'})).result;assert.equal(run.stage,'SUCCEEDED');assert.equal(run.claim.attemptCount,1);
  const validation=(await f.write('project.validate',{id:p.id,runId:'run'})).result;
  const completed=(await f.write('project.complete',{id:p.id,runId:'run',reviewDigest:validation.reviewDigest,humanEvidenceRef:'synthetic:final-only'})).result;assert.equal(completed.complete.runId,'run');
  f.restart();assert.deepEqual(await f.read('run.inspect',{id:'run'}),run);assert.deepEqual(await f.read('project.inspect',{id:p.id}),completed);
  await f.write('collection.execute',{id:'collect'});await f.write('run.dispatch',{id:'run'});assert.deepEqual(f.counts(),{collectionCalls:1,runCalls:1});
  const db=new DatabaseSync(join(f.options.workspaceRoot,'state/runtime/runtime.db'));assert.equal(db.prepare('PRAGMA user_version').get().user_version,2);db.close();
});
test('native failures: scope/source/standard/denominator drift, empty actual receipts, raw tamper',async t=>{
  const f=fixture(t),{input,c}=await f.setup();
  for(const mutate of [v=>{v.requirements.pop();},v=>{v.standardPins.ontology.standardDigest=hash('old-v1');},v=>{v.collectionReceipts=[];},v=>{v.sourceScope.revision='wrong';}]){const changed=structuredClone(input);mutate(changed);await assert.rejects(()=>f.prepare(changed));}
  const path=join(f.options.workspaceRoot,'state/runtime-native',c.claim.claimId.slice(7),'stdout.json');writeFileSync(path,'{"count":4}\n');
  await assert.rejects(()=>f.prepare(input),{code:'EVIDENCE_DRIFT'});
  writeFileSync(f.source,'changed source');await assert.rejects(()=>f.prepare(input),{code:'REVIEW_REQUIRED'});
});
test('aggregate execution success is insufficient for incomplete owner variants',async t=>{
  const f=fixture(t),original=f.provider.executeNative;f.provider.executeNative=({claim})=>{const result=original({claim});result.ownerReceipts.harness.criteria=[];f.stored.set(result.ownerReceipts.harness.requestId,result.ownerReceipts.harness);return result;};
  // Trusted callbacks are fixed at construction; restart deliberately installs fixture provider.
  f.restart();const {input}=await f.setup();const r=await f.prepare(input);await f.write('run.decide',{id:'run',reviewDigest:r.reviewDigest,decision:'APPROVE',humanEvidenceRef:'synthetic:fixture'});assert.equal((await f.write('run.dispatch',{id:'run'})).result.stage,'SUCCEEDED');await assert.rejects(()=>f.write('project.validate',{id:'project-r1',runId:'run'}),{code:'INCOMPLETE'});
});
test('UNKNOWN collection is inspected by original claim and never dispatched twice',async t=>{
  let count=0;const f=fixture(t,{collect:()=>{count++;throw Error('uncertain');},inspectCollection:()=>null});
  const p=(await f.write('project.prepare',{id:'project-r1',goalId:'goal',sourceScope:f.sourceScope,standardPins:pins,requirements:f.requirements})).result;const c=(await f.write('collection.prepare',{id:'collect',projectId:p.id,recipe:f.recipe})).result;await f.write('collection.decide',{id:c.id,reviewDigest:c.reviewDigest,decision:'APPROVE',humanEvidenceRef:'synthetic:fixture'});
  assert.equal((await f.write('collection.execute',{id:c.id})).result.stage,'UNKNOWN');f.restart();await f.write('collection.execute',{id:c.id});assert.equal(count,1);assert.equal((await f.write('collection.reconcile',{id:c.id})).result.stage,'UNKNOWN');assert.equal(count,1);
});
test('legacy new Run writes are rejected; no native marker or historical receipt fabricated',async t=>{
  const f=fixture(t);assert.throws(()=>f.service().execute({operation:'run.prepare',scope,input:{},requestId:'old',expectedRevision:0}),{code:'HISTORICAL_READ_ONLY'});await assert.rejects(()=>f.service().dispatch({scope,id:'old',requestId:'old-dispatch',expectedRevision:0}),{code:'HISTORICAL_READ_ONLY'});assert.equal(f.service().execute({operation:'workspace.inspect',scope,input:{}}).revision,0);
});

async function collectionOnly(f, id='collect') {
  const p=(await f.write('project.prepare',{id:'project-r1',goalId:'goal',sourceScope:f.sourceScope,standardPins:pins,requirements:f.requirements})).result;
  const c=(await f.write('collection.prepare',{id,projectId:p.id,recipe:f.recipe})).result;
  await f.write('collection.decide',{id,reviewDigest:c.reviewDigest,decision:'APPROVE',humanEvidenceRef:'synthetic:fixture'});
  return (await f.write('collection.execute',{id})).result;
}
for (const scenario of [
  {name:'JUnit testcase outcomes and declared counts',kind:'junit-total',text:'<?xml version="1.0" encoding="UTF-8"?><testsuites tests="3" failures="1" errors="0" skipped="1"><testsuite name="sample" tests="3" failures="1" errors="0" skipped="1"><properties><property name="a" value="b"/></properties><testcase name="one"/><testcase name="two"><failure message="x &amp; y"><![CDATA[stack <text>]]></failure></testcase><testcase name="three"><skipped/></testcase></testsuite></testsuites>',expected:3},
  {name:'JUnit failures',kind:'junit-failures',text:'<testsuite><testcase name="one"><failure>failure stack</failure></testcase></testsuite>',expected:1},
  {name:'JUnit errors',kind:'junit-errors',text:'<testsuite><testcase><error/></testcase></testsuite>',expected:1},
  {name:'JUnit skips',kind:'junit-skipped',text:'<testsuite><testcase><skipped/></testcase></testsuite>',expected:1},
  {name:'structured log records',kind:'json-lines-count',text:'{"level":"WARN","message":"warning"}\n{"level":"INFO"}\n',expected:2},
  {name:'JUnit false summary',kind:'junit-total',text:'<testsuite tests="20"><testcase/></testsuite>',error:true},
  {name:'JUnit XXE rejected',kind:'junit-total',text:'<!DOCTYPE testsuite [<!ENTITY x SYSTEM "file:///etc/passwd">]><testsuite><testcase><error>&x;</error></testcase></testsuite>',error:true},
  {name:'JUnit malformed tags rejected',kind:'junit-total',text:'<testsuite><testcase></testsuite>',error:true},
  {name:'JUnit duplicate attributes rejected',kind:'junit-total',text:'<testsuite tests="1" tests="1"><testcase/></testsuite>',error:true},
  {name:'JUnit unknown dialect rejected',kind:'junit-total',text:'<report tests="1"/>',error:true},
  {name:'unstructured logs rejected',kind:'json-lines-count',text:'WARN real plain text log\n',error:true},
]) test('protected raw parser: '+scenario.name,async t=>{
  const f=fixture(t);writeFileSync(f.source,'process.stdout.write('+JSON.stringify(scenario.text)+')');f.sourceScope.treeDigest=nativeBytesDigest(readFileSync(f.source));
  f.recipe.selectors=[{id:'observed',output:'stdout.json',kind:scenario.kind,pointer:''}];
  const c=await collectionOnly(f);assert.equal(c.stage,scenario.error?'FAILED':'SUCCEEDED');
  assert.equal(c.receipt.raw.find(r=>r.path==='stdout.json').sha256,nativeBytesDigest(Buffer.from(scenario.text)).slice(7));
  if(scenario.error)assert.match(c.receipt.result.error,/OBSERVATION_PARSE_FAILED/);else assert.equal(c.receipt.observations.observed,scenario.expected);
});
test('native owner readback mismatch becomes UNKNOWN and cannot be silently redispatched',async t=>{
  const f=fixture(t),original=f.provider.executeNative;f.provider.executeNative=({claim})=>{const receipt=original({claim});const forged=structuredClone(receipt);forged.ownerReceipts.harness.reportDigest=hash('forged');return forged;};f.restart();
  const {input}=await f.setup(),r=await f.prepare(input);await f.write('run.decide',{id:r.plan.id,reviewDigest:r.reviewDigest,decision:'APPROVE',humanEvidenceRef:'synthetic:fixture'});
  assert.equal((await f.write('run.dispatch',{id:r.plan.id})).result.stage,'UNKNOWN');f.restart();await f.write('run.dispatch',{id:r.plan.id});assert.equal(f.counts().runCalls,1);
  assert.equal((await f.write('run.reconcile',{id:r.plan.id})).result.stage,'SUCCEEDED');assert.equal(f.counts().runCalls,1);
});
for(const [id,mutate] of [
 ['C05.02',r=>{r.ownerReceipts.harness.context.scope.projectId='another-project';}],
 ['C05.03',r=>{r.projectCandidateDigest=hash('previous-round');}],
 ['C05.05',r=>{r.ownerReceipts.harness.reference.digest=hash('different-package');}],
 ['C05.06',r=>{r.ownerReceipts.harness.context.workspaceId='another-workspace';}],
 ['C05.07',r=>{r.ownerReceipts.harness.context.projectCandidateDigest=hash('another-candidate');}],
 ['C05.08',r=>{r.ownerReceipts.harness.context.claimId=hash('another-claim');}],
 ['C05.09',r=>{r.ownerReceipts.harness.context.inputDigest=hash('another-input');}],
 ['C05.10',r=>{r.ownerReceipts.harness.reference.standardDigest=hash('another-standard');}],
 ['C05.11',r=>{r.producer={product:'unknown',version:'0.3.0'};}]
])test(id+': mismatched owner binding remains UNKNOWN without redispatch',async t=>{
 const f=fixture(t),original=f.provider.executeNative;
 f.provider.executeNative=({claim})=>{const receipt=structuredClone(original({claim}));mutate(receipt);
  // Even a matching protected readback cannot make a different context valid.
  f.stored.set(receipt.ownerReceipts.harness.requestId,receipt.ownerReceipts.harness);return receipt;};
 f.restart();const {input}=await f.setup(),r=await f.prepare(input);
 await f.write('run.decide',{id:r.plan.id,reviewDigest:r.reviewDigest,decision:'APPROVE',humanEvidenceRef:'synthetic:receipt-mismatch'});
 const rejected=(await f.write('run.dispatch',{id:r.plan.id})).result;
 assert.equal(rejected.stage,'UNKNOWN');assert.equal(rejected.reason,'INVALID_PROVIDER_RECEIPT');assert.equal(rejected.receipt,null);
 await assert.rejects(()=>f.write('project.validate',{id:'project-r1',runId:r.plan.id}));
 f.restart();await f.write('run.dispatch',{id:r.plan.id});assert.equal(f.counts().runCalls,1);
});
test('C05.04: reported PASS without protected owner receipt remains UNKNOWN',async t=>{
 const f=fixture(t);f.provider.readOwnerReceipt=()=>undefined;f.restart();const {input}=await f.setup(),r=await f.prepare(input);
 await f.write('run.decide',{id:r.plan.id,reviewDigest:r.reviewDigest,decision:'APPROVE',humanEvidenceRef:'synthetic:missing-receipt'});
 const rejected=(await f.write('run.dispatch',{id:r.plan.id})).result;assert.equal(rejected.stage,'UNKNOWN');assert.equal(rejected.receipt,null);
 await assert.rejects(()=>f.write('project.validate',{id:'project-r1',runId:r.plan.id}));
 await f.write('run.dispatch',{id:r.plan.id});assert.equal(f.counts().runCalls,1);
});
test('native fixed denominator cannot be narrowed by caller',async t=>{
  const f=fixture(t),reduced=f.requirements.slice(0,1),sourceScope={...f.sourceScope,requirementsDigest:hash(reduced)};
  f.provider.inspectSource=()=>sourceScope;f.restart();
  await assert.rejects(()=>f.write('project.prepare',{id:'narrowed',goalId:'goal',sourceScope,standardPins:pins,requirements:reduced}),{code:'REQUIREMENTS_MISMATCH'});
});
test('native snapshot covers raw evidence and records, relocation retains originals and rejects stale prepared execution',async t=>{
  const f=fixture(t),{input,c}=await f.setup(),r=await f.prepare(input);f.close();
  const before=inspectWorkspaceSnapshot(f.options);assert.ok(before.native.receiptCount>0);assert.ok(before.blobs.some(b=>b.path.endsWith('/stdout.json')));
  const destination=join(f.root,'relocated');cpSync(f.options.workspaceRoot,destination,{recursive:true,preserveTimestamps:true});const fixMode=path=>{const st=lstatSync(path);chmodSync(path,st.isDirectory()?0o700:0o600);if(st.isDirectory())for(const name of readdirSync(path))fixMode(join(path,name));};fixMode(destination);
  const moved=relocateWorkspaceSnapshot({sourceRoot:f.options.workspaceRoot,destinationRoot:destination,workspaceId:f.options.workspaceId,expectedSnapshotDigest:before.snapshotDigest});
  assert.deepEqual(moved.snapshot.native,before.native);assert.deepEqual(moved.snapshot.blobs,before.blobs);
  const service=createRuntimeService({workspaceRoot:destination,workspaceId:f.options.workspaceId},f.provider);service.initialize();t.after(()=>service.close());
  assert.deepEqual(await service.native({operation:'collection.inspect',scope,input:{id:c.id}}),c);
  const read=()=>service.native({operation:'workspace.inspect',scope,input:{}});
  await service.native({operation:'run.decide',scope,input:{id:r.plan.id,reviewDigest:r.reviewDigest,decision:'APPROVE',humanEvidenceRef:'synthetic:fixture'},requestId:'after-move-decision',expectedRevision:(await read()).revision});
  await assert.rejects(()=>read().then(({revision})=>service.native({operation:'run.dispatch',scope,input:{id:r.plan.id},requestId:'after-move-run',expectedRevision:revision})),{code:'RELOCATION_REVIEW_REQUIRED'});
  service.close();writeFileSync(join(destination,'state/runtime-native',c.claim.claimId.slice(7),'stdout.json'),'changed');
  assert.throws(()=>inspectWorkspaceSnapshot({workspaceRoot:destination,workspaceId:f.options.workspaceId}),{code:'CORRUPT_BLOB'});
});
test('native process crash after raw receipt resumes original claim without a second process',async t=>{
  const f=fixture(t);const p=(await f.write('project.prepare',{id:'project-r1',goalId:'goal',sourceScope:f.sourceScope,standardPins:pins,requirements:f.requirements})).result;
  const c=(await f.write('collection.prepare',{id:'collect',projectId:p.id,recipe:f.recipe})).result;await f.write('collection.decide',{id:c.id,reviewDigest:c.reviewDigest,decision:'APPROVE',humanEvidenceRef:'synthetic:fixture'});f.close();
  const config={options:f.options,scope,sourceScope:f.sourceScope},script=`
    import {createRuntimeService} from ${JSON.stringify(new URL('../../dist/service.js',import.meta.url).href)};
    import {nativeBytesDigest} from ${JSON.stringify(new URL('../../vendor/compatibility/v1/native.mjs',import.meta.url).href)};
    import {writeFileSync,readFileSync} from 'node:fs'; import {join} from 'node:path';import {spawnSync} from 'node:child_process';
    const cfg=${JSON.stringify(config)};const svc=createRuntimeService(cfg.options,{inspectSource:()=>cfg.sourceScope,collect:({claim,artifactRoot})=>{
      const startedAt=new Date().toISOString(),r=spawnSync(claim.recipe.executable,claim.recipe.argv,{cwd:claim.recipe.cwd,env:claim.recipe.environment});
      const outputs=[['stdout.json',r.stdout],['stderr.txt',r.stderr]].map(([path,bytes])=>{writeFileSync(join(artifactRoot,path),bytes,{mode:0o600});return {path,mediaType:'text/plain',sha256:nativeBytesDigest(bytes).slice(7)}});
      const receipt={claimId:claim.claimId,recipeDigest:claim.recipeDigest,sourceDigest:cfg.sourceScope.treeDigest,startedAt,endedAt:new Date().toISOString(),exitCode:r.status,signal:r.signal,timedOut:false,interrupted:false,error:null,outputs};
      writeFileSync(join(artifactRoot,'adapter-result.json'),JSON.stringify(receipt),{mode:0o600});process.exit(86);
    }});svc.initialize();const current=await svc.native({operation:'workspace.inspect',scope:cfg.scope,input:{}});await svc.native({operation:'collection.execute',scope:cfg.scope,input:{id:'collect'},requestId:'crash',expectedRevision:current.revision});`;
  const killed=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});assert.equal(killed.status,86,killed.stderr);
  f.provider.inspectCollection=({artifactRoot})=>JSON.parse(readFileSync(join(artifactRoot,'adapter-result.json'),'utf8'));f.restart();
  const pending=await f.read('collection.inspect',{id:c.id});assert.equal(pending.stage,'RUNNING');assert.equal(pending.claim.attemptCount,1);
  const resolved=(await f.write('collection.reconcile',{id:c.id})).result;assert.equal(resolved.stage,'SUCCEEDED');assert.equal(resolved.claim.claimId,pending.claim.claimId);assert.equal(resolved.receipt.observations.count,3);assert.equal(f.counts().collectionCalls,0);
  await f.write('collection.execute',{id:c.id});assert.equal(f.counts().collectionCalls,0);
});

test('native actual subprocess timeout retains partial raw bytes without success or retry',async t=>{
  const f=fixture(t);writeFileSync(f.source,'process.stdout.write(JSON.stringify({count:3})+"\\n");setInterval(()=>{},1000)');f.sourceScope.treeDigest=nativeBytesDigest(readFileSync(f.source));f.recipe.timeoutMs=200;
  const c=await collectionOnly(f);assert.equal(c.stage,'FAILED');assert.equal(c.receipt.result.timedOut,true);assert.equal(c.receipt.result.signal,'SIGTERM');assert.equal(c.receipt.observations.count,3);assert.equal(c.claim.attemptCount,1);
  f.restart();assert.deepEqual(await f.read('collection.inspect',{id:c.id}),c);await f.write('collection.execute',{id:c.id});assert.equal(f.counts().collectionCalls,1);
});
test('native nonzero subprocess preserves raw output and cannot become successful evidence',async t=>{
  const f=fixture(t);writeFileSync(f.source,'process.stdout.write(JSON.stringify({count:3})+"\\n");process.exit(3)');f.sourceScope.treeDigest=nativeBytesDigest(readFileSync(f.source));
  const c=await collectionOnly(f);assert.equal(c.stage,'FAILED');assert.equal(c.receipt.result.exitCode,3);assert.equal(c.receipt.observations.count,3);
});
for (const status of ['FAIL','ERROR','UNSUPPORTED','INDETERMINATE']) test('native quality '+status+' blocks project completion after successful owner execution',async t=>{
  const f=fixture(t),original=f.provider.executeNative;f.provider.executeNative=({claim})=>{const result=original({claim});result.ownerReceipts.harness.qualityStatus=status;return result;};f.restart();
  const {input}=await f.setup(),r=await f.prepare(input);await f.write('run.decide',{id:r.plan.id,reviewDigest:r.reviewDigest,decision:'APPROVE',humanEvidenceRef:'synthetic:fixture'});
  assert.equal((await f.write('run.dispatch',{id:r.plan.id})).result.stage,'SUCCEEDED');await assert.rejects(()=>f.write('project.validate',{id:'project-r1',runId:r.plan.id}),{code:'INCOMPLETE'});
});
test('native duplicate PASS variants across owners cannot satisfy fixed denominator',async t=>{
  const f=fixture(t),original=f.provider.executeNative;f.provider.executeNative=({claim})=>{const result=original({claim});result.ownerReceipts.harness.criteria.push({...result.ownerReceipts.ontology.criteria[0]});return result;};f.restart();
  const {input}=await f.setup(),r=await f.prepare(input);await f.write('run.decide',{id:r.plan.id,reviewDigest:r.reviewDigest,decision:'APPROVE',humanEvidenceRef:'synthetic:fixture'});await f.write('run.dispatch',{id:r.plan.id});await assert.rejects(()=>f.write('project.validate',{id:'project-r1',runId:r.plan.id}),{code:'INCOMPLETE'});
});
test('new native writes preserve historical rows and replay retained native requests before source reinspection',async t=>{
  const f=fixture(t);f.service().execute({operation:'project.create',scope,input:{name:'Historical administrative record'},requestId:'historical-create',expectedRevision:0});
  const readLegacy=()=>{const db=new DatabaseSync(join(f.options.workspaceRoot,'state/runtime/runtime.db'));try{return ['state','receipts','audit'].map(table=>db.prepare('SELECT * FROM '+table).all());}finally{db.close();}};
  const before=readLegacy();const request={operation:'project.prepare',scope,input:{id:'project-r1',goalId:'goal',sourceScope:f.sourceScope,standardPins:pins,requirements:f.requirements},requestId:'explicit-replay',expectedRevision:0};
  const receipt=await f.service().native(request);writeFileSync(f.source,'source moved after successful original request');assert.deepEqual(await f.service().native(request),receipt);assert.deepEqual(readLegacy(),before);
  await assert.rejects(()=>f.service().native({...request,input:{...request.input,goalId:'different'}}),{code:'REQUEST_CONFLICT'});
});
test('native audit and unknown contract tampering fail closed on restart',async t=>{
  const f=fixture(t);await f.setup();f.close();const path=join(f.options.workspaceRoot,'state/runtime/runtime.db');let db=new DatabaseSync(path);db.prepare('UPDATE native_runtime_audit SET result_digest=? WHERE revision=1').run(hash('changed'));db.close();f.restart();
  await assert.rejects(()=>f.read('workspace.inspect'),{code:'CORRUPT_STATE'});f.close();db=new DatabaseSync(path);db.prepare('UPDATE native_runtime_identity SET contract_digest=?').run(hash('unknown-contract'));db.close();assert.throws(()=>f.restart(),{code:'CORRUPT_STATE'});
});

test('native criterion/variant pair identity permits one case shared across distinct requirements',async t=>{
  const f=fixture(t);for(const req of f.requirements)req.variantIds=['shared-case'];f.sourceScope.requirementsDigest=hash(f.requirements);
  const original=f.provider.executeNative;f.provider.executeNative=({claim})=>{const result=original({claim});for(const receipt of Object.values(result.ownerReceipts))receipt.criteria[0].variantId='shared-case';return result;};f.restart();
  const {input}=await f.setup(),r=await f.prepare(input);await f.write('run.decide',{id:r.plan.id,reviewDigest:r.reviewDigest,decision:'APPROVE',humanEvidenceRef:'synthetic:fixture'});assert.equal((await f.write('run.dispatch',{id:r.plan.id})).result.stage,'SUCCEEDED');assert.equal((await f.write('project.validate',{id:'project-r1',runId:r.plan.id})).result.eligible,true);
});
test('native duplicate variant inside the same required criterion is rejected before preparation',async t=>{
  const f=fixture(t);f.requirements[0].variantIds.push(f.requirements[0].variantIds[0]);f.sourceScope.requirementsDigest=hash(f.requirements);
  await assert.rejects(()=>f.write('project.prepare',{id:'project-r1',goalId:'goal',sourceScope:f.sourceScope,standardPins:pins,requirements:f.requirements}),{code:'INVALID_INPUT'});
});

test('project verifier reads actual directory/coverage and review on both validate and completion',async t=>{
  const f=fixture(t);const marker=join(f.root,'directory-layout.json');writeFileSync(marker,'{"covered":true}',{mode:0o600});
  f.requirements.push({criterionId:'project:directory',variantIds:['current'],origin:'source-declaration'},{criterionId:'domain:native-fixture:review',variantIds:['accepted'],origin:'source-declaration'});f.sourceScope.requirementsDigest=hash(f.requirements);
  let accepted=true,calls=0;f.provider.verifyProject=({project,run})=>{calls++;let valid=false;try{valid=JSON.parse(readFileSync(marker,'utf8')).covered===true;}catch{}const subject={schema:'evopilot-project-check/v1',context:run.claim.context,runReviewDigest:run.reviewDigest,assetDigests:{ontology:run.plan.pins.ontology.digest,harness:run.plan.pins.harness.digest},criteria:[{criterionId:'project:directory',variantId:'current',status:valid?'PASS':'FAIL',evidenceDigest:hash({valid})},{criterionId:'domain:native-fixture:review',variantId:'accepted',status:accepted?'PASS':'UNKNOWN',evidenceDigest:hash({accepted})}],details:{synthetic:true,valid,accepted}};return{...subject,reportDigest:hash(subject)};};f.restart();
  const {input}=await f.setup(),r=await f.prepare(input);await f.write('run.decide',{id:r.plan.id,reviewDigest:r.reviewDigest,decision:'APPROVE',humanEvidenceRef:'synthetic:fixture'});await f.write('run.dispatch',{id:r.plan.id});
  const validation=(await f.write('project.validate',{id:'project-r1',runId:r.plan.id})).result;assert.equal(calls,1);
  rmSync(marker);await assert.rejects(()=>f.write('project.complete',{id:'project-r1',runId:r.plan.id,reviewDigest:validation.reviewDigest,humanEvidenceRef:'synthetic:fixture'}),{code:'INCOMPLETE'});assert.equal(calls,2);
  writeFileSync(marker,'{"covered":true}',{mode:0o600});accepted=false;await assert.rejects(()=>f.write('project.validate',{id:'project-r1',runId:r.plan.id}),{code:'INCOMPLETE'});
});

test('raw selectors preserve camelCase observation keys and reject prototype keys',async t=>{
  const f=fixture(t);f.recipe.selectors=[{id:'evidenceDigest',output:'stdout.json',kind:'json-pointer',pointer:'/count'}];const c=await collectionOnly(f);assert.equal(c.receipt.observations.evidenceDigest,3);
  const bad={...f.recipe,selectors:[{id:'constructor',output:'stdout.json',kind:'json-pointer',pointer:'/count'}]};await assert.rejects(()=>f.write('collection.prepare',{id:'unsafe-key',projectId:'project-r1',recipe:bad}),{code:'INVALID_INPUT'});
});
