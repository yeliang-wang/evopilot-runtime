import { setTimeout as delay } from 'node:timers/promises';
import { record, reject, ServiceError, string } from '../server/errors.js';
import { normalizeChannelEvent, readChannelScope, type ChannelScope, type NormalizedChannelEvent } from './channel.js';

type ResolveThreadCase = (scope: ChannelScope, originalMessageId: string) => string | undefined;

const connectionEndpoint = 'https://slack.com/api/apps.connections.open';
const socketHost = /^wss(?:-[a-z0-9]+)*\.slack\.com$/;
const frameLimit = 256 * 1024;
const preparationTimeoutMs = 10_000;
const maxPendingFrames = 32;

type SlackAppCredential = { readonly kind: 'app-level'; readonly value: string };
type SlackCredentialResolver = (reference: string, signal: AbortSignal) => SlackAppCredential | Promise<SlackAppCredential>;
type SlackSocket = Pick<WebSocket, 'addEventListener' | 'removeEventListener' | 'close' | 'send' | 'readyState'>;
type SlackSocketStatus = 'READY' | 'INTERRUPTED' | 'BLOCKED';
type SlackDeliveryDecision = { readonly status: 'RETAINED' | 'REUSED' | 'DISCARDED' };

interface SlackSocketOptions {
  readonly fetch?: typeof fetch;
  readonly openSocket?: (url: URL) => SlackSocket;
}

interface SlackSocketRun {
  readonly onEvent: (event: NormalizedChannelEvent, signal: AbortSignal) => SlackDeliveryDecision | Promise<SlackDeliveryDecision>;
  readonly resolveThreadCase?: ResolveThreadCase;
  readonly signal: AbortSignal;
  readonly onStatus?: (status: SlackSocketStatus) => void;
}

function parseSocketURL(input: unknown): URL | undefined {
  if (typeof input !== 'string' || input.length > 4096 || !/^wss:\/\/[^\s#]+$/.test(input)) return;
  const url = URL.parse(input);
  if (!url || !socketHost.test(url.hostname) || url.port || url.username || url.password ||
      url.pathname !== '/link/' || url.hash || url.searchParams.getAll('ticket').length !== 1 ||
      !url.searchParams.get('ticket')) return;
  return url;
}

async function readConnectionResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 8192) {
        await reader.cancel().catch(() => {});
        return {};
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return record(JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks, length))));
}

type SlackConnection = { readonly url: URL } | { readonly blocked: true } | { readonly retryMs: number };

async function openSlackConnection(
  request: typeof fetch, credentialRef: string, resolveCredential: SlackCredentialResolver, signal: AbortSignal,
): Promise<SlackConnection> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(preparationTimeoutMs)]);
  let credential: SlackAppCredential;
  try {
    signal.throwIfAborted();
    credential = await new Promise((resolve, rejectResolution) => {
      const abort = () => rejectResolution(signal.reason);
      signal.addEventListener('abort', abort, {once:true});
      void Promise.resolve().then(() => resolveCredential(credentialRef, signal))
        .then(resolve, rejectResolution).finally(() => signal.removeEventListener('abort', abort));
    });
  } catch {
    return signal.aborted ? {retryMs:0} : {blocked:true};
  }
  if (signal.aborted) return {retryMs:0};
  if (credential?.kind !== 'app-level' || typeof credential.value !== 'string' ||
      !/^xapp-[A-Za-z0-9-]{1,4091}$/.test(credential.value)) return {blocked:true};
  try {
    const response = await request(connectionEndpoint, {
      method:'POST', headers:{Authorization:`Bearer ${credential.value}`, 'Content-Type':'application/x-www-form-urlencoded'},
      redirect:'error', signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) return {blocked:true};
      const seconds = response.headers.get('retry-after');
      const retryMs = response.status === 429 && seconds && /^\d+$/.test(seconds) ? Math.min(+seconds, 3600) * 1000 : 0;
      return {retryMs};
    }
    const value = await readConnectionResponse(response);
    if (value.ok !== true) {
      const blocked = ['invalid_auth','not_authed','missing_scope','not_allowed_token_type','token_revoked',
        'account_inactive','app_not_found','not_allowed','link_disabled'].some(code => code === value.error);
      return blocked ? {blocked:true} : {retryMs:0};
    }
    const url = parseSocketURL(value.url);
    return url ? {url} : {blocked:true};
  } catch {
    return {retryMs:0};
  }
}

function messageTimestamp(value: unknown): string {
  const timestamp = string(value);
  if (!/^\d+\.\d+$/.test(timestamp)) reject('INVALID_INPUT', 'Expected a Slack message timestamp');
  return timestamp;
}

/** Maps a delivery from an authenticated Slack socket and a registered feedback route.
 * The caller resolves replies using the original message binding in that route. */
