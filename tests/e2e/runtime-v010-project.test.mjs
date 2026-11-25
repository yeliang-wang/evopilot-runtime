import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectFeedbackChannelReadiness, parseFeedbackProjectDraft } from '../../dist/feedback-loop/project.js';

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
