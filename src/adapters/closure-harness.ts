import {randomUUID} from 'node:crypto';
import {canonicalEvidence as canonical,record,reject,ServiceError} from '../server/errors.js';
import {authorize,type Principal} from '../server/security.js';
import {RuntimeStore} from '../server/store.js';
import {evidenceValueDigest as valueDigest} from '../server/errors.js';
import type {LifecycleInstance} from '../lifecycle/instance.js';
import type {StageRequest} from '../lifecycle/execution.js';
import {readIntegrationConfiguration} from './config.js';
import {verifyNativeStageResult,type NativeStageConnections,type NativeAction,type OwnerResult} from './stages.js';
import {ownerRequestDigest,type OwnerRequest} from './published-owners.js';
import {nativeSha256,type NativeValidationContext} from '../../vendor/compatibility/v1/native.mjs';
import {createPublicationHarness,type PublicationHarnessPin} from './publication-harness.js';
import type {DistributionObservation} from './distribution.js';
import type {InstallationObservation} from './installation.js';
import type {VerifiedDeliverySmoke} from './delivery-smoke.js';

export interface ClosureHarnessInput {
  smoke:VerifiedDeliverySmoke;distribution:Omit<DistributionObservation,'observedAt'>;
  installation:Omit<InstallationObservation,'observedAt'>|null;
  publicationEvidenceDigest:string;feedbackEventDigest:string;
}
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const unknown=():OwnerResult=>({owner:'harness',status:'UNKNOWN',receiptDigest:null,reportDigest:null});
/** Fixed native consumer for selected delivery observations. Publication quality
 * is a separate historical result; this action evaluates actual closure input. */
