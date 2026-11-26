import { digest, exact, reject, string } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import type { RuntimeStore } from '../server/store.js';
import {
  normalizeChannelEvent, readFeedbackDeliveryIntent, readFeedbackDeliveryReceipt,
  type ChannelScope, type FeedbackDeliveryIntent, type FeedbackDeliveryReceipt, type FeedbackDeliveryResult,
} from './channel.js';
import { claimFeedbackMerge, feedbackReviewId, openFeedbackReview, recordFeedbackVeto, type MergeObservation, type ReviewCandidate } from './review.js';
import type { createFeedbackGitHubAdapter, FeedbackGitHubMergeObservation } from './github.js';
import {
  FEEDBACK_ACTIVATE, inspectFeedbackActivationBindings, parseFeedbackProjectDraft,
  readSavedFeedbackProjectDraft, type FeedbackBindingObservation, type FeedbackProjectDraft,
} from './project.js';

interface ActivationPolicy {
  revision: number;
  digest: string;
  ownerId: string;
  ownerRevision: number;
  validUntil: number;
}

interface LifecycleBinding {
  revisionId: string;
  semanticDigest: string;
  bindingStamp: string;
  validUntil: number;
}

export interface FeedbackActivationRegistry {
  observe(draft: FeedbackProjectDraft, actor: Principal, signal: AbortSignal): Promise<readonly FeedbackBindingObservation[]>;
  policy(draft: FeedbackProjectDraft): ActivationPolicy | null;
  verifyDecision(decision: {
    workspaceId: string;
    projectId: string;
    actorId: string;
    actorRevision: number;
    policyDigest: string;
    candidateDigest: string;
    evidenceRef: string;
    decision: 'approve';
  }): boolean;
}

