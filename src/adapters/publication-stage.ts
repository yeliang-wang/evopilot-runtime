import {randomUUID} from 'node:crypto';
import {canonical,record,reject,ServiceError,string} from '../server/errors.js';
import {authorize,type Principal} from '../server/security.js';
import {RuntimeStore} from '../server/store.js';
import {byteDigest,valueDigest} from '../lifecycle/base.js';
import {atPath} from '../lifecycle/compiler.js';
import type {LifecycleInstance,ReleaseAuthority} from '../lifecycle/instance.js';
import type {StageAdapter,StageObservation,StagePlan,StageRequest} from '../lifecycle/execution.js';
import {configuredPlatform,readIntegrationConfiguration,type PlatformRegistration} from './config.js';
import {validateResourceDefinition} from './bindings.js';
import {readReleaseMaterial,type ReleaseMaterial} from './release-stages.js';
import {publicationTarget,publicationTag,publicationDescription,validatePublicationInput,type PublicationInput,type DistributionRequest,type DistributionObservation} from './distribution.js';
import {ciInputs,validateRunRequest,type PlatformRunRequest,type PlatformRunObservation} from './platforms.js';
import {verifyCiArtifact,type VerifiedCiArtifact} from './artifacts.js';
import {createPublicationHarness,type PublicationHarnessPin,type PublicationHarnessInput} from './publication-harness.js';
import type {NativeStageConnections,OwnerResult} from './stages.js';

const ID='runtime-publication-stage-v2',ADAPTER_DIGEST=valueDigest({id:ID,workflow:'runtime-ci/v1',input:'runtime-publication-input/v1',distribution:'runtime-distribution-observation/v1',harness:'runtime-publication-observation/v1',recovery:'inspect-original-only'});
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
interface Parameters {binding:PlatformRegistration;commit:string;workflowDigest:string;resourceDigest:string;releaseMaterialDigest:string;releaseAuthorityRef:string;releaseOutcomeDigest:string;publication:PublicationInput;expectedChecks:string[];harness:PublicationHarnessPin;}
function retainedAction(store:RuntimeStore,r:StageRequest):PlatformRunRequest|null{
  const raw=store.object(r.projectId,'publication-ci-action',r.id);if(!raw)return null;const a=record(raw),{digest,...body}=a;
  if(digest!==valueDigest(body)||a.requestDigest!==r.digest||a.planDigest!==r.planDigest)reject('CORRUPT_PUBLICATION','Original publication action changed',503);return a.ci as PlatformRunRequest;
}
export function readPublicationEvidence(store:RuntimeStore,r:StageRequest){
  if(r.stageId!=='publication')reject('STAGE_SCOPE','Publication evidence requires its original publication request',409);
  const pointer=store.object(r.projectId,'publication-evidence-pointer',r.id) as {ref:string}|null;
  const evidence=pointer?store.object(r.projectId,'publication-evidence',pointer.ref):null;
  if(pointer&&(!evidence||valueDigest(evidence)!==pointer.ref||record(evidence).requestDigest!==r.digest))reject('CORRUPT_PUBLICATION','Publication readback changed',503);
  return{ciRequest:retainedAction(store,r),run:store.object(r.projectId,'publication-ci-run',r.id),evidenceRef:pointer?.ref??null,evidence,harness:{input:store.object(r.projectId,'publication-harness-input',r.id),action:store.object(r.projectId,'publication-harness-action',r.id),receipt:store.object(r.projectId,'publication-harness-receipt',r.id)},historical:true,automaticRedispatch:false};
}
/** CI performs the configured publication; Runtime independently re-reads the
 * public channel and every original artifact. No release/asset mutation API is
 * exposed, and a lost workflow response never authorizes another dispatch. */
