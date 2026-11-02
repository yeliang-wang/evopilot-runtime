import { randomUUID } from 'node:crypto';
import { canonical, exact, record, reject, ServiceError, string } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import { RuntimeStore } from '../server/store.js';
import { valueDigest } from '../lifecycle/base.js';
import { containsInlineSecret } from '../lifecycle/compiler.js';
import { nativeSha256, validateNativeReference } from '../../vendor/compatibility/v1/native.mjs';
import { verifyDecisionEvidence } from '../../vendor/compatibility/v1/decision-evidence.mjs';
import { validateFeedbackEvent, validateFeedbackReceipt, type FeedbackEvent } from '../../vendor/compatibility/feedback/v1/feedback.mjs';
import { ownerRequestDigest, type Owner, type OwnerRequest, type PublishedOwnerAdapter } from './published-owners.js';

export type FeedbackState='PENDING'|'UNKNOWN'|'REVIEW_REQUIRED'|'REJECTED'|'REBIND_REQUIRED'|'REUSE_APPROVED';
export interface FeedbackObservation {status:FeedbackState;receiptDigest:string|null;dispositionDigest:string|null;softwareRelease:false;}
export interface FeedbackDelivery {
  schema:'runtime-owner-feedback-delivery/v1'; eventId:string; eventDigest:string; owner:Owner;
  registrationDigest:string; request:OwnerRequest; requestDigest:string; digest:string;
  initiatedBy:{id:string;revision:number};
}
export interface FeedbackConnections {
  /** Recompute/read an existing registered terminal Run. Never accept an event
   * supplied by an HTTP caller, a raw CI PASS or a future lifecycle result. */
  event(actor:Principal,projectId:string,id:string):Promise<FeedbackEvent>;
  owner(event:FeedbackEvent,owner:Owner):PublishedOwnerAdapter;
}
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const absent=():FeedbackObservation=>({status:'PENDING',receiptDigest:null,dispositionDigest:null,softwareRelease:false});
const unknown=():FeedbackObservation=>({...absent(),status:'UNKNOWN'});
function checkedEvent(event:FeedbackEvent,workspaceId:string,projectId:string,id:string):FeedbackEvent{
  validateFeedbackEvent(event);
  if(event.workspaceId!==workspaceId||event.projectId!==projectId||event.scope.projectId!==projectId||event.id!==id)reject('FEEDBACK_SCOPE','Feedback belongs to another registered project',403);
  if(containsInlineSecret(canonical(event)))reject('INLINE_SECRET','Feedback cannot contain raw credentials');
  return JSON.parse(canonical(event)) as FeedbackEvent;
}
/** Independent readback verifies the owner receipt and its actual decision
 * evidence. Delivery and an approved new asset never close the old asset pins. */