export function createFeedbackActivationService(
  store: RuntimeStore,
  lifecycle: (actor: Principal, projectId: string) => Promise<LifecycleBinding>,
  registry?: FeedbackActivationRegistry,
) {
  const digestPattern = /^sha256:[a-f0-9]{64}$/;
  const verifyPolicy = (draft: FeedbackProjectDraft, actor: Principal) => {
    const policy = registry?.policy(draft);
    if (!policy || !digestPattern.test(policy.digest) ||
        !Number.isSafeInteger(policy.revision) || policy.revision <= 0 ||
        !Number.isSafeInteger(policy.validUntil) || policy.validUntil <= Date.now()) {
      return reject('FEEDBACK_POLICY_UNAVAILABLE','Verify the current registered activation policy first.',409);
    }
    if (policy.ownerId !== actor.id || policy.ownerRevision !== actor.revision) {
      return reject('FEEDBACK_ACTIVATION_OWNER','The named project owner must review the candidate.',403);
    }
    return policy;
  };
  const activePointer = (projectId: string) => store.object(projectId,'feedback-activation-pointer','current');
  const lifecyclePointer = (projectId: string) => store.object(projectId,'definition-pointer','active');
  const draftPointer = (projectId: string) => store.object(projectId,'feedback-project-draft-pointer','current');
  const requireOwnerPermission = (actor: Principal, projectId: string) => {
    authorize(actor,projectId,'definition.activate');
    authorize(actor,projectId,'decision.record');
  };

  async function prepare(actor: Principal, projectId: string) {
    requireOwnerPermission(actor,projectId);
    if (!registry) return reject('FEEDBACK_ACTIVATION_UNAVAILABLE','Register the protected feedback bindings first.',409);
    const saved = readSavedFeedbackProjectDraft(store,actor,projectId);
    if (!saved.draft || saved.draft.missingFields.length) {
      return reject('FEEDBACK_DRAFT_INCOMPLETE','Save all required fields before requesting activation review.',409);
    }
    const draft = Object.freeze(parseFeedbackProjectDraft(saved.draft.configuration));
    const observedPolicy = { ...verifyPolicy(draft,actor) };
    const definitionPointer = digest(lifecyclePointer(projectId));
    const priorActivation = activePointer(projectId);
    const signal = AbortSignal.timeout(5000);
    const [definition,observations] = await Promise.all([
      lifecycle(actor,projectId),
      Promise.race([
        registry.observe(draft,actor,signal),
        new Promise<never>((_resolve,rejectPromise) => {
          signal.addEventListener('abort',() => rejectPromise(new Error('Feedback observation timeout')),{once:true});
        }),
      ]).catch(() => reject('FEEDBACK_BINDINGS_UNAVAILABLE','Current provider observation did not complete.',409)),
    ]);
    const now = Date.now();
    const policy = verifyPolicy(draft,actor);
    if (policy.revision !== observedPolicy.revision || policy.digest !== observedPolicy.digest ||
        observedPolicy.validUntil <= now) {
      return reject('FEEDBACK_ACTIVATION_STALE','The activation policy changed while checking bindings. Review the current candidate.',409);
    }
    const evidence = inspectFeedbackActivationBindings(draft,observations,now);
    if (!evidence.bindingStamp || !evidence.validUntil) {
      return reject('FEEDBACK_BINDINGS_UNVERIFIED','All seven project bindings require current verified evidence.',409);
    }
    if (store.revision(projectId) !== saved.revision || digest(lifecyclePointer(projectId)) !== definitionPointer ||
        definition.validUntil <= now) {
      return reject('FEEDBACK_ACTIVATION_STALE','The active lifecycle or feedback draft changed during review.',409);
    }
    const subject = {
      serviceId:store.serviceId,workspaceId:store.workspaceId,projectId,projectRevision:saved.revision,
      draftDigest:evidence.draftDigest,yamlDigest:saved.draft.yamlDigest ?? null,
      definitionPointer,definitionRevision:definition.revisionId,
      lifecycleDigest:definition.semanticDigest,lifecycleBindingStamp:definition.bindingStamp,
      feedbackBindingStamp:evidence.bindingStamp,policyRevision:policy.revision,policyDigest:policy.digest,
      ownerId:policy.ownerId,ownerRevision:policy.ownerRevision,priorActivation,
    };
    return {
      draft,candidate:{
        subject,candidateDigest:'sha256:'+digest(subject),
        validUntil:Math.min(definition.validUntil,evidence.validUntil,observedPolicy.validUntil,policy.validUntil,Date.parse(actor.expiresAt)),
      },
    };
  }

  async function preview(actor: Principal, projectId: string) {
    const {candidate} = await prepare(actor,projectId);
    return {status:'READY_FOR_REVIEW',...candidate,executionAuthorized:false,releaseAuthorized:false};
  }

  async function activate(actor: Principal, projectId: string, input: Record<string,unknown>,
    requestId: string, expectedRevision: number, reauthorize: () => Principal) {
    requireOwnerPermission(actor,projectId);
    exact(input,['candidateDigest','decision','evidenceRef']);
    const candidateDigest = string(input.candidateDigest,71), evidenceRef = string(input.evidenceRef,1024);
    if (!digestPattern.test(candidateDigest) || input.decision !== 'approve') {
      return reject('FEEDBACK_ACTIVATION_DECISION','An explicit approval for the exact candidate is required.',409);
    }
    const checkActor = () => {
      const current = reauthorize();
      requireOwnerPermission(current,projectId);
      return current;
    };
    const mutation = {projectId,operation:FEEDBACK_ACTIVATE,requestId,expectedRevision,input,permission:'definition.activate' as const};
    if (store.findReceipt(actor,projectId,requestId)) {
      return store.mutate(actor,mutation,() => {throw new Error('Unreachable replay callback');},checkActor);
    }
    const {draft,candidate} = await prepare(actor,projectId);
    if (candidate.candidateDigest !== candidateDigest || expectedRevision !== candidate.subject.projectRevision) {
      return reject('FEEDBACK_ACTIVATION_STALE','Review the exact current candidate again.',409);
    }
    return store.mutate(actor,mutation,() => {
      const current = checkActor(), policy = verifyPolicy(draft,current);
      const {subject,validUntil} = candidate;
      if (Math.min(validUntil,policy.validUntil) <= Date.now() || policy.digest !== subject.policyDigest ||
          policy.revision !== subject.policyRevision || current.id !== subject.ownerId ||
          current.revision !== subject.ownerRevision || draftPointer(projectId) !== subject.draftDigest ||
          digest(lifecyclePointer(projectId)) !== subject.definitionPointer ||
          digest(activePointer(projectId)) !== digest(subject.priorActivation)) {
        return reject('FEEDBACK_ACTIVATION_STALE','The reviewed draft, binding, lifecycle or authority changed.',409);
      }
      if (registry?.verifyDecision({
        workspaceId:store.workspaceId,projectId,actorId:current.id,actorRevision:current.revision,
        policyDigest:subject.policyDigest,candidateDigest,evidenceRef,decision:'approve',
      }) !== true) {
        return reject('FEEDBACK_ACTIVATION_DECISION','The original owner approval could not be verified.',409);
      }
      const value = {status:'ACTIVE',activationId:candidateDigest,executionAuthorized:false,releaseAuthorized:false};
      return {
        value,
        objects:[
          {kind:'feedback-activation',id:candidateDigest,value:{...candidate,evidenceRef,activatedBy:current.id}},
          {kind:'feedback-activation-pointer',id:'current',value:candidateDigest},
        ],
        event:{type:'feedback-project-activated',data:{activationId:candidateDigest,draftDigest:subject.draftDigest}},
      };
    },checkActor);
  }
  return {preview,activate};
}

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