export function createPublicationStageAdapter(store:RuntimeStore,configPath:string,connections:NativeStageConnections,resolveRelease:(instance:LifecycleInstance,actor:Principal)=>ReleaseAuthority|undefined):StageAdapter{
  const harness=createPublicationHarness(store,configPath,connections);
  function resources(instance:LifecycleInstance,actor:Principal){
    authorize(actor,instance.pins.projectId,'read');const config=readIntegrationConfiguration(configPath,store.workspaceId),selected=['channelTargetRef','publishWorkflowRef','readbackPolicyRef','recoveryPolicyRef'].map(field=>{
      const role='config.publication.'+field,r=config.resources.find(r=>r.projectId===instance.pins.projectId&&r.role===role&&r.ref===atPath(instance.definition.semantic,role));
      if(!r||Date.parse(r.expiresAt)<=Date.now())reject('PUBLICATION_CONFIGURATION','All exact current publication resources are required',409);validateResourceDefinition(r);return r;
    });
    const channel=selected[0].definition,workflow=selected[1].definition;
    if(channel.channel!==atPath(instance.definition.semantic,'config.publication.channel')||workflow.purpose!=='publish'||channel.platformRef!==workflow.platformRef)reject('PUBLICATION_CONFIGURATION','Publication workflow and channel must use the same registered destination',409);
    const binding=configuredPlatform(config,actor,instance.pins.projectId,string(channel.platformRef));
    if(channel.channel!==binding.provider+'-release'||binding.credentialRef!==atPath(instance.definition.semantic,'config.publication.credentialRef'))reject('PUBLICATION_CONFIGURATION','Publication destination and credential differ from the configured channel',409);
    return{binding,resourceDigest:valueDigest(selected),target:publicationTarget(channel.publication,binding.provider)};
  }
  function retain(actor:Principal,r:StageRequest,kind:string,id:string,value:unknown){
    const old=store.object(r.projectId,kind,id);if(old){if(!same(old,value))reject('PUBLICATION_FACT_CHANGED','Retained original publication fact cannot be replaced',409);return;}
    store.mutate(actor,{projectId:r.projectId,operation:'lifecycle.publication.fact',requestId:'publication-fact-'+randomUUID(),expectedRevision:store.revision(r.projectId),input:{stageRequestId:r.id,kind,id,digest:valueDigest(value)},permission:'read'},()=>({objects:[{kind,id,value}],value:{kind,id},event:{type:'publication-fact-retained',data:{stageRequestId:r.id,kind,id}}}));
  }
  function material(instance:LifecycleInstance,current:boolean){
    const m=readReleaseMaterial(store,instance,current),stage=instance.stages['release-decision'];
    if(stage.status!=='PASSED'||!stage.outcomeDigest||current&&(!stage.expiresAt||Date.parse(stage.expiresAt)<=Date.now()))reject('RELEASE_EVIDENCE_REQUIRED','Publication requires the completed exact release-admission stage',409);return m;
  }
  function ciRequest(r:StageRequest,p:Parameters,m:ReleaseMaterial):PlatformRunRequest{
    return validateRunRequest({schema:'runtime-ci-request/v1',requestId:'publish-'+valueDigest({workspaceId:r.workspaceId,projectId:r.projectId,requestId:r.id}).slice(7,55),projectId:r.projectId,bindingDigest:valueDigest(p.binding),commit:p.commit,workflowDigest:p.workflowDigest,inputDigest:r.inputDigest,stageId:'publication',candidateDigest:m.candidateDigest,candidateInput:m.candidateInput,publicationInput:p.publication,requestedAt:r.requestedAt,deadlineAt:r.deadlineAt},p.binding);
  }
  function original(r:StageRequest,instance:LifecycleInstance,actor:Principal,current=false){
    const{digest,...body}=r,p=r.plan.parameters as unknown as Parameters,m=material(instance,current),c=resources(instance,actor),s=instance.stages.publication;
    if(digest!==valueDigest(body)||r.schema!=='runtime-stage-request/v1'||r.workspaceId!==store.workspaceId||r.projectId!==instance.pins.projectId||r.instanceId!==instance.id||r.pinsDigest!==instance.pinsDigest||r.stageId!=='publication'||s.requestId!==r.id||s.inputDigest!==r.inputDigest||r.plan.adapterId!==ID||r.plan.adapterDigest!==ADAPTER_DIGEST||r.plan.action!=='base.publication'||r.planDigest!==valueDigest(r.plan)||r.plan.bindingDigest!==valueDigest(p)||p.releaseMaterialDigest!==m.digest||r.releaseAuthorityRef!==p.releaseAuthorityRef||p.releaseOutcomeDigest!==instance.stages['release-decision'].outcomeDigest||p.commit!==m.documents.commit||!same(p.expectedChecks,instance.definition.nodes.find(n=>n.id==='publication')!.checks)||!same(p.binding,c.binding)||p.resourceDigest!==c.resourceDigest||!same(p.publication.target,c.target))reject('PUBLICATION_PLAN_CHANGED','Original publication scope or configured destination changed',409);
    harness.current(p.harness,r.projectId);const ci=ciRequest(r,p,m);if(Buffer.byteLength(canonical(ciInputs(ci)))>65536)reject('PUBLICATION_INPUT_LIMIT','Combined CI inputs exceed the fixed 64 KiB dispatch profile',409);
    const notes=m.documents.documents.filter(d=>d.role==='release-notes');
    if(!same(p.publication.notes,notes.map(({path,digest,bytes})=>({path,digest,bytes})))||p.publication.releaseMaterialDigest!==m.digest||p.publication.releaseAuthorityRef!==r.releaseAuthorityRef)reject('PUBLICATION_PLAN_CHANGED','Publication notes or release authority differ',409);
    const description=publicationDescription(notes.map(d=>d.text),ci),distribution:DistributionRequest={commit:p.commit,candidate:instance.candidate!,tag:p.publication.tag,prerelease:p.publication.target.prerelease,packageName:p.publication.target.packageName,descriptionDigest:byteDigest(description)};
    return{p,m,ci,distribution,client:connections.platform(p.binding)};
  }
  function evidence(actor:Principal,r:StageRequest,value:Record<string,unknown>):string{
    const body={schema:'runtime-publication-evidence/v1',requestDigest:r.digest,planDigest:r.planDigest,releaseAuthorityRef:r.releaseAuthorityRef,...value},ref=valueDigest(body);retain(actor,r,'publication-evidence',ref,body);
    const old=store.object(r.projectId,'publication-evidence-pointer',r.id) as {ref:string}|null;if(old?.ref!==ref)store.mutate(actor,{projectId:r.projectId,operation:'lifecycle.publication.observed',requestId:'publication-observed-'+randomUUID(),expectedRevision:store.revision(r.projectId),input:{stageRequestId:r.id,evidenceRef:ref},permission:'read'},()=>({objects:[{kind:'publication-evidence-pointer',id:r.id,value:{ref}}],value:{evidenceRef:ref},event:{type:'publication-observed',data:{stageRequestId:r.id,evidenceRef:ref}}}));return ref;
  }
  function observed(r:StageRequest,p:Parameters,ci:PlatformRunRequest,phase:StageObservation['phase'],ref:string):StageObservation{
    const complete=phase==='COMPLETE',failed=phase==='FAILED';return{requestId:r.id,inputDigest:r.inputDigest,adapterDigest:ADAPTER_DIGEST,phase,handle:{publicationRequestId:ci.requestId},outcome:{requestId:r.id,inputDigest:r.inputDigest,receiptRef:'runtime:publication-stage/'+r.id,status:complete?'COMPLETE':failed?'FAILED':phase==='UNKNOWN'?'UNKNOWN':'RUNNING',expiresAt:r.deadlineAt,checks:complete||failed?p.expectedChecks.map(id=>({id,status:complete?'PASS':'FAIL',evidenceRef:ref})):[]}};
  }
  const code=(e:unknown)=>e instanceof ServiceError?e.code:'PUBLICATION_OBSERVATION_UNAVAILABLE';
  async function inspect(r:StageRequest,instance:LifecycleInstance,_progress:unknown,actor:Principal,signal:AbortSignal):Promise<StageObservation>{
    const{p,ci,distribution,client}=original(r,instance,actor),action=retainedAction(store,r);
    if(!action)return observed(r,p,ci,'UNKNOWN','runtime:publication-stage/'+r.id);
    if(!same(action,ci))reject('PUBLICATION_PLAN_CHANGED','Original publication CI identity changed',409);
    let run:PlatformRunObservation|null=null,verified:VerifiedCiArtifact|null=null,delivery:DistributionObservation|null=null;const reasons:string[]=[];
    const known=store.object(r.projectId,'publication-ci-run',r.id) as {runId:string}|null;
    try{run=await client.run(actor,ci,known?.runId??null,signal);if(run.runId)retain(actor,r,'publication-ci-run',r.id,{runId:run.runId});}catch(e){reasons.push(code(e));}
    if(run?.runId&&['PASSED','FAILED'].includes(run.status))try{
      const archive=await client.artifact(actor,ci,run.runId,signal);verified=await verifyCiArtifact(archive,ci,p.expectedChecks,signal);retain(actor,r,'publication-ci-artifact',r.id,verified);
    }catch(e){reasons.push(code(e));}
    try{delivery=await client.distribution(actor,distribution,signal);}catch(e){reasons.push(code(e));}
    let currentGrant=false;
    if(verified?.status==='PASSED'&&delivery?.status==='PASSED')try{original(r,instance,actor,true);const grant=resolveRelease(instance,actor);if(!grant||grant.decisionRef!==r.releaseAuthorityRef)reject('RELEASE_AUTHORITY_CHANGED','Original exact publication grant is no longer usable',409);currentGrant=true;}catch(e){reasons.push(code(e));}
    const ciFacts=run?{provider:run.provider,repositoryId:run.repositoryId,requestId:run.requestId,inputDigest:run.inputDigest,commit:run.commit,ref:run.ref,runId:run.runId,status:run.status,evidenceRef:run.evidenceRef,jobs:run.jobs.map(j=>({jobId:j.jobId,status:j.status,factsDigest:j.factsDigest}))}:null;
    const deliveryFacts=delivery?(({observedAt,...facts})=>facts)(delivery):null;let evaluation:OwnerResult|null=null;
    if(currentGrant&&verified&&deliveryFacts)try{evaluation=await harness.inspect(r,instance,p.harness,{ci:verified,distribution:deliveryFacts,releaseMaterialDigest:p.releaseMaterialDigest},actor,signal);}catch(e){reasons.push(code(e));}
    const ref=evidence(actor,r,{ci:ciFacts,artifact:verified,distribution:deliveryFacts,harness:evaluation,reasons,currentGrant});
    const phase=run?.status==='FAILED'||verified?.status==='FAILED'||evaluation?.status==='FAIL'?'FAILED':currentGrant&&evaluation?.status==='PASS'?'COMPLETE':currentGrant&&evaluation?'RUNNING':run?.status==='RUNNING'?'CI_RUNNING':run?.status==='PENDING'?'CI_PENDING':'UNKNOWN';return observed(r,p,ci,phase,ref);
  }
  async function dispatch(r:StageRequest,instance:LifecycleInstance,permit:()=>Promise<Principal>,signal:AbortSignal):Promise<StageObservation>{
    let actor=await permit();const{p,ci,client}=original(r,instance,actor,true);
    if(retainedAction(store,r))return inspect(r,instance,null,actor,signal);
    async function allowed(){const fresh=await permit();original(r,instance,fresh,true);const grant=resolveRelease(instance,fresh);if(!grant||grant.decisionRef!==r.releaseAuthorityRef)reject('RELEASE_AUTHORITY_CHANGED','Publication requires its original current release grant',409);authorize(fresh,r.projectId,'release.request');signal.throwIfAborted();return fresh;}
    actor=await allowed();const action={requestDigest:r.digest,planDigest:r.planDigest,ci};retain(actor,r,'publication-ci-action',r.id,{...action,digest:valueDigest(action)});
    // The durable action is the single dispatch marker. Unknown outcomes and
    // restart can only inspect; even an explicit advance cannot repeat writes.
    const run=await client.dispatch(ci,async request=>{if(!same(request,ci))reject('PUBLICATION_PLAN_CHANGED','Provider changed the exact publication request',409);return allowed();},signal);
    if(run.runId)retain(actor,r,'publication-ci-run',r.id,{runId:run.runId});return inspect(r,instance,null,actor,signal);
  }
  return{async prepare(instance,stageId,actor,signal):Promise<StagePlan>{
    if(stageId!=='publication')reject('STAGE_ADAPTER_UNAVAILABLE','This adapter owns publication only',409);authorize(actor,instance.pins.projectId,'release.request');signal.throwIfAborted();
    const m=material(instance,true),c=resources(instance,actor),grant=resolveRelease(instance,actor);
    if(!grant||grant.candidateDigest!==instance.candidateDigest||grant.channel!==c.binding.provider+'-release')reject('EXACT_RELEASE_AUTHORITY_REQUIRED','An exact current release authority is required',409);
    if(m.documents.provider!==c.binding.provider||m.documents.repositoryId!==c.binding.repositoryId)reject('PUBLICATION_CONFIGURATION','Publication must use the reviewed source repository',409);
    const source=await connections.platform(c.binding).revision(actor,m.documents.commit,signal);
    if(source.commit!==m.documents.commit||source.bindingDigest!==valueDigest(c.binding)||source.repositoryId!==c.binding.repositoryId||source.projectId!==instance.pins.projectId||source.sourceSelection!=='exact-commit'||Date.parse(source.expiresAt)<=Date.now())reject('PUBLICATION_CONFIGURATION','The exact publication workflow revision must be available',409);
    const publication:PublicationInput={schema:'runtime-publication-input/v1',target:c.target,tag:publicationTag(instance.candidate!.version,c.target),releaseMaterialDigest:m.digest,releaseAuthorityRef:grant.decisionRef,notes:m.documents.documents.filter(d=>d.role==='release-notes').map(({path,digest,bytes})=>({path,digest,bytes}))};validatePublicationInput(publication,{candidateInput:m.candidateInput,stageId:'publication'},c.binding.provider);
    const p:Parameters={binding:c.binding,commit:m.documents.commit,workflowDigest:source.workflowDigest,resourceDigest:c.resourceDigest,releaseMaterialDigest:m.digest,releaseAuthorityRef:grant.decisionRef,releaseOutcomeDigest:instance.stages['release-decision'].outcomeDigest!,publication,expectedChecks:instance.definition.nodes.find(n=>n.id===stageId)!.checks,harness:await harness.prepare(instance,actor,signal)};
    return{adapterId:ID,adapterDigest:ADAPTER_DIGEST,action:'base.publication',bindingDigest:valueDigest(p),parameters:p as unknown as Record<string,unknown>};
  },dispatch,inspect,async advance(r,i,_progress,permit,signal){
    const observed=await dispatch(r,i,permit,signal);if(observed.phase!=='RUNNING')return observed;
    const allowed=async()=>{const actor=await permit();original(r,i,actor,true);const grant=resolveRelease(i,actor);if(!grant||grant.decisionRef!==r.releaseAuthorityRef)reject('RELEASE_AUTHORITY_CHANGED','Original publication grant is required for native continuation',409);return actor;};
    const actor=await allowed(),{p}=original(r,i,actor,true),saved=record(readPublicationEvidence(store,r).evidence),input:PublicationHarnessInput={ci:saved.artifact as VerifiedCiArtifact,distribution:saved.distribution as PublicationHarnessInput['distribution'],releaseMaterialDigest:p.releaseMaterialDigest};
    await harness.advance(r,i,p.harness,input,allowed,signal);return inspect(r,i,null,actor,signal);
  }};
}
