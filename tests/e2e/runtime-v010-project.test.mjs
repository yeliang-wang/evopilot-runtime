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

test('Expert transport enables only the exact current draft with independently verified owner approval', async () => {
  const {mkdtempSync,realpathSync,rmSync} = await import('node:fs');
  const {join} = await import('node:path');
  const {tmpdir} = await import('node:os');
  const {randomBytes} = await import('node:crypto');
  const {Client} = await import('@modelcontextprotocol/sdk/client/index.js');
  const {StreamableHTTPClientTransport} = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const {initializeCredentials,tokenDigest} = await import('../../dist/server/security.js');
  const {startRuntimeServer} = await import('../../dist/server/http.js');
  const {lifecycle,syntheticBindings,yaml} = await import('../fixtures/lifecycle-v090.mjs');
  const root = mkdtempSync(join(realpathSync(tmpdir()),'runtime-v010-activation-http-'));
  const owner = 'accountable-owner';
  const ownerToken = randomBytes(32).toString('hex'), otherToken = randomBytes(32).toString('hex');
  const ownerPermissions = ['read','draft.write','definition.activate','decision.record'];
  const bindings = syntheticBindings();
  const roles = ['feedbackBindingRef','reviewBindingRef','linearTeamRef','githubRepositoryRef','cursorAgentRef','harnessRuleRef','mergePolicyRef'];
  let approval = null, policyRevision = 1, providerReads = 0;
  let onObservation;
  const registry = {
    async observe() {
      providerReads++;
      const observations = roles.map((role,index) => ({
        ...observe(input[role],index === 0 ? inbound.capabilities : index === 1 ? review.capabilities : []),
        role,validUntil:Date.now()+60_000,evidenceRef:`evidence:fixture/${providerReads}-${index}`,
        factsDigest:'sha256:' + String(index).repeat(64),
      }));
      onObservation?.();
      return observations;
    },
    policy:() => ({revision:policyRevision,digest:'sha256:'+'a'.repeat(64),ownerId:owner,ownerRevision:1,validUntil:Date.now()+60_000}),
    // The fixture models a protected reviewer record independently of the request.
    verifyDecision: decision => approval !== null && Object.entries(approval).every(([key,value]) => decision[key] === value),
  };
  const client = new Client({name:'feedback-activation-fixture',version:'1'});
  let server;
  try {
    initializeCredentials(root,'demo',[{id:owner,token:ownerToken},{id:'other-editor',token:otherToken}].map(({id,token}) => ({
      id,projects:['tasks'],permissions:ownerPermissions,revision:1,expiresAt:'2099-01-01T00:00:00Z',tokenDigest:tokenDigest(token),
    })));
    server = await startRuntimeServer({stateRoot:root,workspaceId:'demo'},bindings.provider,
      undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,registry);
    const request = async (operation, input={}, meta={}, token=ownerToken) => {
      const response = await fetch(server.url+'/api/v1/request',{
        method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
        body:JSON.stringify({operation,projectId:'tasks',input,...meta}),
      });
      return {status:response.status,...await response.json()};
    };
    const source = yaml(lifecycle('github','tasks'));
    const validated = await request('lifecycle.definition.validate',{yaml:source});
    assert.equal(validated.status,200,JSON.stringify(validated));
    const active = await request('lifecycle.definition.save-and-activate',{
      yaml:source,validationDigest:validated.result.validationDigest,
    },{requestId:'native-definition-enable',expectedRevision:0});
    assert.equal(active.result.result.status,'ACTIVE',JSON.stringify(active));
    const jsonPost = (path,input,headers) => fetch(server.url+path,{
      method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(input),
    });
    const issue = await jsonPost('/api/v1/dashboard-code',{projectId:'tasks'},{authorization:'Bearer '+ownerToken});
    assert.equal(issue.status,200);
    const exchange = await jsonPost('/api/v1/dashboard/session',{code:(await issue.json()).result.code},{origin:server.url});
    assert.equal(exchange.status,200);
    const headers = {
      origin:server.url,cookie:exchange.headers.get('set-cookie').split(';')[0],
      'x-runtime-csrf':(await exchange.json()).result.csrf,
    };
    const browser = (operation,input={},meta={},overrides={}) => jsonPost('/api/v1/dashboard/request',{
      operation,projectId:'tasks',input,...meta,
    },{...headers,...overrides});
    const saveMeta = {requestId:'feedback-draft',expectedRevision:1};
    const browserSource = {yaml:'# 审阅用 YAML 注释\r\n'+yaml(input).replaceAll('\n','\r\n')};
    assert.equal((await browser('feedback.project.draft.save',browserSource,saveMeta,{'x-runtime-csrf':'incorrect'})).status,403);
    assert.equal((await browser('feedback.project.draft.save',browserSource,{...saveMeta,projectId:'foreign'})).status,403);
    for (const [invalid,error] of [
      [browserSource.yaml+'workspaceId: demo\n','FEEDBACK_YAML_INVALID'],
      [browserSource.yaml.replace('workspaceId: demo','workspaceId: &scope demo'),'FEEDBACK_YAML_INVALID'],
      [browserSource.yaml.replace('workspaceId: demo','workspaceId: foreign'),'FEEDBACK_PROJECT_SCOPE'],
      [browserSource.yaml+'token: plaintext\n','INLINE_SECRET'],
      ['# '+ '中'.repeat(6000),'FEEDBACK_YAML_LIMIT'],
    ]) {
      const denied = await browser('feedback.project.draft.save',{yaml:invalid},saveMeta);
      assert.equal((await denied.json()).error.code,error);
    }
    const saved = await browser('feedback.project.draft.save',browserSource,saveMeta);
    assert.equal(saved.status,200,JSON.stringify(saved));
    assert.equal((await saved.json()).result.result.activationAuthorized,false);
    const readback = (await (await browser('feedback.project.inspect')).json()).result.draft;
    assert.equal(readback.yaml,browserSource.yaml);
    assert.deepEqual(readback.configuration,input);
    const checked = (await (await browser('feedback.project.validate',browserSource)).json()).result;
    assert.equal(checked.structure,'VALID');
    assert.equal(checked.yamlDigest,readback.yamlDigest);
    const previewOp = 'feedback.project.activation.preview', activateOp = 'feedback.project.activate';
    assert.equal((await browser(previewOp)).status,403);
    assert.equal((await request(previewOp,{},{},otherToken)).error.code,'FEEDBACK_ACTIVATION_OWNER');
    onObservation = () => { policyRevision++; };
    const mixed = await request(previewOp);
    assert.equal(mixed.error?.code,'FEEDBACK_ACTIVATION_STALE');
    assert.equal((await request('feedback.project.inspect')).result.active,undefined);
    onObservation = undefined;
    const preview = await request(previewOp);
    assert.equal(preview.status,200,JSON.stringify(preview));
    assert.equal(preview.result.subject.definitionRevision,active.result.result.activeRevisionId);
    assert.equal(preview.result.subject.yamlDigest,readback.yamlDigest);
    assert.equal(preview.result.executionAuthorized,false);
    const activationInput = {candidateDigest:preview.result.candidateDigest,decision:'approve',evidenceRef:'evidence:approval/owner-1'};
    const meta = {requestId:'approved-feedback-activation',expectedRevision:preview.result.subject.projectRevision};
    assert.equal((await request(activateOp,activationInput,meta)).error.code,'FEEDBACK_ACTIVATION_DECISION');
    approval = {
      ...activationInput,projectId:'tasks',workspaceId:'demo',actorId:owner,actorRevision:1,
    };
    const browserActivation = await browser(activateOp,activationInput,meta);
    assert.equal(browserActivation.status,403);
    assert.equal((await browserActivation.json()).error.code,'DASHBOARD_OPERATION');
    policyRevision++;
    assert.equal((await request(activateOp,activationInput,meta)).error.code,'FEEDBACK_ACTIVATION_STALE');
    policyRevision--;
    bindings.state.revision = 'native-binding-2';
    assert.equal((await request(activateOp,activationInput,meta)).error.code,'FEEDBACK_LIFECYCLE_BINDINGS');
    bindings.state.revision = 'synthetic-1';
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url+'/mcp'),{
      requestInit:{headers:{authorization:'Bearer '+ownerToken}},
    }));
    const call = await client.callTool({name:'runtime_write',arguments:{operation:activateOp,projectId:'tasks',input:activationInput,...meta}});
    assert.notEqual(call.isError,true,JSON.stringify(call));
    const receipt = JSON.parse(call.content[0].text).result;
    assert.deepEqual(receipt.result,{status:'ACTIVE',activationId:activationInput.candidateDigest,executionAuthorized:false,releaseAuthorized:false});
    const readsAfterActivation = providerReads;
    assert.deepEqual((await request(activateOp,activationInput,meta)).result,receipt);
    assert.equal(providerReads,readsAfterActivation);
    assert.equal((await request(activateOp,{...activationInput,evidenceRef:'evidence:approval/other'},meta)).error.code,'REQUEST_CONFLICT');
    assert.equal((await request('lifecycle.definition.inspect')).result.active.id,active.result.result.activeRevisionId);
    await client.close();
    await server.close();
    server = await startRuntimeServer({stateRoot:root,workspaceId:'demo'});
    const restarted = (await request('feedback.project.inspect')).result;
    assert.equal(restarted.draft.yaml,browserSource.yaml);
    assert.equal(restarted.draft.yamlDigest,readback.yamlDigest);
    assert.deepEqual(restarted.active,{
      activationId:activationInput.candidateDigest,draftDigest:preview.result.subject.draftDigest,matchesSavedDraft:true,
    });
    const editedYaml = browserSource.yaml.replace('审阅用 YAML 注释','重新编辑的 YAML 注释');
    const edited = await request('feedback.project.draft.save',{yaml:editedYaml},{
      requestId:'feedback-draft-comment-edit',expectedRevision:restarted.revision,
    });
    assert.equal(edited.status,200,JSON.stringify(edited));
    assert.equal(edited.result.result.draftDigest,readback.draftDigest);
    assert.notEqual(edited.result.result.yamlDigest,readback.yamlDigest);
    const current = (await request('feedback.project.inspect')).result;
    assert.equal(current.draft.yaml,editedYaml);
    assert.deepEqual(current.active,{
      activationId:activationInput.candidateDigest,draftDigest:preview.result.subject.draftDigest,matchesSavedDraft:false,
    });
  } finally {
    await client.close();
    await server?.close();
    rmSync(root,{recursive:true,force:true});
  }
});
