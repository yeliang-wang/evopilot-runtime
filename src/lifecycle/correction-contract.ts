import { canonical, exact, record, reject, string } from '../server/errors.js';
import { valueDigest } from './base.js';

/** Additive contracts only. These states are not lifecycle StageState values. */
export const EVIDENCE_INPUT_KINDS = ['source','test','assertion','generated','build','lock','toolchain','config','environment','collector','fixture','prestate','policy','ttl'] as const;
export type EvidenceInputKind = typeof EVIDENCE_INPUT_KINDS[number];
export type RawEvidenceOutcome = 'PASS'|'FAIL'|'NOT_RUN'|'CANCELLED'|'UNKNOWN'|'SKIPPED';
export interface EvidenceScope { workspaceId:string; projectId:string; acceptanceScopeDigest:string; }
export interface EvidenceInputManifest {
  schema:'runtime-evidence-input-manifest/v1'; candidateDigest:string;
  completeness:'COMPLETE'|'INCOMPLETE'|'UNKNOWN'; dynamicInputs:'RESOLVED'|'UNKNOWN'; externalInputs:'RESOLVED'|'UNKNOWN';
  roots:string[];
  nodes:{id:string;kind:EvidenceInputKind;digest:string;dependsOn:string[]}[];
  /** Absence needs an explicit reason and independent owner verification. */
  notApplicable:{kind:EvidenceInputKind;reason:string}[];
}
export interface OriginalEvidenceExecution {
  schema:'runtime-original-evidence-execution/v1'; mode:'EXECUTED';
  scope:EvidenceScope; caseId:string; runId:string; candidateDigest:string;
  inputManifestDigest:string; rawReceiptDigest:string; outcome:RawEvidenceOutcome;
  executedAt:string; expiresAt:string;
}
export interface EvidenceHistoryEntry {
  executionDigest:string; candidateDigest:string; rawReceiptDigest:string;
  outcome:RawEvidenceOutcome; executedAt:string;
}
export interface QualificationInput {
  schema:'runtime-evidence-qualification-input/v1'; scope:EvidenceScope; caseId:string;
  currentCandidateDigest:string; original:OriginalEvidenceExecution; originalExecutionDigest:string;
  /** Exact retained receipt text, not a parsed/re-serialized or rewritten receipt. */
  rawReceipt:string; originalInputs:EvidenceInputManifest; currentInputs:EvidenceInputManifest;
  history:EvidenceHistoryEntry[];
  /** Owner must also enforce its fixed mandatory set; callers cannot waive it. */
  executionRule:'MUST_EXECUTE'|'OWNER_POLICY';
}
export interface HarnessQualificationAssessment {
  schema:'runtime-harness-qualification-assessment/v1'; owner:'harness'; subjectDigest:string;
  policy:{id:string;version:string;digest:string;publishedReceiptRef:string};
  assessmentReceiptRef:string; trustRevision:string; assessedAt:string; expiresAt:string;
  verdict:'PASS'|'FAIL'|'UNKNOWN'; executionRequirement:'MUST_EXECUTE'|'REUSE_PERMITTED';
}
/** Read-only verifier installed by the service operator, never deserialized from
 * API/YAML data. It inspects separately authorized durable native assessments;
 * this bounded lookup must not dispatch validation, collection or repair work.
 * The adapter must authenticate the immutable original execution and raw receipt,
 * complete current history and direct/transitive input declarations, publication,
 * current trust/revocation, scope, TTL and fixed mandatory execution policy.
 * Returning an assessment asserts those independent checks were performed. No
 * existing Harness release is claimed to implement this additive contract. */
export interface TrustedQualificationVerifier {
  verify(subject:Readonly<QualificationInput>, subjectDigest:string, signal:AbortSignal):Promise<HarnessQualificationAssessment|null>;
}
export interface EvidenceQualification {
  schema:'runtime-evidence-qualification/v1'; caseId:string; scope:EvidenceScope;
  subjectDigest:string; currentCandidateDigest:string; originalExecutionDigest:string;
  originalCandidateDigest:string; rawReceiptDigest:string;
  status:'QUALIFIED'|'EXECUTION_REQUIRED'; mode:'EXECUTED'|'PASS_REUSED'|null;
  reasons:string[]; fallback:'CASE'|'GROUP'|'FULL';
  assessment:HarnessQualificationAssessment|null; expiresAt:string|null;
  history:EvidenceHistoryEntry[]; hasFailureHistory:boolean;
  establishesEnvironmentState:false; executionAuthorized:false;
}

/** V2 selects protected records. It never accepts an execution, history,
 * dependency inventory, policy verdict or verifier from a public caller. */
export interface QualificationSelection {
  schema:'runtime-evidence-qualification-selection/v2'; scope:EvidenceScope;
  caseId:string; currentCandidateDigest:string; originalExecutionDigest:string;
  phase:'PRE_RELEASE'|'POST_RELEASE';
}
export interface NativeEvidenceQualification extends Omit<EvidenceQualification,'schema'> {
  schema:'runtime-evidence-qualification/v2'; phase:'PRE_RELEASE'|'POST_RELEASE';
  actionRef:string; actionDigest:string; protectedFactsDigest:string;
  originalReceiptRef:string; originalRawBytesRef:string;
  historyWatermark:string; nativeReceiptDigest:string|null; nativeReportDigest:string|null;
  releaseAuthorized:false; formalAcceptanceEligible:boolean;
}

