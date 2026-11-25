import { digest, exact, record, reject, slug, string } from '../server/errors.js';

export type FeedbackCapability = 'receive-feedback' | 'reply' | 'notify' | 'review-action';
const feedbackCapabilities = ['receive-feedback', 'reply'] as const;
const reviewCapabilities = ['notify', 'review-action'] as const;

interface FeedbackProjectDraft {
  workspaceId: string;
  projectId: string;
  feedbackBindingRef: string;
  reviewBindingRef: string;
  linearTeamRef: string;
  githubRepositoryRef: string;
  cursorAgentRef: string;
  harnessRuleRef: string;
  mergePolicyRef: string;
  reviewWindowMinutes: 60;
}

export interface FeedbackConnectionObservation {
  workspaceId: string;
  projectId: string;
  reference: string;
  status: 'READY' | 'UNAVAILABLE';
  capabilities: readonly FeedbackCapability[];
  revision: number;
  validUntil: number;
}

type BindingRequirement = { reference: string; capabilities: readonly FeedbackCapability[] };
const reference = (value: unknown) => {
  const ref = string(value, 200);
  if (!/^binding:[a-z][a-z0-9-]*(\/[a-z0-9][a-z0-9._-]*){1,5}$/.test(ref)) {
    return reject('FEEDBACK_BINDING_REFERENCE', 'Use a protected registered binding reference.');
  }
  return ref;
};

export function parseFeedbackProjectDraft(value: unknown): FeedbackProjectDraft {
  const row = record(value);
  exact(row, [
    'workspaceId', 'projectId', 'feedbackBindingRef', 'reviewBindingRef', 'linearTeamRef',
    'githubRepositoryRef', 'cursorAgentRef', 'harnessRuleRef', 'mergePolicyRef', 'reviewWindowMinutes',
  ]);
  if (row.reviewWindowMinutes !== 60) {
    return reject('FEEDBACK_REVIEW_WINDOW', 'The v0.10 Preview review window is sixty minutes.');
  }
  return {
    workspaceId: slug(row.workspaceId),
    projectId: slug(row.projectId),
    feedbackBindingRef: reference(row.feedbackBindingRef),
    reviewBindingRef: reference(row.reviewBindingRef),
    linearTeamRef: reference(row.linearTeamRef),
    githubRepositoryRef: reference(row.githubRepositoryRef),
    cursorAgentRef: reference(row.cursorAgentRef),
    harnessRuleRef: reference(row.harnessRuleRef),
    mergePolicyRef: reference(row.mergePolicyRef),
    reviewWindowMinutes: 60,
  };
}

/** Consumes trusted connection observations from the service, never request-provided proof. */
export function inspectFeedbackChannelReadiness(
  draft: FeedbackProjectDraft,
  observations: readonly FeedbackConnectionObservation[],
  now: number,
) {
  if (!Number.isSafeInteger(now) || now <= 0) {
    return reject('FEEDBACK_CLOCK', 'A current authoritative timestamp is required.');
  }
  const requirements: BindingRequirement[] = [
    { reference: draft.feedbackBindingRef, capabilities: feedbackCapabilities },
    { reference: draft.reviewBindingRef, capabilities: reviewCapabilities },
  ];
  const results = requirements.map(({ reference, capabilities }) => {
    const matches = observations.filter(item => item.reference === reference);
    const observation = matches[0];
    const valid = matches.length === 1 && observation.workspaceId === draft.workspaceId &&
      observation.projectId === draft.projectId && observation.status === 'READY' &&
      Number.isSafeInteger(observation.revision) && observation.revision > 0 &&
      Number.isSafeInteger(observation.validUntil) && observation.validUntil > now;
    const missing = capabilities.filter(capability => !valid || !observation.capabilities.includes(capability));
    return {
      reference,
      missing,
      revision: valid ? observation.revision : null,
      ready: valid && missing.length === 0,
    };
  });
  return {
    draftDigest: digest(draft),
    channelsReady: results.every(result => result.ready),
    feedback: results[0],
    review: results[1],
  };
}

export const FEEDBACK_PROJECT_VALIDATE = 'feedback.project.validate';

/** Expert previews only the scoped draft. Provider registration and activation
 * have separate authority and are never inferred from a successful read. */
export function inspectFeedbackProjectDraft(input: unknown, workspaceId: string, projectId: string) {
  const draft = parseFeedbackProjectDraft(input);
  if (draft.workspaceId !== workspaceId || draft.projectId !== projectId) {
    reject('FEEDBACK_PROJECT_SCOPE', 'Feedback draft does not match the authenticated project.', 403);
  }
  return {
    draftDigest: digest(draft),
    structure: 'VALID',
    validatedProject: {workspaceId, projectId},
    providerBindings: 'NOT_EVALUATED',
    activationAuthorized: false,
  };
}
