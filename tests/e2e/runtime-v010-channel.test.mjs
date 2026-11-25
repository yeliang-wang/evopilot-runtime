import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeChannelEvent } from '../../dist/feedback-loop/channel.js';
import { normalizeSlackSocketModeEvent } from '../../dist/feedback-loop/slack.js';

const scope = { provider: 'slack', installationId: 'A00', tenantId: 'T00', channelId: 'C00' };
const event = {
  schema: 'runtime-feedback-channel-event/v1',
  scope,
  eventId: 'Ev001',
  messageId: '1732471200.001000',
  actorId: 'U00',
  action: { kind: 'feedback', text: '复现步骤 🧪\r\n\tReview the received request.  ' },
};

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
