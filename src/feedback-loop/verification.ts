import {
  nativeFrozenClone, nativeSha256, validateNativeReference,
  type NativeReference, type NativeScope, type NativeValidationContext,
} from '../../vendor/compatibility/v1/native.mjs';
import { ownerDistributionIdentity, ownerRequestDigest, type PublishedOwnerAdapter } from '../adapters/published-owners.js';
import { nativeInventory, verifyNativeStageResult } from '../adapters/stages.js';
import { digest, exact, record, reject, slug, string } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import type { CursorRunRealization, CursorScope, CursorWorkIntent } from './cursor.js';

type VerificationSource = 'PROTECTED' | 'FIXTURE';

export interface FeedbackVerificationCandidate {
  readonly source: 'GITHUB_PROVIDER' | 'FIXTURE';
  readonly repositoryId: string;
  readonly number: number;
  readonly branch: string;
  readonly head: string;
  readonly base: string;
}

export interface FeedbackVerificationRule {
  readonly bindingRef: string;
  readonly ownerRegistrationDigest: string;
  readonly scope: NativeScope;
  readonly reference: NativeReference;
  readonly publicationRequestId: string;
  readonly toolchainLockDigest: string;
  readonly effectiveConfigDigest: string;
  readonly executorRef: string;
  readonly executorBindingDigest: string;
  readonly validUntil: number;
}

interface FinishedWork {
  readonly intent: CursorWorkIntent;
  readonly run: CursorRunRealization;
}

interface SubjectInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly caseId: string;
  readonly activationId: string;
  readonly scope: CursorScope;
  readonly original: FinishedWork;
  readonly work: FinishedWork;
  readonly pullRequest: FeedbackVerificationCandidate;
  readonly rule: FeedbackVerificationRule;
}

interface WorkProof {
  readonly kind: CursorWorkIntent['kind'];
  readonly intentId: string;
  readonly run: CursorRunRealization;
}

export interface FeedbackVerificationSubject extends Omit<SubjectInput, 'original' | 'work'> {
  readonly schema: 'runtime-feedback-verification-subject/v1';
  readonly issueId: string;
  readonly source: VerificationSource;
  readonly original: WorkProof;
  readonly work: WorkProof;
  readonly subjectDigest: string;
}

/** Read through a protected registered executor that holds the original receipt and report. */
export interface FeedbackVerificationExecution {
  readonly schema: 'runtime-feedback-verification-execution/v1';
  readonly source: VerificationSource;
  readonly subjectDigest: string;
  readonly requestId: string;
  readonly executorRef: string;
  readonly executorBindingDigest: string;
  readonly executionId: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly expiresAt: number;
  readonly receiptRef: string;
  readonly receiptDigest: string;
  readonly reportDigest: string;
  readonly status: 'PASS' | 'FAIL';
}

export type FeedbackVerificationExecutionReader = (
  actor: Principal, subject: FeedbackVerificationSubject, requestId: string, signal: AbortSignal,
) => Promise<FeedbackVerificationExecution | null>;

type HoldReason = 'PROVENANCE_MISMATCH' | 'RULE_STALE' | 'RULE_UNVERIFIED' | 'CANDIDATE_UNAVAILABLE' | 'CANDIDATE_CHANGED' |
  'EXECUTION_UNAVAILABLE' | 'EXECUTION_MISMATCH' | 'EXECUTION_STALE' | 'HARNESS_UNDECIDABLE' | 'VERDICT_MISMATCH';

interface VerificationEvidence {
  readonly schema: 'runtime-feedback-verification-evidence/v1';
  readonly source: VerificationSource;
  readonly subjectDigest: string;
  readonly execution: FeedbackVerificationExecution;
  readonly publicationReceiptDigest: string;
  readonly harnessRequestId: string;
  readonly harnessReceiptDigest: string;
  readonly harnessReportDigest: string;
  readonly expiresAt: number;
  readonly status: 'PASS' | 'FAIL';
}

