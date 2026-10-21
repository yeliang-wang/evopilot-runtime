import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRuntimeService } from '@evopilot-next/runtime/service';
import { nativeSha256 as hash, nativeBytesDigest, NATIVE_CONTRACT_DIGEST } from '../../vendor/compatibility/v1/native.mjs';
import { RESPONSE_STOP_CONDITIONS, validateResponseRunbook } from '../../vendor/compatibility/response/v1/response.mjs';
import { syntheticDecisionEvidence } from '../fixtures/native/decision-evidence.mjs';

// These owner callbacks are synthetic fixtures. Actual cross-owner/native/Host
// acceptance is independently exercised by parent integration/e2e/response.test.mjs.
async function fixture(t, settings = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'response-runtime-'));
  const scope = { visibility: 'private', projectId: 'synthetic-project' };
  const options = { workspaceRoot: path.join(root, 'state'), workspaceId: 'synthetic-response' };
  const now = () => Math.floor(Date.now() / 1000), source = path.join(root, 'action.mjs');
  fs.writeFileSync(source, 'import fs from "node:fs";if(process.argv[2]==="repair"){fs.appendFileSync("attempts.txt","one\\n");fs.writeFileSync("repaired.flag","ok")};console.log(JSON.stringify({healthy:fs.existsSync("repaired.flag")?1:0}));\n', {mode:0o600});
  const requirements = [{criterionId:'O',variantIds:['O.01'],origin:'execution-result'},{criterionId:'H',variantIds:['H.01'],origin:'execution-result'}];
  const sourceScope = {direction:'reverse',locator:'synthetic:'+root,revision:'fixed-r1',treeDigest:nativeBytesDigest(fs.readFileSync(source)),inventoryDigest:hash(['action.mjs']),requirementsDigest:hash(requirements)};
  const standards = Object.fromEntries(['ontology','harness'].map(owner=>[owner,{standardDigest:hash({owner,standard:true}),standardLockDigest:hash({owner,lock:true})}]));
  const pin = owner => ({product:owner,id:'synthetic-'+owner,version:'1.0.0',specVersion:'v1',visibility:'private',digest:hash({owner,asset:true}),...standards[owner],producer:{product:owner,version:'0.3.0'},contractDigest:NATIVE_CONTRACT_DIGEST});
  const reference = {owner:'runtime',id:'collection:precondition',digest:hash('real-precondition-receipt-fixture')};
  const target = {owner:'workspace',id:'private/projects/synthetic-project/targets/repair/approved.json',digest:hash('target')};
  const loop = {owner:'workspace',id:target.id+'#loop=diagnose',digest:hash('loop')};
  const book = {schema:'evopilot-response-runbook/v1',id:'synthetic-repair',version:'1.0.0',serviceId:'fictional-service',environment:'test',sourceRevision:sourceScope.revision,parameters:{mode:'repair'},prerequisites:[reference],steps:[{id:'repair',description:'Repair generated local fixture state',operation:'isolated-collection'}],stopConditions:[...RESPONSE_STOP_CONDITIONS],effectScope:'isolated-local',maxEvidenceAgeSeconds:3600,expiresAt:now()+3600};
  const runbook = {reference:pin('harness'),path:'runbooks/repair.json',digest:hash(book)};
  const findingBody={schema:'evopilot-online-finding/v1',id:hash('firing'),workspaceId:options.workspaceId,scope,bindingId:'monitor',bindingDigest:hash('binding'),serviceId:book.serviceId,environment:'test',deploymentRevision:'isolated-deployment',policy:pin('harness'),incidentId:hash({source:settings.findingSource??'evaluation',incident:'synthetic'}),source:settings.findingSource??'evaluation',state:'FIRING',at:now()-3,evidenceDigest:hash('fault'),causeId:hash('cause'),candidate:{kind:'regression',status:'REVIEW_REQUIRED'}};
  const finding={...findingBody,digest:hash(findingBody)};
  const problemBody={schema:'evopilot-response-problem/v1',id:'problem',workspaceId:options.workspaceId,scope,incidentId:finding.incidentId,findingIds:[finding.id],serviceId:book.serviceId,environment:'test',deploymentRevision:finding.deploymentRevision,impact:'Synthetic endpoint unavailable',causes:[{kind:'suspected',description:'Generated local configuration',evidence:[{owner:'harness',id:finding.id,digest:finding.digest}]}],evidence:[{owner:'harness',id:finding.id,digest:finding.digest}],followups:[],disposition:null,history:[]};
  const problem={...problemBody,digest:hash(problemBody)};
  const results=new Map(), ownerReceipts=new Map(), inboxes=new Map();
  const controls={lostResponse:false,withdrawn:false,evidenceStatus:'PASS',evidenceAge:0,evidenceWorkspaceId:options.workspaceId,evidenceScope:scope,onEvidence:null,collectCount:0,cancelCount:0,feedbackReady:true,feedbackDeliver:false,recoveryAt:null,recoveryOverride:null};
  let service,serial=0;
  const decision=(operation,reviewDigest)=>syntheticDecisionEvidence(root,{owner:'runtime',operation,workspaceId:options.workspaceId,scope,reviewDigest,decision:'APPROVE'});
  const providers={
    nativeStandards:standards,resolveRequirements:()=>requirements,
    inspectSource:()=>({...sourceScope,treeDigest:nativeBytesDigest(fs.readFileSync(source))}),
    resolveNative:({reference,workspace,scope})=>({reference,workspace,scope,published:true,materialDigest:reference.digest,descriptor:{kind:reference.product+'-composition/v1',digest:reference.digest}}),
    readOnlineFinding:async()=>finding,
    resolveResponseRunbook:()=>({workspaceId:options.workspaceId,scope,pin:runbook,runbook:book,published:true,withdrawn:controls.withdrawn}),
    readResponseProblem:()=>problem,
    readResponseEvidence:async({reference})=>{const run=controls.onEvidence;controls.onEvidence=null;if(run)await run();return {workspaceId:controls.evidenceWorkspaceId,scope:controls.evidenceScope,reference,status:controls.evidenceStatus,observedAt:reference.owner==='workspace'?1:now()-controls.evidenceAge};},
    cancelResponseCollection:({claimId})=>{controls.cancelCount++;return {requested:true,claimId};},
    collect:async({claim,artifactRoot})=>{
      controls.collectCount++;const startedAt=new Date().toISOString(),stdout=[],stderr=[];
      const child=spawn(claim.recipe.executable,claim.recipe.argv,{cwd:root,env:{LANG:'C'},stdio:['ignore','pipe','pipe']});
      child.stdout.on('data',b=>stdout.push(b));child.stderr.on('data',b=>stderr.push(b));
      const [exitCode,signal]=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve([code,signal]));});
      const outputs=[];for(const [name,parts] of [['stdout.json',stdout],['stderr.txt',stderr]]){const bytes=Buffer.concat(parts);fs.writeFileSync(path.join(artifactRoot,name),bytes,{mode:0o600});outputs.push({path:name,mediaType:name.endsWith('.json')?'application/json':'text/plain',sha256:nativeBytesDigest(bytes).slice(7)});}
      const result={claimId:claim.claimId,recipeDigest:claim.recipeDigest,sourceDigest:sourceScope.treeDigest,startedAt,endedAt:new Date().toISOString(),exitCode,signal,timedOut:false,interrupted:false,error:null,outputs};
      results.set(claim.claimId,result);if(controls.lostResponse){controls.lostResponse=false;throw Error('Synthetic transport response loss after actual process');}return result;
    },
    inspectCollection:({claim})=>results.get(claim.claimId)??null,
    executeNative:({claim})=>{
      const receipts=Object.fromEntries(['ontology','harness'].map((owner,i)=>{const row={owner,requestId:'native-'+owner+'-'+claim.id,receiptDigest:hash({owner,claim:claim.claimId}),reference:claim.pins[owner],context:claim.context,executionStatus:'SUCCEEDED',qualityStatus:'PASS',reportDigest:hash({owner,report:claim.claimId}),criteria:[{criterionId:i?'H':'O',variantId:i?'H.01':'O.01',status:'PASS',evidenceDigest:hash({owner,fixture:true})}]};ownerReceipts.set(row.requestId,row);return[owner,row];}));
      return{schema:'runtime-receipt/v1',contractDigest:NATIVE_CONTRACT_DIGEST,producer:{product:'runtime',version:'0.3.0'},claimId:claim.claimId,inputDigest:claim.inputDigest,projectCandidateDigest:claim.input.projectCandidateDigest,pins:claim.pins,standardPins:claim.input.standardPins,ownerReceipts:receipts};
    },
    readOwnerReceipt:({requestId})=>ownerReceipts.get(requestId),
    deliverFeedback:({owner,event})=>{
      const receiptBody={eventId:event.id,eventDigest:event.digest,owner,workspaceId:options.workspaceId,scope,candidateId:event.id+':'+owner};
      const reviewBody={mode:controls.feedbackDeliver?'DELIVER':'REUSE',reference:controls.feedbackDeliver?{...event.pins[owner],version:'1.1.0',digest:hash({owner,newDelivery:true})}:event.pins[owner],rationale:'Synthetic reviewed disposition',changes:controls.feedbackDeliver?[{kind:'rule',identifiers:['quality'],sourcePaths:['source.txt'],explanation:'Synthetic strengthened rule'}]:[],eventId:event.id,eventDigest:event.digest,owner,workspaceId:options.workspaceId,scope,sourceDigest:hash(event.source),baseline:event.pins[owner],changedFiles:controls.feedbackDeliver?['rule.txt']:[],dependentHarness:[]};
      const review={...reviewBody,reviewDigest:hash(reviewBody)};
      const dispositionBody={review,decision:'APPROVE',humanEvidenceRef:syntheticDecisionEvidence(root,{owner,operation:'feedback.decide',workspaceId:options.workspaceId,scope,reviewDigest:review.reviewDigest,decision:'APPROVE'})};
      const inbox={event,receipt:{...receiptBody,digest:hash(receiptBody)},candidate:{id:receiptBody.candidateId,kind:owner==='harness'?'regression':'semantic-impact',evidenceDigest:event.receiptDigest,status:'REVIEW_REQUIRED'},review,disposition:controls.feedbackReady?{...dispositionBody,digest:hash(dispositionBody)}:null};inboxes.set(owner+':'+event.id,inbox);return inbox;
    },
    readFeedbackInbox:({owner,id})=>inboxes.get(owner+':'+id)??null,
    readResponseRecovery:({reference})=>({workspaceId:options.workspaceId,scope,reference,bindingId:'monitor',incidentId:finding.incidentId,serviceId:book.serviceId,environment:'test',deploymentRevision:finding.deploymentRevision,faultDigest:hash('fault'),recoveryDigest:hash('recovery'),faultAt:finding.at,recoveryAt:controls.recoveryAt??=now(),outcome:'PASS',...controls.recoveryOverride}),
  };
  if(settings.missingCollector)delete providers.collect;
  if(settings.missingInspector)delete providers.inspectCollection;
  service=createRuntimeService(options,providers);service.initialize();
  t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true});});
  const query=(operation,input={})=>service.native({operation,scope,input});
  const nativeWrite=async(operation,input)=>service.native({operation,scope,input,requestId:'native-'+(++serial),expectedRevision:(await query('workspace.inspect')).revision});
  const responseRead=(operation='response.read',input={id:'response'})=>service.response({operation,scope,input});
  const responseWrite=async(operation,input)=>service.response({operation,scope,input,requestId:'response-'+(++serial),expectedRevision:(await responseRead('response.inspect',{})).revision});
  const legacyWrite=(operation,input)=>service.execute({operation,scope,input,requestId:'legacy-'+(++serial),expectedRevision:service.execute({operation:'workspace.inspect',scope,input:{}}).revision});
  legacyWrite('project.create',{name:'Synthetic response'});legacyWrite('goal.create',{id:'goal',description:'Repair isolated generated state'});
  const project=(await nativeWrite('project.prepare',{id:'native-project',goalId:'goal',sourceScope,standardPins:standards,requirements})).result;
  const recipe=mode=>({schema:'evopilot-collection-recipe/v1',sourceScope,executable:process.execPath,executableDigest:nativeBytesDigest(fs.readFileSync(process.execPath)),argv:[source,mode],cwd:root,environment:{LANG:'C'},toolchainLockDigest:hash('node-fixture'),timeoutMs:3000,maxOutputBytes:65536,allowedOutputs:['stdout.json','stderr.txt'],network:{mode:'none',hosts:[]},selectors:[{id:'healthy',output:'stdout.json',kind:'json-pointer',pointer:'/healthy'}]});
  async function collection(id,mode){const c=(await nativeWrite('collection.prepare',{id,projectId:project.id,recipe:recipe(mode)})).result;if(!(id==='repair'&&settings.skipCollectionApproval))await nativeWrite('collection.decide',{id,reviewDigest:c.reviewDigest,decision:'APPROVE',humanEvidenceRef:decision('collection.decide',c.reviewDigest)});return c;}
  await collection('repair','repair');
  await service.online({operation:'online.repair.ingest',scope,input:{id:finding.id},requestId:'ingest',expectedRevision:(await service.online({operation:'online.inspect',scope,input:{}})).revision});
  const repair=await service.online({operation:'online.repair.inspect',scope,input:{id:finding.incidentId}});
  const prepareInput={id:'response',repairId:repair.id,repairDigest:repair.digest,problemId:problem.id,problemDigest:problem.digest,runbook,projectId:project.id,goalId:'goal',target,loop,collectionId:'repair',parameters:book.parameters,actor:'synthetic-test-operator'};
  const prepare=()=>responseWrite('response.prepare',prepareInput).then(r=>r.result);
  async function approve(){const r=await prepare();await responseWrite('response.decide',{id:r.plan.id,reviewDigest:r.reviewDigest,decision:'APPROVE',humanEvidenceRef:decision('response.decide',r.reviewDigest)});return r;}
  async function runVerification(){
    await service.feedback({operation:'feedback.configure',scope,input:{projectId:project.id},requestId:'configure-feedback-'+(++serial),expectedRevision:(await service.feedback({operation:'feedback.inspect',scope,input:{}})).revision});
    await collection('verification','verify');const collected=(await nativeWrite('collection.execute',{id:'verification'})).result,raw=collected.receipt;
    const input={schema:'runtime-composition/v1',contractDigest:NATIVE_CONTRACT_DIGEST,projectCandidateDigest:project.candidateDigest,standardPins:standards,sourceScope,requirements,effectiveConfig:{synthetic:true},nativeInputs:{ontology:{synthetic:true},harness:{observation:{schema:'evopilot-observation/v1',origin:'execution-result',source:{revision:sourceScope.revision,digest:sourceScope.treeDigest},values:raw.observations,collectionReceiptRef:{id:raw.id,digest:raw.digest,claimId:raw.claimId},sourceScopeDigest:hash(sourceScope)}}},collectionReceipts:[{id:raw.id,digest:raw.digest}]};
    const r=(await nativeWrite('run.prepare',{id:'verification-run',projectId:project.id,goalId:'goal',ontology:pin('ontology'),harness:pin('harness'),input})).result;
    await nativeWrite('run.decide',{id:r.plan.id,reviewDigest:r.reviewDigest,decision:'APPROVE',humanEvidenceRef:decision('run.decide',r.reviewDigest)});
    await nativeWrite('run.dispatch',{id:r.plan.id});return r.plan.id;
  }
  return{root,scope,options,source,book,runbook,controls,problem,prepareInput,prepare,approve,query,nativeWrite,responseRead,responseWrite,decision,runVerification,service:()=>service,restart(){service.close();service=createRuntimeService(options,providers);service.initialize();},reference,recovery:{owner:'harness',id:'regression:synthetic',digest:hash('synthetic-regression')}};
}