interface ReviewNotificationIntent {
  intentRef: string;
  windowId: string;
  candidateDigest: string;
  audienceDigest: string;
}

function requireReviewAudience(store: RuntimeStore, principal: Principal, scope: ReviewScope, candidate: ReviewCandidate) {
  requireScope(store, scope.workspaceId, scope.projectId, principal);
  if (scope.workspaceId !== candidate.workspaceId || scope.projectId !== candidate.projectId || !scope.allowedActorIds.length) {
    reject('FEEDBACK_REVIEW_FORBIDDEN', 'A verified project reviewer audience is required.', 403);
  }
}

function ensureReviewCanOpen(store: RuntimeStore, candidate: ReviewCandidate) {
  const projectId = candidate.projectId;
  if (store.object(projectId, 'feedback-vetoed-head', vetoIndexId(candidate))) {
    reject('FEEDBACK_REVIEW_VETO', 'A vetoed PR requires a new revision before review.', 409);
  }
  const currentId = store.object(projectId, 'feedback-review-current', pointerId(candidate)) as string | null;
  if (currentId && readWindow(store, projectId, currentId).claim) {
    reject('FEEDBACK_RECONCILE_ORIGINAL', 'Inspect the original merge claim.', 409);
  }
}

function reviewNotificationIdentity(scope: ReviewScope, candidate: ReviewCandidate): ReviewNotificationIntent {
  const material = {candidateDigest:digest(candidate), audienceDigest:audienceDigest(scope)};
  const intentRef = 'feedback-notify:' + digest(material);
  return {intentRef,windowId:feedbackReviewId(candidate,intentRef),...material};
}

/** Resume an already-open window before attempting another notification. */
export function readRetainedFeedbackReview(
  store: RuntimeStore, principal: Principal, scope: ReviewScope, candidate: ReviewCandidate,
) {
  requireReviewAudience(store,principal,scope,candidate);
  const expected = reviewNotificationIdentity(scope,candidate);
  const window = store.object(candidate.projectId,windowKind,expected.windowId) as StoredWindow | null;
  if (!window) return null;
  const intent = store.object(candidate.projectId,'feedback-review-intent',expected.intentRef);
  const noticeKey = digest({channel:scope.channel,notificationRef:window.notificationRef});
  if (digest(intent) !== digest(expected) || window.id !== expected.windowId ||
      window.notificationIntentRef !== expected.intentRef || window.audienceDigest !== expected.audienceDigest ||
      window.candidateDigest !== expected.candidateDigest || digest(window.candidate) !== expected.candidateDigest ||
      store.object(candidate.projectId,'feedback-review-notification',noticeKey) !== window.id) {
    return reject('FEEDBACK_REVIEW_NOTIFICATION_CONFLICT','The retained review does not match the original notification.',409);
  }
  activeWindow(store,window);
  return window;
}

