import { setTimeout as delay } from 'node:timers/promises';
import { digest, record, reject, ServiceError, slug, string } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import type { RuntimeStore } from '../server/store.js';
import {
  prepareCursorWorkIntent, type createCursorAgentAdapter, type CursorScope,
  type CursorWorkIntent, type CursorWorkResult,
} from './cursor.js';
import {
  prepareFeedbackDelivery, readChannelScope, type ChannelScope, type NormalizedChannelEvent,
} from './channel.js';
import { bindFeedbackCaseIssue, changeFeedbackCaseIssue } from './ingress.js';
import type { createLinearIssueAdapter, LinearIssueReceipt, LinearIssueResult, LinearIssueScope } from './linear.js';
import type { createFeedbackGitHubAdapter } from './github.js';
import type { MergeObservation, openFeedbackReview, ReviewCandidate } from './review.js';
import {
  advanceFeedbackDelivery, advanceFeedbackMerge, feedbackClosureDeliveryId, readFeedbackClosureMerge,
  readRetainedFeedbackReview, reserveFeedbackReviewNotification, retainFeedbackProgress, retainFeedbackReview, type FeedbackDeliveryAdapter,
} from './service.js';
import {
  prepareFeedbackVerification, type createFeedbackVerification, type FeedbackVerificationCandidate,
  type FeedbackVerificationResult, type FeedbackVerificationRule,
} from './verification.js';

interface CursorSelection {
  projectId: string;
  caseId: string;
  round: number;
}

export interface FeedbackCursorSubject extends CursorSelection {
  serviceId: string;
  workspaceId: string;
  activationId: string;
  issueId: string;
  issueEvidenceDigest: string;
  cursorScopeDigest: string;
  cursorSource: CursorAdapter['source'];
  previousIntentId: string | null;
  previousRunId: string | null;
  principalId: string;
  principalRevision: number;
}

export interface FeedbackCursorGrant {
  subjectDigest: string;
  evidenceRef: string;
  prompt: string;
  expiresAt: number;
  maxRepairs: number;
}

type CursorAdapter = ReturnType<typeof createCursorAgentAdapter>;
type Verifier = ReturnType<typeof createFeedbackVerification>;

interface SavedAttempt {
  subject: FeedbackCursorSubject;
  intent: CursorWorkIntent;
  grantDigest: string;
  outcome: CursorWorkResult | null;
  runId: string | null;
}

interface SavedVerification {
  attemptId: string;
  candidate: FeedbackVerificationCandidate;
  result: FeedbackVerificationResult;
}

const terminal = (outcome: CursorWorkResult | null) => outcome?.status === 'OBSERVED' &&
  ['FINISHED','ERROR','CANCELLED','EXPIRED'].includes(outcome.realization.status);

/** Internal owner worker. Only the registered admission reader can supply work
 * and a scoped prompt. No browser, MCP input, or feedback body grants a launch. */
