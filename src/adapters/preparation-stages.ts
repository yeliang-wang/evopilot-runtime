import { randomUUID } from 'node:crypto';
import { relative, sep } from 'node:path';
import { canonical, record, reject, ServiceError, string } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import { RuntimeStore } from '../server/store.js';
import { valueDigest } from '../lifecycle/base.js';
import { atPath, type EffectiveDefinition } from '../lifecycle/compiler.js';
import { inspectInstance, type LifecycleInstance } from '../lifecycle/instance.js';
import { readPreparationPacket, type PreparationPacket, type PreparationValidator } from '../lifecycle/preparation.js';
import type { StageAdapter, StageObservation, StagePlan, StageRequest } from '../lifecycle/execution.js';
import { readIntegrationConfiguration, configuredPlatform, type IntegrationConfiguration, type PlatformRegistration } from './config.js';
import { validateResourceDefinition, verifyResourceFile, type BindingConnections } from './bindings.js';
import { nativeSha256, validateNativeReference, type NativeReference, type NativeValidationContext } from '../../vendor/compatibility/v1/native.mjs';
import { ownerRequestDigest, type Owner, type OwnerRequest } from './published-owners.js';
import { nativeInventory, verifyNativeStageResult, type NativeAction, type NativeStageConnections, type OwnerPin, type OwnerResult } from './stages.js';

const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function resource(config:Readonly<IntegrationConfiguration>,definition:EffectiveDefinition,role:string){
  const r=config.resources.find(r=>r.ref===atPath(definition.semantic,role)&&r.projectId===definition.projectId&&r.role===role);
  if(!r||Date.parse(r.expiresAt)<=Date.now())reject('PREPARATION_BINDING_MISSING','Current exact scoped preparation resource is required',409);validateResourceDefinition(r);return r;
}

const PLAN_ID='runtime-plan-stage-v1',PLAN_DIGEST=valueDigest({id:PLAN_ID,preparation:'runtime-preparation/v1',observation:'runtime-plan-observation/v1',owners:'native/v1',recovery:'inspect-original'});
interface PlanParameters {
  preparationRef:string;preparationDigest:string;factsDigest:string;scopeRequestId:string;scopeEvidenceDigest:string;
  expectedChecks:string[];owners:Record<Owner,OwnerPin>;effectiveConfigDigest:string;
  toolchainLockDigest:string;toolchainManifestDigest:string|null;
}
/** Fixed plan checks operate on exact reviewed material and native owner rules.
 * No request accepts caller-authored outcomes, commands or validation callbacks. */
