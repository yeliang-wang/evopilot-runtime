import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCursorAgentAdapter,
  createCursorProviderTransport,
  prepareCursorWorkIntent,
} from '../../dist/feedback-loop/cursor.js';

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
  assert.equal((await adapter.dispatch(intent, 'RESERVED')).status, 'UNKNOWN');
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