export function normalizeSlackSocketModeEvent(
  input: unknown,
  expectedScope: ChannelScope,
  resolveThreadCase?: ResolveThreadCase,
): NormalizedChannelEvent | undefined {
  const envelope = record(input);
  if (envelope.type !== 'events_api') return undefined;
  string(envelope.envelope_id);
  const payload = record(envelope.payload);
  if (payload.type !== 'event_callback') return undefined;
  if (expectedScope.provider !== 'slack' || payload.api_app_id !== expectedScope.installationId ||
    payload.team_id !== expectedScope.tenantId) {
    reject('CHANNEL_SCOPE_MISMATCH', 'Slack event does not match the configured app and workspace', 403);
  }

  const event = record(payload.event);
  // Slack can omit the subtype of a message_replied update, which wraps the original message.
  if (event.type !== 'message' || event.subtype !== undefined || event.bot_id !== undefined ||
    event.bot_profile !== undefined || event.app_id !== undefined || event.message !== undefined ||
    event.hidden === true || event.edited !== undefined) return undefined;

  if (event.channel !== expectedScope.channelId) {
    reject('CHANNEL_SCOPE_MISMATCH', 'Slack event does not match the configured conversation', 403);
  }
  const scope = readChannelScope({
    provider: 'slack',
    installationId: payload.api_app_id,
    tenantId: payload.team_id,
    channelId: event.channel,
  });
  const messageId = messageTimestamp(event.ts);
  const base = {
    schema: 'runtime-feedback-channel-event/v1',
    scope,
    eventId: payload.event_id,
    messageId,
    actorId: event.user,
  };
  const threadId = event.thread_ts === undefined ? messageId : messageTimestamp(event.thread_ts);
  if (threadId === messageId) {
    return normalizeChannelEvent({ ...base, action: { kind: 'feedback', text: event.text } }, expectedScope);
  }

  const caseId = resolveThreadCase?.(scope, threadId);
  if (caseId === undefined) return undefined;
  return normalizeChannelEvent({ ...base, action: { kind: 'supplement', caseId, text: event.text } }, expectedScope);
}

type SessionEnd = 'REFRESH' | 'RETRY' | 'BLOCKED' | 'STOPPED';

function readSocketFrame(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== 'string' || data.length > frameLimit || Buffer.byteLength(data) > frameLimit) return;
  try {
    return record(JSON.parse(data));
  } catch {
    return;
  }
}

async function acceptSocketDelivery(
  envelope: Record<string, unknown>, scope: ChannelScope, run: SlackSocketRun, signal: AbortSignal,
): Promise<boolean> {
  if (!['events_api', 'interactive', 'slash_commands'].some(type => type === envelope.type)) return false;
  const payload = envelope.payload as Record<string, unknown>;
  const nested = payload.event;
  if (envelope.type === 'events_api' && (typeof payload.type !== 'string' ||
      (payload.type === 'event_callback' && (!nested || typeof nested !== 'object' ||
        !('type' in nested) || typeof nested.type !== 'string')))) return false;
  let event: NormalizedChannelEvent | undefined;
  try {
    event = normalizeSlackSocketModeEvent(envelope, scope, (route, originalMessageId) => {
      try {
        return run.resolveThreadCase?.(route, originalMessageId);
      } catch {
        return reject('SLACK_THREAD_LOOKUP', 'The original thread binding is temporarily unavailable.', 503);
      }
    });
  } catch (error) {
    if (error instanceof ServiceError && error.code === 'SLACK_THREAD_LOOKUP') throw error;
    // An authenticated app socket can also receive events outside the configured route.
    return error instanceof ServiceError && error.code === 'CHANNEL_SCOPE_MISMATCH';
  }
  if (!event) return true;
  const decision = await run.onEvent(event, signal);
  if (decision?.status !== 'RETAINED' && decision?.status !== 'REUSED' && decision?.status !== 'DISCARDED') {
    return reject('SLACK_ADMISSION_UNKNOWN', 'The owner must confirm the delivery disposition.', 503);
  }
  return true;
}

