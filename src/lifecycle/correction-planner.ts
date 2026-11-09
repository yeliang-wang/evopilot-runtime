import type {DifferentialEvidenceCatalog,DifferentialEvidencePlan} from './correction-contract.js';
import { canonical, exact, record, reject, string } from '../server/errors.js';

export type CorrectionPhase = 'PRE_RELEASE' | 'POST_RELEASE';
export const CORRECTION_BINDING_KEYS = ['source', 'candidate', 'toolchain', 'fixture', 'collector', 'platform', 'permission'] as const;
export type CorrectionBindings = Record<typeof CORRECTION_BINDING_KEYS[number], string>;
export interface CorrectionCase { id: string; phase: CorrectionPhase; dependsOn: string[]; entry: string; }
export interface CorrectionPreflight {
  phase: CorrectionPhase;
  expected: CorrectionBindings;
  observed: CorrectionBindings;
  cases: CorrectionCase[];
}
export interface CorrectionPreflightResult {
  schema: 'runtime-correction-preflight/v1';
  phase: CorrectionPhase;
  ready: boolean;
  issues: { code: string; id: string }[];
  callableCaseIds: string[];
  dispatchAuthorized: false;
}
const MAX_NODES = 1024, MAX_EDGES = 8192;
function phase(value: unknown): CorrectionPhase {
  if (value !== 'PRE_RELEASE' && value !== 'POST_RELEASE') reject('CORRECTION_PHASE', 'Unsupported correction phase');
  return value;
}
function list(value: unknown, limit = MAX_NODES): unknown[] {
  if (!Array.isArray(value) || value.length > limit) reject('CORRECTION_LIMIT', 'Expected bounded array');
  return value;
}
function ids(value: unknown): string[] {
  const result = list(value).map(v => string(v, 128));
  if (new Set(result).size !== result.length) reject('CORRECTION_DUPLICATE', 'Duplicate identifiers');
  return result;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') reject('CORRECTION_INPUT', 'Expected boolean');
  return value;
}
interface GraphNode { id: string; phase: CorrectionPhase; dependsOn: string[]; }
/** Missing edges are not discarded. They block the affected closure later. */
function graph(nodes: GraphNode[]): GraphNode[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  if (byId.size !== nodes.length) reject('CORRECTION_DUPLICATE', 'Duplicate case identifiers');
  if (nodes.reduce((sum, n) => sum + n.dependsOn.length, 0) > MAX_EDGES) reject('CORRECTION_LIMIT', 'Too many dependency edges');
  const pending = new Map(nodes.map(n => [n.id, n.dependsOn.filter(id => byId.has(id)).length]));
  const children = new Map<string, string[]>();
  for (const n of nodes) for (const id of n.dependsOn) {
    if (n.phase === 'PRE_RELEASE' && byId.get(id)?.phase === 'POST_RELEASE') reject('CORRECTION_PHASE_DEPENDENCY', 'PRE cannot depend on POST output');
    const a = children.get(id) ?? []; a.push(n.id); children.set(id, a);
  }
  const queue = nodes.filter(n => pending.get(n.id) === 0).map(n => n.id), ordered: GraphNode[] = [];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]; ordered.push(byId.get(id)!);
    for (const child of children.get(id) ?? []) {
      const count = pending.get(child)! - 1; pending.set(child, count);
      if (!count) queue.push(child);
    }
  }
  if (ordered.length !== nodes.length) reject('CORRECTION_CYCLE', 'Dependency graph contains a cycle');
  return ordered;
}
function bindings(value: unknown): CorrectionBindings {
  const v = record(value); exact(v, CORRECTION_BINDING_KEYS);
  return Object.fromEntries(CORRECTION_BINDING_KEYS.map(key => [key, string(v[key], 512)])) as CorrectionBindings;
}
/** Callable entries are supplied by the trusted local collector registry. This
 * checks function presence, never executes it, and cannot prove fixture reality.
 * The caller must obtain observed bindings from actual phase-specific probes. */
