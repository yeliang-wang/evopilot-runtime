import { nativeAssertJSON, nativeExact, nativeText, nativeDigest, nativeSha256, nativeFrozenClone } from '../vendor/compatibility/v1/native.mjs';
import type { NativeScope, NativeJSON } from '../vendor/compatibility/v1/native.mjs';
import { verifyDecisionEvidence } from '../vendor/compatibility/v1/decision-evidence.mjs';
import { createFeedbackStore, feedbackEqual as same, feedbackFail as fail, feedbackScope, feedbackBounded, validateFeedbackEvent, validateFeedbackReceipt } from '../vendor/compatibility/feedback/v1/feedback.mjs';
import type { FeedbackEnvelope, FeedbackEvent, FeedbackOutbox, FeedbackInbox, FeedbackOwner, FeedbackDisposition } from '../vendor/compatibility/feedback/v1/feedback.mjs';
import type { Store } from './types.js';
import type { NativeRun, NativeProject, NativeRuntimeProviders } from './native-types.js';
export type * from '../vendor/compatibility/feedback/v1/feedback.mjs';
export interface RuntimeFeedbackProviders {
 deliverFeedback?: (input:{owner:FeedbackOwner;event:FeedbackEvent})=>Promise<FeedbackInbox>|FeedbackInbox;
 readFeedbackInbox?: (input:{owner:FeedbackOwner;scope:NativeScope;id:string})=>Promise<FeedbackInbox|null>|FeedbackInbox|null;
}
export interface FeedbackCompletion {eventId:string;eventDigest:string;dispositions:{ontology:string;harness:string}}
export const RUNTIME_FEEDBACK_OPERATIONS=['feedback.inspect','feedback.configure','feedback.list','feedback.read','feedback.event','feedback.capture','feedback.deliver','feedback.refresh'] as const;
export function createRuntimeFeedback(store:Store,providers:NativeRuntimeProviders,access:{run:(scope:NativeScope,id:string)=>Promise<NativeRun>;project:(scope:NativeScope,id:string)=>Promise<NativeProject>;verify:(run:NativeRun)=>Promise<void>}) {
 const state=createFeedbackStore(store,'runtime');let active=0;
 function enabled(scope:NativeScope,projectId:string):boolean{return !!state.get(scope,'configuration',projectId);}
 function eventFor(run:NativeRun):FeedbackEvent {
  if(!run.claim||!run.receipt||!['SUCCEEDED','FAILED'].includes(run.stage))fail('FEEDBACK_NOT_TERMINAL','Verified registered terminal Run required');
  const p=run.plan,subject={schema:'evopilot-feedback-event/v1' as const,id:nativeSha256({workspaceId:store.identity.id,scope:p.scope,claimId:run.claim.claimId}),workspaceId:store.identity.id,scope:p.scope,projectId:p.projectId,projectCandidateDigest:p.input.projectCandidateDigest,source:p.input.sourceScope,runId:p.id,runReviewDigest:run.reviewDigest,claimId:run.claim.claimId,inputDigest:run.claim.inputDigest,receiptDigest:nativeSha256(run.receipt),causeId:run.claim.claimId,origin:'registered-runtime-run' as const,stage:run.stage as 'SUCCEEDED'|'FAILED',pins:p.pins,results:JSON.parse(JSON.stringify(run.receipt.ownerReceipts)) as {ontology:NativeJSON;harness:NativeJSON},collectionRefs:p.input.collectionReceipts,observation:p.input.nativeInputs.harness};
  const event={...subject,digest:nativeSha256(subject)};validateFeedbackEvent(event);return event;
 }
 function capture(run:NativeRun,recordTransition=true):FeedbackOutbox|null {
  if(!enabled(run.plan.scope,run.plan.projectId)||!run.receipt||!['SUCCEEDED','FAILED'].includes(run.stage))return null;
  const event=eventFor(run),old=state.get<FeedbackOutbox>(event.scope,'outbox',event.id);
  if(old){if(!same(old.event,event))fail('EVENT_CONFLICT');return old;}
  const record:FeedbackOutbox={event,destinations:{ontology:null,harness:null},dispositions:{ontology:null,harness:null},errors:{ontology:'FEEDBACK_PENDING',harness:'FEEDBACK_PENDING'}};
  state.put(event.scope,'outbox',event.id,record);if(recordTransition)state.recordTransition({operation:'registered-run-terminal',eventId:event.id},record);return record;
 }
 function outbox(scope:NativeScope,id:string):FeedbackOutbox {nativeDigest(id);const r=state.get<FeedbackOutbox>(scope,'outbox',id);if(!r)fail('NOT_FOUND');validateFeedbackEvent(r.event);if(!same(r.event.scope,scope)||r.event.workspaceId!==store.identity.id)fail('SCOPE_MISMATCH');return r;}
 async function verifyEvent(event:FeedbackEvent):Promise<void> {const run=await access.run(event.scope,event.runId);await access.verify(run);if(!same(eventFor(run),event))fail('EVENT_CONFLICT');}
 function disposition(value:FeedbackDisposition|null,event:FeedbackEvent,owner:FeedbackOwner):FeedbackDisposition|null {
  if(!value)return null;const {digest,...body}=value;const {reviewDigest,...review}=value.review;
  if(digest!==nativeSha256(body)||reviewDigest!==nativeSha256(review)||value.review.eventId!==event.id||value.review.eventDigest!==event.digest||value.review.owner!==owner||!same(value.review.scope,event.scope)||value.review.workspaceId!==event.workspaceId||!same(value.review.baseline,event.pins[owner])||value.review.sourceDigest!==nativeSha256(event.source))fail('DISPOSITION_MISMATCH');
  return value;
 }
 async function inspectOwners(event:FeedbackEvent,deliver:boolean){
  if(!providers.readFeedbackInbox||deliver&&!providers.deliverFeedback)fail('MISSING_FEEDBACK_PROVIDER');
  const found:{[P in FeedbackOwner]:FeedbackInbox|null}={ontology:null,harness:null};const errors:{[P in FeedbackOwner]:string|null}={ontology:null,harness:null};
  for(const owner of ['ontology','harness'] as const)try {
   let record=await feedbackBounded(()=>providers.readFeedbackInbox!({owner,scope:event.scope,id:event.id}));
   if(!record&&deliver)record=await feedbackBounded(()=>providers.deliverFeedback!({owner,event}));
   if(record){if(!same(record.event,event))fail('EVENT_CONFLICT');validateFeedbackReceipt(record.receipt,event,owner);disposition(record.disposition,event,owner);found[owner]=record;}
   else errors[owner]='FEEDBACK_PENDING';
  }catch(error){errors[owner]=String((error as {code?:string}).code??'FEEDBACK_UNAVAILABLE');}
  return {found,errors};
 }
 async function verifyComplete(run:NativeRun):Promise<FeedbackCompletion|null> {
  if(!enabled(run.plan.scope,run.plan.projectId))return null;
  const event=eventFor(run),record=outbox(event.scope,event.id);await verifyEvent(event);
  const {found,errors}=await inspectOwners(event,false);
  for(const owner of ['ontology','harness'] as const) {
   if(errors[owner]||!record.destinations[owner]||!record.dispositions[owner]||!found[owner]?.disposition||found[owner]!.disposition!.decision!=='APPROVE'||!same(record.dispositions[owner],found[owner]!.disposition))fail('FEEDBACK_PENDING','Both owners need current reviewed disposition; refresh retained receipts');
   if(!same(found[owner]!.disposition!.review.reference,run.plan.pins[owner]))fail('FEEDBACK_NEW_RUN_REQUIRED','The completed Run must evaluate the final exact assets');
   const d=found[owner]!.disposition!;verifyDecisionEvidence(d.humanEvidenceRef,{owner,operation:'feedback.decide',workspaceId:event.workspaceId,scope:event.scope,reviewDigest:d.review.reviewDigest,decision:'APPROVE'});
  }
  return {eventId:event.id,eventDigest:event.digest,dispositions:{ontology:found.ontology!.disposition!.digest,harness:found.harness!.disposition!.digest}};
 }
 async function feedbackBody(r:FeedbackEnvelope):Promise<unknown> {
  nativeAssertJSON(r);feedbackScope(r.scope);if(!RUNTIME_FEEDBACK_OPERATIONS.includes(r.operation as typeof RUNTIME_FEEDBACK_OPERATIONS[number]))fail('INVALID_OPERATION');
  const write=['feedback.configure','feedback.capture','feedback.deliver','feedback.refresh'].includes(r.operation);nativeExact(r,['operation','scope','input',...(write?['requestId','expectedRevision']:[])]);
  if(r.operation==='feedback.inspect'){nativeExact(r.input,[]);return {...state.inspect(r.scope),configurations:state.list(r.scope,'configuration'),pending:state.list<FeedbackOutbox>(r.scope,'outbox').filter(x=>!x.dispositions.ontology||!x.dispositions.harness).length};}
  if(r.operation==='feedback.list'){nativeExact(r.input,[]);return state.list(r.scope,'outbox');}
  if(r.operation==='feedback.configure'){
   nativeExact(r.input,['projectId']);nativeText(r.input.projectId);const project=await access.project(r.scope,r.input.projectId);if(project.complete)fail('ALREADY_COMPLETE');
   return state.mutate(r,()=>{const config={projectId:project.id,projectCandidateDigest:project.candidateDigest,enabled:true,owners:['ontology','harness'],automaticStage:'durable-capture-only',unregisteredHostCapture:false};const old=state.get(r.scope,'configuration',project.id);if(old&&!same(old,config))fail('CONFIGURATION_CONFLICT');state.put(r.scope,'configuration',project.id,config);return config;});
  }
  if(r.operation==='feedback.capture') {nativeExact(r.input,['runId']);nativeText(r.input.runId);const run=await access.run(r.scope,r.input.runId);await access.verify(run);if(!enabled(r.scope,run.plan.projectId))fail('FEEDBACK_NOT_CONFIGURED');return state.mutate(r,()=>capture(run,false));}
  nativeExact(r.input,['id']);nativeDigest(r.input.id);const record=outbox(r.scope,r.input.id);
  if(r.operation==='feedback.read')return record;
  await verifyEvent(record.event);
  if(r.operation==='feedback.event')return record.event;
  // Persist the caller's delivery intent before external owner writes. Same request replay returns it.
  const admission=state.mutate(r,()=>({eventId:record.event.id,eventDigest:record.event.digest,stage:'ADMITTED',operation:r.operation}));
  const completionId='feedback-done-'+nativeSha256({requestId:r.requestId,scope:r.scope}).slice(7,47);
  const existing=state.receipt(r.scope,completionId);if(existing)return existing;
  const {found,errors}=await inspectOwners(record.event,r.operation==='feedback.deliver');
  return state.mutate({operation:'feedback.internal-complete',scope:r.scope,input:{id:record.event.id,admissionDigest:admission.digest},requestId:completionId,expectedRevision:state.inspect(r.scope).revision},()=>{
   const current=outbox(r.scope,record.event.id);for(const owner of ['ontology','harness'] as const){if(found[owner]){current.destinations[owner]=found[owner]!.receipt;current.dispositions[owner]=found[owner]!.disposition;}current.errors[owner]=errors[owner];}
   state.put(r.scope,'outbox',record.event.id,current);return current;
  });
 }
 async function feedback(r:FeedbackEnvelope):Promise<unknown>{active++;try{return await feedbackBody(r);}finally{active--;}}
 function assertQuiescent():void{if(active)fail('BUSY','Feedback operation is still in progress');}
 async function deliverRun(run:NativeRun):Promise<void> {
  if(!enabled(run.plan.scope,run.plan.projectId)||!run.receipt||!['SUCCEEDED','FAILED'].includes(run.stage))return;
  const event=eventFor(run);
  // A failed delivery retains its admitted intent and pending outbox. It cannot undo or repeat the Run.
  try {await feedback({operation:'feedback.deliver',scope:event.scope,input:{id:event.id},requestId:'auto-'+event.id.slice(7,55),expectedRevision:state.inspect(event.scope).revision});}catch(error) {
   const code=String((error as {code?:string}).code??'FEEDBACK_UNAVAILABLE');
   state.mutate({operation:'feedback.internal-failure',scope:event.scope,input:{id:event.id,code},requestId:'auto-failure-'+event.id.slice(7,55),expectedRevision:state.inspect(event.scope).revision},()=>{const current=outbox(event.scope,event.id);for(const owner of ['ontology','harness'] as const)if(!current.destinations[owner])current.errors[owner]=code;state.put(event.scope,'outbox',event.id,current);return current;});
  }
 }
 return {feedback,capture,verifyComplete,deliverRun,assertQuiescent};
}
