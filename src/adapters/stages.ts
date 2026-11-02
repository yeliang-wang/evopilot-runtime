import { randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, exact, record, reject, ServiceError, string } from '../server/errors.js';
import { authorize, privateFile, type Principal } from '../server/security.js';
import { RuntimeStore } from '../server/store.js';
import { byteDigest, valueDigest } from '../lifecycle/base.js';
import { atPath } from '../lifecycle/compiler.js';
import { inspectInstance, type LifecycleInstance } from '../lifecycle/instance.js';
import type { StageAdapter, StageObservation, StagePlan, StageProgress, StageRequest } from '../lifecycle/execution.js';
import { nativeSha256, validateNativeReference, type NativeReference, type NativeScope, type NativeValidationContext } from '../../vendor/compatibility/v1/native.mjs';
import { configuredPlatform, readIntegrationConfiguration, type IntegrationConfiguration, type PlatformRegistration } from './config.js';
import { validateResourceDefinition, type BindingConnections } from './bindings.js';
import { ciSourceRef, type PlatformArtifactArchive, type PlatformClient, type PlatformRunObservation, type PlatformRunRequest } from './platforms.js';
import { MAX_ARCHIVE_BYTES, ciSourceDigest, readArtifactArchive, verifyCiArtifact, type VerifiedCiArtifact } from './artifacts.js';
import { ownerRequestDigest, type Owner, type OwnerRequest, type PublishedOwnerAdapter } from './published-owners.js';

const ADAPTER_ID='runtime-ci-owner-stage-v1';
const ADAPTER_DIGEST=valueDigest({id:ADAPTER_ID,stages:['candidate','verification'],workflow:'runtime-ci/v1',owners:'native/v1',observation:'runtime-ci-owner-values/v1',continuation:'explicit-original-request/v1'});
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
type Pair={criterionId:string;variantId:string};
interface OwnerPin {ref:string;registrationDigest:string;scope:NativeScope;reference:NativeReference;criteria:Pair[];}
interface CiPlan {
  stageId:'candidate'|'verification'; binding:PlatformRegistration; commit:string; workflowDigest:string;
  expectedChecks:string[]; owners:Record<Owner,OwnerPin>; toolchainLockDigest:string;
  toolchainManifestDigest?:string;
  effectiveConfigDigest:string; candidateDigest:string|null;
}
interface NativeAction {request:OwnerRequest;requestDigest:string;context:NativeValidationContext;observationDigest:string|null;digest:string;}
interface OwnerResult {owner:Owner;status:'PASS'|'FAIL'|'UNKNOWN';receiptDigest:string|null;reportDigest:string|null;}
export interface NativeStageConnections extends Pick<BindingConnections,'owner'|'platform'> {toolchainLockDigest:string;toolchainManifestDigest?:string;}
const hash=(v:unknown):string=>{const s=string(v,71);if(!/^sha256:[a-f0-9]{64}$/.test(s))reject('STAGE_EVIDENCE_INVALID','Exact evidence digest is required');return s;};
function packageJson(pkg:Record<string,unknown>,path:unknown):Record<string,unknown>{
  const text=record(pkg.files)[string(path,512)];if(typeof text!=='string'||Buffer.byteLength(text)>2097152)reject('OWNER_PACKAGE_INVALID','A bounded owner inventory is required');
  try{return record(JSON.parse(text));}catch{return reject('OWNER_PACKAGE_INVALID','Owner inventory is not valid JSON');}
}
function inventory(pkg:Record<string,unknown>,owner:Owner):Pair[]{
  const entry=record(record(pkg.manifest).entrypoints),result:Pair[]=[];
  const pairs=(ids:unknown,variants:unknown)=>{
    if(!Array.isArray(ids)||!ids.length||!Array.isArray(variants)||!variants.length)reject('OWNER_INVENTORY_INVALID','Native criterion and variant inventory is required');
    for(const id of ids)for(const variant of variants)result.push({criterionId:string(id,256),variantId:string(variant,256)});
  };
  if(owner==='harness'){
    const coverage=packageJson(pkg,entry.coverage);if(!Array.isArray(coverage.requirements))reject('OWNER_INVENTORY_INVALID','Harness requirements are missing');
    for(const raw of coverage.requirements){const r=record(raw);if(!Array.isArray(r.caseIds))reject('OWNER_INVENTORY_INVALID','Harness cases are missing');pairs([r.id],[...r.caseIds,'actual-observation']);}
  }else{
    const cases=packageJson(pkg,entry.cases);if(!Array.isArray(cases.cases))reject('OWNER_INVENTORY_INVALID','Ontology cases are missing');
    for(const raw of cases.cases){const c=record(raw);pairs(c.requirementIds,[c.id]);}
  }
  if(!result.length||result.length>4096||new Set(result.map(p=>p.criterionId+'\0'+p.variantId)).size!==result.length)reject('OWNER_INVENTORY_INVALID','Native inventory is empty, duplicated or too large');
  return result.sort((a,b)=>(a.criterionId+'\0'+a.variantId).localeCompare(b.criterionId+'\0'+b.variantId));
}