export function createPlanStageAdapter(store:RuntimeStore,configPath:string,connections:NativeStageConnections):StageAdapter{
  const validate=registeredPreparation(configPath,store.workspaceId);
  const hash=(value:unknown)=>{const s=string(value,71);if(!/^sha256:[a-f0-9]{64}$/.test(s))reject('PLAN_EVIDENCE_INVALID','Exact plan evidence digest is required');return s;};
  hash(connections.toolchainLockDigest);if(connections.toolchainManifestDigest)hash(connections.toolchainManifestDigest);
  function retain(actor:Principal,projectId:string,kind:string,id:string,value:unknown):void{
    const old=store.object(projectId,kind,id);if(old){if(!same(old,value))reject('PLAN_EVIDENCE_CHANGED','Original plan evidence cannot be replaced',409);return;}
    store.mutate(actor,{projectId,operation:'lifecycle.plan.evidence',requestId:'plan-fact-'+randomUUID(),expectedRevision:store.revision(projectId),input:{kind,id,digest:valueDigest(value)},permission:'read'},()=>({objects:[{kind,id,value}],value:{kind,id,digest:valueDigest(value)},event:{type:'plan-evidence-retained',data:{kind,id,digest:valueDigest(value)}}}));
  }
  function selected(instance:LifecycleInstance):PreparationPacket{
    inspectInstance(instance);const packet=readPreparationPacket(store,instance.pins.projectId,instance.pins.targetRef);
    if(packet.input.definitionRevisionId!==instance.pins.definitionRevisionId||packet.semanticDigest!==instance.pins.semanticDigest||packet.input.goalRef!==instance.pins.goalRef||packet.input.loopRef!==instance.pins.loopRef)reject('PREPARATION_SCOPE','Plan must retain the exact reviewed preparation',409);return packet;
  }
  function scope(instance:LifecycleInstance,packet:PreparationPacket):{requestId:string;digest:string}{
    const stage=instance.stages.scope,request=stage?.requestId?store.object(instance.pins.projectId,'stage-request',stage.requestId):null,e=stage?.requestId?store.object(instance.pins.projectId,'scope-stage-evidence',stage.requestId):null;
    if(stage?.status!=='PASSED'||!request||!e)reject('SCOPE_EVIDENCE_REQUIRED','Plan requires the completed original scope evidence',409);
    const r=record(request),raw=record(e),{digest,...body}=raw;
    if(digest!==valueDigest(body)||raw.requestDigest!==r.digest||raw.planDigest!==r.planDigest||raw.preparationDigest!==packet.digest||r.instanceId!==instance.id||r.pinsDigest!==instance.pinsDigest||r.projectId!==instance.pins.projectId||r.workspaceId!==store.workspaceId)reject('CORRUPT_STAGE_EVIDENCE','Original scope evidence does not match this plan',503);
    return{requestId:stage.requestId!,digest:hash(digest)};
  }
  function owner(config:Readonly<IntegrationConfiguration>,pin:OwnerPin,kind:Owner,projectId:string){
    if(!config.owners.some(o=>o.ref===pin.ref&&o.owner===kind&&o.projects.includes(projectId)))reject('OWNER_BINDING_CHANGED','Plan owner registration is unavailable');
    const a=connections.owner(pin.ref,config);if(a.owner!==kind||a.workspaceId!==store.workspaceId||record(a.capabilities()).registrationDigest!==pin.registrationDigest)reject('OWNER_BINDING_CHANGED','Plan owner registration changed');return a;
  }
  function original(r:StageRequest,instance:LifecycleInstance,actor:Principal){
    authorize(actor,r.projectId,'read');const packet=selected(instance),p=r.plan.parameters as unknown as PlanParameters,prior=scope(instance,packet),config=readIntegrationConfiguration(configPath,store.workspaceId);
    if(r.stageId!=='plan'||r.workspaceId!==store.workspaceId||r.projectId!==instance.pins.projectId||r.instanceId!==instance.id||r.pinsDigest!==instance.pinsDigest||r.plan.adapterId!==PLAN_ID||r.plan.adapterDigest!==PLAN_DIGEST||r.plan.action!=='base.plan'||r.planDigest!==valueDigest(r.plan)||r.plan.bindingDigest!==valueDigest(p)||p.preparationRef!==instance.pins.targetRef||p.preparationDigest!==packet.digest||p.scopeRequestId!==prior.requestId||p.scopeEvidenceDigest!==prior.digest||!same(p.expectedChecks,instance.definition.nodes.find(n=>n.id==='plan')!.checks))reject('STAGE_PLAN_MISMATCH','Plan differs from its original immutable request',409);
    if(p.toolchainLockDigest!==connections.toolchainLockDigest||p.toolchainManifestDigest!==(connections.toolchainManifestDigest??null))reject('TOOLCHAIN_CHANGED','Original plan validator pins changed',409);
    for(const kind of ['ontology','harness'] as const)owner(config,p.owners[kind],kind,r.projectId);
    return{packet,p,config};
  }
  function action(r:StageRequest,kind:Owner):NativeAction|null{
    const a=store.object(r.projectId,'plan-stage-native-action',r.id+':'+kind) as NativeAction|null;if(!a)return null;
    const{digest,...body}=a;if(digest!==valueDigest(body)||a.requestDigest!==ownerRequestDigest(kind,a.request))reject('CORRUPT_STAGE_ACTION','Original plan validation changed',503);return a;
  }
  function observed(r:StageRequest,p:PlanParameters,phase:StageObservation['phase'],ref:string):StageObservation{
    const complete=phase==='COMPLETE',failed=phase==='FAILED';
    return{requestId:r.id,inputDigest:r.inputDigest,adapterDigest:PLAN_DIGEST,phase,handle:{preparationRef:p.preparationRef},outcome:{requestId:r.id,inputDigest:r.inputDigest,receiptRef:'runtime:plan-stage/'+r.id,status:complete?'COMPLETE':failed?'FAILED':phase==='UNKNOWN'?'UNKNOWN':'RUNNING',expiresAt:r.deadlineAt,checks:complete||failed?p.expectedChecks.map(id=>({id,status:complete?'PASS':id.startsWith('base.plan.')?'PASS':'FAIL',evidenceRef:ref})):[]}};
  }
  async function inspect(r:StageRequest,instance:LifecycleInstance,_progress:unknown,actor:Principal,signal:AbortSignal):Promise<StageObservation>{
    signal.throwIfAborted();const{p,config}=original(r,instance,actor),retained=store.object(r.projectId,'plan-stage-input',r.id);
    if(!retained)return observed(r,p,'UNKNOWN','runtime:plan-stage/'+r.id);
    const input=record(retained),{digest,...body}=input;
    if(digest!==valueDigest(body)||input.requestDigest!==r.digest||input.planDigest!==r.planDigest||input.preparationDigest!==p.preparationDigest||input.factsDigest!==p.factsDigest)reject('CORRUPT_STAGE_EVIDENCE','Retained plan input differs',503);
    const results:OwnerResult[]=[];let uncertain=false;
    for(const kind of ['ontology','harness'] as const){
      signal.throwIfAborted();const a=action(r,kind),empty:OwnerResult={owner:kind,status:'UNKNOWN',receiptDigest:null,reportDigest:null};
      if(!a){results.push(empty);continue;}
      let receipt:Record<string,unknown>;try{receipt=record(await owner(config,p.owners[kind],kind,r.projectId).read(actor,r.projectId,{operation:'native.receipt.inspect',scope:a.request.scope,input:{requestId:a.request.requestId}}));}
      catch(e){if(e instanceof ServiceError&&e.code==='NOT_FOUND'){uncertain=true;results.push(empty);continue;}throw e;}
      const result=verifyNativeStageResult(receipt,kind,p.owners[kind],a,p.toolchainLockDigest,p.effectiveConfigDigest);results.push(result);
      // Running observations may change; only terminal originals are retained.
      if(result.receiptDigest)retain(actor,r.projectId,'plan-stage-native-receipt',r.id+':'+kind,receipt);
    }
    const failed=results.some(x=>x.status==='FAIL'),complete=results.every(x=>x.status==='PASS'),phase=failed?'FAILED':complete?'COMPLETE':uncertain?'UNKNOWN':'RUNNING';
    const evidence={schema:'runtime-plan-stage-evidence/v1',requestDigest:r.digest,planDigest:r.planDigest,preparationDigest:p.preparationDigest,inputDigest:digest,owners:results,softwareRelease:false},ref=valueDigest(evidence);
    retain(actor,r.projectId,'plan-stage-evidence',ref,evidence);return observed(r,p,phase,ref);
  }
  async function execute(r:StageRequest,instance:LifecycleInstance,permit:()=>Promise<Principal>,signal:AbortSignal):Promise<StageObservation>{
    let actor=await permit();const{packet,p,config}=original(r,instance,actor),facts=validate(packet,instance.definition,actor);
    if(valueDigest(facts)!==p.factsDigest)reject('PREPARATION_CHANGED','Reviewed plan facts changed',409);
    const inputBody={schema:'runtime-plan-stage-input/v1',requestDigest:r.digest,planDigest:r.planDigest,preparationDigest:p.preparationDigest,factsDigest:p.factsDigest,facts,authorityRef:r.authorityRef,scopeEvidenceDigest:p.scopeEvidenceDigest},input={...inputBody,digest:valueDigest(inputBody)};
    retain(actor,r.projectId,'plan-stage-input',r.id,input);
    const prior=await inspect(r,instance,null,actor,signal);if(['COMPLETE','FAILED','UNKNOWN'].includes(prior.phase))return prior;
    const context:NativeValidationContext={workspaceId:r.workspaceId,scope:{visibility:'private',projectId:r.projectId},projectCandidateDigest:packet.digest,claimId:valueDigest({stageRequestDigest:r.digest}),inputDigest:r.inputDigest,effectiveConfigDigest:p.effectiveConfigDigest,sourceScopeDigest:p.scopeEvidenceDigest,requirementSetDigest:instance.pins.requirementsDigest};
    const observation={schema:'evopilot-observation/v1',origin:'execution-result',source:{revision:packet.input.source.commit,digest:p.scopeEvidenceDigest},values:{runtimePlan:{schema:'runtime-plan-observation/v1',preparationDigest:packet.digest,target:packet.input.target,compatibility:packet.input.compatibility,documents:record(facts.evidence.documents),verification:packet.input.verification,budget:instance.pins.budget,authorityRef:r.authorityRef,scopeEvidenceDigest:p.scopeEvidenceDigest}},collectionReceiptRef:{id:'plan-stage:'+r.id,digest:input.digest,claimId:context.claimId},sourceScopeDigest:context.sourceScopeDigest};
    for(const kind of ['ontology','harness'] as const){
      signal.throwIfAborted();if(action(r,kind))continue;
      const a=owner(config,p.owners[kind],kind,r.projectId),scope=p.owners[kind].scope,state=record(await a.read(actor,r.projectId,{operation:'workspace.inspect',scope,input:{}}));
      if(!Number.isSafeInteger(state.revision)||Number(state.revision)<0)reject('OWNER_REVISION_INVALID','Plan validation needs the current owner revision');
      const request:OwnerRequest={operation:'native.package.validate',scope,input:{id:p.owners[kind].reference.id,version:p.owners[kind].reference.version,context,...(kind==='harness'?{observation}:{})},requestId:'plan-native-'+valueDigest({requestId:r.id,projectId:r.projectId,owner:kind}).slice(7,55),expectedRevision:Number(state.revision)};
      const body={request,requestDigest:ownerRequestDigest(kind,request),context,observationDigest:kind==='harness'?nativeSha256(observation):null};retain(actor,r.projectId,'plan-stage-native-action',r.id+':'+kind,{...body,digest:valueDigest(body)});
      actor=await permit();signal.throwIfAborted();authorize(actor,r.projectId,'execution.request');
      if(actor.id!==r.initiatedBy.id||actor.revision!==r.initiatedBy.revision||valueDigest(validate(packet,instance.definition,actor))!==p.factsDigest)reject('PREPARATION_CHANGED','Plan authority or material changed before validation',409);
      await a.mutate(actor,r.projectId,request,{projectId:r.projectId,owner:kind,requestDigest:body.requestDigest,authorityRef:r.authorityRef,expiresAt:r.deadlineAt});
      const result=await inspect(r,instance,null,actor,signal);if(result.phase==='FAILED'||result.phase==='UNKNOWN')return result;
    }
    return inspect(r,instance,null,actor,signal);
  }
  return{async prepare(instance,stageId,actor,signal):Promise<StagePlan>{
    if(stageId!=='plan')reject('STAGE_ADAPTER_UNAVAILABLE','This fixed adapter owns the plan stage only',409);signal.throwIfAborted();
    const packet=selected(instance),prior=scope(instance,packet),facts=validate(packet,instance.definition,actor),config=readIntegrationConfiguration(configPath,store.workspaceId),pins={} as Record<Owner,OwnerPin>;let effectiveConfigDigest='';
    for(const kind of ['ontology','harness'] as const){
      const selected=record(atPath(instance.definition.semantic,'assets.'+kind)),mapping=resource(config,instance.definition,'assets.'+kind+'.mappingRef'),reference=mapping.definition.reference as NativeReference;
      validateNativeReference(reference,{product:kind});if(reference.id!==selected.id||reference.version!==selected.version||reference.digest!==selected.digest||reference.visibility!==selected.visibility)reject('OWNER_SCOPE','Plan mapping differs from the selected immutable asset');
      const a=connections.owner(string(selected.adapterRef),config),scope={visibility:reference.visibility,projectId:string(selected.projectId)};
      if(a.workspaceId!==store.workspaceId||a.owner!==kind)reject('OWNER_SCOPE','Plan owner scope differs');
      const material=await a.readPackage(actor,instance.pins.projectId,scope,reference);
      pins[kind]={ref:string(selected.adapterRef),registrationDigest:hash(record(a.capabilities()).registrationDigest),scope,reference,criteria:nativeInventory(record(material.package),kind)};
      if(kind==='harness'){const report=record(material.validation),{reportDigest,...body}=report;if(reportDigest!==nativeSha256(body)||!same(report.reference,reference)||report.qualityStatus!=='PASS')reject('OWNER_BASELINE_INVALID','Published plan Harness validation is unavailable');effectiveConfigDigest=hash(report.effectiveConfigDigest);}
    }
    signal.throwIfAborted();const p:PlanParameters={preparationRef:instance.pins.targetRef,preparationDigest:packet.digest,factsDigest:valueDigest(facts),scopeRequestId:prior.requestId,scopeEvidenceDigest:prior.digest,expectedChecks:instance.definition.nodes.find(n=>n.id==='plan')!.checks,owners:pins,effectiveConfigDigest,toolchainLockDigest:connections.toolchainLockDigest,toolchainManifestDigest:connections.toolchainManifestDigest??null};
    return{adapterId:PLAN_ID,adapterDigest:PLAN_DIGEST,action:'base.plan',bindingDigest:valueDigest(p),parameters:p as unknown as Record<string,unknown>};
  },dispatch:execute,inspect,advance:async(r,instance,_progress,permit,signal)=>execute(r,instance,permit,signal)};
}
function platform(config:Readonly<IntegrationConfiguration>,definition:EffectiveDefinition,actor:Principal):PlatformRegistration{
  const d=record(atPath(definition.semantic,'config.implementation')),matches=config.platforms.filter(p=>p.projectId===definition.projectId&&['provider','host','repository','repositoryId','defaultBranch','credentialRef'].every(k=>(p as unknown as Record<string,unknown>)[k]===d[k]));
  if(matches.length!==1)reject('PREPARATION_SOURCE','Preparation needs one exact registered source platform',409);return configuredPlatform(config,actor,definition.projectId,matches[0].ref);
}
/** Project configuration fixes locations and rules. Actual target/plan bytes
 * arrive later in an immutable per-instance packet, before its exact review. */