export type FeedbackVerificationResult =
  | {readonly status: 'HOLD'; readonly subjectDigest: string; readonly reason: HoldReason}
  | {readonly status: 'PASS' | 'FAIL'; readonly subjectDigest: string; readonly evidenceDigest: string;
      readonly evidence: VerificationEvidence; readonly expiresAt: number};

const bareHash = /^[a-f0-9]{64}$/;
const hash = /^sha256:[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
const repository = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const providerNumber = /^[1-9][0-9]{0,19}$/;
const binding = /^binding:[a-z][a-z0-9-]*(\/[a-z0-9][a-z0-9._-]*){1,5}$/;
const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const agentId = new RegExp('^bc-' + uuid + '$');
const runId = new RegExp('^run-' + uuid + '$');
const time = (value: number) => Number.isSafeInteger(value) && value > 0;
const same = (left: unknown, right: unknown) => digest(left) === digest(right);

function invalid(code = 'FEEDBACK_VERIFICATION_SUBJECT'): never {
  return reject(code, 'Independent verification requires the exact retained feedback and provider records.', 409);
}

function candidate(value: FeedbackVerificationCandidate) {
  exact(record(value), ['source', 'repositoryId', 'number', 'branch', 'head', 'base']);
  if (!['GITHUB_PROVIDER', 'FIXTURE'].includes(value.source) || !providerNumber.test(string(value.repositoryId, 20)) ||
      !Number.isSafeInteger(value.number) || value.number <= 0 || !commit.test(value.head) || !commit.test(value.base)) invalid();
  string(value.branch, 255);
  return value;
}

function finished(finishedWork: FinishedWork, scope: CursorScope, caseId: string, pr: FeedbackVerificationCandidate) {
  const {intent, run} = finishedWork;
  const {intentId, ...material} = intent;
  const prIdentity = run.pullRequest;
  const scopeDigest = digest(scope);
  if (intent.schema !== 'runtime-cursor-work/v1' || !['initial', 'repair'].includes(intent.kind) ||
      intentId !== digest(material) || intent.caseId !== caseId || intent.scopeDigest !== scopeDigest ||
      run.status !== 'FINISHED' || run.scopeDigest !== scopeDigest || run.intentId !== intentId ||
      intent.agentId !== run.agentId || !agentId.test(run.agentId) || !runId.test(run.runId) ||
      !['CURSOR_PROVIDER', 'FIXTURE'].includes(run.source) ||
      !time(Date.parse(run.createdAt)) || !time(Date.parse(run.updatedAt)) || Date.parse(run.createdAt) > Date.parse(run.updatedAt) ||
      (run.resultDigest !== null && !bareHash.test(run.resultDigest)) || !prIdentity ||
      prIdentity.number !== pr.number || prIdentity.branch !== pr.branch ||
      prIdentity.url !== `${scope.repository}/pull/${pr.number}`) invalid();
  string(intent.requestId);
  string(intent.issueId);
  return {kind: intent.kind, intentId, run};
}

export function prepareFeedbackVerification(input: SubjectInput): FeedbackVerificationSubject {
  const {workspaceId, projectId, caseId, activationId, scope, rule} = input;
  slug(workspaceId);
  slug(projectId);
  string(caseId);
  exact(record(scope), ['repository', 'branch']);
  if (!hash.test(activationId) || !repository.test(scope.repository)) invalid();
  string(scope.branch, 255);
  const pullRequest = candidate(input.pullRequest);
  if (pullRequest.branch === scope.branch || pullRequest.head === pullRequest.base) invalid();
  exact(record(rule), ['bindingRef', 'ownerRegistrationDigest', 'scope', 'reference', 'publicationRequestId',
    'toolchainLockDigest', 'effectiveConfigDigest', 'executorRef', 'executorBindingDigest', 'validUntil']);
  exact(record(rule.scope), ['visibility', 'projectId']);
  validateNativeReference(rule.reference, {product: 'harness', visibility: rule.scope.visibility});
  slug(rule.scope.projectId);
  if ((rule.scope.visibility === 'private' && rule.scope.projectId !== projectId) ||
      ![rule.ownerRegistrationDigest, rule.toolchainLockDigest, rule.effectiveConfigDigest, rule.executorBindingDigest].every(value => hash.test(value)) ||
      ![rule.bindingRef, rule.executorRef].every(value => binding.test(string(value, 200))) ||
      !time(rule.validUntil)) invalid();
  string(rule.publicationRequestId, 512);

  const original = finished(input.original, scope, caseId, pullRequest);
  const work = finished(input.work, scope, caseId, pullRequest);
  const issueId = input.original.intent.issueId;
  if (original.kind !== 'initial' || input.work.intent.issueId !== issueId) invalid();
  if (input.work.intent.kind === 'repair') {
    const {source, intentId, agentId, runId, pullRequest} = original.run;
    if (!same(input.work.intent.original, {source, intentId, agentId, runId, pullRequest}) ||
        work.run.runId === runId || work.run.agentId === agentId ||
        input.work.intent.requestId === input.original.intent.requestId ||
        Date.parse(work.run.createdAt) < Date.parse(original.run.updatedAt)) invalid();
  } else if (!same(original, work)) invalid();

  const source: VerificationSource = original.run.source === 'FIXTURE' ? 'FIXTURE' : 'PROTECTED';
  if (work.run.source !== original.run.source || (pullRequest.source === 'FIXTURE') !== (source === 'FIXTURE')) {
    invalid('FEEDBACK_VERIFICATION_PROVENANCE');
  }
  const body = {schema:'runtime-feedback-verification-subject/v1' as const, workspaceId, projectId, caseId, activationId,
    scope, rule, source, issueId, original, work, pullRequest};
  return nativeFrozenClone({...body, subjectDigest: nativeSha256(body)});
}

function checkSubject(subject: FeedbackVerificationSubject) {
  const {subjectDigest, ...body} = subject;
  if (subject.schema !== 'runtime-feedback-verification-subject/v1' || nativeSha256(body) !== subjectDigest) invalid();
}

export function feedbackVerificationExecutionId(subject: FeedbackVerificationSubject): string {
  checkSubject(subject);
  return 'feedback-verify-' + subject.subjectDigest.slice(7, 55);
}

function executionMatches(execution: FeedbackVerificationExecution, subject: FeedbackVerificationSubject) {
  exact(record(execution), ['schema', 'source', 'subjectDigest', 'requestId', 'executorRef', 'executorBindingDigest',
    'executionId', 'startedAt', 'completedAt', 'expiresAt', 'receiptRef', 'receiptDigest', 'reportDigest', 'status']);
  const {rule, work} = subject;
  return execution.schema === 'runtime-feedback-verification-execution/v1' && execution.source === subject.source &&
    execution.subjectDigest === subject.subjectDigest && execution.requestId === feedbackVerificationExecutionId(subject) &&
    execution.executorRef === rule.executorRef && execution.executorBindingDigest === rule.executorBindingDigest &&
    string(execution.executionId) !== work.run.runId && execution.executionId !== subject.original.run.runId &&
    time(execution.startedAt) && time(execution.completedAt) && time(execution.expiresAt) &&
    execution.startedAt >= Date.parse(work.run.updatedAt) && execution.startedAt <= execution.completedAt &&
    execution.expiresAt > execution.completedAt && !!string(execution.receiptRef, 1024) &&
    [execution.reportDigest, execution.receiptDigest].every(value => hash.test(value)) &&
    (execution.status === 'PASS' || execution.status === 'FAIL');
}

/** Derive the one native evaluation whose original receipt the worker may consume. */
export function prepareFeedbackVerificationEvaluation(subject: FeedbackVerificationSubject,
  execution: FeedbackVerificationExecution, publishedPackage: Record<string, unknown>) {
  checkSubject(subject);
  if (!executionMatches(execution, subject)) invalid('FEEDBACK_VERIFICATION_EXECUTION');
  const {rule, pullRequest, workspaceId} = subject;
  const criteria = nativeInventory(publishedPackage, 'harness');
  const sourceScopeDigest = nativeSha256({scope:subject.scope, pullRequest});
  const context: NativeValidationContext = {
    workspaceId, scope:rule.scope, projectCandidateDigest:subject.subjectDigest,
    claimId:nativeSha256({requestId:execution.requestId}), inputDigest:nativeSha256(execution),
    effectiveConfigDigest:rule.effectiveConfigDigest, sourceScopeDigest, requirementSetDigest:nativeSha256(criteria),
  };
  const observation = {schema:'evopilot-observation/v1', origin:'execution-result',
    source:{revision:pullRequest.head, digest:sourceScopeDigest},
    values:{runtimeFeedbackVerification:{subject, execution}}, sourceScopeDigest,
    collectionReceiptRef:{id:execution.receiptRef, digest:execution.receiptDigest, claimId:context.claimId}};
  const request = {operation:'native.package.validate', scope:rule.scope,
    input:{id:rule.reference.id, version:rule.reference.version, context, observation},
    requestId:'feedback-native-' + subject.subjectDigest.slice(7, 55)};
  const action = {request, context, requestDigest:ownerRequestDigest('harness', request), observationDigest:nativeSha256(observation)};
  return {request, action:{...action, digest:nativeSha256(action)},
    pin:{ref:rule.bindingRef, registrationDigest:rule.ownerRegistrationDigest, scope:rule.scope, reference:rule.reference, criteria}};
}

export function createFeedbackVerification(options: {
  readonly source: VerificationSource;
  readonly owner: Pick<PublishedOwnerAdapter, 'owner' | 'workspaceId' | 'capabilities' | 'readPackage' | 'read'>;
  readonly readExecution: FeedbackVerificationExecutionReader;
}) {
  const {source, owner, readExecution} = options;
  function currentOwner(subject: FeedbackVerificationSubject) {
    const capabilities = record(owner.capabilities());
    if (owner.owner !== 'harness' || owner.workspaceId !== subject.workspaceId ||
        capabilities.registrationDigest !== subject.rule.ownerRegistrationDigest) return false;
    if (source === 'FIXTURE') return true;
    const distribution = ownerDistributionIdentity('harness');
    return capabilities.owner === distribution.owner && capabilities.version === distribution.version &&
      capabilities.packageDigest === distribution.packageDigest && capabilities.distributionDigest === distribution.distributionDigest;
  }

  async function inspect(actor: Principal, retained: FeedbackVerificationSubject, input: {
    readonly readCandidate: () => Promise<FeedbackVerificationCandidate | null>;
    readonly signal: AbortSignal;
  }): Promise<FeedbackVerificationResult> {
    const subject = nativeFrozenClone(retained), {signal, readCandidate} = input;
    const {subjectDigest, projectId, rule} = subject;
    const hold = (reason: HoldReason): FeedbackVerificationResult => ({status:'HOLD', subjectDigest, reason});
    authorize(actor, projectId, 'read');
    checkSubject(subject);
    signal.throwIfAborted();
    if (source !== subject.source) return hold('PROVENANCE_MISMATCH');
    if (rule.validUntil <= Date.now()) return hold('RULE_STALE');

    async function candidateHold(): Promise<HoldReason | null> {
      try {
        const current = await readCandidate();
        signal.throwIfAborted();
        if (!current) return 'CANDIDATE_UNAVAILABLE';
        if (current.source !== subject.pullRequest.source) return 'PROVENANCE_MISMATCH';
        return same(candidate(current), subject.pullRequest) ? null : 'CANDIDATE_CHANGED';
      } catch {
        signal.throwIfAborted();
        return 'CANDIDATE_UNAVAILABLE';
      }
    }

    const before = await candidateHold();
    if (before) return hold(before);
    let execution: FeedbackVerificationExecution;
    let reason: HoldReason = 'EXECUTION_UNAVAILABLE';
    try {
      const original = await readExecution(actor, subject, feedbackVerificationExecutionId(subject), signal);
      signal.throwIfAborted();
      if (!original) return hold(reason);
      reason = 'EXECUTION_MISMATCH';
      execution = nativeFrozenClone(original);
      if (source !== execution.source) return hold('PROVENANCE_MISMATCH');
      if (!executionMatches(execution, subject)) return hold(reason);
    } catch {
      signal.throwIfAborted();
      return hold(reason);
    }
    if (execution.completedAt > Date.now() || execution.expiresAt <= Date.now()) return hold('EXECUTION_STALE');

    let evidence: VerificationEvidence;
    reason = 'RULE_UNVERIFIED';
    try {
      if (!currentOwner(subject)) return hold(reason);
      const material = await owner.readPackage(actor, projectId, rule.scope, rule.reference);
      const publication = record(await owner.read(actor, projectId, {operation:'native.receipt.inspect',
        scope:rule.scope, input:{requestId:rule.publicationRequestId}}));
      signal.throwIfAborted();
      const publicationResult = record(publication.result);
      const {reportDigest, ...baseline} = record(material.validation);
      if (material.published !== true || material.workspaceId !== subject.workspaceId || !same(material.scope, rule.scope) ||
          !same(material.reference, rule.reference) || publication.requestId !== rule.publicationRequestId ||
          publication.operation !== 'native.package.publish' || publication.status !== 'SUCCEEDED' ||
          !same(publication.scope, rule.scope) || publicationResult.published !== true ||
          !same(publicationResult.reference, rule.reference) || reportDigest !== nativeSha256(baseline) ||
          !same(baseline.reference, rule.reference) || baseline.effectiveConfigDigest !== rule.effectiveConfigDigest ||
          baseline.executionStatus !== 'SUCCEEDED' || baseline.qualityStatus !== 'PASS') return hold(reason);
      const publicationReceiptDigest = nativeSha256(publication);
      const evaluation = prepareFeedbackVerificationEvaluation(subject, execution, record(material.package));
      reason = 'HARNESS_UNDECIDABLE';
      const receipt = record(await owner.read(actor, projectId, {operation:'native.receipt.inspect',
        scope:rule.scope, input:{requestId:evaluation.request.requestId}}));
      signal.throwIfAborted();
      // An execution/tool failure, skipped criterion or pending owner action cannot establish a functional failure.
      if (receipt.status !== 'SUCCEEDED') return hold(reason);
      const report = record(receipt.result);
      if (report.schema !== 'evopilot-native-validation/v1' || report.owner !== 'harness' ||
          report.executionStatus !== 'SUCCEEDED' || !Array.isArray(report.criteria) ||
          !report.criteria.every(criterion => ['PASS', 'FAIL'].includes(String(record(criterion).status)))) return hold(reason);
      const result = verifyNativeStageResult(receipt, 'harness', evaluation.pin, evaluation.action,
        rule.toolchainLockDigest, rule.effectiveConfigDigest);
      if (result.status === 'UNKNOWN' || !result.receiptDigest || !result.reportDigest ||
          (result.status === 'FAIL' && (report.qualityStatus !== 'FAIL' || !report.criteria.some(item => record(item).status === 'FAIL')))) {
        return hold(reason);
      }
      if (result.status !== execution.status) return hold('VERDICT_MISMATCH');
      evidence = {schema:'runtime-feedback-verification-evidence/v1', source, subjectDigest, execution,
        publicationReceiptDigest, harnessRequestId:evaluation.request.requestId, harnessReceiptDigest:result.receiptDigest,
        harnessReportDigest:result.reportDigest, expiresAt:Math.min(rule.validUntil, execution.expiresAt), status:result.status};
    } catch {
      signal.throwIfAborted();
      return hold(reason);
    }

    const after = await candidateHold();
    if (after) return hold(after);
    authorize(actor, projectId, 'read');
    if (rule.validUntil <= Date.now()) return hold('RULE_STALE');
    if (evidence.expiresAt <= Date.now()) return hold('EXECUTION_STALE');
    return nativeFrozenClone({status:evidence.status, subjectDigest, evidence, evidenceDigest:digest(evidence), expiresAt:evidence.expiresAt});
  }
  return Object.freeze({inspect});
}
