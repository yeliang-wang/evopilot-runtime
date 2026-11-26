import { digest, exact, record, reject, string } from '../server/errors.js';
import type { ReviewCandidate } from './review.js';
import type { FeedbackVerificationCandidate } from './verification.js';

const api = 'https://api.github.com';
const version = '2026-03-10';
const numberId = /^[1-9][0-9]{0,15}$/;
const commitId = /^[a-f0-9]{40}$/;
const operationId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export interface FeedbackGitHubBinding {
  repository: string;
  repositoryId: string;
  baseBranch: string;
  installationId: string;
  installationCredentialRef: string;
  actorId: string;
  actorLogin: string;
  allowedPaths: readonly string[];
}

/** The protected broker supplies a GitHub App installation token scoped to this repository. */
export type FeedbackGitHubTokenReader = (binding: Readonly<FeedbackGitHubBinding>, signal: AbortSignal) => Promise<string>;

export interface FeedbackGitHubMergeRequest {
  candidate: ReviewCandidate;
  requestId: string;
}

export interface FeedbackGitHubMergeObservation {
  source: 'GITHUB_PROVIDER' | 'FIXTURE';
  requestId: string;
  candidateDigest: string;
  bindingDigest: string;
  status: 'PENDING' | 'DENIED' | 'UNKNOWN' | 'MERGED';
  operationId: string | null;
  githubRequestId: string | null;
  dispatchHttpStatus: number | null;
  observedPullRequestMergeSha: string | null;
  mergeSha: string | null;
}

function providerSha(value: unknown): value is string {
  return typeof value === 'string' && value.length === 40 && commitId.test(value);
}

function providerOperation(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && operationId.test(value);
}

function unavailable(): never {
  return reject('FEEDBACK_GITHUB_UNAVAILABLE', 'GitHub did not provide a usable response for the registered repository.', 502);
}

function blocked(): never {
  return reject('FEEDBACK_GITHUB_BLOCKED', 'GitHub did not confirm the exact protected rebase candidate.', 409);
}

async function json(response: Response): Promise<unknown> {
  // The compare endpoint can include a large file diff even for a small commit range.
  const limit = 8 * 1024 * 1024;
  const reader = response.body?.getReader();
  if (!reader) return unavailable();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) {
        void reader.cancel().catch(() => {});
        return unavailable();
      }
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    return unavailable();
  } finally {
    reader.releaseLock();
  }
}

function compareStartsAt(comparison: Record<string, unknown>, base: string): boolean {
  return comparison.status === 'ahead' && comparison.behind_by === 0 &&
    record(comparison.base_commit).sha === base && record(comparison.merge_base_commit).sha === base;
}

/** Compare exact trees at each step of a complete, linear range. Rebase rewrites commit IDs. */
function linearTrees(comparison: Record<string, unknown>, base: string, tip: string): string[] {
  const commits = comparison.commits;
  if (!compareStartsAt(comparison, base) || !Array.isArray(commits) || !commits.length || commits.length > 250 ||
      comparison.ahead_by !== commits.length || comparison.total_commits !== commits.length) return blocked();
  let previous = base;
  const trees = commits.map(raw => {
    const commit = record(raw);
    const tree = record(record(commit.commit).tree).sha;
    if (!providerSha(commit.sha) || !providerSha(tree) || !Array.isArray(commit.parents) ||
        commit.parents.length !== 1 || record(commit.parents[0]).sha !== previous) return blocked();
    previous = commit.sha;
    return tree;
  });
  if (previous !== tip) return blocked();
  return trees;
}

