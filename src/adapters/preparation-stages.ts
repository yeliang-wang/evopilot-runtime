import { randomUUID } from 'node:crypto';
import { relative, sep } from 'node:path';
import { canonical, record, reject, string } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import { RuntimeStore } from '../server/store.js';
import { valueDigest } from '../lifecycle/base.js';
import { atPath, type EffectiveDefinition } from '../lifecycle/compiler.js';
import { inspectInstance, type LifecycleInstance } from '../lifecycle/instance.js';
import { readPreparationPacket, type PreparationPacket, type PreparationValidator } from '../lifecycle/preparation.js';
import type { StageAdapter, StageObservation, StagePlan, StageRequest } from '../lifecycle/execution.js';
import { readIntegrationConfiguration, configuredPlatform, type IntegrationConfiguration, type PlatformRegistration } from './config.js';
import { validateResourceDefinition, verifyResourceFile, type BindingConnections } from './bindings.js';

const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function resource(config:Readonly<IntegrationConfiguration>,definition:EffectiveDefinition,role:string){
  const r=config.resources.find(r=>r.ref===atPath(definition.semantic,role)&&r.projectId===definition.projectId&&r.role===role);
  if(!r||Date.parse(r.expiresAt)<=Date.now())reject('PREPARATION_BINDING_MISSING','Current exact scoped preparation resource is required',409);validateResourceDefinition(r);return r;
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
