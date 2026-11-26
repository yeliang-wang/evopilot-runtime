import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { normalizeChannelEvent } from '../../dist/feedback-loop/channel.js';
import { createSlackSocketModeTransport, normalizeSlackSocketModeEvent } from '../../dist/feedback-loop/slack.js';

const scope = { provider: 'slack', installationId: 'A00', tenantId: 'T00', channelId: 'C00' };
const event = {
  schema: 'runtime-feedback-channel-event/v1',
  scope,
  eventId: 'Ev001',
  messageId: '1732471200.001000',
  actorId: 'U00',
  action: { kind: 'feedback', text: '复现步骤 🧪\r\n\tReview the received request.  ' },
};

test('signed outbound reference delivery recovers the original message across both peer restarts', async () => {
  const {mkdirSync,mkdtempSync,realpathSync,rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {randomBytes} = await import('node:crypto');
  const {RuntimeStore} = await import('../../dist/server/store.js');
  const {prepareFeedbackDelivery} = await import('../../dist/feedback-loop/channel.js');
  const {createReferenceDeliveryAdapter,startReferenceDeliveryInbox} = await import('../../dist/feedback-loop/callback-channel.js');
  const {bindFeedbackCaseIssue,changeFeedbackCaseIssue,retainFeedbackChannelEvent} = await import('../../dist/feedback-loop/ingress.js');
  const {createLinearIssueAdapter} = await import('../../dist/feedback-loop/linear.js');
  const {advanceFeedbackDelivery,feedbackClosureDeliveryId,retainFeedbackReview,
    reserveFeedbackMerge,reserveFeedbackReviewNotification} = await import('../../dist/feedback-loop/service.js');
  const root = mkdtempSync(join(realpathSync(tmpdir()),'runtime-v010-reference-outbound-'));
  const senderRoot = join(root,'sender'), peerRoot = join(root,'peer');
  mkdirSync(senderRoot,{mode:0o700});
  mkdirSync(peerRoot,{mode:0o700});
  const route = {workspaceId:'workspace',projectId:'project',scope:{...scope,provider:'callback'}};
  const actor = {id:'receiver',projects:['project'],permissions:['read','execution.request'],revision:1,expiresAt:'2099-01-01T00:00:00Z'};
  const key = randomBytes(32);
  let sender, peer, inbox, adapter;
  try {
    sender = new RuntimeStore(senderRoot,route.workspaceId);
    peer = new RuntimeStore(peerRoot,'callback-peer');
    const {caseId} = retainFeedbackChannelEvent(sender,route,actor,{...event,scope:route.scope});
    const message = {
      kind:'needs-info',caseId,requestId:'request-more-info',scope:route.scope,
      originalMessageId:event.messageId,text:'Which browser and version did you use?',
    };
    const intent = prepareFeedbackDelivery(message);
    const startPeer = () => startReferenceDeliveryInbox({store:peer,projectId:route.projectId,scope:route.scope,key,principal:() => actor});
    inbox = await startPeer();
    const operations = [];
    let inspection;
    const transport = async (url,options) => {
      operations.push(url.pathname);
      if (url.pathname === '/inspect') inspection = options;
      const response = await fetch(url,options);
      if (url.pathname === '/deliver') {
        assert(sender.object(route.projectId,'feedback-delivery-intent',intent.requestId));
        assert.equal(response.status,201);
        await response.arrayBuffer();
        throw Error('Original outbound response lost');
      }
      return response;
    };
    adapter = createReferenceDeliveryAdapter(inbox.url,route.scope,key,transport);
    const advance = selected => advanceFeedbackDelivery(sender,actor,route.projectId,route.scope,selected,adapter,() => actor);
    assert.equal((await advance(intent)).status,'UNKNOWN');
    assert.equal(peer.revision(route.projectId),1);
    await inbox.close();
    inbox = null;
    sender.close();
    peer.close();
    sender = new RuntimeStore(senderRoot,route.workspaceId);
    peer = new RuntimeStore(peerRoot,'callback-peer');
    inbox = await startPeer();
    adapter.close();
    adapter = createReferenceDeliveryAdapter(inbox.url,route.scope,key,transport);
    const recovered = await advance(intent);
    assert.equal(recovered.status,'DELIVERED');
    assert.equal(recovered.receipt.source,'REFERENCE_CALLBACK');
    assert.match(recovered.receipt.messageId,/^callback-message:[a-f0-9]{64}$/);
    assert.deepEqual(await advance(intent),recovered);
    assert.equal(peer.revision(route.projectId),1);
    assert.deepEqual(operations,['/deliver','/inspect']);
    // An authenticated readback request cannot be repurposed as a delivery.
    assert.equal((await fetch(new URL('/deliver',inbox.url),inspection)).status,401);
    await assert.rejects(advance(prepareFeedbackDelivery({...message,text:'Different content'})),{code:'FEEDBACK_DELIVERY_CONFLICT'});
    await assert.rejects(advance(prepareFeedbackDelivery({...message,originalMessageId:'different-thread'})),{code:'FEEDBACK_DELIVERY_SCOPE'});
    assert.equal(peer.revision(route.projectId),1);

    // The peer carries an authenticated notice and the original thread reply.
    // Independent Linear and GitHub state are fixture evidence in this test.
    const linear = linearFixture();
    const linearBinding = {scope:linearScope,adapter:createLinearIssueAdapter(linearScope,linear)};
    const issue = await bindFeedbackCaseIssue(sender,route,actor,caseId,linearBinding);
    const candidate = {workspaceId:route.workspaceId,projectId:route.projectId,repositoryId:'4',pullRequestId:'8',
      head:'a'.repeat(40),base:'b'.repeat(40),evidenceDigest:'c'.repeat(64),policyDigest:'d'.repeat(64)};
    const reviewScope = {workspaceId:route.workspaceId,projectId:route.projectId,channel:route.scope,allowedActorIds:['reviewer']};
    const {intent:notice} = reserveFeedbackReviewNotification(sender,actor,reviewScope,candidate);
    const noticeIntent = prepareFeedbackDelivery({
      kind:'review',caseId,requestId:notice.intentRef,scope:route.scope,text:'Review the exact PR head.',reviewId:notice.windowId,
    });
    assert.equal((await advance(noticeIntent)).status,'UNKNOWN');
    const noticeReceipt = (await advance(noticeIntent)).receipt;
    const review = retainFeedbackReview(sender,actor,reviewScope,candidate,notice.intentRef,noticeReceipt.messageId,noticeReceipt.deliveredAt);
    const closure = prepareFeedbackDelivery({
      ...message,kind:'closed',requestId:feedbackClosureDeliveryId(caseId,review.id),text:'Merged and verified.',
    });
    const closeIssue = () => changeFeedbackCaseIssue(sender,route,actor,caseId,linearBinding,{kind:'close',windowId:review.id});
    await assert.rejects(closeIssue(),{code:'FEEDBACK_CLOSURE_NOT_CONFIRMED'});
    await assert.rejects(advance(closure),{code:'FEEDBACK_DELIVERY_CLOSURE_REQUIRED'});
    const claimed = reserveFeedbackMerge(sender,actor,review.id,{candidate,policyCurrent:true,githubChecksPassed:true,
      baseProtected:true,receiptCoverage:'COMPLETE'},() => review.deadline);
    const mergeSha = 'e'.repeat(40);
    sender.mutate(actor,{projectId:route.projectId,operation:'fixture.merge',requestId:'fixture-merge',
      expectedRevision:sender.revision(route.projectId),permission:'execution.request',input:{}},() => ({
      value:{},event:{type:'fixture-merge',data:{}},objects:[{kind:'feedback-merge-outcome',id:claimed.claim.requestId,value:{
        status:'MERGED',source:'FIXTURE',requestId:claimed.claim.requestId,candidateDigest:review.candidateDigest,mergeSha,
      }}],
    }));
    await assert.rejects(advance(closure),{code:'FEEDBACK_DELIVERY_CLOSURE_REQUIRED'});
    const closed = await closeIssue();
    assert.equal(closed.status,'CONFIRMED');
    assert.equal(closed.receipt.issueId,issue.receipt.issueId);
    assert.equal(closed.receipt.stateId,linearScope.closedStateId);
    assert.equal((await advance(closure)).status,'UNKNOWN');
    assert.equal((await advance(closure)).status,'DELIVERED');
    assert.equal(peer.revision(route.projectId),3);
  } finally {
    adapter?.close();
    await inbox?.close();
    sender?.close();
    peer?.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test('persisting a feedback draft marks the state before any provider traffic', async () => {
  const {mkdtempSync,realpathSync,rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {DatabaseSync} = await import('node:sqlite');
  const {RuntimeStore} = await import('../../dist/server/store.js');
  const {saveFeedbackProjectDraft} = await import('../../dist/feedback-loop/project.js');
  const root = mkdtempSync(join(realpathSync(tmpdir()),'runtime-v010-feedback-rollback-'));
  const actor = {id:'editor',projects:['project'],permissions:['read','draft.write'],revision:1,expiresAt:'2099-01-01T00:00:00Z'};
  const store = new RuntimeStore(root,'workspace');
  try {
    const state = new DatabaseSync(join(root,'service.sqlite'),{readOnly:true});
    try {
      assert.equal(state.prepare('PRAGMA user_version').get().user_version,1);
      const draft = {workspaceId:'workspace',projectId:'project'};
      assert.throws(() => saveFeedbackProjectDraft(store,actor,'project',draft,'stale',1,()=>actor),{code:'REVISION_CONFLICT'});
      assert.equal(state.prepare('PRAGMA user_version').get().user_version,1);
      saveFeedbackProjectDraft(store,actor,'project',draft,'draft',0,()=>actor);
      assert.equal(state.prepare('PRAGMA user_version').get().user_version,4);
    } finally {
      state.close();
    }
  } finally {
    store.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test('normalized events keep exact text and original message and actor identities', () => {
  const first = normalizeChannelEvent(event, scope);
  const redelivery = normalizeChannelEvent({
    action: { text: event.action.text, kind: 'feedback' },
    actorId: event.actorId,
    messageId: event.messageId,
    eventId: event.eventId,
    scope: { channelId: 'C00', tenantId: 'T00', installationId: 'A00', provider: 'slack' },
    schema: event.schema,
  }, scope);
  assert.deepEqual(redelivery, first);
  assert.deepEqual({ ...event, eventKey: first.eventKey, payloadDigest: first.payloadDigest }, first);
  assert.match(first.eventKey, /^sha256:[a-f0-9]{64}$/);
  assert.match(first.payloadDigest, /^sha256:[a-f0-9]{64}$/);
});

test('same identity exposes changed content for conflict detection', () => {
  const first = normalizeChannelEvent(event, scope);
  for (const changed of [
    { actorId: 'U01' },
    { messageId: '1732471200.002000' },
    { action: { kind: 'feedback', text: event.action.text.trimEnd() } },
  ]) {
    const later = normalizeChannelEvent({ ...event, ...changed }, scope);
    assert.equal(later.eventKey, first.eventKey);
    assert.notEqual(later.payloadDigest, first.payloadDigest);
  }
  assert.notEqual(normalizeChannelEvent({ ...event, eventId: 'Ev002' }, scope).eventKey, first.eventKey);
});

test('every scope component contributes to identity and must match the configured route', () => {
  const first = normalizeChannelEvent(event, scope);
  for (const [field, value] of Object.entries({
    provider: 'callback', installationId: 'A01', tenantId: 'T01', channelId: 'C01',
  })) {
    const differentScope = { ...scope, [field]: value };
    const differentEvent = { ...event, scope: differentScope };
    assert.throws(() => normalizeChannelEvent(differentEvent, scope), { code: 'CHANNEL_SCOPE_MISMATCH', status: 403 });
    assert.notEqual(normalizeChannelEvent(differentEvent, differentScope).eventKey, first.eventKey);
  }
});

test('supplement and veto are distinct closed actions usable by a callback adapter', () => {
  const callbackScope = { ...scope, provider: 'callback' };
  for (const action of [
    { kind: 'supplement', caseId: 'case:example', text: '补充：在保存后出现问题' },
    { kind: 'veto', reviewId: 'review:example' },
  ]) assert.deepEqual(normalizeChannelEvent({ ...event, scope: callbackScope, action }, callbackScope).action, action);
});

test('malformed envelopes and credentials are rejected and text input is byte bounded', () => {
  for (const malformed of [
    { credentialRef: 'secret:rotation' },
    { scope: { ...scope, credentialRef: 'secret:rotation' } },
    { action: { kind: 'veto', text: 'unbound veto' } },
    { action: { kind: 'supplement', text: 'unbound supplement' } },
    { action: { kind: 'feedback', text: '\n\t ' } },
    { action: { kind: 'feedback', text: 'bad\u0000text' } },
    { action: { kind: 'feedback', text: '\ud800' } },
    { eventId: 'contains a space' },
    { messageId: 'x'.repeat(257) },
  ]) assert.throws(() => normalizeChannelEvent({ ...event, ...malformed }, scope));
  assert.throws(
    () => normalizeChannelEvent({ ...event, action: { kind: 'feedback', text: '测'.repeat(6000) } }, scope),
    { code: 'INPUT_LIMIT', status: 413 },
  );
});

test('original event persists through restart and receiver rotation without duplicate audit or projected text', async () => {
  const { mkdtempSync, realpathSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { RuntimeStore } = await import('../../dist/server/store.js');
  const { retainFeedbackChannelEvent } = await import('../../dist/feedback-loop/ingress.js');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'runtime-v010-ingress-'));
  const route = {workspaceId:'workspace', projectId:'project', scope};
  const actor = {id:'receiver-one', projects:['project'], permissions:['read','execution.request'], revision:1, expiresAt:'2099-01-01T00:00:00Z'};
  let store = new RuntimeStore(root, route.workspaceId);
  try {
    const first = retainFeedbackChannelEvent(store, route, actor, event);
    assert.equal(first.status, 'RETAINED');
    store.close();
    store = new RuntimeStore(root, route.workspaceId);
    const second = retainFeedbackChannelEvent(store, route, {...actor,id:'receiver-two'}, event);
    assert.deepEqual(second, {...first,status:'REUSED'});
    assert.throws(() => retainFeedbackChannelEvent(store, route, actor, {...event,messageId:'changed'}), {code:'CHANNEL_EVENT_CONFLICT'});
    assert.throws(() => retainFeedbackChannelEvent(store, route, {...actor,projects:['other']}, event), {code:'FORBIDDEN'});
    assert.equal(store.revision(route.projectId), 1);
    assert.equal(store.events(actor, route.projectId).events.length, 1);
    assert(!JSON.stringify(store.events(actor, route.projectId)).includes('actorId'));
  } finally {
    store.close();
    rmSync(root, {recursive:true,force:true});
  }
});

test('callback adapter authenticates original bytes before normalization', async () => {
  const { createHmac, randomBytes } = await import('node:crypto');
  const { authenticateReferenceCallback } = await import('../../dist/feedback-loop/callback-channel.js');
  const body = Buffer.from(JSON.stringify({...event,scope:{...scope,provider:'callback'}}));
  const key = randomBytes(32);
  const timestamp = '1800000000000';
  const signature = 'sha256=' + createHmac('sha256',key).update(timestamp+'.').update(body).digest('hex');
  const callback = authenticateReferenceCallback(body,timestamp,signature,key,Number(timestamp));
  assert.equal(normalizeChannelEvent(callback,{...scope,provider:'callback'}).scope.provider,'callback');
  assert.throws(() => authenticateReferenceCallback(body,timestamp,signature,key,Number(timestamp)+300001),{code:'CALLBACK_UNAUTHENTICATED'});
  assert.throws(() => authenticateReferenceCallback(Buffer.concat([body,Buffer.from(' ')]),timestamp,signature,key,Number(timestamp)),{code:'CALLBACK_UNAUTHENTICATED'});
  assert.throws(() => authenticateReferenceCallback(Buffer.alloc(65537),timestamp,signature,key,Number(timestamp)),{code:'INPUT_LIMIT'});
});

const slackDelivery = {
  type: 'events_api',
  envelope_id: 'delivery-first',
  accepts_response_payload: false,
  payload: {
    type: 'event_callback',
    api_app_id: scope.installationId,
    team_id: scope.tenantId,
    event_id: event.eventId,
    event_time: 1732471200,
    event: {
      type: 'message',
      channel: scope.channelId,
      user: event.actorId,
      ts: event.messageId,
      event_ts: event.messageId,
      text: event.action.text,
      channel_type: 'channel',
    },
  },
};

function slackMessage(message, callback = {}) {
  return {
    ...slackDelivery,
    payload: { ...slackDelivery.payload, ...callback, event: { ...slackDelivery.payload.event, ...message } },
  };
}

test('Slack Socket Mode retains provider identities and exact text across delivery retries', () => {
  const normalized = normalizeSlackSocketModeEvent(slackDelivery, scope);
  assert.deepEqual(normalized, normalizeChannelEvent(event, scope));
  assert.deepEqual(normalizeSlackSocketModeEvent({
    ...slackDelivery,
    envelope_id: 'delivery-retry',
    retry_attempt: 1,
    payload: { ...slackDelivery.payload, event_time: 1732471201 },
  }, scope), normalized);
  const changed = normalizeSlackSocketModeEvent(slackMessage({ text: 'Changed feedback' }), scope);
  assert.equal(changed.eventKey, normalized.eventKey);
  assert.notEqual(changed.payloadDigest, normalized.payloadDigest);
  assert.throws(() => normalizeSlackSocketModeEvent(slackMessage({}, { event_id: undefined }), scope), { code: 'INVALID_INPUT' });
});

test('Slack Socket Mode rejects scope mismatches before resolving a thread', () => {
  const thread_ts = '1732471199.000100';
  for (const delivery of [
    slackMessage({ thread_ts }, { api_app_id: 'A01' }),
    slackMessage({ thread_ts }, { team_id: 'T01' }),
    slackMessage({ thread_ts, channel: 'C01' }),
  ]) {
    assert.throws(() => normalizeSlackSocketModeEvent(delivery, scope, () => assert.fail('Unexpected thread lookup')), {
      code: 'CHANNEL_SCOPE_MISMATCH',
      status: 403,
    });
  }
  assert.throws(() => normalizeSlackSocketModeEvent(slackDelivery, { ...scope, provider: 'callback' }), {
    code: 'CHANNEL_SCOPE_MISMATCH',
    status: 403,
  });
});

test('Slack Socket Mode ignores bot, system, update, and non-message deliveries', () => {
  for (const message of [
    { subtype: 'bot_message' },
    { bot_id: 'B00' },
    { bot_profile: { id: 'B00' } },
    { app_id: 'A00' },
    { subtype: 'channel_join' },
    { subtype: 'message_changed' },
    { subtype: 'message_deleted' },
    { subtype: 'message_replied' },
    { subtype: 'thread_broadcast' },
    { hidden: true, message: { ts: event.messageId, thread_ts: event.messageId } },
    { edited: { user: event.actorId, ts: event.messageId } },
    { type: 'reaction_added' },
  ]) {
    assert.equal(normalizeSlackSocketModeEvent(slackMessage(message), scope), undefined);
  }
  assert.equal(normalizeSlackSocketModeEvent({ type: 'hello' }, scope), undefined);
  assert.equal(normalizeSlackSocketModeEvent({ type: 'interactive' }, scope), undefined);
});

test('Slack Socket Mode supplements require a trusted binding to the original thread', () => {
  const threadId = event.messageId;
  assert.deepEqual(normalizeSlackSocketModeEvent(slackMessage({ thread_ts: threadId }), scope, () => {
    assert.fail('Root messages do not need a thread lookup');
  }), normalizeChannelEvent(event, scope));

  const messageId = '1732471201.003000';
  const text = '补充：保存后出现问题';
  const reply = slackMessage({
    thread_ts: threadId, ts: messageId, user: 'U01', text, caseId: 'case:untrusted',
  }, { event_id: 'Ev002', event_time: 1732471201 });

  assert.equal(normalizeSlackSocketModeEvent(reply, scope), undefined);
  assert.equal(normalizeSlackSocketModeEvent(reply, scope, () => undefined), undefined);
  const resolved = normalizeSlackSocketModeEvent(reply, scope, (boundScope, originalMessageId) => {
    assert.deepEqual(boundScope, scope);
    assert.equal(originalMessageId, threadId);
    return 'case:original';
  });
  assert.deepEqual(resolved, normalizeChannelEvent({
    ...event,
    eventId: 'Ev002',
    messageId,
    actorId: 'U01',
    action: { kind: 'supplement', caseId: 'case:original', text },
  }, scope));
});

test('signed reference callbacks retain feedback and veto through actual loopback HTTP', async () => {
  const {createHmac,randomBytes} = await import('node:crypto');
  const {mkdtempSync,realpathSync,rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {RuntimeStore} = await import('../../dist/server/store.js');
  const {startReferenceChannel} = await import('../../dist/feedback-loop/callback-channel.js');
  const {reserveFeedbackReviewNotification,retainFeedbackReview,reserveFeedbackMerge} = await import('../../dist/feedback-loop/service.js');
  const root = mkdtempSync(join(realpathSync(tmpdir()),'runtime-v010-reference-'));
  const projectRoute = {workspaceId:'workspace',projectId:'project'};
  const feedbackScope = {...scope,provider:'callback'};
  const reviewScope = {...feedbackScope,channelId:'C-review'};
  const signer = randomBytes(32);
  const reviewerSigner = randomBytes(32);
  const principal = {
    id:'callback-receiver',projects:['project'],permissions:['read','execution.request'],revision:1,expiresAt:'2099-01-01T00:00:00Z',
  };
  const feedback = {key:signer,route:{...projectRoute,scope:feedbackScope}};
  const review = {key:reviewerSigner,route:{...projectRoute,channel:reviewScope,allowedActorIds:['reviewer']}};
  let store = new RuntimeStore(root,'workspace');
  let listener;
  const start = () => startReferenceChannel({feedback,review,store,receiverPrincipal:()=>principal});
  const send = async (path, key, payload) => {
    const body = JSON.stringify(payload);
    const timestamp = String(Date.now());
    const signature = 'sha256='+createHmac('sha256',key).update(timestamp+'.').update(body).digest('hex');
    const response = await fetch(listener.url+path,{
      method:'POST',body,headers:{
        'content-type':'application/json','x-runtime-callback-timestamp':timestamp,'x-runtime-callback-signature':signature,
      },
    });
    return {status:response.status,body:await response.json()};
  };
  try {
    listener = await start();
    const first = {...event,scope:feedbackScope};
    const retained = await send('/feedback',signer,first);
    assert.equal(retained.status,201);
    const foreign = await send('/feedback',signer,{...first,scope:{...feedbackScope,tenantId:'foreign'}});
    assert.deepEqual(foreign,{status:403,body:{error:'CHANNEL_SCOPE_MISMATCH'}});
    await listener.close();
    listener = undefined;
    store.close();
    store = new RuntimeStore(root,'workspace');
    listener = await start();
    const replay = await send('/feedback',signer,first);
    assert.deepEqual(replay,{status:200,body:{...retained.body,status:'REUSED'}});
    assert.equal(store.revision('project'),1);
    const caseId = retained.body.caseId;
    const {resolveOriginalFeedbackCase} = await import('../../dist/feedback-loop/ingress.js');
    assert.equal(resolveOriginalFeedbackCase(store,feedback.route,first.messageId),caseId);
    const duplicateMessage = await send('/feedback',signer,{...first,eventId:'same-message-new-delivery'});
    assert.equal(duplicateMessage.body.caseId,caseId);
    assert.equal(store.objectsPage('project','feedback-case').length,1);
    const supplement = { ...first, eventId:'supplement-1', messageId:'reply-1', action:{kind:'supplement',caseId,text:'More detail'} };
    assert.equal((await send('/feedback',signer,supplement)).body.caseId,caseId);
    assert.deepEqual(await send('/feedback',signer,{...supplement,eventId:'unknown-case',action:{...supplement.action,caseId:'unknown'}}),
      {status:404,body:{error:'FEEDBACK_CASE_UNKNOWN'}});
    assert.equal(store.object('project','feedback-case',caseId).originalEventKey,retained.body.eventKey);

    const candidate = {
      ...projectRoute,repositoryId:'repo',pullRequestId:'1',head:'a'.repeat(40),base:'b'.repeat(40),
      evidenceDigest:'c'.repeat(64),policyDigest:'d'.repeat(64),
    };
    const intent = reserveFeedbackReviewNotification(store,principal,review.route,candidate).intent;
    const window = retainFeedbackReview(store,principal,review.route,candidate,intent.intentRef,'notice-1',Date.now());
    const veto = {...event,scope:reviewScope,eventId:'veto-1',messageId:'notice-1',actorId:'reviewer',action:{kind:'veto',reviewId:window.id}};
    assert.deepEqual(await send('/review',signer,veto),{status:401,body:{error:'CALLBACK_UNAUTHENTICATED'}});
    assert.deepEqual(await send('/review',reviewerSigner,veto),{status:200,body:{status:'VETO_RETAINED',windowId:window.id}});
    assert.throws(() => reserveFeedbackMerge(store,principal,window.id,{
      candidate,policyCurrent:true,receiptCoverage:'COMPLETE',githubChecksPassed:true,baseProtected:true,
    },()=>window.deadline),{code:'FEEDBACK_REVIEW_VETO'});
  } finally {
    await listener?.close();
    store.close();
    rmSync(root,{recursive:true,force:true});
  }
});

const linearScope = {
  teamId: '42bdea2e-2fad-4a86-969a-9e9b9d12f1d0',
  projectId: '3ab1f6ae-79fd-4d7b-963e-2d213830b709',
  openStateId: '6cb465d2-9cc5-4993-8b6c-c85a6f7aea9f',
  needsInfoStateId: '694f0b0d-3f00-4498-a37c-bda169ba873b',
  closedStateId: 'b06a9637-950c-4152-9d11-9f086e8eaa0b',
};
const linearCreate = {
  kind: 'create', caseId: 'case:original', requestId: 'request:original', title: 'Save feedback', body: 'Exact report 🧪\n\nSteps to reproduce.',
};

function linearFixture() {
  const fixture = {calls: [], issue: undefined, loseMutationResponse: false, loseReadback: false, closeStateType: 'completed'};
  fixture.request = async (query, variables) => {
    const operation = query.match(/(?:query|mutation) (\w+)/)[1];
    fixture.calls.push({operation, variables: structuredClone(variables)});
    if (operation === 'RuntimeLinearRead') {
      if (fixture.loseReadback) throw Error('response was lost');
      if (fixture.partialRead) return {data: {issue: fixture.issue}, errors: [{message: 'incomplete response'}]};
      return {data: {issue: fixture.issue ?? null}};
    }
    if (operation === 'RuntimeLinearState') {
      return {data: {workflowState: {id: linearScope.closedStateId, type: fixture.closeStateType, team: {id: linearScope.teamId}}}};
    }
    const {input} = variables;
    const state = {id: input.stateId, type: input.stateId === linearScope.closedStateId ? 'completed' : 'unstarted'};
    if (operation === 'RuntimeLinearCreate') {
      assert.equal(fixture.issue, undefined);
      fixture.issue = {
        id: input.id, title: input.title, description: input.description, archivedAt: null,
        team: {id: input.teamId}, project: {id: input.projectId}, state,
      };
    } else {
      assert.equal(operation, 'RuntimeLinearUpdate');
      assert.equal(variables.id, fixture.issue.id);
      fixture.issue = {...fixture.issue, description: input.description, state};
    }
    if (fixture.losePostMutationReadback) fixture.loseReadback = true;
    if (fixture.loseMutationResponse) throw Error('response was lost');
    const field = operation === 'RuntimeLinearCreate' ? 'issueCreate' : 'issueUpdate';
    return {data: {[field]: {success: true, issue: {id: fixture.issue.id}}}};
  };
  return fixture;
}

test('Linear rechecks authorization after its last read before dispatching an update', async () => {
  const {createLinearIssueAdapter,prepareLinearIssueIntent} = await import('../../dist/feedback-loop/linear.js');
  const fixture = linearFixture();
  const adapter = createLinearIssueAdapter(linearScope,fixture);
  const original = prepareLinearIssueIntent(linearScope,linearCreate);
  const {receipt} = await adapter.dispatch(original,'RESERVED');
  const update = prepareLinearIssueIntent(linearScope,{kind:'needs-info',original,prior:receipt,
    requestId:'request:perimeter-test',body:'What version is affected?'});
  const upstream = fixture.request;
  let authorized = true;
  fixture.request = async (query,variables) => {
    const result = await upstream(query,variables);
    if (query.includes('query RuntimeLinearRead')) authorized = false;
    return result;
  };
  await assert.rejects(adapter.dispatch(update,'RESERVED',() => {
    if (!authorized) throw new Error('owner authorization changed');
  }),/owner authorization changed/);
  assert.equal(fixture.calls.filter(call=>call.operation === 'RuntimeLinearUpdate').length,0);
  assert.equal(fixture.issue.state.id,linearScope.openStateId);
});

test('Linear create reconciles the exact reserved UUID after restart without another mutation', async () => {
  const {createLinearIssueAdapter, prepareLinearIssueIntent} = await import('../../dist/feedback-loop/linear.js');
  const linear = linearFixture();
  linear.source = 'LINEAR_PROVIDER';
  const original = prepareLinearIssueIntent(linearScope, linearCreate);
  const retained = JSON.parse(JSON.stringify(original));
  await assert.rejects(createLinearIssueAdapter(linearScope, linear).reconcile({...retained, body: 'changed'}), {
    code: 'LINEAR_INTENT_MISMATCH',
  });
  await assert.rejects(createLinearIssueAdapter({
    ...linearScope, projectId: '4a968200-9976-4b6a-9c26-62c9a216b946',
  }, linear).dispatch(retained, 'RESERVED'), {code: 'LINEAR_INTENT_MISMATCH'});
  assert.equal(linear.calls.length, 0);
  linear.loseMutationResponse = true;
  linear.loseReadback = true;
  const first = await createLinearIssueAdapter(linearScope, linear).dispatch(retained, 'RESERVED');
  assert.deepEqual(first, {status: 'UNKNOWN', issueId: retained.issueId, intentId: retained.intentId});
  assert.match(retained.issueId, /^[a-f0-9-]{14}4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.deepEqual(linear.calls[0], {
    operation: 'RuntimeLinearCreate',
    variables: {input: {
      id: retained.issueId, teamId: linearScope.teamId, projectId: linearScope.projectId, useDefaultTemplate: false,
      title: linearCreate.title, description: 'EvoPilot issue: ' + retained.intentId + '\n\n' + linearCreate.body,
      stateId: linearScope.openStateId,
    }},
  });
  linear.loseReadback = false;
  linear.partialRead = true;
  const restarted = createLinearIssueAdapter(linearScope, linear);
  assert.deepEqual(await restarted.reconcile(retained), first);
  linear.partialRead = false;
  await assert.rejects(restarted.dispatch(retained, 'REUSED'), {code: 'LINEAR_RECONCILE_ORIGINAL'});
  const confirmed = await restarted.reconcile(retained);
  assert.equal(confirmed.status, 'CONFIRMED');
  assert.equal(confirmed.receipt.source, 'FIXTURE');
  assert.equal(confirmed.receipt.originalIntentId, retained.intentId);
  assert.equal(confirmed.receipt.issueId, retained.issueId);
  assert.deepEqual(linear.calls.slice(1), Array(3).fill({operation: 'RuntimeLinearRead', variables: {id: retained.issueId}}));
});

test('retained feedback reserves one Linear issue and confirms it once after a restart and concurrent readbacks', async () => {
  const {mkdtempSync, realpathSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {RuntimeStore} = await import('../../dist/server/store.js');
  const {bindFeedbackCaseIssue, retainFeedbackChannelEvent} = await import('../../dist/feedback-loop/ingress.js');
  const {createLinearIssueAdapter} = await import('../../dist/feedback-loop/linear.js');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'runtime-v010-linear-case-'));
  const route = {workspaceId: 'workspace', projectId: 'project', scope};
  const actor = {id: 'receiver-one', projects: ['project'], permissions: ['read', 'execution.request'], revision: 1, expiresAt: '2099-01-01T00:00:00Z'};
  const fixture = linearFixture();
  fixture.loseMutationResponse = true;
  fixture.loseReadback = true;
  let store = new RuntimeStore(root, route.workspaceId);
  try {
    const original = retainFeedbackChannelEvent(store, route, actor, event);
    let reservationAtDispatch;
    const request = async (query, variables) => {
      if (query.includes('mutation RuntimeLinearCreate')) {
        reservationAtDispatch = store.object(route.projectId, 'feedback-case-issue-intent', original.caseId);
      }
      return fixture.request(query, variables);
    };
    const binding = {scope: linearScope, adapter: createLinearIssueAdapter(linearScope, {request})};
    const first = await bindFeedbackCaseIssue(store, route, actor, original.caseId, binding);
    assert.equal(first.status, 'UNKNOWN');
    assert.equal(first.issueId, reservationAtDispatch.issueId);
    assert.equal(reservationAtDispatch.body, event.action.text);
    assert.equal(reservationAtDispatch.title, '复现步骤 🧪');
    assert.equal(store.revision(route.projectId), 2);
    store.close();
    store = new RuntimeStore(root, route.workspaceId);
    fixture.loseReadback = false;
    const [found, concurrent] = await Promise.all([
      bindFeedbackCaseIssue(store, route, actor, original.caseId, binding),
      bindFeedbackCaseIssue(store, route, {...actor, id: 'receiver-two'}, original.caseId, binding),
    ]);
    assert.deepEqual(found, concurrent);
    assert.equal(found.status, 'CONFIRMED');
    assert.equal(found.receipt.source, 'FIXTURE');
    assert.equal(found.receipt.issueId, first.issueId);
    assert.deepEqual(store.object(route.projectId, 'feedback-case-issue', original.caseId), found.receipt);
    assert.deepEqual(await bindFeedbackCaseIssue(store, route, actor, original.caseId, binding), found);
    const changed = {...linearScope, projectId: linearScope.teamId};
    await assert.rejects(bindFeedbackCaseIssue(store, route, actor, original.caseId, {
      scope: changed, adapter: createLinearIssueAdapter(changed, fixture),
    }), {code: 'LINEAR_SCOPE_CHANGED'});
    assert.equal(store.revision(route.projectId), 3);
    assert.deepEqual(fixture.calls.map(call => call.operation), [
      'RuntimeLinearCreate', 'RuntimeLinearRead', 'RuntimeLinearRead', 'RuntimeLinearRead',
    ]);
  } finally {
    store.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('needs-info resumes the same Linear issue only from the original case supplement', async () => {
  const {mkdtempSync, realpathSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {RuntimeStore} = await import('../../dist/server/store.js');
  const {bindFeedbackCaseIssue, changeFeedbackCaseIssue, retainFeedbackChannelEvent} = await import('../../dist/feedback-loop/ingress.js');
  const {createLinearIssueAdapter} = await import('../../dist/feedback-loop/linear.js');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'runtime-v010-linear-resume-'));
  const route = {workspaceId: 'workspace', projectId: 'project', scope};
  const actor = {id: 'receiver', projects: ['project'], permissions: ['read', 'execution.request'], revision: 1, expiresAt: '2099-01-01T00:00:00Z'};
  const fixture = linearFixture();
  const binding = {scope: linearScope, adapter: createLinearIssueAdapter(linearScope, fixture)};
  let store = new RuntimeStore(root, route.workspaceId);
  try {
    const {caseId, eventKey: originalKey} = retainFeedbackChannelEvent(store, route, actor, event);
    const supplement = retainFeedbackChannelEvent(store, route, actor, {
      ...event, eventId: 'EvSupplement', messageId: '1732471201.001000',
      action: {kind: 'supplement', caseId, text: 'It happens on save in Chromium.'},
    });
    const {receipt: created} = await bindFeedbackCaseIssue(store, route, actor, caseId, binding);
    const prompt = {kind: 'needs-info', triageRef: 'triage:single-attempt', prompt: 'Which browser?'};
    const resume = {kind: 'resume', supplementEventKey: supplement.eventKey};
    await assert.rejects(changeFeedbackCaseIssue(store, route, actor, caseId, binding, resume), {
      code: 'LINEAR_ORIGINAL_REQUIRED',
    });
    fixture.loseMutationResponse = true;
    fixture.losePostMutationReadback = true;
    const pending = await changeFeedbackCaseIssue(store, route, actor, caseId, binding, prompt);
    assert.equal(pending.status, 'UNKNOWN');
    await assert.rejects(changeFeedbackCaseIssue(store, route, actor, caseId, binding, resume), {
      code: 'LINEAR_RECONCILE_ORIGINAL',
    });
    store.close();
    store = new RuntimeStore(root, route.workspaceId);
    fixture.loseReadback = false;
    fixture.loseMutationResponse = false;
    fixture.losePostMutationReadback = false;
    const waiting = await changeFeedbackCaseIssue(store, route, actor, caseId, binding, prompt);
    assert.equal(waiting.status, 'CONFIRMED');
    assert.equal(waiting.receipt.stateId, linearScope.needsInfoStateId);
    assert.equal(waiting.receipt.intentId, pending.intentId);
    await assert.rejects(changeFeedbackCaseIssue(store, route, actor, caseId, binding, {
      ...prompt, prompt: 'A different question',
    }), {code: 'LINEAR_CHANGE_CONFLICT'});
    await assert.rejects(changeFeedbackCaseIssue(store, route, actor, caseId, binding, {
      ...resume, supplementEventKey: originalKey,
    }), {code: 'FEEDBACK_SUPPLEMENT_REQUIRED'});
    const resumed = await changeFeedbackCaseIssue(store, route, actor, caseId, binding, resume);
    assert.equal(resumed.status, 'CONFIRMED');
    assert.equal(resumed.receipt.stateId, linearScope.openStateId);
    assert.equal(resumed.receipt.originalIntentId, created.intentId);
    assert.equal(resumed.receipt.issueId, created.issueId);
    assert.deepEqual(await changeFeedbackCaseIssue(store, route, actor, caseId, binding, resume), resumed);
    assert.match(fixture.issue.description, /It happens on save in Chromium\.$/);
    assert.deepEqual(fixture.calls.filter(call => call.operation === 'RuntimeLinearUpdate').map(call => call.variables.id), [
      created.issueId, created.issueId,
    ]);
  } finally {
    store.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('Linear changes verify the original issue and correlate the exact body and state', async () => {
  const {createLinearIssueAdapter, prepareLinearIssueIntent} = await import('../../dist/feedback-loop/linear.js');
  const linear = linearFixture();
  const adapter = createLinearIssueAdapter(linearScope, linear);
  const original = prepareLinearIssueIntent(linearScope, linearCreate);
  const {receipt: created} = await adapter.dispatch(original, 'RESERVED');
  const needsInfoRequest = {
    kind: 'needs-info', original, prior: created, requestId: 'request:needs-info', body: 'Which browser?',
  };
  const blockedNeedsInfo = prepareLinearIssueIntent(linearScope, {...needsInfoRequest, requestId: 'request:blocked-needs-info'});
  const originalBody = linear.issue.description;
  linear.issue.description += ' Manual edit';
  const callsBeforeEdit = linear.calls.length;
  assert.equal((await adapter.dispatch(blockedNeedsInfo, 'RESERVED')).reason, 'ORIGINAL_CHANGED');
  assert.deepEqual(linear.calls.slice(callsBeforeEdit), [{operation: 'RuntimeLinearRead', variables: {id: original.issueId}}]);
  linear.issue.description = originalBody;
  const needsInfo = prepareLinearIssueIntent(linearScope, needsInfoRequest);
  const {receipt: waiting} = await adapter.dispatch(needsInfo, 'RESERVED');
  assert.equal(waiting.stateId, linearScope.needsInfoStateId);
  assert.equal(linear.issue.description, 'EvoPilot issue: ' + original.intentId + '\n\nEvoPilot change: ' + needsInfo.intentId + '\n\nWhich browser?');

  const resume = prepareLinearIssueIntent(linearScope, {
    kind: 'resume', original, prior: waiting, requestId: 'request:resume', body: 'Reproduces in Chromium.',
  });
  const {receipt: resumed} = await adapter.dispatch(resume, 'RESERVED');
  assert.equal(resumed.originalIntentId, original.intentId);
  assert.equal(resumed.stateId, linearScope.openStateId);
  assert.equal((await adapter.reconcile(needsInfo)).status, 'UNKNOWN');
  assert.throws(() => prepareLinearIssueIntent(linearScope, {
    kind: 'close', original, prior: {...resumed, issueId: linearScope.projectId}, requestId: 'request:close', body: 'Merged.',
  }), {code: 'LINEAR_ORIGINAL_REQUIRED'});

  const closeRequest = {
    kind: 'close', original, prior: resumed, requestId: 'request:close', body: 'Merged.',
  };
  const blockedClose = prepareLinearIssueIntent(linearScope, {...closeRequest, requestId: 'request:blocked-close'});
  linear.closeStateType = 'canceled';
  const callsBeforeClose = linear.calls.length;
  assert.equal((await adapter.dispatch(blockedClose, 'RESERVED')).reason, 'CLOSE_STATE_UNVERIFIED');
  assert.deepEqual(linear.calls.slice(callsBeforeClose).map(call => call.operation), ['RuntimeLinearRead', 'RuntimeLinearState']);
  linear.closeStateType = 'completed';
  const close = prepareLinearIssueIntent(linearScope, closeRequest);
  linear.loseMutationResponse = true;
  linear.losePostMutationReadback = true;
  assert.equal((await adapter.dispatch(close, 'RESERVED')).status, 'UNKNOWN');
  linear.loseReadback = false;
  const {receipt: closed} = await createLinearIssueAdapter(linearScope, linear).reconcile(close);
  assert.equal(closed.issueId, original.issueId);
  assert.equal(closed.stateId, linearScope.closedStateId);
  assert.equal(closed.originalIntentId, original.intentId);
  assert.equal((await adapter.reconcile(close)).status, 'CONFIRMED');
  const snapshot = structuredClone(linear.issue);
  for (const change of [
    {id: linearScope.teamId},
    {team: {id: linearScope.projectId}},
    {project: null},
    {state: {...snapshot.state, type: 'canceled'}},
    {state: {...snapshot.state, id: linearScope.openStateId}},
    {description: snapshot.description + ' Manual edit'},
  ]) {
    linear.issue = {...snapshot, ...change};
    assert.equal((await adapter.reconcile(close)).status, 'UNKNOWN');
  }
  assert.deepEqual(
    linear.calls.filter(call => call.operation === 'RuntimeLinearUpdate').map(call => call.variables.id),
    Array(3).fill(original.issueId),
  );
});

const slackSocketScope = {provider:'slack', installationId:'A01', tenantId:'T01', channelId:'C01'};

class SlackProtocolSocket extends EventTarget {
  readyState = 1;
  sent = [];
  close() { this.readyState = 3; }
  send(data) { this.sent.push(JSON.parse(data)); }
  frame(frame) { this.dispatchEvent(new MessageEvent('message', {data:JSON.stringify(frame)})); }
  hello(appId = slackSocketScope.installationId) { this.frame({type:'hello', connection_info:{app_id:appId}}); }
}

function slackProtocolHarness() {
  const controller = new AbortController();
  const sockets = [];
  const statuses = [];
  const resolved = [];
  const requests = [];
  const transport = createSlackSocketModeTransport(slackSocketScope, 'credential:slack/test-app', (reference, signal) => {
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    resolved.push(reference);
    return {kind:'app-level', value:'xapp-protocol-fixture'};
  }, {
    async fetch(url, init) {
      requests.push({url, init});
      return Response.json({ok:true, url:'wss://wss-primary.slack.com/link/?ticket=fixture-' + requests.length});
    },
    openSocket(url) {
      const socket = new SlackProtocolSocket();
      sockets.push({socket, url});
      return socket;
    },
  });
  return {controller, sockets, statuses, resolved, requests, start(onEvent, resolveThreadCase) {
    return transport.run({signal:controller.signal, onEvent, onStatus:status => statuses.push(status), resolveThreadCase});
  }};
}

function slackProtocolMessage(id, event = {}, callback = {}) {
  return {
    type:'events_api', envelope_id:id, accepts_response_payload:false,
    payload:{type:'event_callback', api_app_id:'A01', team_id:'T01', event_id:'Ev01', ...callback,
      event:{type:'message', user:'U01', channel:'C01', ts:'1234567890.000001', text:'Reproduce the reported behavior', ...event}},
  };
}

test('Slack Socket Mode posts protected app credentials and ACKs only after durable admission; reconnect redelivery keeps its identity', {timeout:5000}, async t => {
  const fixture = slackProtocolHarness();
  t.after(() => fixture.controller.abort());
  const retained = new Map();
  const delivered = [];
  let onRetain;
  const barrier = new Promise(resolve => { onRetain = resolve; });
  const completion = fixture.start(async event => {
    delivered.push(event);
    if (retained.has(event.eventKey)) return {status:'REUSED'};
    await barrier;
    retained.set(event.eventKey, event.payloadDigest);
    return {status:'RETAINED'};
  });
  await setImmediate();
  assert.equal(fixture.sockets.length, 1);
  const [{socket}] = fixture.sockets;
  assert.deepEqual(fixture.resolved, ['credential:slack/test-app']);
  assert.equal(fixture.requests[0].url, 'https://slack.com/api/apps.connections.open');
  assert.equal(fixture.requests[0].init.method, 'POST');
  assert.equal(fixture.requests[0].init.headers.Authorization, 'Bearer xapp-protocol-fixture');
  assert.equal(fixture.requests[0].init.body, undefined);
  assert.equal(fixture.requests[0].init.redirect, 'error');
  assert.equal(fixture.sockets[0].url.hostname, 'wss-primary.slack.com');

  socket.frame(slackProtocolMessage('too-early'));
  await setImmediate();
  assert.deepEqual(socket.sent, []);
  assert.deepEqual(delivered, []);
  socket.hello();
  socket.frame(slackProtocolMessage('first'));
  await setImmediate();
  assert.equal(delivered.length, 1);
  assert.deepEqual(socket.sent, []);
  onRetain();
  await setImmediate();
  assert.deepEqual(socket.sent, [{envelope_id:'first'}]);

  socket.frame({type:'disconnect', reason:'refresh_requested'});
  await setImmediate();
  assert.equal(socket.readyState, 3);
  assert.equal(fixture.sockets.length, 2);
  assert.equal(fixture.resolved.length, 2);
  assert.notEqual(fixture.sockets[0].url.search, fixture.sockets[1].url.search);
  const replacement = fixture.sockets[1].socket;
  replacement.hello();
  replacement.frame(slackProtocolMessage('redelivery', {}, {event_time:42}));
  await setImmediate();
  assert.deepEqual(delivered[1], delivered[0]);
  assert.equal(retained.size, 1);
  assert.deepEqual(replacement.sent, [{envelope_id:'redelivery'}]);
  fixture.controller.abort();
  assert.equal(await completion, 'STOPPED');
  assert.equal(replacement.readyState, 3);
  assert.deepEqual(fixture.statuses, ['INTERRUPTED','READY','INTERRUPTED','READY','INTERRUPTED']);
});

test('Slack Socket Mode routes only authenticated app, workspace and conversation messages and isolates malformed deliveries', {timeout:5000}, async t => {
  const fixture = slackProtocolHarness();
  t.after(() => fixture.controller.abort());
  const admitted = [];
  const originalTs = '1234567890.000001';
  const result = fixture.start(event => {
    admitted.push(event);
    return {status:'RETAINED'};
  }, (route, timestamp) => {
    assert.deepEqual(route, slackSocketScope);
    return timestamp === originalTs ? 'feedback-case:fixture' : undefined;
  });
  await setImmediate();
  const {socket} = fixture.sockets[0];
  socket.hello();
  socket.dispatchEvent(new MessageEvent('message', {data:'{'}));
  socket.frame({type:'events_api', envelope_id:'bad-payload', payload:{}});
  socket.frame(slackProtocolMessage('bad-event', {text:null}));
  socket.frame(slackProtocolMessage('bad\n-id'));
  socket.frame(slackProtocolMessage('different-installation', {}, {api_app_id:'A99'}));
  socket.frame(slackProtocolMessage('different-workspace', {}, {team_id:'T99'}));
  socket.frame(slackProtocolMessage('different-conversation', {channel:'C99'}));
  socket.frame(slackProtocolMessage('bot', {bot_id:'B01'}));
  socket.frame(slackProtocolMessage('thread', {thread_ts:originalTs, ts:'1234567890.000002'}, {event_id:'Ev02'}));
  await setImmediate();
  assert.deepEqual(admitted.map(event => event.action), [
    {kind:'supplement', caseId:'feedback-case:fixture', text:'Reproduce the reported behavior'},
  ]);
  assert.deepEqual(socket.sent.map(frame => frame.envelope_id),
    ['different-installation', 'different-workspace', 'different-conversation', 'bot', 'thread']);
  fixture.controller.abort();
  assert.equal(await result, 'STOPPED');

  const wrong = slackProtocolHarness();
  t.after(() => wrong.controller.abort());
  const blocked = wrong.start(() => assert.fail('Unbound app reached the owner'));
  await setImmediate();
  wrong.sockets[0].socket.hello('A99');
  assert.equal(await blocked, 'BLOCKED');
  assert.deepEqual(wrong.statuses, ['INTERRUPTED','BLOCKED']);
  assert.deepEqual(wrong.sockets[0].socket.sent, []);
});

test('Slack Socket Mode rejects nonofficial socket hosts and unsafe socket URLs before connecting', {timeout:5000}, async () => {
  for (const url of [
    'wss://wss.slack.com.example.invalid/link/?ticket=fixture',
    'wss://wss-evil.slack.com.example.invalid/link/?ticket=fixture',
    'wss://elsewhere.slack.com/link/?ticket=fixture',
    'wss://wss.slack.com@elsewhere.invalid/link/?ticket=fixture',
    'wss://user@wss.slack.com/link/?ticket=fixture',
    'ws://wss.slack.com/link/?ticket=fixture',
    'wss://wss.slack.com:8443/link/?ticket=fixture',
    'wss://wss.slack.com/unexpected/?ticket=fixture',
    'wss://wss.slack.com/link/?ticket=fixture&ticket=duplicate',
    'wss://wss.slack.com/link/?ticket=fixture#secret',
  ]) {
    let dialed = false;
    const transport = createSlackSocketModeTransport(slackSocketScope, 'credential:slack/test-app',
      () => ({kind:'app-level', value:'xapp-protocol-fixture'}), {
        async fetch() { return Response.json({ok:true, url}); },
        openSocket() { dialed = true; return new SlackProtocolSocket(); },
      });
    assert.equal(await transport.run({signal:AbortSignal.timeout(1000), onEvent:() => assert.fail()}), 'BLOCKED');
    assert.equal(dialed, false);
  }
});

test('Slack Socket Mode leaves owner failures unacknowledged and aborts an unresolved credential read', {timeout:5000}, async t => {
  const fixture = slackProtocolHarness();
  t.after(() => fixture.controller.abort());
  const completion = fixture.start(() => { throw new Error('Fixture retention failure'); });
  await setImmediate();
  const {socket} = fixture.sockets[0];
  socket.hello();
  socket.frame(slackProtocolMessage('unretained'));
  await setImmediate();
  assert.deepEqual(socket.sent, []);
  assert.equal(socket.readyState, 3);
  assert.deepEqual(fixture.statuses, ['INTERRUPTED','READY','INTERRUPTED']);
  fixture.controller.abort();
  assert.equal(await completion, 'STOPPED');

  const controller = new AbortController();
  const stalled = createSlackSocketModeTransport(slackSocketScope, 'credential:slack/test-app',
    () => new Promise(() => {}), {async fetch() { assert.fail('Credential resolution never finished'); }});
  const stopping = stalled.run({signal:controller.signal, onEvent:() => assert.fail()});
  controller.abort();
  assert.equal(await stopping, 'STOPPED');
});

test('Slack Socket Mode reuses real Runtime retention when the socket closes before the first ACK', {timeout:5000}, async t => {
  const {mkdtempSync, realpathSync, rmSync} = await import('node:fs');
  const {join} = await import('node:path');
  const {tmpdir} = await import('node:os');
  const {RuntimeStore} = await import('../../dist/server/store.js');
  const {retainFeedbackChannelEvent} = await import('../../dist/feedback-loop/ingress.js');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'runtime-slack-protocol-'));
  const fixture = slackProtocolHarness();
  const route = {workspaceId:'workspace', projectId:'project', scope:slackSocketScope};
  const actor = {id:'receiver', projects:['project'], permissions:['read','execution.request'],
    revision:1, expiresAt:'2099-01-01T00:00:00Z'};
  let store = new RuntimeStore(root, route.workspaceId);
  t.after(() => {
    fixture.controller.abort();
    store.close();
    rmSync(root, {recursive:true, force:true});
  });

  const seen = [];
  let releaseFirst;
  const delayedResult = new Promise(resolve => { releaseFirst = resolve; });
  const completion = fixture.start(async (event, signal) => {
    const {eventKey, payloadDigest, ...input} = event;
    const result = retainFeedbackChannelEvent(store, route, actor, input);
    seen.push({result, signal});
    if (result.status === 'RETAINED') await delayedResult;
    return result;
  });
  await setImmediate();
  const first = fixture.sockets[0].socket;
  first.hello();
  first.frame(slackProtocolMessage('original'));
  assert.equal(store.revision(route.projectId), 1);
  assert.deepEqual(first.sent, []);
  first.frame({type:'disconnect', reason:'refresh_requested'});
  assert.equal(seen[0].signal.aborted, true);
  store.close();
  store = new RuntimeStore(root, route.workspaceId);

  await setImmediate();
  const second = fixture.sockets[1].socket;
  second.hello();
  second.frame(slackProtocolMessage('replayed'));
  await setImmediate();
  assert.equal(seen[1].result.status, 'REUSED');
  assert.equal(seen[1].result.caseId, seen[0].result.caseId);
  assert.equal(store.revision(route.projectId), 1);
  assert.deepEqual(second.sent, [{envelope_id:'replayed'}]);
  releaseFirst();
  await setImmediate();
  assert.deepEqual(first.sent, []);
  assert.deepEqual(second.sent, [{envelope_id:'replayed'}]);
  fixture.controller.abort();
  assert.equal(await completion, 'STOPPED');
});
