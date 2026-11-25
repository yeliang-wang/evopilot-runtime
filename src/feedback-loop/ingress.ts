import { digest, reject, slug, string } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import type { RuntimeStore } from '../server/store.js';
import {
  linearIssueDescription, prepareLinearIssueIntent, type createLinearIssueAdapter,
  type LinearCreateIntent, type LinearIssueReceipt, type LinearIssueScope,
} from './linear.js';
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

/** Internal case worker entry. The registered project worker supplies the exact
 * Linear scope and transport. A retained intent is only eligible for readback. */
export async function bindFeedbackCaseIssue(
  store: RuntimeStore, route: RegisteredRoute, receiver: Principal, caseId: string,
  linear: {scope:LinearIssueScope; adapter:ReturnType<typeof createLinearIssueAdapter>},
) {
  const projectId = slug(route.projectId);
  if (route.workspaceId !== store.workspaceId) reject('CHANNEL_SCOPE_MISMATCH','Route belongs to another workspace.',403);
  authorize(receiver,projectId,'execution.request');
  const original = store.object(projectId,'feedback-case',caseId) as FeedbackCase | null;
  if (!original || original.id !== caseId || original.workspaceId !== route.workspaceId ||
      original.projectId !== projectId || digest(original.scope) !== digest(route.scope)) {
    return reject('FEEDBACK_CASE_UNKNOWN','A retained case in the registered route is required.',404);
  }
  const originalEvent = store.object(projectId,'feedback-channel-event',original.originalEventKey) as RetainedEvent | null;
  if (!originalEvent || originalEvent.caseId !== caseId || originalEvent.event.action.kind !== 'feedback' ||
      originalEvent.event.eventKey !== original.originalEventKey ||
      originalEvent.event.messageId !== original.originalMessageId) {
    return reject('FEEDBACK_CASE_ORIGIN','The original feedback event cannot be verified.',503);
  }
  const pinned = store.object(projectId,'feedback-case-issue-intent',caseId) as LinearCreateIntent | null;
  if (pinned && pinned.scopeDigest !== digest(linear.scope)) {
    return reject('LINEAR_SCOPE_CHANGED','The original issue intent belongs to another Linear scope.',409);
  }
  const linked = store.object(projectId,'feedback-case-issue',caseId) as LinearIssueReceipt | null;
  if (linked) {
    if (!pinned || linked.intentId !== pinned.intentId || linked.issueId !== pinned.issueId) {
      return reject('LINEAR_RECEIPT_MISMATCH','Retained issue receipt does not match its original intent.',503);
    }
    return {status:'CONFIRMED' as const,receipt:linked};
  }

  const body = originalEvent.event.action.text;
  const title = [...(body.trim().split(/[\r\n]/,1)[0].replaceAll('\t',' '))].slice(0,90).join('').trim();
  const intent = pinned ?? prepareLinearIssueIntent(linear.scope,{
    kind:'create',caseId,requestId:'feedback-issue:'+digest(caseId),title,body,
  });
  if (!pinned) {
    store.mutate(receiver,{
      projectId,operation:'feedback.case.issue.reserve',requestId:intent.requestId,
      expectedRevision:store.revision(projectId),permission:'execution.request',input:{caseId,intentId:intent.intentId},
    },() => ({
      value:{intentId:intent.intentId,issueId:intent.issueId},
      objects:[{kind:'feedback-case-issue-intent',id:caseId,value:intent}],
      event:{type:'feedback-case-issue-reserved',data:{caseId,issueId:intent.issueId}},
    }));
  }
  const result = pinned ? await linear.adapter.reconcile(intent) : await linear.adapter.dispatch(intent,'RESERVED');
  if (result.status !== 'CONFIRMED') return result;
  const {receipt} = result;
  if (receipt.intentId !== intent.intentId || receipt.originalIntentId !== intent.intentId ||
      receipt.issueId !== intent.issueId || receipt.scopeDigest !== intent.scopeDigest ||
      receipt.stateId !== intent.stateId || receipt.descriptionDigest !== digest(linearIssueDescription(intent))) {
    return reject('LINEAR_RECEIPT_MISMATCH','Issue readback does not match its original scoped reservation.',409);
  }
  const concurrent = store.object(projectId,'feedback-case-issue',caseId) as LinearIssueReceipt | null;
  if (concurrent) {
    if (digest(concurrent) !== digest(receipt)) {
      return reject('LINEAR_RECEIPT_MISMATCH','Another readback confirmed different issue evidence.',409);
    }
    return {status:'CONFIRMED' as const,receipt:concurrent};
  }
  store.mutate(receiver,{
    projectId,operation:'feedback.case.issue.confirm',requestId:intent.requestId+':confirmed',
    expectedRevision:store.revision(projectId),permission:'execution.request',input:{caseId,receipt},
  },() => ({
    value:receipt,
    objects:[{kind:'feedback-case-issue',id:caseId,value:receipt}],
    event:{type:'feedback-case-issue-confirmed',data:{caseId,issueId:receipt.issueId,source:receipt.source}},
  }));
  return result;
}