export function createFeedbackCursorWorker(
  store: RuntimeStore, scope: CursorScope, adapter: CursorAdapter,
  permits: (subject: FeedbackCursorSubject) => FeedbackCursorGrant | null,
  principal: (id: string) => Principal,
) {
  const inFlight = new Set<string>();
  const scopeDigest = digest(scope);
  if (adapter.scopeDigest !== scopeDigest) {
    reject('FEEDBACK_CURSOR_SCOPE','The registered Cursor adapter has different repository bindings.',409);
  }
  const attemptId = (caseId: string,round: number) => 'feedback-cursor:'+digest({caseId,round});
  const readAttempt = (projectId: string,id: string) =>
    store.object(projectId,'feedback-cursor-attempt',id) as SavedAttempt | null;

  function verifyActor(projectId: string, actor: Principal) {
    const current = principal(actor.id);
    authorize(current,projectId,'execution.request');
    if (current.id !== actor.id || current.revision !== actor.revision) {
      return reject('AUTHORITY_CHANGED','The registered feedback worker authority changed.',409);
    }
    return current;
  }

  function activation(projectId: string) {
    const id = store.object(projectId,'feedback-activation-pointer','current');
    if (typeof id !== 'string') return reject('FEEDBACK_ACTIVATION_REQUIRED','A current feedback activation is required.',409);
    const saved = record(store.object(projectId,'feedback-activation',id));
    const subject = record(saved.subject);
    if (id !== 'sha256:'+digest(subject) || saved.candidateDigest !== id ||
        subject.projectId !== projectId || subject.workspaceId !== store.workspaceId ||
        subject.serviceId !== store.serviceId) {
      return reject('CORRUPT_FEEDBACK_ACTIVATION','The active feedback record did not verify.',503);
    }
    return id;
  }

  function grant(subject: FeedbackCursorSubject) {
    const value = permits(Object.freeze({...subject}));
    if (!value || value.subjectDigest !== digest(subject) || !Number.isSafeInteger(value.expiresAt) ||
        !Number.isSafeInteger(value.maxRepairs) || value.maxRepairs < subject.round ||
        value.expiresAt <= Date.now() || !/^[a-z][a-z0-9._:/-]{0,255}$/.test(value.evidenceRef)) {
      return reject('FEEDBACK_CURSOR_ADMISSION','A current exact verification or triage admission is required.',409);
    }
    return value;
  }

  function originalIssue(projectId: string, caseId: string) {
    const original = store.object(projectId,'feedback-case',caseId) as {id:string;workspaceId:string;projectId:string} | null;
    const issue = store.object(projectId,'feedback-case-issue',caseId) as LinearIssueReceipt | null;
    if (!original || original.id !== caseId || original.workspaceId !== store.workspaceId ||
        original.projectId !== projectId || !issue ||
        (adapter.source === 'FIXTURE' ? issue.source !== 'FIXTURE' : issue.source !== 'LINEAR_PROVIDER')) {
      return reject('FEEDBACK_CURSOR_CASE','The original case and qualified Linear issue are required.',409);
    }
    const latestId = store.object(projectId,'feedback-case-issue-latest',caseId);
    if (typeof latestId !== 'string') return {issue, issueEvidenceDigest:digest(issue)};
    const latest = store.object(projectId,'feedback-case-issue-change',latestId) as {
      intent:{kind:string};result:{status:string;receipt?:LinearIssueReceipt} | null;
    } | null;
    if (latest?.intent.kind !== 'resume' || latest.result?.status !== 'CONFIRMED' ||
        latest.result.receipt?.issueId !== issue.issueId || latest.result.receipt?.source !== issue.source) {
      return reject('FEEDBACK_CURSOR_CASE_WAITING','The original Linear case is waiting for verified information.',409);
    }
    return {issue,issueEvidenceDigest:digest(latest.result.receipt)};
  }

  function reserve(actor: Principal, selection: CursorSelection, id: string): SavedAttempt {
    const {projectId,caseId,round} = selection;
    const {issue,issueEvidenceDigest} = originalIssue(projectId,caseId);
    const activationId = activation(projectId);
    const previous = round > 0 ? readAttempt(projectId,attemptId(caseId,round-1)) : null;
    const original = round > 0 ? readAttempt(projectId,attemptId(caseId,0)) : null;
    if (round > 0 && (previous?.outcome?.status !== 'OBSERVED' || previous.outcome.realization.status !== 'FINISHED' ||
        original?.outcome?.status !== 'OBSERVED' || original.outcome.realization.status !== 'FINISHED' ||
        previous.subject.activationId !== activationId || previous.subject.issueId !== issue.issueId ||
        original.subject.activationId !== activationId || original.subject.issueId !== issue.issueId)) {
      return reject('FEEDBACK_CURSOR_ORIGINAL','Repair requires the original finished Cursor attempt and prior round.',409);
    }
    const subject: FeedbackCursorSubject = {
      ...selection,serviceId:store.serviceId,workspaceId:store.workspaceId,activationId,
      issueId:issue.issueId,issueEvidenceDigest,cursorScopeDigest:scopeDigest,cursorSource:adapter.source,
      previousIntentId:previous?.intent.intentId ?? null,
      previousRunId:previous?.runId ?? null,principalId:actor.id,principalRevision:actor.revision,
    };
    const approval = grant(subject);
    const material = {caseId,issueId:issue.issueId,requestId:id,prompt:approval.prompt};
    const intent = original?.outcome?.status === 'OBSERVED'
      ? prepareCursorWorkIntent(scope,{...material,kind:'repair',original:original.intent,prior:original.outcome.realization})
      : prepareCursorWorkIntent(scope,{...material,kind:'initial'});
    const attempt = {subject,intent,grantDigest:digest(approval),outcome:null,runId:null};
    store.mutate(actor,{
      projectId,operation:'feedback.cursor.reserve',requestId:id,expectedRevision:store.revision(projectId),
      permission:'execution.request',input:{caseId,round,activationId,intentId:intent.intentId,grantDigest:attempt.grantDigest},
    },() => ({
      value:{caseId,round,intentId:intent.intentId,agentId:intent.agentId},
      objects:[{kind:'feedback-cursor-attempt',id,value:attempt}],
      event:{type:'feedback-cursor-reserved',data:{caseId,round,agentId:intent.agentId}},
    }),() => verifyActor(projectId,actor));
    return attempt;
  }

  async function advance(actor: Principal, selection: CursorSelection, assertCurrent?: () => void) {
    const {projectId,round} = selection;
    const caseId = string(selection.caseId);
    if (!Number.isSafeInteger(round) || round < 0) return reject('FEEDBACK_CURSOR_ROUND','A bounded work round is required.');
    verifyActor(projectId,actor);
    const id = attemptId(caseId,round);
    const runningKey = projectId+':'+id;
    if (inFlight.has(runningKey)) return reject('FEEDBACK_CURSOR_BUSY','The original Cursor attempt is being inspected.',409);
    inFlight.add(runningKey);
    try {
      const retained = readAttempt(projectId,id);
      const attempt = retained ?? reserve(actor,{projectId,caseId,round},id);
      const {intent,subject} = attempt;
      if (subject.serviceId !== store.serviceId || subject.workspaceId !== store.workspaceId ||
          subject.projectId !== projectId || subject.caseId !== caseId || subject.round !== round ||
          subject.cursorScopeDigest !== scopeDigest || subject.cursorSource !== adapter.source ||
          intent.caseId !== caseId || intent.issueId !== subject.issueId ||
          intent.requestId !== id || intent.scopeDigest !== scopeDigest) {
        return reject('FEEDBACK_CURSOR_SCOPE','Retained work does not match the original Cursor case and scope.',409);
      }
      if (terminal(attempt.outcome)) return attempt.outcome!;
      const result = retained ? await adapter.reconcile(intent,attempt.runId ?? undefined) :
        await adapter.dispatch(intent,'RESERVED',() => {
          assertCurrent?.();
          verifyActor(projectId,actor);
          if (activation(projectId) !== subject.activationId ||
              originalIssue(projectId,caseId).issueEvidenceDigest !== subject.issueEvidenceDigest ||
              digest(grant(subject)) !== attempt.grantDigest ||
              readAttempt(projectId,id)?.intent.intentId !== intent.intentId) {
            reject('FEEDBACK_CURSOR_ADMISSION','The original launch no longer has current admission.',409);
          }
        });
      assertCurrent?.();
      const observation = result.status === 'OBSERVED' ? result.realization : result;
      if (observation.intentId !== intent.intentId || observation.agentId !== intent.agentId ||
          (attempt.runId && observation.runId !== attempt.runId) ||
          (result.status === 'OBSERVED' && (result.realization.scopeDigest !== scopeDigest || result.realization.source !== adapter.source))) {
        return reject('FEEDBACK_CURSOR_READBACK','Cursor readback does not match the original work.',409);
      }
      const current = readAttempt(projectId,id);
      if (!current || current.intent.intentId !== intent.intentId) {
        return reject('FEEDBACK_CURSOR_READBACK','The retained Cursor reservation changed.',409);
      }
      if (digest(current) !== digest(attempt)) {
        return current.outcome ?? reject('FEEDBACK_CURSOR_BUSY','Another worker is inspecting the same attempt.',409);
      }
      if (digest(result) === digest(attempt.outcome)) return result;
      const resultDigest = digest(result), runId = observation.runId;
      store.mutate(actor,{
        projectId,operation:'feedback.cursor.observe',requestId:id+':'+resultDigest,
        expectedRevision:store.revision(projectId),permission:'execution.request',input:{caseId,round,resultDigest},
      },() => ({
        value:{caseId,round,resultDigest},
        objects:[{kind:'feedback-cursor-attempt',id,value:{...attempt,outcome:result,runId}}],
        event:{type:'feedback-cursor-observed',data:{
          caseId,round,agentId:intent.agentId,runId,
          status:result.status === 'OBSERVED' ? result.realization.status : result.status,
        }},
      }),() => verifyActor(projectId,actor));
      return result;
    } finally {
      inFlight.delete(runningKey);
    }
  }

  /** Bind the independent verifier to the exact retained initial and current
   * Cursor Run. No claimed result text is eligible as verification evidence. */
  async function verify(
    actor: Principal, selection: CursorSelection, rule: FeedbackVerificationRule, verifier: Verifier,
    readCandidate: () => Promise<FeedbackVerificationCandidate | null>, signal: AbortSignal, assertCurrent?: () => void,
  ): Promise<FeedbackVerificationResult> {
    const {projectId,caseId,round} = selection;
    verifyActor(projectId,actor);
    const id = attemptId(caseId,round);
    const work = readAttempt(projectId,id), original = readAttempt(projectId,attemptId(caseId,0));
    if (work?.outcome?.status !== 'OBSERVED' || original?.outcome?.status !== 'OBSERVED' ||
        work.outcome.realization.status !== 'FINISHED' || original.outcome.realization.status !== 'FINISHED' ||
        work.subject.activationId !== original.subject.activationId ||
        work.subject.activationId !== activation(projectId)) {
      return reject('FEEDBACK_CURSOR_ORIGINAL','Verify the completed original and current Cursor attempts first.',409);
    }
    const candidate = await readCandidate();
    signal.throwIfAborted();
    if (!candidate) return reject('FEEDBACK_VERIFICATION_CANDIDATE','The original PR head and base are unavailable.',409);
    const previous = round > 0 ? store.object(projectId,'feedback-verification-latest',attemptId(caseId,round-1)) as SavedVerification | null : null;
    if (round > 0 && (!previous || previous.result.status === 'HOLD' || previous.candidate.head === candidate.head ||
        previous.candidate.repositoryId !== candidate.repositoryId || previous.candidate.number !== candidate.number)) {
      return reject('FEEDBACK_VERIFICATION_CANDIDATE','Repair requires a changed head on the same previously verified PR.',409);
    }
    const subject = prepareFeedbackVerification({
      workspaceId:store.workspaceId,projectId,caseId,activationId:work.subject.activationId,scope,
      original:{intent:original.intent,run:original.outcome.realization},
      work:{intent:work.intent,run:work.outcome.realization},pullRequest:candidate,rule,
    });
    const result = await verifier.inspect(actor,subject,{readCandidate,signal});
    signal.throwIfAborted();
    assertCurrent?.();
    verifyActor(projectId,actor);
    if (activation(projectId) !== subject.activationId ||
        readAttempt(projectId,id)?.intent.intentId !== work.intent.intentId || result.subjectDigest !== subject.subjectDigest) {
      return reject('FEEDBACK_VERIFICATION_STALE','The activation or original work changed during readback.',409);
    }
    const observation: SavedVerification = {attemptId:id,candidate:subject.pullRequest,result};
    const latest = store.object(projectId,'feedback-verification-latest',id);
    const observationDigest = digest(observation);
    if (!latest || digest(latest) !== observationDigest) {
      const revision = store.revision(projectId);
      store.mutate(actor,{
        projectId,operation:'feedback.verification.observe',requestId:'feedback-verify:'+digest({id,observationDigest,revision}),
        expectedRevision:revision,permission:'execution.request',input:{caseId,round,observationDigest},
      },() => ({
        value:{caseId,round,observationDigest},
        objects:[{kind:'feedback-verification-latest',id,value:observation}],
        event:{type:'feedback-verification-observed',data:{
          caseId,round,head:subject.pullRequest.head,status:result.status,
          reason:result.status==='HOLD'?result.reason:null,evidenceDigest:result.status==='HOLD'?null:result.evidenceDigest,
        }},
      }),() => verifyActor(projectId,actor));
    }
    return result;
  }
  return {advance,verify};
}