test('response requires exact independent review; actual action is not recovery or closure',async t=>{
  const f=await fixture(t),prepared=await f.prepare();
  await assert.rejects(f.responseWrite('response.execute',{id:'response'}),{code:'RESPONSE_APPROVAL_REQUIRED'});
  await assert.rejects(f.responseWrite('response.decide',{id:'response',reviewDigest:prepared.reviewDigest,decision:'APPROVE',humanEvidenceRef:'forged'}),{code:'HUMAN_EVIDENCE_REQUIRED'});
  await f.responseWrite('response.decide',{id:'response',reviewDigest:prepared.reviewDigest,decision:'APPROVE',humanEvidenceRef:f.decision('response.decide',prepared.reviewDigest)});
  const executed=(await f.responseWrite('response.execute',{id:'response'})).result;
  assert.equal(executed.stage,'SUCCEEDED');assert.equal(f.controls.collectCount,1);
  assert.equal(fs.readFileSync(path.join(f.root,'attempts.txt'),'utf8'),'one\n');
  assert.equal(executed.verification,null);assert.equal((await f.responseRead('response.execution.inspect',{id:'response'})).status,'UNVERIFIED');
  await assert.rejects(f.responseWrite('response.close',{id:'response',reviewDigest:prepared.reviewDigest,humanEvidenceRef:f.decision('response.close',prepared.reviewDigest)}),{code:'RESPONSE_VERIFICATION_REQUIRED'});
  f.restart();await f.responseWrite('response.execute',{id:'response'});assert.equal(f.controls.collectCount,1);
});

