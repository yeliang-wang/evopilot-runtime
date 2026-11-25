import { randomUUID } from 'node:crypto';
import { digest, exact, record, reject, string } from '../server/errors.js';

export interface CursorScope {
  readonly repository: string;
  readonly branch: string;
}

export interface CursorPullRequest {
  readonly url: string;
  readonly number: number;
  readonly branch: string;
}

const statuses = ['CREATING', 'RUNNING', 'WAITING_FOR_BACKGROUND_WORK', 'FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED'] as const;
type CursorRunStatus = typeof statuses[number];
type CursorSource = 'CURSOR_PROVIDER' | 'FIXTURE';

export interface CursorRunRealization {
  readonly source: CursorSource;
  readonly scopeDigest: string;
  readonly intentId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly status: CursorRunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resultDigest: string | null;
  readonly pullRequest: CursorPullRequest | null;
}

interface WorkInput {
  readonly caseId: string;
  readonly issueId: string;
  readonly requestId: string;
  readonly prompt: string;
}
type WorkKind = 'initial' | 'repair';
export type CursorWorkRequest = WorkInput & (
  | {readonly kind: 'initial'}
  | {readonly kind: 'repair'; readonly original: CursorWorkIntent; readonly prior: CursorRunRealization}
);

interface RepairSource {
  readonly source: CursorSource;
  readonly intentId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly pullRequest: CursorPullRequest;
}
type IntentMaterial = WorkInput & {
  readonly schema: 'runtime-cursor-work/v1';
  readonly scopeDigest: string;
  readonly agentId: string;
} & (
  | {readonly kind: 'initial'}
  | {readonly kind: 'repair'; readonly original: RepairSource}
);
export type CursorWorkIntent = IntentMaterial & {readonly intentId: string};

export type CursorWorkResult =
  | {readonly status: 'OBSERVED'; readonly realization: CursorRunRealization}
  | {readonly status: 'UNKNOWN'; readonly intentId: string; readonly agentId: string; readonly runId: string | null};

type CursorOperation =
  | {readonly kind: 'launch'; readonly body: LaunchBody}
  | {readonly kind: 'agent' | 'runs'; readonly agentId: string}
  | {readonly kind: 'run'; readonly agentId: string; readonly runId: string};
export interface CursorTransport {
  request(operation: CursorOperation, permit?: () => void): Promise<unknown>;
}

interface LaunchBody {
  readonly agentId: string;
  readonly name: string;
  readonly env: {readonly type: 'cloud'};
  readonly repos: readonly [{readonly url: string; readonly startingRef: string} | {readonly url: string; readonly prUrl: string}];
  readonly workOnCurrentBranch: boolean;
  readonly autoCreatePR: boolean;
  readonly prompt: {readonly text: string};
}

const endpoint = 'https://api.cursor.com/v1/agents';
const maxResponseBytes = 262144;
const sha256 = /^[0-9a-f]{64}$/;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const agentIdPattern = new RegExp('^bc-' + uuid + '$');
const runIdPattern = new RegExp('^run-' + uuid + '$');
const liveTransports = new WeakSet<CursorTransport>();
const repositoryPattern = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const dateTime = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
const workFields = ['caseId', 'issueId', 'requestId', 'prompt'] as const;
const intentFields = ['schema', 'scopeDigest', 'agentId', 'kind', 'intentId', ...workFields] as const;

function matches(pattern: RegExp, value: unknown): value is string {
  return typeof value === 'string' && pattern.test(value);
}

function branchName(value: unknown): value is string {
  return matches(/^[A-Za-z0-9_][A-Za-z0-9._/-]{0,254}$/, value) &&
    !value.includes('..') && value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock')) &&
    !value.endsWith('.') && !value.startsWith('refs/') && !/^[0-9a-fA-F]{40}$/.test(value);
}

