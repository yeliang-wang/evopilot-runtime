import {randomUUID} from 'node:crypto';
import {canonical,record,reject} from '../server/errors.js';
import {authorize,type Principal} from '../server/security.js';
import {RuntimeStore} from '../server/store.js';
import {valueDigest} from '../lifecycle/base.js';
import {atPath} from '../lifecycle/compiler.js';
import {inspectInstance,type LifecycleInstance,type ReleaseAuthority} from '../lifecycle/instance.js';
import type {StageAdapter,StageObservation,StagePlan,StageProgress,StageRequest} from '../lifecycle/execution.js';
import {configuredPlatform,readIntegrationConfiguration,type PlatformRegistration,type ResourceRegistration} from './config.js';
import {validateResourceDefinition,type BindingConnections} from './bindings.js';
import {validateCandidateInput,type CandidateInput} from './artifacts.js';
import {releaseDocuments,type DocumentObservation,type ReleaseDocument} from './documents.js';
import type {AuthorityPolicyProvider} from './authority.js';

const ID='runtime-release-admission-v1',ADAPTER_DIGEST=valueDigest({id:ID,documents:'runtime-release-documents/v1',material:'runtime-release-material/v1',decision:'separate-exact-authority',publication:false});
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
/** All transitive gates, including required project extensions, stay mandatory. */
export function releasePredecessors(instance:LifecycleInstance,current=true){
  inspectInstance(instance);const required=new Set<string>(),pending=[...instance.definition.nodes.find(n=>n.id==='release-decision')!.dependsOn];
  while(pending.length){const id=pending.pop()!;if(required.has(id))continue;required.add(id);pending.push(...instance.definition.nodes.find(n=>n.id===id)!.dependsOn);}
  return [...required].sort().map(id=>{
    const s=instance.stages[id];
    if(s.status!=='PASSED'||!s.requestId||!s.inputDigest||!s.outcomeDigest||!s.receiptRef||!s.expiresAt||current&&Date.parse(s.expiresAt)<=Date.now())reject('RELEASE_EVIDENCE_REQUIRED','Every fixed release predecessor and dependency must currently pass',409);
    return{id,requestId:s.requestId,inputDigest:s.inputDigest,outcomeDigest:s.outcomeDigest,receiptRef:s.receiptRef,expiresAt:s.expiresAt};
  });
}
interface ReleaseParameters {
  binding:PlatformRegistration;commit:string;candidateInput:CandidateInput;documentation:ReleaseDocument[];
  evidencePolicyDigest:string;bindingContextDigest:string;verificationRequestId:string;verificationRequestDigest:string;
  predecessors:ReturnType<typeof releasePredecessors>;expectedChecks:string[];
}
export interface ReleaseMaterial {
  schema:'runtime-release-material/v1';workspaceId:string;projectId:string;instanceId:string;pinsDigest:string;
  stageRequestId:string;requestDigest:string;planDigest:string;candidateDigest:string;candidateInput:CandidateInput;
  bindingContextDigest:string;evidencePolicyDigest:string;verificationRequestId:string;verificationOutcomeDigest:string;
  predecessors:ReturnType<typeof releasePredecessors>;documents:DocumentObservation;collectedAt:string;releaseAuthorized:false;digest:string;
}
function originalRequest(store:RuntimeStore,instance:LifecycleInstance,stageId:string):StageRequest{
  const stage=instance.stages[stageId],r=stage?.requestId?store.object(instance.pins.projectId,'stage-request',stage.requestId) as StageRequest|null:null;
  if(!r)reject('RELEASE_EVIDENCE_REQUIRED','Original retained stage request is required',409);
  const{digest,...body}=r;
  if(r.schema!=='runtime-stage-request/v1'||digest!==valueDigest(body)||r.planDigest!==valueDigest(r.plan)||r.id!==stage.requestId||r.inputDigest!==stage.inputDigest||r.stageId!==stageId||r.workspaceId!==store.workspaceId||r.projectId!==instance.pins.projectId||r.instanceId!==instance.id||r.pinsDigest!==instance.pinsDigest)reject('CORRUPT_STAGE_REQUEST','Release evidence differs from its original stage request',503);return r;
}
function candidate(store:RuntimeStore,instance:LifecycleInstance,binding:PlatformRegistration,commit:string):CandidateInput{
  const r=originalRequest(store,instance,'candidate'),proof=store.object(r.projectId,'stage-candidate-source',r.id);
  if(!proof||!instance.candidateDigest)reject('CI_CANDIDATE_INPUT_REQUIRED','Release requires the original candidate archive',409);
  const raw=record(proof),{digest,...body}=raw;
  if(raw.schema!=='runtime-candidate-source-evidence/v1'||digest!==valueDigest(body)||raw.requestId!==r.id||raw.requestDigest!==r.digest||raw.pinsDigest!==instance.pinsDigest||raw.outcomeDigest!==instance.stages.candidate.outcomeDigest||!same(record(raw.input).manifest,instance.candidate))reject('CI_CANDIDATE_INPUT_INVALID','Release candidate differs from its original archive evidence',409);
  return validateCandidateInput(raw.input as CandidateInput,{commit,candidateDigest:instance.candidateDigest},binding.provider,binding.repositoryId);
}
/** Pure retained read used by the existing authority review. A digest alone is
 * insufficient: the review receives candidate, original receipts and full text. */