test('response cannot adopt, reconcile, cancel or verify a competing direct collection claim',async t=>{
  const f=await fixture(t);await f.approve();
  // Deterministic TOCTOU: another client executes after collection preflight was
  // read but before response admission can dispatch. Its process is real.
  f.controls.onEvidence=()=>f.nativeWrite('collection.execute',{id:'repair'});
  const raced=(await f.responseWrite('response.execute',{id:'response'})).result;
  assert.equal(raced.stage,'UNKNOWN');assert.equal(raced.reason,'REVISION_CONFLICT');assert.equal(raced.collection,null);
  assert.equal(f.controls.collectCount,1);assert.equal((await f.query('collection.inspect',{id:'repair'})).stage,'SUCCEEDED');
  const reconciled=(await f.responseWrite('response.reconcile',{id:'response'})).result;
  assert.equal(reconciled.stage,'UNKNOWN');assert.equal(reconciled.reason,'RESPONSE_CLAIM_UNOWNED');assert.equal(reconciled.collection,null);
  const cancelDigest=hash({responseReviewDigest:reconciled.reviewDigest,admission:reconciled.admission,operation:'response.cancel'});
  await assert.rejects(f.responseWrite('response.cancel',{id:'response',reviewDigest:cancelDigest,humanEvidenceRef:f.decision('response.cancel',cancelDigest)}),{code:'RESPONSE_CLAIM_UNOWNED'});
  await assert.rejects(f.responseWrite('response.verify',{id:'response',runId:'any',recovery:f.recovery}),{code:'RESPONSE_ACTION_INCOMPLETE'});
  f.restart();await f.responseWrite('response.execute',{id:'response'});
  assert.equal(f.controls.collectCount,1);assert.equal(f.controls.cancelCount,0);
});