function fixedScope(input: CursorScope): CursorScope {
  const {repository, branch} = input;
  if (!matches(repositoryPattern, repository) || repository.endsWith('.') || repository.toLowerCase().endsWith('.git') || !branchName(branch)) {
    return reject('CURSOR_SCOPE', 'Cursor requires one canonical GitHub repository and a fixed branch.');
  }
  return Object.freeze({repository, branch});
}

function pullRequestNumber(scope: CursorScope, url: unknown): number | null {
  if (typeof url !== 'string' || !url.startsWith(scope.repository + '/pull/')) return null;
  const number = url.slice(scope.repository.length + '/pull/'.length);
  if (!/^[1-9][0-9]{0,15}$/.test(number) || !Number.isSafeInteger(Number(number))) return null;
  return Number(number);
}

function validateWorkInput(input: WorkInput): WorkInput {
  const {caseId, issueId, requestId, prompt} = input;
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 32768 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u.test(prompt)) {
    return reject('CURSOR_PROMPT', 'Cursor requires bounded authorized task text.');
  }
  return {caseId: string(caseId), issueId: string(issueId), requestId: string(requestId), prompt};
}

function checkRepairSource(original: RepairSource, scope: CursorScope) {
  exact(record(original), ['source', 'intentId', 'agentId', 'runId', 'pullRequest']);
  const pr = original.pullRequest;
  exact(record(pr), ['url', 'number', 'branch']);
  const number = pullRequestNumber(scope, pr.url);
  if (!['CURSOR_PROVIDER', 'FIXTURE'].includes(original.source) || !matches(sha256, original.intentId) ||
      !matches(agentIdPattern, original.agentId) || !matches(runIdPattern, original.runId) ||
      number === null || number !== pr.number || !branchName(pr.branch) || pr.branch === scope.branch) {
    reject('CURSOR_ORIGINAL_PR', 'Repair requires the original realized run and scoped pull request.', 409);
  }
}

function checkIntent(intent: CursorWorkIntent, scope: CursorScope) {
  exact(record(intent), intent.kind === 'repair' ? [...intentFields, 'original'] : intentFields);
  const {intentId, ...material} = intent;
  validateWorkInput(intent);
  if (intent.kind !== 'initial' && intent.kind !== 'repair' || intent.schema !== 'runtime-cursor-work/v1' ||
      intent.scopeDigest !== digest(scope) || !matches(agentIdPattern, intent.agentId) || intentId !== digest(material)) {
    reject('CURSOR_INTENT_MISMATCH', 'Cursor requires the exact retained intent in its original scope.', 409);
  }
  if (intent.kind === 'repair') {
    checkRepairSource(intent.original, scope);
    if (intent.original.agentId === intent.agentId) {
      reject('CURSOR_INTENT_MISMATCH', 'Cursor repair requires its own reserved Agent identity.', 409);
    }
  }
}

/** Retain the original intent before the single external mutation. */
export function prepareCursorWorkIntent(scope: CursorScope, input: CursorWorkRequest): CursorWorkIntent {
  const fixed = fixedScope(scope);
  const source = record(input);
  exact(source, input.kind === 'repair' ? [...workFields, 'kind', 'original', 'prior'] : [...workFields, 'kind']);
  const material = {
    schema: 'runtime-cursor-work/v1' as const, scopeDigest: digest(fixed), ...validateWorkInput(input),
    agentId: 'bc-' + randomUUID(),
  };
  if (input.kind === 'initial') {
    const initial = {...material, kind: input.kind};
    return {...initial, intentId: digest(initial)};
  }
  if (input.kind !== 'repair') return reject('CURSOR_WORK_KIND', 'Cursor requires initial or repair work.');
  const {original, prior} = input;
  checkIntent(original, fixed);
  if (original.kind !== 'initial' || original.caseId !== material.caseId || original.issueId !== material.issueId ||
      original.requestId === material.requestId || prior.status !== 'FINISHED' || !prior.pullRequest ||
      prior.intentId !== original.intentId || prior.agentId !== original.agentId || prior.scopeDigest !== material.scopeDigest) {
    return reject('CURSOR_ORIGINAL_PR', 'Repair requires the finished original run of this case and issue.', 409);
  }
  const retained = {
    source: prior.source, agentId: prior.agentId, runId: prior.runId, intentId: prior.intentId,
    pullRequest: {...prior.pullRequest},
  };
  checkRepairSource(retained, fixed);
  const repair = {...material, kind: input.kind, original: retained};
  return {...repair, intentId: digest(repair)};
}

