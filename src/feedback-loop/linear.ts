import { randomUUID } from 'node:crypto';
import { digest, record, reject, string } from '../server/errors.js';

export interface LinearIssueScope {
  readonly teamId: string;
  readonly projectId: string;
  readonly openStateId: string;
  readonly needsInfoStateId: string;
  readonly closedStateId: string;
}

type ChangeKind = 'needs-info' | 'resume' | 'close';
export type LinearIssueRequest =
  | {kind: 'create'; caseId: string; requestId: string; title: string; body: string}
  | {kind: ChangeKind; original: LinearCreateIntent; prior: LinearIssueReceipt; requestId: string; body: string};

interface IssueIntentFields {
  readonly scopeDigest: string;
  readonly caseId: string;
  readonly requestId: string;
  readonly issueId: string;
  readonly stateId: string;
  readonly body: string;
}

type IssueIntentMaterial = IssueIntentFields & (
  | {readonly kind: 'create'; readonly title: string}
  | {readonly kind: ChangeKind; readonly originalIntentId: string; readonly prior: LinearIssueReceipt}
);

export type LinearIssueIntent = IssueIntentMaterial & {readonly intentId: string};
export type LinearCreateIntent = Extract<LinearIssueIntent, {kind: 'create'}>;

export interface LinearIssueReceipt {
  readonly source: 'LINEAR_PROVIDER' | 'FIXTURE';
  readonly scopeDigest: string;
  readonly intentId: string;
  readonly originalIntentId: string;
  readonly issueId: string;
  readonly stateId: string;
  readonly descriptionDigest: string;
}

export type LinearIssueResult =
  | {status: 'CONFIRMED'; receipt: LinearIssueReceipt}
  | {status: 'UNKNOWN'; intentId: string; issueId: string}
  | {status: 'BLOCKED'; intentId: string; issueId: string; reason: 'ORIGINAL_CHANGED' | 'CLOSE_STATE_UNVERIFIED'};

export interface LinearTransport {
  request(query: string, variables: Readonly<Record<string, unknown>>): Promise<unknown>;
}

type Credential = {kind: 'api-key' | 'oauth'; value: string};
const endpoint = 'https://api.linear.app/graphql';
const liveTransports = new WeakSet<LinearTransport>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256 = /^[0-9a-f]{64}$/;

/** The service resolves the protected reference server-side on each request. */
export function createLinearProviderTransport(
  credentialRef: string,
  resolveCredential: (reference: string) => Promise<Credential> | Credential,
): LinearTransport {
  if (!/^(?:credential|secret|binding):[a-z0-9][a-z0-9._/-]{0,187}$/.test(credentialRef)) {
    reject('LINEAR_CREDENTIAL_REFERENCE', 'Use a protected Linear credential reference.');
  }
  const transport: LinearTransport = {
    async request(query, variables) {
      const credential = await resolveCredential(credentialRef);
      if (!credential || !['api-key', 'oauth'].includes(credential.kind) ||
          typeof credential.value !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(credential.value)) {
        return reject('LINEAR_CREDENTIAL_UNAVAILABLE', 'The protected Linear credential is unavailable.', 503);
      }
      const authorization = credential.kind === 'oauth' ? 'Bearer ' + credential.value : credential.value;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: authorization},
        body: JSON.stringify({query, variables}),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        return reject('LINEAR_PROVIDER_UNAVAILABLE', 'Linear returned no successful HTTP response.', 503);
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 262144) {
            await reader.cancel().catch(() => {});
            return reject('LINEAR_PROVIDER_UNAVAILABLE', 'Linear response exceeds the profile.', 503);
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      const body = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks, bytes));
      return JSON.parse(body) as unknown;
    },
  };
  liveTransports.add(transport);
  return Object.freeze(transport);
}

function fixedScope(scope: LinearIssueScope): LinearIssueScope {
  const {teamId, projectId, openStateId, needsInfoStateId, closedStateId} = scope;
  const states = [openStateId, needsInfoStateId, closedStateId];
  if (![teamId, projectId, ...states].every(id => typeof id === 'string' && uuid.test(id)) || new Set(states).size !== 3) {
    reject('LINEAR_SCOPE_INVALID', 'Linear requires fixed team and project UUIDs and three distinct workflow state UUIDs.');
  }
  return {teamId, projectId, openStateId, needsInfoStateId, closedStateId};
}