function readSlackSocket(
  socket: SlackSocket, scope: ChannelScope, run: SlackSocketRun, ready: () => void,
): Promise<SessionEnd> {
  return new Promise(resolve => {
    const session = new AbortController();
    const queue: Record<string, unknown>[] = [];
    let processing = false;
    let authenticated = false;
    const helloTimeout = setTimeout(() => finish('RETRY'), preparationTimeoutMs);
    helloTimeout.unref();

    function finish(outcome: SessionEnd) {
      if (session.signal.aborted) return;
      session.abort();
      queue.length = 0;
      clearTimeout(helloTimeout);
      run.signal.removeEventListener('abort', stop);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', disconnected);
      socket.removeEventListener('error', disconnected);
      try { socket.close(); } catch { /* The underlying socket is already unusable. */ }
      resolve(outcome);
    }

    const stop = () => finish('STOPPED');
    const disconnected = () => finish('RETRY');

    async function drain() {
      processing = true;
      while (queue.length && !session.signal.aborted) {
        const envelope = queue.shift()!;
        let acknowledged: boolean;
        try {
          acknowledged = await acceptSocketDelivery(envelope, scope, run, session.signal);
        } catch {
          // Owner failure leaves the original delivery eligible for Slack retry.
          finish('RETRY');
          break;
        }
        if (!acknowledged || session.signal.aborted) continue;
        if (socket.readyState !== 1) {
          finish('RETRY');
          break;
        }
        try {
          socket.send(JSON.stringify({envelope_id:envelope.envelope_id}));
        } catch {
          finish('RETRY');
        }
      }
      processing = false;
    }

    function onMessage(message: MessageEvent) {
      const frame = readSocketFrame(message.data);
      if (!frame) return;
      if (frame.type === 'hello') {
        const connection = frame.connection_info;
        if (!connection || typeof connection !== 'object' || !('app_id' in connection) ||
            connection.app_id !== scope.installationId) return finish('BLOCKED');
        if (!authenticated) {
          authenticated = true;
          clearTimeout(helloTimeout);
          try { ready(); } catch { finish('BLOCKED'); }
        }
        return;
      }
      if (frame.type === 'disconnect') {
        if (frame.reason === 'link_disabled') return finish('BLOCKED');
        return finish(frame.reason === 'warning' || frame.reason === 'refresh_requested' ? 'REFRESH' : 'RETRY');
      }
      if (!authenticated) return;
      if (typeof frame.envelope_id !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(frame.envelope_id) ||
          !frame.payload || typeof frame.payload !== 'object' || Array.isArray(frame.payload)) return;
      if (queue.length >= maxPendingFrames) return finish('RETRY');
      queue.push(frame);
      if (!processing) void drain();
    }

    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', disconnected);
    socket.addEventListener('error', disconnected);
    run.signal.addEventListener('abort', stop, {once:true});
    if (run.signal.aborted) stop();
    else if (socket.readyState >= 2) disconnected();
  });
}

/** Start one socket for the server's registered Slack app and route. Event
 * admission is owned by Runtime and confirms retention before transport ACK. */
export function createSlackSocketModeTransport(
  scope: ChannelScope,
  credentialRef: string,
  resolveCredential: SlackCredentialResolver,
  options: SlackSocketOptions = {},
) {
  scope = readChannelScope(scope);
  if (scope.provider !== 'slack') reject('CHANNEL_SCOPE_MISMATCH', 'Expected a Slack route.', 403);
  if (!/^(?:credential|secret|binding):[a-z0-9][a-z0-9._/-]{0,187}$/.test(credentialRef)) {
    reject('SLACK_CREDENTIAL_REFERENCE', 'Use a protected Slack app credential reference.');
  }
  const request = options.fetch ?? fetch;
  const openSocket = options.openSocket ?? (url => new WebSocket(url));
  let running = false;
  return Object.freeze({
    async run(input: SlackSocketRun): Promise<'BLOCKED' | 'STOPPED'> {
      if (running) return reject('SLACK_SOCKET_RUNNING', 'The Slack route already has a running socket.', 409);
      running = true;
      const {signal} = input;
      let state: SlackSocketStatus | undefined;
      let backoff = 1000;
      let lastRefresh = -Infinity;
      function publish(status: SlackSocketStatus) {
        if (status !== state) {
          state = status;
          input.onStatus?.(status);
        }
      }
      try {
        while (!signal.aborted) {
          publish('INTERRUPTED');
          const connection = await openSlackConnection(request, credentialRef, resolveCredential, signal);
          if (signal.aborted) break;
          if ('blocked' in connection) {
            publish('BLOCKED');
            return 'BLOCKED';
          }
          let retryAfter = 0;
          if ('url' in connection) {
            let socket: SlackSocket | undefined;
            try { socket = openSocket(connection.url); } catch { /* Retry with a fresh URL. */ }
            if (socket) {
              const outcome = await readSlackSocket(socket, scope, input, () => {
                backoff = 1000;
                publish('READY');
              });
              if (outcome === 'STOPPED' || signal.aborted) break;
              publish('INTERRUPTED');
              if (outcome === 'BLOCKED') {
                publish('BLOCKED');
                return 'BLOCKED';
              }
              if (outcome === 'REFRESH' && Date.now() - lastRefresh >= 1000) {
                lastRefresh = Date.now();
                continue;
              }
            }
          } else retryAfter = connection.retryMs;
          await delay(Math.max(backoff, retryAfter), undefined, {signal}).catch(() => {});
          backoff = Math.min(backoff * 2, 60_000);
        }
        publish('INTERRUPTED');
        return 'STOPPED';
      } finally {
        running = false;
      }
    },
  });
}
