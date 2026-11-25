import { record, reject, string } from '../server/errors.js';
import { normalizeChannelEvent, readChannelScope, type ChannelScope, type NormalizedChannelEvent } from './channel.js';

type ResolveThreadCase = (scope: ChannelScope, originalMessageId: string) => string | undefined;

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