export function readReleaseMaterial(store:RuntimeStore,instance:LifecycleInstance,current=true):ReleaseMaterial{
  const predecessors=releasePredecessors(instance,current),r=originalRequest(store,instance,'release-decision'),m=store.object(r.projectId,'release-stage-material',r.id) as ReleaseMaterial|null;
  if(!m)reject('RELEASE_MATERIAL_REQUIRED','Collect exact candidate documents and verification in the original release-decision stage before review',409);
  const{digest,...body}=m,p=r.plan.parameters as unknown as ReleaseParameters,{schema,factsDigest,observedAt,releaseAuthorized,...facts}=m.documents;
  if(r.plan.adapterId!==ID||r.plan.adapterDigest!==ADAPTER_DIGEST||r.plan.action!=='base.release-decision'||r.plan.bindingDigest!==valueDigest(p)||m.schema!=='runtime-release-material/v1'||digest!==valueDigest(body)||m.workspaceId!==store.workspaceId||m.projectId!==r.projectId||m.instanceId!==instance.id||m.pinsDigest!==instance.pinsDigest||m.stageRequestId!==r.id||m.requestDigest!==r.digest||m.planDigest!==r.planDigest||m.candidateDigest!==instance.candidateDigest||m.releaseAuthorized!==false||m.bindingContextDigest!==p.bindingContextDigest||m.evidencePolicyDigest!==p.evidencePolicyDigest||m.verificationRequestId!==p.verificationRequestId||m.verificationOutcomeDigest!==instance.stages.verification.outcomeDigest||!same(m.predecessors,predecessors)||!same(m.predecessors,p.predecessors)||!same(m.candidateInput,p.candidateInput)||!same(m.candidateInput,candidate(store,instance,p.binding,p.commit))||schema!=='runtime-release-documents/v1'||factsDigest!==valueDigest(facts)||releaseAuthorized!==false||m.documents.commit!==p.commit||m.documents.bindingDigest!==valueDigest(p.binding)||m.documents.projectId!==r.projectId||m.documents.repositoryId!==p.binding.repositoryId||m.documents.provider!==p.binding.provider||!same(releaseDocuments(m.documents.documents.map(({role,path})=>({role,path}))),p.documentation))reject('CORRUPT_RELEASE_MATERIAL','Release material does not match its exact retained request and evidence',503);
  const v=originalRequest(store,instance,'verification');if(v.id!==p.verificationRequestId||v.digest!==p.verificationRequestDigest)reject('CORRUPT_RELEASE_MATERIAL','Original verification request differs',503);
  if(current&&Date.parse(r.deadlineAt)<=Date.now())reject('RELEASE_MATERIAL_EXPIRED','The original release-stage evidence expired',409);return m;
}
export function createReleaseStageAdapter(store:RuntimeStore,configPath:string,connections:Pick<BindingConnections,'platform'>&{verification:StageAdapter},resolveRelease:(instance:LifecycleInstance,actor:Principal)=>ReleaseAuthority|undefined,policies:AuthorityPolicyProvider):StageAdapter{
  function config(instance:LifecycleInstance,actor:Principal){
    authorize(actor,instance.pins.projectId,'read');const c=readIntegrationConfiguration(configPath,store.workspaceId),role='config.release-decision.evidencePolicyRef';
    const resource=c.resources.find(r=>r.projectId===instance.pins.projectId&&r.role===role&&r.ref===atPath(instance.definition.semantic,role));
    if(!resource||Date.parse(resource.expiresAt)<=Date.now())reject('RELEASE_DOCUMENT_CONFIGURATION','Current registered release evidence policy is required',409);validateResourceDefinition(resource);
    return{configuration:c,resource,documentation:releaseDocuments(resource.definition.documentation),policy:policies(instance.definition,actor)};
  }
  const evidencePolicyDigest=(resource:ResourceRegistration)=>{const{revision,expiresAt,...scope}=resource;return valueDigest(scope);};
  function original(r:StageRequest,instance:LifecycleInstance,actor:Principal){
    const actual=originalRequest(store,instance,'release-decision'),p=r.plan.parameters as unknown as ReleaseParameters,c=config(instance,actor);
    if(!same(actual,r)||r.plan.adapterId!==ID||r.plan.adapterDigest!==ADAPTER_DIGEST||r.plan.action!=='base.release-decision'||r.plan.bindingDigest!==valueDigest(p)||!same(p.predecessors,releasePredecessors(instance))||!same(p.expectedChecks,instance.definition.nodes.find(n=>n.id==='release-decision')!.checks))reject('STAGE_PLAN_MISMATCH','Release admission differs from its original request',409);
    if(c.policy.bindingContextDigest!==p.bindingContextDigest||evidencePolicyDigest(c.resource)!==p.evidencePolicyDigest||!same(c.documentation,p.documentation)||!same(configuredPlatform(c.configuration,actor,r.projectId,p.binding.ref),p.binding))reject('RELEASE_BINDINGS_CHANGED','Release documentation or provider configuration changed',409);
    const verification=originalRequest(store,instance,'verification');
    if(verification.id!==p.verificationRequestId||verification.digest!==p.verificationRequestDigest||!same(candidate(store,instance,p.binding,p.commit),p.candidateInput))reject('RELEASE_EVIDENCE_CHANGED','Original verification or candidate changed',409);return{p,verification};
  }
  async function verify(r:StageRequest,instance:LifecycleInstance,actor:Principal,signal:AbortSignal){
    const{p,verification}=original(r,instance,actor),progress=store.object(r.projectId,'stage-progress',verification.id) as StageProgress|null;
    if(!progress||!progress.terminal||progress.phase!=='COMPLETE'||progress.requestId!==verification.id||valueDigest(progress.observation?.outcome)!==instance.stages.verification.outcomeDigest)reject('RELEASE_EVIDENCE_REQUIRED','Original verification completion must be retained',409);
    const observed=await connections.verification.inspect(verification,instance,progress,actor,signal);signal.throwIfAborted();
    if(observed.phase!=='COMPLETE'||observed.requestId!==verification.id||observed.inputDigest!==verification.inputDigest||observed.adapterDigest!==verification.plan.adapterDigest||valueDigest(observed.outcome)!==instance.stages.verification.outcomeDigest)reject('RELEASE_VERIFICATION_CHANGED','Original verification no longer independently passes',409);
    return p;
  }
  function observation(r:StageRequest,p:ReleaseParameters,complete:boolean,digest?:string):StageObservation{
    return{requestId:r.id,inputDigest:r.inputDigest,adapterDigest:ADAPTER_DIGEST,phase:complete?'COMPLETE':'RUNNING',handle:{releaseRequestId:r.id},outcome:{requestId:r.id,inputDigest:r.inputDigest,receiptRef:'runtime:release-stage/'+r.id,status:complete?'COMPLETE':'RUNNING',expiresAt:r.deadlineAt,checks:complete?p.expectedChecks.map(id=>({id,status:'PASS',evidenceRef:digest!})):[]}};
  }
  async function inspect(r:StageRequest,instance:LifecycleInstance,_progress:StageProgress,actor:Principal,signal:AbortSignal):Promise<StageObservation>{
    const{p}=original(r,instance,actor);signal.throwIfAborted();
    if(!store.object(r.projectId,'release-stage-material',r.id))return observation(r,p,false);
    const material=readReleaseMaterial(store,instance),grant=resolveRelease(instance,actor);
    if(!grant)return observation(r,p,false);
    await verify(r,instance,actor,signal);original(r,instance,actor);
    const fresh=resolveRelease(instance,actor);
    if(!fresh||!same(fresh,grant))reject('AUTHORITY_CHANGED','Exact release authority changed during observation',409);
    return observation(r,p,true,valueDigest({materialDigest:material.digest,decisionRef:grant.decisionRef}));
  }
  async function execute(r:StageRequest,instance:LifecycleInstance,permit:()=>Promise<Principal>,signal:AbortSignal){
    let actor=await permit();const{p}=original(r,instance,actor);
    if(!store.object(r.projectId,'release-stage-material',r.id)){
      await verify(r,instance,actor,signal);
      const documents=await connections.platform(p.binding).documents(actor,{commit:p.commit,documents:p.documentation},signal);
      actor=await permit();original(r,instance,actor);signal.throwIfAborted();
      const body:Omit<ReleaseMaterial,'digest'>={schema:'runtime-release-material/v1',workspaceId:store.workspaceId,projectId:r.projectId,instanceId:r.instanceId,pinsDigest:r.pinsDigest,stageRequestId:r.id,requestDigest:r.digest,planDigest:r.planDigest,candidateDigest:instance.candidateDigest!,candidateInput:p.candidateInput,bindingContextDigest:p.bindingContextDigest,evidencePolicyDigest:p.evidencePolicyDigest,verificationRequestId:p.verificationRequestId,verificationOutcomeDigest:instance.stages.verification.outcomeDigest!,predecessors:p.predecessors,documents,collectedAt:new Date().toISOString(),releaseAuthorized:false},material={...body,digest:valueDigest(body)};
      if(store.object(r.projectId,'release-stage-material',r.id))reject('RELEASE_MATERIAL_EXISTS','Original release material already exists',409);
      store.mutate(actor,{projectId:r.projectId,operation:'lifecycle.release.material',requestId:'release-material-'+randomUUID(),expectedRevision:store.revision(r.projectId),input:{stageRequestId:r.id,materialDigest:material.digest},permission:'read'},()=>({objects:[{kind:'release-stage-material',id:r.id,value:material}],value:{stageRequestId:r.id,materialDigest:material.digest},event:{type:'release-material-retained',data:{instanceId:r.instanceId,stageRequestId:r.id,materialDigest:material.digest}}}));
    }
    return inspect(r,instance,{} as StageProgress,actor,signal);
  }
  return{async prepare(instance,stageId,actor,signal):Promise<StagePlan>{
    if(stageId!=='release-decision')reject('STAGE_ADAPTER_UNAVAILABLE','This fixed adapter only prepares release admission',409);signal.throwIfAborted();
    const predecessors=releasePredecessors(instance),c=config(instance,actor),verification=originalRequest(store,instance,'verification'),v=record(verification.plan.parameters),binding=v.binding as PlatformRegistration,commit=String(v.commit);
    if(!binding||!same(configuredPlatform(c.configuration,actor,instance.pins.projectId,binding.ref),binding))reject('RELEASE_BINDINGS_CHANGED','Release source must use the original verification provider',409);
    const candidateInput=candidate(store,instance,binding,commit);
    if(!same(v.candidateInput,candidateInput))reject('RELEASE_EVIDENCE_CHANGED','Verification did not consume the original candidate',409);
    const p:ReleaseParameters={binding,commit,candidateInput,documentation:c.documentation,evidencePolicyDigest:evidencePolicyDigest(c.resource),bindingContextDigest:c.policy.bindingContextDigest,verificationRequestId:verification.id,verificationRequestDigest:verification.digest,predecessors,expectedChecks:instance.definition.nodes.find(n=>n.id===stageId)!.checks};
    return{adapterId:ID,adapterDigest:ADAPTER_DIGEST,action:'base.release-decision',bindingDigest:valueDigest(p),parameters:p as unknown as Record<string,unknown>};
  },dispatch:execute,inspect,advance:(r,i,_p,permit,signal)=>execute(r,i,permit,signal)};
}