function launchBody(scope: CursorScope, intent: CursorWorkIntent): LaunchBody {
  const repair = intent.kind === 'repair';
  return {
    agentId: intent.agentId, name: 'evopilot-' + intent.intentId, env: {type: 'cloud'},
    repos: [repair ? {url: scope.repository, prUrl: intent.original.pullRequest.url} :
      {url: scope.repository, startingRef: scope.branch}],
    workOnCurrentBranch: repair, autoCreatePR: !repair, prompt: {text: intent.prompt},
  };
}

function operationUrl(operation: CursorOperation): string {
  if (!matches(agentIdPattern, operation.kind === 'launch' ? operation.body.agentId : operation.agentId)) {
    return reject('CURSOR_PROVIDER_ID', 'Cursor requires a scoped Agent identity.');
  }
  if (operation.kind === 'launch') return endpoint;
  const agent = endpoint + '/' + operation.agentId;
  if (operation.kind === 'agent') return agent;
  if (operation.kind === 'runs') return agent + '/runs?limit=2';
  if (operation.kind !== 'run' || !matches(runIdPattern, operation.runId)) {
    return reject('CURSOR_PROVIDER_ID', 'Cursor requires a scoped Run identity.');
  }
  return agent + '/runs/' + operation.runId;
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    return reject('CURSOR_PROVIDER_UNAVAILABLE', 'Cursor returned no successful HTTP response.', 503);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxResponseBytes) {
        await reader.cancel().catch(() => {});
        return reject('CURSOR_PROVIDER_UNAVAILABLE', 'Cursor response exceeds the bounded profile.', 503);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const json = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks, bytes));
  return JSON.parse(json) as unknown;
}

/** Resolve only the protected server-side credential reference. */
export function createCursorProviderTransport(
  credentialRef: string,
  resolveCredential: (reference: string) => Promise<string> | string,
): CursorTransport {
  if (!matches(/^(?:credential|secret|binding):[a-z0-9][a-z0-9._/-]{0,187}$/, credentialRef)) {
    reject('CURSOR_CREDENTIAL_REFERENCE', 'Use a protected Cursor credential reference.');
  }
  const transport: CursorTransport = {
    async request(operation, permit) {
      const url = operationUrl(operation);
      const key = await resolveCredential(credentialRef);
      if (!matches(/^[\x21-\x7e]{1,4096}$/, key)) {
        return reject('CURSOR_CREDENTIAL_UNAVAILABLE', 'The protected Cursor credential is unavailable.', 503);
      }
      const write = operation.kind === 'launch';
      if (write) {
        if (!permit) return reject('CURSOR_AUTHORITY_REQUIRED', 'Live launch requires the original Runtime reservation.', 409);
        permit();
      }
      const headers = {Authorization: 'Bearer ' + key, Accept: 'application/json'};
      const request = write ?
        {method: 'POST', headers: {...headers, 'Content-Type': 'application/json'}, body: JSON.stringify(operation.body)} :
        {method: 'GET', headers};
      return readResponse(await fetch(url, {...request, redirect: 'error', signal: AbortSignal.timeout(10_000)}));
    },
  };
  liveTransports.add(transport);
  return Object.freeze(transport);
}