/** Current execution is a different proof from cross-candidate applicability.
 * Only a registered original producer can retain this record; public callers
 * select its reference and never submit these fields as evidence. */
export interface TypedCurrentExecutionCapture {
  schema:'runtime-current-execution-capture/v2'; captureRef:string; captureDigest:string;
  scope:EvidenceScope; caseId:string; phase:'PRE_RELEASE'|'POST_RELEASE'; candidateDigest:string;
  mode:'EXECUTED'; outcome:'PASS'; originalExecutionDigest:string;
  originalReceiptRef:string; originalRawBytesRef:string; rawReceiptDigest:string;
  protectedFactsDigest:string; historyWatermark:string; expiresAt:string; formalAcceptanceEligible:true;
  requirement:'ALWAYS_MUST_EXECUTE'|'AFFECTED_OR_UNKNOWN_MUST_EXECUTE';
  policy:{referenceDigest:string;profileDigest:string;catalogScopeDigest:string};
  origin:{kind:'REGISTERED_CI';stageRequestId:string;stageRequestDigest:string;provider:'github'|'gitlab';runId:string;archiveDigest:string;reportDigest:string;collectorDigest:string;catalogDigest:string};
  establishesEnvironmentState:false; executionAuthorized:false; releaseAuthorized:false;
}

export interface RecoveryRoot {
  schema:'runtime-recovery-root/v1'; workspaceId:string; projectId:string;
  /** Stable owner-resolved lineage, never derived from Host, path or new request. */
  lineageId:string; originalRequestId:string; originalRequestDigest:string;
  authorityDigest:string; initialInputDigest:string; startedAt:string; deadlineAt:string;
  /** Existing exact attempt grant; no extra repair budget or maxLoops mapping. */
  maxAttempts:number;
}
export interface RecoveryFacts {
  schema:'runtime-recovery-facts/v1'; root:RecoveryRoot; rootDigest:string;
  attempts:{requestId:string;inputDigest:string;requestedAt:string}[];
  /** Actual completed repair/minimal-verification rounds. Hypotheses or repeated
   * proposal writes are not rounds; compare stable observed failure facts. */
  rounds:{beforeFactsDigest:string;afterFactsDigest:string}[];
  current:{requestId:string;phase:'RUNNING'|'UNKNOWN'|'FAILED'|'COMPLETE';failureClass:'DETERMINISTIC'|'TRANSIENT'|'UNKNOWN';authorityDigest:string};
  proposedInputDigest:string;
}
export interface RecoveryAdmission {
  schema:'runtime-recovery-admission/v1'; originalRequestId:string; rootDigest:string;
  disposition:'OBSERVE_ONLY'|'DENIED'|'ELIGIBLE'; reasons:string[]; executionAuthorized:false;
}
export type RecoveryAction = 'OBSERVE_ORIGINAL'|'CONTINUE_ORIGINAL'|'RETRY';

export function correctionDigest(value:unknown):string {
  const v=string(value,128);
  if(!/^sha256:[a-f0-9]{64}$/.test(v))reject('INVALID_CORRECTION_DIGEST','Exact sha256 content digest required');
  return v;
}
export function correctionTime(value:unknown):number {
  const v=string(value,64),time=Date.parse(v);
  if(!Number.isFinite(time))reject('INVALID_CORRECTION_TIME','Exact timestamp required');
  return time;
}
export function correctionEnum<T extends string>(value:unknown, values:readonly T[]):T {
  if(typeof value!=='string'||!values.includes(value as T))reject('INVALID_CORRECTION_ENUM','Unsupported correction contract value');
  return value as T;
}
export function immutableCorrection<T>(value:T):T {
  const freeze=(item:unknown):void=>{if(item&&typeof item==='object'){Object.freeze(item);for(const child of Object.values(item))freeze(child);}};
  const copy=JSON.parse(canonical(value)) as T;freeze(copy);return copy;
}

/** Advisory admission over independently retained owner facts. The owner must
 * load the original lineage for every request/Host/instance, atomically append
 * attempts and revalidate current execution authority before dispatch. A caller
 * supplied root/ledger is not authority. Missing integration must remain denied. */
