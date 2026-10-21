import { nativeAssertJSON, nativeExact, nativeText, nativeDigest, nativeSha256, nativeFrozenClone } from '../vendor/compatibility/v1/native.mjs';
import type { NativeScope, NativeJSON } from '../vendor/compatibility/v1/native.mjs';
import { verifyDecisionEvidence } from '../vendor/compatibility/v1/decision-evidence.mjs';
import { createFeedbackStore, feedbackScope, feedbackBounded } from '../vendor/compatibility/feedback/v1/feedback.mjs';
import type { FeedbackEnvelope, FeedbackOutbox } from '../vendor/compatibility/feedback/v1/feedback.mjs';
import { responseEqual as same, responseFail as fail, responseReference, responseRunbookPin, validateResolvedResponseRunbook, validateResponseProblem, validateResponseEvidence, validateResponseRecovery } from '../vendor/compatibility/response/v1/response.mjs';
import type { ResponseEnvelope, ResponseRuntimeProviders, RunbookPin, ResponseEvidenceRef, ResponseRunbook, ResponseProblem, ResponseRecovery, ResponseExecutionVerification } from '../vendor/compatibility/response/v1/response.mjs';
import type { OnlineEnvelope, OnlineRepairCandidate } from '../vendor/compatibility/online/v1/online.mjs';
import type { NativeRequest, NativeProject, NativeRun, CollectionRecord, NativeSourceScope, NativeOperationReceipt } from './native-types.js';
import type { Store } from './types.js';
export type * from '../vendor/compatibility/response/v1/response.mjs';

export interface ResponsePlan {
  id: string; workspaceId: string; scope: NativeScope; actor: string;
  repairId: string; repairDigest: string; problemId: string; problemDigest: string;
  runbook: RunbookPin; guidance: ResponseRunbook;
  projectId: string; projectCandidateDigest: string; sourceScope: NativeSourceScope;
  goalId: string; goalDigest: string; target: ResponseEvidenceRef; loop: ResponseEvidenceRef;
  collectionId: string; collectionReviewDigest: string; recipeDigest: string;
  parameters: Record<string, NativeJSON>; serviceId: string; environment: string;
  deploymentRevision: string; bindingId: string; preparedAt: number;
}
export interface ResponseDecision { decision: 'APPROVE' | 'REJECT'; actor: string; humanEvidenceRef: string; at: number }
export interface ResponseVerification {
  runId: string; runReviewDigest: string; runReceiptDigest: string;
  recovery: ResponseRecovery; feedbackEventId: string; feedbackDigest: string;
  validationDigest: string; verifiedAt: number; reviewDigest: string;
}
export interface ResponseRecord {
  plan: ResponsePlan; reviewDigest: string; decision: ResponseDecision | null;
  stage: 'PREPARED' | 'APPROVED' | 'REJECTED' | 'RUNNING' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'CANCEL_REQUESTED' | 'VERIFIED' | 'CLOSED';
  admission: { requestId: string; collectionRequestId: string; nativeRevision: number; at: number } | null;
  collection: { id: string; claimId: string; receiptDigest: string; stage: string; startedAt: string; endedAt: string } | null;
  verification: ResponseVerification | null;
  closure: { actor: string; humanEvidenceRef: string; reviewDigest: string; at: number } | null;
  cancellation: { actor: string; humanEvidenceRef: string; requestedAt: number; confirmedAt: number | null } | null;
  reason: string | null;
}
export const RESPONSE_RUNTIME_OPERATIONS = ['response.inspect', 'response.list', 'response.read', 'response.execution.inspect', 'response.receipt.inspect', 'response.cancel.review', 'response.prepare', 'response.decide', 'response.execute', 'response.reconcile', 'response.cancel', 'response.verify', 'response.close'] as const;
export interface ResponseRuntimeAccess {
  native(request: NativeRequest): Promise<unknown>;
  feedback(request: FeedbackEnvelope): Promise<unknown>;
  online(request: OnlineEnvelope): Promise<unknown>;
  goal(scope: NativeScope, id: string): unknown;
}