test('response reconciles its own lost result after restart without executing twice',async t=>{
  const f=await fixture(t);await f.approve();f.controls.lostResponse=true;
  const before=(await f.responseWrite('response.execute',{id:'response'})).result;
  assert.equal(before.stage,'UNKNOWN');assert.equal(f.controls.collectCount,1);
  f.restart();const after=(await f.responseWrite('response.reconcile',{id:'response'})).result;
  assert.equal(after.stage,'SUCCEEDED');assert.equal(after.admission.collectionRequestId,before.admission.collectionRequestId);
  assert.equal(after.admission.nativeRevision,before.admission.nativeRevision);
  assert.equal(fs.readFileSync(path.join(f.root,'attempts.txt'),'utf8'),'one\n');assert.equal(f.controls.collectCount,1);
});

test('guidance withdrawal, stale precondition and changed source cannot dispatch',async t=>{
  const f=await fixture(t);await f.approve();f.controls.withdrawn=true;
  await assert.rejects(f.responseWrite('response.execute',{id:'response'}),{code:'RESPONSE_RUNBOOK_STALE'});
  f.controls.withdrawn=false;f.controls.evidenceAge=3601;
  await assert.rejects(f.responseWrite('response.execute',{id:'response'}),{code:'RESPONSE_PREREQUISITE'});
  f.controls.evidenceAge=0;f.controls.evidenceStatus='UNKNOWN';
  await assert.rejects(f.responseWrite('response.execute',{id:'response'}),{code:'RESPONSE_PREREQUISITE'});
  f.controls.evidenceStatus='PASS';fs.appendFileSync(f.source,'\n// changed source');
  const changed=(await f.responseWrite('response.execute',{id:'response'})).result;
  assert.equal(changed.stage,'UNKNOWN');assert.equal(f.controls.collectCount,0);
});