export function createClosureHarness(store:RuntimeStore,configPath:string,connections:NativeStageConnections){
  const selected=createPublicationHarness(store,configPath,connections);
  function owner(p:PublicationHarnessPin,projectId:string){selected.current(p,projectId);return connections.owner(p.owner.ref,readIntegrationConfiguration(configPath,store.workspaceId));}
  function retain(actor:Principal,r:StageRequest,kind:string,value:unknown){
    const old=store.object(r.projectId,kind,r.id);if(old){if(!same(old,value))reject('CLOSURE_HARNESS_CHANGED','Original delivery evaluation cannot be replaced',409);return;}
    store.mutate(actor,{projectId:r.projectId,operation:'lifecycle.closure.harness',requestId:'closure-harness-'+randomUUID(),expectedRevision:store.revision(r.projectId),input:{stageRequestId:r.id,kind,digest:valueDigest(value)},permission:'read'},()=>({objects:[{kind,id:r.id,value}],value:{kind},event:{type:'closure-harness-retained',data:{stageRequestId:r.id,kind}}}));
  }
  function action(r:StageRequest):NativeAction|null{
    const a=store.object(r.projectId,'closure-harness-action',r.id) as NativeAction|null;if(!a)return null;
    const{digest,...body}=a;if(digest!==valueDigest(body)||a.requestDigest!==ownerRequestDigest('harness',a.request))reject('CORRUPT_CLOSURE','Original delivery Harness action changed',503);return a;
  }
  function input(r:StageRequest,i:LifecycleInstance,p:PublicationHarnessPin,values:ClosureHarnessInput){
    const{digest,...body}=r,{schema,factsDigest,releaseAuthorized,...distribution}=values.distribution,{digest:smokeDigest,...smoke}=values.smoke;
    if(digest!==valueDigest(body)||r.stageId!=='closure'||r.workspaceId!==store.workspaceId||r.projectId!==i.pins.projectId||r.instanceId!==i.id||r.pinsDigest!==i.pinsDigest||r.planDigest!==valueDigest(r.plan)||!same(r.plan.parameters.harness,p)||values.smoke.status!=='PASSED'||values.smoke.ci.candidateDigest!==i.candidateDigest||smokeDigest!==valueDigest(smoke)||schema!=='runtime-distribution-observation/v1'||factsDigest!==valueDigest(distribution)||releaseAuthorized!==false||distribution.status!=='PASSED'||distribution.candidateDigest!==i.candidateDigest||distribution.projectId!==r.projectId||r.plan.parameters.publicationEvidenceDigest!==values.publicationEvidenceDigest||r.plan.parameters.feedbackEventDigest!==values.feedbackEventDigest)reject('CLOSURE_HARNESS_INPUT','Delivery evaluation requires the original exact closure observations',409);
    if(values.smoke.smoke.target.mode==='distribution'?values.installation!==null:!values.installation||values.installation.status!=='PASSED'||values.installation.factsDigest!==values.smoke.installationFactsDigest)reject('CLOSURE_HARNESS_INPUT','Selected installation and smoke must describe the same actual target',409);
    const context:NativeValidationContext={workspaceId:r.workspaceId,scope:{visibility:'private',projectId:r.projectId},projectCandidateDigest:i.candidateDigest!,claimId:valueDigest({stageRequestDigest:r.digest}),inputDigest:r.inputDigest,effectiveConfigDigest:p.effectiveConfigDigest,sourceScopeDigest:i.candidate!.sourceDigest,requirementSetDigest:i.pins.requirementsDigest};
    const evidence={schema:'runtime-closure-observation/v1',requestDigest:r.digest,planDigest:r.planDigest,candidateDigest:i.candidateDigest,...values},evidenceDigest=valueDigest(evidence);
    const observation={schema:'evopilot-observation/v1',origin:'execution-result',source:{revision:distribution.commit,digest:context.sourceScopeDigest},values:{runtimeClosure:evidence},collectionReceiptRef:{id:'closure:'+r.id,digest:evidenceDigest,claimId:context.claimId},sourceScopeDigest:context.sourceScopeDigest};return{context,evidence,observation};
  }
  async function inspect(r:StageRequest,i:LifecycleInstance,p:PublicationHarnessPin,values:ClosureHarnessInput,actor:Principal,signal:AbortSignal):Promise<OwnerResult>{
    authorize(actor,r.projectId,'read');signal.throwIfAborted();const current=input(r,i,p,values),adapter=owner(p,r.projectId),a=action(r);if(!a)return unknown();
    if(!same(store.object(r.projectId,'closure-harness-input',r.id),current.evidence)||!same(a.context,current.context)||a.observationDigest!==nativeSha256(current.observation))reject('CLOSURE_HARNESS_CHANGED','Actual delivery changed after its native evaluation was frozen',409);
    let receipt:Record<string,unknown>;try{receipt=record(await adapter.read(actor,r.projectId,{operation:'native.receipt.inspect',scope:a.request.scope,input:{requestId:a.request.requestId}}));}catch(e){if(e instanceof ServiceError&&e.code==='NOT_FOUND')return unknown();throw e;}
    signal.throwIfAborted();const result=verifyNativeStageResult(receipt,'harness',p.owner,a,p.toolchainLockDigest,p.effectiveConfigDigest);if(result.status!=='UNKNOWN')retain(actor,r,'closure-harness-receipt',receipt);return result;
  }
  async function advance(r:StageRequest,i:LifecycleInstance,p:PublicationHarnessPin,values:ClosureHarnessInput,permit:()=>Promise<Principal>,signal:AbortSignal):Promise<OwnerResult>{
    const actor=await permit();authorize(actor,r.projectId,'execution.request');signal.throwIfAborted();const current=input(r,i,p,values),adapter=owner(p,r.projectId);if(action(r))return inspect(r,i,p,values,actor,signal);
    const state=record(await adapter.read(actor,r.projectId,{operation:'workspace.inspect',scope:p.owner.scope,input:{}}));if(!Number.isSafeInteger(state.revision)||Number(state.revision)<0)reject('OWNER_REVISION_INVALID','Native Harness revision is unavailable',409);
    const request:OwnerRequest={operation:'native.package.validate',scope:p.owner.scope,input:{id:p.owner.reference.id,version:p.owner.reference.version,context:current.context,observation:current.observation},requestId:'closure-native-'+valueDigest({requestId:r.id,projectId:r.projectId}).slice(7,51),expectedRevision:Number(state.revision)};
    const body={request,requestDigest:ownerRequestDigest('harness',request),context:current.context,observationDigest:nativeSha256(current.observation)};
    retain(actor,r,'closure-harness-input',current.evidence);retain(actor,r,'closure-harness-action',{...body,digest:valueDigest(body)});
    const fresh=await permit();signal.throwIfAborted();authorize(fresh,r.projectId,'execution.request');if(fresh.id!==r.initiatedBy.id||fresh.revision!==r.initiatedBy.revision)reject('AUTHORITY_CHANGED','Delivery evaluation requires the original current principal',409);owner(p,r.projectId);
    await adapter.mutate(fresh,r.projectId,request,{projectId:r.projectId,owner:'harness',requestDigest:body.requestDigest,authorityRef:r.authorityRef,expiresAt:r.deadlineAt});return inspect(r,i,p,values,fresh,signal);
  }
  return{prepare:selected.prepare,current:selected.current,inspect,advance};
}
