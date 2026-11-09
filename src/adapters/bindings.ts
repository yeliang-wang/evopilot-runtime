import {AsyncLocalStorage} from 'node:async_hooks';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { canonical, exact, record, reject, slug, string, ServiceError } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import { byteDigest, valueDigest } from '../lifecycle/base.js';
import { atPath, type EffectiveDefinition } from '../lifecycle/compiler.js';
import { bindingRequirements, type BindingCheck, type DefinitionBindingProvider } from '../lifecycle/bindings.js';
import { nativeStableSerialize, nativeSha256, validateNativeReference, type NativePackage, type NativeReference, type NativeScope } from '../../vendor/compatibility/v1/native.mjs';
import { READINESS_STANDARD_DIGEST, type ReadinessProjection } from '../../vendor/compatibility/usability/v2/contract.mjs';
import { configuredPlatform, readIntegrationConfiguration, type IntegrationConfiguration, type PlatformRegistration, type ResourceRegistration } from './config.js';
import { openPublishedOwner, verifyReadinessView, type Owner, type PublishedOwnerAdapter } from './published-owners.js';
import type { PlatformClient, PlatformReadiness } from './platforms.js';
import { createRuntimeService } from '../service.js';
import type {LegacyIntentSource} from '../compat/gateway.js';
import { readPlatformToken } from './config.js';
import { githubClient } from './github.js';
import { gitlabClient } from './gitlab.js';
import { inspectExternalAgent, verifyCodexExecutable, type AgentIdentity } from './external-agent.js';
import { readRegisteredNativeToolchain } from './config.js';
import { createImplementationStageAdapters } from './implementation-stages.js';
import { releaseDocuments } from './documents.js';
import type { RuntimeStore, Receipt } from '../server/store.js';
import {createNativeQualificationService,createClosedFixtureQualificationProducer,qualifyEvidence,type NativeQualificationService,type NativeQualificationBindings,type ProtectedQualificationFacts,type QualificationAction,type QualificationMutationContext} from '../lifecycle/evidence-qualification.js';
import {LC20_CHILDREN,type QualificationSelection,type TypedCurrentExecutionCapture,type Lc20ProducerContract,type OriginalEvidenceExecution,type EvidenceInputManifest,type DifferentialEvidenceSelection,type DifferentialEvidenceCatalog,type DifferentialEvidenceCase,type RawEvidenceOutcome} from '../lifecycle/correction-contract.js';
import {createQualificationAssessmentAuthority,QUALIFICATION_AUTHORITY_READS,QUALIFICATION_AUTHORITY_WRITES,type QualificationAssessmentPlan,type PrincipalLookup} from './authority.js';
import {openProtectedCiObservationScope,nativeInventory,verifyNativeStageResult,protectedCiExecutionState,readProtectedCiExecution,readProtectedLc20Candidate,lc20ManagedHistoryState,type ProtectedLc20Candidate,type PublishedExecutionProducer} from './stages.js';
import {readCurrentCaseReceipt,readLc20ProducerContract,observeLc20Protocol,openLc20ObservationScope,prepareLc20Protocol} from './artifacts.js';
import type { StageAdapter, StageServices, StageRequest } from '../lifecycle/execution.js';
import { createReleaseStageAdapter } from './release-stages.js';
import { publicationTarget } from './distribution.js';
import { createPublicationStageAdapter } from './publication-stage.js';
import {readVerificationFeedback} from './stage-feedback.js';
import {createClosureStageAdapter} from './closure-stage.js';
import {registeredExtensionReview,type ExtensionReviewBindings} from '../lifecycle/extension-review.js';
import {inspectInstance,type LifecycleInstance} from '../lifecycle/instance.js';
import {createNativeExtensionStageAdapter} from './extension-stages.js';
import type { PreparationValidator } from '../lifecycle/preparation.js';
import { createPlanStageAdapter, createScopeStageAdapter, registeredPreparation } from './preparation-stages.js';
import { registeredImplementationReview, type ImplementationReviewBindings } from '../lifecycle/implementation-review.js';
import type { ReadinessIntentRecord } from '../../vendor/compatibility/usability/v2/contract.mjs';

export interface BindingConnections {
  /** Fixed product composition supplies these clients, never YAML or a request. */
  owner(ref:string,configuration:Readonly<IntegrationConfiguration>):PublishedOwnerAdapter;
  platform(binding:PlatformRegistration):PlatformClient;
  agent?(definition:Record<string,unknown>,signal:AbortSignal):Promise<AgentIdentity>;
}
interface Fact { value:unknown; expiresAt:string; }
interface Asset { selected:Record<string,unknown>; scope:NativeScope; reference:NativeReference; package:NativePackage; projection?:ReadinessProjection; grade?:ReturnType<typeof verifyReadinessView>; mapping:ResourceRegistration; }
const same=(a:unknown,b:unknown)=>nativeStableSerialize(a)===nativeStableSerialize(b);
const hash=(v:unknown):string=>{const s=string(v,71);if(!/^sha256:[a-f0-9]{64}$/.test(s))reject('INVALID_RESOURCE','Exact content digest is required');return s;};
const ref=(v:unknown):string=>{const s=string(v,256);if(!/^binding:[a-z0-9][a-z0-9/._-]*$/.test(s))reject('INVALID_RESOURCE','Registered binding reference is required');return s;};
function list(v:unknown,max=256):unknown[]{if(!Array.isArray(v)||!v.length||v.length>max)reject('INVALID_RESOURCE','A nonempty bounded list is required');return v;}
function strings(v:unknown,max=256):string[]{const a=list(v,max).map(x=>string(x,512));if(new Set(a).size!==a.length)reject('INVALID_RESOURCE','Duplicate resource entry');return a;}
function relativePath(v:unknown):string{const s=string(v,512);if(s.startsWith('/')||s.split('/').some(x=>!x||x==='.'||x==='..')||/[\\\u0000-\u001f]/.test(s))reject('INVALID_RESOURCE','A relative resource path is required');return s;}
function directory(v:unknown):string{const s=string(v,4096);if(!isAbsolute(s)||resolve(s)!==s||realpathSync(s)!==s||!lstatSync(s).isDirectory()||(lstatSync(s).mode&0o022)!==0)reject('UNSAFE_RESOURCE','Registered directory is absent, linked or writable by other users');return s;}
export function verifyResourceFile(value:unknown,executable=false):{digest:string;bytes:number}{
  const p=record(value);exact(p,['path','digest']);const path=string(p.path,4096),expected=hash(p.digest);
  if(!isAbsolute(path)||resolve(path)!==path||realpathSync(path)!==path)reject('UNSAFE_RESOURCE','Registered file is not canonical');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o022)!==0||stat.size<1||stat.size>(executable?268435456:1048576)||executable&&(stat.mode&0o111)===0)reject('UNSAFE_RESOURCE','Registered file does not meet its type/size/permission boundary');
    const digest=byteDigest(readFileSync(fd));if(digest!==expected)reject('RESOURCE_CHANGED','Registered file bytes changed',409);return{digest,bytes:stat.size};
  }finally{closeSync(fd);}
}
const roles:Record<string,string>={
  'runtime.qualification':'qualification',
  'config.scope.targetInputRef':'document','config.scope.baselineRuleRef':'baseline','config.scope.requirementsMappingRef':'requirements-map','config.scope.deliveryTargetRef':'delivery',
  'config.plan.planLocationRef':'location','config.plan.adrLocationRef':'location','config.plan.compatibilityPolicyRef':'compatibility','config.plan.reviewPolicyRef':'review','config.plan.recoveryPolicyRef':'recovery',
  'config.implementation.reviewPolicyRef':'review','config.implementation.agentBindingRef':'agent',
  'config.candidate.buildWorkflowRef':'workflow','config.candidate.toolchainRef':'toolchain','config.candidate.artifactLocationRef':'artifact-store','config.candidate.manifestActionRef':'manifest',
  'config.verification.environmentRef':'environment','config.verification.verifyWorkflowRef':'workflow','config.verification.evidenceMappingRef':'evidence-map','config.verification.failurePolicyRef':'failure',
  'config.release-decision.authorityPolicyRef':'authority-policy','config.release-decision.decisionSourceRef':'decision-source','config.release-decision.evidencePolicyRef':'evidence-policy',
  'config.publication.channelTargetRef':'channel','config.publication.publishWorkflowRef':'workflow','config.publication.readbackPolicyRef':'readback','config.publication.recoveryPolicyRef':'recovery',
  'config.closure.deliveryTargetRef':'delivery','config.closure.smokeWorkflowRef':'workflow','config.closure.archiveRef':'location','config.closure.followupPolicyRef':'followup',
  'assets.ontology.mappingRef':'asset-map','assets.harness.mappingRef':'asset-map','assets.ontology.standardRef':'standard','assets.harness.standardRef':'standard',
  'extension.check':'check','extension.requirement':'check','extension.mapping':'evidence-map','extension.review':'review','extension.workflow':'workflow',
};
function expectedKind(role:string):string{const kind=roles[role]??(/^config\.(plan|implementation|verification|release-decision|closure)\.requiredChecks$/.test(role)?'check':undefined);if(!kind)reject('UNKNOWN_RESOURCE_ROLE','Resource is not a publisher-supported configuration role');return kind;}
/** Configurable facts are deliberately separate from owner grades, actual
 * evidence and execution authority. A typed resource is never a future PASS. */
export function validateResourceDefinition(resource:ResourceRegistration):void{
  const d=record(resource.definition),kind=expectedKind(resource.role);if(d.kind!==kind)reject('RESOURCE_KIND_MISMATCH','Resource type does not match its lifecycle role');
  const fields=(required:string[],optional:string[]=[])=>exact(d,['kind',...required],optional);
  const yes=(k:string)=>{if(d[k]!==true)reject('INVALID_RESOURCE','Required resource safeguard cannot be disabled');};
  const fixed=(k:string,value:unknown)=>{if(d[k]!==value)reject('INVALID_RESOURCE','Resource cannot weaken the publisher contract');};
  switch(kind){
    case 'qualification':fields(['adapterRef','scope','reference','publicationRequestId','principalIds','probes']);ref(d.adapterRef);validateNativeReference(d.reference,{product:'harness'});{const s=record(d.scope);exact(s,['visibility','projectId']);if(s.projectId!==resource.projectId||s.visibility!==record(d.reference).visibility)reject('QUALIFICATION_SCOPE_CHANGED','Policy must belong to this exact project');}string(d.publicationRequestId,512);strings(d.principalIds,128).forEach(slug);if(!Array.isArray(d.probes)||d.probes.length>32)reject('INVALID_RESOURCE','Bounded registered probes required');{const ids=new Set<string>();for(const item of d.probes){const p=record(item);exact(p,['caseId','root'],['lc20Child']);const id=string(p.caseId,256);if(p.lc20Child!==undefined&&(id!=='LC20'||!LC20_CHILDREN.includes(p.lc20Child as never)))reject('INVALID_RESOURCE','Only the fixed nonformal LC20 children are supported');if(ids.has(id))reject('INVALID_RESOURCE','Probe cases must be unique');ids.add(id);directory(p.root);}}break;
    case 'document':fields(['file','format']);if(!['markdown','json'].includes(String(d.format)))reject('INVALID_RESOURCE','Unsupported target document format');verifyResourceFile(d.file);break;
    case 'baseline':fields(['branch','changeMode','requireClean','exactSource']);string(d.branch);fixed('changeMode','pull-request');yes('requireClean');yes('exactSource');break;
    case 'location':fields(['directory','purpose']);directory(d.directory);string(d.purpose);break;
    case 'compatibility':fields(['strategy','allowUnreviewedDrift']);fixed('strategy','exact-pins');fixed('allowUnreviewedDrift',false);break;
    case 'review':fields(['reviewerIds','evidenceRequired']);strings(d.reviewerIds,128).forEach(slug);yes('evidenceRequired');break;
    case 'recovery':fields(['strategy','onUnknown','maxAttempts']);fixed('strategy','inspect-original');fixed('onUnknown','BLOCK');if(!Number.isSafeInteger(d.maxAttempts)||Number(d.maxAttempts)<1||Number(d.maxAttempts)>4)reject('INVALID_RESOURCE','Recovery attempts must fit publisher limits');break;
    case 'agent':fields(['adapter','executable','version','hostId','workspaceRoot']);fixed('adapter','codex');{const file=record(d.executable);exact(file,['path','digest']);verifyCodexExecutable(string(file.path,4096),hash(file.digest));}string(d.version);string(d.hostId);directory(d.workspaceRoot);break;
    case 'workflow':fields(['platformRef','purpose','outputContract'],['qualificationProducer']);if(d.qualificationProducer!==undefined){const q=record(d.qualificationProducer);exact(q,['registrationRef','caseId','mode']);ref(q.registrationRef);if(q.caseId!=='LC20'||!['EXECUTE','INVENTORY'].includes(String(q.mode)))reject('INVALID_RESOURCE','Only the fixed LC20 producer workflow is supported');}ref(d.platformRef);if(!['build','verify','publish','smoke','prepare'].includes(String(d.purpose)))reject('INVALID_RESOURCE','Unknown workflow purpose');fixed('outputContract','runtime-ci/v1');break;
    case 'toolchain':fields(['executables']);for(const raw of list(d.executables,32)){const e=record(raw);exact(e,['file','version']);verifyResourceFile(e.file,true);string(e.version);}break;
    case 'artifact-store':fields(['platformRef','retentionDays']);ref(d.platformRef);if(!Number.isSafeInteger(d.retentionDays)||Number(d.retentionDays)<1||Number(d.retentionDays)>365)reject('INVALID_RESOURCE','Invalid artifact retention');break;
    case 'manifest':fields(['action']);fixed('action','runtime.candidate.manifest/v1');break;
    case 'environment':fields(['platformRef','scope','maxConcurrency']);ref(d.platformRef);fixed('scope','dedicated-test');if(!Number.isSafeInteger(d.maxConcurrency)||Number(d.maxConcurrency)<1||Number(d.maxConcurrency)>4)reject('INVALID_RESOURCE','Invalid verification concurrency');break;
    case 'failure':fields(['onFailure','onUnknown'],['repairComparison']);fixed('onFailure','BLOCK');fixed('onUnknown','BLOCK');
      if(d.repairComparison!==undefined){const p=record(d.repairComparison);exact(p,['schema','adapterRef','scope','reference','criteria']);if(p.schema!=='runtime-repair-comparison-policy/v1')reject('INVALID_RESOURCE','Unknown fixed repair comparison contract');ref(p.adapterRef);validateNativeReference(p.reference,{product:'harness'});const scope=record(p.scope);exact(scope,['visibility','projectId']);if(scope.projectId!==resource.projectId||!['public','private'].includes(String(scope.visibility))||scope.visibility!==record(p.reference).visibility)reject('INVALID_RESOURCE','Repair comparison must retain its registered project asset scope');const criteria=record(p.criteria);exact(criteria,['comparable','regression','progress'],['transient']);const ids=Object.values(criteria).map(x=>string(x,256));if(new Set(ids).size!==ids.length)reject('INVALID_RESOURCE','Comparison, regression, progress and optional transient require distinct fixed actual criteria');}
      break;
    case 'authority-policy':fields(['principalIds','exactSubjectRequired']);strings(d.principalIds,128).forEach(slug);yes('exactSubjectRequired');break;
    case 'decision-source':fields(['backend','decisionTypes']);fixed('backend','runtime');if(canonical([...strings(d.decisionTypes)].sort())!==canonical(['execution','release']))reject('INVALID_RESOURCE','Execution and release decisions must remain separate');break;
    case 'evidence-policy':fields(['requireAll','requireCurrent','allowSkipped','documentation']);yes('requireAll');yes('requireCurrent');fixed('allowSkipped',false);releaseDocuments(d.documentation);break;
    case 'channel':fields(['platformRef','channel','publication']);ref(d.platformRef);if(!['github-release','gitlab-release'].includes(String(d.channel)))reject('INVALID_RESOURCE','Unsupported publication channel');publicationTarget(d.publication,d.channel==='github-release'?'github':'gitlab');break;
    case 'readback':fields(['verifyDownloadedDigests','requireExactCandidate']);yes('verifyDownloadedDigests');yes('requireExactCandidate');break;
    case 'followup':fields(['onGap','autoExecute']);fixed('onGap','create-target');fixed('autoExecute',false);break;
    case 'delivery':fields(['mode'],['platformRef','directory','manifestArtifact']);if(d.mode==='distribution'){ref(d.platformRef);if(d.directory!==undefined||d.manifestArtifact!==undefined)reject('INVALID_RESOURCE','Distribution uses the registered channel');}else if(['local-install','approved-deployment'].includes(String(d.mode))){directory(d.directory);if(d.platformRef!==undefined||! /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(string(d.manifestArtifact,128)))reject('INVALID_RESOURCE','Installation needs a registered destination and exact candidate manifest artifact');}else reject('INVALID_RESOURCE','Unsupported delivery mode');break;
    case 'standard':fields(['owner','standardDigest','standardLockDigest','contractDigest','readinessStandardDigest']);if(!['ontology','harness'].includes(String(d.owner)))reject('INVALID_RESOURCE','Unknown standard owner');for(const key of ['standardDigest','standardLockDigest','contractDigest','readinessStandardDigest'])hash(d[key]);break;
    case 'asset-map':fields(['owner','reference','assessmentId','evidenceOrigin'],['ontologyCompatibility']);if(!['ontology','harness'].includes(String(d.owner)))reject('INVALID_RESOURCE','Unknown asset owner');validateNativeReference(d.reference,{product:d.owner as Owner});if(d.owner==='ontology')string(d.assessmentId);else if(d.assessmentId!==null)reject('INVALID_RESOURCE','Content grade belongs to the Ontology assessment, not a second Harness grade');if(!['ACTUAL','SYNTHETIC'].includes(String(d.evidenceOrigin)))reject('INVALID_RESOURCE','Explicit evidence origin is required');if(d.ontologyCompatibility!==undefined){const c=record(d.ontologyCompatibility);exact(c,['path','digest']);relativePath(c.path);hash(c.digest);}break;
    case 'check':fields(['owner','criterionId','variantIds']);if(!['ontology','harness'].includes(String(d.owner)))reject('INVALID_RESOURCE','Checks must map to a published owner rule');string(d.criterionId);strings(d.variantIds);break;
    case 'requirements-map':fields(['ontology','harness','rows']);validateNativeReference(d.ontology,{product:'ontology'});validateNativeReference(d.harness,{product:'harness'});for(const raw of list(d.rows)){const row=record(raw);exact(row,['id','semanticId','ruleId','variantIds']);string(row.id);string(row.semanticId,1024);string(row.ruleId);strings(row.variantIds);}break;
    case 'evidence-map':fields(['ontology','harness','rows']);validateNativeReference(d.ontology,{product:'ontology'});validateNativeReference(d.harness,{product:'harness'});for(const raw of list(d.rows,1024)){const row=record(raw);exact(row,['stage','checkId','owner','criterionId','variantIds','source']);string(row.stage);string(row.checkId);string(row.criterionId);strings(row.variantIds);if(!['ontology','harness'].includes(String(row.owner))||!['ci-artifact','owner-receipt','decision','delivery-readback'].includes(String(row.source)))reject('INVALID_RESOURCE','Invalid owner evidence mapping');}break;
  }
}