function expectedState(scope: LinearIssueScope, kind: LinearIssueIntent['kind']) {
  switch (kind) {
    case 'create':
    case 'resume':
      return scope.openStateId;
    case 'needs-info':
      return scope.needsInfoStateId;
    case 'close':
      return scope.closedStateId;
  }
}

function bodyText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 32768 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)) {
    return reject('LINEAR_BODY_INVALID', 'Linear requires a bounded Markdown body.');
  }
  return value;
}

const originalId = (intent: LinearIssueIntent) => intent.kind === 'create' ? intent.intentId : intent.originalIntentId;

export function linearIssueDescription(intent: LinearIssueIntent) {
  const issueMarker = 'EvoPilot issue: ' + originalId(intent);
  const changeMarker = intent.kind === 'create' ? '' : '\n\nEvoPilot change: ' + intent.intentId;
  return issueMarker + changeMarker + '\n\n' + intent.body;
}

function checkIntent(intent: LinearIssueIntent, scope: LinearIssueScope) {
  const {intentId, ...material} = intent;
  if (!uuidV4.test(intent.issueId) || intent.scopeDigest !== digest(scope) ||
      intent.stateId !== expectedState(scope, intent.kind) || intentId !== digest(material)) {
    reject('LINEAR_INTENT_MISMATCH', 'Linear requires the original intent in its fixed scope.', 409);
  }
}

/** Persist the intent and reserve its only dispatch before contacting Linear. */
export function prepareLinearIssueIntent(scope: LinearIssueScope, request: Extract<LinearIssueRequest, {kind: 'create'}>): LinearCreateIntent;
export function prepareLinearIssueIntent(scope: LinearIssueScope, request: LinearIssueRequest): LinearIssueIntent;
export function prepareLinearIssueIntent(scope: LinearIssueScope, request: LinearIssueRequest): LinearIssueIntent {
  const fixed = fixedScope(scope);
  const scopeDigest = digest(fixed);
  const requestId = string(request.requestId);
  const body = bodyText(request.body);
  const stateId = expectedState(fixed, request.kind);
  if (request.kind === 'create') {
    const title = string(request.title, 200);
    if (title.trim() !== title || /[\u007f-\u009f\ud800-\udfff]/u.test(title)) {
      reject('LINEAR_TITLE_INVALID', 'Linear requires a bounded single-line title.');
    }
    const material = {
      kind: request.kind, scopeDigest, caseId: string(request.caseId), requestId, issueId: randomUUID(), stateId, title, body,
    };
    return {...material, intentId: digest(material)};
  }

  const {original, prior} = request;
  checkIntent(original, fixed);
  const sourceStateId = request.kind === 'resume' ? fixed.needsInfoStateId : fixed.openStateId;
  if (original.kind !== 'create' || prior.scopeDigest !== scopeDigest || prior.originalIntentId !== original.intentId ||
      prior.issueId !== original.issueId || prior.stateId !== sourceStateId || !sha256.test(prior.intentId) ||
      !sha256.test(prior.descriptionDigest) || requestId === original.requestId) {
    reject('LINEAR_ORIGINAL_REQUIRED', 'Linear changes require the original issue and last verified state.', 409);
  }
  const material = {
    kind: request.kind, scopeDigest, caseId: original.caseId, requestId, issueId: original.issueId, stateId, body,
    originalIntentId: original.intentId, prior: {...prior},
  };
  return {...material, intentId: digest(material)};
}

const readIssue = `query RuntimeLinearRead($id: String!) {
  issue(id: $id) { id title description archivedAt team { id } project { id } state { id type } }
}`;
const createIssue = `mutation RuntimeLinearCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id } }
}`;
const updateIssue = `mutation RuntimeLinearUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { id } }
}`;
const readState = `query RuntimeLinearState($id: String!) {
  workflowState(id: $id) { id type team { id } }
}`;

