import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCursorAgentAdapter,
  createCursorProviderTransport,
  prepareCursorWorkIntent,
} from '../../dist/feedback-loop/cursor.js';
import {
  createFeedbackVerification, feedbackVerificationExecutionId, prepareFeedbackVerification,
  prepareFeedbackVerificationEvaluation,
} from '../../dist/feedback-loop/verification.js';
import {digest} from '../../dist/server/errors.js';
import {NATIVE_CONTRACT_DIGEST, nativeSha256} from '../../vendor/compatibility/v1/native.mjs';

const scope = {repository:'https://github.com/example/feedback-lab', branch:'main'};
const issueId = '2be61638-313b-449d-bc53-f2c267c343b9';
const originalWork = {
  kind:'initial', caseId:'case:original', issueId, requestId:'launch:original',
  prompt:'Reproduce the export label defect in the fixture.\r\nFix the formatting once reproduced. \t',
};
const originalPR = {url:scope.repository + '/pull/13', number:13, branch:'cursor/export-label'};
const firstRunId = 'run-00000000-0000-0000-0000-000000000001';
const repairRunId = 'run-00000000-0000-0000-0000-000000000002';
const agentKey = 'bc-00000000-0000-0000-0000-000000000001';
const time = '2026-11-25T00:00:00Z';

function cursorFixture(runId = firstRunId) {
  const trace = [];
  let agent;
  let run;
  let omitReply = false;
  let transform = (_operation, response) => response;
  const transport = {
    async request(operation) {
      trace.push(structuredClone(operation));
      if (operation.kind === 'launch') {
        const {prompt, agentId, ...settings} = operation.body;
        assert.ok(prompt.text);
        agent = {id:agentId, ...settings, latestRunId:runId, status:'ACTIVE'};
        run = {id:runId, agentId, status:'RUNNING', createdAt:time, updatedAt:time};
        if (omitReply) throw Error('Provider response was lost.');
        return {agent, run};
      }
      if (!agent || operation.agentId !== agent.id) throw Error('Agent was not found.');
      const response = operation.kind === 'agent' ? agent : operation.kind === 'runs' ? {items:[run]} : run;
      return transform(operation, structuredClone(response));
    },
  };
  return {
    trace, transport,
    dropLaunchResponse() { omitReply = true; },
    shapeResponse(edit) { transform = edit; },
    finish(prUrl = originalPR.url, branch = originalPR.branch) {
      agent.status = 'IDLE';
      run.status = 'FINISHED';
      run.result = 'Reproduced and repaired the fixture.';
      run.git = {branches:[{repoUrl:scope.repository.slice(8), branch}]};
      if (prUrl !== null) run.git.branches[0].prUrl = prUrl;
    },
  };
}

