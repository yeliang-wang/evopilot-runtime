import {randomUUID} from 'node:crypto';
import {lstatSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {canonicalEvidence as canonical,record,reject,string} from '../server/errors.js';
import {authorize,privateFile,type Principal} from '../server/security.js';
import {RuntimeStore} from '../server/store.js';
import {byteDigest} from '../lifecycle/base.js';
import {evidenceValueDigest as valueDigest} from '../server/errors.js';
import {inspectInstance,type LifecycleInstance} from '../lifecycle/instance.js';
import type {StageProgress,StageRequest} from '../lifecycle/execution.js';
import {nativeSha256,type NativeJSON,type NativeReference} from '../../vendor/compatibility/v1/native.mjs';
import {validateFeedbackEvent,type FeedbackEvent} from '../../vendor/compatibility/feedback/v1/feedback.mjs';
import type {NativeSourceScope} from '../native-types.js';
import {ownerRequestDigest,type Owner} from './published-owners.js';
import {verifyNativeStageResult,type NativeAction,type OwnerPin} from './stages.js';
import {MAX_ARCHIVE_BYTES,type VerifiedCiArtifact} from './artifacts.js';

interface EvaluationRun {
  schema:'runtime-stage-evaluation-run/v1';id:string;workspaceId:string;projectId:string;instanceId:string;
  requestId:string;requestDigest:string;planDigest:string;pinsDigest:string;inputDigest:string;claimId:string;
  authorityRef:string;stage:'SUCCEEDED'|'FAILED';source:NativeSourceScope;sourceTreeDigest:string;
  candidateDigest:string;pins:Record<Owner,NativeReference>;
  receipt:{schema:'runtime-stage-evaluation-receipt/v1';requestDigest:string;claimId:string;inputDigest:string;
    ciEvidenceDigest:string;ownerReceipts:Record<Owner,Record<string,unknown>>;observation:Record<string,unknown>;
    collectionRefs:{id:string;digest:string}[];stage:'SUCCEEDED'|'FAILED'};
  digest:string;
}
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function required(store:RuntimeStore,projectId:string,kind:string,id:string):Record<string,unknown>{
  const raw=store.object(projectId,kind,id);if(!raw)reject('FEEDBACK_RUN_INCOMPLETE','Original '+kind+' evidence is required',409);return record(raw);
}
/** Reconstruct a new Runtime-owned evaluation record from actual retained CI
 * and the original native actions/receipts. This is not a fabricated legacy
 * NativeRun and it cannot acquire execution or semantic approval authority. */
function evaluation(store:RuntimeStore,r:StageRequest,instance:LifecycleInstance,evidenceRef:string):EvaluationRun{
  const{digest,...requestBody}=r,p=record(r.plan.parameters),source=record(p.sourceScope),tree=record(p.sourceTree);
  if(r.schema!=='runtime-stage-request/v1'||digest!==valueDigest(requestBody)||r.planDigest!==valueDigest(r.plan)||r.plan.bindingDigest!==valueDigest(p)||r.plan.adapterId!=='runtime-ci-owner-stage-v2'||r.stageId!=='verification'||r.workspaceId!==store.workspaceId||r.projectId!==instance.pins.projectId||r.instanceId!==instance.id||r.pinsDigest!==instance.pinsDigest||!instance.candidateDigest||p.candidateDigest!==instance.candidateDigest||source.revision!==p.commit||source.requirementsDigest!==instance.pins.requirementsDigest||source.treeDigest!==tree.treeDigest||source.inventoryDigest!==tree.inventoryDigest)reject('FEEDBACK_RUN_MISMATCH','Feedback requires the original exact source-bound verification Run',409);
  const evidence=required(store,r.projectId,'ci-stage-evidence',evidenceRef),ci=required(store,r.projectId,'ci-stage-artifact',r.id) as unknown as VerifiedCiArtifact;
  if(valueDigest(evidence)!==evidenceRef||evidence.schema!=='runtime-ci-stage-evidence/v1'||evidence.requestId!==r.id||evidence.inputDigest!==r.inputDigest||!same(evidence.ci,ci)||ci.status!=='PASSED'||ci.candidateDigest!==instance.candidateDigest)reject('FEEDBACK_RUN_MISMATCH','Original verified candidate and collection evidence differ',409);
  const{schema:treeSchema,factsDigest:treeFactsDigest,observedAt:treeObservedAt,contentRead,linksFollowed,sourceApproved,...treeFacts}=tree;
  if(treeSchema!=='runtime-source-tree/v1'||treeFactsDigest!==valueDigest(treeFacts)||tree.inventoryDigest!==valueDigest(tree.entries)||tree.treeDigest!==valueDigest({schema:'runtime-git-tree-identity/v1',rootTreeId:tree.rootTreeId,inventoryDigest:tree.inventoryDigest})||tree.bindingDigest!==valueDigest(p.binding)||tree.commit!==p.commit||contentRead!==false||linksFollowed!==false||sourceApproved!==false)reject('FEEDBACK_RUN_MISMATCH','Original complete source inventory changed',409);
  if(!/^sha256:[a-f0-9]{64}$/.test(ci.archiveDigest))reject('FEEDBACK_RUN_MISMATCH','Original collection archive identity is invalid',409);
  const archive=join(store.root,'stage-ci-artifacts',ci.archiveDigest.slice(7)+'.zip');privateFile(archive);
  if(lstatSync(archive).size>MAX_ARCHIVE_BYTES||byteDigest(readFileSync(archive))!==ci.archiveDigest)reject('FEEDBACK_RUN_MISMATCH','Original collection archive bytes changed',409);
  const claimId=valueDigest({stageRequestDigest:r.digest}),pins={} as Record<Owner,NativeReference>,ownerReceipts={} as Record<Owner,Record<string,unknown>>,results=[];
  let observation:Record<string,unknown>|null=null;
  for(const owner of ['ontology','harness'] as const){
    const pin=record(record(p.owners)[owner]) as unknown as OwnerPin,a=required(store,r.projectId,'stage-native-action',r.id+':'+owner) as unknown as NativeAction,{digest:actionDigest,...actionBody}=a;
    const context={workspaceId:r.workspaceId,scope:{visibility:'private',projectId:r.projectId},projectCandidateDigest:instance.candidateDigest,claimId,inputDigest:r.inputDigest,effectiveConfigDigest:p.effectiveConfigDigest,sourceScopeDigest:nativeSha256(source),requirementSetDigest:instance.pins.requirementsDigest};
    if(actionDigest!==valueDigest(actionBody)||a.requestDigest!==ownerRequestDigest(owner,a.request)||!same(a.context,context)||!same(a.request.input.context,context)||a.request.input.id!==pin.reference.id||a.request.input.version!==pin.reference.version||!same(a.request.scope,pin.scope))reject('FEEDBACK_RUN_MISMATCH','Original native claim or asset context differs',409);
    const receipt=required(store,r.projectId,'stage-native-receipt',r.id+':'+owner),result=verifyNativeStageResult(receipt,owner,pin,a,string(p.toolchainLockDigest),string(p.effectiveConfigDigest));
    if(result.status==='UNKNOWN')reject('FEEDBACK_RUN_INCOMPLETE','Unknown owner results are not terminal evaluations',409);
    results.push(result);pins[owner]=pin.reference;ownerReceipts[owner]=receipt;
    if(owner==='harness'){
      observation=record(a.request.input.observation);
      if(a.observationDigest!==nativeSha256(observation)||observation.schema!=='evopilot-observation/v1'||observation.origin!=='execution-result'||observation.sourceScopeDigest!==nativeSha256(source)||!same(observation.source,{revision:p.commit,digest:source.treeDigest})||!same(observation.collectionReceiptRef,{id:'ci-stage:'+r.id,digest:ci.resultDigest,claimId}))reject('FEEDBACK_RUN_MISMATCH','Original observation and collection receipt differ',409);
    }
  }
  if(!same(evidence.owners,results)||!observation)reject('FEEDBACK_RUN_MISMATCH','Terminal owner results differ from the original stage evidence',409);
  const stage=results.every(r=>r.status==='PASS')?'SUCCEEDED' as const:'FAILED' as const;
  const receipt:EvaluationRun['receipt']={schema:'runtime-stage-evaluation-receipt/v1',requestDigest:r.digest,claimId,inputDigest:r.inputDigest,ciEvidenceDigest:evidenceRef,ownerReceipts,observation,collectionRefs:[{id:'ci-stage:'+r.id,digest:ci.resultDigest}],stage};
  const body={schema:'runtime-stage-evaluation-run/v1' as const,id:'verification:'+r.id,workspaceId:r.workspaceId,projectId:r.projectId,instanceId:r.instanceId,requestId:r.id,requestDigest:r.digest,planDigest:r.planDigest,pinsDigest:r.pinsDigest,inputDigest:r.inputDigest,claimId,authorityRef:r.authorityRef,stage,source:source as unknown as NativeSourceScope,sourceTreeDigest:string(tree.factsDigest),candidateDigest:instance.candidateDigest,pins,receipt};
  return{...body,digest:valueDigest(body)};
}
function feedback(run:EvaluationRun):FeedbackEvent{
  const scope={visibility:'private' as const,projectId:run.projectId};
  const body={schema:'evopilot-feedback-event/v1' as const,id:nativeSha256({workspaceId:run.workspaceId,scope,claimId:run.claimId}),workspaceId:run.workspaceId,scope,projectId:run.projectId,projectCandidateDigest:run.candidateDigest,source:run.source,runId:run.id,runReviewDigest:run.planDigest,claimId:run.claimId,inputDigest:run.inputDigest,receiptDigest:nativeSha256(run.receipt),causeId:run.claimId,origin:'registered-runtime-run' as const,stage:run.stage,pins:run.pins,results:run.receipt.ownerReceipts as Record<Owner,NativeJSON>,collectionRefs:run.receipt.collectionRefs,observation:run.receipt.observation as NativeJSON};
  const event={...body,digest:nativeSha256(body)};validateFeedbackEvent(event);return event;
}
/** Called only after the fixed adapter independently reads both original owner
 * receipts. The reader below additionally requires the core's terminal commit;
 * a crash between these steps cannot expose a completed Run. */
export function retainVerificationRun(store:RuntimeStore,r:StageRequest,instance:LifecycleInstance,evidenceRef:string,actor:Principal):void{
  authorize(actor,r.projectId,'read');const run=evaluation(store,r,instance,evidenceRef),event=feedback(run),old=store.object(r.projectId,'stage-evaluation-run',r.id),link={requestId:r.id,runDigest:run.digest};
  if(old){if(!same(old,run)||!same(store.object(r.projectId,'stage-feedback-source',event.id),link))reject('FEEDBACK_RUN_CHANGED','An original terminal evaluation cannot be replaced',409);return;}
  store.mutate(actor,{projectId:r.projectId,operation:'lifecycle.feedback.run-retained',requestId:'feedback-run-'+randomUUID(),expectedRevision:store.revision(r.projectId),input:{requestId:r.id,runDigest:run.digest},permission:'read'},()=>({objects:[{kind:'stage-evaluation-run',id:r.id,value:run},{kind:'stage-feedback-source',id:event.id,value:link}],value:{requestId:r.id,runDigest:run.digest,eventId:event.id},event:{type:'verification-run-retained',data:{instanceId:r.instanceId,requestId:r.id,runDigest:run.digest,eventId:event.id}}}));
}
/** Trusted event reader: accepts an ID, never a client-authored event or PASS.
 * It recomputes all retained Run links and requires the core's original terminal
 * outcome. Reading this history grants no owner write or current permission. */
export function readVerificationFeedback(store:RuntimeStore,actor:Principal,projectId:string,eventId:string):FeedbackEvent{
  authorize(actor,projectId,'read');if(!/^sha256:[a-f0-9]{64}$/.test(string(eventId,71)))reject('INVALID_REFERENCE','Exact feedback event ID required');
  const link=required(store,projectId,'stage-feedback-source',eventId),id=string(link.requestId),saved=required(store,projectId,'stage-evaluation-run',id) as unknown as EvaluationRun;
  const r=required(store,projectId,'stage-request',id) as unknown as StageRequest,instance=inspectInstance(required(store,projectId,'lifecycle-instance',r.instanceId) as unknown as LifecycleInstance),progress=required(store,projectId,'stage-progress',id) as unknown as StageProgress,stage=instance.stages.verification;
  const run=evaluation(store,r,instance,saved.receipt.ciEvidenceDigest),event=feedback(run),outcome=progress.observation?.outcome;
  if(r.projectId!==projectId||!same(saved,run)||link.runDigest!==run.digest||event.id!==eventId||!progress.terminal||progress.requestId!==id||!outcome||progress.phase!==(run.stage==='SUCCEEDED'?'COMPLETE':'FAILED')||stage?.status!==(run.stage==='SUCCEEDED'?'PASSED':'FAILED')||stage.requestId!==id||stage.inputDigest!==r.inputDigest||stage.outcomeDigest!==valueDigest(outcome)||outcome.requestId!==r.id||outcome.inputDigest!==r.inputDigest||outcome.receiptRef!=='runtime:ci-stage/'+r.id||!same(outcome.checks.map(c=>c.id).sort(),[...instance.definition.nodes.find(n=>n.id==='verification')!.checks].sort())||outcome.checks.some(c=>c.evidenceRef!==run.receipt.ciEvidenceDigest||c.status!==(run.stage==='SUCCEEDED'?'PASS':'FAIL')))reject('FEEDBACK_RUN_NOT_TERMINAL','The original verified Run has not reached its committed terminal outcome',409);
  return event;
}
export function readVerificationFeedbackForRequest(store:RuntimeStore,actor:Principal,r:StageRequest):FeedbackEvent{
  authorize(actor,r.projectId,'read');if(r.stageId!=='verification')reject('STAGE_SCOPE','Feedback requires the original verification request',409);
  const id=nativeSha256({workspaceId:store.workspaceId,scope:{visibility:'private',projectId:r.projectId},claimId:valueDigest({stageRequestDigest:r.digest})});
  return readVerificationFeedback(store,actor,r.projectId,id);
}
