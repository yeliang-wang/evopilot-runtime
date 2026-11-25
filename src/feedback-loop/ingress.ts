import { reject, slug } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import type { RuntimeStore } from '../server/store.js';
import { normalizeChannelEvent, type ChannelScope, type NormalizedChannelEvent } from './channel.js';

interface RegisteredRoute {
  workspaceId: string;
  projectId: string;
  scope: ChannelScope;
}

interface RetainedEvent {
  event: NormalizedChannelEvent;
  receivedAt: number;
}

/** Owner-only ingress. The transport must authenticate the envelope and actor,
 * and resolve the registered project route before calling this function. */
export function retainFeedbackChannelEvent(store: RuntimeStore, route: RegisteredRoute, receiver: Principal, input: unknown) {
  const projectId = slug(route.projectId);
  if (route.workspaceId !== store.workspaceId) reject('CHANNEL_SCOPE_MISMATCH', 'Route belongs to another workspace.', 403);
  authorize(receiver, projectId, 'execution.request');
  const event = normalizeChannelEvent(input, route.scope);
  if (event.action.kind === 'veto') reject('FEEDBACK_VETO_ROUTE', 'Veto must use transactional review admission.', 409);
  const original = store.object(projectId, 'feedback-channel-event', event.eventKey) as RetainedEvent | null;
  if (original) {
    if (original.event.payloadDigest !== event.payloadDigest) {
      reject('CHANNEL_EVENT_CONFLICT', 'Provider event identity already has different content.', 409);
    }
    return {status:'REUSED' as const, eventKey:event.eventKey, receivedAt:original.receivedAt};
  }
  // The store holds the sole writer lock; this read and write are synchronous.
  const receivedAt = Date.now();
  store.mutate(receiver, {
    projectId, operation:'feedback.channel.retain', requestId:event.eventKey,
    expectedRevision:store.revision(projectId), permission:'execution.request', input:{payloadDigest:event.payloadDigest},
  }, () => ({
    value:{eventKey:event.eventKey, receivedAt},
    objects:[{kind:'feedback-channel-event', id:event.eventKey, value:{event, receivedAt}}],
    event:{type:'feedback-channel-received', data:{eventKey:event.eventKey, action:event.action.kind}},
  }));
  return {status:'RETAINED' as const, eventKey:event.eventKey, receivedAt};
}