export function preflightCorrection(input: unknown, entries: ReadonlyMap<string, unknown>): CorrectionPreflightResult {
  canonical(input);
  const v = record(input); exact(v, ['phase', 'expected', 'observed', 'cases']);
  const currentPhase = phase(v.phase), expected = bindings(v.expected), observed = bindings(v.observed);
  const cases = list(v.cases).map(value => {
    const c = record(value); exact(c, ['id', 'phase', 'dependsOn', 'entry']);
    return { id: string(c.id, 128), phase: phase(c.phase), dependsOn: ids(c.dependsOn), entry: string(c.entry, 256) };
  });
  if (!cases.length) reject('CORRECTION_EMPTY', 'Fixed case catalog is required');
  graph(cases);
  const issues: CorrectionPreflightResult['issues'] = [], callableCaseIds: string[] = [];
  for (const key of CORRECTION_BINDING_KEYS) if (expected[key] !== observed[key]) issues.push({ code: 'BINDING_MISMATCH', id: key });
  const byId = new Map(cases.map(c => [c.id, c]));
  // Verify the complete fixed mapping without asking PRE to produce POST evidence.
  for (const c of cases) {
    if (!entries.has(c.entry)) issues.push({ code: 'MISSING_ENTRY', id: c.id });
    else if (typeof entries.get(c.entry) !== 'function') issues.push({ code: 'UNCALLABLE_ENTRY', id: c.id });
    else if (c.phase === currentPhase) callableCaseIds.push(c.id);
    for (const id of c.dependsOn) if (!byId.has(id)) issues.push({ code: 'MISSING_DEPENDENCY', id: c.id });
  }
  return { schema: 'runtime-correction-preflight/v1', phase: currentPhase, ready: issues.length === 0, issues, callableCaseIds, dispatchAuthorized: false };
}

export type CorrectionRawStatus = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_RUN' | 'RUNNING' | 'CANCELLED' | 'SKIPPED';
export interface CorrectionBranch extends GraphNode {
  status: CorrectionRawStatus;
  authorized: boolean;
  originalRequestId: string | null;
}
export type CorrectionInvalidationKind = 'CANDIDATE' | 'SHARED_ENVIRONMENT' | 'AUTHORITY' | 'BUDGET';
export interface CorrectionBranchInput {
  phase: CorrectionPhase;
  nodes: CorrectionBranch[];
  /** Each ordered group is one indivisible stateful unit; no overlapping groups. */
  serialGroups: string[][];
  /** null affects all branches; explicit ids propagate through groups/descendants. */
  invalidations: { kind: CorrectionInvalidationKind; nodeIds: string[] | null }[];
}
export interface CorrectionBranchDecision {
  id: string;
  rawStatus: CorrectionRawStatus;
  action: 'READY' | 'WAITING' | 'BLOCKED' | 'OBSERVE_ONLY' | 'RETAIN';
  reasons: string[];
  originalRequestId: string | null;
}
export interface CorrectionBranchPlan {
  schema: 'runtime-correction-branch-plan/v1';
  phase: CorrectionPhase;
  decisions: CorrectionBranchDecision[];
  readyUnits: string[][];
  requiredFailures: string[];
  dispatchAuthorized: false;
}
/** Deterministic advice for existing request/reconcile/advance paths. READY is
 * neither dispatch nor authority. The caller supplies current authority/budget
 * invalidations and must recheck them transactionally before any execution. */