test('Runtime owns the original Cursor reservation across restart and admits repair only on its existing PR', async () => {
  const {mkdtempSync,realpathSync,rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {digest} = await import('../../dist/server/errors.js');
  const {RuntimeStore} = await import('../../dist/server/store.js');
  const {createFeedbackCursorWorker} = await import('../../dist/feedback-loop/worker.js');
  const root = mkdtempSync(join(realpathSync(tmpdir()),'runtime-v010-cursor-worker-'));
  const actor = {id:'worker',projects:['feedback'],permissions:['read','execution.request'],revision:1,expiresAt:'2099-01-01T00:00:00Z'};
  const selection = {projectId:'feedback',caseId:originalWork.caseId,round:0};
  const provider = cursorFixture();
  provider.dropLaunchResponse();
  provider.shapeResponse(() => { throw new Error('Readback temporarily unavailable'); });
  let store = new RuntimeStore(root,'demo');
  try {
    const activation = {workspaceId:'demo',projectId:selection.projectId,serviceId:store.serviceId};
    const activationId = 'sha256:'+digest(activation);
    store.mutate(actor,{
      projectId:selection.projectId,operation:'fixture.ready',requestId:'ready',expectedRevision:0,input:{},
      permission:'execution.request',
    },() => ({
      value:{},event:{type:'fixture-ready',data:{}},
      objects:[
        {kind:'feedback-case',id:selection.caseId,value:{
          id:selection.caseId,workspaceId:'demo',projectId:selection.projectId,
        }},
        {kind:'feedback-case-issue',id:selection.caseId,value:{source:'FIXTURE',issueId}},
        {kind:'feedback-activation',id:activationId,value:{subject:activation,candidateDigest:activationId}},
        {kind:'feedback-activation-pointer',id:'current',value:activationId},
      ],
    }));
    let canRepair = false;
    const expiresAt = Date.now()+60000;
    const readGrant = subject => {
      if (subject.round && !canRepair) return null;
      assert.equal(subject.issueId,issueId);
      assert.equal(subject.activationId,activationId);
      return {
        subjectDigest:digest(subject),evidenceRef:'evidence:fixture/'+subject.round,
        prompt:originalWork.prompt,expiresAt,maxRepairs:1,
      };
    };
    const worker = (transport, permit = readGrant) =>
      createFeedbackCursorWorker(store,scope,createCursorAgentAdapter(scope,transport),permit,() => actor);
    let reservationAtLaunch;
    const trackingTransport = {async request(operation) {
      if (operation.kind === 'launch') {
        const [saved] = store.objectsPage(selection.projectId,'feedback-cursor-attempt');
        reservationAtLaunch = saved.value.intent;
      }
      return provider.transport.request(operation);
    }};
    const initial = await worker(trackingTransport).advance(actor,selection);
    assert.equal(initial.status,'UNKNOWN');
    assert.equal(reservationAtLaunch.agentId,initial.agentId);
    assert.equal(reservationAtLaunch.requestId,store.objectsPage(selection.projectId,'feedback-cursor-attempt')[0].id);
    store.close();
    store = new RuntimeStore(root,'demo');
    provider.shapeResponse((_operation,response) => response);
    provider.finish();
    const resumed = await worker(provider.transport,() => {throw Error('Recovery must use the original intent');}).advance(actor,selection);
    assert.equal(resumed.realization.runId,firstRunId);
    assert.deepEqual(resumed.realization.pullRequest,originalPR);
    assert.equal(provider.trace.filter(item => item.kind==='launch').length,1);
    const repairProvider = cursorFixture(repairRunId);
    const repairWorker = worker(repairProvider.transport);
    const selectionRepair = {...selection,round:1};
    await assert.rejects(repairWorker.advance(actor,selectionRepair),{code:'FEEDBACK_CURSOR_ADMISSION'});
    assert.equal(repairProvider.trace.length,0);
    canRepair = true;
    await repairWorker.advance(actor,selectionRepair);
    repairProvider.finish(null);
    const repaired = await repairWorker.advance(actor,selectionRepair);
    assert.equal(repaired.realization.runId,repairRunId);
    assert.deepEqual(repaired.realization.pullRequest,originalPR);
    const launches = repairProvider.trace.filter(item => item.kind==='launch');
    assert.equal(launches.length,1);
    assert.deepEqual(launches[0].body.repos,[{url:scope.repository,prUrl:originalPR.url}]);
    await assert.rejects(repairWorker.advance(actor,{...selection,round:2}),{code:'FEEDBACK_CURSOR_ADMISSION'});
  } finally {
    store.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test('retains the original Cursor launch across a lost response and a new adapter instance', async () => {
  const provider = cursorFixture();
  provider.dropLaunchResponse();
  const intent = prepareCursorWorkIntent(scope, originalWork);
  const first = createCursorAgentAdapter(scope, provider.transport);
  const active = await first.dispatch(intent, 'RESERVED');
  assert.equal(active.status, 'OBSERVED');
  assert.equal(active.realization.status, 'RUNNING');
  assert.equal(active.realization.runId, firstRunId);
  assert.equal(active.realization.source, 'FIXTURE');
  assert.equal(active.realization.pullRequest, null);
  assert.deepEqual(provider.trace[0], {kind:'launch', body:{
    agentId:intent.agentId, name:'evopilot-' + intent.intentId, env:{type:'cloud'},
    repos:[{url:scope.repository,startingRef:scope.branch}],
    workOnCurrentBranch:false, autoCreatePR:true, prompt:{text:originalWork.prompt},
  }});
  assert.ok(Object.isFrozen(active.realization));
  provider.finish();
  const restarted = createCursorAgentAdapter(scope, provider.transport);
  const persisted = JSON.parse(JSON.stringify(intent));
  const completed = await restarted.reconcile(persisted, active.realization.runId);
  assert.equal(completed.status, 'OBSERVED');
  assert.deepEqual(completed.realization.pullRequest, originalPR);
  assert.equal(completed.realization.status, 'FINISHED');
  assert.match(completed.realization.resultDigest, /^[a-f0-9]{64}$/);
  assert.equal(completed.realization.intentId, intent.intentId);
  assert.ok(Object.isFrozen(completed.realization.pullRequest));
  await assert.rejects(restarted.dispatch(persisted, 'REUSED'), {code:'CURSOR_RECONCILE_ORIGINAL'});
  assert.equal(provider.trace.filter(call => call.kind === 'launch').length, 1);
});

test('requires exact original intent and confirmed agent scope and sole Run', async () => {
  const provider = cursorFixture();
  const intent = prepareCursorWorkIntent(scope, originalWork);
  const adapter = createCursorAgentAdapter(scope, provider.transport);
  await assert.rejects(adapter.dispatch({...intent, prompt:intent.prompt.trimEnd()}, 'RESERVED'), {code:'CURSOR_INTENT_MISMATCH'});
  await assert.rejects(createCursorAgentAdapter({...scope, branch:'other'}, provider.transport).reconcile(intent), {code:'CURSOR_INTENT_MISMATCH'});
  assert.equal(provider.trace.length, 0);
  assert.equal((await adapter.reconcile(intent)).status, 'UNKNOWN');
  await adapter.dispatch(intent, 'RESERVED');
  provider.finish();
  for (const change of [
    (op, res) => op.kind === 'agent' ? {...res,name:'copied request'} : res,
    (op, res) => op.kind === 'agent' ? {...res,repos:[{url:scope.repository,startingRef:'other'}]} : res,
    (op, res) => op.kind === 'agent' ? {...res,workOnCurrentBranch:true} : res,
    (op, res) => op.kind === 'agent' ? {...res,autoCreatePR:false} : res,
    (op, res) => op.kind === 'agent' ? {...res,env:{type:'pool'}} : res,
    (op, res) => op.kind === 'agent' ? {...res,latestRunId:repairRunId} : res,
    (op, res) => op.kind === 'runs' ? {...res,nextCursor:firstRunId} : res,
    (op, res) => op.kind === 'runs' ? {items:[res.items[0], {...res.items[0],id:repairRunId}]} : res,
    (op, res) => op.kind === 'run' ? {...res,id:repairRunId} : res,
    (op, res) => op.kind === 'run' ? {...res,agentId:agentKey} : res,
    (op, res) => op.kind === 'run' ? {...res,git:{branches:[]}} : res,
    (op, res) => op.kind === 'run' ? {...res,git:{branches:[{repoUrl:'github.com/other/repo',branch:originalPR.branch,prUrl:originalPR.url}]}} : res,
  ]) {
    provider.shapeResponse(change);
    assert.deepEqual(await adapter.reconcile(intent, firstRunId), {
      status:'UNKNOWN', intentId:intent.intentId, agentId:intent.agentId, runId:firstRunId,
    });
  }
  // Once a provider Run is known, a different Run never replaces it.
  provider.shapeResponse((_op, res) => res);
  assert.deepEqual(await adapter.reconcile(intent, repairRunId), {
    status:'UNKNOWN', intentId:intent.intentId, agentId:intent.agentId, runId:repairRunId,
  });
  assert.equal(provider.trace.filter(call => call.kind === 'launch').length, 1);
});

test('repairs the exact original PR through its own client-identified Cursor launch', async () => {
  const first = cursorFixture();
  const firstAdapter = createCursorAgentAdapter(scope, first.transport);
  const original = prepareCursorWorkIntent(scope, originalWork);
  await firstAdapter.dispatch(original, 'RESERVED');
  first.finish();
  const prior = (await firstAdapter.reconcile(original, firstRunId)).realization;
  const request = {
    kind:'repair', caseId:original.caseId, issueId, requestId:'launch:repair',
    prompt:'Fix the escaping mismatch flagged by verification of PR #13.',
    original, prior,
  };
  assert.throws(() => prepareCursorWorkIntent(scope, {...request, issueId:'other'}), {code:'CURSOR_ORIGINAL_PR'});
  assert.throws(() => prepareCursorWorkIntent(scope, {...request, prior:{...prior,pullRequest:{...originalPR,url:null,number:null}}}),
    {code:'CURSOR_ORIGINAL_PR'});

  const intent = prepareCursorWorkIntent(scope, request);
  const provider = cursorFixture(repairRunId);
  provider.dropLaunchResponse();
  const adapter = createCursorAgentAdapter(scope, provider.transport);
  const launch = await adapter.dispatch(intent, 'RESERVED');
  assert.equal(launch.realization.runId, repairRunId);
  assert.notEqual(launch.realization.agentId, prior.agentId);
  assert.deepEqual(provider.trace[0].body, {
    agentId:intent.agentId, name:'evopilot-' + intent.intentId, env:{type:'cloud'},
    repos:[{url:scope.repository,prUrl:originalPR.url}],
    workOnCurrentBranch:true, autoCreatePR:false, prompt:{text:request.prompt},
  });
  provider.finish(scope.repository + '/pull/14');
  assert.equal((await adapter.reconcile(intent, repairRunId)).status, 'UNKNOWN');
  provider.finish(null, 'cursor/replacement');
  assert.equal((await adapter.reconcile(intent, repairRunId)).status, 'UNKNOWN');
  provider.finish(null);
  provider.shapeResponse((op, res) => op.kind === 'agent' ? {...res,repos:[{url:scope.repository,startingRef:originalPR.branch}]} : res);
  assert.equal((await adapter.reconcile(intent, repairRunId)).status, 'UNKNOWN');
  provider.shapeResponse((_op, res) => res);
  const repaired = await adapter.reconcile(JSON.parse(JSON.stringify(intent)), repairRunId);
  assert.equal(repaired.realization.status, 'FINISHED');
  assert.deepEqual(repaired.realization.pullRequest, originalPR);
  assert.equal(provider.trace.filter(call => call.kind === 'launch').length, 1);
  const official = createCursorAgentAdapter(scope, createCursorProviderTransport('secret:cursor/test', () => {
    assert.fail('Fixture provenance must be rejected before resolving credentials.');
  }));
  await assert.rejects(official.dispatch(intent, 'RESERVED'), {code:'CURSOR_PROVENANCE_MISMATCH'});
});

test('provider HTTP transport uses the protected reference, fixed API host and bounded response', async t => {
  const calls = [];
  const resolved = [];
  const key = 'fixture-key-value';
  t.mock.method(globalThis,'fetch', async (url, options) => {
    calls.push({url,options});
    if (options.method === 'POST') return new Response(null,{status:503});
    return new Response('x'.repeat(262145),{status:200});
  });
  const ref = 'secret:cursor/test';
  assert.throws(() => createCursorProviderTransport(key, () => key), {code:'CURSOR_CREDENTIAL_REFERENCE'});
  const transport = createCursorProviderTransport(ref, value => {
    resolved.push(value);
    return key;
  });
  const intent = prepareCursorWorkIntent(scope, originalWork);
  const adapter = createCursorAgentAdapter(scope, transport);
  await assert.rejects(adapter.dispatch(intent, 'RESERVED'), {code:'CURSOR_AUTHORITY_REQUIRED'});
  const revoked = new Error('Fixture authority revoked.');
  await assert.rejects(adapter.dispatch(intent, 'RESERVED', () => {throw revoked;}), error => error === revoked);
  assert.equal(calls.length,0);
  resolved.length = 0;
  let checked = false;
  assert.equal((await adapter.dispatch(intent, 'RESERVED', () => {checked = true;})).status, 'UNKNOWN');
  assert.equal(checked,true);
  assert.deepEqual(resolved, [ref,ref]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.cursor.com/v1/agents');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[1].url, 'https://api.cursor.com/v1/agents/' + intent.agentId);
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(calls[1].options.body, undefined);
  for (const {options} of calls) {
    assert.equal(options.headers.Authorization, 'Bearer ' + key);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.equal(JSON.parse(calls[0].options.body).prompt.text, originalWork.prompt);
  assert.ok(!calls[0].options.body.includes(key));
});

{
  const projectId = 'feedback-lab', workspaceId = 'fixture-workspace', caseId = 'fixture-case';
  const now = Date.now(), clock = delta => new Date(now + delta).toISOString();
  const actor = {id:'fixture', revision:1, projects:[projectId], permissions:['read'], expiresAt:clock(60000)};
  const cursorScope = {repository:'https://github.com/example/feedback-lab', branch:'main'};
  const originalPR = {number:13, url:cursorScope.repository + '/pull/13', branch:'cursor/repair'};
  const pullRequest = {source:'FIXTURE', repositoryId:'42', number:13, branch:originalPR.branch, head:'6'.repeat(40), base:'7'.repeat(40)};
  const workInput = {caseId, issueId:'linear-issue', requestId:'original-request', prompt:'Reproduce and repair the fixture defect.'};
  const initialIntent = prepareCursorWorkIntent(cursorScope, {...workInput, kind:'initial'});
  function finished(intent, id, start, finish) {
    return {source:'FIXTURE', status:'FINISHED', agentId:intent.agentId, intentId:intent.intentId, scopeDigest:intent.scopeDigest,
      runId:`run-00000000-0000-0000-0000-00000000000${id}`, resultDigest:digest('Cursor claimed success'),
      pullRequest:originalPR, createdAt:clock(start), updatedAt:clock(finish)};
  }
  const original = {intent:initialIntent, run:finished(initialIntent, 1, -5000, -4000)};
  const repairIntent = prepareCursorWorkIntent(cursorScope, {...workInput, kind:'repair', requestId:'repair-request',
    prompt:'Fix the original PR', original:original.intent, prior:original.run});
  const repair = {intent:repairIntent, run:finished(repairIntent, 2, -3500, -3000)};
  const rule = {
    bindingRef:'binding:harness/feedback-quality', ownerRegistrationDigest:nativeSha256('synthetic-harness-registration'),
    publicationRequestId:'synthetic-publication', toolchainLockDigest:nativeSha256('synthetic-toolchain'),
    effectiveConfigDigest:nativeSha256('synthetic-config'), executorRef:'binding:executor/functional-verifier',
    executorBindingDigest:nativeSha256('synthetic-verifier-registration'), validUntil:now + 60000,
    scope:{projectId, visibility:'private'}, reference:{product:'harness', id:'feedback-check', version:'1.0.0', specVersion:'v1',
      visibility:'private', digest:nativeSha256('rule'), standardDigest:nativeSha256('standard'), standardLockDigest:nativeSha256('lock'),
      producer:{product:'harness', version:'0.3.0'}, contractDigest:NATIVE_CONTRACT_DIGEST},
  };
  const subjectInput = {workspaceId, projectId, caseId, activationId:nativeSha256('activation'), scope:cursorScope, original,
    work:original, pullRequest, rule};
  const initial = prepareFeedbackVerification(subjectInput);
  const repaired = prepareFeedbackVerification({...subjectInput, work:repair, pullRequest:{...pullRequest, head:'8'.repeat(40)}});

  const publishedPackage = {manifest:{entrypoints:{coverage:'coverage.json'}},
    files:{'coverage.json':JSON.stringify({requirements:[{id:'H001', caseIds:['functional']}]})}};
  function fixture() {
    const executions = new Map(), receipts = new Map();
    const baseline = {reference:rule.reference, effectiveConfigDigest:rule.effectiveConfigDigest,
      executionStatus:'SUCCEEDED', qualityStatus:'PASS'};
    const publishedResult = {published:true, reference:rule.reference};
    receipts.set(rule.publicationRequestId, {operation:'native.package.publish', requestId:rule.publicationRequestId,
      status:'SUCCEEDED', scope:rule.scope, result:publishedResult});
    const owner = {
      owner:'harness', workspaceId, capabilities:() => ({registrationDigest:rule.ownerRegistrationDigest}),
      async readPackage() {
        return {published:true, workspaceId, scope:rule.scope, reference:rule.reference, package:publishedPackage,
          validation:{...baseline, reportDigest:nativeSha256(baseline)}};
      },
      async read(_actor, project, request) {
        assert.equal(project, projectId);
        assert.equal(request.operation, 'native.receipt.inspect');
        return structuredClone(receipts.get(request.input.requestId));
      },
    };
    function retain(subject, status, transformReport = value => value) {
      const requestId = feedbackVerificationExecutionId(subject);
      const original = {schema:'runtime-feedback-verification-execution/v1', source:'FIXTURE', subjectDigest:subject.subjectDigest,
        requestId, executorRef:rule.executorRef, executorBindingDigest:rule.executorBindingDigest, executionId:`test-run-${requestId}`,
        startedAt:now-2000, completedAt:now-1000, expiresAt:now+60000, receiptRef:`fixture:execution/${requestId}`,
        receiptDigest:nativeSha256({requestId, status}), reportDigest:nativeSha256({requestId, result:status}), status};
      executions.set(requestId, original);
      const {request, action, pin} = prepareFeedbackVerificationEvaluation(subject, original, publishedPackage);
      const criteria = pin.criteria.map(criterion => ({...criterion, status, evidenceDigest:nativeSha256(criterion)}));
      const report = transformReport({schema:'evopilot-native-validation/v1', owner:'harness', context:action.context,
        toolchainLockDigest:rule.toolchainLockDigest, effectiveConfigDigest:rule.effectiveConfigDigest, reference:rule.reference,
        qualityStatus:status, executionStatus:'SUCCEEDED', observationDigest:action.observationDigest, criteria, rawReports:[]});
      receipts.set(request.requestId, {requestId:request.requestId, operation:request.operation, scope:request.scope,
        status:'SUCCEEDED', requestDigest:nativeSha256({operation:request.operation, scope:request.scope, input:request.input}),
        result:{...report, reportDigest:nativeSha256(report)}});
      return {execution:original, request, receipt:receipts.get(request.requestId)};
    }
    function verifier(source = 'FIXTURE') {
      return createFeedbackVerification({source, owner, async readExecution(_actor, subject, requestId) {
        assert.equal(feedbackVerificationExecutionId(subject),requestId);
        return structuredClone(executions.get(requestId) ?? null);
      }});
    }
    return {owner, verifier, retain, executions, receipts};
  }
  const inspect = (fixture, subject, readCandidate = async () => subject.pullRequest) =>
    fixture.verifier().inspect(actor, structuredClone(subject), {signal:new AbortController().signal, readCandidate});

  test('binds independent FAIL and PASS to successive heads in the same original Cursor case', async () => {
    const f = fixture(), first = f.retain(initial, 'FAIL');
    const failure = await inspect(f, initial);
    assert.equal(failure.status, 'FAIL');
    assert.equal(failure.evidence.source, 'FIXTURE');
    assert.equal(failure.evidence.execution.receiptDigest, first.execution.receiptDigest);
    assert.equal(failure.evidence.harnessReceiptDigest, nativeSha256(first.receipt));
    assert.equal(failure.evidenceDigest, digest(failure.evidence));
    assert.deepEqual(await inspect(f, initial), failure, 'Original evidence survives recreation of the consumer');
    assert.equal((await inspect(f, initial, async () => repaired.pullRequest)).reason, 'CANDIDATE_CHANGED');
    f.executions.set(feedbackVerificationExecutionId(repaired), first.execution);
    assert.equal((await inspect(f, repaired)).reason, 'EXECUTION_MISMATCH');
    const second = f.retain(repaired, 'PASS');
    const pass = await inspect(f, repaired);
    assert.equal(pass.status, 'PASS');
    assert.notEqual(pass.evidenceDigest, failure.evidenceDigest);
    assert.notEqual(first.request.requestId, second.request.requestId);
    assert.equal(repaired.original.run.runId, initial.original.run.runId);
    assert.equal(repaired.pullRequest.number, initial.pullRequest.number);
  });

  test('holds after a concurrent head or base change and covers missing observations', async () => {
    const f = fixture();
    f.retain(initial,'PASS');
    for (const field of ['head','base']) {
      let reads = 0;
      assert.equal((await inspect(f, initial, async () => ++reads === 1 ? pullRequest : {...pullRequest, [field]:'f'.repeat(40)})).reason,
        'CANDIDATE_CHANGED');
      assert.equal(reads, 2);
    }
    assert.equal((await inspect(f, initial, async () => null)).reason,'CANDIDATE_UNAVAILABLE');
  });

  test('requires exact current independently recorded evidence and an original published native verdict', async () => {
    const f = fixture();
    assert.equal((await inspect(f,initial)).reason,'EXECUTION_UNAVAILABLE');
    const {execution, request, receipt} = f.retain(initial,'PASS');
    f.executions.set(execution.requestId,{...execution, expiresAt:now - 1});
    assert.equal((await inspect(f,initial)).reason,'EXECUTION_STALE');
    f.executions.set(execution.requestId,{...execution, reportDigest:nativeSha256('another raw report')});
    assert.equal((await inspect(f,initial)).reason,'HARNESS_UNDECIDABLE');
    f.executions.set(execution.requestId,execution);
    f.receipts.set(request.requestId,{...receipt,status:'RUNNING'});
    assert.equal((await inspect(f,initial)).reason,'HARNESS_UNDECIDABLE');
    f.receipts.set(request.requestId,{...receipt,status:'FAILED'});
    assert.equal((await inspect(f,initial)).reason,'HARNESS_UNDECIDABLE');
    f.retain(initial,'PASS', report => ({...report, criteria:report.criteria.slice(1)}));
    assert.equal((await inspect(f,initial)).reason,'HARNESS_UNDECIDABLE');
    f.retain(initial,'FAIL', report => ({...report,criteria:report.criteria.map(criterion => ({...criterion,status:'SKIPPED'}))}));
    assert.equal((await inspect(f,initial)).reason,'HARNESS_UNDECIDABLE');
    f.retain(initial,'PASS', report => ({...report,qualityStatus:'FAIL',criteria:report.criteria.map(criterion => ({...criterion,status:'FAIL'}))}));
    assert.equal((await inspect(f,initial)).reason,'VERDICT_MISMATCH');
    f.retain(initial,'PASS');
    f.receipts.delete(rule.publicationRequestId);
    assert.equal((await inspect(f,initial)).reason,'RULE_UNVERIFIED');
    const expired = prepareFeedbackVerification({...subjectInput, rule:{...rule,validUntil:now-1}});
    assert.equal((await inspect(f,expired)).reason,'RULE_STALE');
  });

  test('holds mixed provider provenance and binds case, activation, original run and rule', async () => {
    const f = fixture();
    const work = f.retain(initial,'PASS');
    assert.throws(() => prepareFeedbackVerification({...subjectInput,pullRequest:{...pullRequest,source:'GITHUB_PROVIDER'}}),
      {code:'FEEDBACK_VERIFICATION_PROVENANCE'});
    assert.equal((await f.verifier('PROTECTED').inspect(actor, initial, {signal:new AbortController().signal,
      readCandidate:async () => pullRequest})).reason,'PROVENANCE_MISMATCH');
    f.executions.set(work.execution.requestId,{...work.execution,source:'PROTECTED'});
    assert.equal((await inspect(f,initial)).reason,'PROVENANCE_MISMATCH');
    assert.throws(() => prepareFeedbackVerification({...subjectInput,caseId:'other-case'}), {code:'FEEDBACK_VERIFICATION_SUBJECT'});
    for (const variation of [
      {activationId:nativeSha256('new-activation')},
      {rule:{...rule, publicationRequestId:'another-publication'}},
      {pullRequest:{...pullRequest,base:'e'.repeat(40)}},
      (() => {const changed = {...original, run:{...original.run,runId:'run-10000000-0000-0000-0000-000000000001'}};
        return {original:changed,work:changed};})(),
    ]) {
      const changed = prepareFeedbackVerification({...subjectInput, ...variation});
      assert.notEqual(changed.subjectDigest, initial.subjectDigest);
    }
  });
}