/** A durable link around the existing native collection claim; never another command executor. */
export function createResponseRuntime(store: Store, providers: ResponseRuntimeProviders, access: ResponseRuntimeAccess) {
  const records = createFeedbackStore(store, 'runtime', 5);
  let active = 0;
  const seconds = () => Math.floor(Date.now() / 1000);
  function record(scope: NativeScope, id: unknown): ResponseRecord {
    nativeText(id); const value = records.get<ResponseRecord>(scope, 'response-plan', id);
    if (!value) fail('RESPONSE_NOT_FOUND');
    if (value.reviewDigest !== nativeSha256(value.plan) || value.plan.workspaceId !== store.identity.id || !same(value.plan.scope, scope)) fail('RESPONSE_STATE');
    return value;
  }
  function scoped(value: { workspaceId: string; scope: NativeScope }, scope: NativeScope): void {
    if (value.workspaceId !== store.identity.id || !same(value.scope, scope)) fail('RESPONSE_SCOPE');
  }
  async function nativeRead<T>(scope: NativeScope, operation: 'project.inspect' | 'collection.inspect' | 'run.inspect', id: string): Promise<T> {
    return await access.native({ operation, scope, input: { id } }) as T;
  }
  async function nativeWrite<T>(scope: NativeScope, operation: 'collection.execute' | 'collection.reconcile' | 'project.validate', input: { id: string; runId?: string }, requestId: string, expectedRevision?: number): Promise<NativeOperationReceipt<T>> {
    const revision = expectedRevision ?? (await access.native({ operation: 'workspace.inspect', scope, input: {} }) as { revision: number }).revision;
    const request = { operation, scope, input, requestId, expectedRevision: revision } as NativeRequest;
    return await access.native(request) as NativeOperationReceipt<T>;
  }
  async function ownedCollection(current: ResponseRecord): Promise<CollectionRecord> {
    if (!current.admission) fail('RESPONSE_NO_CLAIM');
    let admitted: NativeOperationReceipt<CollectionRecord>;
    try { admitted = await access.native({ operation: 'receipt.inspect', scope: current.plan.scope, input: { requestId: current.admission.collectionRequestId } }) as NativeOperationReceipt<CollectionRecord>; }
    catch { fail('RESPONSE_CLAIM_UNOWNED', 'No retained native admission receipt for this response; do not adopt or cancel another claim'); }
    const expectedDigest = nativeSha256({ operation: 'collection.execute', scope: current.plan.scope, input: { id: current.plan.collectionId } });
    if (admitted.requestId !== current.admission.collectionRequestId || admitted.operation !== 'collection.execute' || admitted.requestDigest !== expectedDigest || !same(admitted.scope, current.plan.scope) || !admitted.result.claim || admitted.revision !== current.admission.nativeRevision + 1) fail('RESPONSE_CLAIM_UNOWNED');
    const collection = await nativeRead<CollectionRecord>(current.plan.scope, 'collection.inspect', current.plan.collectionId);
    if (!collection.claim || collection.claim.claimId !== admitted.result.claim.claimId || collection.reviewDigest !== current.plan.collectionReviewDigest || nativeSha256(collection.recipe) !== current.plan.recipeDigest) fail('RESPONSE_CLAIM_UNOWNED');
    return collection;
  }
  async function evidence(scope: NativeScope, reference: ResponseEvidenceRef, maxAge: number | null): Promise<void> {
    if (!providers.readResponseEvidence) fail('RESPONSE_EVIDENCE_UNAVAILABLE');
    const current = await feedbackBounded(() => providers.readResponseEvidence!({ scope, reference }));
    validateResponseEvidence(current); scoped(current, scope);
    if (!same(current.reference, reference) || current.status !== 'PASS' || (maxAge !== null && (current.observedAt > seconds() || seconds() - current.observedAt > maxAge))) fail('RESPONSE_PREREQUISITE');
  }
  async function guidance(scope: NativeScope, pin: RunbookPin): Promise<ResponseRunbook> {
    if (!providers.resolveResponseRunbook) fail('RESPONSE_RUNBOOK_UNAVAILABLE');
    const resolved = await feedbackBounded(() => providers.resolveResponseRunbook!({ scope, pin }));
    validateResolvedResponseRunbook(resolved);
    if (resolved.workspaceId !== store.identity.id || !same(resolved.pin, pin) || (resolved.scope.visibility === 'private' && !same(resolved.scope, scope)) || resolved.withdrawn || resolved.runbook.expiresAt <= seconds()) fail('RESPONSE_RUNBOOK_STALE');
    return resolved.runbook;
  }
  async function problem(scope: NativeScope, id: string): Promise<ResponseProblem> {
    if (!providers.readResponseProblem) fail('RESPONSE_PROBLEM_UNAVAILABLE');
    const result = await feedbackBounded(() => providers.readResponseProblem!({ scope, id }));
    validateResponseProblem(result); scoped(result, scope);
    if (result.id !== id) fail('RESPONSE_PROBLEM');
    return result;
  }
  async function checkPlan(plan: ResponsePlan, executing: boolean): Promise<CollectionRecord> {
    const p = await nativeRead<NativeProject>(plan.scope, 'project.inspect', plan.projectId);
    const c = await nativeRead<CollectionRecord>(plan.scope, 'collection.inspect', plan.collectionId);
    if (p.candidateDigest !== plan.projectCandidateDigest || !same(p.sourceScope, plan.sourceScope) || p.goalId !== plan.goalId || nativeSha256(access.goal(plan.scope, plan.goalId)) !== plan.goalDigest) fail('RESPONSE_PROJECT_DRIFT');
    if (c.projectId !== p.id || c.projectCandidateDigest !== p.candidateDigest || c.reviewDigest !== plan.collectionReviewDigest || nativeSha256(c.recipe) !== plan.recipeDigest || !same(c.recipe.sourceScope, plan.sourceScope) || !same(c.workspace, store.identity)) fail('RESPONSE_COLLECTION_DRIFT');
    const book = await guidance(plan.scope, plan.runbook);
    if (!same(book, plan.guidance) || book.serviceId !== plan.serviceId || book.environment !== plan.environment || book.sourceRevision !== plan.sourceScope.revision || !same(book.parameters, plan.parameters)) fail('RESPONSE_APPLICABILITY');
    const assessment = await problem(plan.scope, plan.problemId);
    if (assessment.digest !== plan.problemDigest || assessment.incidentId !== plan.repairId || assessment.serviceId !== plan.serviceId || assessment.environment !== plan.environment || assessment.deploymentRevision !== plan.deploymentRevision) fail('RESPONSE_PROBLEM_DRIFT');
    if (assessment.disposition && assessment.disposition.kind !== 'OPEN') fail('RESPONSE_PROBLEM_DISPOSITION');
    // Existing immutable campaign/loop files carry no authoritative observation time.
    // These links prove governance reference integrity, never operational permission.
    await evidence(plan.scope, plan.target, null);
    await evidence(plan.scope, plan.loop, null);
    for (const reference of book.prerequisites) await evidence(plan.scope, reference, book.maxEvidenceAgeSeconds);
    if (executing) {
      const repair = await access.online({ operation: 'online.repair.inspect', scope: plan.scope, input: { id: plan.repairId } }) as OnlineRepairCandidate;
      if (!repair || repair.digest !== plan.repairDigest || repair.bindingId !== plan.bindingId || repair.state !== 'FIRING') fail('RESPONSE_REPAIR_DRIFT');
      if (c.stage !== 'APPROVED' || c.claim || c.decision?.decision !== 'APPROVE') fail('RESPONSE_COLLECTION_NOT_READY');
      verifyDecisionEvidence(c.decision.humanEvidenceRef, { owner: 'runtime', operation: 'collection.decide', workspaceId: store.identity.id, scope: plan.scope, reviewDigest: c.reviewDigest, decision: 'APPROVE' });
    }
    return c;
  }
  function decideEvidence(scope: NativeScope, operation: string, reviewDigest: string, humanEvidenceRef: unknown, decision: 'APPROVE' | 'REJECT' = 'APPROVE'): string {
    nativeText(humanEvidenceRef);
    verifyDecisionEvidence(humanEvidenceRef, { owner: 'runtime', operation, workspaceId: store.identity.id, scope, reviewDigest, decision });
    return humanEvidenceRef;
  }
  function confirmCollection(current: ResponseRecord, c: CollectionRecord): void {
    if (!c.claim || c.projectCandidateDigest !== current.plan.projectCandidateDigest || c.reviewDigest !== current.plan.collectionReviewDigest) fail('RESPONSE_COLLECTION_DRIFT');
    if (!c.receipt) { current.stage = current.cancellation ? 'CANCEL_REQUESTED' : 'UNKNOWN'; current.reason = c.reason ?? 'COLLECTION_UNRESOLVED'; return; }
    current.collection = { id: c.id, claimId: c.claim.claimId, receiptDigest: c.receipt.digest, stage: c.stage, startedAt: c.receipt.result.startedAt, endedAt: c.receipt.result.endedAt };
    current.reason = c.reason ?? c.receipt.result.error;
    if (current.cancellation && c.receipt.result.interrupted) { current.stage = 'CANCELLED'; current.cancellation.confirmedAt = seconds(); }
    else current.stage = c.stage === 'SUCCEEDED' ? 'SUCCEEDED' : c.stage === 'FAILED' ? 'FAILED' : 'UNKNOWN';
  }
  async function verify(current: ResponseRecord, runId: string, reference: ResponseEvidenceRef, requestId: string): Promise<ResponseVerification> {
    if (!current.collection || current.collection.stage !== 'SUCCEEDED') fail('RESPONSE_ACTION_INCOMPLETE');
    const action = await ownedCollection(current);
    if (!action.claim || !action.receipt || action.claim.claimId !== current.collection.claimId || action.receipt.digest !== current.collection.receiptDigest || action.stage !== 'SUCCEEDED') fail('RESPONSE_ACTION_EVIDENCE_CHANGED');
    if (!providers.readResponseRecovery) fail('RESPONSE_RECOVERY_UNAVAILABLE');
    const recovery = await feedbackBounded(() => providers.readResponseRecovery!({ scope: current.plan.scope, reference }));
    validateResponseRecovery(recovery); scoped(recovery, current.plan.scope);
    if (!same(recovery.reference, reference) || reference.owner !== 'harness' || recovery.outcome !== 'PASS' || recovery.incidentId !== current.plan.repairId || recovery.bindingId !== current.plan.bindingId || recovery.serviceId !== current.plan.serviceId || recovery.environment !== current.plan.environment || recovery.deploymentRevision !== current.plan.deploymentRevision || recovery.faultAt > Math.floor(Date.parse(current.collection.startedAt) / 1000) || recovery.recoveryAt < Math.floor(Date.parse(current.collection.endedAt) / 1000) || recovery.recoveryAt > seconds() || seconds() - recovery.recoveryAt > current.plan.guidance.maxEvidenceAgeSeconds) fail('RESPONSE_RECOVERY_MISMATCH');
    const run = await nativeRead<NativeRun>(current.plan.scope, 'run.inspect', runId);
    if (run.plan.projectId !== current.plan.projectId || run.plan.goalId !== current.plan.goalId || run.plan.input.projectCandidateDigest !== current.plan.projectCandidateDigest || !same(run.plan.input.sourceScope, current.plan.sourceScope) || run.stage !== 'SUCCEEDED' || !run.receipt || !run.claim || !run.plan.input.collectionReceipts.length) fail('RESPONSE_VERIFICATION_RUN');
    for (const ref of run.plan.input.collectionReceipts) {
      const observation = await nativeRead<CollectionRecord>(current.plan.scope, 'collection.inspect', ref.id);
      if (ref.id === current.plan.collectionId || !observation.receipt || observation.receipt.digest !== ref.digest || observation.stage !== 'SUCCEEDED' || Date.parse(observation.receipt.result.startedAt) < Date.parse(current.collection.endedAt)) fail('RESPONSE_INDEPENDENT_COLLECTION_REQUIRED');
    }
    // Existing project validation rechecks protected raw data, owner receipts, complete criteria and exact feedback dispositions.
    const checked = await nativeWrite<{ eligible: boolean; reviewDigest: string; feedback?: { eventId: string } }>(current.plan.scope, 'project.validate', { id: current.plan.projectId, runId }, 'response-validate-' + nativeSha256(requestId).slice(7, 43));
    if (!checked.result.eligible || !checked.result.feedback) fail('RESPONSE_FEEDBACK_REQUIRED');
    const outbox = await access.feedback({ operation: 'feedback.read', scope: current.plan.scope, input: { id: checked.result.feedback.eventId } }) as FeedbackOutbox;
    if (outbox.event.runId !== runId || outbox.event.receiptDigest !== nativeSha256(run.receipt) || !outbox.dispositions.harness || !outbox.dispositions.ontology) fail('RESPONSE_FEEDBACK_REQUIRED');
    const body = { runId, runReviewDigest: run.reviewDigest, runReceiptDigest: nativeSha256(run.receipt), recovery, feedbackEventId: outbox.event.id, feedbackDigest: nativeSha256(outbox), validationDigest: checked.result.reviewDigest, verifiedAt: current.verification?.verifiedAt ?? seconds() };
    return { ...body, reviewDigest: nativeSha256({ responseReviewDigest: current.reviewDigest, ...body }) };
  }
  async function body(request: ResponseEnvelope): Promise<unknown> {
    nativeAssertJSON(request); feedbackScope(request.scope);
    const { operation, scope, input } = request;
    if (!RESPONSE_RUNTIME_OPERATIONS.includes(operation as typeof RESPONSE_RUNTIME_OPERATIONS[number])) fail('RESPONSE_OPERATION');
    const read = ['response.inspect', 'response.list', 'response.read', 'response.execution.inspect', 'response.receipt.inspect', 'response.cancel.review'].includes(operation);
    nativeExact(request, ['operation', 'scope', 'input', ...(read ? [] : ['requestId', 'expectedRevision'])]);
    store.guard();
    if (scope.visibility !== 'private') fail('RESPONSE_PRIVATE_SCOPE');
    if (operation === 'response.inspect') { nativeExact(input, []); return { ...records.inspect(scope), operations: RESPONSE_RUNTIME_OPERATIONS, effectScope: 'isolated-local', softwareRelease: false, records: records.list<ResponseRecord>(scope, 'response-plan') }; }
    if (operation === 'response.list') { nativeExact(input, []); return records.list<ResponseRecord>(scope, 'response-plan'); }
    if (operation === 'response.receipt.inspect') { nativeExact(input, ['requestId']); nativeText(input.requestId); return records.receipt(scope, input.requestId); }
    if (operation === 'response.read') { nativeExact(input, ['id']); return nativeFrozenClone(record(scope, input.id)); }
    if (operation === 'response.cancel.review') {
      nativeExact(input, ['id']); const current = record(scope, input.id);
      const subject = { responseReviewDigest: current.reviewDigest, admission: current.admission, operation: 'response.cancel' };
      return nativeFrozenClone({ id: current.plan.id, actor: current.plan.actor, stage: current.stage, subject, reviewDigest: nativeSha256(subject), effect: current.admission ? 'REQUEST_INTERRUPTION' : 'CANCEL_UNCLAIMED_PLAN', authority: false });
    }
    if (operation === 'response.execution.inspect') {
      nativeExact(input, ['id']); const current = record(scope, input.id);
      const verified = ['VERIFIED', 'CLOSED'].includes(current.stage) && !!current.verification;
      if (verified) {
        const action = await ownedCollection(current);
        const run = await nativeRead<NativeRun>(scope, 'run.inspect', current.verification!.runId);
        if (!action.receipt || action.receipt.digest !== current.collection?.receiptDigest || !run.receipt || nativeSha256(run.receipt) !== current.verification!.runReceiptDigest) fail('RESPONSE_RETAINED_EVIDENCE_CHANGED');
        for (const ref of run.plan.input.collectionReceipts) {
          const collection = await nativeRead<CollectionRecord>(scope, 'collection.inspect', ref.id);
          if (!collection.receipt || collection.receipt.digest !== ref.digest) fail('RESPONSE_RETAINED_EVIDENCE_CHANGED');
        }
        const feedback = await access.feedback({ operation: 'feedback.read', scope, input: { id: current.verification!.feedbackEventId } });
        if (nativeSha256(feedback) !== current.verification!.feedbackDigest) fail('RESPONSE_RETAINED_EVIDENCE_CHANGED');
      }
      const projection: ResponseExecutionVerification = {
        workspaceId: store.identity.id, scope,
        reference: { owner: 'runtime', id: 'response:' + current.plan.id, digest: nativeSha256({ responseReviewDigest: current.reviewDigest, verification: current.verification }) },
        problemId: current.plan.problemId, problemDigest: current.plan.problemDigest,
        serviceId: current.plan.serviceId, environment: current.plan.environment, deploymentRevision: current.plan.deploymentRevision,
        status: verified ? 'VERIFIED' : 'UNVERIFIED', recovery: verified ? current.verification!.recovery.reference : null, verifiedAt: verified ? current.verification!.verifiedAt : null,
      };
      return nativeFrozenClone(projection);
    }
    // Durable request identities are checked before external reads, so an already committed action is never replayed.
    nativeText(request.requestId);
    const retained = records.receipt(scope, request.requestId);
    if (retained) return records.mutate(request, () => fail('RESPONSE_STATE'));
    if (operation === 'response.prepare') {
      nativeExact(input, ['id', 'repairId', 'repairDigest', 'problemId', 'problemDigest', 'runbook', 'projectId', 'goalId', 'target', 'loop', 'collectionId', 'parameters', 'actor']);
      nativeText(input.id); nativeText(input.problemId); nativeText(input.projectId);
      nativeText(input.goalId); nativeText(input.collectionId); nativeText(input.actor);
      nativeDigest(input.repairId); nativeDigest(input.repairDigest); nativeDigest(input.problemDigest); responseRunbookPin(input.runbook); responseReference(input.target); responseReference(input.loop);
      if (input.target.owner !== 'workspace' || input.loop.owner !== 'workspace' || input.target.id.includes('#') || !input.loop.id.startsWith(input.target.id + '#loop=') || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.loop.id.slice(input.target.id.length + 6))) fail('RESPONSE_GOVERNANCE_REFS');
      const p = await nativeRead<NativeProject>(scope, 'project.inspect', input.projectId);
      const c = await nativeRead<CollectionRecord>(scope, 'collection.inspect', input.collectionId);
      const book = await guidance(scope, input.runbook);
      const assessment = await problem(scope, input.problemId);
      const repair = await access.online({ operation: 'online.repair.inspect', scope, input: { id: input.repairId } }) as OnlineRepairCandidate;
      if (!repair || repair.digest !== input.repairDigest || repair.workspaceId !== store.identity.id || !same(repair.scope, scope) || repair.state !== 'FIRING' || !repair.history.length) fail('RESPONSE_REPAIR_DRIFT');
      const latest = repair.history.at(-1)!;
      if (!same(input.parameters, book.parameters) || p.goalId !== input.goalId || assessment.digest !== input.problemDigest) fail('RESPONSE_APPLICABILITY');
      const plan: ResponsePlan = { id: input.id, workspaceId: store.identity.id, scope, actor: input.actor, repairId: input.repairId, repairDigest: input.repairDigest, problemId: input.problemId, problemDigest: input.problemDigest, runbook: input.runbook, guidance: book, projectId: p.id, projectCandidateDigest: p.candidateDigest, sourceScope: p.sourceScope, goalId: input.goalId, goalDigest: nativeSha256(access.goal(scope, input.goalId)), target: input.target, loop: input.loop, collectionId: c.id, collectionReviewDigest: c.reviewDigest, recipeDigest: nativeSha256(c.recipe), parameters: input.parameters as Record<string, NativeJSON>, serviceId: latest.serviceId, environment: latest.environment, deploymentRevision: latest.deploymentRevision, bindingId: repair.bindingId, preparedAt: seconds() };
      await checkPlan(plan, true);
      return records.mutate(request, () => {
        if (records.get(scope, 'response-plan', plan.id)) fail('RESPONSE_EXISTS');
        const result: ResponseRecord = { plan, reviewDigest: nativeSha256(plan), decision: null, stage: 'PREPARED', admission: null, collection: null, verification: null, closure: null, cancellation: null, reason: null };
        records.put(scope, 'response-plan', plan.id, result); return result;
      });
    }
    const current = record(scope, input.id);
    if (operation === 'response.decide') {
      nativeExact(input, ['id', 'reviewDigest', 'decision', 'humanEvidenceRef']);
      if (current.stage !== 'PREPARED' || current.reviewDigest !== input.reviewDigest || !['APPROVE', 'REJECT'].includes(input.decision as string)) fail('RESPONSE_REVIEW');
      const humanEvidenceRef = decideEvidence(scope, operation, current.reviewDigest, input.humanEvidenceRef, input.decision as 'APPROVE' | 'REJECT');
      if (input.decision === 'APPROVE') await checkPlan(current.plan, true);
      return records.mutate(request, () => { const latest = record(scope, input.id); if (latest.stage !== 'PREPARED') fail('RESPONSE_REVIEW'); latest.decision = { decision: input.decision as 'APPROVE' | 'REJECT', actor: latest.plan.actor, humanEvidenceRef, at: seconds() }; latest.stage = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED'; records.put(scope, 'response-plan', latest.plan.id, latest); return latest; });
    }
    if (operation === 'response.execute' || operation === 'response.reconcile') {
      nativeExact(input, ['id']);
      if (operation === 'response.execute' && current.admission) return records.mutate(request, () => current);
      // Pin native CAS *before* any async preflight reads. A different execution
      // cannot slip between validation and admission and be adopted by this plan.
      const nativeRevision = (await access.native({ operation: 'workspace.inspect', scope, input: {} }) as { revision: number }).revision;
      if (operation === 'response.execute') {
        if (current.stage !== 'APPROVED' || current.decision?.decision !== 'APPROVE') fail('RESPONSE_APPROVAL_REQUIRED');
        decideEvidence(scope, 'response.decide', current.reviewDigest, current.decision.humanEvidenceRef);
        await checkPlan(current.plan, true);
      } else if (!current.admission) fail('RESPONSE_NO_CLAIM');
      const admitted = records.mutate(request, () => {
        const latest = record(scope, input.id);
        if (!latest.admission) { latest.admission = { requestId: request.requestId!, collectionRequestId: 'response-collect-' + nativeSha256({ scope, id: latest.plan.id, reviewDigest: latest.reviewDigest }).slice(7, 43), nativeRevision, at: seconds() }; latest.stage = 'RUNNING'; records.put(scope, 'response-plan', latest.plan.id, latest); }
        return latest;
      });
      let collected: CollectionRecord | null = null, error: string | null = null;
      try {
        if (operation === 'response.reconcile') {
          const prior = await ownedCollection(admitted.result);
          collected = ['RUNNING', 'UNKNOWN'].includes(prior.stage) ? (await nativeWrite<CollectionRecord>(scope, 'collection.reconcile', { id: prior.id }, 'response-reconcile-' + nativeSha256(request.requestId).slice(7, 43))).result : prior;
        } else {
          await nativeWrite<CollectionRecord>(scope, 'collection.execute', { id: current.plan.collectionId }, admitted.result.admission!.collectionRequestId, admitted.result.admission!.nativeRevision);
          collected = await ownedCollection(admitted.result);
        }
      } catch (e) { error = String((e as { code?: string }).code ?? 'RESPONSE_COLLECTION_UNAVAILABLE'); }
      return records.mutate({ operation: 'response.internal-outcome', scope, input: { id: current.plan.id, admission: admitted.digest }, requestId: 'response-done-' + nativeSha256({ scope, requestId: request.requestId }).slice(7, 43), expectedRevision: records.inspect(scope).revision }, () => {
        const latest = record(scope, input.id);
        if (!['VERIFIED', 'CLOSED', 'CANCELLED'].includes(latest.stage)) {
          if (collected) confirmCollection(latest, collected); else { latest.stage = latest.cancellation ? 'CANCEL_REQUESTED' : 'UNKNOWN'; latest.reason = error; }
          records.put(scope, 'response-plan', latest.plan.id, latest);
        }
        return latest;
      });
    }
    if (operation === 'response.cancel') {
      nativeExact(input, ['id', 'reviewDigest', 'humanEvidenceRef']);
      const reviewDigest = nativeSha256({ responseReviewDigest: current.reviewDigest, admission: current.admission, operation });
      if (input.reviewDigest !== reviewDigest) fail('RESPONSE_REVIEW');
      const humanEvidenceRef = decideEvidence(scope, operation, reviewDigest, input.humanEvidenceRef);
      if (!['PREPARED', 'APPROVED', 'RUNNING', 'UNKNOWN', 'CANCEL_REQUESTED'].includes(current.stage)) fail('RESPONSE_CANCEL_STAGE');
      const c = current.admission ? await ownedCollection(current) : null;
      if (current.admission && (!c?.claim || !providers.cancelResponseCollection)) fail('RESPONSE_CANCELLATION_UNAVAILABLE');
      const admitted = records.mutate(request, () => { const latest = record(scope, input.id); latest.cancellation = { actor: latest.plan.actor, humanEvidenceRef, requestedAt: seconds(), confirmedAt: latest.admission ? null : seconds() }; latest.stage = latest.admission ? 'CANCEL_REQUESTED' : 'CANCELLED'; records.put(scope, 'response-plan', latest.plan.id, latest); return latest; });
      if (c?.claim) { const result = await feedbackBounded(() => providers.cancelResponseCollection!({ scope, collectionId: c.id, claimId: c.claim!.claimId })); if (result.requested !== true || result.claimId !== c.claim.claimId) fail('RESPONSE_CANCEL_UNCERTAIN'); }
      return admitted;
    }
    if (operation === 'response.verify') {
      nativeExact(input, ['id', 'runId', 'recovery']); nativeText(input.runId); responseReference(input.recovery);
      if (current.stage !== 'SUCCEEDED') fail('RESPONSE_ACTION_INCOMPLETE');
      const verified = await verify(current, input.runId, input.recovery, request.requestId!);
      return records.mutate(request, () => { const latest = record(scope, input.id); if (latest.stage !== 'SUCCEEDED') fail('RESPONSE_ACTION_INCOMPLETE'); latest.verification = verified; latest.stage = 'VERIFIED'; records.put(scope, 'response-plan', latest.plan.id, latest); return latest; });
    }
    if (operation === 'response.close') {
      nativeExact(input, ['id', 'reviewDigest', 'humanEvidenceRef']);
      if (current.stage !== 'VERIFIED' || !current.verification || input.reviewDigest !== current.verification.reviewDigest) fail('RESPONSE_VERIFICATION_REQUIRED');
      const humanEvidenceRef = decideEvidence(scope, operation, current.verification.reviewDigest, input.humanEvidenceRef);
      const checked = await verify(current, current.verification.runId, current.verification.recovery.reference, request.requestId!);
      if (!same(checked, current.verification)) fail('RESPONSE_VERIFICATION_DRIFT');
      return records.mutate(request, () => { const latest = record(scope, input.id); if (latest.stage !== 'VERIFIED' || !same(latest.verification, checked)) fail('RESPONSE_VERIFICATION_DRIFT'); latest.closure = { actor: latest.plan.actor, humanEvidenceRef, reviewDigest: checked.reviewDigest, at: seconds() }; latest.stage = 'CLOSED'; records.put(scope, 'response-plan', latest.plan.id, latest); return latest; });
    }
    fail('RESPONSE_OPERATION');
  }
  return { response: async (request: ResponseEnvelope): Promise<unknown> => { active++; try { return await body(request); } finally { active--; } }, assertQuiescent: () => { if (active) fail('BUSY', 'Response operation is in progress'); } };
}
