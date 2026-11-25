import { digest, reject } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import type { RuntimeStore } from '../server/store.js';
import { normalizeChannelEvent, type ChannelScope } from './channel.js';
import { claimFeedbackMerge, openFeedbackReview, recordFeedbackVeto, type MergeObservation, type ReviewCandidate } from './review.js';

type Window = ReturnType<typeof openFeedbackReview>;
type ReviewScope = {workspaceId:string; projectId:string; channel:ChannelScope; allowedActorIds:readonly string[]};
type StoredWindow = Window & {audienceDigest:string};
const windowKind = 'feedback-review-window';
const audienceDigest = (scope: ReviewScope) => digest({channel:scope.channel, actors:[...new Set(scope.allowedActorIds)].sort()});

function requireScope(store: RuntimeStore, workspaceId: string, projectId: string, principal: Principal) {
  if (workspaceId !== store.workspaceId) reject('CHANNEL_SCOPE_MISMATCH', 'Wrong review workspace.', 403);
  authorize(principal, projectId, 'execution.request');
}

function readWindow(store: RuntimeStore, projectId: string, id: string): StoredWindow {
  return store.object(projectId, windowKind, id) as StoredWindow | null ??
    reject('FEEDBACK_REVIEW_UNKNOWN', 'The original review window was not found.', 404);
}

function pointerId(candidate: ReviewCandidate) {
  return digest({repository:candidate.repositoryId, pr:candidate.pullRequestId});
}

const vetoIndexId = (candidate: ReviewCandidate) => digest({pr:pointerId(candidate),head:candidate.head});

function activeWindow(store: RuntimeStore, window: Window) {
  const current = store.object(window.candidate.projectId, 'feedback-review-current', pointerId(window.candidate));
  if (current !== window.id) reject('FEEDBACK_REVIEW_CLOSED', 'The review window was superseded.', 409);
}

/** Internal entry for a verified provider notification, with evidence bound by the caller. */
export function retainFeedbackReview(store: RuntimeStore, principal: Principal, scope: ReviewScope, candidate: ReviewCandidate, notificationIntentRef: string, notificationRef: string, observedAt: number): Window {
  requireScope(store, scope.workspaceId, scope.projectId, principal);
  if (scope.workspaceId !== candidate.workspaceId || scope.projectId !== candidate.projectId || !scope.allowedActorIds.length) {
    reject('FEEDBACK_REVIEW_FORBIDDEN', 'A verified project reviewer audience is required.', 403);
  }
  const window = {...openFeedbackReview(candidate, notificationIntentRef, notificationRef, observedAt), audienceDigest:audienceDigest(scope)};
  const projectId = candidate.projectId;
  const pointer = pointerId(candidate);
  const noticeKey = digest({channel:scope.channel, notificationRef});
  const originalWindow = store.object(projectId, 'feedback-review-notification', noticeKey);
  if (originalWindow !== null && originalWindow !== window.id) {
    reject('FEEDBACK_REVIEW_NOTIFICATION_CONFLICT', 'The original provider message binds another review.', 409);
  }
  const prior = store.object(projectId, windowKind, window.id) as StoredWindow | null;
  if (prior) {
    if (prior.audienceDigest !== window.audienceDigest || prior.notificationRef !== notificationRef) reject('FEEDBACK_REVIEW_AUDIENCE_CHANGED', 'The original notification binds a different audience.', 409);
    return prior;
  }
  if (store.object(projectId, 'feedback-vetoed-head', vetoIndexId(candidate))) {
    reject('FEEDBACK_REVIEW_VETO', 'A vetoed PR requires a new revision before review.', 409);
  }
  const currentId = store.object(projectId, 'feedback-review-current', pointer) as string | null;
  if (currentId) {
    const current = readWindow(store, projectId, currentId);
    if (current.claim) reject('FEEDBACK_RECONCILE_ORIGINAL', 'Inspect the original merge claim.', 409);

  }
  store.mutate(principal, {
    projectId, operation:'feedback.review.open', requestId:window.id,
    expectedRevision:store.revision(projectId), permission:'execution.request', input:{candidateDigest:window.candidateDigest},
  }, () => ({
    value:{windowId:window.id, deadline:window.deadline},
    objects:[
      {kind:windowKind,id:window.id,value:window},
      {kind:'feedback-review-current',id:pointer,value:window.id},
      {kind:'feedback-review-notification',id:noticeKey,value:window.id},
    ],
    event:{type:'feedback-review-opened',data:{windowId:window.id, deadline:window.deadline}},
  }));
  return window;
}

