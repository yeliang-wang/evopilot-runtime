import { digest, exact, record, reject, slug, string } from '../server/errors.js';

export interface ChannelScope {
  readonly provider: string;
  readonly installationId: string;
  readonly tenantId: string;
  readonly channelId: string;
}

export type ChannelAction =
  | { readonly kind: 'feedback'; readonly text: string }
  | { readonly kind: 'supplement'; readonly caseId: string; readonly text: string }
  | { readonly kind: 'veto'; readonly reviewId: string };

export interface ChannelEvent {
  readonly schema: 'runtime-feedback-channel-event/v1';
  readonly scope: ChannelScope;
  readonly eventId: string;
  readonly messageId: string;
  readonly actorId: string;
  readonly action: ChannelAction;
}

export interface NormalizedChannelEvent extends ChannelEvent {
  readonly eventKey: string;
  readonly payloadDigest: string;
}

const MAX_TEXT_BYTES = 16 * 1024;

function platformId(value: unknown): string {
  const id = string(value, 256);
  if (/[\s\u007f-\u009f\ud800-\udfff]/u.test(id)) {
    reject('INVALID_ID', 'Expected an opaque platform identifier without spaces or controls');
  }
  return id;
}

function feedbackText(value: unknown): string {
  if (typeof value !== 'string') reject('INVALID_INPUT', 'Expected feedback text');
  if (value.length > MAX_TEXT_BYTES || Buffer.byteLength(value) > MAX_TEXT_BYTES) {
    reject('INPUT_LIMIT', 'Feedback text exceeds its byte limit', 413);
  }
  if (!value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)) {
    reject('INVALID_INPUT', 'Expected feedback text with visible content and safe line breaks');
  }
  return value;
}

export function readChannelScope(input: unknown): ChannelScope {
  const scope = record(input);
  exact(scope, ['provider', 'installationId', 'tenantId', 'channelId']);
  return {
    provider: slug(scope.provider),
    installationId: platformId(scope.installationId),
    tenantId: platformId(scope.tenantId),
    channelId: platformId(scope.channelId),
  };
}

function readAction(input: unknown): ChannelAction {
  const action = record(input);
  switch (action.kind) {
    case 'feedback':
      exact(action, ['kind', 'text']);
      return { kind: action.kind, text: feedbackText(action.text) };
    case 'supplement':
      exact(action, ['kind', 'caseId', 'text']);
      return { kind: action.kind, caseId: platformId(action.caseId), text: feedbackText(action.text) };
    case 'veto':
      exact(action, ['kind', 'reviewId']);
      return { kind: action.kind, reviewId: platformId(action.reviewId) };
    default:
      return reject('INVALID_INPUT', 'Unsupported feedback channel action');
  }
}

/** The adapter authenticates the event and actor before applying the configured route scope. */
export function normalizeChannelEvent(input: unknown, expectedScope: ChannelScope): NormalizedChannelEvent {
  const value = record(input);
  exact(value, ['schema', 'scope', 'eventId', 'messageId', 'actorId', 'action']);
  if (value.schema !== 'runtime-feedback-channel-event/v1') {
    reject('INVALID_INPUT', 'Unsupported feedback channel event schema');
  }
  const scope = readChannelScope(value.scope);
  if (scope.provider !== expectedScope.provider || scope.installationId !== expectedScope.installationId ||
    scope.tenantId !== expectedScope.tenantId || scope.channelId !== expectedScope.channelId) {
    reject('CHANNEL_SCOPE_MISMATCH', 'Channel event does not match the configured route scope', 403);
  }
  const event: ChannelEvent = {
    schema: value.schema,
    scope,
    eventId: platformId(value.eventId),
    messageId: platformId(value.messageId),
    actorId: platformId(value.actorId),
    action: readAction(value.action),
  };
  return {
    ...event,
    eventKey: 'sha256:' + digest({ schema: 'runtime-feedback-channel-event-key/v1', scope, eventId: event.eventId }),
    payloadDigest: 'sha256:' + digest(event),
  };
}