export function evaluateRecovery(facts:RecoveryFacts, action:RecoveryAction, now=Date.now()):RecoveryAdmission {
  exact(record(facts),['schema','root','rootDigest','attempts','rounds','current','proposedInputDigest']);
  if(facts.schema!=='runtime-recovery-facts/v1')reject('UNSUPPORTED_RECOVERY_SCHEMA','Unsupported recovery facts schema');
  correctionEnum(action,['OBSERVE_ORIGINAL','CONTINUE_ORIGINAL','RETRY']);
  const r=facts.root;
  exact(record(r),['schema','workspaceId','projectId','lineageId','originalRequestId','originalRequestDigest','authorityDigest','initialInputDigest','startedAt','deadlineAt','maxAttempts']);
  if(r.schema!=='runtime-recovery-root/v1')reject('UNSUPPORTED_RECOVERY_SCHEMA','Unsupported recovery root schema');
  for(const v of [r.workspaceId,r.projectId,r.lineageId,r.originalRequestId])string(v,512);
  for(const v of [r.originalRequestDigest,r.authorityDigest,r.initialInputDigest,facts.rootDigest,facts.proposedInputDigest])correctionDigest(v);
  const start=correctionTime(r.startedAt),deadline=correctionTime(r.deadlineAt);
  if(!Number.isFinite(now)||deadline<=start||!Number.isSafeInteger(r.maxAttempts)||r.maxAttempts<1||valueDigest(r)!==facts.rootDigest)reject('INVALID_RECOVERY_ROOT','Original recovery root or grant bounds are invalid');
  if(!Array.isArray(facts.attempts)||!facts.attempts.length||facts.attempts.length>4096||!Array.isArray(facts.rounds)||facts.rounds.length>4096)reject('INVALID_RECOVERY_HISTORY','Complete bounded original recovery history required');
  const seen=new Set<string>();let last=start;
  for(const attempt of facts.attempts){
    exact(record(attempt),['requestId','inputDigest','requestedAt']);string(attempt.requestId,512);correctionDigest(attempt.inputDigest);
    const at=correctionTime(attempt.requestedAt);
    if(seen.has(attempt.requestId)||at<last||at>now||at>=deadline)reject('INVALID_RECOVERY_HISTORY','Attempt history is duplicated, unordered or outside the original deadline');
    last=at;seen.add(attempt.requestId);
  }
  if(facts.attempts[0].requestId!==r.originalRequestId||facts.attempts[0].inputDigest!==r.initialInputDigest||facts.attempts[0].requestedAt!==r.startedAt)reject('INVALID_RECOVERY_HISTORY','Attempt history must begin at the exact original request');
  for(const round of facts.rounds){exact(record(round),['beforeFactsDigest','afterFactsDigest']);correctionDigest(round.beforeFactsDigest);correctionDigest(round.afterFactsDigest);}
  const c=facts.current;exact(record(c),['requestId','phase','failureClass','authorityDigest']);
  correctionEnum(c.phase,['RUNNING','UNKNOWN','FAILED','COMPLETE']);correctionEnum(c.failureClass,['DETERMINISTIC','TRANSIENT','UNKNOWN']);correctionDigest(c.authorityDigest);
  if(c.requestId!==facts.attempts.at(-1)!.requestId)reject('INVALID_RECOVERY_HISTORY','Current result must belong to the last retained request');
  const reasons:string[]=[];
  if(c.authorityDigest!==r.authorityDigest)reasons.push('ORIGINAL_AUTHORITY_CHANGED');
  if(now>=deadline)reasons.push('ORIGINAL_DEADLINE_EXHAUSTED');
  if(c.phase==='UNKNOWN')reasons.push('RECONCILE_ORIGINAL_REQUEST');
  const result=(disposition:RecoveryAdmission['disposition']):RecoveryAdmission=>immutableCorrection({schema:'runtime-recovery-admission/v1',originalRequestId:r.originalRequestId,rootDigest:facts.rootDigest,disposition,reasons,executionAuthorized:false});
  if(action==='OBSERVE_ORIGINAL'||now>=deadline||c.phase==='UNKNOWN')return result('OBSERVE_ONLY');
  if(c.phase==='COMPLETE')reasons.push('ORIGINAL_ALREADY_COMPLETE');
  if(action==='CONTINUE_ORIGINAL'&&c.phase!=='RUNNING')reasons.push('ORIGINAL_NOT_RUNNING');
  if(action==='CONTINUE_ORIGINAL'&&facts.proposedInputDigest!==facts.attempts.at(-1)!.inputDigest)reasons.push('ORIGINAL_INPUT_CHANGED');
  if(facts.attempts.length>r.maxAttempts)reasons.push('CUMULATIVE_ATTEMPTS_EXHAUSTED');
  if(action==='RETRY'){
    if(c.phase!=='FAILED')reasons.push('ORIGINAL_NOT_FAILED');
    if(facts.attempts.length===r.maxAttempts)reasons.push('CUMULATIVE_ATTEMPTS_EXHAUSTED');
    if(c.failureClass==='UNKNOWN')reasons.push('FAILURE_CLASSIFICATION_UNKNOWN');
    if(c.failureClass==='DETERMINISTIC'&&facts.proposedInputDigest===facts.attempts.at(-1)!.inputDigest)reasons.push('UNCHANGED_DETERMINISTIC_FAILURE');
  }
  if(facts.rounds.length>=2&&facts.rounds.slice(-2).every(round=>round.beforeFactsDigest===round.afterFactsDigest))reasons.push('TWO_NO_PROGRESS_ROUNDS');
  return result(reasons.length?'DENIED':'ELIGIBLE');
}