/** Transport authenticates the event and its actor. This transaction commits the
 * original provider event and veto before any success acknowledgment. */
export function retainFeedbackVeto(store: RuntimeStore, principal: Principal, scope: ReviewScope, input: unknown, clock = Date.now): Window {
  const receivedAt = clock();
  const {workspaceId, projectId} = scope;
  requireScope(store, workspaceId, projectId, principal);
  const event = normalizeChannelEvent(input, scope.channel);
  const action = event.action;
  if (action.kind !== 'veto' || !scope.allowedActorIds.includes(event.actorId)) {
    return reject('FEEDBACK_REVIEW_FORBIDDEN', 'The actor cannot veto this review.', 403);
  }
  const window = readWindow(store, projectId, action.reviewId);
  if (window.audienceDigest !== audienceDigest(scope) || window.notificationRef !== event.messageId) {
    reject('FEEDBACK_REVIEW_FORBIDDEN', 'Veto does not reference the verified notification and audience.', 403);
  }
  const original = store.object(projectId, 'feedback-channel-event', event.eventKey) as {event:{payloadDigest:string}} | null;
  if (original) {
    if (original.event.payloadDigest !== event.payloadDigest) {
      reject('CHANNEL_EVENT_CONFLICT', 'Provider event identity already has different content.', 409);
    }
    return window;
  }
  let updated: Window = window;
  store.mutate(principal, {
    projectId, operation:'feedback.review.veto', requestId:event.eventKey,
    expectedRevision:store.revision(projectId), permission:'execution.request', input:{payloadDigest:event.payloadDigest},
  }, () => {
    activeWindow(store, window);
    updated = recordFeedbackVeto(window, {windowId:action.reviewId, actorRef:event.actorId, eventKey:event.eventKey, receivedAt});
    return {
      value:{windowId:window.id},
      objects:[
        {kind:windowKind,id:window.id,value:updated},
        {kind:'feedback-channel-event',id:event.eventKey,value:{event,receivedAt}},
        {kind:'feedback-vetoed-head',id:vetoIndexId(window.candidate),value:{firstVeto:updated.veto}},
      ],
      event:{type:'feedback-review-vetoed',data:{windowId:window.id,eventKey:event.eventKey}},
    };
  });
  return updated;
}

/** One synchronous reservation. The provider call and its exact readback are separate. */
export function reserveFeedbackMerge(store: RuntimeStore, principal: Principal, windowId: string, observed: Omit<MergeObservation,'now'>, clock = Date.now): Window {
  const {workspaceId, projectId} = observed.candidate;
  requireScope(store,workspaceId,projectId,principal);
  const window = readWindow(store,projectId,windowId);
  activeWindow(store,window);
  const updated = claimFeedbackMerge(window,{...observed,now:clock()});
  const claim = updated.claim!;
  store.mutate(principal, {
    projectId, operation:'feedback.merge.reserve', requestId:claim.requestId,
    expectedRevision:store.revision(projectId), permission:'execution.request', input:{candidateDigest:window.candidateDigest},
  }, () => ({
    value:{windowId,claim},
    objects:[{kind:windowKind,id:windowId,value:updated}],
    event:{type:'feedback-merge-reserved',data:{windowId,requestId:claim.requestId}},
  }));
  return updated;
}
