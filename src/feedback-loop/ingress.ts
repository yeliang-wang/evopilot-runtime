import { digest, reject, slug, string } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import type { RuntimeStore } from '../server/store.js';
import { normalizeChannelEvent, type ChannelScope, type NormalizedChannelEvent } from './channel.js';

interface RegisteredRoute {
  workspaceId: string;
  projectId: string;
  scope: ChannelScope;
}

interface FeedbackCase {
  id: string;
  workspaceId: string;
  projectId: string;
  scope: ChannelScope;
  originalMessageId: string;
  originalEventKey: string;
  receivedAt: number;
}

const caseIdFor = (scope: ChannelScope, messageId: string) =>
  'feedback-case:' + digest({scope,messageId});

/** Read the durable thread root mapping selected by the registered route. */
export function resolveOriginalFeedbackCase(store: RuntimeStore, route: RegisteredRoute, messageId: string): string | undefined {
  if (route.workspaceId !== store.workspaceId) reject('CHANNEL_SCOPE_MISMATCH', 'Route belongs to another workspace.', 403);
  const id = caseIdFor(route.scope,string(messageId));
  return store.object(route.projectId,'feedback-case',id) ? id : undefined;
}

interface RetainedEvent {
  caseId: string;
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
    return {status:'REUSED' as const, eventKey:event.eventKey, caseId:original.caseId, receivedAt:original.receivedAt};
  }
  // The store holds the sole writer lock; this read and write are synchronous.
  const receivedAt = Date.now();
  const caseId = event.action.kind === 'feedback' ? caseIdFor(event.scope,event.messageId) : event.action.caseId;
  const existing = store.object(projectId,'feedback-case',caseId) as FeedbackCase | null;
  if (existing && (existing.id !== caseId || existing.workspaceId !== store.workspaceId ||
      existing.projectId !== projectId || digest(existing.scope) !== digest(event.scope))) {
    reject('FEEDBACK_CASE_SCOPE', 'The feedback case belongs to another route.',403);
  }
  if (!existing && event.action.kind === 'supplement') {
    reject('FEEDBACK_CASE_UNKNOWN', 'Supplement requires a retained original feedback case.',404);
  }
  const created: FeedbackCase | null = existing ? null : {
    id:caseId,workspaceId:store.workspaceId,projectId,scope:event.scope,
    originalMessageId:event.messageId,originalEventKey:event.eventKey,receivedAt,
  };
  store.mutate(receiver, {
    projectId, operation:'feedback.channel.retain', requestId:event.eventKey,
    expectedRevision:store.revision(projectId), permission:'execution.request', input:{payloadDigest:event.payloadDigest},
  }, () => ({
    value:{eventKey:event.eventKey,caseId,receivedAt},
    objects:[
      {kind:'feedback-channel-event',id:event.eventKey,value:{event,caseId,receivedAt}},
      ...(created ? [{kind:'feedback-case',id:caseId,value:created}] : []),
    ],
    event:{type:'feedback-channel-received',data:{eventKey:event.eventKey,caseId,action:event.action.kind}},
  }));
  return {status:'RETAINED' as const,eventKey:event.eventKey,caseId,receivedAt};
}
