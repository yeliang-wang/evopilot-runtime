import { digest, record, reject, string } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import type { RuntimeStore } from '../server/store.js';
import {
  prepareCursorWorkIntent, type createCursorAgentAdapter, type CursorScope,
  type CursorWorkIntent, type CursorWorkResult,
} from './cursor.js';
import type { LinearIssueReceipt } from './linear.js';
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

  async function advance(actor: Principal, selection: CursorSelection) {
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
          verifyActor(projectId,actor);
          if (activation(projectId) !== subject.activationId ||
              originalIssue(projectId,caseId).issueEvidenceDigest !== subject.issueEvidenceDigest ||
              digest(grant(subject)) !== attempt.grantDigest ||
              readAttempt(projectId,id)?.intent.intentId !== intent.intentId) {
            reject('FEEDBACK_CURSOR_ADMISSION','The original launch no longer has current admission.',409);
          }
        });
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
    readCandidate: () => Promise<FeedbackVerificationCandidate | null>, signal: AbortSignal,
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