export function planCorrectionBranches(input: unknown): CorrectionBranchPlan {
  canonical(input);
  const v = record(input); exact(v, ['phase', 'nodes', 'serialGroups', 'invalidations']);
  const currentPhase = phase(v.phase);
  const nodes: CorrectionBranch[] = list(v.nodes).map(value => {
    const n = record(value); exact(n, ['id', 'phase', 'dependsOn', 'status', 'authorized', 'originalRequestId']);
    const status = string(n.status) as CorrectionRawStatus;
    if (!['PASS', 'FAIL', 'UNKNOWN', 'NOT_RUN', 'RUNNING', 'CANCELLED', 'SKIPPED'].includes(status)) reject('CORRECTION_STATUS', 'Unsupported raw status');
    const originalRequestId = n.originalRequestId === null ? null : string(n.originalRequestId, 256);
    if ((status === 'UNKNOWN' || status === 'RUNNING') && !originalRequestId) reject('CORRECTION_REQUEST', 'Uncertain or running execution must retain its original request');
    return { id: string(n.id, 128), phase: phase(n.phase), dependsOn: ids(n.dependsOn), status, authorized: bool(n.authorized), originalRequestId };
  });
  if (!nodes.length) reject('CORRECTION_EMPTY', 'Validation graph is required');
  graph(nodes);
  const byId = new Map(nodes.map(n => [n.id, n])), groupFor = new Map<string, string[]>();
  const groups = list(v.serialGroups).map(value => ids(value));
  for (const group of groups) {
    if (group.length < 2) reject('CORRECTION_SERIAL', 'A serial group requires at least two cases');
    for (let i = 0; i < group.length; i++) {
      const id = group[i], n = byId.get(id);
      if (!n || groupFor.has(id) || n.phase !== byId.get(group[0])!.phase || (i > 0 && !n.dependsOn.includes(group[i - 1]))) reject('CORRECTION_SERIAL', 'Serial groups must be disjoint, same-phase dependency chains');
      groupFor.set(id, group);
    }
  }
  const stop = new Map(nodes.map(n => [n.id, new Set<string>()]));
  for (const value of list(v.invalidations, 128)) {
    const x = record(value); exact(x, ['kind', 'nodeIds']);
    const kind = string(x.kind);
    if (!['CANDIDATE', 'SHARED_ENVIRONMENT', 'AUTHORITY', 'BUDGET'].includes(kind)) reject('CORRECTION_INVALIDATION', 'Unknown invalidation');
    const affected = x.nodeIds === null ? nodes.map(n => n.id) : ids(x.nodeIds);
    if (!affected.length || affected.some(id => !byId.has(id))) reject('CORRECTION_INVALIDATION', 'Invalidation must bind known affected cases');
    for (const id of affected) stop.get(id)!.add(kind);
  }
  for (const n of nodes) {
    if (!n.authorized) stop.get(n.id)!.add('UNAUTHORIZED');
    if (n.status === 'FAIL') stop.get(n.id)!.add('FAILED');
    if (n.status === 'CANCELLED' || n.status === 'SKIPPED') stop.get(n.id)!.add(n.status);
    if (n.dependsOn.some(id => !byId.has(id))) stop.get(n.id)!.add('MISSING_DEPENDENCY');
  }
  // Monotone closure, bounded by graph size. Failed group members invalidate the
  // entire stateful unit; independent groups retain their own readiness.
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups) if (group.some(id => stop.get(id)!.size)) for (const id of group) {
      if (!stop.get(id)!.has('SERIAL_GROUP_BLOCKED')) { stop.get(id)!.add('SERIAL_GROUP_BLOCKED'); changed = true; }
    }
    for (const n of nodes) if (n.dependsOn.some(id => stop.get(id)?.size)) {
      if (!stop.get(n.id)!.has('DEPENDENCY_BLOCKED')) { stop.get(n.id)!.add('DEPENDENCY_BLOCKED'); changed = true; }
    }
  }
  const decisions: CorrectionBranchDecision[] = nodes.map(n => {
    const reasons = [...stop.get(n.id)!].sort();
    let action: CorrectionBranchDecision['action'];
    if (n.status === 'UNKNOWN' || n.status === 'RUNNING') action = 'OBSERVE_ONLY';
    else if (n.status === 'PASS' || n.status === 'FAIL') action = 'RETAIN';
    else if (reasons.length) action = 'BLOCKED';
    else if (n.phase !== currentPhase) { action = 'WAITING'; reasons.push('OTHER_PHASE'); }
    else if (n.dependsOn.some(id => byId.get(id)?.status !== 'PASS')) { action = 'WAITING'; reasons.push('DEPENDENCY_NOT_PASSED'); }
    else action = 'READY';
    return { id: n.id, rawStatus: n.status, originalRequestId: n.originalRequestId, action, reasons };
  });
  // Admission is for the full group, even though execution remains sequential.
  // All external prerequisites must pass before its first pending member starts.
  for (const group of groups) {
    const externalPending = group.some(id => byId.get(id)!.dependsOn.some(dep => !group.includes(dep) && byId.get(dep)?.status !== 'PASS'));
    const uncertain = group.some(id => ['UNKNOWN', 'RUNNING'].includes(byId.get(id)!.status));
    for (const d of decisions) if (group.includes(d.id) && d.action === 'READY' && (externalPending || uncertain)) {
      d.action = 'WAITING'; d.reasons.push(uncertain ? 'SERIAL_GROUP_OBSERVE_ONLY' : 'SERIAL_EXTERNAL_DEPENDENCY');
    }
  }
  const readyUnits: string[][] = [], included = new Set<string>();
  for (const d of decisions) if (d.action === 'READY' && !included.has(d.id)) {
    const unit = groupFor.get(d.id) ?? [d.id]; readyUnits.push([...unit]); unit.forEach(id => included.add(id));
  }
  return { schema: 'runtime-correction-branch-plan/v1', phase: currentPhase, decisions, readyUnits, requiredFailures: nodes.filter(n => n.status === 'FAIL').map(n => n.id), dispatchAuthorized: false };
}

