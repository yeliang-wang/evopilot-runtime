import { digest, reject, string } from '../server/errors.js';

const windowMs = 60 * 60 * 1000;
const commit = /^[a-f0-9]{40}$/;
const sha256 = /^[a-f0-9]{64}$/;

export interface ReviewCandidate {
  workspaceId: string;
  projectId: string;
  repositoryId: string;
  pullRequestId: string;
  head: string;
  base: string;
  evidenceDigest: string;
  policyDigest: string;
}
interface ReviewWindow {
  id: string;
  candidate: ReviewCandidate;
  candidateDigest: string;
  notificationRef: string;
  notificationIntentRef: string;
  openedAt: number;
  deadline: number;
  veto: { actorRef: string; eventKey: string; observedAt: number } | null;
  claim: { requestId: string; claimedAt: number } | null;
}

function time(at: number): number {
  if (!Number.isSafeInteger(at) || at <= 0 || at > Number.MAX_SAFE_INTEGER - windowMs) {
    return reject('FEEDBACK_CLOCK', 'Expected a bounded authoritative timestamp.');
  }
  return at;
}

/** A delivery intent reserves this identity before the provider assigns a message ID. */
export function feedbackReviewId(candidate: ReviewCandidate, notificationIntentRef: string): string {
  return 'feedback-review:' + digest({candidate, intent:string(notificationIntentRef)});
}

/** Accepts only the operator's verified notification and candidate observation. */
export function openFeedbackReview(candidate: ReviewCandidate, notificationIntentRef: string, notificationRef: string, observedAt: number): ReviewWindow {
  time(observedAt);
  if (![candidate.head, candidate.base].every(value => commit.test(value)) ||
      ![candidate.evidenceDigest, candidate.policyDigest].every(value => sha256.test(value))) {
    return reject('FEEDBACK_REVIEW_CANDIDATE', 'Exact source and policy digests are required.');
  }
  for (const field of [candidate.workspaceId, candidate.projectId, candidate.repositoryId, candidate.pullRequestId]) {
    string(field, 100);
  }
  const candidateDigest = digest(candidate);
  const notice = string(notificationRef);
  return {
    id: feedbackReviewId(candidate, notificationIntentRef),
    candidate: {...candidate},
    candidateDigest,
    notificationRef: notice,
    notificationIntentRef,
    openedAt: observedAt,
    deadline: observedAt + windowMs,
    veto: null,
    claim: null,
  };
}

/** Call inside the same transaction as the original authenticated inbound event.
 * receivedAt is the Runtime receipt time, never a provider-supplied client timestamp. */
export function recordFeedbackVeto(window: ReviewWindow, action: {
  windowId: string; actorRef: string; eventKey: string; receivedAt: number;
}): ReviewWindow {
  time(action.receivedAt);
  if (action.windowId !== window.id || window.claim || action.receivedAt < window.openedAt || action.receivedAt >= window.deadline) {
    return reject('FEEDBACK_REVIEW_CLOSED', 'The selected review window no longer accepts changes.', 409);
  }
  if (window.veto) return window;
  return {...window, veto: {actorRef: string(action.actorRef), eventKey: string(action.eventKey), observedAt: action.receivedAt}};
}

export interface MergeObservation {
  candidate: ReviewCandidate;
  now: number;
  policyCurrent: boolean;
  receiptCoverage: 'COMPLETE' | 'UNCERTAIN';
  githubChecksPassed: boolean;
  baseProtected: boolean;
}

/** Pure decision; the owner must write the resulting claim by CAS before provider dispatch.
 * No approved window, observer read, or claim proves that GitHub performed the merge. */
export function claimFeedbackMerge(window: ReviewWindow, observation: MergeObservation): ReviewWindow {
  time(observation.now);
  if (window.claim) return reject('FEEDBACK_RECONCILE_ORIGINAL', 'Inspect the original merge claim.', 409);
  if (window.veto) return reject('FEEDBACK_REVIEW_VETO', 'The selected candidate was vetoed.', 409);
  if (observation.now < window.deadline) {
    return reject('FEEDBACK_REVIEW_WAITING', 'The complete review window has not elapsed.', 409);
  }
  if (!observation.policyCurrent || observation.receiptCoverage !== 'COMPLETE' ||
      !observation.githubChecksPassed || !observation.baseProtected ||
      digest(observation.candidate) !== window.candidateDigest) {
    return reject('FEEDBACK_MERGE_BLOCKED', 'Current authority, review coverage or candidate qualification is insufficient.', 409);
  }
  return {...window, claim: {requestId: 'feedback-merge:' + digest(window.id), claimedAt: observation.now}};
}
