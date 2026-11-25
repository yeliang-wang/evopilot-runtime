import assert from 'node:assert/strict';
import test from 'node:test';
import { claimFeedbackMerge, feedbackReviewId, openFeedbackReview, recordFeedbackVeto } from '../../dist/feedback-loop/review.js';

const candidate = {
  workspaceId:'demo', projectId:'tasks', repositoryId:'21', pullRequestId:'5',
  head:'a'.repeat(40), base:'b'.repeat(40), evidenceDigest:'c'.repeat(64), policyDigest:'d'.repeat(64),
};
const start = 1_800_000_000_000;
const fixture = () => openFeedbackReview(candidate, 'intent-5', 'notice-5', start);
const observed = window => ({
  candidate, now:window.deadline, policyCurrent:true, receiptCoverage:'COMPLETE',
  githubChecksPassed:true, baseProtected:true,
});
test('window lasts sixty full minutes and a retained claim requires reconciliation', () => {
  const window = fixture();
  assert.equal(window.deadline - window.openedAt, 3_600_000);
  assert.throws(() => claimFeedbackMerge(window, {...observed(window), now:window.deadline - 1}), {code:'FEEDBACK_REVIEW_WAITING'});
  const claimed = claimFeedbackMerge(window, observed(window));
  assert.equal(claimed.claim.claimedAt, window.deadline);
  assert.throws(() => claimFeedbackMerge(claimed, observed(window)), {code:'FEEDBACK_RECONCILE_ORIGINAL'});
});
test('an authenticated veto recorded before cutoff blocks the original candidate', () => {
  const window = fixture();
  const action = {windowId:window.id, actorRef:'authorized-reviewer', eventKey:'original-event', receivedAt:window.deadline-1};
  const vetoed = recordFeedbackVeto(window, action);
  assert.equal(recordFeedbackVeto(vetoed, action), vetoed);
  assert.throws(() => claimFeedbackMerge(vetoed, observed(window)), {code:'FEEDBACK_REVIEW_VETO'});
  assert.throws(() => recordFeedbackVeto(window, {...action, receivedAt:window.deadline}), {code:'FEEDBACK_REVIEW_CLOSED'});
  assert.throws(() => recordFeedbackVeto(window, {...action, windowId:'old-window'}), {code:'FEEDBACK_REVIEW_CLOSED'});
});
test('changed candidate, uncertain coverage, invalid authority or failed GitHub guards block merging', () => {
  const window = fixture();
  for (const change of [
    {candidate:{...candidate, head:'e'.repeat(40)}}, {candidate:{...candidate, base:'f'.repeat(40)}},
    {receiptCoverage:'UNCERTAIN'}, {policyCurrent:false}, {githubChecksPassed:false}, {baseProtected:false},
  ]) {
    assert.throws(() => claimFeedbackMerge(window, {...observed(window), ...change}), {code:'FEEDBACK_MERGE_BLOCKED'});
  }
});

test('veto and merge share durable state; stale notification, duplicate delivery and restart are safe', async () => {
  const { mkdtempSync, realpathSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { RuntimeStore } = await import('../../dist/server/store.js');
  const { retainFeedbackReview, retainFeedbackVeto, reserveFeedbackMerge } = await import('../../dist/feedback-loop/service.js');
  const root = mkdtempSync(join(realpathSync(tmpdir()),'runtime-v010-review-'));
  const actor = {id:'operator',projects:['tasks'],permissions:['execution.request'],revision:1,expiresAt:'2099-01-01T00:00:00Z'};
  const scope = {
    workspaceId:'demo',projectId:'tasks',allowedActorIds:['reviewer'],
    channel:{provider:'callback',installationId:'adapter',tenantId:'team',channelId:'review-channel'},
  };
  let store = new RuntimeStore(root, 'demo');
  try {
    const window = retainFeedbackReview(store, actor, scope, candidate, 'intent-5', 'notice-5', start);
    assert.equal(window.id, feedbackReviewId(candidate, 'intent-5'));
    assert.deepEqual(retainFeedbackReview(store, actor, scope, candidate, 'intent-5', 'notice-5', start + 2000), window);
    assert.throws(() => retainFeedbackReview(store, actor, scope, candidate, 'other-intent', 'notice-5', start + 2000), {code:'FEEDBACK_REVIEW_NOTIFICATION_CONFLICT'});
    const original = {
      schema:'runtime-feedback-channel-event/v1',scope:scope.channel,eventId:'veto-1',messageId:'notice-5',
      actorId:'reviewer',action:{kind:'veto',reviewId:window.id},
    };
    assert.throws(() => retainFeedbackVeto(store, actor, scope, {...original,messageId:'other'}, () => start+1), {code:'FEEDBACK_REVIEW_FORBIDDEN'});
    const vetoed = retainFeedbackVeto(store, actor, scope, original, () => start+1);
    assert.equal(vetoed.veto.actorRef,'reviewer');
    store.close();
    store = new RuntimeStore(root, 'demo');
    assert.equal(retainFeedbackVeto(store, actor, scope, original, () => start+2).veto.eventKey,vetoed.veto.eventKey);
    assert.throws(() => reserveFeedbackMerge(store, actor, window.id, observed(window), () => window.deadline), {code:'FEEDBACK_REVIEW_VETO'});
    assert.throws(() => retainFeedbackReview(store, actor, scope, candidate, 'intent-retry', 'notice-retry', start+9), {code:'FEEDBACK_REVIEW_VETO'});
    const newCandidate = {...candidate,head:'e'.repeat(40)};
    const next = retainFeedbackReview(store, actor, scope, newCandidate,'intent-6','notice-6',start+10);
    assert.throws(() => retainFeedbackVeto(store, actor, scope, {...original,eventId:'veto-2'},() => start+12), {code:'FEEDBACK_REVIEW_CLOSED'});
    assert.throws(() => retainFeedbackReview(store, actor, scope, candidate,'intent-reopened','notice-reopened',start+11), {code:'FEEDBACK_REVIEW_VETO'});
    const admission = {...observed(next),candidate:newCandidate};
    assert(reserveFeedbackMerge(store, actor, next.id, admission, () => next.deadline).claim);
    assert.throws(() => reserveFeedbackMerge(store, actor, next.id, admission, () => next.deadline), {code:'FEEDBACK_RECONCILE_ORIGINAL'});
    assert.equal(store.revision('tasks'),4);
  } finally {
    store.close();
    rmSync(root,{recursive:true,force:true});
  }
});
