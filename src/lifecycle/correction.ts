import { canonical, exact, record, reject, string, ServiceError, evidenceValueDigest } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import { RuntimeStore, type Receipt } from '../server/store.js';
import { valueDigest } from './base.js';
import { containsInlineSecret } from './compiler.js';
import type { StageProgress, StageRequest } from './execution.js';
import { readExtensionEvidence } from '../adapters/extension-stages.js';
import { readVerificationFeedbackForRequest } from '../adapters/stage-feedback.js';

export const CORRECTION_READS = ['lifecycle.correction.inspect', 'lifecycle.correction.admission'] as const;
export const CORRECTION_WRITES = ['lifecycle.correction.propose'] as const;
interface ProposalInput {
  stageRequestId: string;
  hypothesis: string;
  minimalVerification: string;
  proposedChanges: { path: string; expectedEffect: string }[];
}
interface FailureFacts {
  originalRequestId: string; originalRequestDigest: string; instanceId: string; stageId: string;
  pinsDigest: string; inputDigest: string; planDigest: string; adapterId: string;
  adapterDigest: string; bindingDigest: string; authorityRef: string; deadlineAt: string;
  phase: StageProgress['phase']; terminal: boolean; reason: string | null;
  observationRef: string | null; observationDigest: string | null;
}
interface Proposal {
  schema: 'runtime-correction-proposal/v1'; workspaceId: string; projectId: string;
  input: ProposalInput; facts: FailureFacts; factsDigest: string;
  createdBy: { id: string; revision: number }; digest: string;
}
export interface CorrectionDependencies {
  /** Trusted execution service read, never a caller-provided evidence payload. */
  original(actor: Principal, projectId: string, stageRequestId: string): { request: StageRequest; progress: StageProgress };
  stageAdmission(actor: Principal, projectId: string, instanceId: string, stageId: string): Promise<unknown>;
  repairAdmission?(actor: Principal, projectId: string, stageRequestId: string): Promise<{
    allowed: boolean; reasons: string[]; originalRequestId: string; originalRequestDigest: string; executionAuthorized: false;
  }>;
}

