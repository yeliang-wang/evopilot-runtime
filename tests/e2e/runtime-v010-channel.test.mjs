import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeChannelEvent } from '../../dist/feedback-loop/channel.js';

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