export type FeedbackWorkflowPhase =
  | 'issue' | 'triage' | 'info-issue' | 'info-reply' | 'supplement' | 'resume'
  | 'work' | 'verify' | 'notify' | 'review' | 'close-issue' | 'close-thread' | 'complete' | 'failed';

export interface FeedbackWorkflowSubject {
  readonly serviceId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly activationId: string;
  readonly bindingDigest: string;
  readonly principalId: string;
  readonly principalRevision: number;
  readonly caseId: string;
  readonly originalEventDigest: string;
  readonly phase: FeedbackWorkflowPhase;
  readonly stateDigest: string;
}

export interface FeedbackWorkflowAdmission {
  readonly subjectDigest: string;
  readonly expiresAt: number;
}

export interface FeedbackWorkflowTriageSubject extends FeedbackWorkflowSubject {
  readonly issueReceiptDigest: string;
  readonly originalEvent: NormalizedChannelEvent;
  readonly supplement: NormalizedChannelEvent | null;
}

export type FeedbackWorkflowTriageDecision = FeedbackWorkflowAdmission & {
  readonly evidenceRef: string;
} & ({readonly status:'READY' | 'REJECTED'} |
  {readonly status:'NEEDS_INFO';readonly prompt:string});

export interface FeedbackWorkflowVerificationSelection {
  readonly caseId: string;
  readonly round: number;
  readonly run: Extract<CursorWorkResult,{status:'OBSERVED'}>['realization'];
}

export interface FeedbackWorkflowReviewSubject {
  readonly serviceId: string;
  readonly activationId: string;
  readonly bindingDigest: string;
  readonly caseId: string;
  readonly round: number;
  readonly verificationDigest: string;
  readonly candidate: FeedbackVerificationCandidate;
}

export interface FeedbackWorkflowReviewPolicy extends FeedbackWorkflowAdmission {
  readonly policyDigest: string;
  readonly receiptCoverage: MergeObservation['receiptCoverage'];
}

export interface FeedbackWorkflowRegistration {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly activationId: string;
  readonly feedbackBindingStamp: string;
  readonly principalId: string;
  readonly caseId?: string;
  readonly principal: (id: string) => Principal | null;
  readonly admit: (subject: FeedbackWorkflowSubject) => FeedbackWorkflowAdmission | null;
  readonly triage: (subject: FeedbackWorkflowTriageSubject, signal: AbortSignal) =>
    Promise<FeedbackWorkflowTriageDecision | null>;
  readonly linear: {
    readonly scope: LinearIssueScope;
    readonly adapter: ReturnType<typeof createLinearIssueAdapter>;
  };
  readonly channel: {
    readonly scope: ChannelScope;
    readonly adapter: FeedbackDeliveryAdapter;
  };
  readonly cursor: {
    readonly scope: CursorScope;
    readonly adapter: CursorAdapter;
    readonly permits: (subject: FeedbackCursorSubject, trigger: Readonly<FeedbackWorkflowWorkTrigger>) =>
      FeedbackCursorGrant | null;
  };
  readonly verification: {
    readonly rule: FeedbackVerificationRule;
    readonly verifier: Verifier;
    readonly readCandidate: (selection: FeedbackWorkflowVerificationSelection, signal: AbortSignal) =>
      Promise<FeedbackVerificationCandidate | null>;
  };
  readonly review: {
    readonly scope: Parameters<typeof reserveFeedbackReviewNotification>[2];
    readonly channel?: FeedbackDeliveryAdapter;
    readonly adapter: ReturnType<typeof createFeedbackGitHubAdapter>;
    readonly currentPolicy: (subject: FeedbackWorkflowReviewSubject, windowId: string | null) =>
      FeedbackWorkflowReviewPolicy | null;
  };
  readonly maxRepairs: number;
  readonly pollIntervalMs?: number;
  readonly onError?: (fault: {projectId:string;code:string}) => void;
}