export function createFeedbackGitHubAdapter(configured: FeedbackGitHubBinding, readInstallationToken: FeedbackGitHubTokenReader, fetcher: typeof fetch = fetch) {
  exact(record(configured), ['repository', 'repositoryId', 'baseBranch', 'installationId', 'installationCredentialRef', 'actorId', 'actorLogin','allowedPaths']);
  const paths = configured.allowedPaths;
  if (!Array.isArray(paths) || !paths.length || paths.length>100 || new Set(paths).size!==paths.length ||
      paths.some(path=>typeof path!=='string'||path.length>512||!path.split('/').every(part=>part!=='.'&&part!=='..'&&/^[a-zA-Z0-9_.-]+$/.test(part)))) {
    return reject('FEEDBACK_GITHUB_BINDING','Register the exact allowed repository paths.');
  }
  const binding = Object.freeze({...configured,allowedPaths:Object.freeze([...paths])});
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9_][a-z0-9_.-]*$/i.test(string(binding.repository, 140)) ||
      !/^[a-z0-9_][a-z0-9_./-]*$/i.test(string(binding.baseBranch, 200)) ||
      binding.baseBranch.includes('..') || binding.baseBranch.includes('//') || binding.baseBranch.endsWith('/') ||
      !/^[a-z0-9][a-z0-9-]*\[bot\]$/i.test(string(binding.actorLogin, 100)) ||
      ![binding.repositoryId, binding.installationId, binding.actorId].every(value => numberId.test(string(value, 16)))) {
    return reject('FEEDBACK_GITHUB_BINDING', 'Expected a registered GitHub repository, base branch and App installation identity.');
  }
  string(binding.installationCredentialRef);
  const bindingDigest = digest(binding);
  const source = fetcher === fetch ? 'GITHUB_PROVIDER' as const : 'FIXTURE' as const;
  const repoPath = `/repos/${binding.repository}`;
  const branch = encodeURIComponent(binding.baseBranch);
  const branchPath = `/branches/${branch}`;

  function exactCandidate(candidate: ReviewCandidate): ReviewCandidate {
    const copy = {...candidate};
    if (copy.repositoryId !== binding.repositoryId || !numberId.test(string(copy.pullRequestId, 16)) ||
        !providerSha(copy.head) || !providerSha(copy.base) || copy.head === copy.base) return blocked();
    return copy;
  }

  async function installation(signal: AbortSignal) {
    let token: string;
    try {
      token = await readInstallationToken(binding, signal);
      if (!/^[a-zA-Z0-9_.-]+$/.test(string(token, 8192))) throw new Error();
    } catch {
      return reject('FEEDBACK_GITHUB_CREDENTIAL', 'The registered GitHub App installation credential is unavailable.', 409);
    }
    async function request(path: string, body?: Record<string, unknown>): Promise<Response> {
      const headers = new Headers({
        accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
        'x-github-api-version': version, 'cache-control': 'no-cache',
      });
      if (body) headers.set('content-type', 'application/json');
      try {
        return await fetcher(api + path, {
          method: body ? 'PUT' : 'GET', headers, body: body && JSON.stringify(body), redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
      } catch {
        return unavailable();
      }
    }
    async function read(path: string): Promise<unknown> {
      const response = await request(path);
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        return unavailable();
      }
      return json(response);
    }

    // This endpoint authenticates as an App installation and reports its accessible repositories.
    const accessible = record(await read('/installation/repositories?per_page=2'));
    if (accessible.total_count !== 1 || !Array.isArray(accessible.repositories) || accessible.repositories.length !== 1 ||
        !matchesRepository(accessible.repositories[0])) return blocked();
    return {request, get: (path: string) => read(repoPath + path)};
  }

  type Installation = Awaited<ReturnType<typeof installation>>;

  function matchesRepository(value: unknown): boolean {
    const repo = record(value);
    return Number.isSafeInteger(repo.id) && String(repo.id) === binding.repositoryId &&
      typeof repo.full_name === 'string' && repo.full_name.toLowerCase() === binding.repository.toLowerCase();
  }

  async function pullRequest(access: Installation, candidate: ReviewCandidate) {
    const pull = record(await access.get(`/pulls/${candidate.pullRequestId}`));
    const head = record(pull.head);
    const base = record(pull.base);
    if (pull.number !== Number(candidate.pullRequestId) || base.ref !== binding.baseBranch ||
        !matchesRepository(base.repo) || !matchesRepository(head.repo) || head.sha !== candidate.head) return blocked();
    return {pull, base};
  }

  async function protectedBranch(access: Installation): Promise<string> {
    const current = record(await access.get(branchPath));
    const head = record(current.commit).sha;
    if (current.name !== binding.baseBranch || current.protected !== true || !providerSha(head)) return blocked();
    return head;
  }

  async function requireAllowedChanges(access: Installation,pullRequestId: string,pull: Record<string,unknown>) {
    if (!Number.isSafeInteger(pull.changed_files) || Number(pull.changed_files)<1 ||
        Number(pull.changed_files)>binding.allowedPaths.length) return blocked();
    const files=await access.get('/pulls/'+pullRequestId+'/files?per_page=100');
    if (!Array.isArray(files) || files.length!==pull.changed_files) return blocked();
    const touched=new Set<string>();
    for (const value of files) {
      const file=record(value);
      if (typeof file.filename!=='string' || touched.has(file.filename) || !binding.allowedPaths.includes(file.filename) ||
          (file.status==='renamed' && typeof file.previous_filename!=='string') ||
          (file.previous_filename!==undefined && (typeof file.previous_filename!=='string' || !binding.allowedPaths.includes(file.previous_filename)))) {
        return blocked();
      }
      touched.add(file.filename);
    }
  }

  async function preflight(access: Installation, candidate: ReviewCandidate): Promise<void> {
    const repo = record(await access.get(''));
    if (!matchesRepository(repo) || repo.archived !== false || repo.disabled !== false || repo.allow_rebase_merge !== true) return blocked();
    const protection = record(await access.get(`${branchPath}/protection`));
    const checks = record(await access.get(`${branchPath}/protection/required_status_checks`));
    const reviews = record(protection.required_pull_request_reviews);
    const bypass = reviews.bypass_pull_request_allowances;
    if (bypass != null && ['apps', 'users', 'teams'].some(key => {
      const entries = record(bypass)[key];
      return entries !== undefined && (!Array.isArray(entries) || entries.length > 0);
    })) return blocked();
    if (record(protection.enforce_admins).enabled !== true || record(protection.allow_force_pushes).enabled !== false ||
        record(protection.allow_deletions).enabled !== false || checks.strict !== true ||
        !Array.isArray(checks.contexts) || !checks.contexts.length) return blocked();
    const rules = await access.get(`/rules/branches/${branch}?per_page=100`);
    if (!Array.isArray(rules) || rules.length >= 100 || rules.some(rule => record(rule).type === 'merge_queue')) return blocked();

    linearTrees(record(await access.get(`/compare/${candidate.base}...${candidate.head}`)), candidate.base, candidate.head);
    const before = await pullRequest(access, candidate);
    await requireAllowedChanges(access,candidate.pullRequestId,before.pull);
    const {pull, base} = await pullRequest(access, candidate);
    if (base.sha !== candidate.base || pull.state !== 'open' || pull.merged !== false || pull.draft !== false ||
        pull.auto_merge !== null || pull.stack != null || pull.mergeable !== true || pull.rebaseable !== true ||
        pull.changed_files !== before.pull.changed_files || pull.mergeable_state !== 'clean' ||
        await protectedBranch(access) !== candidate.base) return blocked();
  }

  function initial(request: FeedbackGitHubMergeRequest): FeedbackGitHubMergeObservation {
    return {
      source, requestId: string(request.requestId), candidateDigest: digest(request.candidate), bindingDigest, status: 'UNKNOWN',
      operationId: null, githubRequestId: null, dispatchHttpStatus: null, observedPullRequestMergeSha: null, mergeSha: null,
    };
  }

  function pending(result: Record<string, unknown>, head: string): string | null {
    const details = record(result.details);
    // GitHub's 202 example omits bypass_rules. The request always sends false, and a contradictory echo is rejected.
    return result.status === 'pending' && providerOperation(details.uuid) && details.expected_head_sha === head &&
      details.merge_method === 'rebase' && details.merge_action === 'direct_merge' &&
      (details.bypass_rules === undefined || details.bypass_rules === false) ? details.uuid : null;
  }

  return Object.freeze({
    async readCandidate(pullRequestId: string, signal: AbortSignal): Promise<FeedbackVerificationCandidate> {
      if (!numberId.test(string(pullRequestId,16))) return blocked();
      const access = await installation(signal);
      const pull = record(await access.get('/pulls/'+pullRequestId));
      const head = record(pull.head), base = record(pull.base);
      const branch = string(head.ref,200);
      if (pull.number !== Number(pullRequestId) || pull.state !== 'open' || pull.merged !== false ||
          base.ref !== binding.baseBranch || branch === binding.baseBranch || !matchesRepository(base.repo) ||
          !matchesRepository(head.repo) || !providerSha(head.sha) || !providerSha(base.sha) || head.sha === base.sha ||
          (await protectedBranch(access)) !== base.sha) return blocked();
      await requireAllowedChanges(access,pullRequestId,pull);
      const latest=record(await access.get('/pulls/'+pullRequestId));
      if (record(latest.head).sha!==head.sha || record(latest.base).sha!==base.sha || latest.changed_files!==pull.changed_files) return blocked();
      return {source,repositoryId:binding.repositoryId,number:Number(pullRequestId),branch,head:head.sha,base:base.sha};
    },

    async inspect(input: ReviewCandidate, signal: AbortSignal) {
      const candidate = exactCandidate(input);
      await preflight(await installation(signal), candidate);
      return {candidate, bindingDigest, githubChecksPassed: true as const, baseProtected: true as const};
    },

    /** Dispatch only after the owner has persisted the original claim. Recovered claims use reconcile. */
    async dispatch(request: FeedbackGitHubMergeRequest, signal: AbortSignal, permit?: () => void): Promise<FeedbackGitHubMergeObservation> {
      const candidate = exactCandidate(request.candidate);
      let observation = initial({...request, candidate});
      const access = await installation(signal);
      await preflight(access, candidate);
      if (!permit && source === 'GITHUB_PROVIDER') return blocked();
      signal.throwIfAborted();
      permit?.();
      try {
        const response = await access.request(`${repoPath}/pulls/${candidate.pullRequestId}/merge-async`, {
          sha: candidate.head, merge_method: 'rebase', merge_action: 'direct_merge', bypass_rules: false,
        });
        const providerId = response.headers.get('x-github-request-id');
        observation = {...observation, dispatchHttpStatus: response.status,
          githubRequestId: providerId && /^[a-zA-Z0-9:_-]{1,128}$/.test(providerId) ? providerId : null};
        if (response.status === 202) {
          const original = pending(record(await json(response)), candidate.head);
          if (original) return {...observation, status: 'PENDING', operationId: original};
        } else {
          void response.body?.cancel().catch(() => {});
          if ([400, 403, 404, 422].includes(response.status)) return {...observation, status: 'DENIED'};
        }
      } catch {
        // Losing the write response cannot authorize a retry of the mutation.
      }
      return observation;
    },

    /** GET only. A PR merged by the App is insufficient evidence without the original operation UUID. */
    async reconcile(request: FeedbackGitHubMergeRequest, previous: FeedbackGitHubMergeObservation | null, signal: AbortSignal): Promise<FeedbackGitHubMergeObservation> {
      const candidate = exactCandidate(request.candidate);
      const start = initial({...request, candidate});
      if (previous && (previous.source !== source || previous.requestId !== start.requestId || previous.candidateDigest !== start.candidateDigest ||
          previous.bindingDigest !== bindingDigest || (previous.operationId !== null &&
            (previous.dispatchHttpStatus !== 202 || !providerOperation(previous.operationId))) ||
          (previous.status === 'PENDING' && !previous.operationId) || (previous.status === 'MERGED' &&
            (!previous.operationId || !providerSha(previous.mergeSha) || previous.mergeSha !== previous.observedPullRequestMergeSha)))) {
        return reject('FEEDBACK_GITHUB_RECEIPT', 'The retained GitHub response belongs to a different request or binding.', 409);
      }
      if (previous?.status === 'DENIED' || previous?.status === 'MERGED') return previous;
      let observation: FeedbackGitHubMergeObservation = {...(previous ?? start), status: 'UNKNOWN', mergeSha: null};
      try {
        const access = await installation(signal);
        const original = observation.operationId;
        // A missing or expired UUID read can still leave a useful, uncorrelated PR observation.
        const result = original ? await access.get(`/pulls/${candidate.pullRequestId}/merge-async/${original}`).then(record, () => null) : null;
        if (result?.status === 'failed') return {...observation, status: 'DENIED'};
        const {pull} = await pullRequest(access, candidate);
        const observed = pull.merged === true && providerSha(pull.merge_commit_sha) ? pull.merge_commit_sha : null;
        observation = {...observation, observedPullRequestMergeSha: observed};
        if (!result || !original) return observation;

        if (result.status === 'pending' && pending(result, candidate.head) === original) return {...observation, status: 'PENDING'};
        const landed = record(result.details).sha;
        if (result.status !== 'merged' || !providerSha(landed) || landed !== observed || landed === candidate.head ||
            pull.state !== 'closed' || pull.stack != null) return observation;
        const actor = record(pull.merged_by);
        if (actor.type !== 'Bot' || !Number.isSafeInteger(actor.id) || String(actor.id) !== binding.actorId ||
            typeof actor.login !== 'string' || actor.login.toLowerCase() !== binding.actorLogin.toLowerCase()) return observation;

        const expected = linearTrees(record(await access.get(`/compare/${candidate.base}...${candidate.head}`)), candidate.base, candidate.head);
        const merged = linearTrees(record(await access.get(`/compare/${candidate.base}...${landed}`)), candidate.base, landed);
        if (expected.length !== merged.length || !expected.every((tree, index) => tree === merged[index])) return observation;
        const branchHead = await protectedBranch(access);
        if (branchHead !== landed && !compareStartsAt(record(await access.get(`/compare/${landed}...${branchHead}?per_page=1`)), landed)) return observation;
        return {...observation, status: 'MERGED', mergeSha: landed};
      } catch {
        return observation;
      }
    },
  });
}