function packageFile(pkg:NativePackage,path:unknown):Record<string,unknown>{const p=relativePath(path),text=pkg.files[p];if(typeof text!=='string')reject('ASSET_MAPPING_MISSING','Published asset lacks its declared inventory');try{return record(JSON.parse(text));}catch{return reject('ASSET_MAPPING_INVALID','Published asset inventory is not valid JSON');}}
function inventory(asset:Asset,owner:Owner):{criteria:Set<string>;variants:Set<string>;semantic:Set<string>;pairs:Set<string>}{
  const entry=asset.package.manifest.entrypoints as Record<string,unknown>,coverage=packageFile(asset.package,entry.coverage);
  if(owner==='harness')return{criteria:new Set(strings(coverage.requiredRuleIds)),variants:new Set(strings(coverage.requiredCaseIds)),semantic:new Set(),pairs:new Set(list(coverage.requirements).flatMap(raw=>{const r=record(raw);return strings(r.ruleIds).flatMap(id=>strings(r.caseIds).map(v=>id+'\0'+v));}))};
  const bindings=packageFile(asset.package,asset.package.manifest.sourceBindingRef);
  const cases=packageFile(asset.package,entry.cases);
  return{criteria:new Set(list(bindings.requirements).map(r=>string(record(r).id))),variants:new Set(strings(coverage.requiredCaseIds)),semantic:new Set([...list(coverage.expectedEntities).map(r=>string(record(r).id,1024)),...strings(coverage.requiredShapeIds)]),pairs:new Set(list(cases.cases).flatMap(raw=>{const c=record(raw);return strings(c.requirementIds).map(id=>id+'\0'+string(c.id));}))};
}
export function createRegisteredBindings(configPath:string,workspaceId:string,connections:BindingConnections):DefinitionBindingProvider{
  return async(definition,actor,requirements,signal)=>{
    authorize(actor,definition.projectId,'read');const config=readIntegrationConfiguration(configPath,workspaceId),configDigest=valueDigest(config),now=Date.now(),projectId=definition.projectId;
    if(canonical(requirements)!==canonical(bindingRequirements(definition)))reject('BINDING_SET_CHANGED','Binding verification requires the complete exact definition');
    const cache=new Map<string,Promise<Fact>>(),assets=new Map<Owner,Promise<Asset>>(),platforms=new Map<string,Promise<PlatformReadiness>>();
    const fresh=()=>{signal.throwIfAborted();authorize(actor,projectId,'read');};
    const resource=(reference:unknown,role:string):ResourceRegistration=>{
      fresh();const r=config.resources.find(r=>r.ref===ref(reference)&&r.projectId===projectId);
      if(!r||r.role!==role||Date.parse(r.expiresAt)<=Date.now())reject('RESOURCE_NOT_CURRENT','Current scoped resource with the exact lifecycle role is required',409);
      validateResourceDefinition(r);return r;
    };
    const platform=async(reference:unknown):Promise<PlatformReadiness>=>{
      const key=ref(reference);let pending=platforms.get(key);if(!pending){const p=configuredPlatform(config,actor,projectId,key),c=config.credentials.find(c=>c.ref===p.credentialRef)!;
        if(Date.parse(c.expiresAt)<=Date.now())reject('CREDENTIAL_EXPIRED','Registered platform credential has expired',403);
        pending=connections.platform(p).readiness(actor,signal).then(observed=>{fresh();if(observed.bindingDigest!==valueDigest(p)||observed.projectId!==projectId||observed.provider!==p.provider||observed.repositoryId!==p.repositoryId||Date.parse(observed.expiresAt)<=Date.now())reject('PLATFORM_OBSERVATION_CHANGED','Platform observation is stale or mismatched');return observed;});platforms.set(key,pending);}
      return pending;
    };
    const owner=(reference:unknown,kind:Owner):PublishedOwnerAdapter=>{
      const configured=config.owners.find(o=>o.ref===ref(reference)&&o.owner===kind&&o.projects.includes(projectId));
      if(!configured)reject('OWNER_NOT_REGISTERED','Published owner connection is not registered for this project',409);
      const adapter=connections.owner(configured.ref,config);
      const {ref:unused,...registration}=configured;
      if(adapter.owner!==kind||adapter.workspaceId!==workspaceId||record(adapter.capabilities()).registrationDigest!==valueDigest(registration))reject('OWNER_SCOPE','Published owner connection does not match the current workspace/configuration');return adapter;
    };
    const asset=(kind:Owner):Promise<Asset>=>{
      let pending=assets.get(kind);if(pending)return pending;
      pending=(async()=>{
        const selected=record(atPath(definition.semantic,'assets.'+kind)),mapping=resource(selected.mappingRef,'assets.'+kind+'.mappingRef'),d=mapping.definition,reference=d.reference as NativeReference;
        if(d.owner!==kind||reference.id!==selected.id||reference.version!==selected.version||reference.digest!==selected.digest||reference.visibility!==selected.visibility)reject('ASSET_MAPPING_MISMATCH','Asset mapping differs from the exact selected asset');
        const scope={visibility:String(selected.visibility),projectId:String(selected.projectId)} as NativeScope,adapter=owner(selected.adapterRef,kind),readback=await adapter.readPackage(actor,projectId,scope,reference);
        const result:Asset={selected,scope,reference,package:readback.package as NativePackage,mapping};
        if(kind==='ontology'){
          const projection=await adapter.read(actor,projectId,{operation:'readiness.package.inspect',scope,input:{standardVersion:'v2',id:reference.id,version:reference.version}}) as ReadinessProjection;
          const h=owner(atPath(definition.semantic,'assets.harness.adapterRef'),'harness'),view=await h.read(actor,projectId,{operation:'readiness.assessment.read',scope,input:{standardVersion:'v2',id:d.assessmentId}});
          result.projection=projection;result.grade=verifyReadinessView(view,projection,selected.targetLevel as 'L1'|'L2'|'L3',d.evidenceOrigin as 'ACTUAL'|'SYNTHETIC');
        }else{
          const ontology=await asset('ontology');
          if(d.evidenceOrigin!==ontology.mapping.definition.evidenceOrigin||!['L1','L2','L3'].includes(String(selected.targetLevel))||['L1','L2','L3'].indexOf(String(ontology.grade!.level))<['L1','L2','L3'].indexOf(String(selected.targetLevel)))reject('ASSET_MAPPING_MISMATCH','Harness use must match the selected content readiness origin/level');
          if(!result.package.manifest.dependencies.some(r=>same(r,ontology.reference))){
            const proof=record(d.ontologyCompatibility),content=result.package.files[relativePath(proof.path)];
            if(typeof content!=='string'||byteDigest(content)!==proof.digest)reject('OWNER_DEPENDENCY_MISMATCH','Harness lacks the exact Ontology dependency or published compatibility declaration');
            const compatibility=record(JSON.parse(content));exact(compatibility,['schema','ontology','compatible']);if(compatibility.schema!=='runtime-ontology-compatibility/v1'||compatibility.compatible!==true||!same(compatibility.ontology,ontology.reference))reject('OWNER_DEPENDENCY_MISMATCH','Published compatibility declaration differs from selected Ontology');
          }
        }
        fresh();return result;
      })();assets.set(kind,pending);return pending;
    };
    async function checkOwnerCriterion(kind:unknown,criterion:unknown,variants:unknown):Promise<void>{
      if(!['ontology','harness'].includes(String(kind)))reject('ASSET_MAPPING_MISMATCH','Unknown mapped owner');const inv=inventory(await asset(kind as Owner),kind as Owner);
      if(!inv.criteria.has(string(criterion))||strings(variants).some(v=>!inv.variants.has(v)||!inv.pairs.has(String(criterion)+'\0'+v)))reject('ASSET_MAPPING_MISMATCH','Criterion/variant pair is absent from its published owner inventory');
    }
    async function inspectResource(reference:unknown,role:string):Promise<Fact>{
      const key=role+':'+String(reference);let pending=cache.get(key);if(pending)return pending;
      pending=(async()=>{
        const r=resource(reference,role),d=r.definition,observations:unknown[]=[];let expires=Date.parse(r.expiresAt);
        if(typeof d.platformRef==='string'){
          const p=await platform(d.platformRef),registration=configuredPlatform(config,actor,projectId,d.platformRef);
          const implementation=record(atPath(definition.semantic,'config.implementation'));
          if(registration.provider!==implementation.provider||registration.host!==implementation.host||registration.repositoryId!==implementation.repositoryId||registration.repository!==implementation.repository||registration.defaultBranch!==implementation.defaultBranch)reject('PLATFORM_SCOPE','Resource platform belongs to a different repository/source scope');
          if(d.kind==='channel'&&registration.credentialRef!==atPath(definition.semantic,'config.publication.credentialRef'))reject('CREDENTIAL_SCOPE','Publication channel and selected credential differ');
          observations.push(p.factsDigest);expires=Math.min(expires,Date.parse(p.expiresAt));
        }
        if(d.kind==='workflow'){
          const purposes:Record<string,string>={'config.candidate.buildWorkflowRef':'build','config.verification.verifyWorkflowRef':'verify','config.publication.publishWorkflowRef':'publish','config.closure.smokeWorkflowRef':'smoke','extension.workflow':'prepare'};
          if(d.purpose!==purposes[role])reject('RESOURCE_KIND_MISMATCH','Workflow purpose differs from its lifecycle stage');
        }
        if(d.kind==='baseline'&&d.branch!==atPath(definition.semantic,'config.implementation.defaultBranch'))reject('PLATFORM_SCOPE','Baseline branch differs from the selected repository');
        if(d.kind==='agent'){
          const identity=await (connections.agent??inspectExternalAgent)(d,signal);
          if(identity.adapter!=='codex'||identity.version!==d.version||identity.executableDigest!==record(d.executable).digest||identity.hostId!==d.hostId||identity.modelInvoked!==false)reject('AGENT_IDENTITY_CHANGED','External Agent observation differs from its registered identity');observations.push(identity);
        }
        if(d.kind==='delivery'&&d.mode!==atPath(definition.semantic,'config.closure.deliveryMode'))reject('RESOURCE_KIND_MISMATCH','Delivery mode differs from the project lifecycle');
        if(d.kind==='channel'&&d.channel!==atPath(definition.semantic,'config.publication.channel'))reject('RESOURCE_KIND_MISMATCH','Publication channel differs from the project lifecycle');
        if(d.kind==='artifact-store'&&d.retentionDays!==atPath(definition.semantic,'config.candidate.retentionDays'))reject('RESOURCE_KIND_MISMATCH','Artifact retention differs from the project lifecycle');
        if(d.kind==='environment'&&Number(d.maxConcurrency)<Number(atPath(definition.semantic,'config.verification.budget.maxConcurrency')))reject('RESOURCE_KIND_MISMATCH','Verification budget exceeds its environment concurrency');
        if(d.kind==='standard'){
          const a=await asset(d.owner as Owner);
          if(role!=='assets.'+d.owner+'.standardRef'||d.standardDigest!==a.reference.standardDigest||d.standardLockDigest!==a.reference.standardLockDigest||d.contractDigest!==a.reference.contractDigest||d.readinessStandardDigest!==READINESS_STANDARD_DIGEST)reject('OWNER_STANDARD_MISMATCH','Selected standard does not match its exact owner asset');
          observations.push(a.reference);
        }
        if(d.kind==='asset-map'){const a=await asset(d.owner as Owner);observations.push(a.reference,a.grade??(await asset('ontology')).grade);}
        if(d.kind==='check')await checkOwnerCriterion(d.owner,d.criterionId,d.variantIds);
        if(d.kind==='requirements-map'||d.kind==='evidence-map'){
          const o=await asset('ontology'),h=await asset('harness');if(!same(d.ontology,o.reference)||!same(d.harness,h.reference))reject('ASSET_MAPPING_MISMATCH','Mapping has different asset versions');
          const rows=list(d.rows,1024).map(record),keys=new Set<string>();
          for(const row of rows){
            const key=d.kind==='requirements-map'?String(row.id):String(row.stage)+'\0'+String(row.checkId);if(keys.has(key))reject('ASSET_MAPPING_MISMATCH','Duplicate mapping denominator');keys.add(key);
            if(d.kind==='requirements-map'){if(!inventory(o,'ontology').semantic.has(string(row.semanticId,1024)))reject('ASSET_MAPPING_MISMATCH','Semantic identifier is absent from published Ontology');await checkOwnerCriterion('harness',row.ruleId,row.variantIds);}
            else{const node=definition.nodes.find(n=>n.id===row.stage);if(!node||!node.checks.includes(String(row.checkId)))reject('ASSET_MAPPING_MISMATCH','Evidence mapping refers to an unknown stage/check');await checkOwnerCriterion(row.owner,row.criterionId,row.variantIds);}
          }
          if(d.kind==='requirements-map'){
            const required=inventory(h,'harness'),mappedRules=new Set(rows.map(r=>String(r.ruleId))),mappedVariants=new Set(rows.flatMap(r=>strings(r.variantIds))),mappedPairs=new Set(rows.flatMap(r=>strings(r.variantIds).map(v=>String(r.ruleId)+'\0'+v)));
            if([...required.criteria].some(id=>!mappedRules.has(id))||[...required.variants].some(id=>!mappedVariants.has(id))||[...required.pairs].some(pair=>!mappedPairs.has(pair)))reject('ASSET_MAPPING_INCOMPLETE','Requirements mapping cannot omit published mandatory criterion/variant pairs');
          }
          if(d.kind==='evidence-map'&&role==='config.verification.evidenceMappingRef')for(const node of definition.nodes)for(const check of node.checks)if(!keys.has(node.id+'\0'+check))reject('ASSET_MAPPING_INCOMPLETE','Every required stage/check needs its exact evidence mapping');
          observations.push(o.reference,h.reference,o.grade);
        }
        fresh();return{value:{registration:r,observations},expiresAt:new Date(expires).toISOString()};
      })();cache.set(key,pending);return pending;
    }
    async function inspect(path:string,value:unknown):Promise<Fact>{
      if(path==='assets.ontology'||path==='assets.harness'){const a=await asset(path.slice(7) as Owner);return{value:{reference:a.reference,grade:a.grade??(await asset('ontology')).grade},expiresAt:a.mapping.expiresAt};}
      if(path.endsWith('.adapterRef')){const kind=path.split('.')[1] as Owner,a=owner(value,kind);return{value:a.capabilities(),expiresAt:new Date(now+60000).toISOString()};}
      if(path.endsWith('.credentialRef')){
        const c=config.credentials.find(c=>c.ref===value&&c.projectId===projectId);if(!c||Date.parse(c.expiresAt)<=Date.now())reject('CREDENTIAL_EXPIRED','Current scoped credential registration is required');
        const p=config.platforms.filter(p=>p.projectId===projectId&&p.credentialRef===c.ref);if(!p.length)reject('PLATFORM_NOT_REGISTERED','Credential has no registered platform');
        const observations=await Promise.all(p.map(p=>platform(p.ref)));return{value:{credentialRevision:c.revision,credentialRef:c.ref,platforms:observations.map(p=>p.factsDigest)},expiresAt:new Date(Math.min(Date.parse(c.expiresAt),...observations.map(p=>Date.parse(p.expiresAt)))).toISOString()};
      }
      if(path==='config.implementation.connection'){
        const v=record(value),matches=config.platforms.filter(p=>p.projectId===projectId&&p.credentialRef===v.credentialRef&&p.provider===v.provider&&p.host===v.host&&p.repository===v.repository&&p.repositoryId===v.repositoryId&&p.defaultBranch===v.defaultBranch&&p.workflowPath===v.workflowPath&&p.pipelinePath===v.pipelinePath&&p.runner===v.runner);
        if(matches.length!==1)reject('PLATFORM_BINDING_MISMATCH','Connection must match one exact scoped platform registration');const p=await platform(matches[0].ref);return{value:p.factsDigest,expiresAt:p.expiresAt};
      }
      if(path.startsWith('extensions.')){
        const action=record(value),parameters=record(action.parameters),facts:Fact[]=[];
        for(const requirement of list(action.requirementRefs,64))facts.push(await inspectResource(requirement,'extension.requirement'));
        facts.push(await inspectResource(action.evidenceMappingRef,'extension.mapping'));
        for(const [key,v] of Object.entries(parameters))facts.push(await inspectResource(v,key==='checkRef'?'extension.check':key==='reviewRef'?'extension.review':'extension.workflow'));
        if(['runtime.check.ontology','runtime.check.harness','runtime.check.artifact','runtime.review.scope','runtime.operation.ci-prepare'].includes(String(action.actionRef))){
          const reviewing=action.actionRef==='runtime.review.scope',preparing=action.actionRef==='runtime.operation.ci-prepare',kind=action.actionRef==='runtime.check.ontology'?'ontology':'harness',node=definition.nodes.find(n=>path==='extensions.'+n.id)!;
          const check=reviewing||preparing?null:resource(parameters.checkRef,'extension.check'),required=list(action.requirementRefs,64).map(ref=>resource(ref,'extension.requirement'));
          if(check&&(check.definition.owner!==kind||required.some(r=>r.definition.owner!==kind)||!required.some(r=>same(r.definition,check.definition))))reject('EXTENSION_MAPPING','Extension checks must use their registered owner and required criterion');
          const local=resource(action.evidenceMappingRef,'extension.mapping').definition,global=resource(atPath(definition.semantic,'config.verification.evidenceMappingRef'),'config.verification.evidenceMappingRef').definition;
          const rows=(local.rows as Record<string,unknown>[]).filter(r=>r.stage===node.id),globalRows=(global.rows as Record<string,unknown>[]).filter(r=>r.stage===node.id),sorted=(rows:Record<string,unknown>[])=>[...rows].sort((a,b)=>String(a.checkId).localeCompare(String(b.checkId)));
          if(rows.length!==node.checks.length||!same(rows.map(r=>r.checkId).sort(),[...node.checks].sort())||!same(sorted(rows),sorted(globalRows)))reject('EXTENSION_MAPPING','Local and global extension mappings must cover the same required checks');
          for(const r of required){const row=rows.find(row=>row.checkId===r.ref)!;if(row.source!==(reviewing?'decision':preparing?'ci-artifact':'owner-receipt')||row.owner!==r.definition.owner||row.criterionId!==r.definition.criterionId||!same([...(row.variantIds as string[])].sort(),[...(r.definition.variantIds as string[])].sort()))reject('EXTENSION_MAPPING','Each extension criterion must map to its exact fixed action evidence source');}
        }
        return{value:facts.map(f=>f.value),expiresAt:new Date(Math.min(...facts.map(f=>Date.parse(f.expiresAt)))).toISOString()};
      }
      if(Array.isArray(value)){const facts=await Promise.all(value.map(v=>inspectResource(v,path)));return{value:facts.map(f=>f.value),expiresAt:new Date(Math.min(...facts.map(f=>Date.parse(f.expiresAt)))).toISOString()};}
      return inspectResource(value,path);
    }
    const checks:BindingCheck[]=await Promise.all(requirements.map(async requirement=>{
      try{const fact=await inspect(requirement.path,requirement.value);return{path:requirement.path,inputDigest:requirement.inputDigest,status:'VALID' as const,revision:String(config.revision),factsDigest:valueDigest({configDigest,facts:fact.value}),evidenceRef:'runtime-binding:'+projectId+'/'+encodeURIComponent(requirement.path),expiresAt:new Date(Math.min(Date.parse(fact.expiresAt),now+60000)).toISOString()};}
      catch(error){const code=error instanceof ServiceError?error.code:'BINDING_UNAVAILABLE';return{path:requirement.path,inputDigest:requirement.inputDigest,status:'INVALID' as const,revision:String(config.revision),factsDigest:valueDigest({code}),evidenceRef:'runtime-binding:'+projectId+'/'+encodeURIComponent(requirement.path),expiresAt:new Date(now+60000).toISOString()};}
    }));
    fresh();if(valueDigest(readIntegrationConfiguration(configPath,workspaceId))!==configDigest)reject('INTEGRATION_CHANGED','Integration configuration changed during verification',409);
    return checks;
  };
}