test('target and loop must resolve the same campaign; changed parameters are rejected',async t=>{
  const f=await fixture(t);
  for(const change of [
    i=>{[i.target,i.loop]=[i.loop,i.target];},
    i=>{i.loop.id=i.target.id+'#loop=';},
    i=>{i.loop.id=i.target.id+'-other#loop=diagnose';},
    i=>{i.target.id+='#untrusted';},
  ]){const input=structuredClone(f.prepareInput);change(input);await assert.rejects(f.responseWrite('response.prepare',input),{code:'RESPONSE_GOVERNANCE_REFS'});}
  await assert.rejects(f.responseWrite('response.prepare',{...f.prepareInput,parameters:{mode:'different'}}),{code:'RESPONSE_APPLICABILITY'});
  assert.equal((await f.responseRead('response.list',{})).length,0);assert.equal(f.controls.collectCount,0);
});

test('unclaimed cancellation preserves decision evidence and never invokes the collector',async t=>{
  const f=await fixture(t),prepared=await f.approve();
  const before=await f.responseRead('response.inspect',{}),review=await f.responseRead('response.cancel.review',{id:'response'});
  const digest=review.reviewDigest;
  assert.equal(digest,hash({responseReviewDigest:prepared.reviewDigest,admission:null,operation:'response.cancel'}));
  assert.equal(review.authority,false);assert.equal(review.effect,'CANCEL_UNCLAIMED_PLAN');
  assert.equal((await f.responseRead('response.inspect',{})).revision,before.revision);
  const cancelled=(await f.responseWrite('response.cancel',{id:'response',reviewDigest:digest,humanEvidenceRef:f.decision('response.cancel',digest)})).result;
  assert.equal(cancelled.stage,'CANCELLED');assert.ok(cancelled.cancellation.confirmedAt);assert.equal(cancelled.admission,null);
  await assert.rejects(f.responseWrite('response.execute',{id:'response'}),{code:'RESPONSE_APPROVAL_REQUIRED'});
  assert.equal(f.controls.collectCount,0);assert.equal(f.controls.cancelCount,0);
});

