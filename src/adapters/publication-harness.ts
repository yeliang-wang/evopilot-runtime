import {randomUUID} from 'node:crypto';
import {canonical,record,reject,ServiceError,string} from '../server/errors.js';
import {authorize,type Principal} from '../server/security.js';
import {RuntimeStore} from '../server/store.js';
import {valueDigest} from '../lifecycle/base.js';
import {atPath} from '../lifecycle/compiler.js';
import type {LifecycleInstance} from '../lifecycle/instance.js';
import type {StageRequest} from '../lifecycle/execution.js';
import {readIntegrationConfiguration} from './config.js';
import {validateResourceDefinition} from './bindings.js';
import {nativeInventory,verifyNativeStageResult,type NativeStageConnections,type OwnerPin,type NativeAction,type OwnerResult} from './stages.js';
import {ownerRequestDigest,type OwnerRequest} from './published-owners.js';
import {nativeSha256,validateNativeReference,type NativeReference,type NativeValidationContext} from '../../vendor/compatibility/v1/native.mjs';
import type {VerifiedCiArtifact} from './artifacts.js';
import type {DistributionObservation} from './distribution.js';

export interface PublicationHarnessPin {owner:OwnerPin;effectiveConfigDigest:string;toolchainLockDigest:string;toolchainManifestDigest:string|null;}
export interface PublicationHarnessInput {ci:VerifiedCiArtifact;distribution:Omit<DistributionObservation,'observedAt'>;releaseMaterialDigest:string;}
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b),hash=(x:unknown)=>{const s=string(x,71);if(!/^sha256:[a-f0-9]{64}$/.test(s))reject('PUBLICATION_HARNESS_PIN','Exact native evaluation pins are required',409);return s;};
const unknown=():OwnerResult=>({owner:'harness',status:'UNKNOWN',receiptDigest:null,reportDigest:null});
/** Evaluates Runtime's independently observed delivery. This internal consumer
 * cannot author rules, accept caller PASS, or repeat an uncertain owner request. */