function proposalInput(value: unknown): ProposalInput {
  const input = record(value);
  exact(input, ['stageRequestId', 'hypothesis', 'minimalVerification', 'proposedChanges']);
  string(input.stageRequestId); string(input.hypothesis, 4096); string(input.minimalVerification, 4096);
  if (containsInlineSecret(canonical(input))) reject('INLINE_SECRET', 'Correction records use references, not credentials');
  if (!Array.isArray(input.proposedChanges) || !input.proposedChanges.length || input.proposedChanges.length > 64) reject('INVALID_CORRECTION', 'Declare a bounded minimal change scope');
  const paths = new Set<string>();
  for (const value of input.proposedChanges) {
    const change = record(value); exact(change, ['path', 'expectedEffect']);
    const path = string(change.path, 1024); string(change.expectedEffect, 2048);
    if (path.startsWith('/') || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..') || paths.has(path)) reject('INVALID_CORRECTION', 'Use unique repository-relative change paths');
    paths.add(path);
  }
  return JSON.parse(canonical(input)) as ProposalInput;
}

/** Retaining a hypothesis cannot write execution outcomes, reset a budget or
 * authorize a repair. All original requests and receipts remain untouched. */
export function createCorrectionService(store: RuntimeStore, deps: CorrectionDependencies) {
  function facts(actor: Principal, projectId: string, id: string): FailureFacts {
    const { request: r, progress: p } = deps.original(actor, projectId, id);
    if (r.id !== id || r.workspaceId !== store.workspaceId || r.projectId !== projectId || p.requestId !== id) reject('CORRECTION_SCOPE', 'Original execution identity differs', 409);
    const { digest, ...body } = r;
    if (digest !== valueDigest(body) || r.planDigest !== valueDigest(r.plan)) reject('CORRUPT_STAGE_REQUEST', 'Original execution content changed', 503);
    exact(record(p), ['requestId','phase','terminal','handle','observation','observationRef','reason','observedAt']);
    if (!Number.isFinite(Date.parse(r.deadlineAt)) || !Number.isFinite(Date.parse(p.observedAt))) reject('CORRUPT_STAGE_REQUEST', 'Original execution time is invalid', 503);
    if (p.phase === 'DISPATCHING') {
      if (p.terminal !== false || p.observation !== null || p.observationRef !== null || p.reason !== null || p.handle !== null) reject('CORRUPT_STAGE_OBSERVATION', 'Initial progress contains unverified observation facts', 503);
    } else {
      if (!['WAITING_AGENT','CI_PENDING','CI_RUNNING','RUNNING','UNKNOWN','COMPLETE','FAILED'].includes(p.phase) || !p.observation || !p.observationRef) reject('CORRUPT_STAGE_OBSERVATION', 'Retained original observation is required', 503);
      const envelope = store.object(projectId, 'stage-observation', p.observationRef);
      if (!envelope) reject('CORRUPT_STAGE_OBSERVATION', 'Original observation envelope is missing', 503);
      const e = record(envelope); exact(e, ['schema','requestId','observation','reason','observedAt']);
      if (e.schema !== 'runtime-stage-observation/v1' || e.requestId !== r.id || valueDigest(e) !== p.observationRef || canonical(e.observation) !== canonical(p.observation) || e.reason !== p.reason || e.observedAt !== p.observedAt || p.observation.phase !== p.phase || canonical(p.handle) !== canonical(p.observation.handle) || p.terminal !== ['COMPLETE','FAILED'].includes(p.phase)) reject('CORRUPT_STAGE_OBSERVATION', 'Mutable progress differs from immutable original observation', 503);
      const outcome = p.observation.outcome;
      if (outcome.requestId !== r.id || outcome.inputDigest !== r.inputDigest || outcome.status !== (p.phase === 'COMPLETE' ? 'COMPLETE' : p.phase === 'FAILED' ? 'FAILED' : p.phase === 'UNKNOWN' ? 'UNKNOWN' : 'RUNNING')) reject('CORRUPT_STAGE_OBSERVATION', 'Original phase and outcome differ', 503);
    }
    if (p.observation && (p.observation.requestId !== id || p.observation.inputDigest !== r.inputDigest || p.observation.adapterDigest !== r.plan.adapterDigest)) reject('CORRUPT_STAGE_REQUEST', 'Original observation identity differs', 503);
    return { originalRequestId: id, originalRequestDigest: digest, instanceId: r.instanceId, stageId: r.stageId,
      pinsDigest: r.pinsDigest, inputDigest: r.inputDigest, planDigest: r.planDigest, adapterId: r.plan.adapterId,
      adapterDigest: r.plan.adapterDigest, bindingDigest: r.plan.bindingDigest, authorityRef: r.authorityRef,
      deadlineAt: r.deadlineAt, phase: p.phase, terminal: p.terminal, reason: p.reason,
      observationRef: p.observationRef, observationDigest: p.observation ? valueDigest(p.observation) : null };
  }
  /** Existing fixed readers authenticate original-stage records only. They do
   * not discover a repair round, classify a failure or certify input closure. */
  function originalNativeEvidence(actor: Principal, projectId: string, id: string) {
    const { request: r, progress: p } = deps.original(actor, projectId, id);
    const base = { originalRequestId: r.id, originalRequestDigest: r.digest,
      purpose: 'ORIGINAL_STAGE_VALIDATION' as const, repairProof: false as const,
      missingRepairBindings: ['FAILURE_BOUND_MINIMAL_VERIFICATION', 'COMPLETE_BEFORE_AFTER_INPUT_CLOSURE',
        'PUBLISHED_FAILURE_CLASSIFICATION', 'COMPLETE_CUMULATIVE_REPAIR_ROUNDS'] };
    const summarize = (owner: string, receipt: unknown) => {
      const raw = record(receipt), report = record(raw.result ?? {}), counts: Record<string, number> = {};
      // Preserve native FAIL/ERROR/UNKNOWN/SKIPPED separately. No status is
      // reinterpreted as deterministic, transient, repaired or current PASS.
      if (Array.isArray(report.criteria)) for (const value of report.criteria) {
        const status = string(record(value).status); counts[status] = (counts[status] ?? 0) + 1;
      }
      return { owner, nativeRequestId: raw.requestId, receiptDigest: evidenceValueDigest(raw),
        reportDigest: report.reportDigest ?? null, receiptStatus: raw.status ?? null,
        executionStatus: report.executionStatus ?? null, qualityStatus: report.qualityStatus ?? report.status ?? null,
        criterionStatuses: counts };
    };
    try {
      if (r.plan.adapterId === 'runtime-native-extension-stage-v1') {
        const original = readExtensionEvidence(store, r);
        if (!original.evidence || !original.action || !original.receipt) return { ...base, status: 'UNAVAILABLE', reason: 'ORIGINAL_NATIVE_EVIDENCE_MISSING' };
        const evidence = record(original.evidence), result = record(evidence.result);
        if (evidence.receiptTerminal !== true || !p.terminal) return { ...base, status: 'UNAVAILABLE', reason: 'ORIGINAL_NATIVE_RESULT_NOT_TERMINAL' };
        const phase = result.status === 'PASS' ? 'COMPLETE' : result.status === 'FAIL' ? 'FAILED' : null;
        if (!phase || p.phase !== phase || p.observation?.outcome.receiptRef !== 'runtime:extension/' + r.id ||
          !p.observation.outcome.checks.length || p.observation.outcome.checks.some(c => c.evidenceRef !== original.evidenceRef || c.status !== (phase === 'COMPLETE' ? 'PASS' : 'FAIL')))
          reject('CORRECTION_NATIVE_EVIDENCE_MISMATCH', 'Original stage outcome does not reference this native result', 503);
        return { ...base, status: 'AVAILABLE', evidence: { kind: 'extension-evidence', id: original.evidenceRef },
          owners: [summarize(string(record(r.plan.parameters).kind), original.receipt)] };
      }
      if (r.plan.adapterId === 'runtime-ci-owner-stage-v2' && r.stageId === 'verification') {
        const event = readVerificationFeedbackForRequest(store, actor, r);
        return { ...base, status: 'AVAILABLE', evidence: { kind: 'stage-feedback-source', id: event.id },
          owners: (['ontology', 'harness'] as const).map(owner => summarize(owner, event.results[owner])) };
      }
      return { ...base, status: 'UNAVAILABLE', reason: 'ORIGINAL_NATIVE_READER_UNAVAILABLE' };
    } catch (error) {
      return { ...base, status: 'UNAVAILABLE', reason: error instanceof ServiceError ? error.code : 'ORIGINAL_NATIVE_EVIDENCE_UNKNOWN' };
    }
  }
  function retained(projectId: string, ref: unknown): Proposal {
    const id = string(ref, 128);
    if (!/^correction:sha256:[a-f0-9]{64}$/.test(id)) reject('INVALID_CORRECTION', 'Use an exact retained correction reference');
    const raw = store.object(projectId, 'lifecycle-correction-proposal', id);
    if (!raw) reject('NOT_FOUND', 'Correction not found in this project', 404);
    const p = record(raw); exact(p, ['schema','workspaceId','projectId','input','facts','factsDigest','createdBy','digest']);
    const { digest, ...body } = p;
    if (p.schema !== 'runtime-correction-proposal/v1' || p.workspaceId !== store.workspaceId || p.projectId !== projectId || digest !== valueDigest(body) || id !== 'correction:' + digest || p.factsDigest !== valueDigest(p.facts)) reject('CORRUPT_CORRECTION', 'Retained correction changed', 503);
    proposalInput(p.input);
    return JSON.parse(canonical(p)) as Proposal;
  }
  async function read(actor: Principal, projectId: string, operation: string, input: Record<string, unknown>): Promise<unknown> {
    authorize(actor, projectId, 'read');
    if (!CORRECTION_READS.includes(operation as typeof CORRECTION_READS[number])) reject('UNKNOWN_OPERATION', 'Unsupported correction read', 404);
    exact(input, ['stageRequestId'], ['correctionRef']);
    const current = facts(actor, projectId, string(input.stageRequestId));
    const proposal = input.correctionRef === undefined ? null : retained(projectId, input.correctionRef);
    if (proposal && proposal.input.stageRequestId !== current.originalRequestId) reject('CORRECTION_SCOPE', 'Correction belongs to a different original request', 409);
    const nativeEvidence = originalNativeEvidence(actor, projectId, current.originalRequestId);
    if (nativeEvidence.originalRequestDigest !== current.originalRequestDigest || nativeEvidence.originalRequestId !== current.originalRequestId) reject('CORRECTION_FACTS_CHANGED', 'Original request changed during protected evidence readback', 409);
    const response = { facts: current, nativeEvidence, proposal, proposalCurrent: proposal ? proposal.factsDigest === valueDigest(current) : null,
      projectRevision: store.revision(projectId), executionAuthorized: false, releaseAuthorized: false, automaticRedispatch: false };
    if (operation === 'lifecycle.correction.inspect') return response;
    authorize(actor, projectId, 'execution.request');
    const reasons: string[] = [];
    if (current.phase === 'UNKNOWN' || !current.terminal) reasons.push('RECONCILE_ORIGINAL_REQUEST');
    else if (current.phase === 'COMPLETE') reasons.push('STAGE_ALREADY_COMPLETE');
    if (Date.parse(current.deadlineAt) <= Date.now()) reasons.push('ORIGINAL_DEADLINE_EXHAUSTED');
    if (!proposal) reasons.push('CORRECTION_PROPOSAL_REQUIRED');
    else if (!response.proposalCurrent) reasons.push('CORRECTION_FACTS_CHANGED');
    // A preview never grants execution. The ordinary request path independently
    // repeats the trusted preparation, repair, authority and atomic budget checks.
    let repairAdmission: Awaited<ReturnType<NonNullable<CorrectionDependencies['repairAdmission']>>> | null = null;
    if (!reasons.length && deps.repairAdmission) {
      repairAdmission = await deps.repairAdmission(actor, projectId, current.originalRequestId);
      if (repairAdmission.originalRequestId !== current.originalRequestId || repairAdmission.originalRequestDigest !== current.originalRequestDigest || repairAdmission.executionAuthorized !== false) reject('CORRECTION_SCOPE', 'Repair preview belongs to another original request', 409);
      if (!repairAdmission.allowed) reasons.push(...repairAdmission.reasons);
      if (valueDigest(facts(actor, projectId, current.originalRequestId)) !== valueDigest(current)) reasons.push('CORRECTION_FACTS_CHANGED');
      if (Date.parse(current.deadlineAt) <= Date.now()) reasons.push('ORIGINAL_DEADLINE_EXHAUSTED');
    } else if (!deps.repairAdmission) reasons.push('VERIFIED_REPAIR_ADMISSION_REQUIRED');
    const allowed = reasons.length === 0 && repairAdmission?.allowed === true;
    const nextAction = current.phase === 'UNKNOWN' || !current.terminal ? 'RECONCILE_ORIGINAL_REQUEST'
      : current.phase === 'COMPLETE' ? 'STAGE_ALREADY_COMPLETE'
      : Date.parse(current.deadlineAt) <= Date.now() ? 'INSPECT_ORIGINAL_EVIDENCE'
      : allowed ? 'REQUEST_GOVERNED_STAGE' : 'VERIFY_MINIMAL_REPAIR';
    const stageAdmission = !deps.repairAdmission && nextAction === 'VERIFY_MINIMAL_REPAIR'
      ? await deps.stageAdmission(actor, projectId, current.instanceId, current.stageId) : null;
    return { ...response, allowed, reasons, stageAdmission, repairAdmission, nextAction };
  }
  function write(actor: Principal, projectId: string, operation: string, input: Record<string, unknown>, requestId: string, expectedRevision: number, reauthorize: () => Principal): Receipt {
    authorize(actor, projectId, 'draft.write');
    if (operation !== 'lifecycle.correction.propose') reject('UNKNOWN_OPERATION', 'Unsupported correction mutation', 404);
    const mutation = { projectId, operation, requestId, expectedRevision, input, permission: 'draft.write' as const };
    if (store.findReceipt(actor, projectId, requestId)) return store.mutate(actor, mutation, () => { throw Error('Unreachable replay'); }, reauthorize);
    const data = proposalInput(input);
    return store.mutate(actor, mutation, () => {
      const observed = facts(actor, projectId, data.stageRequestId);
      const body = { schema: 'runtime-correction-proposal/v1' as const, workspaceId: store.workspaceId, projectId,
        input: data, facts: observed, factsDigest: valueDigest(observed), createdBy: { id: actor.id, revision: actor.revision } };
      const proposal: Proposal = { ...body, digest: valueDigest(body) }, correctionRef = 'correction:' + proposal.digest;
      return { objects: [{ kind: 'lifecycle-correction-proposal', id: correctionRef, value: proposal }],
        value: { correctionRef, factsDigest: proposal.factsDigest, hypothesisVerified: false, executionAuthorized: false, releaseAuthorized: false },
        event: { type: 'lifecycle-correction-proposed', data: { correctionRef, stageRequestId: data.stageRequestId, originalRequestDigest: observed.originalRequestDigest } } };
    }, reauthorize);
  }
  return { read, write };
}