test('fixed guidance profile rejects empty prerequisites, instructions and unsupported operations',async()=>{
  const now=Math.floor(Date.now()/1000),base={schema:'evopilot-response-runbook/v1',id:'one',version:'1.0.0',serviceId:'service',environment:'test',sourceRevision:'r1',parameters:{},prerequisites:[{owner:'runtime',id:'collection:pre',digest:hash('pre')}],steps:[{id:'one',description:'Bound action',operation:'isolated-collection'}],stopConditions:[...RESPONSE_STOP_CONDITIONS],effectScope:'isolated-local',maxEvidenceAgeSeconds:60,expiresAt:now+60};
  assert.doesNotThrow(()=>validateResponseRunbook(base));
  for(const mutate of [v=>{v.prerequisites=[];},v=>{v.prerequisites[0].owner='workspace';},v=>{v.steps[0].operation='shell';},v=>{v.steps[0].command='curl attacker';},v=>{v.stopConditions=['stop if unsafe'];},v=>{v.effectScope='production';}]){const changed=structuredClone(base);mutate(changed);assert.throws(()=>validateResponseRunbook(changed));}
});

test('independent validation and both owner feedback dispositions are required for exact closure',async t=>{
  const f=await fixture(t);await f.approve();await f.responseWrite('response.execute',{id:'response'});
  const runId=await f.runVerification();
  const verified=(await f.responseWrite('response.verify',{id:'response',runId,recovery:f.recovery})).result;
  assert.equal(verified.stage,'VERIFIED');assert.equal(verified.verification.runId,runId);assert.equal(f.controls.collectCount,2);
  const projection=await f.responseRead('response.execution.inspect',{id:'response'});
  assert.equal(projection.status,'VERIFIED');assert.equal(projection.problemDigest,f.problem.digest);assert.equal(projection.reference.id,'response:response');
  const closed=(await f.responseWrite('response.close',{id:'response',reviewDigest:verified.verification.reviewDigest,humanEvidenceRef:f.decision('response.close',verified.verification.reviewDigest)})).result;
  assert.equal(closed.stage,'CLOSED');f.restart();assert.deepEqual(await f.responseRead(),closed);
  const collection=await f.query('collection.inspect',{id:'repair'});
  fs.writeFileSync(path.join(f.options.workspaceRoot,'state/runtime-native',collection.claim.claimId.slice(7),'stdout.json'),'tampered',{mode:0o600});
  await assert.rejects(f.responseRead('response.execution.inspect',{id:'response'}),{code:'EVIDENCE_DRIFT'});
});

test('missing reviewed asset feedback cannot be closed by an otherwise successful Run',async t=>{
  const f=await fixture(t);f.controls.feedbackReady=false;await f.approve();await f.responseWrite('response.execute',{id:'response'});
  const runId=await f.runVerification();
  await assert.rejects(f.responseWrite('response.verify',{id:'response',runId,recovery:f.recovery}),{code:'FEEDBACK_PENDING'});
  assert.equal((await f.responseRead()).stage,'SUCCEEDED');
});

for (const [field,value] of [['serviceId','another-service'],['environment','production'],['sourceRevision','other-revision']]) {
  test('applicability rejects independently published wrong '+field,async t=>{
    const f=await fixture(t);f.book[field]=value;f.runbook.digest=hash(f.book);
    await assert.rejects(f.prepare(),{code:'RESPONSE_APPLICABILITY'});
    assert.equal(f.controls.collectCount,0);assert.equal((await f.responseRead('response.list',{})).length,0);
  });
}

test('different deployment assessment cannot authorize the original incident',async t=>{
  const f=await fixture(t);f.problem.deploymentRevision='unrelated-deployment';
  const {digest,...body}=f.problem;f.problem.digest=hash(body);f.prepareInput.problemDigest=f.problem.digest;
  await assert.rejects(f.prepare(),{code:'RESPONSE_PROBLEM_DRIFT'});assert.equal(f.controls.collectCount,0);
});