/** Trusted composition supplies authenticated observations. This pure reducer
 * grants nothing and is not an API for importing evidence or case statuses. */
export function planDifferentialEvidence(catalog:DifferentialEvidenceCatalog,candidateDigest:string,
  executed:ReadonlySet<string>,reused:ReadonlySet<string>,refusals:ReadonlyMap<string,readonly string[]>,now=Date.now()):DifferentialEvidencePlan {
  const ids=catalog.cases.map(c=>c.caseId),known=new Set(ids);
  if(!ids.length||ids.length>709||known.size!==ids.length||[...executed,...reused,...refusals.keys()].some(id=>!known.has(id))||[...executed].some(id=>reused.has(id)))reject('DIFFERENTIAL_INVENTORY','Exact disjoint bounded catalog partition required',409);
  if(!/^sha256:[a-f0-9]{64}$/.test(candidateDigest)||!Number.isFinite(now)||Date.parse(catalog.expiresAt)<=now)reject('DIFFERENTIAL_EXPIRED','Current candidate and catalog validity required',409);
  const candidateAuthenticated=executed.size+reused.size>0,currentExecuted:string[]=[],reusable:string[]=[],requiredExecution:string[]=[],observeOriginal:DifferentialEvidencePlan['observeOriginal']=[];
  const decisions=catalog.cases.map(c=>{
    const reasons=[...(refusals.get(c.caseId)??[])],unknown=c.observeOriginalRequestIds.length>0;
    if(unknown)reasons.push('OBSERVE_ORIGINAL');
    for(const outcome of c.observedOutcomes)if(outcome!=='PASS')reasons.push('ORIGINAL_'+outcome);
    if(c.absence==='PROVEN_NATIVE_ABSENCE')reasons.push('NEW');else if(c.absence==='UNPROVEN')reasons.push('HISTORY_UNPROVEN');
    if(c.executionRequirement==='ALWAYS_MUST_EXECUTE')reasons.push('FINAL_MUST_RUN');
    let coverage:'EXECUTED'|'PASS_REUSED'|'REQUIRED'='REQUIRED';
    if(!unknown&&executed.has(c.caseId)){coverage='EXECUTED';currentExecuted.push(c.caseId);}
    else if(!unknown&&reused.has(c.caseId)&&c.executionRequirement==='AFFECTED_OR_UNKNOWN_MUST_EXECUTE'&&!c.observedOutcomes.some(v=>v!=='PASS')){coverage='PASS_REUSED';reusable.push(c.caseId);}
    else{requiredExecution.push(c.caseId);if(!reasons.length)reasons.push('CURRENT_EVIDENCE_REQUIRED');}
    if(unknown)observeOriginal.push({caseId:c.caseId,requestIds:[...c.observeOriginalRequestIds]});
    return{caseId:c.caseId,coverage,reasons:[...new Set(reasons)].sort(),originalRequestIds:[...c.originalRequestIds],nextAction:coverage!=='REQUIRED'?'RETAIN' as const:unknown?'OBSERVE_ORIGINAL' as const:'REVIEW_EXECUTION' as const};
  });
  return{schema:'runtime-differential-execution-plan/v1',scope:catalog.scope,currentCandidateDigest:candidateDigest,candidateAuthenticated,phase:catalog.phase,status:candidateAuthenticated?'OBSERVED':'CANDIDATE_UNPROVEN',policyDigest:catalog.policyDigest,profileDigest:catalog.profileDigest,inventoryDigest:catalog.inventoryDigest,historyWatermark:catalog.historyWatermark,observedAt:new Date(now).toISOString(),expiresAt:catalog.expiresAt,required:ids.length,currentExecuted:currentExecuted.sort(),reusable:reusable.sort(),requiredExecution:requiredExecution.sort(),observeOriginal,decisions,dispatchAuthorized:false,releaseAuthorized:false,establishesEnvironmentState:false};
}