/** Only a new durable reservation is available for dispatch. On replay inspect
 * that exact provider attempt; a reused reservation must not create a new notice. */
export function reserveFeedbackReviewNotification(store: RuntimeStore, principal: Principal, scope: ReviewScope, candidate: ReviewCandidate) {
  requireReviewAudience(store, principal, scope, candidate);
  ensureReviewCanOpen(store, candidate);
  const projectId = candidate.projectId;
  const intent = reviewNotificationIdentity(scope,candidate);
  const {intentRef,candidateDigest,audienceDigest} = intent;
  const material = {candidateDigest,audienceDigest};
  const prior = store.object(projectId, 'feedback-review-intent', intentRef) as ReviewNotificationIntent | null;
  if (prior) return {status:'REUSED' as const,intent:prior};
  store.mutate(principal, {
    projectId,operation:'feedback.review.notify.reserve',requestId:intentRef,
    expectedRevision:store.revision(projectId),permission:'execution.request',input:material,
  }, () => ({
    value:intent,
    objects:[{kind:'feedback-review-intent',id:intentRef,value:intent}],
    event:{type:'feedback-review-notification-reserved',data:{windowId:intent.windowId}},
  }));
  return {status:'RESERVED' as const,intent};
}

/** Internal entry for a verified provider notification, with evidence bound by the caller. */
export function retainFeedbackReview(store: RuntimeStore, principal: Principal, scope: ReviewScope, candidate: ReviewCandidate, notificationIntentRef: string, notificationRef: string, observedAt: number): Window {
  requireReviewAudience(store, principal, scope, candidate);
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
  ensureReviewCanOpen(store, candidate);
  const intent = store.object(projectId, 'feedback-review-intent', notificationIntentRef) as ReviewNotificationIntent | null;
  if (!intent || intent.windowId !== window.id || intent.candidateDigest !== window.candidateDigest ||
      intent.audienceDigest !== window.audienceDigest) {
    reject('FEEDBACK_REVIEW_NOTIFICATION_UNRESERVED', 'Verified delivery must match the original durable notification intent.', 409);
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

type MergeAdapter = ReturnType<typeof createFeedbackGitHubAdapter>;
type CurrentMergeAdmission = (candidate: ReviewCandidate) => Pick<MergeObservation,'policyCurrent'|'receiptCoverage'>;

/** Internal worker entry using the registered provider and a synchronous check
 * of the current policy and review-channel evidence. A saved claim only polls. */
export async function advanceFeedbackMerge(
  store: RuntimeStore, principal: Principal, projectId: string, windowId: string,
  adapter: MergeAdapter, currentAdmission: CurrentMergeAdmission, reauthorize: () => Principal,
  signal: AbortSignal, clock = Date.now,
): Promise<FeedbackGitHubMergeObservation> {
  const currentPrincipal = () => {
    const fresh = reauthorize();
    authorize(fresh,projectId,'execution.request');
    if (fresh.id !== principal.id || fresh.revision !== principal.revision) {
      reject('AUTHORITY_CHANGED','The registered merge worker authority changed.',409);
    }
    return fresh;
  };
  currentPrincipal();
  let window: Window = readWindow(store,projectId,windowId);
  requireScope(store,window.candidate.workspaceId,projectId,principal);
  activeWindow(store,window);
  const {candidate} = window;
  let reservedNow = false;
  if (!window.claim) {
    if (window.veto) return reject('FEEDBACK_REVIEW_VETO','The selected candidate was vetoed.',409);
    if (clock() < window.deadline) return reject('FEEDBACK_REVIEW_WAITING','The complete review window has not elapsed.',409);
    const inspected = await adapter.inspect(candidate,signal);
    window = readWindow(store,projectId,windowId);
    if (!window.claim) {
      window = reserveFeedbackMerge(store,currentPrincipal(),windowId,{...inspected,...currentAdmission(candidate)},clock);
      reservedNow = true;
    }
  }
  const claim = window.claim!;
  const readOutcome = () => store.object(projectId,'feedback-merge-outcome',claim.requestId) as FeedbackGitHubMergeObservation | null;
  const previous = readOutcome();
  const request = {candidate,requestId:claim.requestId};
  const result = reservedNow ? await adapter.dispatch(request,signal,() => {
    currentPrincipal();
    const fresh = readWindow(store,projectId,windowId);
    activeWindow(store,fresh);
    const admitted = currentAdmission(candidate);
    const now = clock();
    if (fresh.claim?.requestId !== claim.requestId || fresh.veto || !Number.isSafeInteger(now) || now < fresh.deadline ||
        !admitted.policyCurrent || admitted.receiptCoverage !== 'COMPLETE') {
      reject('FEEDBACK_MERGE_BLOCKED','The reserved request lost its current merge admission.',409);
    }
  }) : await adapter.reconcile(request,previous,signal);
  if (result.requestId !== claim.requestId || result.candidateDigest !== window.candidateDigest) {
    return reject('FEEDBACK_GITHUB_RECEIPT','GitHub evidence does not match the original Runtime claim.',409);
  }
  const retained = readOutcome();
  if (retained?.operationId && result.operationId && retained.operationId !== result.operationId) {
    return reject('FEEDBACK_GITHUB_RECEIPT','The original GitHub operation identity changed.',409);
  }
  if (retained && (digest(retained) === digest(result) || retained.status === 'MERGED' ||
      retained.status === 'DENIED' || (retained.operationId && !result.operationId))) return retained;

  const observationDigest = digest(result);
  store.mutate(principal,{
    projectId,operation:'feedback.merge.observe',
    requestId:claim.requestId+':'+observationDigest,expectedRevision:store.revision(projectId),
    permission:'execution.request',input:{windowId,observationDigest},
  },() => ({
    value:result,
    objects:[{kind:'feedback-merge-outcome',id:claim.requestId,value:result}],
    event:{type:'feedback-merge-observed',data:{
      windowId,requestId:claim.requestId,status:result.status,source:result.source,mergeSha:result.mergeSha,
    }},
  }),currentPrincipal);
  return result;
}

const feedbackStages = ['receive','issue','reproduce','repair','verify','review','close'] as const;
type FeedbackStage = typeof feedbackStages[number];
const feedbackStatuses = ['WAITING','RUNNING','UNKNOWN','FAILED','COMPLETE'] as const;
type FeedbackStatus = typeof feedbackStatuses[number];
const progressTransitions: Record<FeedbackStage,readonly FeedbackStage[]> = {
  receive:['issue'],issue:['reproduce'],reproduce:['receive','repair'],repair:['verify'],
  verify:['repair','review'],review:['repair','close'],close:[],
};

interface FeedbackProgress {
  stage: FeedbackStage;
  status: FeedbackStatus;
  reason: string;
  ref: string | null;
  reviewId?: string;
}

type ProgressEntry = Omit<FeedbackProgress,'reviewId'> & {id:string;at:string;returnFrom:FeedbackStage|null};
type ProgressState = {
  stage: FeedbackStage;
  status: FeedbackStatus;
  visited: readonly FeedbackStage[];
  timeline: readonly ProgressEntry[];
  reviewId: string | null;
};

function feedbackCaseState(store: RuntimeStore, projectId: string, caseId: string): ProgressState {
  const original = store.object(projectId,'feedback-case',caseId) as {
    id:string;workspaceId:string;projectId:string;receivedAt:number;originalEventKey:string;
  } | null;
  if (!original || original.id !== caseId || original.workspaceId !== store.workspaceId || original.projectId !== projectId) {
    return reject('FEEDBACK_CASE_UNKNOWN','The original feedback case is unavailable.',404);
  }
  return (store.object(projectId,'feedback-case-progress',caseId) as ProgressState | null) ?? {
    stage:'receive',status:'COMPLETE',visited:['receive'],reviewId:null,timeline:[{
      id:original.originalEventKey,stage:'receive',status:'COMPLETE',at:new Date(original.receivedAt).toISOString(),
      reason:'FEEDBACK_RECEIVED',ref:original.originalEventKey,returnFrom:null,
    }],
  };
}

/** Internal projection of retained case transitions. This writes viewing
 * evidence only; provider dispatch and case authority cannot read it as a grant. */
export function retainFeedbackProgress(
  store: RuntimeStore, actor: Principal, projectId: string, caseId: string, progress: FeedbackProgress,
) {
  authorize(actor,projectId,'execution.request');
  const previous = feedbackCaseState(store,projectId,caseId);
  if (!feedbackStages.includes(progress.stage) || !feedbackStatuses.includes(progress.status) ||
      typeof progress.reason !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(progress.reason) ||
      (progress.ref !== null && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(progress.ref)) ||
      (progress.reviewId !== undefined && progress.stage !== 'review')) {
    return reject('FEEDBACK_PROGRESS_INVALID','Use an owned transition with a bounded status and receipt reference.');
  }
  const id = 'feedback-progress:'+digest({caseId,progress});
  if (store.object(projectId,'feedback-progress-entry',id)) return previous;
  if (progress.stage !== previous.stage && !progressTransitions[previous.stage].includes(progress.stage)) {
    return reject('FEEDBACK_PROGRESS_INVALID','The recorded case stage does not permit this transition.',409);
  }
  if (progress.stage === 'close' && previous.status === 'COMPLETE' && previous.stage === 'close') {
    return reject('FEEDBACK_PROGRESS_FINAL','The feedback lifecycle is closed.',409);
  }
  if (progress.reviewId) readWindow(store,projectId,progress.reviewId);
  const entry = {
    id,at:new Date().toISOString(),stage:progress.stage,status:progress.status,reason:progress.reason,ref:progress.ref,
    returnFrom:feedbackStages.indexOf(progress.stage) < feedbackStages.indexOf(previous.stage) ? previous.stage : null,
  };
  const value: ProgressState = {
    stage:progress.stage,status:progress.status,visited:[...new Set([...previous.visited,progress.stage])],
    timeline:[...previous.timeline,entry].slice(-24),
    reviewId:progress.reviewId ?? previous.reviewId,
  };
  store.mutate(actor,{
    projectId,operation:'feedback.progress.retain',requestId:id,expectedRevision:store.revision(projectId),
    permission:'execution.request',input:{caseId,progress},
  },() => ({
    value:{caseId,id},
    objects:[
      {kind:'feedback-progress-entry',id,value:{caseId,entry}},
      {kind:'feedback-case-progress',id:caseId,value},
    ],
    event:{type:'feedback-progress-retained',data:{caseId,id,stage:entry.stage,status:entry.status}},
  }));
  return value;
}

export function feedbackMonitorSnapshot(
  store: RuntimeStore, actor: Principal, projectId: string, after?: string, expectedRevision?: number,
) {
  authorize(actor,projectId,'read');
  const revision = store.revision(projectId);
  if (after !== undefined && expectedRevision === undefined) {
    return reject('MONITOR_REVISION_REQUIRED','Feedback pagination must retain its original project revision.');
  }
  if (expectedRevision !== undefined && expectedRevision !== revision) {
    return reject('MONITOR_REVISION_CHANGED','Refresh the feedback snapshot before continuing pagination.',409);
  }
  const rows = store.objectsPage(projectId,'feedback-case',after ?? '',21);
  const cases = rows.slice(0,20).map(({id}) => {
    const {reviewId,...progress} = feedbackCaseState(store,projectId,id);
    const reviewWindow = reviewId ? readWindow(store,projectId,reviewId) : null;
    const review = reviewWindow ? {
      deadline:reviewWindow.deadline,head:reviewWindow.candidate.head,pullRequestId:reviewWindow.candidate.pullRequestId,
      state:reviewWindow.veto ? 'VETOED' as const :
        progress.stage === 'review' && !reviewWindow.claim ? 'OPEN' as const : 'CLOSED' as const,
    } : null;
    return {id,...progress,review};
  });
  return {
    projectId,revision,observedAt:new Date().toISOString(),readOnly:true,cases,
    nextAfter:rows.length > cases.length ? cases.at(-1)!.id : null,
  };
}

export interface FeedbackDeliveryAdapter {
  source: FeedbackDeliveryReceipt['source'];
  dispatch(intent: FeedbackDeliveryIntent,reservation: 'RESERVED'): Promise<FeedbackDeliveryResult>;
  reconcile(intent: FeedbackDeliveryIntent): Promise<FeedbackDeliveryResult>;
}

export function readFeedbackClosureMerge(store: RuntimeStore,projectId: string,caseId: string,windowId: string) {
  const window = readWindow(store,projectId,windowId);
  const requestId = window.claim?.requestId;
  const merge = requestId ? store.object(projectId,'feedback-merge-outcome',requestId) as FeedbackGitHubMergeObservation | null : null;
  const notice = store.object(projectId,'feedback-delivery-intent',window.notificationIntentRef) as {
    intent:FeedbackDeliveryIntent;source:FeedbackDeliveryReceipt['source'];
  } | null;
  const receipt = notice ? store.object(projectId,'feedback-delivery-receipt',notice.intent.requestId) : null;
  if (window.candidate.workspaceId !== store.workspaceId || window.candidate.projectId !== projectId ||
      window.veto || !merge || merge.status !== 'MERGED' || merge.requestId !== requestId ||
      merge.candidateDigest !== window.candidateDigest || !merge.mergeSha || !/^[a-f0-9]{40}$/.test(merge.mergeSha) ||
      notice?.intent.kind !== 'review' || notice.intent.caseId !== caseId || notice.intent.reviewId !== windowId ||
      !receipt || readFeedbackDeliveryReceipt(receipt,notice.intent,notice.source).messageId !== window.notificationRef) {
    return reject('FEEDBACK_CLOSURE_NOT_CONFIRMED','The original case has no verified GitHub merge and review delivery.',409);
  }
  return {requestId,mergeSha:merge.mergeSha,source:merge.source,pullRequestId:window.candidate.pullRequestId};
}

export const feedbackClosureDeliveryId = (caseId: string,windowId: string) => 'feedback-closure:'+digest({caseId,windowId});

/** Runtime owns the outbound intent. A restarted worker only inspects the
 * original operation; verified receipt identity never changes on replay. */
export async function advanceFeedbackDelivery(
  store: RuntimeStore, principal: Principal, projectId: string, scope: ChannelScope,
  input: FeedbackDeliveryIntent, adapter: FeedbackDeliveryAdapter, reauthorize: () => Principal,
) {
  const latestActor = () => {
    const actor = reauthorize();
    authorize(actor,projectId,'execution.request');
    if (actor.id !== principal.id || actor.revision !== principal.revision) {
      reject('AUTHORITY_CHANGED','The registered delivery worker authority changed.',409);
    }
    return actor;
  };
  latestActor();
  const intent = readFeedbackDeliveryIntent(input,scope);
  const original = store.object(projectId,'feedback-case',intent.caseId) as {
    id:string;workspaceId:string;projectId:string;scope:ChannelScope;originalMessageId:string;
  } | null;
  if (!original || original.id !== intent.caseId || original.workspaceId !== store.workspaceId || original.projectId !== projectId) {
    return reject('FEEDBACK_CASE_UNKNOWN','The original delivery case is unavailable.',404);
  }
  if (intent.kind === 'review') {
    const reservation = store.object(projectId,'feedback-review-intent',intent.requestId) as ReviewNotificationIntent | null;
    if (reservation?.windowId !== intent.reviewId) {
      return reject('FEEDBACK_REVIEW_NOTIFICATION_UNRESERVED','Review delivery requires the original reserved notification.',409);
    }
  } else if (digest(scope) !== digest(original.scope) || intent.originalMessageId !== original.originalMessageId) {
    return reject('FEEDBACK_DELIVERY_SCOPE','Replies must use the original feedback thread.',409);
  }
  const id = intent.requestId;
  const saved = store.object(projectId,'feedback-delivery-intent',id) as {
    intentDigest:string;source:FeedbackDeliveryAdapter['source'];
  } | null;
  if (saved && (saved.intentDigest !== intent.intentDigest || saved.source !== adapter.source)) {
    return reject('FEEDBACK_DELIVERY_CONFLICT','The original delivery already binds different content or transport.',409);
  }
  const receipt = () => {
    const retained = store.object(projectId,'feedback-delivery-receipt',id);
    return retained ? readFeedbackDeliveryReceipt(retained,intent,adapter.source) : null;
  };
  const verified = receipt();
  if (verified) return {status:'DELIVERED' as const,receipt:verified};
  if (!saved) {
    if (intent.kind === 'closed') {
      const closure = store.object(projectId,'feedback-case-closure',intent.caseId) as {
        windowId:string;issueId:string;mergeSha:string;receiptIntentId:string;
      } | null;
      if (!closure || id !== feedbackClosureDeliveryId(intent.caseId,closure.windowId) ||
          readFeedbackClosureMerge(store,projectId,intent.caseId,closure.windowId).mergeSha !== closure.mergeSha) {
        return reject('FEEDBACK_DELIVERY_CLOSURE_REQUIRED','Closure must follow the original verified merge and issue receipt.',409);
      }
    }
    store.mutate(principal,{
      projectId,operation:'feedback.delivery.reserve',requestId:'feedback-delivery:'+digest(id),
      expectedRevision:store.revision(projectId),permission:'execution.request',input:{intentDigest:intent.intentDigest,source:adapter.source},
    },() => ({
      value:{requestId:id,intentDigest:intent.intentDigest},
      objects:[{kind:'feedback-delivery-intent',id,value:{intentDigest:intent.intentDigest,intent,source:adapter.source}}],
      event:{type:'feedback-delivery-reserved',data:{caseId:intent.caseId,kind:intent.kind,requestId:id}},
    }),latestActor);
  }
  const result = saved ? await adapter.reconcile(intent) : await adapter.dispatch(intent,'RESERVED');
  if (result.status !== 'DELIVERED') return result;
  const originalReceipt = readFeedbackDeliveryReceipt(result.receipt,intent,adapter.source);
  const concurrent = receipt();
  if (concurrent) {
    if (digest(concurrent) !== digest(originalReceipt)) {
      return reject('FEEDBACK_DELIVERY_RECEIPT','The original channel receipt changed.',409);
    }
    return {status:'DELIVERED' as const,receipt:concurrent};
  }
  store.mutate(principal,{
    projectId,operation:'feedback.delivery.confirm',requestId:'feedback-delivery-confirm:'+digest(id),
    expectedRevision:store.revision(projectId),permission:'execution.request',input:{receiptDigest:digest(originalReceipt)},
  },() => ({
    value:originalReceipt,
    objects:[{kind:'feedback-delivery-receipt',id,value:originalReceipt}],
    event:{type:'feedback-delivery-confirmed',data:{caseId:intent.caseId,kind:intent.kind,requestId:id,messageId:originalReceipt.messageId}},
  }),latestActor);
  return {status:'DELIVERED' as const,receipt:originalReceipt};
}