function observedAgent(value: unknown, request: LaunchBody): string {
  const agent = record(value);
  const env = record(agent.env);
  if (agent.id !== request.agentId || agent.name !== request.name || env.type !== 'cloud' || env.name !== undefined ||
      !['ACTIVE', 'IDLE'].includes(agent.status as string) ||
      agent.workOnCurrentBranch !== request.workOnCurrentBranch || agent.autoCreatePR !== request.autoCreatePR ||
      !Array.isArray(agent.repos) || agent.repos.length !== 1 || !matches(runIdPattern, agent.latestRunId)) {
    return reject('CURSOR_AGENT_MISMATCH', 'Cursor did not confirm the original Agent, repository and launch settings.', 409);
  }
  const repo = record(agent.repos[0]);
  const expected = request.repos[0];
  const originalTarget = 'startingRef' in expected ?
    repo.startingRef === expected.startingRef && repo.prUrl === undefined :
    repo.prUrl === expected.prUrl;
  if (repo.url !== expected.url || !originalTarget) {
    return reject('CURSOR_AGENT_MISMATCH', 'Cursor did not confirm the original repository and target ref.', 409);
  }
  return agent.latestRunId;
}

function observedRun(value: unknown, agentId: string, runId: string) {
  const run = record(value);
  const {status, createdAt, updatedAt} = run;
  if (run.id !== runId || run.agentId !== agentId || !statuses.includes(status as CursorRunStatus) ||
      !matches(dateTime, createdAt) || !matches(dateTime, updatedAt) ||
      !Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt)) || Date.parse(updatedAt) < Date.parse(createdAt)) {
    return reject('CURSOR_RUN_MISMATCH', 'Cursor did not confirm the original Run identity or state.', 409);
  }
  return {status: status as CursorRunStatus, createdAt, updatedAt, result: run.result, git: run.git};
}

function observedPullRequest(scope: CursorScope, intent: CursorWorkIntent, value: unknown): CursorPullRequest | null {
  if (value === undefined) return null;
  const {branches} = record(value);
  if (Array.isArray(branches) && branches.length === 0) return null;
  if (!Array.isArray(branches) || branches.length !== 1) {
    return reject('CURSOR_PULL_REQUEST_MISMATCH', 'Cursor reported branches outside the single-repository profile.', 409);
  }
  const {repoUrl, branch, prUrl} = record(branches[0]);
  if (repoUrl !== scope.repository.slice('https://'.length) || !branchName(branch) || branch === scope.branch) {
    return reject('CURSOR_PULL_REQUEST_MISMATCH', 'Cursor did not confirm work on the scoped PR branch.', 409);
  }
  if (intent.kind === 'repair') {
    const original = intent.original.pullRequest;
    // Cursor documents git.prUrl as present when it opened a PR. The retained
    // launch target and Agent readback bind the existing PR for a repair.
    if (branch !== original.branch || (prUrl !== undefined && prUrl !== original.url)) {
      return reject('CURSOR_PULL_REQUEST_MISMATCH', 'Cursor did not confirm repair of the original PR.', 409);
    }
    return {...original};
  }
  if (prUrl === undefined) return null;
  const number = pullRequestNumber(scope, prUrl);
  if (number === null || typeof prUrl !== 'string') {
    return reject('CURSOR_PULL_REQUEST_MISMATCH', 'Cursor did not confirm a PR in the scoped repository.', 409);
  }
  return {url: prUrl, number, branch};
}