export interface FeedbackWorkflowWorkTrigger {
  readonly kind: 'triage' | 'verification' | 'veto';
  readonly ref: string;
  readonly digest: string;
  readonly expiresAt: number | null;
}

type WorkflowCase = {
  id: string;
  workspaceId: string;
  projectId: string;
  scope: ChannelScope;
  originalMessageId: string;
  originalEventKey: string;
};
type WorkflowEvent = {
  caseId: string;
  event: NormalizedChannelEvent;
  receivedAt: number;
};
type WorkflowInfo = {evidenceRef:string; prompt:string; requestedAt:number; expiresAt:number};
type WorkflowReview = {
  subject: FeedbackWorkflowReviewSubject;
  candidate: ReviewCandidate;
  expiresAt: number;
  windowId: string | null;
};
type WorkflowDetail =
  | {phase:'issue' | 'triage'}
  | {phase:'info-issue' | 'info-reply' | 'supplement';info:WorkflowInfo}
  | {phase:'resume';supplementKey:string}
  | {phase:'work' | 'verify';round:number;trigger:FeedbackWorkflowWorkTrigger}
  | {phase:'notify' | 'review' | 'close-issue' | 'close-thread';review:WorkflowReview}
  | {phase:'complete' | 'failed';ref:string;reason:string};
type WorkflowState = WorkflowDetail & {
  caseId: string;
  bindingDigest: string;
  principalRevision: number;
  sequence: number;
  supplementKey: string | null;
};

const workflowHash = /^[a-f0-9]{64}$/;
const workflowRef = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/;
const currentGrant = (value: FeedbackWorkflowAdmission | null, subject: object) =>
  value?.subjectDigest === digest(subject) && Number.isSafeInteger(value.expiresAt) && value.expiresAt > Date.now();
const workflowAttemptId = (caseId: string,round: number) => 'feedback-cursor:'+digest({caseId,round});
const runningWorkflows = new WeakMap<RuntimeStore, Set<string>>();

async function readWithinWorkflowTick<T>(signal: AbortSignal, read: (signal: AbortSignal) => Promise<T>) {
  const budget = AbortSignal.any([signal,AbortSignal.timeout(30_000)]);
  budget.throwIfAborted();
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([read(budget),new Promise<never>((_resolve,rejectRead) => {
      onAbort = () => rejectRead(budget.reason);
      if (budget.aborted) onAbort();
      else budget.addEventListener('abort',onAbort,{once:true});
    })]);
  } finally {
    budget.removeEventListener('abort',onAbort);
  }
}

/** The host registers one worker per activated scope. Starting it is explicit
 * and independent of Codex. A new process resumes the retained phase. */