export function registeredPreparation(configPath:string,workspaceId:string):PreparationValidator{
  return(packet,definition,actor)=>{
    authorize(actor,definition.projectId,'read');const config=readIntegrationConfiguration(configPath,workspaceId);
    if(packet.workspaceId!==workspaceId||packet.projectId!==definition.projectId||packet.semanticDigest!==definition.semanticDigest)reject('PREPARATION_SCOPE','Preparation belongs to another workspace or definition',403);
    const roles=['config.scope.targetInputRef','config.scope.baselineRuleRef','config.scope.requirementsMappingRef','config.scope.deliveryTargetRef','config.plan.planLocationRef','config.plan.adrLocationRef','config.plan.compatibilityPolicyRef','config.plan.reviewPolicyRef','config.plan.recoveryPolicyRef','config.verification.evidenceMappingRef'];
    const resources=roles.map(role=>resource(config,definition,role)),selected=(role:string)=>resources.find(r=>r.role===role)!.definition;
    const source=platform(config,definition,actor);
    if(source.provider!==packet.input.source.provider||source.repositoryId!==packet.input.source.repositoryId)reject('PREPARATION_SOURCE','Target source is not the configured project repository',409);
    const version=packet.input.target.version,rule=atPath(definition.semantic,'config.candidate.versionRule');
    if(rule==='semver'?!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(version):! /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(version)||version==='latest')reject('PREPARATION_VERSION','Target version must follow the selected immutable version rule');
    const files:Record<string,unknown>={};
    for(const [role,pin] of Object.entries(packet.input.documents)){
      if(pin===null)continue;
      const directory=string(selected(role==='impact'||role==='migration'?'config.plan.adrLocationRef':'config.plan.planLocationRef').directory,4096),within=relative(directory,pin.path);
      if(!within||within==='..'||within.startsWith('..'+sep)||within.startsWith(sep))reject('PREPARATION_DOCUMENT_SCOPE','Preparation document must stay inside its configured location',403);
      files[role]={...verifyResourceFile(pin),path:pin.path};
    }
    const rows=selected('config.verification.evidenceMappingRef').rows as Record<string,unknown>[];
    for(const check of packet.input.verification.checks){const row=rows.find(r=>r.stage===check.stageId&&r.checkId===check.checkId);if(!row||row.source!==check.source)reject('PREPARATION_EVIDENCE_MAPPING','Planned evidence source must match its exact registered check',409);}
    return{reviewerIds:selected('config.plan.reviewPolicyRef').reviewerIds as string[],evidence:{configurationDigest:valueDigest(resources),documents:files,sourceRegistration:source,requirementsMapping:resource(config,definition,'config.scope.requirementsMappingRef').definition}};
  };
}