export function createCursorAgentAdapter(scope: CursorScope, transport: CursorTransport) {
  const fixed = fixedScope(scope);
  const source = liveTransports.has(transport) ? 'CURSOR_PROVIDER' : 'FIXTURE';
  const request = transport.request.bind(transport);

  function retainedIntent(value: CursorWorkIntent) {
    const intent = structuredClone(value);
    checkIntent(intent, fixed);
    if (intent.kind === 'repair' && intent.original.source !== source) {
      reject('CURSOR_PROVENANCE_MISMATCH', 'Repair requires the original adapter provenance.', 409);
    }
    return intent;
  }

  async function readBack(intent: CursorWorkIntent, expectedRunId?: string): Promise<CursorWorkResult> {
    const body = launchBody(fixed, intent);
    const {agentId, intentId, scopeDigest} = intent;
    let runId = expectedRunId ?? null;
    try {
      const latest = observedAgent(await request({kind: 'agent', agentId}), body);
      if (expectedRunId !== undefined && expectedRunId !== latest) {
        return {status: 'UNKNOWN', intentId, agentId, runId};
      }
      // Git outcomes are per Agent. Require a sole Run on this one-purpose
      // Agent before attributing its branches or PR to the exact intent.
      const history = record(await request({kind: 'runs', agentId}));
      if (!Array.isArray(history.items) || history.items.length !== 1 || history.nextCursor !== undefined) {
        return {status: 'UNKNOWN', intentId, agentId, runId};
      }
      const listed = observedRun(history.items[0], agentId, latest);
      runId = latest;
      const run = observedRun(await request({kind: 'run', agentId, runId}), agentId, runId);
      if (run.createdAt !== listed.createdAt ||
          observedAgent(await request({kind: 'agent', agentId}), body) !== runId) {
        return {status: 'UNKNOWN', intentId, agentId, runId};
      }
      const pullRequest = run.status === 'FINISHED' ? observedPullRequest(fixed, intent, run.git) : null;
      // Cursor can briefly report a finished Run before the PR is available.
      if (run.status === 'FINISHED' && !pullRequest) return {status: 'UNKNOWN', intentId, agentId, runId};
      const realization = Object.freeze({
        source, scopeDigest, intentId, agentId, runId, status: run.status, createdAt: run.createdAt,
        updatedAt: run.updatedAt, resultDigest: typeof run.result === 'string' ? digest(run.result) : null,
        pullRequest: pullRequest && Object.freeze(pullRequest),
      });
      return Object.freeze({status: 'OBSERVED', realization});
    } catch {
      return {status: 'UNKNOWN', intentId, agentId, runId};
    }
  }

  async function reconcile(retained: CursorWorkIntent, expectedRunId?: string): Promise<CursorWorkResult> {
    if (expectedRunId !== undefined && !matches(runIdPattern, expectedRunId)) {
      reject('CURSOR_PROVIDER_ID', 'Cursor requires the original retained Run identity.');
    }
    return readBack(retainedIntent(retained), expectedRunId);
  }

  /** Only the owner that just committed a new reservation may dispatch. All
   * other paths call reconcile and use only the saved Agent and Run identities. */
  async function dispatch(retained: CursorWorkIntent, reservation: 'RESERVED', permit?: () => void): Promise<CursorWorkResult> {
    if (reservation !== 'RESERVED') {
      reject('CURSOR_RECONCILE_ORIGINAL', 'Read back the original Cursor intent.', 409);
    }
    const intent = retainedIntent(retained);
    if (!permit && source === 'CURSOR_PROVIDER') {
      return reject('CURSOR_AUTHORITY_REQUIRED', 'Live launch requires the original Runtime reservation.', 409);
    }
    if (source === 'FIXTURE') permit?.();
    const body = launchBody(fixed, intent);
    let runId: string | undefined;
    let admissionError: unknown;
    let admissionDenied = false;
    try {
      const submitted = record(await request({kind: 'launch', body},permit && (() => {
        try { permit(); }
        catch (error) { admissionError = error; admissionDenied = true; throw error; }
      })));
      const latest = observedAgent(submitted.agent, body);
      observedRun(submitted.run, intent.agentId, latest);
      runId = latest;
    } catch {
      if (admissionDenied) throw admissionError;
      // Cursor supports caller-assigned Agent IDs. A lost launch response does
      // not require a retry or a newest-Agent heuristic.
    }
    return readBack(intent, runId);
  }

  return Object.freeze({dispatch, reconcile, source, scopeDigest:digest(fixed)});
}