export function createFeedbackWorkflowWorker(store: RuntimeStore, registration: FeedbackWorkflowRegistration) {
  const projectId = slug(registration.projectId);
  const principalId = slug(registration.principalId);
  const {workspaceId,activationId,feedbackBindingStamp,caseId,channel,cursor,linear,review,verification,maxRepairs} = registration;
  const scope = readChannelScope(channel.scope);
  const reviewChannel = review.channel ?? channel.adapter;
  const reviewScope = {...review.scope,channel:readChannelScope(review.scope.channel),
    allowedActorIds:[...new Set(review.scope.allowedActorIds)].sort()};
  const route = {workspaceId,projectId,scope};
  const interval = registration.pollIntervalMs ?? 5_000;
  if (workspaceId !== store.workspaceId || reviewScope.workspaceId !== workspaceId ||
      reviewScope.projectId !== projectId || !/^sha256:[a-f0-9]{64}$/.test(activationId) ||
      !workflowHash.test(feedbackBindingStamp) || !workflowHash.test(review.adapter.bindingDigest) ||
      !reviewScope.allowedActorIds.length || !reviewScope.allowedActorIds.every(id => workflowRef.test(id)) ||
      (!review.channel && digest(reviewScope.channel) !== digest(scope)) ||
      !Number.isSafeInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 10 ||
      !Number.isSafeInteger(interval) || interval < 250 || interval > 60_000) {
    reject('FEEDBACK_WORKER_REGISTRATION','An exact scoped and bounded feedback registration is required.',409);
  }
  if (caseId !== undefined) string(caseId);
  const bindingDigest = digest({
    route,reviewScope,activationId,feedbackBindingStamp,principalId,maxRepairs,
    cursorScope:cursor.scope,cursorSource:cursor.adapter.source,linearScope:linear.scope,
    channelSource:channel.adapter.source,reviewSource:reviewChannel.source,
    githubBindingDigest:review.adapter.bindingDigest,githubSource:review.adapter.source,verificationRule:verification.rule,
  });
  const key = projectId+':'+activationId;
  const activeRuns = runningWorkflows.get(store) ?? new Set<string>();
  runningWorkflows.set(store,activeRuns);
  let caseCursor = '';
  let eventCursor = '';
  let active: {controller:AbortController;done:Promise<void>} | null = null;

  function currentActor(revision?: number) {
    const actor = registration.principal(principalId);
    if (!actor || actor.id !== principalId || !Number.isSafeInteger(actor.revision) ||
        (revision !== undefined && actor.revision !== revision)) {
      return reject('AUTHORITY_CHANGED','The registered feedback worker principal changed.',409);
    }
    authorize(actor,projectId,'execution.request');
    return actor;
  }

  function requireActivation() {
    const row = store.object(projectId,'feedback-activation',activationId);
    if (store.object(projectId,'feedback-activation-pointer','current') !== activationId || !row) {
      return reject('FEEDBACK_WORKER_ACTIVATION','The registered feedback activation is no longer current.',409);
    }
    const saved = record(row), subject = record(saved.subject);
    if (activationId !== 'sha256:'+digest(subject) || saved.candidateDigest !== activationId ||
        subject.workspaceId !== workspaceId || subject.serviceId !== store.serviceId ||
        subject.projectId !== projectId || subject.feedbackBindingStamp !== feedbackBindingStamp ||
        !Number.isSafeInteger(saved.validUntil) ||
        Number(saved.validUntil) <= Date.now() ||
        subject.definitionPointer !== digest(store.object(projectId,'definition-pointer','active'))) {
      return reject('FEEDBACK_WORKER_ACTIVATION','The exact feedback activation is stale or invalid.',409);
    }
  }

  const readState = () => store.object(projectId,'feedback-workflow',activationId) as WorkflowState | null;
  const findCase = (id: string) => store.object(projectId,'feedback-case',id) as WorkflowCase | null;
  const readEvent = (id: string) => store.object(projectId,'feedback-channel-event',id) as WorkflowEvent | null;
  const readIssue = (id: string) => store.object(projectId,'feedback-case-issue',id) as LinearIssueReceipt | null;

  function matchesCase(value: WorkflowCase | null,id: string): value is WorkflowCase {
    return !!value && value.id === id && value.workspaceId === workspaceId && value.projectId === projectId &&
      digest(value.scope) === digest(scope);
  }

  function requireOriginal(value: WorkflowCase) {
    const original = readEvent(value.originalEventKey);
    if (!original || original.caseId !== value.id || original.event.eventKey !== value.originalEventKey ||
        original.event.messageId !== value.originalMessageId || original.event.action.kind !== 'feedback' ||
        digest(original.event.scope) !== digest(scope)) {
      return reject('FEEDBACK_WORKER_ORIGINAL','The original authenticated feedback is unavailable.',409);
    }
    return original;
  }

  function subjectFor(state: WorkflowState,original: WorkflowEvent): FeedbackWorkflowSubject {
    return {
      serviceId:store.serviceId,workspaceId,projectId,activationId,bindingDigest,principalId,
      principalRevision:state.principalRevision,caseId:state.caseId,originalEventDigest:original.event.payloadDigest,
      phase:state.phase,stateDigest:digest(state),
    };
  }

  function allowed(subject: FeedbackWorkflowSubject) {
    return currentGrant(registration.admit(Object.freeze({...subject})),subject);
  }

  function save(actor: Principal,state: WorkflowState,prior: WorkflowState | null) {
    const stateDigest = digest(state);
    store.mutate(actor,{
      projectId,operation:'feedback.workflow.transition',requestId:'feedback-workflow:'+digest({activationId,stateDigest}),
      expectedRevision:store.revision(projectId),permission:'execution.request',input:{activationId,stateDigest},
    },() => {
      if (digest(readState()) !== digest(prior)) {
        return reject('FEEDBACK_WORKER_BUSY','The original feedback phase changed.',409);
      }
      const firstPhase = state.sequence === 0;
      if (firstPhase && store.object(projectId,'feedback-workflow-assignment',state.caseId)) {
        return reject('FEEDBACK_WORKER_SCOPE','This case already belongs to its original feedback workflow.',409);
      }
      return {
        value:{caseId:state.caseId,phase:state.phase,sequence:state.sequence},
        objects:[
          {kind:'feedback-workflow',id:activationId,value:state},
          ...(firstPhase ? [{
            kind:'feedback-workflow-assignment',id:state.caseId,value:{activationId,bindingDigest},
          }] : []),
          ...(['complete','failed'].includes(state.phase) ? [{
            kind:'feedback-workflow-terminal',id:state.caseId,value:{activationId,phase:state.phase,stateDigest},
          }] : []),
        ],
        event:{type:'feedback-workflow-transition',data:{caseId:state.caseId,phase:state.phase,sequence:state.sequence}},
      };
    },() => currentActor(actor.revision));
    return state;
  }

  function select(actor: Principal, prior: WorkflowState | null) {
    const rows = caseId !== undefined ? [{id:caseId,value:findCase(caseId)}] :
      store.objectsPage(projectId,'feedback-case',caseCursor,50);
    if (caseId === undefined) caseCursor = rows.length === 50 ? rows.at(-1)!.id : '';
    for (const {id,value} of rows) {
      const candidate = value as WorkflowCase | null;
      if (id === prior?.caseId || store.object(projectId,'feedback-workflow-assignment',id) ||
          !matchesCase(candidate,id)) continue;
      const state: WorkflowState = {phase:'issue',caseId:id,bindingDigest,principalRevision:actor.revision,
        sequence:0,supplementKey:null};
      if (allowed(subjectFor(state,requireOriginal(candidate)))) return save(actor,state,prior);
    }
    return null;
  }

  function verifiedSupplement(event: WorkflowEvent | null,id: string,selectedCaseId: string) {
    return event?.caseId === selectedCaseId && event.event.eventKey === id &&
      event.event.action.kind === 'supplement' && event.event.action.caseId === selectedCaseId &&
      digest(event.event.scope) === digest(scope);
  }

  function nextSupplement(state: WorkflowState, info: WorkflowInfo) {
    const rows = store.objectsPage(projectId,'feedback-channel-event',eventCursor,100);
    eventCursor = rows.length === 100 ? rows.at(-1)!.id : '';
    for (const {id,value} of rows) {
      const event = value as WorkflowEvent;
      if (id !== state.supplementKey && event.receivedAt >= info.requestedAt && verifiedSupplement(event,id,state.caseId)) {
        return id;
      }
    }
    return null;
  }

  function requireIssue(id: string) {
    const issue = readIssue(id);
    if (!issue || issue.scopeDigest !== digest(linear.scope) ||
        issue.source !== (cursor.adapter.source === 'FIXTURE' ? 'FIXTURE' : 'LINEAR_PROVIDER')) {
      return reject('FEEDBACK_WORKER_ISSUE','The original scoped Linear issue has no qualified receipt.',409);
    }
    return issue;
  }

  const cursorWorker = createFeedbackCursorWorker(store,cursor.scope,cursor.adapter,subject => {
    const state = readState();
    if (state?.phase !== 'work' || state.caseId !== subject.caseId || state.round !== subject.round ||
        state.bindingDigest !== bindingDigest || (state.trigger.expiresAt !== null && state.trigger.expiresAt <= Date.now())) return null;
    const approval = cursor.permits(subject,Object.freeze({...state.trigger}));
    return approval && approval.maxRepairs <= maxRepairs ? approval : null;
  },id => id === principalId ? currentActor() : reject('AUTHORITY_CHANGED','Wrong registered Cursor principal.',409));

  async function advance(actor: Principal,state: WorkflowState,selected: WorkflowCase,signal: AbortSignal) {
    const {caseId} = state;
    const original = requireOriginal(selected);
    const subject = subjectFor(state,original);
    const assertCurrent = () => {
      signal.throwIfAborted();
      requireActivation();
      const fresh = currentActor(state.principalRevision);
      if (digest(readState()) !== subject.stateDigest || !allowed(subject)) {
        return reject('FEEDBACK_WORKER_ADMISSION','The exact feedback phase has no current registered admission.',409);
      }
      return fresh;
    };
    assertCurrent();
    const progress = (stage: Parameters<typeof retainFeedbackProgress>[4]['stage'],
      status: Parameters<typeof retainFeedbackProgress>[4]['status'],reason: string,ref: string | null,reviewId?: string) => {
      assertCurrent();
      return retainFeedbackProgress(store,actor,projectId,caseId,{stage,status,reason,ref,
        ...(reviewId ? {reviewId} : {})});
    };
    const next = (detail: WorkflowDetail) => {
      assertCurrent();
      return save(actor,{
        caseId,bindingDigest,principalRevision:actor.revision,sequence:state.sequence+1,
        supplementKey:state.supplementKey,...detail,
      },state);
    };
    const fail = (stage: Parameters<typeof retainFeedbackProgress>[4]['stage'],reason: string,ref: string) => {
      progress(stage,'FAILED',reason,ref);
      return next({phase:'failed',reason,ref});
    };
    const issueBinding = {
      scope:linear.scope,adapter: {
        dispatch: (...[intent,reservation]: Parameters<typeof linear.adapter.dispatch>) => {
          const checkMutation = () => {
            assertCurrent();
            if (state.phase === 'info-issue' && state.info.expiresAt <= Date.now()) {
              return reject('FEEDBACK_WORKER_TRIAGE','The exact information request is no longer authorized.',409);
            }
          };
          checkMutation();
          return linear.adapter.dispatch(intent,reservation,checkMutation);
        },
        reconcile: (...args: Parameters<typeof linear.adapter.reconcile>) => linear.adapter.reconcile(...args),
      },
    };
    const deliver = (intent: ReturnType<typeof prepareFeedbackDelivery>,adapter: FeedbackDeliveryAdapter,
      guard: () => void = () => {}) =>
      advanceFeedbackDelivery(store,actor,projectId,intent.scope,intent,{
        source:adapter.source,
        dispatch: (request,reservation) => {
          assertCurrent();
          guard();
          return adapter.dispatch(request,reservation);
        },
        reconcile: request => adapter.reconcile(request),
      },assertCurrent);
    const changeIssue = (change: Parameters<typeof changeFeedbackCaseIssue>[5]) =>
      changeFeedbackCaseIssue(store,route,actor,caseId,issueBinding,change,assertCurrent);
    const issueStatus = (result: LinearIssueResult,
      stage: Parameters<typeof retainFeedbackProgress>[4]['stage']) => {
      if (result.status === 'BLOCKED') return fail(stage,'LINEAR_'+result.reason,result.intentId);
      if (result.status === 'UNKNOWN') progress(stage,'UNKNOWN','LINEAR_READBACK_PENDING',result.intentId);
      return state;
    };
    const repair = (stage:'verify'|'review',round: number,trigger: FeedbackWorkflowWorkTrigger) => {
      if (round >= maxRepairs) return fail(stage,'REPAIR_LIMIT_REACHED',trigger.ref);
      progress('repair','RUNNING',trigger.kind === 'veto' ? 'CANDIDATE_VETOED' : 'VERIFICATION_FAILED',trigger.ref);
      return next({phase:'work',round:round+1,trigger});
    };
    const currentPolicy = (selection: WorkflowReview) => {
      const policy = review.currentPolicy(structuredClone(selection.subject),selection.windowId);
      return currentGrant(policy,selection.subject) && policy && workflowHash.test(policy.policyDigest) &&
        ['COMPLETE','UNCERTAIN'].includes(policy.receiptCoverage) ? policy : null;
    };
    const requireWindow = (selection: WorkflowReview) => {
      const window = selection.windowId ?
        store.object(projectId,'feedback-review-window',selection.windowId) as ReturnType<typeof openFeedbackReview> | null : null;
      if (!window || window.id !== selection.windowId || window.candidateDigest !== digest(selection.candidate) ||
          digest(window.candidate) !== window.candidateDigest) {
        return reject('FEEDBACK_WORKER_WINDOW','The original candidate-bound review window is unavailable.',409);
      }
      return window;
    };

    switch (state.phase) {
    case 'issue': {
      progress('issue','RUNNING','LINEAR_ISSUE_BINDING',original.event.eventKey);
      const result = await bindFeedbackCaseIssue(store,route,actor,caseId,issueBinding,assertCurrent);
      if (result.status !== 'CONFIRMED') return issueStatus(result,'issue');
      requireIssue(caseId);
      progress('issue','COMPLETE','LINEAR_ISSUE_CONFIRMED',result.receipt.intentId);
      return next({phase:'triage'});
    }
    case 'triage': {
      const originalIssue = requireIssue(caseId);
      const supplement = state.supplementKey ? readEvent(state.supplementKey) : null;
      let issueReceipt = originalIssue;
      if (state.supplementKey) {
        const id = store.object(projectId,'feedback-case-issue-latest',caseId);
        const change = typeof id === 'string' ?
          store.object(projectId,'feedback-case-issue-change',id) as {result: LinearIssueResult | null} | null : null;
        if (!verifiedSupplement(supplement,state.supplementKey,caseId) || change?.result?.status !== 'CONFIRMED' ||
            change.result.receipt.issueId !== originalIssue.issueId) {
          return reject('FEEDBACK_WORKER_SUPPLEMENT','Authenticated information and its original issue receipt are required.',409);
        }
        issueReceipt = change.result.receipt;
      }
      progress('reproduce','WAITING','TRIAGE_PENDING',issueReceipt.intentId);
      const triage: FeedbackWorkflowTriageSubject = {...subject,issueReceiptDigest:digest(issueReceipt),
        originalEvent:original.event,supplement:supplement?.event ?? null};
      const decision = await readWithinWorkflowTick(signal,budget => registration.triage(structuredClone(triage),budget));
      assertCurrent();
      if (!decision || !currentGrant(decision,triage) || !workflowRef.test(decision.evidenceRef)) return state;
      if (decision.status === 'REJECTED') return fail('reproduce','TRIAGE_REJECTED',decision.evidenceRef);
      if (decision.status === 'NEEDS_INFO') {
        prepareFeedbackDelivery({kind:'needs-info',caseId,scope,requestId:'triage-validation',
          originalMessageId:selected.originalMessageId,text:decision.prompt});
        return next({phase:'info-issue',info:{evidenceRef:decision.evidenceRef,prompt:decision.prompt,
          requestedAt:Date.now(),expiresAt:decision.expiresAt}});
      }
      if (decision.status !== 'READY') return state;
      return next({phase:'work',round:0,trigger:{kind:'triage',ref:decision.evidenceRef,
        digest:digest(decision),expiresAt:decision.expiresAt}});
    }
    case 'info-issue': {
      const result = await changeIssue({kind:'needs-info',triageRef:state.info.evidenceRef,prompt:state.info.prompt});
      if (result.status !== 'CONFIRMED') return issueStatus(result,'reproduce');
      return next({phase:'info-reply',info:state.info});
    }
    case 'info-reply': {
      const {info} = state;
      const requestId = 'feedback-info:'+digest({caseId,triageRef:info.evidenceRef});
      const result = await deliver(prepareFeedbackDelivery({kind:'needs-info',caseId,scope,requestId,
        originalMessageId:selected.originalMessageId,text:info.prompt}),channel.adapter,() => {
        if (info.expiresAt <= Date.now()) reject('FEEDBACK_WORKER_TRIAGE','The exact information reply is no longer authorized.',409);
      });
      if (result.status !== 'DELIVERED') {
        progress('reproduce','UNKNOWN','CHANNEL_READBACK_PENDING',requestId);
        return state;
      }
      progress('receive','WAITING','ORIGINAL_SUPPLEMENT_PENDING',requestId);
      return next({phase:'supplement',info});
    }
    case 'supplement': {
      const supplementKey = nextSupplement(state,state.info);
      if (!supplementKey) return state;
      progress('receive','COMPLETE','ORIGINAL_SUPPLEMENT_RECEIVED',supplementKey);
      return next({phase:'resume',supplementKey});
    }
    case 'resume': {
      progress('issue','RUNNING','LINEAR_RESUME_PENDING',state.supplementKey);
      const result = await changeIssue({kind:'resume',supplementEventKey:state.supplementKey});
      if (result.status !== 'CONFIRMED') return issueStatus(result,'issue');
      progress('issue','COMPLETE','LINEAR_RESUMED',result.receipt.intentId);
      return next({phase:'triage'});
    }
    case 'work': {
      const {round,trigger} = state;
      const stage = round === 0 ? 'reproduce' : 'repair';
      progress(stage,'RUNNING',round === 0 ? 'CURSOR_REPRODUCTION' : 'CURSOR_REPAIR',trigger.ref);
      const result = await cursorWorker.advance(actor,{projectId,caseId,round},assertCurrent);
      if (result.status === 'UNKNOWN') {
        progress(stage,'UNKNOWN','CURSOR_READBACK_PENDING',result.intentId);
        return state;
      }
      const run = result.realization;
      if (!terminal(result)) {
        progress(stage,'RUNNING','CURSOR_WORK_PENDING',run.runId);
        return state;
      }
      if (run.status !== 'FINISHED' || !run.pullRequest) return fail(stage,'CURSOR_WORK_FAILED',run.runId);
      progress('repair','COMPLETE','CURSOR_PR_READY',run.runId);
      return next({phase:'verify',round,trigger});
    }
    case 'verify': {
      const {round} = state;
      const attemptId = workflowAttemptId(caseId,round);
      const attempt = store.object(projectId,'feedback-cursor-attempt',attemptId) as SavedAttempt | null;
      if (attempt?.outcome?.status !== 'OBSERVED' || attempt.outcome.realization.status !== 'FINISHED') {
        return reject('FEEDBACK_WORKER_VERIFICATION','The original finished Cursor run is required.',409);
      }
      const run = attempt.outcome.realization;
      progress('verify','RUNNING','INDEPENDENT_VERIFICATION',run.runId);
      const result = await readWithinWorkflowTick(signal,budget => cursorWorker.verify(
        actor,{projectId,caseId,round},verification.rule,verification.verifier,
        async () => {
          budget.throwIfAborted();
          assertCurrent();
          return verification.readCandidate({caseId,round,run:structuredClone(run)},budget);
        },budget,assertCurrent));
      if (result.status === 'HOLD') {
        progress('verify','WAITING','VERIFICATION_'+result.reason,run.runId);
        return state;
      }
      if (result.status === 'FAIL') return repair('verify',round,{kind:'verification',ref:result.evidenceDigest,
        digest:digest(result),expiresAt:result.expiresAt});
      const saved = store.object(projectId,'feedback-verification-latest',attemptId) as SavedVerification | null;
      if (!saved || saved.attemptId !== attemptId || digest(saved.result) !== digest(result)) {
        return reject('FEEDBACK_WORKER_VERIFICATION','Exact retained candidate verification is required.',409);
      }
      const reviewSubject: FeedbackWorkflowReviewSubject = {serviceId:store.serviceId,activationId,
        bindingDigest,caseId,round,verificationDigest:result.evidenceDigest,candidate:saved.candidate};
      const policy = review.currentPolicy(structuredClone(reviewSubject),null);
      if (!currentGrant(policy,reviewSubject) || !policy || !workflowHash.test(policy.policyDigest)) {
        progress('verify','WAITING','REVIEW_POLICY_PENDING',result.evidenceDigest);
        return state;
      }
      progress('verify','COMPLETE','VERIFICATION_PASSED',result.evidenceDigest);
      const candidate: ReviewCandidate = {
        workspaceId,projectId,repositoryId:saved.candidate.repositoryId,pullRequestId:String(saved.candidate.number),
        head:saved.candidate.head,base:saved.candidate.base,evidenceDigest:result.evidenceDigest,policyDigest:policy.policyDigest,
      };
      return next({phase:'notify',review:{subject:reviewSubject,candidate,expiresAt:result.expiresAt,windowId:null}});
    }
    case 'notify': {
      const selection = state.review;
      const {candidate} = selection;
      const retained = readRetainedFeedbackReview(store,actor,reviewScope,candidate);
      if (retained) {
        progress('review','WAITING','REVIEW_WINDOW_OPEN',retained.id,retained.id);
        return next({phase:'review',review:{...selection,windowId:retained.id}});
      }
      const admitReview = () => {
        const policy = currentPolicy(selection);
        return policy?.policyDigest === candidate.policyDigest && selection.expiresAt > Date.now();
      };
      if (!admitReview()) {
        progress('review','WAITING','REVIEW_ADMISSION_PENDING',candidate.evidenceDigest);
        return state;
      }
      const {intent} = reserveFeedbackReviewNotification(store,actor,reviewScope,candidate);
      progress('review','RUNNING','REVIEW_NOTIFICATION_PENDING',intent.intentRef);
      const result = await deliver(prepareFeedbackDelivery({kind:'review',caseId,scope:reviewScope.channel,requestId:intent.intentRef,
        reviewId:intent.windowId,text:`Review PR #${candidate.pullRequestId} at ${candidate.head}. The review window lasts sixty minutes.`}),
        reviewChannel,() => {
          if (!admitReview()) reject('FEEDBACK_WORKER_REVIEW','The original notice lost its current admission.',409);
        });
      if (result.status !== 'DELIVERED') {
        progress('review','UNKNOWN','CHANNEL_READBACK_PENDING',intent.intentRef);
        return state;
      }
      assertCurrent();
      if (!admitReview()) return state;
      const window = retainFeedbackReview(store,actor,reviewScope,candidate,intent.intentRef,result.receipt.messageId,Date.now());
      progress('review','WAITING','REVIEW_WINDOW_OPEN',window.id,window.id);
      return next({phase:'review',review:{...selection,windowId:window.id}});
    }
    case 'review': {
      const selection = state.review;
      const window = requireWindow(selection);
      const {candidate} = selection;
      if (window.veto) return repair('review',selection.subject.round,{kind:'veto',ref:window.veto.eventKey,
        digest:digest({windowId:window.id,veto:window.veto}),expiresAt:null});
      if (!window.claim && Date.now() < window.deadline) return state;
      const admission = () => {
        assertCurrent();
        const policy = currentPolicy(selection);
        const attemptId = workflowAttemptId(caseId,selection.subject.round);
        const latest = store.object(projectId,'feedback-verification-latest',attemptId) as SavedVerification | null;
        return {
          policyCurrent: policy?.policyDigest === candidate.policyDigest && selection.expiresAt > Date.now() &&
            latest?.result.status === 'PASS' && latest.result.evidenceDigest === selection.subject.verificationDigest &&
            digest(latest.candidate) === digest(selection.subject.candidate),
          receiptCoverage:policy?.receiptCoverage ?? 'UNCERTAIN' as const,
        };
      };
      if (!window.claim) {
        const current = admission();
        if (!current.policyCurrent || current.receiptCoverage !== 'COMPLETE') {
          progress('review','WAITING','MERGE_ADMISSION_PENDING',window.id,window.id);
          return state;
        }
      }
      const outcome = await advanceFeedbackMerge(store,actor,projectId,window.id,review.adapter,admission,assertCurrent,signal);
      if (outcome.status === 'DENIED') return fail('review','GITHUB_MERGE_DENIED',outcome.requestId);
      if (outcome.status !== 'MERGED') {
        progress('review',outcome.status === 'UNKNOWN' ? 'UNKNOWN' : 'RUNNING','GITHUB_MERGE_READBACK_PENDING',outcome.requestId);
        return state;
      }
      if (outcome.source !== selection.subject.candidate.source) {
        return reject('FEEDBACK_WORKER_MERGE','The original GitHub receipt has different provider provenance.',409);
      }
      const confirmed = readFeedbackClosureMerge(store,projectId,caseId,window.id);
      progress('review','COMPLETE','GITHUB_MERGE_CONFIRMED',confirmed.requestId,window.id);
      return next({phase:'close-issue',review:selection});
    }
    case 'close-issue': {
      const window = requireWindow(state.review);
      const merged = readFeedbackClosureMerge(store,projectId,caseId,window.id);
      progress('close','RUNNING','LINEAR_CLOSURE_PENDING',merged.requestId);
      const result = await changeIssue({kind:'close',windowId:window.id});
      if (result.status !== 'CONFIRMED') return issueStatus(result,'close');
      return next({phase:'close-thread',review:state.review});
    }
    case 'close-thread': {
      const window = requireWindow(state.review);
      const merged = readFeedbackClosureMerge(store,projectId,caseId,window.id);
      const requestId = feedbackClosureDeliveryId(caseId,window.id);
      const result = await deliver(prepareFeedbackDelivery({kind:'closed',caseId,scope,requestId,
        originalMessageId:selected.originalMessageId,text:`Merged PR #${merged.pullRequestId} at ${merged.mergeSha}.`}),channel.adapter);
      if (result.status !== 'DELIVERED') {
        progress('close','UNKNOWN','CHANNEL_READBACK_PENDING',requestId);
        return state;
      }
      progress('close','COMPLETE','ORIGINAL_THREAD_CLOSED',requestId);
      return next({phase:'complete',ref:requestId,reason:'ORIGINAL_THREAD_CLOSED'});
    }
    case 'complete':
    case 'failed':
      return state;
    }
  }

  async function runOnce(signal: AbortSignal = new AbortController().signal) {
    if (activeRuns.has(key)) return reject('FEEDBACK_WORKER_BUSY','The original feedback case is already being inspected.',409);
    activeRuns.add(key);
    try {
      signal.throwIfAborted();
      requireActivation();
      const state = readState();
      if (!state) return select(currentActor(),null);
      if (state.bindingDigest !== bindingDigest || (caseId !== undefined && state.caseId !== caseId)) {
        return reject('FEEDBACK_WORKER_SCOPE','The retained workflow belongs to different registration bindings.',409);
      }
      if (state.phase === 'complete' || state.phase === 'failed') {
        return caseId === undefined ? select(currentActor(),state) : state;
      }
      const actor = currentActor(state.principalRevision);
      const selected = findCase(state.caseId);
      if (!matchesCase(selected,state.caseId)) {
        return reject('FEEDBACK_WORKER_SCOPE','The original feedback case no longer matches its registration.',409);
      }
      return await advance(actor,state,selected,signal);
    } finally {
      activeRuns.delete(key);
    }
  }

  function start() {
    if (!active) {
      const controller = new AbortController();
      const {signal} = controller;
      const done = (async () => {
        let wait = interval;
        while (!signal.aborted) {
          try {
            const state = await runOnce(signal);
            if (caseId !== undefined && (state?.phase === 'complete' || state?.phase === 'failed')) break;
            wait = interval;
          } catch (error) {
            if (signal.aborted) break;
            try {
              registration.onError?.({projectId,code:error instanceof ServiceError ? error.code : 'FEEDBACK_WORKER_UNAVAILABLE'});
            } catch { /* Reporting cannot change the original phase or retry decision. */ }
            wait = Math.min(wait*2,60_000);
          }
          await delay(wait,undefined,{signal}).catch(() => {});
        }
      })();
      active = {controller,done};
    }
    const session = active;
    return Object.freeze({done:session.done,stop:async () => {
      session.controller.abort();
      await session.done;
      if (active === session) active = null;
    }});
  }

  return Object.freeze({runOnce,start});
}
