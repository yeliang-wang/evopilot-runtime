import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectFeedbackActivationBindings, inspectFeedbackChannelReadiness, parseFeedbackProjectDraft } from '../../dist/feedback-loop/project.js';

const now = 1_800_000_000_000;
const input = {
  workspaceId: 'demo', projectId: 'tasks',
  feedbackBindingRef: 'binding:tasks/feedback',
  reviewBindingRef: 'binding:tasks/review',
  linearTeamRef: 'binding:tasks/issues',
  githubRepositoryRef: 'binding:tasks/repo',
  cursorAgentRef: 'binding:tasks/coding',
  harnessRuleRef: 'binding:tasks/checks',
  mergePolicyRef: 'binding:tasks/merge',
  reviewWindowMinutes: 60,
};
const observe = (reference, capabilities) => ({
  workspaceId: 'demo', projectId: 'tasks', reference,
  capabilities, status: 'READY', revision: 1, validUntil: now + 1000,
});
const inbound = observe(input.feedbackBindingRef, ['receive-feedback','reply']);
const review = observe(input.reviewBindingRef, ['notify','review-action']);

test('draft uses distinct scoped channel bindings and a fixed sixty-minute window', () => {
  const draft = parseFeedbackProjectDraft(input);
  assert.equal(inspectFeedbackChannelReadiness(draft, [inbound, review], now).channelsReady, true);
  assert.throws(() => parseFeedbackProjectDraft({...input, token: 'example'}), { code: 'INVALID_FIELDS' });
  assert.throws(() => parseFeedbackProjectDraft({...input, reviewWindowMinutes: 1}), { code: 'FEEDBACK_REVIEW_WINDOW' });
});

test('notification-only, expired, foreign and ambiguous channel observations fail readiness', () => {
  const draft = parseFeedbackProjectDraft(input);
  const notification = inspectFeedbackChannelReadiness(draft, [inbound, {...review, capabilities: ['notify']}], now);
  assert.deepEqual(notification.review.missing, ['review-action']);
  assert.equal(notification.channelsReady, false);
  for (const invalid of [{...review, validUntil: now}, {...review, workspaceId: 'other'}]) {
    assert.equal(inspectFeedbackChannelReadiness(draft, [inbound, invalid], now).channelsReady, false);
  }
  assert.equal(inspectFeedbackChannelReadiness(draft, [inbound, review, review], now).channelsReady, false);
});

test('one registered connection may fill both roles with the correct capability union', () => {
  const draft = parseFeedbackProjectDraft({...input, reviewBindingRef: input.feedbackBindingRef});
  const both = observe(input.feedbackBindingRef, ['receive-feedback','reply','notify','review-action']);
  assert.equal(inspectFeedbackChannelReadiness(draft, [both], now).channelsReady, true);
  assert.equal(inspectFeedbackChannelReadiness(draft, [inbound], now).channelsReady, false);
});

test('feedback activation evidence binds every provider role to the selected draft and earliest expiry', () => {
  const draft = parseFeedbackProjectDraft(input);
  const observations = [
    {...inbound, role: 'feedbackBindingRef'},
    {...review, role: 'reviewBindingRef'},
    ...['linearTeamRef','githubRepositoryRef','cursorAgentRef','harnessRuleRef','mergePolicyRef']
      .map(role => ({...observe(input[role], []), role})),
  ].map((binding, index) => ({
    ...binding, factsDigest: 'sha256:' + String(index).repeat(64),
    evidenceRef: 'evidence:providers/' + index, validUntil: now + index + 10,
  }));
  const valid = inspectFeedbackActivationBindings(draft, observations, now);
  assert.match(valid.bindingStamp, /^[a-f0-9]{64}$/);
  assert.equal(valid.validUntil, now + 10);
  assert.deepEqual(inspectFeedbackActivationBindings(draft, [...observations].reverse(), now), valid);
  for (const broken of [
    observations.slice(0,-1),
    [...observations,observations[0]],
    observations.map(row => row.role === 'cursorAgentRef' ? {...row, reference: input.githubRepositoryRef} : row),
    observations.map(row => row.role === 'linearTeamRef' ? {...row, projectId: 'different'} : row),
    observations.map(row => row.role === 'githubRepositoryRef' ? {...row, factsDigest: 'unverified'} : row),
    observations.map(row => row.role === 'reviewBindingRef' ? {...row, capabilities: ['notify']} : row),
  ]) {
    const invalid = inspectFeedbackActivationBindings(draft, broken, now);
    assert.equal(invalid.bindingStamp, null);
    assert.equal(invalid.validUntil, null);
    assert(invalid.bindings.some(binding => binding.status === 'UNVERIFIED'));
  }
  assert.equal(inspectFeedbackActivationBindings(draft, observations, now + 10).bindingStamp, null);
  const updated = observations.map(row => row.role === 'harnessRuleRef' ? {...row, revision: 2} : row);
  assert.notEqual(inspectFeedbackActivationBindings(draft, updated, now).bindingStamp, valid.bindingStamp);
});

