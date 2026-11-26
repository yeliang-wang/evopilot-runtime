import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectFeedbackActivationBindings, inspectFeedbackChannelReadiness, parseFeedbackProjectDraft } from '../../dist/feedback-loop/project.js';

test('standard service loads scoped feedback policy and verifies pinned owner decisions', async () => {
  const {spawn} = await import('node:child_process');
  const {createHash,randomBytes} = await import('node:crypto');
  const {once} = await import('node:events');
  const {mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {createInterface} = await import('node:readline');
  const {fileURLToPath,pathToFileURL} = await import('node:url');
  const {registeredFeedbackActivation} = await import('../../dist/adapters/bindings.js');
  const {initializeCredentials,tokenDigest} = await import('../../dist/server/security.js');
  const {startRuntimeServer} = await import('../../dist/server/http.js');
  const {lifecycle,syntheticBindings,yaml} = await import('../fixtures/lifecycle-v090.mjs');
  const root = mkdtempSync(join(realpathSync(tmpdir()),'runtime-feedback-standard-'));
  const decisions = join(root,'decisions'), state = join(root,'state');
  const configPath = join(root,'integrations.json');
  const expiry = Date.now()+60_000;
  const actor = {id:'owner',projects:['tasks'],permissions:['read','draft.write','definition.activate','decision.record'],
    revision:1,expiresAt:new Date(expiry).toISOString()};
  const digest = bytes => 'sha256:'+createHash('sha256').update(bytes).digest('hex');
  function put(path,value) {
    const bytes = typeof value==='string' ? value : JSON.stringify(value);
    writeFileSync(path,bytes,{mode:0o600});
    return {path,digest:digest(bytes)};
  }
  const pinned = pin => pathToFileURL(pin.path).href+'#sha256='+pin.digest.slice(7);
  let child,exited,qualifiedService;
  try {
    mkdirSync(decisions,{mode:0o700});
    const roles = ['feedbackBindingRef','reviewBindingRef','linearTeamRef','githubRepositoryRef','cursorAgentRef','harnessRuleRef','mergePolicyRef'];
    const observations = {
      schema:'runtime-feedback-binding-observations/v1',workspaceId:'demo',projectId:'tasks',
      observations:roles.map((role,index) => ({
        ...observe(input[role],index===0 ? inbound.capabilities : index===1 ? review.capabilities : []),
        role,validUntil:expiry,evidenceRef:'evidence:local/'+index,factsDigest:digest(role),
      })),
    };
    const observationFile = put(join(root,'observations.json'),observations);
    const policy = {ref:'binding:tasks/feedback-activation',role:'feedback-activation-policy',workspaceId:'demo',projectId:'tasks',
      revision:1,expiresAt:actor.expiresAt,definition:{ownerId:actor.id,ownerRevision:actor.revision,observations:observationFile,decisionDirectory:decisions}};
    put(configPath,{schema:'runtime-integrations/v1',workspaceId:'demo',revision:1,platforms:[],credentials:[],owners:[],resources:[policy]});
    const registry = registeredFeedbackActivation(configPath,'demo');
    const current = registry.policy(input);
    assert.equal(current.ownerId,actor.id);
    const verified = await registry.observe(input,actor,new AbortController().signal);
    assert.equal(inspectFeedbackActivationBindings(input,verified,Date.now()).bindings.every(row=>row.status==='VERIFIED'),true);
    assert.deepEqual(await registry.observe(input,{...actor,id:'another'},new AbortController().signal),[]);
    const candidateDigest = digest('local test candidate');
    const original = put(join(decisions,'source.txt'),'Local synthetic owner decision fixture only');
    const decision = {schema:'evopilot-decision-evidence/v1',subject:{owner:'runtime',operation:'feedback.project.activate',
      workspaceId:'demo',scope:{visibility:'private',projectId:'tasks'},reviewDigest:candidateDigest,decision:'APPROVE'},
      source:{reference:pinned(original),description:'Local test fixture'}};
    const selection = {workspaceId:'demo',projectId:'tasks',actorId:actor.id,actorRevision:1,
      policyDigest:current.digest,candidateDigest,evidenceRef:pinned(put(join(decisions,'approved.json'),decision)),decision:'approve'};
    assert.equal(registry.verifyDecision(selection),true);
    assert.equal(registry.verifyDecision({...selection,candidateDigest:digest('unreviewed')}),false);
    assert.equal(registry.verifyDecision({...selection,policyDigest:digest('old policy')}),false);
    const outside = pinned(put(join(root,'outside.txt'),'Outside protected decision directory'));
    assert.equal(registry.verifyDecision({...selection,evidenceRef:pinned(put(join(decisions,'outside.json'),
      {...decision,source:{...decision.source,reference:outside}}))}),false);
    put(original.path,'Changed source after review');
    assert.equal(registry.verifyDecision(selection),false);
    put(observationFile.path,{...observations,projectId:'other'});
    await assert.rejects(registry.observe(input,actor,new AbortController().signal),{code:'RESOURCE_CHANGED'});
    put(observationFile.path,observations);

    const token = randomBytes(32).toString('hex');
    const credentials = [{...actor,tokenDigest:tokenDigest(token)}];
    const request = async (origin,operation,value,meta={}) => {
      const response = await fetch(origin+'/api/v1/request',{
        method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
        body:JSON.stringify({projectId:'tasks',operation,input:value,...meta}),signal:AbortSignal.timeout(5_000),
      });
      return response.json();
    };
    const qualifiedState = join(root,'qualified');
    initializeCredentials(qualifiedState,'demo',credentials);
    qualifiedService = await startRuntimeServer({stateRoot:qualifiedState,workspaceId:'demo'},syntheticBindings().provider,
      undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,registry);
    const qualified = (operation,value,meta) => request(qualifiedService.url,operation,value,meta);
    const definition = yaml(lifecycle('github','tasks'));
    const validation = (await qualified('lifecycle.definition.validate',{yaml:definition})).result;
    const activeLifecycle = (await qualified('lifecycle.definition.save-and-activate',{
      yaml:definition,validationDigest:validation.validationDigest,
    },{requestId:'local-base-activate',expectedRevision:0})).result;
    await qualified('feedback.project.draft.save',input,{requestId:'local-feedback-draft',expectedRevision:activeLifecycle.revision});
    const preview = (await qualified('feedback.project.activation.preview',{})).result;
    const approved = {...decision,subject:{...decision.subject,reviewDigest:preview.candidateDigest},
      source:{...decision.source,reference:pinned(put(join(decisions,'fixture-source.txt'),'Synthetic operator approval for HTTP composition'))}};
    const activation = (await qualified('feedback.project.activate',{
      candidateDigest:preview.candidateDigest,decision:'approve',evidenceRef:pinned(put(join(decisions,'fixture-approved.json'),approved)),
    },{requestId:'local-feedback-activate',expectedRevision:preview.subject.projectRevision})).result;
    assert.deepEqual(activation.result,{status:'ACTIVE',activationId:preview.candidateDigest,executionAuthorized:false,releaseAuthorized:false});
    assert.equal((await qualified('feedback.project.inspect',{})).result.active.activationId,preview.candidateDigest);
    await qualifiedService.close();
    qualifiedService = undefined;

    initializeCredentials(state,'demo',credentials);
    const cli = fileURLToPath(new URL('../../dist/server/cli.js',import.meta.url));
    child = spawn(process.execPath,[cli,'serve','--state-root',state,'--workspace-id','demo','--integrations-ref',configPath],{
      stdio:['ignore','pipe','ignore'],
    });
    exited = once(child,'exit');
    const lines = createInterface({input:child.stdout});
    const [line] = await once(lines,'line',{signal:AbortSignal.timeout(10_000)});
    const started = JSON.parse(line);
    assert.equal(started.ready,true);
    const saved = await request(started.url,'feedback.project.draft.save',input,{requestId:'standard-cli-draft',expectedRevision:0});
    assert.equal(saved.result.result.status,'DRAFT');
    const denied = await request(started.url,'feedback.project.activation.preview',{});
    assert.equal(denied.error.code,'FEEDBACK_LIFECYCLE_REQUIRED');
    const currentState = (await request(started.url,'feedback.project.inspect',{})).result;
    assert.equal(currentState.active,undefined);
  } finally {
    await qualifiedService?.close();
    if (child) {
      child.kill('SIGTERM');
      const timer = setTimeout(()=>child.kill('SIGKILL'),2_000);
      try {await exited;} finally {clearTimeout(timer);}
    }
    rmSync(root,{recursive:true,force:true});
  }
});

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