/** CI-backed candidate and verification composition. Other base/extension
 * actions remain separate fixed adapters, not generic commands supplied by YAML.
 * The service worker only inspects. Codex explicitly requests advance after CI
 * completion to run the already planned owner validations under current permits. */
export function createCiStageAdapter(store:RuntimeStore,configPath:string,connections:NativeStageConnections):StageAdapter{
  hash(connections.toolchainLockDigest);
  if(connections.toolchainManifestDigest!==undefined)hash(connections.toolchainManifestDigest);
  const system=(projectId:string):Principal=>({id:'runtime:stage-adapter',projects:[projectId],permissions:['read'],revision:1,expiresAt:new Date(Date.now()+60000).toISOString()});
  function retain(projectId:string,kind:string,id:string,value:unknown,immutable=false):void{
    const old=store.object(projectId,kind,id);if(old&&same(old,value))return;
    if(old&&immutable)reject('STAGE_EVIDENCE_CHANGED','Original stage evidence cannot be replaced',409);
    store.mutate(system(projectId),{projectId,operation:'lifecycle.stage.evidence',requestId:'stage-fact-'+randomUUID(),expectedRevision:store.revision(projectId),input:{kind,id,digest:valueDigest(value)},permission:'read'},()=>({objects:[{kind,id,value}],value:{kind,id,digest:valueDigest(value)},event:{type:'stage-evidence-retained',data:{kind,id,digest:valueDigest(value)}}}));
  }
  function archiveBytes(archive:PlatformArtifactArchive):void{
    if(byteDigest(archive.bytes)!==archive.archiveDigest)reject('CI_ARTIFACT_INTEGRITY','Downloaded archive digest changed');
    const root=join(store.root,'stage-ci-artifacts');mkdirSync(root,{recursive:true,mode:0o700});
    const stat=lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(root)!==root||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)reject('UNSAFE_STATE','Stage evidence directory is not private');
    const path=join(root,hash(archive.archiveDigest).slice(7)+'.zip');
    if(existsSync(path)){privateFile(path);const s=lstatSync(path);if(s.size!==archive.bytes.length||byteDigest(readFileSync(path))!==archive.archiveDigest)reject('CI_ARTIFACT_INTEGRITY','Retained archive bytes differ');return;}
    const temporary=join(root,randomUUID()+'.pending'),fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{writeFileSync(fd,archive.bytes);fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(temporary,path);const directory=openSync(root,constants.O_RDONLY);try{fsyncSync(directory);}finally{closeSync(directory);}
  }
  function configuration(actor:Principal,projectId:string):Readonly<IntegrationConfiguration>{authorize(actor,projectId,'read');return readIntegrationConfiguration(configPath,store.workspaceId);}
  function resource(config:Readonly<IntegrationConfiguration>,instance:LifecycleInstance,role:string){
    const ref=atPath(instance.definition.semantic,role),r=config.resources.find(x=>x.ref===ref&&x.projectId===instance.pins.projectId&&x.role===role);
    if(!r||Date.parse(r.expiresAt)<=Date.now())reject('STAGE_BINDING_UNAVAILABLE','Current scoped stage resource is required');validateResourceDefinition(r);return r;
  }
  function owner(config:Readonly<IntegrationConfiguration>,pin:OwnerPin,kind:Owner,projectId:string):PublishedOwnerAdapter{
    const registration=config.owners.find(x=>x.ref===pin.ref&&x.owner===kind&&x.projects.includes(projectId));if(!registration)reject('OWNER_BINDING_CHANGED','Original scoped owner registration is unavailable');
    const a=connections.owner(pin.ref,config);
    if(a.owner!==kind||a.workspaceId!==store.workspaceId||record(a.capabilities()).registrationDigest!==pin.registrationDigest)reject('OWNER_BINDING_CHANGED','Original owner connection differs');return a;
  }
  async function prepare(instance:LifecycleInstance,stageId:string,actor:Principal,signal:AbortSignal):Promise<StagePlan>{
    inspectInstance(instance);signal.throwIfAborted();
    if(stageId!=='candidate'&&stageId!=='verification')reject('STAGE_ADAPTER_UNAVAILABLE','This fixed adapter owns candidate and verification CI stages only',409);
    if(stageId==='candidate'&&instance.candidate||stageId==='verification'&&!instance.candidate)reject('CANDIDATE_SCOPE','Stage does not match the current immutable candidate');
    const config=configuration(actor,instance.pins.projectId),workflow=resource(config,instance,'config.'+stageId+'.'+(stageId==='candidate'?'buildWorkflowRef':'verifyWorkflowRef'));
    const binding=configuredPlatform(config,actor,instance.pins.projectId,string(workflow.definition.platformRef));
    const implementation=record(atPath(instance.definition.semantic,'config.implementation'));
    for(const key of ['provider','host','repository','repositoryId','defaultBranch'] as const)if(binding[key]!==implementation[key])reject('PLATFORM_SCOPE','CI stage uses a different source repository');
    const current=await connections.platform(binding).readiness(actor,signal);
    if(current.bindingDigest!==valueDigest(binding)||current.projectId!==instance.pins.projectId||current.repositoryId!==binding.repositoryId||Date.parse(current.expiresAt)<=Date.now())reject('PLATFORM_SCOPE','CI stage readiness differs from its registration');
    if(instance.candidate&&instance.candidate.sourceDigest!==ciSourceDigest({commit:current.commit} as PlatformRunRequest,binding.provider,binding.repositoryId))reject('CANDIDATE_SOURCE_CHANGED','Verification cannot move the pinned candidate to another source commit');
    const pins={} as Record<Owner,OwnerPin>;let effectiveConfigDigest='';
    for(const kind of ['ontology','harness'] as const){
      const selected=record(atPath(instance.definition.semantic,'assets.'+kind)),mapping=resource(config,instance,'assets.'+kind+'.mappingRef'),reference=mapping.definition.reference as NativeReference;
      validateNativeReference(reference,{product:kind});if(reference.id!==selected.id||reference.version!==selected.version||reference.digest!==selected.digest||reference.visibility!==selected.visibility)reject('OWNER_SCOPE','Stage mapping differs from the selected immutable asset');const adapter=connections.owner(string(selected.adapterRef),config),scope={visibility:reference.visibility,projectId:string(selected.projectId)};
      if(adapter.workspaceId!==store.workspaceId||adapter.owner!==kind)reject('OWNER_SCOPE','Selected owner scope differs');
      const material=await adapter.readPackage(actor,instance.pins.projectId,scope,reference),pkg=record(material.package);
      pins[kind]={ref:string(selected.adapterRef),registrationDigest:hash(record(adapter.capabilities()).registrationDigest),scope,reference,criteria:inventory(pkg,kind)};
      if(kind==='harness'){const validation=record(material.validation),{reportDigest,...body}=validation;
        if(reportDigest!==nativeSha256(body)||!same(validation.reference,reference)||validation.qualityStatus!=='PASS')reject('OWNER_BASELINE_INVALID','Published Harness configuration validation is unavailable');
        effectiveConfigDigest=hash(validation.effectiveConfigDigest);
      }
    }
    signal.throwIfAborted();
    const parameters:CiPlan={stageId,binding,commit:current.commit,workflowDigest:current.workflowDigest,expectedChecks:[...instance.definition.nodes.find(n=>n.id===stageId)!.checks],owners:pins,toolchainLockDigest:connections.toolchainLockDigest,...(connections.toolchainManifestDigest?{toolchainManifestDigest:connections.toolchainManifestDigest}:{}),effectiveConfigDigest,candidateDigest:instance.candidateDigest};
    return{adapterId:ADAPTER_ID,adapterDigest:ADAPTER_DIGEST,action:'base.'+stageId,bindingDigest:valueDigest(parameters),parameters:parameters as unknown as Record<string,unknown>};
  }
  function plan(r:StageRequest,instance:LifecycleInstance,actor:Principal):{p:CiPlan;config:Readonly<IntegrationConfiguration>;client:PlatformClient;ci:PlatformRunRequest}{
    inspectInstance(instance);const p=r.plan.parameters as unknown as CiPlan,config=configuration(actor,r.projectId);
    if(p.toolchainManifestDigest!==connections.toolchainManifestDigest)reject('TOOLCHAIN_CHANGED','Original native stage manifest cannot change across service restarts',409);
    if(r.workspaceId!==store.workspaceId||r.projectId!==instance.pins.projectId||r.instanceId!==instance.id||r.pinsDigest!==instance.pinsDigest||r.plan.adapterId!==ADAPTER_ID||r.plan.adapterDigest!==ADAPTER_DIGEST||r.plan.action!=='base.'+r.stageId||r.plan.bindingDigest!==valueDigest(p)||valueDigest(r.plan)!==r.planDigest||p.stageId!==r.stageId||!['candidate','verification'].includes(p.stageId)||p.toolchainLockDigest!==connections.toolchainLockDigest||p.candidateDigest!==instance.candidateDigest||!same(p.expectedChecks,instance.definition.nodes.find(n=>n.id===r.stageId)?.checks))reject('STAGE_PLAN_MISMATCH','CI execution differs from its original immutable stage plan');
    const current=configuredPlatform(config,actor,r.projectId,p.binding.ref);if(!same(current,p.binding))reject('PLATFORM_BINDING_CHANGED','Original stage platform registration changed');
    for(const kind of ['ontology','harness'] as const)owner(config,p.owners[kind],kind,r.projectId);
    const ci:PlatformRunRequest={schema:'runtime-ci-request/v1',requestId:'stage-'+valueDigest({workspaceId:r.workspaceId,projectId:r.projectId,requestId:r.id}).slice(7,55),projectId:r.projectId,bindingDigest:valueDigest(p.binding),commit:p.commit,workflowDigest:p.workflowDigest,inputDigest:r.inputDigest,stageId:r.stageId,candidateDigest:p.candidateDigest,requestedAt:r.requestedAt,deadlineAt:r.deadlineAt};
    return{p,config,client:connections.platform(p.binding),ci};
  }
  function observation(r:StageRequest,p:CiPlan,ci:PlatformRunRequest,phase:StageObservation['phase'],checks:StageObservation['outcome']['checks']=[],candidate?:NonNullable<LifecycleInstance['candidate']>):StageObservation{
    return{requestId:r.id,inputDigest:r.inputDigest,adapterDigest:ADAPTER_DIGEST,phase,handle:{provider:p.binding.provider,repositoryId:p.binding.repositoryId,requestId:ci.requestId,ref:ciSourceRef(ci)},outcome:{requestId:r.id,inputDigest:r.inputDigest,receiptRef:'runtime:ci-stage/'+r.id,status:phase==='COMPLETE'?'COMPLETE':phase==='FAILED'?'FAILED':phase==='UNKNOWN'?'UNKNOWN':'RUNNING',expiresAt:r.deadlineAt,checks,...(candidate?{candidate}:{})}};
  }
  function pinRun(r:StageRequest,value:PlatformRunObservation):void{
    if(value.runId)retain(r.projectId,'ci-stage-run',r.id,{requestId:value.requestId,runId:value.runId},true);
    retain(r.projectId,'ci-stage-observation',r.id,value);
  }
  function action(r:StageRequest,kind:Owner):NativeAction|null{
    const v=store.object(r.projectId,'stage-native-action',r.id+':'+kind) as NativeAction|null;if(!v)return null;
    const {digest,...body}=v;if(valueDigest(body)!==digest||ownerRequestDigest(kind,v.request)!==v.requestDigest)reject('CORRUPT_STAGE_ACTION','Original native validation request changed',503);return v;
  }
  async function ownerResult(r:StageRequest,p:CiPlan,config:Readonly<IntegrationConfiguration>,kind:Owner,actor:Principal):Promise<OwnerResult>{
    const a=action(r,kind),result:OwnerResult={owner:kind,status:'UNKNOWN',receiptDigest:null,reportDigest:null};if(!a)return result;
    let receipt:Record<string,unknown>;try{receipt=record(await owner(config,p.owners[kind],kind,r.projectId).read(actor,r.projectId,{operation:'native.receipt.inspect',scope:a.request.scope,input:{requestId:a.request.requestId}}));}
    catch(error){if(error instanceof ServiceError&&error.code==='NOT_FOUND')return result;throw error;}
    if(receipt.requestId!==a.request.requestId||receipt.operation!==a.request.operation||!same(receipt.scope,a.request.scope)||receipt.requestDigest!==nativeSha256({operation:a.request.operation,scope:a.request.scope,input:a.request.input}))reject('OWNER_RECEIPT_MISMATCH','Native receipt differs from the exact original validation request');
    if(receipt.status==='RUNNING'||record(receipt.result??{}).status==='RUNNING'||receipt.status==='UNKNOWN')return result;
    if(kind==='harness'&&receipt.status==='FAILED'){retain(r.projectId,'stage-native-receipt',r.id+':'+kind,receipt);return{...result,status:'FAIL',receiptDigest:nativeSha256(receipt)};}
    const report=record(receipt.result),{reportDigest,...body}=report;
    if(reportDigest!==nativeSha256(body)||!same(report.context,a.context)||report.toolchainLockDigest!==p.toolchainLockDigest)reject('OWNER_REPORT_MISMATCH','Native report context, toolchain or content differs');
    const status=kind==='ontology'?report.status:report.qualityStatus;
    if(kind==='ontology'?(report.packageDigest!==p.owners.ontology.reference.digest||!same(report.standardPins,{standardDigest:p.owners.ontology.reference.standardDigest,standardLockDigest:p.owners.ontology.reference.standardLockDigest})):
      (!same(report.reference,p.owners.harness.reference)||report.observationDigest!==a.observationDigest||report.effectiveConfigDigest!==p.effectiveConfigDigest))reject('OWNER_REPORT_MISMATCH','Native report asset, configuration or observation differs');
    if(!Array.isArray(report.criteria))reject('OWNER_REPORT_INCOMPLETE','Native report has no fixed criterion results');
    const criteria=report.criteria.map(raw=>{const c=record(raw);exact(c,['criterionId','variantId','status','evidenceDigest']);hash(c.evidenceDigest);if(!['PASS','FAIL','ERROR','UNKNOWN','SKIPPED'].includes(String(c.status)))reject('OWNER_REPORT_INCOMPLETE','Unknown native criterion status');return c;});
    const pairs=criteria.map(c=>({criterionId:string(c.criterionId),variantId:string(c.variantId)})).sort((a,b)=>(a.criterionId+'\0'+a.variantId).localeCompare(b.criterionId+'\0'+b.variantId));
    if(!same(pairs,p.owners[kind].criteria))reject('OWNER_REPORT_INCOMPLETE','Native report omits or changes a fixed criterion/variant');
    const passed=(kind==='ontology'?status==='CONFORMS':status==='PASS'&&report.executionStatus==='SUCCEEDED')&&criteria.every(c=>c.status==='PASS');
    const failed=['NONCONFORMING','FAIL','ERROR','UNSUPPORTED'].includes(String(status))||criteria.some(c=>['FAIL','ERROR','SKIPPED'].includes(String(c.status)));
    const output:OwnerResult={owner:kind,status:passed?'PASS':failed?'FAIL':'UNKNOWN',receiptDigest:nativeSha256(receipt),reportDigest:String(reportDigest)};
    retain(r.projectId,'stage-native-receipt',r.id+':'+kind,receipt);return output;
  }
  async function inspect(r:StageRequest,instance:LifecycleInstance,_progress:StageProgress,actor:Principal,signal:AbortSignal):Promise<StageObservation>{
    const {p,config,client,ci}=plan(r,instance,actor),known=store.object(r.projectId,'ci-stage-run',r.id) as {runId:string}|null;
    const run=await client.run(actor,ci,known?.runId??null,signal);pinRun(r,run);
    if(run.status==='PENDING'||run.status==='RUNNING')return observation(r,p,ci,run.status==='PENDING'?'CI_PENDING':'CI_RUNNING');
    if(run.status==='UNKNOWN'||!run.runId)return observation(r,p,ci,'UNKNOWN');
    if(run.status==='FAILED')return observation(r,p,ci,'FAILED');
    const archive=await client.artifact(actor,ci,run.runId,signal),verified=await verifyCiArtifact(archive,ci,p.expectedChecks,signal);archiveBytes(archive);
    retain(r.projectId,'ci-stage-artifact',r.id,verified,true);
    if(verified.status==='FAILED')return observation(r,p,ci,'FAILED',verified.checks.map(c=>({id:c.id,status:c.status,evidenceRef:verified.evidenceRef})));
    if(verified.status!=='PASSED')return observation(r,p,ci,'UNKNOWN');
    const owners=await Promise.all((['ontology','harness'] as const).map(kind=>ownerResult(r,p,config,kind,actor)));signal.throwIfAborted();
    const failed=owners.some(o=>o.status==='FAIL'),complete=owners.every(o=>o.status==='PASS');
    const evidence={schema:'runtime-ci-stage-evidence/v1',requestId:r.id,inputDigest:r.inputDigest,ci:verified,owners,softwareRelease:false},ref=valueDigest(evidence);retain(r.projectId,'ci-stage-evidence',ref,evidence,true);
    const checks=verified.checks.map(c=>({id:c.id,status:failed?'FAIL' as const:complete?'PASS' as const:'UNKNOWN' as const,evidenceRef:ref}));
    return observation(r,p,ci,failed?'FAILED':complete?'COMPLETE':'RUNNING',checks,complete&&p.stageId==='candidate'?verified.candidate!:undefined);
  }
  async function advance(r:StageRequest,instance:LifecycleInstance,progress:StageProgress,permit:()=>Promise<Principal>,signal:AbortSignal):Promise<StageObservation>{
    const actor=await permit(),{p,config,ci}=plan(r,instance,actor),observed=await inspect(r,instance,progress,actor,signal);
    if(observed.phase!=='RUNNING')return observed;
    const verified=store.object(r.projectId,'ci-stage-artifact',r.id) as VerifiedCiArtifact|null;if(!verified||verified.status!=='PASSED')reject('CI_EVIDENCE_REQUIRED','Owner validation waits for the exact complete CI artifact');
    const path=join(store.root,'stage-ci-artifacts',hash(verified.archiveDigest).slice(7)+'.zip');privateFile(path);if(lstatSync(path).size>MAX_ARCHIVE_BYTES)reject('CI_ARCHIVE_LIMIT','Retained archive exceeds its fixed byte bound');const bytes=readFileSync(path);
    if(byteDigest(bytes)!==verified.archiveDigest)reject('CI_ARTIFACT_INTEGRITY','Retained original archive changed');
    const files=await readArtifactArchive(bytes,signal),raw=files.get('evidence/owner-values.json');if(!raw||raw.length>1048576)reject('OWNER_OBSERVATION_MISSING','CI must retain its rule input values as declared evidence/owner-values.json');
    let values:Record<string,unknown>;try{values=record(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)));}catch{return reject('OWNER_OBSERVATION_INVALID','CI owner values must be bounded UTF-8 JSON');}
    exact(values,['schema','values']);if(values.schema!=='runtime-ci-owner-values/v1')reject('OWNER_OBSERVATION_INVALID','CI owner values use a fixed input contract');record(values.values);
    const context:NativeValidationContext={workspaceId:r.workspaceId,scope:{visibility:'private',projectId:r.projectId},projectCandidateDigest:verified.candidateDigest??instance.pinsDigest,claimId:valueDigest({stageRequestDigest:r.digest}),inputDigest:r.inputDigest,effectiveConfigDigest:p.effectiveConfigDigest,sourceScopeDigest:ciSourceDigest(ci,p.binding.provider,p.binding.repositoryId),requirementSetDigest:instance.pins.requirementsDigest};
    const observationInput={schema:'evopilot-observation/v1',origin:'execution-result',source:{revision:p.commit,digest:context.sourceScopeDigest},values:values.values,collectionReceiptRef:{id:'ci-stage:'+r.id,digest:verified.resultDigest,claimId:context.claimId},sourceScopeDigest:context.sourceScopeDigest};
    for(const kind of ['ontology','harness'] as const){
      signal.throwIfAborted();if(action(r,kind))continue;
      const a=owner(config,p.owners[kind],kind,r.projectId),scope=p.owners[kind].scope,state=record(await a.read(actor,r.projectId,{operation:'workspace.inspect',scope,input:{}}));
      if(!Number.isSafeInteger(state.revision)||Number(state.revision)<0)reject('OWNER_REVISION_INVALID','Native owner revision is unavailable');
      const request:OwnerRequest={operation:'native.package.validate',scope,input:{id:p.owners[kind].reference.id,version:p.owners[kind].reference.version,context,...(kind==='harness'?{observation:observationInput}:{})},requestId:'stage-native-'+valueDigest({requestId:r.id,projectId:r.projectId,owner:kind}).slice(7,55),expectedRevision:Number(state.revision)};
      const body={request,requestDigest:ownerRequestDigest(kind,request),context,observationDigest:kind==='harness'?nativeSha256(observationInput):null};retain(r.projectId,'stage-native-action',r.id+':'+kind,{...body,digest:valueDigest(body)},true);
      const fresh=await permit();signal.throwIfAborted();authorize(fresh,r.projectId,'execution.request');
      if(fresh.id!==r.initiatedBy.id||fresh.revision!==r.initiatedBy.revision)reject('AUTHORITY_CHANGED','Native continuation requires the original current principal');
      await a.mutate(fresh,r.projectId,request,{projectId:r.projectId,owner:kind,requestDigest:body.requestDigest,authorityRef:r.authorityRef,expiresAt:r.deadlineAt});
    }
    return inspect(r,instance,progress,actor,signal);
  }
  return{prepare,inspect,advance,async dispatch(r,instance,permit,signal){
    const actor=await permit(),{p,client,ci}=plan(r,instance,actor);
    // The execution core persisted the original StageRequest before entering
    // here. Platform clients independently refuse replacement/ref redispatch.
    const run=await client.dispatch(ci,async requested=>{if(!same(requested,ci))reject('CI_REQUEST_MISMATCH','CI permit cannot change its original request');return permit();},signal);pinRun(r,run);
    if(run.status==='PENDING'||run.status==='RUNNING'||run.status==='UNKNOWN')return observation(r,p,ci,run.status==='PENDING'?'CI_PENDING':run.status==='RUNNING'?'CI_RUNNING':'UNKNOWN');
    return inspect(r,instance,{requestId:r.id,phase:'RUNNING',terminal:false,handle:null,observation:null,observationRef:null,reason:null,observedAt:new Date().toISOString()},actor,signal);
  }};
}