/** Fixed local composition of published owner consumers, the existing Runtime
 * readiness API and registered HTTPS providers. No caller-selected imports,
 * owner authoring, raw database access or default external execution. */
export async function openRegisteredBindings(configPath:string,workspaceId:string,managedIntentSource?:()=>LegacyIntentSource):Promise<{provider:DefinitionBindingProvider;preparation:PreparationValidator;implementationReview:ImplementationReviewBindings;extensionReview:(store:RuntimeStore)=>ExtensionReviewBindings;qualification:(store:RuntimeStore,principals:PrincipalLookup)=>RegisteredQualificationService;executor(store:RuntimeStore,services:StageServices):StageAdapter;close():void}>{
  slug(workspaceId);string(configPath,4096);
  let legacy:ReturnType<typeof createRuntimeService>|undefined,opening:Promise<void>|null=null,connectedDigest:string|null=null,closed=false;
  let serviceStore:RuntimeStore|undefined;
  const feedback:Parameters<typeof openPublishedOwner>[4]=async(actor,projectId,request)=>{
    if(!serviceStore||closed||request.workspaceId!==workspaceId)reject('FEEDBACK_RUN_UNAVAILABLE','Registered Runtime terminal Run reader is unavailable',409);
    return readVerificationFeedback(serviceStore,actor,projectId,request.id);
  };
  const adapters=new Map<string,PublishedOwnerAdapter>();
  const disconnect=()=>{for(const a of [...adapters.values()].reverse())a.close();adapters.clear();legacy?.close();legacy=undefined;connectedDigest=null;};
  const connectionDigest=(configuration:Readonly<IntegrationConfiguration>)=>valueDigest({owners:configuration.owners,nativeToolchain:configuration.nativeToolchain??null});
  async function connect(configuration:Readonly<IntegrationConfiguration>):Promise<void>{
    try{
      const toolchain=readRegisteredNativeToolchain(configuration);
      if(!configuration.owners.length)reject('OWNER_NOT_REGISTERED','Register published Ontology and Harness connections before enabling a lifecycle');
      const roots=new Set(configuration.owners.map(o=>o.workspaceRoot));if(roots.size!==1)reject('OWNER_SCOPE','Current published owner composition requires one shared workspace identity/root');
      const workspaceRoot=[...roots][0];directory(workspaceRoot);
      const marker=workspaceRoot+'/state/runtime/runtime.db';if(realpathSync(marker)!==marker||!lstatSync(marker).isFile())reject('RUNTIME_INTENT_STORE_MISSING','Initialize modeling intent through the existing Runtime owner workflow first');
      const source=managedIntentSource?.();
      if(managedIntentSource&&!source)reject('RUNTIME_INTENT_STORE_MISSING','The selected managed Runtime intent source is unavailable',409);
      if(source){if(source.workspaceRoot!==workspaceRoot||source.workspaceId!==workspaceId)reject('RUNTIME_INTENT_SCOPE','Published owner bindings must use the same managed Runtime workspace',409);}
      else{legacy=createRuntimeService({workspaceRoot,workspaceId});legacy.initialize();}
      for(const registered of configuration.owners.filter(o=>o.owner==='ontology')){
        const{ref,...config}=registered;adapters.set(ref,await openPublishedOwner(config,toolchain,undefined,undefined,feedback));if(closed)reject('CLOSED','Integration composition is closed',503);
      }
      for(const registered of configuration.owners.filter(o=>o.owner==='harness')){
        const possible=configuration.owners.filter(o=>o.owner==='ontology'&&registered.projects.every(p=>o.projects.includes(p)));
        if(possible.length!==1)reject('OWNER_BINDING_AMBIGUOUS','Harness needs one exact scoped Ontology connection');
        const{ref,...config}=registered;
        adapters.set(ref,await openPublishedOwner(config,toolchain,adapters.get(possible[0].ref),async(actor,projectId,request)=>{
          authorize(actor,projectId,'read');if(source)return source.read(actor,projectId,request);
          if(!legacy)reject('OWNER_UNAVAILABLE','Runtime intent reader is unavailable');
          return await legacy.readiness({operation:'readiness.intent.read',scope:request.scope,input:{standardVersion:'v2',digest:request.digest}}) as ReadinessIntentRecord&{current:boolean};
        },feedback));if(closed)reject('CLOSED','Integration composition is closed',503);
      }
      connectedDigest=connectionDigest(configuration);
    }catch(error){disconnect();throw error;}
  }
  const connections:BindingConnections={
    owner(ref){if(closed)reject('CLOSED','Integration composition is closed',503);const adapter=adapters.get(ref);if(!adapter)reject('OWNER_NOT_REGISTERED','Restart with the reviewed changed owner configuration');return adapter;},
    platform(binding){const credentials=async(p:PlatformRegistration,actor:Principal)=>readPlatformToken(configPath,p,actor);return binding.provider==='github'?githubClient(binding,credentials):gitlabClient(binding,credentials);},
  };
  async function ensure(signal:AbortSignal):Promise<Readonly<IntegrationConfiguration>>{
    if(closed)reject('CLOSED','Integration composition is closed',503);signal.throwIfAborted();
    const config=readIntegrationConfiguration(configPath,workspaceId),expected=connectionDigest(config);
    if(connectedDigest&&connectedDigest!==expected)reject('OWNER_CONNECTION_CHANGED','Restart after reviewing a changed owner connection; original history remains readable',409);
    readRegisteredNativeToolchain(config);
    if(!connectedDigest){opening??=connect(config).finally(()=>{opening=null;});await opening;}
    signal.throwIfAborted();if(closed)reject('CLOSED','Integration composition is closed',503);
    if(connectedDigest!==expected||connectionDigest(readIntegrationConfiguration(configPath,workspaceId))!==expected)reject('OWNER_CONNECTION_CHANGED','Owner configuration changed while connecting',409);
    return config;
  }
  const registered=createRegisteredBindings(configPath,workspaceId,connections);
  const provider:DefinitionBindingProvider=async(definition,actor,requirements,signal)=>{
    await ensure(signal);return registered(definition,actor,requirements,signal);
  };
  const extensionReview=(store:RuntimeStore):ExtensionReviewBindings=>{
    let stages:ReturnType<typeof createImplementationStageAdapters>|undefined;
    const review=registeredExtensionReview(store,configPath,{...connections,async source(instance,stage,actor,signal){const config=await ensure(signal),toolchain=readRegisteredNativeToolchain(config);stages??=createImplementationStageAdapters(store,configPath,{...connections,toolchainLockDigest:toolchain.lockDigest,toolchainManifestDigest:config.nativeToolchain!.digest});return stages.source(instance,actor,stage);}});
    return{...review,async facts(instance,id,actor,signal){await ensure(signal);return review.facts(instance,id,actor,signal);}};
  };
  // Owner outages block dependent admission, never service/history availability.
  return{provider,extensionReview,qualification(store,principals){if(store.workspaceId!==workspaceId||serviceStore&&serviceStore!==store)reject('INTEGRATION_SCOPE','Qualification must use the same registered service store',403);serviceStore=store;return createRegisteredQualificationService(store,configPath,connections,ensure,principals);},preparation:registeredPreparation(configPath,workspaceId),implementationReview:registeredImplementationReview(configPath,workspaceId,connections),executor(store,services){
    if(store.workspaceId!==workspaceId)reject('INTEGRATION_SCOPE','Stage executor must share the service workspace',403);
    if(serviceStore&&serviceStore!==store)reject('INTEGRATION_SCOPE','Owner feedback cannot switch to another service store',403);serviceStore=store;
    let stages:ReturnType<typeof createImplementationStageAdapters>|undefined,scope:StageAdapter|undefined,plan:StageAdapter|undefined,release:StageAdapter|undefined,publication:StageAdapter|undefined,closure:StageAdapter|undefined,nativeExtension:StageAdapter|undefined;
    async function current(signal:AbortSignal,stageId:string,instance:LifecycleInstance):Promise<StageAdapter>{
      const config=await ensure(signal),toolchain=readRegisteredNativeToolchain(config);
      if(stageId==='scope'){scope??=createScopeStageAdapter(store,configPath,connections);return scope;}
      if(stageId==='plan'){plan??=createPlanStageAdapter(store,configPath,{...connections,toolchainLockDigest:toolchain.lockDigest,toolchainManifestDigest:config.nativeToolchain!.digest});return plan;}
      stages??=createImplementationStageAdapters(store,configPath,{...connections,toolchainLockDigest:toolchain.lockDigest,toolchainManifestDigest:config.nativeToolchain!.digest});
      if(instance.definition.nodes.find(n=>n.id===stageId)?.action?.actionRef==='runtime.review.scope'){if(!services.extensionReviews)reject('EXTENSION_REVIEW_UNAVAILABLE','Same service review workflow is required',409);return services.extensionReviews.adapter;}
      if(instance.definition.nodes.find(n=>n.id===stageId)?.action?.actionRef==='runtime.operation.ci-prepare')return stages.ci;
      if(stageId.startsWith('project.')){nativeExtension??=createNativeExtensionStageAdapter(store,configPath,{...connections,toolchainLockDigest:toolchain.lockDigest,toolchainManifestDigest:config.nativeToolchain!.digest,source:async(instance,stage,actor,signal)=>{signal.throwIfAborted();return stages!.source(instance,actor,stage);}});return nativeExtension;}
      if(stageId==='release-decision'){
        if(!services.authorityPolicy)reject('AUTHORITY_POLICY_UNAVAILABLE','Release admission requires the service authority policy',409);
        release??=createReleaseStageAdapter(store,configPath,{platform:connections.platform,verification:stages.ci},services.releaseAuthority,services.authorityPolicy);return release;
      }
      if(stageId==='publication'){publication??=createPublicationStageAdapter(store,configPath,{...connections,toolchainLockDigest:toolchain.lockDigest,toolchainManifestDigest:config.nativeToolchain!.digest},services.releaseAuthority);return publication;}
      if(stageId==='closure'){closure??=createClosureStageAdapter(store,configPath,{...connections,toolchainLockDigest:toolchain.lockDigest,toolchainManifestDigest:config.nativeToolchain!.digest});return closure;}
      return stageId==='implementation'?stages.implementation:stages.ci;
    }
    return{
      async prepare(instance,stage,actor,signal){return(await current(signal,stage,instance)).prepare(instance,stage,actor,signal);},
      async dispatch(request,instance,permit,signal){return(await current(signal,request.stageId,instance)).dispatch(request,instance,permit,signal);},
      async inspect(request,instance,progress,actor,signal){return(await current(signal,request.stageId,instance)).inspect(request,instance,progress,actor,signal);},
      async reconcileAdvance(request,instance,progress,actor,signal){
        const adapter=await current(signal,request.stageId,instance);
        if(!adapter.reconcileAdvance)reject('RECONCILE_ORIGINAL_REQUEST','Selected native adapter has no read-only original-receipt recovery',409);
        return adapter.reconcileAdvance(request,instance,progress,actor,signal);
      },
      async verifyRepair(subject,actor,signal){
        signal.throwIfAborted();authorize(actor,subject.projectId,'execution.request');
        if(subject.workspaceId!==workspaceId)reject('INTEGRATION_SCOPE','Repair must belong to the registered service workspace',403);
        const saved=store.object(subject.projectId,'lifecycle-instance',subject.instanceId);
        if(!saved)return null;
        const instance=inspectInstance(saved as LifecycleInstance);
        if(instance.id!==subject.instanceId||instance.pins.projectId!==subject.projectId||instance.pinsDigest!==subject.pinsDigest||instance.pins.authorityDigest!==subject.authorityDigest||instance.candidateDigest!==subject.candidateDigest||!instance.stages[subject.stageId])reject('REPAIR_SCOPE_CHANGED','Repair must retain the exact current instance, stage and candidate',409);
        const adapter=await current(signal,subject.stageId,instance);
        signal.throwIfAborted();
        return adapter.verifyRepair?adapter.verifyRepair(subject,actor,signal):null;
      },
      async advance(request,instance,progress,permit,signal){return(await current(signal,request.stageId,instance)).advance!(request,instance,progress,permit,signal);},
    };
  },close(){if(!closed){closed=true;disconnect();}}};
}

