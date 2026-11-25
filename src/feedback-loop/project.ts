import { isAlias, isNode, parseDocument, visit } from 'yaml';
import { byteDigest } from '../lifecycle/base.js';
import { containsInlineSecret } from '../lifecycle/compiler.js';
import { authorize, type Principal } from '../server/security.js';
import type { RuntimeStore } from '../server/store.js';
import { digest, exact, record, reject, slug, string } from '../server/errors.js';

export type FeedbackCapability = 'receive-feedback' | 'reply' | 'notify' | 'review-action';
const feedbackCapabilities = ['receive-feedback', 'reply'] as const;
const reviewCapabilities = ['notify', 'review-action'] as const;

export interface FeedbackProjectDraft {
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
type FeedbackBindingRole = typeof bindingFields[number];

/** Readbacks obtained from the server's registered provider bindings. */
export interface FeedbackBindingObservation extends FeedbackConnectionObservation {
  role: FeedbackBindingRole;
  evidenceRef: string;
  factsDigest: string;
}

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

function currentObservation<T extends FeedbackConnectionObservation>(draft: FeedbackProjectDraft, matches: readonly T[], now: number) {
  if (matches.length !== 1) return null;
  const [observation] = matches;
  return observation.workspaceId === draft.workspaceId && observation.projectId === draft.projectId &&
    observation.status === 'READY' && Number.isSafeInteger(observation.revision) && observation.revision > 0 &&
    Number.isSafeInteger(observation.validUntil) && observation.validUntil > now ? observation : null;
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
    const observation = currentObservation(draft,observations.filter(item => item.reference === reference),now);
    const missing = capabilities.filter(capability => !observation?.capabilities.includes(capability));
    return {
      reference,
      missing,
      revision: observation?.revision ?? null,
      ready: observation !== null && missing.length === 0,
    };
  });
  return {
    draftDigest: digest(draft),
    channelsReady: results.every(result => result.ready),
    feedback: results[0],
    review: results[1],
  };
}

export function inspectFeedbackActivationBindings(
  draft: FeedbackProjectDraft, observations: readonly FeedbackBindingObservation[], now: number,
) {
  if (!Number.isSafeInteger(now) || now <= 0) return reject('FEEDBACK_CLOCK','A current authoritative timestamp is required.');
  const bindings = bindingFields.map(role => {
    const matches = observations.filter(item => item.role === role);
    const observation = currentObservation(draft,matches,now);
    const capabilities = role === 'feedbackBindingRef' ? feedbackCapabilities : role === 'reviewBindingRef' ? reviewCapabilities : [];
    const missing = capabilities.filter(capability => !observation?.capabilities.includes(capability));
    if (!observation || observation.reference !== draft[role] || missing.length ||
        !/^sha256:[a-f0-9]{64}$/.test(observation.factsDigest) ||
        !/^[a-z][a-z0-9._:/-]{0,255}$/.test(observation.evidenceRef)) {
      return {role,reference:draft[role],status:'UNVERIFIED' as const,missing};
    }
    return {
      role,reference:draft[role],status:'VERIFIED' as const,
      revision:observation.revision,validUntil:observation.validUntil,
      evidenceRef:observation.evidenceRef,factsDigest:observation.factsDigest,
    };
  });
  const verified = bindings.filter(binding => binding.status === 'VERIFIED');
  const complete = verified.length === bindings.length;
  const draftDigest = digest(draft);
  return {
    draftDigest,bindings,
    bindingStamp:complete ? digest({
      draftDigest,bindings:verified.map(({role,reference,revision,factsDigest}) => ({role,reference,revision,factsDigest})),
    }) : null,
    validUntil:complete ? Math.min(...verified.map(binding => binding.validUntil)) : null,
  };
}

export const FEEDBACK_PROJECT_VALIDATE = 'feedback.project.validate';

/** Expert previews only the scoped draft. Provider registration and activation
 * have separate authority and are never inferred from a successful read. */