const ID='runtime-scope-stage-v1',ADAPTER_DIGEST=valueDigest({id:ID,preparation:'runtime-preparation/v1',checks:['target-scope','requirements-mapping'],continuation:'explicit-local-commit'});
interface ScopePlan {preparationRef:string;preparationDigest:string;factsDigest:string;platform:PlatformRegistration;sourceCommit:string;expectedChecks:string[];}
export function createScopeStageAdapter(store:RuntimeStore,configPath:string,connections:Pick<BindingConnections,'platform'>):StageAdapter{
  const validate=registeredPreparation(configPath,store.workspaceId);
  function selected(instance:LifecycleInstance):PreparationPacket{
    inspectInstance(instance);const p=readPreparationPacket(store,instance.pins.projectId,instance.pins.targetRef);
    if(p.input.definitionRevisionId!==instance.pins.definitionRevisionId||p.semanticDigest!==instance.pins.semanticDigest||p.input.goalRef!==instance.pins.goalRef||p.input.loopRef!==instance.pins.loopRef)reject('PREPARATION_SCOPE','Instance must retain the reviewed preparation, goal and loop',409);return p;
  }
  function original(r:StageRequest,instance:LifecycleInstance,actor:Principal):{p:ScopePlan;packet:PreparationPacket}{
    authorize(actor,r.projectId,'read');const packet=selected(instance),p=r.plan.parameters as unknown as ScopePlan;
    if(r.workspaceId!==store.workspaceId||r.projectId!==instance.pins.projectId||r.instanceId!==instance.id||r.pinsDigest!==instance.pinsDigest||r.stageId!=='scope'||r.plan.adapterId!==ID||r.plan.adapterDigest!==ADAPTER_DIGEST||r.plan.action!=='base.scope'||r.planDigest!==valueDigest(r.plan)||r.plan.bindingDigest!==valueDigest(p)||p.preparationRef!==instance.pins.targetRef||p.preparationDigest!==packet.digest||!same(p.expectedChecks,instance.definition.nodes.find(n=>n.id==='scope')!.checks))reject('STAGE_PLAN_MISMATCH','Scope evidence differs from its retained original plan',409);
    return{p,packet};
  }
  function observation(r:StageRequest,p:ScopePlan,complete:boolean,evidenceRef:string):StageObservation{
    return{requestId:r.id,inputDigest:r.inputDigest,adapterDigest:ADAPTER_DIGEST,phase:complete?'COMPLETE':'UNKNOWN',handle:{preparationRef:p.preparationRef},outcome:{requestId:r.id,inputDigest:r.inputDigest,receiptRef:'runtime:scope-stage/'+r.id,status:complete?'COMPLETE':'UNKNOWN',expiresAt:r.deadlineAt,checks:complete?p.expectedChecks.map(id=>({id,status:'PASS',evidenceRef})):[]}};
  }
  async function inspect(r:StageRequest,instance:LifecycleInstance,_progress:unknown,actor:Principal,signal:AbortSignal):Promise<StageObservation>{
    signal.throwIfAborted();const{p}=original(r,instance,actor),raw=store.object(r.projectId,'scope-stage-evidence',r.id);
    if(!raw)return observation(r,p,false,'runtime:scope-stage/'+r.id);
    const e=record(raw),{digest,...body}=e;
    if(digest!==valueDigest(body)||e.requestDigest!==r.digest||e.planDigest!==r.planDigest||e.preparationDigest!==p.preparationDigest)reject('CORRUPT_STAGE_EVIDENCE','Scope evidence changed',503);
    return observation(r,p,true,String(digest));
  }
  async function dispatch(r:StageRequest,instance:LifecycleInstance,permit:()=>Promise<Principal>,signal:AbortSignal):Promise<StageObservation>{
    let actor=await permit();const{p,packet}=original(r,instance,actor);
    if(store.object(r.projectId,'scope-stage-evidence',r.id))return inspect(r,instance,null,actor,signal);
    const facts=validate(packet,instance.definition,actor);if(valueDigest(facts)!==p.factsDigest)reject('PREPARATION_CHANGED','Reviewed preparation resources changed',409);
    const current=await connections.platform(p.platform).readiness(actor,signal);
    if(current.commit!==p.sourceCommit||current.bindingDigest!==valueDigest(p.platform)||current.repositoryId!==p.platform.repositoryId||current.projectId!==r.projectId||Date.parse(current.expiresAt)<=Date.now())reject('PREPARATION_SOURCE_CHANGED','Exact reviewed source baseline is no longer current',409);
    actor=await permit();signal.throwIfAborted();authorize(actor,r.projectId,'execution.request');
    if(actor.id!==r.initiatedBy.id||actor.revision!==r.initiatedBy.revision||Date.parse(r.deadlineAt)<=Date.now()||valueDigest(validate(packet,instance.definition,actor))!==p.factsDigest)reject('PREPARATION_CHANGED','Original scope authority or inputs changed before retention',409);
    const body={schema:'runtime-scope-evidence/v1',requestDigest:r.digest,planDigest:r.planDigest,preparationDigest:packet.digest,authorityRef:r.authorityRef,requirementsDigest:instance.pins.requirementsDigest,facts,source:current,verifiedAt:new Date().toISOString(),softwareRelease:false},evidence={...body,digest:valueDigest(body)};
    store.mutate(actor,{projectId:r.projectId,operation:'lifecycle.scope.evidence',requestId:'scope-fact-'+randomUUID(),expectedRevision:store.revision(r.projectId),input:{stageRequestId:r.id,digest:evidence.digest},permission:'execution.request'},()=>({objects:[{kind:'scope-stage-evidence',id:r.id,value:evidence}],value:{stageRequestId:r.id,evidenceRef:evidence.digest},event:{type:'scope-evidence-retained',data:{instanceId:r.instanceId,stageRequestId:r.id,evidenceRef:evidence.digest}}}));
    return inspect(r,instance,null,actor,signal);
  }
  return{async prepare(instance,stageId,actor,signal):Promise<StagePlan>{
    if(stageId!=='scope')reject('STAGE_ADAPTER_UNAVAILABLE','This fixed adapter handles scope evidence only',409);signal.throwIfAborted();
    const packet=selected(instance),facts=validate(packet,instance.definition,actor),config=readIntegrationConfiguration(configPath,store.workspaceId),source=platform(config,instance.definition,actor);
    const p:ScopePlan={preparationRef:instance.pins.targetRef,preparationDigest:packet.digest,factsDigest:valueDigest(facts),platform:source,sourceCommit:packet.input.source.commit,expectedChecks:instance.definition.nodes.find(n=>n.id==='scope')!.checks};
    return{adapterId:ID,adapterDigest:ADAPTER_DIGEST,action:'base.scope',bindingDigest:valueDigest(p),parameters:p as unknown as Record<string,unknown>};
  },dispatch,inspect,advance:async(r,instance,_progress,permit,signal)=>dispatch(r,instance,permit,signal)};
}