export function verifyOwnerFeedbackInbox(value:unknown,event:FeedbackEvent,owner:Owner):FeedbackObservation{
  validateFeedbackEvent(event);const inbox=record(value);
  exact(inbox,['event','receipt','candidate','review','disposition']);
  if(!same(inbox.event,event))reject('FEEDBACK_EVENT_CHANGED','Owner inbox contains a different event');
  validateFeedbackReceipt(inbox.receipt,event,owner);
  const receipt=record(inbox.receipt),candidate=record(inbox.candidate);
  exact(candidate,['id','kind','evidenceDigest','status']);
  if(candidate.id!==receipt.candidateId||candidate.kind!==(owner==='ontology'?'semantic-impact':'regression')||candidate.evidenceDigest!==event.receiptDigest||candidate.status!=='REVIEW_REQUIRED')reject('FEEDBACK_INBOX_CHANGED','Owner feedback candidate differs from its event');
  const result:FeedbackObservation={status:'REVIEW_REQUIRED',receiptDigest:String(receipt.digest),dispositionDigest:null,softwareRelease:false};
  if(inbox.review===null){if(inbox.disposition!==null)reject('FEEDBACK_REVIEW_REQUIRED','A disposition requires the exact owner review');return result;}
  const review=record(inbox.review);exact(review,['mode','reference','rationale','changes','eventId','eventDigest','owner','workspaceId','scope','sourceDigest','baseline','changedFiles','dependentHarness','reviewDigest']);
  const {reviewDigest,...body}=review;
  if(reviewDigest!==nativeSha256(body)||review.eventId!==event.id||review.eventDigest!==event.digest||review.owner!==owner||review.workspaceId!==event.workspaceId||!same(review.scope,event.scope)||review.sourceDigest!==nativeSha256(event.source)||!same(review.baseline,event.pins[owner]))reject('FEEDBACK_REVIEW_CHANGED','Review does not bind the exact event and published baseline');
  string(review.rationale,65536);validateNativeReference(review.reference,{product:owner,visibility:event.scope.visibility});
  const reference=record(review.reference);
  if(reference.id!==event.pins[owner].id||!['REUSE','DELIVER'].includes(String(review.mode))||!Array.isArray(review.changes)||review.changes.length>256||!Array.isArray(review.changedFiles)||review.changedFiles.length>10000||!Array.isArray(review.dependentHarness)||review.dependentHarness.length>256)reject('FEEDBACK_REVIEW_CHANGED','Invalid owner review scope');
  review.changedFiles.forEach(x=>string(x,4096));review.dependentHarness.forEach(x=>validateNativeReference(x,{product:'harness'}));
  for(const raw of review.changes){const change=record(raw);exact(change,['kind','identifiers','sourcePaths','explanation']);string(change.explanation,65536);
    if(!['relation','cardinality','deprecation','rule','source','other'].includes(String(change.kind)))reject('FEEDBACK_REVIEW_CHANGED','Invalid change kind');
    for(const key of ['identifiers','sourcePaths']){const values=change[key];if(!Array.isArray(values)||!values.length||values.length>256)reject('FEEDBACK_REVIEW_CHANGED','Invalid change mapping');values.forEach(x=>string(x,4096));}
  }
  if(review.mode==='REUSE'?(!same(review.reference,event.pins[owner])||review.changes.length!==0||review.changedFiles.length!==0):(same(review.reference,event.pins[owner])||!review.changes.length||!review.changedFiles.length))reject('FEEDBACK_REVIEW_CHANGED','REUSE and DELIVER must retain their original owner semantics');
  if(inbox.disposition===null)return result;
  const disposition=record(inbox.disposition);exact(disposition,['review','decision','humanEvidenceRef','digest']);
  const {digest,...decision}=disposition;
  if(digest!==nativeSha256(decision)||!same(disposition.review,review)||!['APPROVE','REJECT'].includes(String(disposition.decision)))reject('FEEDBACK_DISPOSITION_CHANGED','Disposition does not match the exact review');
  try{verifyDecisionEvidence(string(disposition.humanEvidenceRef,8192),{owner,operation:'feedback.decide',workspaceId:event.workspaceId,scope:event.scope,reviewDigest:String(reviewDigest),decision:disposition.decision as 'APPROVE'|'REJECT'});}
  catch{return reject('FEEDBACK_DECISION_EVIDENCE','The retained exact owner decision evidence is unavailable or changed',409);}
  return{...result,status:disposition.decision==='REJECT'?'REJECTED':review.mode==='DELIVER'?'REBIND_REQUIRED':'REUSE_APPROVED',dispositionDigest:String(digest)};
}

async function bounded<T>(call:(signal:AbortSignal)=>Promise<T>,signal:AbortSignal):Promise<T>{
  signal.throwIfAborted();const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,onAbort=()=>{};
  try{return await Promise.race([Promise.resolve().then(()=>{controller.signal.throwIfAborted();return call(controller.signal);}),new Promise<never>((_resolve,fail)=>{
    onAbort=()=>{controller.abort();fail(new ServiceError('FEEDBACK_OUTCOME_UNKNOWN','Inspect the original retained owner event',409));};
    signal.addEventListener('abort',onAbort,{once:true});timer=setTimeout(onAbort,5000);if(signal.aborted)onAbort();
  })]);}finally{if(timer)clearTimeout(timer);signal.removeEventListener('abort',onAbort);}
}

