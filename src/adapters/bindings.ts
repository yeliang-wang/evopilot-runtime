import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { canonical, exact, record, reject, slug, string, ServiceError } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import { byteDigest, valueDigest } from '../lifecycle/base.js';
import { atPath, type EffectiveDefinition } from '../lifecycle/compiler.js';
import { bindingRequirements, type BindingCheck, type DefinitionBindingProvider } from '../lifecycle/bindings.js';
import { nativeStableSerialize, validateNativeReference, type NativePackage, type NativeReference, type NativeScope } from '../../vendor/compatibility/v1/native.mjs';
import { READINESS_STANDARD_DIGEST, type ReadinessProjection } from '../../vendor/compatibility/usability/v2/contract.mjs';
import { configuredPlatform, readIntegrationConfiguration, type IntegrationConfiguration, type PlatformRegistration, type ResourceRegistration } from './config.js';
import { openPublishedOwner, verifyReadinessView, type Owner, type PublishedOwnerAdapter } from './published-owners.js';
import type { PlatformClient, PlatformReadiness } from './platforms.js';
import { createRuntimeService } from '../service.js';
import { readPlatformToken } from './config.js';
import { githubClient } from './github.js';
import { gitlabClient } from './gitlab.js';
import { inspectExternalAgent, type AgentIdentity } from './external-agent.js';
import { readRegisteredNativeToolchain } from './config.js';
import { createImplementationStageAdapters } from './implementation-stages.js';
import { releaseDocuments } from './documents.js';
import type { RuntimeStore } from '../server/store.js';
import type { StageAdapter, StageServices } from '../lifecycle/execution.js';
import { createReleaseStageAdapter } from './release-stages.js';
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
    case 'document':fields(['file','format']);if(!['markdown','json'].includes(String(d.format)))reject('INVALID_RESOURCE','Unsupported target document format');verifyResourceFile(d.file);break;
    case 'baseline':fields(['branch','changeMode','requireClean','exactSource']);string(d.branch);fixed('changeMode','pull-request');yes('requireClean');yes('exactSource');break;
    case 'location':fields(['directory','purpose']);directory(d.directory);string(d.purpose);break;
    case 'compatibility':fields(['strategy','allowUnreviewedDrift']);fixed('strategy','exact-pins');fixed('allowUnreviewedDrift',false);break;
    case 'review':fields(['reviewerIds','evidenceRequired']);strings(d.reviewerIds,128).forEach(slug);yes('evidenceRequired');break;
    case 'recovery':fields(['strategy','onUnknown','maxAttempts']);fixed('strategy','inspect-original');fixed('onUnknown','BLOCK');if(!Number.isSafeInteger(d.maxAttempts)||Number(d.maxAttempts)<1||Number(d.maxAttempts)>4)reject('INVALID_RESOURCE','Recovery attempts must fit publisher limits');break;
    case 'agent':fields(['adapter','executable','version','hostId','workspaceRoot']);fixed('adapter','codex');verifyResourceFile(d.executable,true);string(d.version);string(d.hostId);directory(d.workspaceRoot);break;
    case 'workflow':fields(['platformRef','purpose','outputContract']);ref(d.platformRef);if(!['build','verify','publish','smoke','prepare'].includes(String(d.purpose)))reject('INVALID_RESOURCE','Unknown workflow purpose');fixed('outputContract','runtime-ci/v1');break;
    case 'toolchain':fields(['executables']);for(const raw of list(d.executables,32)){const e=record(raw);exact(e,['file','version']);verifyResourceFile(e.file,true);string(e.version);}break;
    case 'artifact-store':fields(['platformRef','retentionDays']);ref(d.platformRef);if(!Number.isSafeInteger(d.retentionDays)||Number(d.retentionDays)<1||Number(d.retentionDays)>365)reject('INVALID_RESOURCE','Invalid artifact retention');break;
    case 'manifest':fields(['action']);fixed('action','runtime.candidate.manifest/v1');break;
    case 'environment':fields(['platformRef','scope','maxConcurrency']);ref(d.platformRef);fixed('scope','dedicated-test');if(!Number.isSafeInteger(d.maxConcurrency)||Number(d.maxConcurrency)<1||Number(d.maxConcurrency)>4)reject('INVALID_RESOURCE','Invalid verification concurrency');break;
    case 'failure':fields(['onFailure','onUnknown']);fixed('onFailure','BLOCK');fixed('onUnknown','BLOCK');break;
    case 'authority-policy':fields(['principalIds','exactSubjectRequired']);strings(d.principalIds,128).forEach(slug);yes('exactSubjectRequired');break;
    case 'decision-source':fields(['backend','decisionTypes']);fixed('backend','runtime');if(canonical([...strings(d.decisionTypes)].sort())!==canonical(['execution','release']))reject('INVALID_RESOURCE','Execution and release decisions must remain separate');break;
    case 'evidence-policy':fields(['requireAll','requireCurrent','allowSkipped','documentation']);yes('requireAll');yes('requireCurrent');fixed('allowSkipped',false);releaseDocuments(d.documentation);break;
    case 'channel':fields(['platformRef','channel']);ref(d.platformRef);if(!['github-release','gitlab-release'].includes(String(d.channel)))reject('INVALID_RESOURCE','Unsupported publication channel');break;
    case 'readback':fields(['verifyDownloadedDigests','requireExactCandidate']);yes('verifyDownloadedDigests');yes('requireExactCandidate');break;
    case 'followup':fields(['onGap','autoExecute']);fixed('onGap','create-target');fixed('autoExecute',false);break;
    case 'delivery':fields(['mode'],['platformRef','directory']);if(d.mode==='distribution'){ref(d.platformRef);if(d.directory!==undefined)reject('INVALID_RESOURCE','Distribution uses the registered channel');}else if(['local-install','approved-deployment'].includes(String(d.mode))){directory(d.directory);if(d.platformRef!==undefined)reject('INVALID_RESOURCE','Installation uses the registered destination');}else reject('INVALID_RESOURCE','Unsupported delivery mode');break;
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
export async function openRegisteredBindings(configPath:string,workspaceId:string):Promise<{provider:DefinitionBindingProvider;preparation:PreparationValidator;implementationReview:ImplementationReviewBindings;executor(store:RuntimeStore,services:StageServices):StageAdapter;close():void}>{
  slug(workspaceId);string(configPath,4096);
  let legacy:ReturnType<typeof createRuntimeService>|undefined,opening:Promise<void>|null=null,connectedDigest:string|null=null,closed=false;
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
      legacy=createRuntimeService({workspaceRoot,workspaceId});legacy.initialize();
      for(const registered of configuration.owners.filter(o=>o.owner==='ontology')){
        const{ref,...config}=registered;adapters.set(ref,await openPublishedOwner(config,toolchain));if(closed)reject('CLOSED','Integration composition is closed',503);
      }
      for(const registered of configuration.owners.filter(o=>o.owner==='harness')){
        const possible=configuration.owners.filter(o=>o.owner==='ontology'&&registered.projects.every(p=>o.projects.includes(p)));
        if(possible.length!==1)reject('OWNER_BINDING_AMBIGUOUS','Harness needs one exact scoped Ontology connection');
        const{ref,...config}=registered;
        adapters.set(ref,await openPublishedOwner(config,toolchain,adapters.get(possible[0].ref),async(actor,projectId,request)=>{
          authorize(actor,projectId,'read');if(!legacy)reject('OWNER_UNAVAILABLE','Runtime intent reader is unavailable');
          return await legacy.readiness({operation:'readiness.intent.read',scope:request.scope,input:{standardVersion:'v2',digest:request.digest}}) as ReadinessIntentRecord&{current:boolean};
        }));if(closed)reject('CLOSED','Integration composition is closed',503);
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
  // Owner outages block dependent admission, never service/history availability.
  return{provider,preparation:registeredPreparation(configPath,workspaceId),implementationReview:registeredImplementationReview(configPath,workspaceId,connections),executor(store,services){
    if(store.workspaceId!==workspaceId)reject('INTEGRATION_SCOPE','Stage executor must share the service workspace',403);
    let stages:ReturnType<typeof createImplementationStageAdapters>|undefined,scope:StageAdapter|undefined,plan:StageAdapter|undefined,release:StageAdapter|undefined;
    async function current(signal:AbortSignal,stageId:string):Promise<StageAdapter>{
      const config=await ensure(signal),toolchain=readRegisteredNativeToolchain(config);
      if(stageId==='scope'){scope??=createScopeStageAdapter(store,configPath,connections);return scope;}
      if(stageId==='plan'){plan??=createPlanStageAdapter(store,configPath,{...connections,toolchainLockDigest:toolchain.lockDigest,toolchainManifestDigest:config.nativeToolchain!.digest});return plan;}
      stages??=createImplementationStageAdapters(store,configPath,{...connections,toolchainLockDigest:toolchain.lockDigest,toolchainManifestDigest:config.nativeToolchain!.digest});
      if(stageId==='release-decision'){
        if(!services.authorityPolicy)reject('AUTHORITY_POLICY_UNAVAILABLE','Release admission requires the service authority policy',409);
        release??=createReleaseStageAdapter(store,configPath,{platform:connections.platform,verification:stages.ci},services.releaseAuthority,services.authorityPolicy);return release;
      }
      return stageId==='implementation'?stages.implementation:stages.ci;
    }
    return{
      async prepare(instance,stage,actor,signal){return(await current(signal,stage)).prepare(instance,stage,actor,signal);},
      async dispatch(request,instance,permit,signal){return(await current(signal,request.stageId)).dispatch(request,instance,permit,signal);},
      async inspect(request,instance,progress,actor,signal){return(await current(signal,request.stageId)).inspect(request,instance,progress,actor,signal);},
      async advance(request,instance,progress,permit,signal){return(await current(signal,request.stageId)).advance!(request,instance,progress,permit,signal);},
    };
  },close(){if(!closed){closed=true;disconnect();}}};
}