export function inspectFeedbackProjectDraft(input: unknown, workspaceId: string, projectId: string) {
  const {configuration,source} = draftInput(record(input));
  const draft = parseFeedbackProjectDraft(configuration);
  requireDraftScope(draft, workspaceId, projectId);
  return {
    draftDigest: digest(draft),
    ...(source ? {yamlDigest:source.yamlDigest} : {}),
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

function draftInput(input: Record<string,unknown>) {
  if (!Object.hasOwn(input,'yaml')) return {configuration:readDraftEdit(input),source:null};
  exact(input,['yaml']);
  const {yaml} = input;
  if (typeof yaml !== 'string' || Buffer.byteLength(yaml) > 16_384) {
    return reject('FEEDBACK_YAML_LIMIT','Feedback YAML must be at most 16 KiB.',413);
  }
  if (containsInlineSecret(yaml)) {
    return reject('INLINE_SECRET','Use protected binding references in feedback YAML.');
  }
  const document = parseDocument(yaml,{version:'1.2',strict:true,uniqueKeys:true,stringKeys:true,prettyErrors:false});
  if (document.errors.length || document.warnings.length || document.directives?.yaml.version !== '1.2') {
    return reject('FEEDBACK_YAML_INVALID','Feedback YAML requires one plain YAML 1.2 document.');
  }
  visit(document,(_key,node,path) => {
    if (path.length > 4 || isAlias(node) || (isNode(node) && (('anchor' in node && node.anchor) || node.tag))) {
      reject('FEEDBACK_YAML_INVALID','Feedback YAML does not accept aliases, anchors, tags or nested fields.');
    }
  });
  return {
    configuration:readDraftEdit(document.toJS({maxAliasCount:0})),
    source:{yaml,yamlDigest:byteDigest(yaml)},
  };
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
  const sourcePointer = store.object(projectId,'feedback-project-source-pointer','current') as {draftDigest:string;yamlDigest:string} | null;
  const source = sourcePointer ? store.object(projectId,'feedback-project-yaml',sourcePointer.yamlDigest) as {yaml:string;yamlDigest:string} | null : null;
  if (sourcePointer && (!source || sourcePointer.draftDigest !== revision ||
      sourcePointer.yamlDigest !== source.yamlDigest || byteDigest(source.yaml) !== source.yamlDigest)) {
    return reject('CORRUPT_FEEDBACK_DRAFT','The retained YAML does not match its draft pointer.',503);
  }
  const summary = {revision:store.revision(projectId),draft:{...summarizeDraft(configuration),...(source ?? {})}};
  const activationId = store.object(projectId,'feedback-activation-pointer','current');
  if (activationId === null) return summary;
  const activation = record(store.object(projectId,'feedback-activation',string(activationId,71)));
  const subject = record(activation.subject);
  if (activation.candidateDigest !== activationId || 'sha256:'+digest(subject) !== activationId ||
      subject.workspaceId !== store.workspaceId || subject.serviceId !== store.serviceId || subject.projectId !== projectId) {
    return reject('CORRUPT_FEEDBACK_ACTIVATION','The retained activation does not match the project.',503);
  }
  const matchesSavedDraft = subject.draftDigest === revision && subject.yamlDigest === (source?.yamlDigest ?? null);
  return {...summary,active:{activationId,draftDigest:subject.draftDigest,matchesSavedDraft}};
}

export const FEEDBACK_ACTIVATION_PREVIEW = 'feedback.project.activation.preview';
export const FEEDBACK_ACTIVATE = 'feedback.project.activate';

export function saveFeedbackProjectDraft(
  store: RuntimeStore, actor: Principal, projectId: string, input: Record<string,unknown>,
  requestId: string, expectedRevision: number, reauthorize: () => Principal,
) {
  authorize(actor,projectId,'draft.write');
  const {configuration:draft,source} = draftInput(input);
  requireDraftScope(draft,store.workspaceId,projectId);
  const summary = summarizeDraft(draft);
  return store.mutate(actor,{
    projectId,operation:FEEDBACK_PROJECT_SAVE,requestId,expectedRevision,input,permission:'draft.write',
  },() => ({
    value:{...summary,...(source ?? {})},
    objects:[
      {kind:'feedback-project-draft',id:summary.draftDigest,value:draft},
      {kind:'feedback-project-draft-pointer',id:'current',value:summary.draftDigest},
      ...(source ? [{kind:'feedback-project-yaml',id:source.yamlDigest,value:source}] : []),
      {kind:'feedback-project-source-pointer',id:'current',value:source ? {draftDigest:summary.draftDigest,yamlDigest:source.yamlDigest} : null},
    ],
    event:{type:'feedback-project-draft-saved',data:{draftDigest:summary.draftDigest,yamlDigest:source?.yamlDigest ?? null}},
  }),reauthorize);
}