for(const kind of ['workspace','project'])test('cross-'+kind+' operational evidence is rejected',async t=>{
  const f=await fixture(t);
  if(kind==='workspace')f.controls.evidenceWorkspaceId='another-workspace';
  else f.controls.evidenceScope={visibility:'private',projectId:'another-project'};
  await assert.rejects(f.prepare(),{code:'RESPONSE_SCOPE'});assert.equal(f.controls.collectCount,0);
});

test('changed approved runbook reference requires a new plan rather than reusing an old approval',async t=>{
  const f=await fixture(t);await f.approve();f.runbook.reference={...f.runbook.reference,version:'1.1.0',digest:hash('changed-package')};
  await assert.rejects(f.responseWrite('response.execute',{id:'response'}),{code:'RESPONSE_RUNBOOK_STALE'});
  assert.equal(f.controls.collectCount,0);assert.equal((await f.responseRead()).stage,'APPROVED');
});

test('expired runbook and old response review cannot be approved',async t=>{
  const f=await fixture(t),prepared=await f.prepare();
  await assert.rejects(f.responseWrite('response.decide',{id:'response',reviewDigest:hash('old-review'),decision:'APPROVE',humanEvidenceRef:f.decision('response.decide',hash('old-review'))}),{code:'RESPONSE_REVIEW'});
  f.book.expiresAt=Math.floor(Date.now()/1000)-1;f.runbook.digest=hash(f.book);
  await assert.rejects(f.responseWrite('response.decide',{id:'response',reviewDigest:prepared.reviewDigest,decision:'APPROVE',humanEvidenceRef:f.decision('response.decide',prepared.reviewDigest)}),{code:'RESPONSE_RUNBOOK_STALE'});
  assert.equal(f.controls.collectCount,0);
});

test('response approval never replaces the independent collection approval',async t=>{
  const f=await fixture(t,{skipCollectionApproval:true});
  await assert.rejects(f.prepare(),{code:'RESPONSE_COLLECTION_NOT_READY'});
  const c=await f.query('collection.inspect',{id:'repair'});
  assert.equal(c.stage,'PREPARED');assert.equal(c.decision,null);assert.equal(f.controls.collectCount,0);
});

test('immutable response request IDs reject conflicting replay and isolate other projects',async t=>{
  const f=await fixture(t),prepared=await f.prepare();
  const request={operation:'response.decide',scope:f.scope,input:{id:'response',reviewDigest:prepared.reviewDigest,decision:'APPROVE',humanEvidenceRef:f.decision('response.decide',prepared.reviewDigest)},requestId:'exact-decision',expectedRevision:(await f.responseRead('response.inspect',{})).revision};
  const result=await f.service().response(request);assert.deepEqual(await f.service().response(request),result);
  await assert.rejects(f.service().response({...request,input:{...request.input,decision:'REJECT'}}),{code:'REQUEST_CONFLICT'});
  await assert.rejects(f.service().response({operation:'response.read',scope:{visibility:'private',projectId:'another'},input:{id:'response'}}),{code:'RESPONSE_NOT_FOUND'});
  assert.equal(f.controls.collectCount,0);
});

test('reviewed DELIVER cannot close the response using a Run of the old asset pins',async t=>{
  const f=await fixture(t);f.controls.feedbackDeliver=true;await f.approve();await f.responseWrite('response.execute',{id:'response'});
  const runId=await f.runVerification();
  await assert.rejects(f.responseWrite('response.verify',{id:'response',runId,recovery:f.recovery}),{code:'FEEDBACK_NEW_RUN_REQUIRED'});
  assert.equal((await f.responseRead()).stage,'SUCCEEDED');assert.equal((await f.responseRead()).verification,null);
});

test('missing registered action provider remains incomplete and cannot claim execution',async t=>{
  const f=await fixture(t,{missingCollector:true});await f.approve();
  const result=(await f.responseWrite('response.execute',{id:'response'})).result;
  assert.equal(result.stage,'UNKNOWN');assert.equal(result.reason,'MISSING_COLLECTOR');assert.equal(result.collection,null);
  assert.equal((await f.query('collection.inspect',{id:'repair'})).claim,null);
  await f.responseWrite('response.execute',{id:'response'});assert.equal(f.controls.collectCount,0);
  const reconciled=(await f.responseWrite('response.reconcile',{id:'response'})).result;
  assert.equal(reconciled.reason,'RESPONSE_CLAIM_UNOWNED');assert.equal(f.controls.collectCount,0);
});

