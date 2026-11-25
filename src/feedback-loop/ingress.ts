import { digest, reject, slug, string } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import type { RuntimeStore } from '../server/store.js';
import {
  linearIssueDescription, prepareLinearIssueIntent, type createLinearIssueAdapter,
  type LinearCreateIntent, type LinearIssueIntent, type LinearIssueReceipt,
  type LinearIssueResult, type LinearIssueScope,
} from './linear.js';
import { normalizeChannelEvent, type ChannelScope, type NormalizedChannelEvent } from './channel.js';
import { readFeedbackClosureMerge } from './service.js';

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

type LinearBinding = {
  scope: LinearIssueScope;
  adapter: ReturnType<typeof createLinearIssueAdapter>;
};

function requireFeedbackCase(store: RuntimeStore, route: RegisteredRoute, receiver: Principal, caseId: string) {
  const projectId = slug(route.projectId);
  if (route.workspaceId !== store.workspaceId) reject('CHANNEL_SCOPE_MISMATCH','Route belongs to another workspace.',403);
  authorize(receiver,projectId,'execution.request');
  const original = store.object(projectId,'feedback-case',caseId) as FeedbackCase | null;
  if (!original || original.id !== caseId || original.workspaceId !== route.workspaceId ||
      original.projectId !== projectId || digest(original.scope) !== digest(route.scope)) {
    return reject('FEEDBACK_CASE_UNKNOWN','A retained case in the registered route is required.',404);
  }
  return original;
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
  linear: LinearBinding,
) {
  const original = requireFeedbackCase(store,route,receiver,caseId);
  const {projectId} = original;
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

type IssueChange =
  | {kind:'needs-info'; triageRef:string; prompt:string}
  | {kind:'resume'; supplementEventKey:string}
  | {kind:'close'; windowId:string};

type StoredIssueChange = {
  intent: LinearIssueIntent;
  result: Exclude<LinearIssueResult,{status:'UNKNOWN'}> | null;
};

/** The worker may request more information using a retained triage reference.
 * Resumption uses the exact authenticated supplement already bound to this case. */
export async function changeFeedbackCaseIssue(
  store: RuntimeStore, route: RegisteredRoute, receiver: Principal, caseId: string,
  linear: LinearBinding, change: IssueChange,
): Promise<LinearIssueResult> {
  const {projectId} = requireFeedbackCase(store,route,receiver,caseId);
  const original = store.object(projectId,'feedback-case-issue-intent',caseId) as LinearCreateIntent | null;
  const initialReceipt = store.object(projectId,'feedback-case-issue',caseId) as LinearIssueReceipt | null;
  if (!original || !initialReceipt || original.scopeDigest !== digest(linear.scope) ||
      initialReceipt.issueId !== original.issueId || initialReceipt.intentId !== original.intentId) {
    return reject('LINEAR_ORIGINAL_REQUIRED','A confirmed original issue in its fixed scope is required.',409);
  }
  const sourceRef = string(change.kind === 'needs-info' ? change.triageRef :
    change.kind === 'resume' ? change.supplementEventKey : change.windowId);
  const closure = change.kind === 'close' ? readFeedbackClosureMerge(store,projectId,caseId,change.windowId) : null;
  let body: string;
  if (change.kind === 'needs-info') {
    body = change.prompt;
  } else if (closure) {
    if ((closure.source === 'FIXTURE') !== (initialReceipt.source === 'FIXTURE')) {
      return reject('FEEDBACK_CLOSURE_NOT_CONFIRMED','The original issue and merge require matching provider provenance.',409);
    }
    body = 'Merged PR #'+closure.pullRequestId+' at '+closure.mergeSha+'.';
  } else {
    const retained = store.object(projectId,'feedback-channel-event',sourceRef) as RetainedEvent | null;
    const action = retained?.event.action;
    if (!retained || retained.caseId !== caseId || retained.event.eventKey !== sourceRef ||
        digest(retained.event.scope) !== digest(route.scope) || action?.kind !== 'supplement' ||
        action.caseId !== caseId) {
      return reject('FEEDBACK_SUPPLEMENT_REQUIRED','Resumption requires an authenticated supplement to the original case.',409);
    }
    body = action.text;
  }

  const requestId = 'feedback-issue-change:'+digest({caseId,kind:change.kind,sourceRef});
  const readChange = (id: string) => store.object(projectId,'feedback-case-issue-change',id) as StoredIssueChange | null;
  const saved = readChange(requestId);
  if (saved && (saved.intent.kind !== change.kind || saved.intent.body !== body)) {
    return reject('LINEAR_CHANGE_CONFLICT','The original transition already binds different content.',409);
  }
  if (saved?.result) return saved.result;

  const current = store.object(projectId,'feedback-case-issue-latest',caseId) as string | null;
  const previous = current ? readChange(current) : null;
  if (!saved && current && previous?.result?.status !== 'CONFIRMED') {
    return reject('LINEAR_RECONCILE_ORIGINAL','Inspect the original issue change before making another.',409);
  }
  const prior = previous?.result?.status === 'CONFIRMED' ? previous.result.receipt : initialReceipt;
  const intent = saved?.intent ?? prepareLinearIssueIntent(linear.scope,{kind:change.kind,original,prior,requestId,body});
  if (!saved) {
    store.mutate(receiver,{
      projectId,operation:'feedback.case.issue.change.reserve',requestId,
      expectedRevision:store.revision(projectId),permission:'execution.request',input:{caseId,intentId:intent.intentId,sourceRef},
    },() => ({
      value:{intentId:intent.intentId,issueId:intent.issueId},
      objects:[
        {kind:'feedback-case-issue-change',id:requestId,value:{intent,result:null}},
        {kind:'feedback-case-issue-latest',id:caseId,value:requestId},
      ],
      event:{type:'feedback-case-issue-change-reserved',data:{caseId,issueId:intent.issueId,kind:change.kind}},
    }));
  }
  const result = saved ? await linear.adapter.reconcile(intent) : await linear.adapter.dispatch(intent,'RESERVED');
  if (result.status === 'UNKNOWN') return result;
  if (result.status === 'CONFIRMED' &&
      (result.receipt.intentId !== intent.intentId || result.receipt.originalIntentId !== original.intentId ||
       result.receipt.issueId !== original.issueId || result.receipt.scopeDigest !== intent.scopeDigest ||
       result.receipt.stateId !== intent.stateId || result.receipt.source !== initialReceipt.source ||
       result.receipt.descriptionDigest !== digest(linearIssueDescription(intent)))) {
    return reject('LINEAR_RECEIPT_MISMATCH','Issue readback does not match its original scoped transition.',409);
  }
  const concurrent = readChange(requestId)?.result;
  if (concurrent) {
    if (digest(concurrent) !== digest(result)) {
      return reject('LINEAR_RECEIPT_MISMATCH','Another readback retained different issue evidence.',409);
    }
    return concurrent;
  }
  store.mutate(receiver,{
    projectId,operation:'feedback.case.issue.change.resolve',requestId:requestId+':resolved',
    expectedRevision:store.revision(projectId),permission:'execution.request',input:{caseId,intentId:intent.intentId,result},
  },() => ({
    value:result,
    objects:[
      {kind:'feedback-case-issue-change',id:requestId,value:{intent,result}},
      ...(closure && result.status === 'CONFIRMED' ? [{
        kind:'feedback-case-closure',id:caseId,value:{
          windowId:sourceRef,issueId:result.receipt.issueId,mergeSha:closure.mergeSha,receiptIntentId:result.receipt.intentId,
        },
      }] : []),
    ],
    event:{type:'feedback-case-issue-change-resolved',data:{caseId,issueId:intent.issueId,kind:change.kind,status:result.status}},
  }));
  return result;
}