test('actual HTTP and MCP share validation and persist incomplete drafts without activation', async () => {
  const {mkdtempSync,realpathSync,rmSync} = await import('node:fs');
  const {join} = await import('node:path');
  const {tmpdir} = await import('node:os');
  const {randomBytes} = await import('node:crypto');
  const {Client} = await import('@modelcontextprotocol/sdk/client/index.js');
  const {StreamableHTTPClientTransport} = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const {initializeCredentials,tokenDigest} = await import('../../dist/server/security.js');
  const {startRuntimeServer} = await import('../../dist/server/http.js');
  const root = mkdtempSync(join(realpathSync(tmpdir()),'runtime-v010-project-http-'));
  const token = randomBytes(32).toString('hex');
  const authorization = 'Bearer ' + token;
  const editorToken = randomBytes(32).toString('hex');
  const editorAuthorization = 'Bearer ' + editorToken;
  const editor = new Client({name:'feedback-expert-editor-probe',version:'1'});
  const client = new Client({name:'feedback-expert-transport-probe',version:'1'});
  let server;
  try {
    initializeCredentials(root,'demo',[{
      id:'expert-reader',projects:['tasks'],permissions:['read'],revision:1,expiresAt:'2099-01-01T00:00:00Z',tokenDigest:tokenDigest(token),
    },{
      id:'expert-editor',projects:['tasks'],permissions:['read','draft.write'],revision:1,expiresAt:'2099-01-01T00:00:00Z',tokenDigest:tokenDigest(editorToken),
    }]);
    server = await startRuntimeServer({stateRoot:root,workspaceId:'demo'});
    const envelope = {operation:'feedback.project.validate',projectId:'tasks',input};
    const request = (body, auth=authorization) => fetch(server.url+'/api/v1/request',{
      method:'POST',headers:{authorization:auth,'content-type':'application/json'},body:JSON.stringify(body),
    });
    const response = await request(envelope);
    assert.equal(response.status,200);
    const {result} = await response.json();
    assert.equal(result.structure,'VALID');
    assert.equal(result.providerBindings,'NOT_EVALUATED');
    assert.equal(result.activationAuthorized,false);
    assert.equal((await request({...envelope,input:{...input,workspaceId:'foreign'}})).status,403);
    assert.equal((await request({...envelope,projectId:'foreign'})).status,403);
    assert.equal((await request({...envelope,input:{...input,token:'fixture'}})).status,400);
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url+'/mcp'),{requestInit:{headers:{authorization}}}));
    const tools = await client.listTools();
    const read = tools.tools.find(row => row.name==='runtime_read');
    const write = tools.tools.find(row => row.name==='runtime_write');
    assert(read.inputSchema.properties.operation.enum.includes(envelope.operation));
    assert(!write.inputSchema.properties.operation.enum.includes(envelope.operation));
    const mcp = await client.callTool({name:'runtime_read',arguments:envelope});
    assert.notEqual(mcp.isError,true);
    assert.deepEqual(JSON.parse(mcp.content[0].text).result,result);
    const status = await request({operation:'runtime.status',projectId:'tasks',input:{}});
    assert.equal((await status.json()).result.revision,0);

    const edit = {
      operation:'feedback.project.draft.save',projectId:'tasks',requestId:'draft-1',expectedRevision:0,
      input:{workspaceId:'demo',projectId:'tasks',feedbackBindingRef:input.feedbackBindingRef},
    };
    assert.equal((await request(edit)).status,403);
    await editor.connect(new StreamableHTTPClientTransport(new URL(server.url+'/mcp'),{requestInit:{headers:{authorization:editorAuthorization}}}));
    const saved = await editor.callTool({name:'runtime_write',arguments:edit});
    assert.notEqual(saved.isError,true);
    const receipt = JSON.parse(saved.content[0].text).result;
    assert.equal(receipt.result.status,'DRAFT');
    assert.equal(receipt.result.activationAuthorized,false);
    assert(receipt.result.missingFields.includes('reviewBindingRef'));
    assert.deepEqual((await (await request(edit,editorAuthorization)).json()).result,receipt);
    assert.equal((await request({...edit,requestId:'draft-stale'},editorAuthorization)).status,409);
    assert.equal((await request({...edit,input:{...edit.input,providerBindings:'READY'}},editorAuthorization)).status,400);

    await editor.close();
    await client.close();
    await server.close();
    server = await startRuntimeServer({stateRoot:root,workspaceId:'demo'});
    const inspected = await request({operation:'feedback.project.inspect',projectId:'tasks',input:{}});
    assert.deepEqual((await inspected.json()).result,{revision:1,draft:receipt.result});
  } finally {
    await editor.close();
    await client.close();
    await server?.close();
    rmSync(root,{recursive:true,force:true});
  }
});