test('missing registered receipt inspector cannot turn uncertain action into success',async t=>{
  const f=await fixture(t,{missingInspector:true});await f.approve();f.controls.lostResponse=true;
  assert.equal((await f.responseWrite('response.execute',{id:'response'})).result.stage,'UNKNOWN');
  const reconciled=(await f.responseWrite('response.reconcile',{id:'response'})).result;
  assert.equal(reconciled.stage,'UNKNOWN');assert.equal(reconciled.reason,'MISSING_COLLECTOR');assert.equal(reconciled.collection,null);
  assert.equal(f.controls.collectCount,1);assert.equal(fs.readFileSync(path.join(f.root,'attempts.txt'),'utf8'),'one\n');
});

test('Alertmanager response requires exact owner-correlated recovery rather than same-binding evaluation incident',async t=>{
  // Owner correlation is independently exercised by the actual Harness adapter.
  // This synthetic provider checks Runtime consumes it without weakening pins.
  const f=await fixture(t,{findingSource:'alertmanager'});await f.approve();
  await f.responseWrite('response.execute',{id:'response'});const runId=await f.runVerification();
  const reference={owner:'harness',id:hash('reviewed-alertmanager-regression-link'),digest:hash('reviewed-alertmanager-regression-link')};
  f.controls.recoveryOverride={incidentId:hash({source:'evaluation',incident:'synthetic'})};
  await assert.rejects(f.responseWrite('response.verify',{id:'response',runId,recovery:reference}),{code:'RESPONSE_RECOVERY_MISMATCH'});
  assert.equal((await f.responseRead()).stage,'SUCCEEDED');
  f.controls.recoveryOverride=null;
  const verified=(await f.responseWrite('response.verify',{id:'response',runId,recovery:reference})).result;
  assert.equal(verified.stage,'VERIFIED');
  assert.equal(verified.verification.recovery.incidentId,f.prepareInput.repairId);
  assert.deepEqual(verified.verification.recovery.reference,reference);
  f.restart();assert.deepEqual((await f.responseRead('response.execution.inspect',{id:'response'})).recovery,reference);
  assert.equal(f.controls.collectCount,2,'One repair and one independent verification collection only');
});

test('linked recovery cannot weaken Runtime owner, target, source or action-time checks',async t=>{
  const f=await fixture(t,{findingSource:'alertmanager'});await f.approve();
  await f.responseWrite('response.execute',{id:'response'});const runId=await f.runVerification();
  const now=Math.floor(Date.now()/1000);
  const reference={owner:'harness',id:hash('retained-alertmanager-link'),digest:hash('retained-alertmanager-link')};
  const cases=[
    ['workspace',{workspaceId:'foreign-workspace'},'RESPONSE_SCOPE'],
    ['project',{scope:{visibility:'private',projectId:'foreign-project'}},'RESPONSE_SCOPE'],
    ['incident',{incidentId:hash('other-alertmanager-event')},'RESPONSE_RECOVERY_MISMATCH'],
    ['binding',{bindingId:'other-monitor'},'RESPONSE_RECOVERY_MISMATCH'],
    ['service',{serviceId:'other-service'},'RESPONSE_RECOVERY_MISMATCH'],
    ['environment',{environment:'production'},'RESPONSE_RECOVERY_MISMATCH'],
    ['deployment',{deploymentRevision:'other-release'},'RESPONSE_RECOVERY_MISMATCH'],
    ['reference',{reference:{...reference,digest:hash('changed-link')}},'RESPONSE_RECOVERY_MISMATCH'],
    ['unknown',{outcome:'UNKNOWN'},'RESPONSE_RECOVERY_MISMATCH'],
    ['fault-after-action',{faultAt:now+1,recoveryAt:now+2},'RESPONSE_RECOVERY_MISMATCH'],
    ['recovery-before-action',{faultAt:now-20,recoveryAt:now-10},'RESPONSE_RECOVERY_MISMATCH'],
    ['future-recovery',{recoveryAt:now+60},'RESPONSE_RECOVERY_MISMATCH'],
  ];
  for(const [name,override,code]of cases){
    f.controls.recoveryOverride=override;
    await assert.rejects(f.responseWrite('response.verify',{id:'response',runId,recovery:reference}),{code},name);
    assert.equal((await f.responseRead()).verification,null,name+' remains unverified');
  }
  assert.equal(f.controls.collectCount,2);
});
