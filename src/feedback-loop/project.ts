import { authorize, type Principal } from '../server/security.js';
import type { RuntimeStore } from '../server/store.js';
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

const bindingFields = [
  'feedbackBindingRef', 'reviewBindingRef', 'linearTeamRef', 'githubRepositoryRef',
  'cursorAgentRef', 'harnessRuleRef', 'mergePolicyRef',
] as const;
const configFields = [...bindingFields, 'reviewWindowMinutes'] as const;
const draftScope = ['workspaceId', 'projectId'] as const;
type DraftConfiguration = Pick<FeedbackProjectDraft, typeof draftScope[number]> &
  Partial<Pick<FeedbackProjectDraft, typeof configFields[number]>>;

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
  exact(row, [...draftScope, ...configFields]);
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
  requireDraftScope(draft, workspaceId, projectId);
  return {
    draftDigest: digest(draft),
    structure: 'VALID',
    validatedProject: {workspaceId, projectId},
    providerBindings: 'NOT_EVALUATED',
    activationAuthorized: false,
  };
}

export const FEEDBACK_PROJECT_INSPECT = 'feedback.project.inspect';
export const FEEDBACK_PROJECT_SAVE = 'feedback.project.draft.save';

function requireDraftScope(draft: Pick<DraftConfiguration,'workspaceId'|'projectId'>, workspaceId: string, projectId: string) {
  if (draft.workspaceId !== workspaceId || draft.projectId !== projectId) {
    reject('FEEDBACK_PROJECT_SCOPE', 'Feedback draft does not match the authenticated project.', 403);
  }
}

function readDraftEdit(value: unknown): DraftConfiguration {
  const row = record(value);
  exact(row, draftScope, configFields);
  const draft: DraftConfiguration = {workspaceId:slug(row.workspaceId),projectId:slug(row.projectId)};
  for (const field of bindingFields) {
    if (Object.hasOwn(row, field)) draft[field] = reference(row[field]);
  }
  if (Object.hasOwn(row, 'reviewWindowMinutes')) {
    if (row.reviewWindowMinutes !== 60) reject('FEEDBACK_REVIEW_WINDOW', 'The v0.10 Preview review window is sixty minutes.');
    draft.reviewWindowMinutes = 60;
  }
  return draft;
}

function summarizeDraft(configuration: DraftConfiguration) {
  return {
    status:'DRAFT' as const,
    draftDigest:digest(configuration),
    configuration,
    missingFields:configFields.filter(field => !Object.hasOwn(configuration,field)),
    providerBindings:'NOT_EVALUATED' as const,
    activationAuthorized:false as const,
  };
}

export function readSavedFeedbackProjectDraft(store: RuntimeStore, actor: Principal, projectId: string) {
  authorize(actor,projectId,'read');
  const pointer = store.object(projectId,'feedback-project-draft-pointer','current');
  if (pointer === null) return {revision:store.revision(projectId),draft:null};
  const revision = string(pointer,64);
  const value = store.object(projectId,'feedback-project-draft',revision);
  if (!value || digest(value) !== revision) reject('CORRUPT_FEEDBACK_DRAFT','Saved draft does not match its pointer.',503);
  const configuration = readDraftEdit(value);
  requireDraftScope(configuration,store.workspaceId,projectId);
  return {revision:store.revision(projectId),draft:summarizeDraft(configuration)};
}

export function saveFeedbackProjectDraft(
  store: RuntimeStore, actor: Principal, projectId: string, input: Record<string,unknown>,
  requestId: string, expectedRevision: number, reauthorize: () => Principal,
) {
  authorize(actor,projectId,'draft.write');
  const draft = readDraftEdit(input);
  requireDraftScope(draft,store.workspaceId,projectId);
  const summary = summarizeDraft(draft);
  return store.mutate(actor,{
    projectId,operation:FEEDBACK_PROJECT_SAVE,requestId,expectedRevision,input,permission:'draft.write',
  },() => ({
    value:summary,
    objects:[
      {kind:'feedback-project-draft',id:summary.draftDigest,value:draft},
      {kind:'feedback-project-draft-pointer',id:'current',value:summary.draftDigest},
    ],
    event:{type:'feedback-project-draft-saved',data:{draftDigest:summary.draftDigest}},
  }),reauthorize);
}