/** Internal delivery component for the fixed stage composition. No HTTP/YAML
 * method can capture arbitrary events or provide an owner result. Each owner
 * call is durably recorded before dispatch. Recovery is read-only, including
 * crashes before the call; uncertainty cannot grant a replacement attempt. */
export function createOwnerFeedbackDelivery(store:RuntimeStore,connections:FeedbackConnections){
  const inFlight=new Set<string>();
  const observer=(projectId:string):Principal=>({id:'runtime:feedback',projects:[projectId],permissions:['read'],revision:1,expiresAt:new Date(Date.now()+60000).toISOString()});
  function event(projectId:string,id:string):FeedbackEvent{
    const value=store.object(projectId,'owner-feedback-event',id);if(!value)reject('NOT_FOUND','Retained registered feedback event not found',404);
    return checkedEvent(value as FeedbackEvent,store.workspaceId,projectId,id);
  }
  function save(projectId:string,kind:string,id:string,value:unknown):void{
    store.mutate(observer(projectId),{projectId,operation:'lifecycle.feedback.'+kind,requestId:'feedback-'+randomUUID(),expectedRevision:store.revision(projectId),input:{id,digest:valueDigest(value)},permission:'read'},()=>({objects:[{kind,id,value}],value:{id,digest:valueDigest(value)},event:{type:'owner-feedback-observed',data:{kind,id,digest:valueDigest(value)}}}));
  }
  function adapter(e:FeedbackEvent,owner:Owner):PublishedOwnerAdapter{
    if(owner!=='ontology'&&owner!=='harness')reject('UNSUPPORTED_OWNER','Unsupported feedback destination');
    const a=connections.owner(e,owner);if(a.owner!==owner||a.workspaceId!==e.workspaceId)reject('FEEDBACK_SCOPE','Owner connection differs from the event',403);return a;
  }
  function delivery(projectId:string,id:string):FeedbackDelivery|null{
    const value=store.object(projectId,'owner-feedback-delivery',id);if(!value)return null;
    const d=value as FeedbackDelivery,{digest,...body}=d;
    if(d.schema!=='runtime-owner-feedback-delivery/v1'||valueDigest(body)!==digest||ownerRequestDigest(d.owner,d.request)!==d.requestDigest)reject('CORRUPT_FEEDBACK_DELIVERY','Retained original owner request changed',503);return d;
  }
  async function inspect(actor:Principal,projectId:string,eventId:string,owner:Owner,signal:AbortSignal):Promise<FeedbackObservation>{
    authorize(actor,projectId,'read');const e=event(projectId,eventId),a=adapter(e,owner),original=delivery(projectId,eventId+':'+owner);let result:FeedbackObservation;
    if(original&&(original.eventDigest!==e.digest||record(a.capabilities()).registrationDigest!==original.registrationDigest))reject('FEEDBACK_CONNECTION_CHANGED','Read the original pinned owner connection; a changed registration cannot replace its receipt',409);
    try{const inbox=await bounded(()=>a.read(actor,projectId,{operation:'feedback.read',scope:e.scope,input:{id:e.id}}),signal);result=verifyOwnerFeedbackInbox(inbox,e,owner);const retained=store.object(projectId,'owner-feedback-inbox',eventId+':'+owner);if(!same(retained,inbox))save(projectId,'owner-feedback-inbox',eventId+':'+owner,inbox);}
    catch(error){if(error instanceof ServiceError&&error.code==='NOT_FOUND')result=delivery(projectId,eventId+':'+owner)?unknown():absent();else throw error;}
    const id=eventId+':'+owner,old=store.object(projectId,'owner-feedback-observation',id);
    if(!same(old,result))save(projectId,'owner-feedback-observation',id,result);return result;
  }
  async function retain(actor:Principal,projectId:string,id:string,signal:AbortSignal):Promise<FeedbackEvent>{
    authorize(actor,projectId,'execution.request');const source=await bounded(()=>connections.event(actor,projectId,id),signal),e=checkedEvent(source,store.workspaceId,projectId,id);
    signal.throwIfAborted();authorize(actor,projectId,'execution.request');
    const old=store.object(projectId,'owner-feedback-event',id);
    if(old&&!same(old,e))reject('FEEDBACK_EVENT_CHANGED','An original registered event cannot be replaced');
    if(!old)save(projectId,'owner-feedback-event',id,e);return e;
  }
  async function deliver(actor:Principal,projectId:string,eventId:string,owner:Owner,permit:()=>Promise<{actor:Principal;authorityRef:string;expiresAt:string}>,signal:AbortSignal):Promise<FeedbackObservation>{
    authorize(actor,projectId,'execution.request');const e=event(projectId,eventId),id=eventId+':'+owner,key=projectId+'\0'+id;
    if(inFlight.has(key))return inspect(actor,projectId,eventId,owner,signal);
    inFlight.add(key);
    try{
      const observed=await inspect(actor,projectId,eventId,owner,signal);
      if(observed.receiptDigest||delivery(projectId,id))return observed;
      const a=adapter(e,owner),identity=record(a.capabilities()),registrationDigest=string(identity.registrationDigest,71);
      const state=record(await bounded(()=>a.read(actor,projectId,{operation:'feedback.inspect',scope:e.scope,input:{}}),signal));
      if(state.owner!==owner||state.workspaceId!==e.workspaceId||!same(state.scope,e.scope)||!Number.isSafeInteger(state.revision)||Number(state.revision)<0)reject('FEEDBACK_SCOPE','Owner feedback revision is not bound to this event');
      const request:OwnerRequest={operation:'feedback.ingest',scope:e.scope,input:{id:e.id,digest:e.digest},requestId:'runtime-feedback-'+nativeSha256({workspaceId:e.workspaceId,projectId,eventId,owner}).slice(7),expectedRevision:Number(state.revision)};
      const subject={schema:'runtime-owner-feedback-delivery/v1' as const,eventId,eventDigest:e.digest,owner,registrationDigest,request,requestDigest:ownerRequestDigest(owner,request),initiatedBy:{id:actor.id,revision:actor.revision}};
      signal.throwIfAborted();save(projectId,'owner-feedback-delivery',id,{...subject,digest:valueDigest(subject)});
      // Never use the mutation response as completion evidence. Even a timeout
      // after the owner committed is resolved only through feedback.read.
      try{
        await bounded(async inner=>{
          const grant=await permit();inner.throwIfAborted();authorize(grant.actor,projectId,'execution.request');
          if(grant.actor.id!==actor.id||grant.actor.revision!==actor.revision||record(adapter(e,owner).capabilities()).registrationDigest!==registrationDigest)reject('FEEDBACK_AUTHORITY_CHANGED','Original actor or owner connection changed',403);
          string(grant.authorityRef,512);
          if(!Number.isFinite(Date.parse(grant.expiresAt))||Date.parse(grant.expiresAt)<=Date.now())reject('FEEDBACK_AUTHORITY_CHANGED','Feedback authority is expired',403);
          save(projectId,'owner-feedback-permit',id,{requestDigest:subject.requestDigest,authorityRef:grant.authorityRef,expiresAt:grant.expiresAt,principalId:grant.actor.id,principalRevision:grant.actor.revision});
          return a.mutate(grant.actor,projectId,request,{projectId,owner,requestDigest:subject.requestDigest,authorityRef:grant.authorityRef,expiresAt:grant.expiresAt});
        },signal);
      }catch(error){
        const observation={...unknown(),reason:error instanceof ServiceError?error.code:'OWNER_OUTCOME_UNKNOWN'};
        save(projectId,'owner-feedback-observation',id,observation);return unknown();
      }
      return inspect(actor,projectId,eventId,owner,signal);
    }finally{inFlight.delete(key);}
  }
  return{retain,deliver,inspect,readEvent:async(actor:Principal,projectId:string,id:string)=>{authorize(actor,projectId,'read');return event(projectId,id);}};
}