export function createLinearIssueAdapter(scope: LinearIssueScope, transport: LinearTransport) {
  const fixed = fixedScope(scope);
  const source = liveTransports.has(transport) ? 'LINEAR_PROVIDER' : 'FIXTURE';

  async function data(query: string, variables: Record<string, unknown>) {
    try {
      const response = record(await transport.request(query, variables));
      if (Object.hasOwn(response, 'errors') && (!Array.isArray(response.errors) || response.errors.length)) return undefined;
      return record(response.data);
    } catch {
      return undefined;
    }
  }

  async function observe(intent: LinearIssueIntent) {
    try {
      const result = await data(readIssue, {id: intent.issueId});
      const issue = record(result?.issue);
      const team = record(issue.team);
      const project = record(issue.project);
      const state = record(issue.state);
      return {issue, team, project, state};
    } catch {
      return undefined;
    }
  }

  function inScope(intent: LinearIssueIntent, original: Awaited<ReturnType<typeof observe>>) {
    return original?.issue.id === intent.issueId && original.team.id === fixed.teamId && original.project.id === fixed.projectId &&
      original.issue.archivedAt === null && typeof original.issue.description === 'string';
  }

  async function reconcile(retained: LinearIssueIntent): Promise<LinearIssueResult> {
    const intent = structuredClone(retained);
    checkIntent(intent, fixed);
    const original = await observe(intent);
    const expected = linearIssueDescription(intent);
    if (original && inScope(intent, original) && original.state.id === intent.stateId && original.issue.description === expected &&
        (intent.kind !== 'create' || original.issue.title === intent.title) &&
        (intent.kind !== 'close' || original.state.type === 'completed')) {
      return {
        status: 'CONFIRMED',
        receipt: {
          source, scopeDigest: intent.scopeDigest, intentId: intent.intentId, originalIntentId: originalId(intent),
          issueId: intent.issueId, stateId: intent.stateId, descriptionDigest: digest(expected),
        },
      };
    }
    return {status: 'UNKNOWN', intentId: intent.intentId, issueId: intent.issueId};
  }

  /** The owner must serialize issue operations and pass RESERVED only once
   * from its committed reservation. Every reuse goes through reconcile. */
  async function dispatch(retained: LinearIssueIntent, reservation: 'RESERVED', permit?: () => void): Promise<LinearIssueResult> {
    if (reservation !== 'RESERVED') reject('LINEAR_RECONCILE_ORIGINAL', 'Read back the original Linear intent.', 409);
    const intent = structuredClone(retained);
    checkIntent(intent, fixed);
    const input = {description: linearIssueDescription(intent), stateId: intent.stateId};
    if (intent.kind === 'create') {
      // A mutation reply can be lost after commit. Only the original UUID readback confirms the effect.
      permit?.();
      await data(createIssue, {input: {...input, id: intent.issueId, title: intent.title,
        teamId: fixed.teamId, projectId: fixed.projectId, useDefaultTemplate: false}});
      return reconcile(intent);
    }

    const original = await observe(intent);
    const identity = {intentId: intent.intentId, issueId: intent.issueId};
    if (!original) return {status: 'UNKNOWN', ...identity};
    const {prior} = intent;
    if (!inScope(intent, original) || prior.source !== source || original.state.id !== prior.stateId ||
        digest(original.issue.description) !== prior.descriptionDigest) {
      return {status: 'BLOCKED', ...identity, reason: 'ORIGINAL_CHANGED'};
    }
    if (intent.kind === 'close') {
      const result = await data(readState, {id: intent.stateId});
      try {
        const state = record(result?.workflowState);
        if (state.id !== intent.stateId || state.type !== 'completed' || record(state.team).id !== fixed.teamId) {
          return {status: 'BLOCKED', ...identity, reason: 'CLOSE_STATE_UNVERIFIED'};
        }
      } catch {
        return {status: 'BLOCKED', ...identity, reason: 'CLOSE_STATE_UNVERIFIED'};
      }
    }
    permit?.();
    await data(updateIssue, {id: intent.issueId, input});
    return reconcile(intent);
  }

  return Object.freeze({dispatch, reconcile});
}