export function createPublicationHarness(store:RuntimeStore,configPath:string,connections:NativeStageConnections){
  function retain(actor:Principal,r:StageRequest,kind:string,value:unknown){
    const old=store.object(r.projectId,kind,r.id);if(old){if(!same(old,value))reject('PUBLICATION_HARNESS_CHANGED','Original publication evaluation cannot be replaced',409);return;}
    store.mutate(actor,{projectId:r.projectId,operation:'lifecycle.publication.harness',requestId:'publication-harness-'+randomUUID(),expectedRevision:store.revision(r.projectId),input:{stageRequestId:r.id,kind,digest:valueDigest(value)},permission:'read'},()=>({objects:[{kind,id:r.id,value}],value:{kind},event:{type:'publication-harness-retained',data:{stageRequestId:r.id,kind}}}));
  }
  function owner(p:PublicationHarnessPin,projectId:string){
    const config=readIntegrationConfiguration(configPath,store.workspaceId);
    if(p.toolchainLockDigest!==connections.toolchainLockDigest||p.toolchainManifestDigest!==(connections.toolchainManifestDigest??null)||!config.owners.some(o=>o.ref===p.owner.ref&&o.owner==='harness'&&o.projects.includes(projectId)))reject('PUBLICATION_HARNESS_CHANGED','Original Harness or native toolchain registration changed',409);
    const a=connections.owner(p.owner.ref,config);if(a.owner!=='harness'||a.workspaceId!==store.workspaceId||record(a.capabilities()).registrationDigest!==p.owner.registrationDigest)reject('PUBLICATION_HARNESS_CHANGED','Original Harness connection changed',409);return a;
  }
  function action(r:StageRequest):NativeAction|null{
    const a=store.object(r.projectId,'publication-harness-action',r.id) as NativeAction|null;if(!a)return null;
    const{digest,...body}=a;if(digest!==valueDigest(body)||a.requestDigest!==ownerRequestDigest('harness',a.request))reject('CORRUPT_PUBLICATION','Original Harness action changed',503);return a;
  }
  function input(r:StageRequest,instance:LifecycleInstance,p:PublicationHarnessPin,values:PublicationHarnessInput){
    const{digest,...body}=r,distribution=values.distribution,{schema,factsDigest,releaseAuthorized,...facts}=distribution;
    if(digest!==valueDigest(body)||r.stageId!=='publication'||r.workspaceId!==store.workspaceId||r.projectId!==instance.pins.projectId||r.instanceId!==instance.id||r.pinsDigest!==instance.pinsDigest||r.planDigest!==valueDigest(r.plan)||!same(r.plan.parameters.harness,p)||values.ci.status!=='PASSED'||values.ci.candidateDigest!==instance.candidateDigest||distribution.status!=='PASSED'||distribution.projectId!==r.projectId||distribution.candidateDigest!==instance.candidateDigest||distribution.factsDigest!==valueDigest(facts)||schema!=='runtime-distribution-observation/v1'||releaseAuthorized!==false)reject('PUBLICATION_HARNESS_INPUT','Native evaluation requires the original verified publication evidence',409);
    hash(values.releaseMaterialDigest);
    const context:NativeValidationContext={workspaceId:r.workspaceId,scope:{visibility:'private',projectId:r.projectId},projectCandidateDigest:instance.candidateDigest!,claimId:valueDigest({stageRequestDigest:r.digest}),inputDigest:r.inputDigest,effectiveConfigDigest:p.effectiveConfigDigest,sourceScopeDigest:instance.candidate!.sourceDigest,requirementSetDigest:instance.pins.requirementsDigest};
    const evidence={schema:'runtime-publication-observation/v1',requestDigest:r.digest,planDigest:r.planDigest,candidateDigest:instance.candidateDigest,...values},evidenceDigest=valueDigest(evidence);
    const observation={schema:'evopilot-observation/v1',origin:'execution-result',source:{revision:distribution.commit,digest:context.sourceScopeDigest},values:{runtimePublication:evidence},collectionReceiptRef:{id:'publication:'+r.id,digest:evidenceDigest,claimId:context.claimId},sourceScopeDigest:context.sourceScopeDigest};
    return{context,evidence,evidenceDigest,observation};
  }
  async function inspect(r:StageRequest,instance:LifecycleInstance,p:PublicationHarnessPin,values:PublicationHarnessInput,actor:Principal,signal:AbortSignal):Promise<OwnerResult>{
    authorize(actor,r.projectId,'read');signal.throwIfAborted();const current=input(r,instance,p,values),a=action(r),adapter=owner(p,r.projectId);if(!a)return unknown();
    const retained=store.object(r.projectId,'publication-harness-input',r.id);
    if(!same(retained,current.evidence)||a.observationDigest!==nativeSha256(current.observation)||!same(a.context,current.context))reject('PUBLICATION_HARNESS_CHANGED','Channel evidence changed after its exact native evaluation was frozen',409);
    let receipt:Record<string,unknown>;try{receipt=record(await adapter.read(actor,r.projectId,{operation:'native.receipt.inspect',scope:a.request.scope,input:{requestId:a.request.requestId}}));}catch(e){if(e instanceof ServiceError&&e.code==='NOT_FOUND')return unknown();throw e;}
    signal.throwIfAborted();const result=verifyNativeStageResult(receipt,'harness',p.owner,a,p.toolchainLockDigest,p.effectiveConfigDigest);
    if(result.status!=='UNKNOWN')retain(actor,r,'publication-harness-receipt',receipt);return result;
  }
  async function advance(r:StageRequest,instance:LifecycleInstance,p:PublicationHarnessPin,values:PublicationHarnessInput,permit:()=>Promise<Principal>,signal:AbortSignal):Promise<OwnerResult>{
    const actor=await permit();authorize(actor,r.projectId,'execution.request');signal.throwIfAborted();const current=input(r,instance,p,values),adapter=owner(p,r.projectId);
    if(action(r))return inspect(r,instance,p,values,actor,signal);
    const state=record(await adapter.read(actor,r.projectId,{operation:'workspace.inspect',scope:p.owner.scope,input:{}}));
    if(!Number.isSafeInteger(state.revision)||Number(state.revision)<0)reject('OWNER_REVISION_INVALID','Native Harness revision is unavailable',409);
    const request:OwnerRequest={operation:'native.package.validate',scope:p.owner.scope,input:{id:p.owner.reference.id,version:p.owner.reference.version,context:current.context,observation:current.observation},requestId:'publication-native-'+valueDigest({requestId:r.id,projectId:r.projectId}).slice(7,51),expectedRevision:Number(state.revision)};
    const body={request,requestDigest:ownerRequestDigest('harness',request),context:current.context,observationDigest:nativeSha256(current.observation)};
    retain(actor,r,'publication-harness-input',current.evidence);retain(actor,r,'publication-harness-action',{...body,digest:valueDigest(body)});
    const fresh=await permit();signal.throwIfAborted();authorize(fresh,r.projectId,'execution.request');
    if(fresh.id!==r.initiatedBy.id||fresh.revision!==r.initiatedBy.revision)reject('AUTHORITY_CHANGED','Native evaluation needs the original current actor',409);owner(p,r.projectId);
    await adapter.mutate(fresh,r.projectId,request,{projectId:r.projectId,owner:'harness',requestDigest:body.requestDigest,authorityRef:r.authorityRef,expiresAt:r.deadlineAt});
    return inspect(r,instance,p,values,fresh,signal);
  }
  return{inspect,advance,current:(p:PublicationHarnessPin,projectId:string)=>{owner(p,projectId);},async prepare(instance:LifecycleInstance,actor:Principal,signal:AbortSignal):Promise<PublicationHarnessPin>{
    authorize(actor,instance.pins.projectId,'read');signal.throwIfAborted();hash(connections.toolchainLockDigest);if(connections.toolchainManifestDigest)hash(connections.toolchainManifestDigest);
    const config=readIntegrationConfiguration(configPath,store.workspaceId),selected=record(atPath(instance.definition.semantic,'assets.harness')),mapping=config.resources.find(r=>r.projectId===instance.pins.projectId&&r.role==='assets.harness.mappingRef'&&r.ref===selected.mappingRef);
    if(!mapping||Date.parse(mapping.expiresAt)<=Date.now())reject('PUBLICATION_HARNESS_PIN','Current exact Harness mapping is required',409);validateResourceDefinition(mapping);const reference=mapping.definition.reference as NativeReference;
    validateNativeReference(reference,{product:'harness'});if(reference.id!==selected.id||reference.version!==selected.version||reference.digest!==selected.digest||reference.visibility!==selected.visibility)reject('OWNER_SCOPE','Publication Harness mapping differs from selected assets',409);
    const a=connections.owner(string(selected.adapterRef),config),scope={visibility:reference.visibility,projectId:string(selected.projectId)};
    if(a.workspaceId!==store.workspaceId||a.owner!=='harness')reject('OWNER_SCOPE','Publication Harness connection differs',409);
    const material=await a.readPackage(actor,instance.pins.projectId,scope,reference),report=record(material.validation),{reportDigest,...body}=report;
    if(reportDigest!==nativeSha256(body)||!same(report.reference,reference)||report.qualityStatus!=='PASS')reject('OWNER_BASELINE_INVALID','Published Harness configuration validation is unavailable',409);
    const p:PublicationHarnessPin={owner:{ref:string(selected.adapterRef),registrationDigest:hash(record(a.capabilities()).registrationDigest),scope,reference,criteria:nativeInventory(record(material.package),'harness')},effectiveConfigDigest:hash(report.effectiveConfigDigest),toolchainLockDigest:connections.toolchainLockDigest,toolchainManifestDigest:connections.toolchainManifestDigest??null};owner(p,instance.pins.projectId);signal.throwIfAborted();return p;
  }};
}