export interface RegisteredQualificationService {
  native:NativeQualificationService;
  read(actor:Principal,projectId:string,operation:string,input:Record<string,unknown>):Promise<unknown>;
  write(actor:Principal,projectId:string,operation:string,input:Record<string,unknown>,requestId:string,expectedRevision:number,reauthorize:()=>Principal):Promise<Receipt>;
}
/** Trusted server composition. Its callbacks and producer implementation are
 * code, not registration data or API-imported facts. */
export function createRegisteredQualificationService(store:RuntimeStore,configPath:string,connections:Pick<BindingConnections,'owner'>,ensure:(signal:AbortSignal)=>Promise<Readonly<IntegrationConfiguration>>,principals:PrincipalLookup):RegisteredQualificationService {
  const kind='lifecycle-evidence-qualification',workspaceId=store.workspaceId;
  type Case={caseId:string;phase:'PRE_RELEASE'|'POST_RELEASE';executionRequirement:ProtectedQualificationFacts['policy']['requirement']['executionRequirement']};
  type Policy={registration:ResourceRegistration;stamp:string;base:Omit<ProtectedQualificationFacts['policy'],'requirement'>;cases:Map<string,Case>;producers:Map<string,PublishedExecutionProducer>;completeProducer:Lc20ProducerContract|null};
  type PlanRecord={plan:QualificationAssessmentPlan;registrationRef:string;facts:Omit<ProtectedQualificationFacts,'assessmentAuthority'>;sources?:{originalOriginRef:string;currentInputRef:string}};
  type ExecutionRecord={schema:'runtime-current-execution-source/v3';registrationRef:string;originRef:string;producer:PublishedExecutionProducer;originStateDigest:string;policyStamp:string;rawReceipt:string;capture:TypedCurrentExecutionCapture};
  const policies=new Map<string,Policy>(),verifiedExecutionSources=new Map<string,string>();
  type Invocation={closed:boolean;failed:boolean;finalizers:{check:()=>void;dispose:()=>void}[];policies:Map<string,{policy:Policy;observer:{id:string;revision:number}}>};
  const invocations=new AsyncLocalStorage<Invocation>();
  function openObservationScope(signal:AbortSignal){
    const inherited=invocations.getStore(),lc20=openLc20ObservationScope(signal),ci=openProtectedCiObservationScope(signal),invocation:Invocation=inherited??{closed:false,failed:false,finalizers:[],policies:new Map()};
    return{run<T>(read:()=>T):T{signal.throwIfAborted();if(invocation.closed)reject('QUALIFICATION_OBSERVATION_EXPIRED','Original qualification observation closed',409);return invocations.run(invocation,()=>ci.run(()=>lc20.run(read)));},
      onFinalCheck(check:()=>void,dispose:()=>void){if(invocation.closed)reject('QUALIFICATION_OBSERVATION_EXPIRED','Observation already closed',409);invocation.finalizers.push({check,dispose});},
      close(){try{ci.close();}catch(error){invocation.failed=true;throw error;}finally{try{lc20.close();}finally{if(!inherited){invocation.closed=true;invocation.policies.clear();}}}},
      async drain(){try{await lc20.drain();}catch(error){invocation.failed=true;throw error;}},
      finish(){if(inherited)return;try{if(!invocation.closed||invocation.failed)return;for(const final of invocation.finalizers)final.check();}finally{for(const final of invocation.finalizers)final.dispose();invocation.finalizers=[];}},cacheDependent:()=>lc20.cacheDependent()};
  }
  async function executionPolicy(projectId:string,refValue:string,actor:Principal,signal:AbortSignal){
    signal.throwIfAborted();const entry=invocations.getStore()?.policies.get(projectId+'\0'+refValue);
    if(!entry)return policy(projectId,refValue,actor,signal);
    const current=authority.currentActor(actor,projectId,'read');if(entry.observer.id!==current.id||entry.observer.revision!==current.revision||entry.policy.stamp!==policyCurrent(projectId,refValue).stamp)reject('QUALIFICATION_POLICY_CHANGED','Current original policy observer required',409);return entry.policy;
  }

  const same=(a:unknown,b:unknown)=>valueDigest(a)===valueDigest(b);
  function registration(projectId:string,refValue:string){
    const c=readIntegrationConfiguration(configPath,workspaceId),r=c.resources.find(r=>r.ref===refValue&&r.projectId===projectId&&r.role==='runtime.qualification');
    if(!r||Date.parse(r.expiresAt)<=Date.now())reject('QUALIFICATION_POLICY_UNAVAILABLE','Current registered qualification policy required',409);validateResourceDefinition(r);
    const owner=c.owners.find(o=>o.ref===r.definition.adapterRef&&o.owner==='harness'&&o.projects.includes(projectId));if(!owner)reject('QUALIFICATION_OWNER_CHANGED','Exact registered Harness owner required',409);
    const {ref:unused,...ownerConfig}=owner,adapter=connections.owner(owner.ref,c),registrationDigest=valueDigest(ownerConfig),toolchain=readRegisteredNativeToolchain(c);
    if(record(adapter.capabilities()).registrationDigest!==registrationDigest)reject('QUALIFICATION_OWNER_CHANGED','Owner registration changed; restart after review',409);
    return{resource:r,owner,adapter,registrationDigest,toolchain,stamp:valueDigest({resource:r,owner,toolchain:c.nativeToolchain})};
  }
  function policyCurrent(projectId:string,refValue:string){const r=registration(projectId,refValue),p=policies.get(refValue);if(!p||p.registration.projectId!==projectId||p.stamp!==r.stamp)reject('QUALIFICATION_POLICY_CHANGED','Reinspect the current published policy before use',409);return p;}
  async function policy(projectId:string,refValue:string,actor:Principal,signal:AbortSignal){
    authorize(actor,projectId,'read');await ensure(signal);const r=registration(projectId,refValue),d=r.resource.definition,scope=d.scope as NativeScope,reference=d.reference as NativeReference;
    const pkg=record(await r.adapter.readPackage(actor,projectId,scope,reference)),publication=record(await r.adapter.read(actor,projectId,{operation:'native.receipt.inspect',scope,input:{requestId:d.publicationRequestId}}));
    if(publication.status!=='SUCCEEDED'||publication.operation!=='native.package.publish'||publication.requestId!==d.publicationRequestId||!same(publication.scope,scope)||record(publication.result).published!==true||!same(record(publication.result).reference,reference))reject('QUALIFICATION_POLICY_UNPUBLISHED','Actual exact native publication receipt required',409);
    const packageValue=record(pkg.package),files=record(packageValue.files),fileText=(path:string,maximum:number)=>{const value=files[path];if(typeof value!=='string'||Buffer.byteLength(value)>maximum)reject('QUALIFICATION_POLICY_CATALOG','Bounded published policy file required',409);return value;},profileText=fileText('sources/runtime-profile.json',2097152),profile=record(JSON.parse(profileText)),params=record(record(JSON.parse(fileText('data/qualification.json',262144))).params),catalog=record(params.catalogBindings),profileScope=record(profile.scope);
    const catalogScope={product:profileScope.product,targetId:profileScope.targetId,targetVersion:profileScope.targetVersion,catalogBindings:profileScope.catalogBindings};
    const profileDigest=byteDigest(profileText);if(params.profileDigest!==profileDigest||profileScope.product!=='runtime'||profileScope.targetId!=='runtime-v090-independent-lifecycle'||profileScope.targetVersion!=='0.9.0'||profileScope.catalogScopeDigest!==params.catalogScopeDigest||!Array.isArray(profileScope.catalogBindings)||!same(Object.fromEntries(profileScope.catalogBindings.map(raw=>{const v=record(raw);return[string(v.path),hash(v.sha256)];})),catalog)||valueDigest(catalogScope)!==params.catalogScopeDigest)reject('QUALIFICATION_POLICY_CATALOG','Published profile and exact catalog pins differ',409);
    const cases=new Map<string,Case>();for(const raw of list(profile.cases,709)){const c=record(raw),id=string(c.caseId,256);if(cases.has(id)||!['PRE_RELEASE','POST_RELEASE'].includes(String(c.phase))||!['ALWAYS_MUST_EXECUTE','AFFECTED_OR_UNKNOWN_MUST_EXECUTE'].includes(String(c.executionRequirement)))reject('QUALIFICATION_POLICY_CATALOG','Unique fixed phase-correct cases required',409);cases.set(id,{caseId:id,phase:c.phase as Case['phase'],executionRequirement:c.executionRequirement as Case['executionRequirement']});}
    const always=[...cases.values()].filter(c=>c.executionRequirement==='ALWAYS_MUST_EXECUTE').map(c=>c.caseId).sort(),conditional=[...cases.values()].filter(c=>c.executionRequirement==='AFFECTED_OR_UNKNOWN_MUST_EXECUTE').map(c=>c.caseId).sort();
    if(cases.size!==709||always.length!==681||conditional.length!==28||[...cases.values()].filter(c=>c.phase==='PRE_RELEASE').length!==698||!same([...strings(params.mustExecuteCaseIds,709)].sort(),always)||!same([...strings(params.conditionalCaseIds,709)].sort(),conditional))reject('QUALIFICATION_POLICY_CATALOG','Exact accepted 709 / 681 always / 28 conditional inventory required',409);
    const producers=new Map<string,PublishedExecutionProducer>(),rawProducers=files['sources/execution-producers.json'];
    if(rawProducers!==undefined){const v=record(JSON.parse(fileText('sources/execution-producers.json',262144)));exact(v,['schema','cases']);if(v.schema!=='runtime-execution-producers/v1')reject('QUALIFICATION_PRODUCER_CONTRACT','Unsupported fixed producer contract');for(const item of list(v.cases,709)){const p=record(item);exact(p,['caseId','phase','collectorPath','collectorDigest','workflowDigest','catalogDigest','maxAgeSeconds']);const id=string(p.caseId,256),c=cases.get(id);if(!c||c.phase!==p.phase||producers.has(id)||p.catalogDigest!==params.catalogScopeDigest||!Number.isSafeInteger(p.maxAgeSeconds)||Number(p.maxAgeSeconds)<1||Number(p.maxAgeSeconds)>86400)reject('QUALIFICATION_PRODUCER_CONTRACT','Exact published producer/case validity required');relativePath(p.collectorPath);hash(p.collectorDigest);hash(p.workflowDigest);producers.set(id,p as unknown as PublishedExecutionProducer);}}
    let completeProducer:Lc20ProducerContract|null=null;const rawComplete=files['sources/qualification-producers.json'];if(rawComplete!==undefined){const c=record(JSON.parse(fileText('sources/qualification-producers.json',262144)));exact(c,['schema','cases']);if(c.schema!=='runtime-qualification-producers/v1'||!Array.isArray(c.cases)||c.cases.length!==1)reject('LC20_PRODUCER_CONTRACT','Only the complete fixed LC20 producer is supported');completeProducer=readLc20ProducerContract(c.cases[0]);const row=(profile.cases as unknown[]).map(record).find(c=>c.caseId==='LC20');if(completeProducer.catalogDigest!==params.catalogScopeDigest||row?.executionRequirement!=='AFFECTED_OR_UNKNOWN_MUST_EXECUTE'||!same(row.vectors,completeProducer.vectors))reject('LC20_PRODUCER_CONTRACT','Complete LC20 must match the fixed published catalog');}
    const validation=record(pkg.validation);if(validation.executionStatus!=='SUCCEEDED'||validation.qualityStatus!=='PASS'||!same(validation.reference,reference))reject('QUALIFICATION_POLICY_UNPUBLISHED','Published native package validation required',409);
    signal.throwIfAborted();if(registration(projectId,refValue).stamp!==r.stamp)reject('QUALIFICATION_POLICY_CHANGED','Policy changed during owner readback',409);
    const result:Policy={registration:r.resource,stamp:r.stamp,cases,producers,completeProducer,base:{owner:{ref:r.owner.ref,registrationDigest:r.registrationDigest,scope,reference,criteria:nativeInventory(packageValue,'harness')},publishedReceiptRef:'native.receipt:'+string(d.publicationRequestId,512),effectiveConfigDigest:hash(validation.effectiveConfigDigest),toolchainLockDigest:r.toolchain.lockDigest,profileDigest,catalogScopeDigest:hash(params.catalogScopeDigest),caseInventoryDigest:nativeSha256(Object.fromEntries([...cases].map(([id,c])=>[id,{phase:c.phase,executionRequirement:c.executionRequirement}]))),validityContractDigest:hash(params.validityContractDigest),trust:{revision:String(r.resource.revision),protectedRecordRef:r.resource.ref,recordDigest:r.stamp,expiresAt:r.resource.expiresAt}}};policies.set(refValue,result);return result;
  }
  function casePolicy(p:Policy,caseId:string):ProtectedQualificationFacts['policy']{const c=p.cases.get(caseId);if(!c)reject('QUALIFICATION_POLICY_CATALOG','Case is outside the published fixed inventory',409);return{...p.base,requirement:{phase:c.phase,executionRequirement:c.executionRequirement,impact:'UNCHANGED',serialGroupStatus:'PROTECTED_COMPLETE_UNCHANGED_GROUP',inventoryRef:p.registration.ref+'/published-profile',inventoryRevision:p.base.profileDigest}};}
  function probe(p:Policy,caseId:string){const config=(p.registration.definition.probes as {caseId:string;root:string;lc20Child?:typeof LC20_CHILDREN[number]}[]).find(c=>c.caseId===caseId);if(!config)reject('QUALIFICATION_EXECUTION_REQUIRED','This producer has no closed input protocol; actual execution is required',409);const selected=casePolicy(p,caseId);return createClosedFixtureQualificationProducer(store,{scope:{workspaceId,projectId:p.registration.projectId,acceptanceScopeDigest:p.base.catalogScopeDigest},caseId,fixtureRoot:config.root,...(config.lc20Child?{lc20Child:config.lc20Child}:{}),policy:async()=>selected,authority:async()=>{throw Error('Assessment authority is resolved independently');}});}
  type CompleteSources={original:ProtectedLc20Candidate;current:ProtectedLc20Candidate;history:ProtectedQualificationFacts['input']['history'];watermark:string};
  const completeSources=new Map<string,CompleteSources>();
  const sourceKey=(projectId:string,refs:NonNullable<PlanRecord['sources']>)=>valueDigest({projectId,refs});
  function originalExecution(scope:ProtectedQualificationFacts['input']['scope'],s:ProtectedLc20Candidate):OriginalEvidenceExecution {
    if(!s.execution||s.pin.mode!=='EXECUTE')reject('LC20_EXECUTION_REQUIRED','Only an original fully executed LC20 PASS can qualify',409);
    const expiresAt=new Date(Math.min(Date.parse(s.execution.completedAt)+s.pin.contract.maxAgeSeconds*1000,Date.parse(s.execution.expiresAt),Date.parse(s.expiresAt),Date.parse(s.pin.registrationExpiresAt))).toISOString();
    return{schema:'runtime-original-evidence-execution/v1',mode:'EXECUTED',scope,caseId:'LC20',runId:s.request.id,candidateDigest:s.distribution.manifestDigest,inputManifestDigest:valueDigest(withPolicy(s.inputs,s.pin.policyReferenceDigest,s.pin.validityContractDigest)),rawReceiptDigest:s.execution.rawReceiptDigest,outcome:'PASS',executedAt:s.execution.startedAt,expiresAt};
  }
  function withPolicy(inputs:EvidenceInputManifest,policyDigest:string,ttlDigest:string):EvidenceInputManifest {
    if(inputs.nodes.some(n=>['qualification:policy','qualification:ttl'].includes(n.id)))reject('LC20_PRODUCER_CONTRACT','Reserved qualification input id',409);
    return{...inputs,roots:[...inputs.roots,'qualification:policy','qualification:ttl'],nodes:[...inputs.nodes,{id:'qualification:policy',kind:'policy',digest:policyDigest,dependsOn:[]},{id:'qualification:ttl',kind:'ttl',digest:ttlDigest,dependsOn:[]}]};
  }
  async function refreshComplete(projectId:string,refs:NonNullable<PlanRecord['sources']>,p:Policy,actor:Principal,signal:AbortSignal){
    if(!p.completeProducer)reject('LC20_PRODUCER_CONTRACT','The current published full producer contract is absent',409);
    const before=lc20ManagedHistoryState(store,projectId,actor),all=new Map<string,ProtectedLc20Candidate>();
    const original=await readProtectedLc20Candidate(store,projectId,refs.originalOriginRef,signal),current=refs.originalOriginRef===refs.currentInputRef?original:await readProtectedLc20Candidate(store,projectId,refs.currentInputRef,signal);all.set(original.request.id,original);all.set(current.request.id,current);
    if(original.pin.policyReferenceDigest!==p.base.owner.reference.digest||current.pin.policyReferenceDigest!==p.base.owner.reference.digest||!same(original.pin.contract,p.completeProducer)||!same(current.pin.contract,p.completeProducer)||original.pin.contract.catalogDigest!==p.base.catalogScopeDigest||current.pin.contract.catalogDigest!==p.base.catalogScopeDigest)reject('LC20_PRODUCER_CONTRACT','Original and current inputs must use the exact published reviewed protocol',409);
    const scope={workspaceId,projectId,acceptanceScopeDigest:p.base.catalogScopeDigest},history:CompleteSources['history']=[];
    for(const claim of before.claims){if(claim.pin.mode!=='EXECUTE')continue;let s=all.get(claim.request.id);if(!s&&claim.progress?.phase==='COMPLETE')try{s=await readProtectedLc20Candidate(store,projectId,'stage-request:'+claim.request.id,signal);}catch{signal.throwIfAborted();}
      if(s?.execution){const original=originalExecution(scope,s);history.push({executionDigest:valueDigest(original),candidateDigest:original.candidateDigest,rawReceiptDigest:original.rawReceiptDigest,outcome:'PASS',executedAt:original.executedAt});}
      else{const outcome=claim.progress?.phase==='FAILED'?'FAIL':'UNKNOWN';history.push({executionDigest:valueDigest({request:claim.request.digest,outcome}),candidateDigest:claim.ci?.candidateDigest??valueDigest({request:claim.request.digest,candidate:'UNKNOWN'}),rawReceiptDigest:claim.ci?.archiveDigest??valueDigest({request:claim.request.digest,raw:'UNAVAILABLE'}),outcome,executedAt:claim.request.requestedAt});}}
    history.sort((a,b)=>a.executedAt<b.executedAt?-1:a.executedAt>b.executedAt?1:a.executionDigest<b.executionDigest?-1:1);const after=lc20ManagedHistoryState(store,projectId,actor);if(after.watermark!==before.watermark)reject('LC20_HISTORY_UNKNOWN','Managed history changed while reading original bytes',409);
    await prepareLc20Protocol(signal);signal.throwIfAborted();if(lc20ManagedHistoryState(store,projectId,actor).watermark!==after.watermark)reject('LC20_HISTORY_UNKNOWN','Managed history changed during byte observation',409);
    completeSources.set(sourceKey(projectId,refs),{original,current,history,watermark:after.watermark});
  }
  function completeSnapshot(selection:QualificationSelection,refs:NonNullable<PlanRecord['sources']>,actor:Principal,p:Policy,grant:ProtectedQualificationFacts['assessmentAuthority']):ProtectedQualificationFacts {
    const s=completeSources.get(sourceKey(selection.scope.projectId,refs));if(!s||lc20ManagedHistoryState(store,selection.scope.projectId,actor).watermark!==s.watermark)reject('LC20_HISTORY_UNKNOWN','Reinspect complete original source and history before use',409);
    const policy=casePolicy(p,'LC20'),original=originalExecution(selection.scope,s.original),originalInputs=withPolicy(s.original.inputs,s.original.pin.policyReferenceDigest,s.original.pin.validityContractDigest),currentInputs=withPolicy(s.current.inputs,p.base.owner.reference.digest,p.base.validityContractDigest);
    if(selection.caseId!=='LC20'||selection.currentCandidateDigest!==s.current.distribution.manifestDigest||selection.originalExecutionDigest!==valueDigest(original)||Date.parse(s.current.expiresAt)<=Date.now()||Date.parse(s.original.expiresAt)<=Date.now())reject('LC20_ORIGIN_CHANGED','Select the actual original execution and actual current Runtime distribution',409);
    const history=s.history;
    const runtime=observeLc20Protocol(store,readIntegrationConfiguration(configPath,workspaceId),selection.scope,p.base.owner.reference.digest,actor);
    if(runtime.status!=='COMPLETE'||runtime.installedCandidateDigest!==selection.currentCandidateDigest||!same(runtime.inputs,s.current.pin.protocolObservation.inputs))reject('LC20_RUNTIME_INPUT_UNKNOWN','Current fixed Runtime protocol or child prestate is unproven; execute the full case',409);
    return{schema:'runtime-protected-qualification-facts/v2',input:{schema:'runtime-evidence-qualification-input/v1',scope:selection.scope,caseId:'LC20',currentCandidateDigest:selection.currentCandidateDigest,original,originalExecutionDigest:valueDigest(original),rawReceipt:s.original.execution!.rawReceipt,originalInputs,currentInputs,history,executionRule:'OWNER_POLICY'},formalAcceptanceEligible:true,original:{receiptRef:refs.originalOriginRef,rawBytesRef:refs.originalOriginRef+'/evidence/lc20-execution.json',revision:s.original.request.digest,readbackDigest:s.original.stateDigest},history:{receiptRef:'runtime:managed-lc20-history/'+selection.scope.projectId,watermark:s.watermark},inventories:{original:{receiptRef:refs.originalOriginRef+'/inputs',revision:s.original.snapshotDigest},current:{receiptRef:refs.currentInputRef+'/inputs',revision:s.current.snapshotDigest}},policy,validity:{receiptRef:refs.originalOriginRef+'/validity',revision:s.original.pin.registrationDigest,recordDigest:valueDigest({original:original.expiresAt,current:s.current.expiresAt,policy:p.stamp}),originalPolicy:{protectedRecordRef:s.original.pin.registrationRef,recordDigest:s.original.pin.registrationDigest,expiresAt:s.original.pin.registrationExpiresAt},originalPolicyApplicability:'APPLICABLE'},assessmentAuthority:grant};
  }
  function storedPlan(projectId:string,planRef:string):PlanRecord{const r=store.object(projectId,kind,planRef) as PlanRecord|null;if(!r||r.plan.schema!=='runtime-qualification-assessment-plan/v2'||r.plan.ref!==planRef||r.plan.projectId!==projectId)reject('QUALIFICATION_PLAN_REQUIRED','Original protected assessment plan required',409);const{ref:unused,digest,...body}=r.plan;if(valueDigest(body)!==digest||r.plan.protectedPlanDigest!==valueDigest(r.facts))reject('QUALIFICATION_PLAN_CHANGED','Retained plan changed',503);return r;}
  function currentPlan(projectId:string,planRef:string,actor:Principal){
    authorize(actor,projectId,'read');const r=storedPlan(projectId,planRef),p=policyCurrent(projectId,r.registrationRef);if(p.stamp!==r.plan.registrationDigest||Date.parse(r.plan.deadlineAt)<=Date.now())reject('QUALIFICATION_PLAN_CHANGED','Original plan registration or deadline changed',409);
    const grant={requestId:r.plan.requestId,authorityRef:'ungranted',authorityDigest:valueDigest(null),deadlineAt:r.plan.deadlineAt},snapshot=r.sources?completeSnapshot(r.plan.selection,r.sources,actor,p,grant):probe(p,r.plan.selection.caseId).snapshot(r.plan.selection,actor,casePolicy(p,r.plan.selection.caseId),grant);const{assessmentAuthority:unused,...facts}=snapshot;
    if(!same(facts,r.facts))reject('QUALIFICATION_FACTS_CHANGED','Protected plan inputs, history or current policy changed',409);return r.plan;
  }
  const authority=createQualificationAssessmentAuthority(store,principals,currentPlan);
  function selectedPlan(selection:QualificationSelection){const selected=store.object(selection.scope.projectId,kind,'selection:'+valueDigest(selection)) as {planRef:string}|null;if(!selected)reject('QUALIFICATION_PLAN_REQUIRED','Prepare and authorize the exact protected plan first',409);const r=storedPlan(selection.scope.projectId,selected.planRef);if(!same(r.plan.selection,selection))reject('QUALIFICATION_PLAN_CHANGED','Plan selection changed',409);return r;}
  function planForSelection(selection:QualificationSelection,actor:Principal){const r=selectedPlan(selection);currentPlan(selection.scope.projectId,r.plan.ref,actor);return r;}
  function factsSync(selection:QualificationSelection,actor:Principal){const r=planForSelection(selection,actor),p=policyCurrent(selection.scope.projectId,r.registrationRef),grant=authority.resolve(selection.scope.projectId,r.plan.ref,actor);return r.sources?completeSnapshot(selection,r.sources,actor,p,grant):probe(p,selection.caseId).snapshot(selection,actor,casePolicy(p,selection.caseId),grant);}
  function executionRecord(projectId:string,refValue:string):ExecutionRecord{const r=store.object(projectId,kind,refValue) as ExecutionRecord|null;if(!r||r.schema!=='runtime-current-execution-source/v3'||!r.capture.origin.distributionIdentity||r.capture?.schema!=='runtime-current-execution-capture/v2'||r.capture.captureRef!==refValue||r.capture.scope.projectId!==projectId||byteDigest(r.rawReceipt)!==r.capture.rawReceiptDigest)reject('QUALIFICATION_EXECUTION_REQUIRED','Original typed registered execution required',409);return r;}
  function executionCurrent(projectId:string,capture:TypedCurrentExecutionCapture,actor:Principal){
    authority.currentActor(actor,projectId,'read');const r=executionRecord(projectId,capture.captureRef);if(verifiedExecutionSources.get(capture.captureRef)!==valueDigest(r))reject('QUALIFICATION_EXECUTION_INSPECTION_REQUIRED','Reinspect actual Runtime distribution source bytes first',409);const p=policyCurrent(projectId,r.registrationRef),source=protectedCiExecutionState(store,projectId,r.originRef,capture.caseId),ci=source.view.ci;
    if(!ci?.candidateDigest)reject('QUALIFICATION_EXECUTION_CHANGED','Original candidate execution required',409);
    const config=readIntegrationConfiguration(configPath,workspaceId),platform=configuredPlatform(config,actor,projectId,source.view.plan.binding.ref);
    if(!same(platform,source.view.plan.binding)||(['ontology','harness'] as const).some(kind=>{const pin=source.view.plan.owners[kind],registered=config.owners.find(o=>o.ref===pin.ref&&o.owner===kind&&o.projects.includes(projectId));if(!registered)return true;const{ref:unused,...definition}=registered;return valueDigest(definition)!==pin.registrationDigest;}))reject('QUALIFICATION_EXECUTION_CHANGED','Original provider or owner registration changed',409);
    const raw=readCurrentCaseReceipt(Buffer.from(r.rawReceipt),{caseId:capture.caseId,sourceCommit:source.view.plan.commit,candidateDigest:capture.candidateDigest,lifecycleCandidateDigest:ci.candidateDigest,requestId:ci.requestId,inputDigest:source.request.inputDigest});
    const expectedExpiry=new Date(Math.min(Date.parse(p.registration.expiresAt),Date.parse(raw.completedAt)+r.producer.maxAgeSeconds*1000)).toISOString(),rule=casePolicy(p,capture.caseId).requirement;
    if(!same(r.capture,capture)||p.stamp!==r.policyStamp||!same(p.producers.get(capture.caseId),r.producer)||source.stateDigest!==r.originStateDigest||source.historyWatermark!==capture.historyWatermark||source.entry.rawReceipt.digest!==capture.rawReceiptDigest||raw.rawReceiptDigest!==source.entry.rawReceipt.digest||capture.origin.distributionIdentity?.lifecycleCandidateDigest!==ci.candidateDigest||capture.origin.distributionIdentity.manifestDigest!==capture.candidateDigest||capture.originalReceiptRef!==r.originRef||capture.protectedFactsDigest!==valueDigest({origin:source.stateDigest,policy:p.stamp,producer:r.producer})||capture.phase!==rule.phase||capture.requirement!==rule.executionRequirement||!same(capture.policy,{referenceDigest:p.base.owner.reference.digest,profileDigest:p.base.profileDigest,catalogScopeDigest:p.base.catalogScopeDigest})||capture.expiresAt!==expectedExpiry||Date.parse(capture.expiresAt)<=Date.now())reject('QUALIFICATION_EXECUTION_CHANGED','Current original execution or policy changed',409);
    policyCurrent(projectId,r.registrationRef);return authority.currentActor(actor,projectId,'read');
  }
  /** Enumerate native originals, not caller-selected status JSON. Missing
   * selectors are not absence proof. Only an entirely checked registered
   * native producer inventory may identify a case with no retained origin. */
  function executionSetInventory(projectId:string,p:Policy,phase:'PRE_RELEASE'|'POST_RELEASE',actor:Principal,signal?:AbortSignal){
    const revision=store.revision(projectId),events=new Map<string,Record<string,unknown>>(),requests=new Map<string,StageRequest>(),snapshots:unknown[]=[];
    let cursor:string|undefined,eventCount=0;
    for(;;){signal?.throwIfAborted();const page=store.events(actor,projectId,cursor);for(const raw of page.events){if(++eventCount>32768)reject('DIFFERENTIAL_HISTORY_LIMIT','Native claim audit exceeds bounded observation',409);const e=record(raw);if(e.type==='stage-requested'){const d=record(e.data),id=string(d.stageRequestId);if(events.has(id))reject('DIFFERENTIAL_HISTORY_UNAVAILABLE','Duplicate original native claim',409);events.set(id,d);}}if(!page.events.length)break;cursor=page.cursor;}
    const selected=[...p.cases.values()].filter(c=>c.phase===phase).sort((a,b)=>a.caseId<b.caseId?-1:1),rows=new Map<string,DifferentialEvidenceCase>(selected.map(c=>[c.caseId,{caseId:c.caseId,executionRequirement:c.executionRequirement,observedOutcomes:[],originalRequestIds:[],observeOriginalRequestIds:[],absence:p.producers.has(c.caseId)||c.caseId==='LC20'&&p.completeProducer?'PROVEN_NATIVE_ABSENCE':'UNPROVEN'}]));
    const addRequest=(row:DifferentialEvidenceCase,id:string,unknown:boolean)=>{row.absence='NOT_ABSENT';if(!row.originalRequestIds.includes(id))row.originalRequestIds.push(id);if(unknown&&!row.observeOriginalRequestIds.includes(id))row.observeOriginalRequestIds.push(id);};
    let unmappedOriginal=false,after='';for(;;){signal?.throwIfAborted();const page=store.objectsPage(projectId,'stage-request',after,200);for(const item of page){
      if(requests.size>=4096)reject('DIFFERENTIAL_HISTORY_LIMIT','Native stage inventory exceeds bounded observation',409);const r=item.value as StageRequest,{digest,...body}=r,claim=events.get(item.id),instance=store.object(projectId,'lifecycle-instance',r.instanceId) as LifecycleInstance|null;
      if(r.schema!=='runtime-stage-request/v1'||r.id!==item.id||r.projectId!==projectId||r.workspaceId!==workspaceId||valueDigest(body)!==digest||valueDigest(r.plan)!==r.planDigest||!claim||claim.planDigest!==r.planDigest||claim.inputDigest!==r.inputDigest||claim.instanceId!==r.instanceId||claim.stageId!==r.stageId||instance?.schema!=='runtime-lifecycle-instance/v1'||instance.id!==r.instanceId||instance.pins.projectId!==projectId||!instance.requestIds.includes(r.id)||instance.pinsDigest!==r.pinsDigest)reject('DIFFERENTIAL_HISTORY_UNAVAILABLE','Native requests, immutable plans and claim inventory differ',409);
      requests.set(r.id,r);const progress=store.object(projectId,'stage-progress',r.id),v=progress===null?null:record(progress),observation=v?.observationRef?store.object(projectId,'stage-observation',string(v.observationRef)):null;
      if(!v||v.requestId!==r.id||!Number.isFinite(Date.parse(r.deadlineAt))||!Number.isFinite(Date.parse(String(v.observedAt))))reject('DIFFERENTIAL_HISTORY_UNAVAILABLE','Original native progress and time are required',409);
      exact(v,['requestId','phase','terminal','handle','observation','observationRef','reason','observedAt']);
      if(v.phase==='DISPATCHING'){
        if(v.terminal!==false||v.observation!==null||v.observationRef!==null||v.reason!==null||v.handle!==null)reject('DIFFERENTIAL_HISTORY_UNAVAILABLE','Initial native progress contains unverified facts',409);
      }else{
        if(!['WAITING_AGENT','CI_PENDING','CI_RUNNING','RUNNING','UNKNOWN','COMPLETE','FAILED'].includes(String(v.phase))||!v.observation||!v.observationRef||!observation)reject('DIFFERENTIAL_HISTORY_UNAVAILABLE','Immutable original native observation required',409);
        const envelope=record(observation),actual=record(v.observation),outcome=record(actual.outcome);exact(envelope,['schema','requestId','observation','reason','observedAt']);
        if(envelope.schema!=='runtime-stage-observation/v1'||envelope.requestId!==r.id||valueDigest(envelope)!==v.observationRef||!same(envelope.observation,v.observation)||envelope.reason!==v.reason||envelope.observedAt!==v.observedAt||actual.phase!==v.phase||!same(v.handle,actual.handle)||v.terminal!==['COMPLETE','FAILED'].includes(String(v.phase))||actual.requestId!==r.id||actual.inputDigest!==r.inputDigest||actual.adapterDigest!==r.plan.adapterDigest||outcome.requestId!==r.id||outcome.inputDigest!==r.inputDigest||outcome.status!==(v.phase==='COMPLETE'?'COMPLETE':v.phase==='FAILED'?'FAILED':v.phase==='UNKNOWN'?'UNKNOWN':'RUNNING'))reject('DIFFERENTIAL_HISTORY_UNAVAILABLE','Mutable progress differs from its immutable original observation',409);
      }
      const unknown=!v||!['COMPLETE','FAILED'].includes(String(v.phase)),params=record(r.plan.parameters);
      let mapped=false;for(const c of p.cases.values()){const producer=p.producers.get(c.caseId),pin=params.qualificationProducer;const matches=producer&&params.workflowDigest===producer.workflowDigest||c.caseId==='LC20'&&pin&&record(record(pin).contract).caseId==='LC20';if(matches){mapped=true;const row=rows.get(c.caseId);if(row){addRequest(row,r.id,unknown);if(v.phase==='FAILED'&&!row.observedOutcomes.includes('FAIL'))row.observedOutcomes.push('FAIL');}}}
      // An older or unclassified producer claim may belong to a current case.
      // Its absence cannot be guessed from today's producer mapping.
      const knownPredecessor=r.plan.bindingDigest===valueDigest(params)&&!Object.hasOwn(params,'workflowDigest')&&!Object.hasOwn(params,'qualificationProducer')&&(
        r.stageId==='scope'&&r.plan.adapterId==='runtime-scope-stage-v1'&&r.plan.action==='base.scope'&&r.plan.adapterDigest===valueDigest({id:'runtime-scope-stage-v1',preparation:'runtime-preparation/v1',checks:['target-scope','requirements-mapping'],continuation:'explicit-local-commit'})||
        r.stageId==='plan'&&r.plan.adapterId==='runtime-plan-stage-v1'&&r.plan.action==='base.plan'&&r.plan.adapterDigest===valueDigest({id:'runtime-plan-stage-v1',preparation:'runtime-preparation/v1',observation:'runtime-plan-observation/v1',owners:'native/v1',recovery:'inspect-original'}));
      // These two fixed preparation-stages.ts contracts produce scope/plan
      // evidence only. Unknown adapters or historical CI workflows stay unknown.
      if(!mapped&&!knownPredecessor)unmappedOriginal=true;
      snapshots.push({request:r.digest,progress,observation});
    }if(page.length<200)break;after=page.at(-1)!.id;}
    if(requests.size!==events.size)reject('DIFFERENTIAL_HISTORY_UNAVAILABLE','A native stage claim is missing from protected inventory',409);
    let captures=0;const archives=new Set<string>();after='';for(;;){signal?.throwIfAborted();const page=store.objectsPage(projectId,'ci-acceptance-capture',after,200);for(const item of page){
      if(++captures>4096)reject('DIFFERENTIAL_HISTORY_LIMIT','Native capture inventory exceeds bounded observation',409);const original=record(item.value),{digest,...body}=original,report=record(original.report),requestId=string(original.stageRequestId);
      if(original.schema!=='runtime-ci-acceptance-capture/v1'||valueDigest(body)!==digest||original.workspaceId!==workspaceId||original.projectId!==projectId||!requests.has(requestId)||original.stageRequestDigest!==requests.get(requestId)!.digest||!Array.isArray(report.cases))reject('DIFFERENTIAL_HISTORY_UNAVAILABLE','Original captured cases differ from native claim',409);
      const entries=report.cases.map(record).filter(c=>rows.has(String(c.caseId)));
      if(entries.length){const source=protectedCiExecutionState(store,projectId,item.id,String(entries[0].caseId));archives.add(source.root+'\0'+source.archiveDigest);if(archives.size>709)reject('DIFFERENTIAL_HISTORY_LIMIT','Original archive observation exceeds 709 unique originals',409);snapshots.push({capture:item.id,digest,sourceDigest:source.stateDigest,archiveDigest:source.archiveDigest});
        for(const entry of entries){const outcome=string(entry.observedOutcome) as RawEvidenceOutcome;if(!['PASS','FAIL','NOT_RUN','CANCELLED','UNKNOWN','SKIPPED'].includes(outcome))reject('DIFFERENTIAL_HISTORY_UNAVAILABLE','Unknown original captured outcome',409);const row=rows.get(String(entry.caseId))!;addRequest(row,requestId,outcome==='UNKNOWN');if(!row.observedOutcomes.includes(outcome))row.observedOutcomes.push(outcome);}
      }else snapshots.push({capture:item.id,digest});
    }if(page.length<200)break;after=page.at(-1)!.id;}
    // Closed probes are observations only. They never make a formal case NEW,
    // executed or reusable; their existence prevents a false absence claim.
    for(const configured of (p.registration.definition.probes as {caseId:string}[])){const row=rows.get(configured.caseId);if(!row)continue;const history=probe(p,configured.caseId).history(actor);if(history.length){row.absence='NOT_ABSENT';snapshots.push({probe:configured.caseId,historyDigest:valueDigest(history)});}}
    if(store.revision(projectId)!==revision)reject('DIFFERENTIAL_FACTS_CHANGED','Complete native inventory changed while reading',409);
    for(const row of rows.values()){if(unmappedOriginal&&row.absence==='PROVEN_NATIVE_ABSENCE')row.absence='UNPROVEN';row.observedOutcomes.sort();row.originalRequestIds.sort();row.observeOriginalRequestIds.sort();}
    return{cases:[...rows.values()],historyWatermark:valueDigest(snapshots),projectRevision:revision};
  }
  async function executionSetCatalog(projectId:string,registrationRef:string,phase:'PRE_RELEASE'|'POST_RELEASE',actor:Principal,signal:AbortSignal):Promise<DifferentialEvidenceCatalog>{
    const p=await policy(projectId,registrationRef,actor,signal),fresh=authority.currentActor(actor,projectId,'read'),inventory=executionSetInventory(projectId,p,phase,fresh,signal);
    signal.throwIfAborted();policyCurrent(projectId,registrationRef);authority.currentActor(actor,projectId,'read');
    invocations.getStore()?.policies.set(projectId+'\0'+registrationRef,{policy:p,observer:{id:fresh.id,revision:fresh.revision}});
    return{scope:{workspaceId,projectId,acceptanceScopeDigest:p.base.catalogScopeDigest},phase,registrationRef,policyDigest:p.base.owner.reference.digest,profileDigest:p.base.profileDigest,registrationDigest:p.stamp,inventoryDigest:p.base.caseInventoryDigest,expiresAt:new Date(Math.min(Date.parse(p.registration.expiresAt),Date.parse(fresh.expiresAt))).toISOString(),...inventory};
  }
  const bindings:NativeQualificationBindings={
    executionSetFinalizer(catalog,observer,subjects){const configurationDigest=valueDigest(readIntegrationConfiguration(configPath,workspaceId)),plans=new Map(subjects.map(subject=>{const r=selectedPlan(subject.selection);return[r.plan.ref,r.plan];}));
      const unchanged=()=>{const p=policyCurrent(catalog.scope.projectId,catalog.registrationRef);if(store.revision(catalog.scope.projectId)!==catalog.projectRevision||p.stamp!==catalog.registrationDigest||p.base.owner.reference.digest!==catalog.policyDigest||p.base.profileDigest!==catalog.profileDigest||valueDigest(readIntegrationConfiguration(configPath,workspaceId))!==configurationDigest||Date.parse(catalog.expiresAt)<=Date.now())reject('DIFFERENTIAL_FACTS_CHANGED','Original protected inventory, configuration or policy changed during final observation',409);};
      // Reuse the original grant reader, including independent grantor and
      // initiator credentials and original decision bytes. Only plans already
      // authenticated in this observation can use its closed-byte proof.
      const grants=createQualificationAssessmentAuthority(store,principals,(projectId,ref)=>{unchanged();const expected=plans.get(ref),actual=storedPlan(projectId,ref).plan;if(projectId!==catalog.scope.projectId||!expected||!same(expected,actual))reject('QUALIFICATION_PLAN_CHANGED','Original authenticated plan required at final consumption',409);return actual;});
      return()=>{unchanged();for(const subject of subjects){const r=selectedPlan(subject.selection),grant=grants.resolve(catalog.scope.projectId,r.plan.ref,observer);if(grant.authorityRef!==subject.authorityRef||grant.authorityDigest!==subject.authorityDigest)reject('QUALIFICATION_AUTHORITY_CHANGED','Original assessment authority changed after byte cleanup',409);}unchanged();return authority.currentActor(observer,catalog.scope.projectId,'read');};},
    readExecutionSetCatalog:executionSetCatalog,
    authorizeExecutionSet(catalog,observer){const fresh=authority.currentActor(observer,catalog.scope.projectId,'read'),p=policyCurrent(catalog.scope.projectId,catalog.registrationRef),inventory=executionSetInventory(catalog.scope.projectId,p,catalog.phase,fresh);
      if(catalog.scope.workspaceId!==workspaceId||catalog.registrationDigest!==p.stamp||catalog.policyDigest!==p.base.owner.reference.digest||catalog.profileDigest!==p.base.profileDigest||catalog.inventoryDigest!==p.base.caseInventoryDigest||catalog.scope.acceptanceScopeDigest!==p.base.catalogScopeDigest||catalog.projectRevision!==inventory.projectRevision||catalog.historyWatermark!==inventory.historyWatermark||!same(catalog.cases,inventory.cases)||Date.parse(catalog.expiresAt)<=Date.now())reject('DIFFERENTIAL_FACTS_CHANGED','Current catalog, protected inventory and original observer are required',409);return fresh;},
    async read(selection,actor,signal){const r=selectedPlan(selection);const p=await policy(selection.scope.projectId,r.registrationRef,actor,signal);if(r.sources)await refreshComplete(selection.scope.projectId,r.sources,p,actor,signal);signal.throwIfAborted();return factsSync(selection,actor);},
    owner(refValue){return connections.owner(refValue,readIntegrationConfiguration(configPath,workspaceId));},
    authorizeDispatch(subject,actor){const fresh=authority.currentActor(actor,subject.projectId,'execution.request'),a=store.object(subject.projectId,kind,subject.actionRef) as QualificationAction|null;if(!a||a.digest!==subject.actionDigest||a.action.requestDigest!==subject.requestDigest)reject('QUALIFICATION_ACTION_CHANGED','Exact original native action required',409);const r=planForSelection(a.selection,fresh);if(r.plan.initiatedBy.id!==fresh.id||r.plan.initiatedBy.revision!==fresh.revision)reject('QUALIFICATION_PRINCIPAL_CHANGED','Original current initiator required',403);const f=factsSync(a.selection,fresh);if(!same(f,a.facts)||f.assessmentAuthority.authorityRef!==subject.authorityRef||f.assessmentAuthority.authorityDigest!==subject.authorityDigest||a.expiresAt!==subject.expiresAt)reject('QUALIFICATION_AUTHORITY_CHANGED','Exact grant and protected action facts required',409);return{actor:fresh,permit:{projectId:subject.projectId,owner:'harness',requestDigest:subject.requestDigest,authorityRef:subject.authorityRef,expiresAt:subject.expiresAt}};},
    authorizeInspect(subject,actor){const fresh=authority.currentActor(actor,subject.projectId,'read'),facts=factsSync(subject.selection,fresh);if(valueDigest(facts)!==subject.protectedFactsDigest||facts.assessmentAuthority.authorityRef!==subject.authorityRef||facts.assessmentAuthority.authorityDigest!==subject.authorityDigest||facts.history.watermark!==subject.historyWatermark||facts.policy.trust.revision!==subject.trustRevision||facts.policy.owner.registrationDigest!==subject.ownerRegistrationDigest)reject('QUALIFICATION_FACTS_CHANGED','Current complete qualification facts required',409);return fresh;},
    async readExecution(projectId,refValue,actor,signal){const r=executionRecord(projectId,refValue);await executionPolicy(projectId,r.registrationRef,actor,signal);const original=await readProtectedCiExecution(store,projectId,r.originRef,r.producer,signal);if(original.candidateDigest!==r.capture.candidateDigest||original.rawReceipt!==r.rawReceipt||!same(original.origin,r.capture.origin)||original.stateDigest!==r.originStateDigest)reject('QUALIFICATION_EXECUTION_CHANGED','Original Runtime distribution and actual case bytes changed',409);verifiedExecutionSources.set(refValue,valueDigest(r));executionCurrent(projectId,r.capture,actor);return r.capture;},
    authorizeExecution:executionCurrent,
  };
  bindings.openObservationScope=openObservationScope;
  const native=createNativeQualificationService(store,bindings),signal=()=>AbortSignal.timeout(30000);
  const registered:RegisteredQualificationService={native,
    async read(actor,projectId,operation,input){
      authorize(actor,projectId,'read');
      if(operation==='lifecycle.qualification.execution-set.inspect')return native.inspectExecutionSet(projectId,input as unknown as DifferentialEvidenceSelection,actor,signal());
      if(operation==='lifecycle.qualification.action.inspect'){
        exact(input,['actionRef']);const actionRef=string(input.actionRef,512),a=store.object(projectId,kind,actionRef) as QualificationAction|null;
        if(!a||a.schema!=='runtime-native-qualification-action/v2'||a.selection.scope.projectId!==projectId||a.selection.scope.workspaceId!==workspaceId||a.factsDigest!==valueDigest(a.facts))reject('QUALIFICATION_ACTION_REQUIRED','Original native action required',404);
        const{digest,...body}=a;if(valueDigest(body)!==digest)reject('QUALIFICATION_ACTION_CHANGED','Original action changed',503);
        const bounded=signal();await ensure(bounded);
        const ownerCurrent=()=>{const c=readIntegrationConfiguration(configPath,workspaceId),pin=a.facts.policy.owner,r=c.owners.find(o=>o.ref===pin.ref&&o.owner==='harness'&&o.projects.includes(projectId));if(!r)reject('QUALIFICATION_OWNER_CHANGED','Original owner registration unavailable',409);const{ref:unused,...ownerConfig}=r,owner=connections.owner(r.ref,c);if(valueDigest(ownerConfig)!==pin.registrationDigest||record(owner.capabilities()).registrationDigest!==pin.registrationDigest)reject('QUALIFICATION_OWNER_CHANGED','Original owner registration changed',409);return owner;};
        const fresh=authority.currentActor(actor,projectId,'read'),owner=ownerCurrent();let receipt:Record<string,unknown>|null=null;
        try{receipt=record(await owner.read(fresh,projectId,{operation:'native.receipt.inspect',scope:a.facts.policy.owner.scope,input:{requestId:a.action.request.requestId}}));}catch(error){if(!(error instanceof ServiceError)||error.code!=='NOT_FOUND')throw error;}
        const result=receipt?verifyNativeStageResult(receipt,'harness',a.facts.policy.owner,a.action,a.facts.policy.toolchainLockDigest,a.facts.policy.effectiveConfigDigest):{status:'UNKNOWN',receiptDigest:null,reportDigest:null};
        bounded.throwIfAborted();ownerCurrent();authority.currentActor(actor,projectId,'read');return{actionRef,actionDigest:a.digest,originalRequestId:a.action.request.requestId,originalAuthorityRef:a.facts.assessmentAuthority.authorityRef,dispatchRetained:store.object(projectId,kind,'dispatch:'+actionRef)!==null,observedStatus:result.status,nativeReceiptDigest:result.receiptDigest,nativeReportDigest:result.reportDigest,qualification:'NOT_ASSESSED',automaticRedispatch:false,executionAuthorized:false,releaseAuthorized:false};
      }
      if(operation==='lifecycle.qualification.inspect'){exact(input,['actionRef']);return native.inspect(projectId,string(input.actionRef,512),actor,signal());}
      if(operation==='lifecycle.qualification.execution.inspect'){exact(input,['captureRef']);return native.inspectExecution(projectId,string(input.captureRef,512),actor,signal());}
      if(QUALIFICATION_AUTHORITY_READS.includes(operation as typeof QUALIFICATION_AUTHORITY_READS[number])){exact(input,['planRef']);const r=storedPlan(projectId,string(input.planRef,512));const bounded=signal(),p=await policy(projectId,r.registrationRef,actor,bounded);if(r.sources)await refreshComplete(projectId,r.sources,p,actor,bounded);return authority.read(actor,projectId,operation,input);}
      if(operation!=='lifecycle.qualification.origin.inspect')reject('UNKNOWN_OPERATION','Unsupported qualification read',404);
      exact(input,['registrationRef','caseId'],['originRef','afterRequestId','limit','currentCandidateDigest','originalExecutionDigest','protocol']);const p=await policy(projectId,string(input.registrationRef,512),actor,signal()),caseId=string(input.caseId,256);casePolicy(p,caseId);
      const observer=authority.currentActor(actor,projectId,'read');
      if(input.protocol!==undefined){
        if(input.protocol!=='runtime-lc20-local-installed/v1'||caseId!=='LC20'||!p.completeProducer||input.afterRequestId!==undefined||input.limit!==undefined||input.originalExecutionDigest!==undefined||input.currentCandidateDigest!==undefined||!String(input.originRef).startsWith('stage-request:'))reject('INVALID_FIELDS','Select the original fixed LC20 producer request');
        const id=string(input.originRef,512).slice(14),request=record(store.object(projectId,'stage-request',id)),pin=record(record(record(request.plan).parameters).qualificationProducer),{digest,...body}=request;
        if(request.id!==id||request.workspaceId!==workspaceId||request.projectId!==projectId||valueDigest(body)!==digest||request.planDigest!==valueDigest(request.plan)||pin.contractDigest!==valueDigest(p.completeProducer)||pin.policyReferenceDigest!==p.base.owner.reference.digest)reject('LC20_ORIGIN_REQUIRED','Actual immutable scoped producer claim required',409);
        await prepareLc20Protocol(signal());
        const current=observeLc20Protocol(store,readIntegrationConfiguration(configPath,workspaceId),{workspaceId,projectId,acceptanceScopeDigest:p.base.catalogScopeDigest},p.base.owner.reference.digest,observer),before=record(pin.protocolObservation),equal=current.status==='COMPLETE'&&before.status==='COMPLETE'&&same(current.inputs,before.inputs)&&current.installedCandidateDigest===before.installedCandidateDigest;
        authority.currentActor(actor,projectId,'read');policyCurrent(projectId,p.registration.ref);return{schema:'runtime-lc20-protocol-readback/v1',stageRequestId:id,stageRequestDigest:digest,inputDigest:request.inputDigest,contractDigest:pin.contractDigest,contract:pin.contract,mode:pin.mode,original:pin.protocolObservation,current,disposition:equal?'PROVEN_FIXED_INPUTS':'FULL',formalAcceptanceEligible:false,executionAuthorized:false,releaseAuthorized:false};
      }
      if(input.originalExecutionDigest!==undefined||input.currentCandidateDigest!==undefined){
        if(input.originRef!==undefined||input.afterRequestId!==undefined||input.limit!==undefined)reject('INVALID_FIELDS','Select one exact protected probe origin');
        const selection:QualificationSelection={schema:'runtime-evidence-qualification-selection/v2',scope:{workspaceId,projectId,acceptanceScopeDigest:p.base.catalogScopeDigest},caseId,currentCandidateDigest:hash(input.currentCandidateDigest),originalExecutionDigest:hash(input.originalExecutionDigest),phase:casePolicy(p,caseId).requirement.phase};
        const facts=probe(p,caseId).snapshot(selection,observer,casePolicy(p,caseId),{requestId:'readonly-input-preview',authorityRef:'ungranted',authorityDigest:valueDigest(null),deadlineAt:p.registration.expiresAt}),check=await qualifyEvidence(facts.input,undefined,Date.now());
        authority.currentActor(actor,projectId,'read');policyCurrent(projectId,p.registration.ref);return{schema:'runtime-probe-input-preview/v1',selection,original:facts.input.original,rawReceipt:facts.input.rawReceipt,originalInputs:facts.input.originalInputs,currentInputs:facts.input.currentInputs,reasons:check.reasons.filter(r=>r!=='OWNER_POLICY_UNAVAILABLE'),disposition:check.reasons.some(r=>r!=='OWNER_POLICY_UNAVAILABLE')?'EXECUTION_REQUIRED':'ASSESSMENT_REQUIRED',fallback:check.fallback,formalAcceptanceEligible:false,executionAuthorized:false,releaseAuthorized:false};
      }
      if(input.originRef===undefined){const history=probe(p,caseId).history(observer),limit=input.limit===undefined?50:Number(input.limit),after=input.afterRequestId===undefined?-1:history.findIndex(a=>a.requestId===string(input.afterRequestId,512));if(!Number.isSafeInteger(limit)||limit<1||limit>50||input.afterRequestId!==undefined&&after<0)reject('QUALIFICATION_HISTORY_CURSOR','Use a retained original request cursor and a limit from 1 to 50');const selected=history.slice(after+1,after+1+limit),result={producer:'CLOSED_PROBE',attempts:selected.map(({requestId,candidateDigest,startedAt,expiresAt,original})=>({requestId,candidateDigest,startedAt,expiresAt,original,originalExecutionDigest:original?valueDigest(original):null})),totalAttempts:history.length,historyWatermark:valueDigest(history),nextRequestId:after+1+selected.length<history.length?selected.at(-1)!.requestId:null,formalAcceptanceEligible:false,releaseAuthorized:false};authority.currentActor(actor,projectId,'read');return result;}
      if(input.afterRequestId!==undefined||input.limit!==undefined)reject('INVALID_FIELDS','CI origin selection has no probe history cursor');
      if(p.completeProducer&&String(input.originRef).startsWith('stage-request:')){
        const originRef=string(input.originRef,512),s=await readProtectedLc20Candidate(store,projectId,originRef,signal());authority.currentActor(actor,projectId,'read');if(s.pin.contractDigest!==valueDigest(p.completeProducer)||s.pin.policyReferenceDigest!==p.base.owner.reference.digest)reject('LC20_PRODUCER_CONTRACT','Actual origin requires the exact current published complete producer',409);
        const original=s.execution?originalExecution({workspaceId,projectId,acceptanceScopeDigest:p.base.catalogScopeDigest},s):null;return{producer:'REGISTERED_LC20',originRef,caseId:'LC20',mode:s.pin.mode,currentCandidateDigest:s.distribution.manifestDigest,distributionIdentity:s.distribution,original,originalExecutionDigest:original?valueDigest(original):null,qualification:'NOT_ASSESSED',formalAcceptanceEligible:original!==null&&s.inputs.completeness==='COMPLETE',executionAuthorized:false,releaseAuthorized:false};
      }
      const originRef=string(input.originRef,512),original=protectedCiExecutionState(store,projectId,originRef,caseId);authority.currentActor(actor,projectId,'read');return{producer:'REGISTERED_CI',originRef,stageRequestId:original.request.id,caseId,observedOutcome:original.entry.observedOutcome,history:'UNKNOWN',inputClosure:'UNKNOWN',qualification:'EXECUTION_REQUIRED',fallback:'FULL',typedExecutionProducer:p.producers.has(caseId),executionAuthorized:false,releaseAuthorized:false};
    },
    async write(actor,projectId,operation,input,requestId,expectedRevision,reauthorize){
      const permission=QUALIFICATION_AUTHORITY_WRITES.includes(operation as typeof QUALIFICATION_AUTHORITY_WRITES[number])?'decision.record':'execution.request';authorize(actor,projectId,permission);
      const mutation={projectId,operation,input,requestId,expectedRevision,permission} as const;
      if(store.findReceipt(actor,projectId,requestId))return store.mutate(actor,mutation,()=>{throw Error('Unreachable replay');},reauthorize);
      const bounded=signal();let current=()=>authority.currentActor(reauthorize(),projectId,permission);
      if(QUALIFICATION_AUTHORITY_WRITES.includes(operation as typeof QUALIFICATION_AUTHORITY_WRITES[number])){const r=storedPlan(projectId,string(input.planRef,512));const p=await policy(projectId,r.registrationRef,actor,bounded);if(r.sources)await refreshComplete(projectId,r.sources,p,actor,bounded);return authority.write(actor,projectId,operation,input,requestId,expectedRevision,reauthorize);}
      if(operation==='lifecycle.qualification.prepare'||operation==='lifecycle.qualification.dispatch'){
        exact(input,operation.endsWith('.prepare')?['planRef']:['actionRef']);const a=operation.endsWith('.dispatch')?store.object(projectId,kind,string(input.actionRef,512)) as QualificationAction:null;
        const r=a?selectedPlan(a.selection):storedPlan(projectId,string(input.planRef,512));const p=await policy(projectId,r.registrationRef,actor,bounded);if(r.sources)await refreshComplete(projectId,r.sources,p,actor,bounded);
        current=()=>{const fresh=authority.currentActor(reauthorize(),projectId,'execution.request');authority.resolve(projectId,r.plan.ref,fresh);return fresh;};
        const context:QualificationMutationContext={operation,input,requestId,expectedRevision,reauthorize:current};
        if(a)await native.dispatch(projectId,string(input.actionRef,512),actor,bounded,context);else await native.prepare(r.plan.selection,actor,bounded,context);
        return store.receipt(authority.currentActor(reauthorize(),projectId,'read'),projectId,requestId);
      }
      const registrationRef=string(input.registrationRef,512),caseId=string(input.caseId,256),p=await policy(projectId,registrationRef,actor,bounded),cp=casePolicy(p,caseId);
      current=()=>{const fresh=authority.currentActor(reauthorize(),projectId,'execution.request');if(policyCurrent(projectId,registrationRef).stamp!==p.stamp)reject('QUALIFICATION_POLICY_CHANGED','Policy changed before commit',409);return fresh;};
      if(operation==='lifecycle.qualification.probe.execute'){
        exact(input,['registrationRef','caseId','candidateDigest','expiresAt']);const deadline=string(input.expiresAt,64);if(Date.parse(deadline)>Math.min(Date.parse(p.registration.expiresAt),Date.parse(actor.expiresAt),Date.now()+600000))reject('QUALIFICATION_EXPIRY','Probe deadline exceeds its current bounded registration');await probe(p,caseId).execute(hash(input.candidateDigest),requestId,deadline,actor,bounded,{operation,input,requestId,expectedRevision,reauthorize:current});return store.receipt(authority.currentActor(reauthorize(),projectId,'read'),projectId,requestId);
      }
      if(operation==='lifecycle.qualification.plan'){
        exact(input,['registrationRef','caseId','currentCandidateDigest','originalExecutionDigest','phase','deadlineAt'],['originalOriginRef','currentInputRef']);if(input.phase!==cp.requirement.phase)reject('QUALIFICATION_SCOPE_CHANGED','Case phase differs from the protected catalog');
        const deadlineAt=string(input.deadlineAt,64);if(Date.parse(deadlineAt)<=Date.now()||Date.parse(deadlineAt)>Math.min(Date.parse(p.registration.expiresAt),Date.parse(actor.expiresAt),Date.now()+600000))reject('QUALIFICATION_EXPIRY','Assessment deadline exceeds its current bounded registration');
        const selection:QualificationSelection={schema:'runtime-evidence-qualification-selection/v2',scope:{workspaceId,projectId,acceptanceScopeDigest:p.base.catalogScopeDigest},caseId,currentCandidateDigest:hash(input.currentCandidateDigest),originalExecutionDigest:hash(input.originalExecutionDigest),phase:cp.requirement.phase},nativeRequestId='qualification-native-'+valueDigest({projectId,principalId:actor.id,requestId}).slice(7,47);
        const sources=input.originalOriginRef===undefined&&input.currentInputRef===undefined?undefined:{originalOriginRef:string(input.originalOriginRef,512),currentInputRef:string(input.currentInputRef,512)};if(sources)await refreshComplete(projectId,sources,p,current(),bounded);const grant={requestId:nativeRequestId,authorityRef:'ungranted',authorityDigest:valueDigest(null),deadlineAt},snapshot=sources?completeSnapshot(selection,sources,current(),p,grant):probe(p,caseId).snapshot(selection,current(),cp,grant),{assessmentAuthority:unused,...facts}=snapshot;
        if(Date.parse(deadlineAt)>Date.parse(facts.input.original.expiresAt))reject('QUALIFICATION_EXPIRY','Assessment cannot outlive its original execution');
        const body={schema:'runtime-qualification-assessment-plan/v2' as const,projectId,selection,protectedPlanDigest:valueDigest(facts),registrationDigest:p.stamp,requestId:nativeRequestId,deadlineAt,principalIds:strings(p.registration.definition.principalIds,128),initiatedBy:{id:actor.id,revision:actor.revision}},digest=valueDigest(body),refValue='qualification-plan:'+digest,plan={...body,ref:refValue,digest};
        return store.mutate(actor,mutation,()=>({objects:[{kind,id:refValue,value:{plan,registrationRef,facts,...(sources?{sources}:{})}},{kind,id:'selection:'+valueDigest(selection),value:{planRef:refValue}}],value:{planRef:refValue,planDigest:digest,selection,authorityGranted:false},event:{type:'qualification-plan-retained',data:{planRef:refValue}}}),current);
      }
      if(operation!=='lifecycle.qualification.execution.capture')reject('UNKNOWN_OPERATION','Unsupported qualification write',404);
      exact(input,['registrationRef','caseId','originRef']);const originRef=string(input.originRef,512),producer=p.producers.get(caseId);if(!producer)reject('QUALIFICATION_EXECUTION_REQUIRED','Published actual producer contract unavailable',409);
      const original=await readProtectedCiExecution(store,projectId,originRef,producer,bounded),expiresAt=new Date(Math.min(Date.parse(p.registration.expiresAt),Date.parse(original.completedAt)+producer.maxAgeSeconds*1000)).toISOString();if(Date.parse(expiresAt)<=Date.now())reject('QUALIFICATION_EXPIRED','Original execution expired',409);
      const captureRef='current-execution:'+valueDigest({sourceSchema:'runtime-current-execution-source/v3',registrationRef,originRef,caseId,policyStamp:p.stamp}),base={schema:'runtime-current-execution-capture/v2' as const,captureRef,scope:{workspaceId,projectId,acceptanceScopeDigest:p.base.catalogScopeDigest},caseId,phase:producer.phase,candidateDigest:original.candidateDigest,mode:'EXECUTED' as const,outcome:'PASS' as const,originalExecutionDigest:valueDigest({origin:original.origin,rawReceiptDigest:original.rawReceiptDigest}),originalReceiptRef:originRef,originalRawBytesRef:'runtime:ci-archive/'+original.origin.archiveDigest+'/'+original.rawReceiptDigest,rawReceiptDigest:original.rawReceiptDigest,protectedFactsDigest:valueDigest({origin:original.stateDigest,policy:p.stamp,producer}),historyWatermark:original.historyWatermark,expiresAt,formalAcceptanceEligible:true as const,requirement:cp.requirement.executionRequirement,policy:{referenceDigest:p.base.owner.reference.digest,profileDigest:p.base.profileDigest,catalogScopeDigest:p.base.catalogScopeDigest},origin:original.origin,establishesEnvironmentState:false as const,executionAuthorized:false as const,releaseAuthorized:false as const},capture:TypedCurrentExecutionCapture={...base,captureDigest:valueDigest(base)},saved:ExecutionRecord={schema:'runtime-current-execution-source/v3',registrationRef,originRef,producer,originStateDigest:original.stateDigest,policyStamp:p.stamp,rawReceipt:original.rawReceipt,capture};
      return store.mutate(actor,mutation,()=>{current();if(protectedCiExecutionState(store,projectId,originRef,caseId).stateDigest!==original.stateDigest)reject('QUALIFICATION_ORIGINAL_CHANGED','Original execution changed before capture',409);const old=store.object(projectId,kind,captureRef);if(old&&!same(old,saved))reject('QUALIFICATION_IMMUTABLE','Original execution capture cannot change',409);return{objects:[{kind,id:captureRef,value:saved}],value:{captureRef,captureDigest:capture.captureDigest,caseId,mode:'EXECUTED',releaseAuthorized:false},event:{type:'qualification-execution-captured',data:{captureRef,caseId}}};},current);
    },
  };
  // HTTP/MCP currently supply no disconnect signal. This local operation limit
  // bounds observation work; it must not be described as transport cancellation.
  return{native,async read(...args){const scope=openObservationScope(signal());try{return await scope.run(()=>registered.read(...args));}finally{try{scope.close();}finally{try{await scope.drain();}finally{scope.finish();}}}},async write(...args){const scope=openObservationScope(signal());try{return await scope.run(()=>registered.write(...args));}finally{try{scope.close();}finally{try{await scope.drain();}finally{scope.finish();}}}}};
}
