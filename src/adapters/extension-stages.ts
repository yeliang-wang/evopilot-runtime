import {randomUUID} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {byteDigest} from '../lifecycle/base.js';
import {canonicalEvidence as canonical,evidenceValueDigest as valueDigest,record,reject,ServiceError,string} from '../server/errors.js';
import {authorize,privateFile,type Principal} from '../server/security.js';
import {RuntimeStore} from '../server/store.js';
import {loadPublisherBase} from '../lifecycle/base.js';
import {atPath,type EffectiveNode} from '../lifecycle/compiler.js';
import {inspectInstance,type LifecycleInstance} from '../lifecycle/instance.js';
import {readPreparationPacket} from '../lifecycle/preparation.js';
import type {StageAdapter,StageObservation,StageRequest} from '../lifecycle/execution.js';
import {readIntegrationConfiguration,configuredPlatform,type IntegrationConfiguration,type ResourceRegistration,type PlatformRegistration} from './config.js';
import {validateResourceDefinition} from './bindings.js';
import {registeredPreparation} from './preparation-stages.js';
import {nativeInventory,verifyNativeStageResult,type NativeStageConnections,type NativeAction,type OwnerPin,type VerifiedStageSource} from './stages.js';
import {ownerRequestDigest,type Owner,type OwnerRequest} from './published-owners.js';
import {validateCandidateInput,verifyCiArtifact,MAX_ARCHIVE_BYTES,type CandidateInput,type VerifiedCiArtifact} from './artifacts.js';
import type {PlatformRunRequest,PlatformArtifactArchive} from './platforms.js';
import {readImplementationEvidence} from './implementation-stages.js';
import type {SourceTreeObservation} from './source-tree.js';
import {nativeSha256,type NativeReference,type NativeValidationContext} from '../../vendor/compatibility/v1/native.mjs';

const ID='runtime-native-extension-stage-v1',ADAPTER_DIGEST=valueDigest({id:ID,actions:['runtime.check.ontology','runtime.check.harness','runtime.check.artifact'],input:'runtime-extension-observation/v1',recovery:'inspect-original-only'});
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const hash=(v:unknown)=>{const s=string(v,71);if(!/^sha256:[a-f0-9]{64}$/.test(s))reject('EXTENSION_EVIDENCE','Exact SHA256 evidence is required',409);return s;};
interface Prior {stageId:string;requestDigest:string;outcomeDigest:string;}
interface ArtifactCheckInput {schema:'runtime-extension-artifacts/v1';kind:'reviewed-documents'|'implementation-ci'|'candidate-ci';documents?:Record<string,unknown>;requestDigest?:string;artifact?:VerifiedCiArtifact;}
interface Parameters {
  node:EffectiveNode;kind:Owner;resources:ResourceRegistration[];resourceDigest:string;preparationRef:string;preparationDigest:string;preparationFactsDigest:string;
  predecessors:Prior[];binding:PlatformRegistration;source:VerifiedStageSource;sourceTree:SourceTreeObservation;
  candidateDigest:string|null;candidateInput:CandidateInput|null;artifactInput:ArtifactCheckInput|null;owner:OwnerPin;effectiveConfigDigest:string;
  toolchainLockDigest:string;toolchainManifestDigest:string|null;
}
function nodeFor(i:LifecycleInstance,id:string):EffectiveNode{
  const node=i.definition.nodes.find(n=>n.id===id),action=node?.action;
  const registered=loadPublisherBase().base.actions.find(a=>a.id===action?.actionRef);
  if(!node||node.source!=='project'||!action||!registered||action.actionVersion!==registered.version||action.actionDigest!==valueDigest(registered)||registered.type!==action.type||action.scopeRef!=='scope:'+i.pins.projectId)reject('EXTENSION_ACTION','Extension must retain its publisher action and exact project scope',409);
  return node;
}
function resource(c:Readonly<IntegrationConfiguration>,i:LifecycleInstance,ref:unknown,role:string):ResourceRegistration{
  const found=c.resources.find(r=>r.projectId===i.pins.projectId&&r.ref===ref&&r.role===role);
  if(!found||Date.parse(found.expiresAt)<=Date.now())reject('EXTENSION_RESOURCE','Current exact extension resource is required',409);validateResourceDefinition(found);return found;
}
function predecessors(store:RuntimeStore,i:LifecycleInstance,node:EffectiveNode):Prior[]{
  return node.dependsOn.map(stageId=>{
    const s=i.stages[stageId],raw=s?.requestId?store.object(i.pins.projectId,'stage-request',s.requestId):null,p=s?.requestId?store.object(i.pins.projectId,'stage-progress',s.requestId) as Record<string,unknown>|null:null;
    if(s?.status!=='PASSED'||!raw||!p||p.phase!=='COMPLETE'||p.terminal!==true)reject('EXTENSION_PREDECESSOR','Every required original predecessor must be complete',409);
    const r=raw as StageRequest,{digest,...body}=r,o=record(record(p.observation).outcome),required=i.definition.nodes.find(n=>n.id===stageId)!.checks;
    if(digest!==valueDigest(body)||r.planDigest!==valueDigest(r.plan)||r.stageId!==stageId||r.workspaceId!==store.workspaceId||r.projectId!==i.pins.projectId||r.instanceId!==i.id||r.pinsDigest!==i.pinsDigest||r.inputDigest!==s.inputDigest||o.requestId!==r.id||o.inputDigest!==r.inputDigest||o.status!=='COMPLETE'||valueDigest(o)!==s.outcomeDigest||!Array.isArray(o.checks)||!same(o.checks.map(c=>record(c).id).sort(),[...required].sort())||o.checks.some(c=>record(c).status!=='PASS'))reject('EXTENSION_PREDECESSOR','Predecessor request and fixed passing outcome differ',409);
    return{stageId,requestDigest:digest,outcomeDigest:hash(s.outcomeDigest)};
  }).sort((a,b)=>a.stageId.localeCompare(b.stageId));
}
function candidate(store:RuntimeStore,i:LifecycleInstance,node:EffectiveNode,binding:PlatformRegistration,commit:string):CandidateInput|null{
  if(['after-plan','before-candidate'].includes(node.stage)){if(i.candidate)reject('EXTENSION_CANDIDATE','Pre-candidate extension cannot replace an existing candidate',409);return null;}
  const s=i.stages.candidate,raw=s?.requestId?store.object(i.pins.projectId,'stage-candidate-source',s.requestId):null;
  if(s?.status!=='PASSED'||!raw||!i.candidate||!i.candidateDigest)reject('EXTENSION_CANDIDATE','Read-only candidate checks require the original completed candidate',409);
  const saved=record(raw),{digest,...body}=saved;
  if(digest!==valueDigest(body)||saved.requestId!==s.requestId||saved.pinsDigest!==i.pinsDigest||saved.outcomeDigest!==s.outcomeDigest)reject('EXTENSION_CANDIDATE','Candidate provenance differs from the completed original stage',409);
  return validateCandidateInput(saved.input as CandidateInput,{commit,candidateDigest:i.candidateDigest},binding.provider,binding.repositoryId);
}
function verifyTree(tree:SourceTreeObservation,binding:PlatformRegistration,commit:string){
  const{schema,factsDigest,observedAt,contentRead,linksFollowed,sourceApproved,...facts}=tree;
  if(schema!=='runtime-source-tree/v1'||factsDigest!==valueDigest(facts)||tree.bindingDigest!==valueDigest(binding)||tree.projectId!==binding.projectId||tree.provider!==binding.provider||tree.repositoryId!==binding.repositoryId||tree.commit!==commit||tree.inventoryDigest!==valueDigest(tree.entries)||tree.treeDigest!==valueDigest({schema:'runtime-git-tree-identity/v1',rootTreeId:tree.rootTreeId,inventoryDigest:tree.inventoryDigest})||contentRead!==false||linksFollowed!==false||sourceApproved!==false)reject('EXTENSION_SOURCE','Exact complete source inventory is required',409);
}
function mappedCriteria(pkg:Record<string,unknown>,kind:Owner,requirements:ResourceRegistration[]){
  const entry=record(record(pkg.manifest).entrypoints),path=string(kind==='ontology'?entry.cases:entry.coverage),text=record(pkg.files)[path];
  if(typeof text!=='string'||Buffer.byteLength(text)>2097152)reject('EXTENSION_MAPPING','Published native criterion inventory is required',409);
  let inventory:Record<string,unknown>;try{inventory=record(JSON.parse(text));}catch{return reject('EXTENSION_MAPPING','Published criterion inventory is invalid',409);}
  const rows=kind==='ontology'?inventory.cases:inventory.requirements;if(!Array.isArray(rows))reject('EXTENSION_MAPPING','Published criterion inventory is incomplete',409);
  for(const resource of requirements){const d=resource.definition;for(const variant of d.variantIds as string[]){
    const matches=rows.filter(raw=>{const row=record(raw),criteria=kind==='ontology'?row.requirementIds:row.ruleIds,variants=kind==='ontology'?[row.id]:row.caseIds;return Array.isArray(criteria)&&criteria.includes(d.criterionId)&&Array.isArray(variants)&&variants.includes(variant);});
    if(!matches.length)reject('EXTENSION_MAPPING','An extension requirement is absent from the published native criterion/variant pairs',409);
  }}
}
/** Historical original evidence read; it performs no validation, decision or
 * effect and never upgrades an old receipt to current execution authority. */
export function readExtensionEvidence(store:RuntimeStore,r:StageRequest){
  if(r.plan.adapterId!==ID)reject('STAGE_ADAPTER_UNAVAILABLE','This request is not a native extension check',409);
  const pointer=store.object(r.projectId,'extension-evidence-pointer',r.id) as {ref:string}|null,evidence=pointer?store.object(r.projectId,'extension-evidence',pointer.ref):null;
  if(pointer&&(!evidence||valueDigest(evidence)!==pointer.ref||record(evidence).requestDigest!==r.digest))reject('CORRUPT_EXTENSION','Retained extension evidence changed',503);
  const action=store.object(r.projectId,'extension-native-action',r.id) as NativeAction|null,receipt=evidence&&record(evidence).receiptTerminal===false?store.object(r.projectId,'extension-native-observation',string(record(evidence).receiptRef,71)):store.object(r.projectId,'extension-native-receipt',r.id),p=r.plan.parameters as unknown as Parameters;
  if(evidence){if(!action||!receipt)reject('CORRUPT_EXTENSION','Original extension action and receipt are required',503);const{digest,...body}=action,e=record(evidence);if(digest!==valueDigest(body)||action.requestDigest!==ownerRequestDigest(p.kind,action.request)||e.actionDigest!==digest||e.planDigest!==r.planDigest||e.receiptRef!==valueDigest(receipt)||!same(e.result,verifyNativeStageResult(record(receipt),p.kind,p.owner,action,p.toolchainLockDigest,p.effectiveConfigDigest)))reject('CORRUPT_EXTENSION','Original extension receipt or action differs from retained evidence',503);}
  return{request:r,evidenceRef:pointer?.ref??null,evidence,action,receipt,historical:true,executionAuthorized:false,releaseAuthorized:false,automaticRedispatch:false};
}
/** Executes fixed owner checks and the independently verified artifact check.
 * Review/CI preparation actions have distinct adapters; no executable is read
 * from project YAML and no owner result grants semantic or release authority. */
export function createNativeExtensionStageAdapter(store:RuntimeStore,configPath:string,connections:NativeStageConnections):StageAdapter{
  const preparation=registeredPreparation(configPath,store.workspaceId);
  function selected(i:LifecycleInstance,id:string,actor:Principal){
    inspectInstance(i);authorize(actor,i.pins.projectId,'read');const node=nodeFor(i,id),action=node.action!,kind:Owner=['runtime.check.harness','runtime.check.artifact'].includes(String(action.actionRef))?'harness':action.actionRef==='runtime.check.ontology'?'ontology':reject('STAGE_ADAPTER_UNAVAILABLE','Only native owner check actions use this adapter',409),c=readIntegrationConfiguration(configPath,store.workspaceId);
    const packet=readPreparationPacket(store,i.pins.projectId,i.pins.targetRef);
    if(packet.input.definitionRevisionId!==i.pins.definitionRevisionId||packet.semanticDigest!==i.pins.semanticDigest||packet.input.goalRef!==i.pins.goalRef||packet.input.loopRef!==i.pins.loopRef)reject('EXTENSION_PREPARATION','Extension must use the exact reviewed target',409);
    const facts=preparation(packet,i.definition,actor),requirements=(action.requirementRefs as string[]).map(ref=>resource(c,i,ref,'extension.requirement')),check=resource(c,i,record(action.parameters).checkRef,'extension.check'),mapping=resource(c,i,action.evidenceMappingRef,'extension.mapping'),global=resource(c,i,atPath(i.definition.semantic,'config.verification.evidenceMappingRef'),'config.verification.evidenceMappingRef');
    if(check.definition.owner!==kind||requirements.some(r=>r.definition.owner!==kind)||!requirements.some(r=>same(r.definition,check.definition)))reject('EXTENSION_MAPPING','The action check and required criteria must belong to its selected owner',409);
    const rows=(mapping.definition.rows as Record<string,unknown>[]).filter(r=>r.stage===id),globalRows=(global.definition.rows as Record<string,unknown>[]).filter(r=>r.stage===id);
    if(rows.length!==node.checks.length||!same(rows.map(r=>r.checkId).sort(),[...node.checks].sort())||!same([...rows].sort((a,b)=>String(a.checkId).localeCompare(String(b.checkId))),[...globalRows].sort((a,b)=>String(a.checkId).localeCompare(String(b.checkId)))))reject('EXTENSION_MAPPING','Local and global mappings must cover every exact required extension check',409);
    for(const requirement of requirements){const row=rows.find(r=>r.checkId===requirement.ref)!;if(row.owner!==kind||row.criterionId!==requirement.definition.criterionId||row.source!=='owner-receipt'||!same([...(row.variantIds as string[])].sort(),[...(requirement.definition.variantIds as string[])].sort()))reject('EXTENSION_MAPPING','Required criteria and actual native evidence must agree',409);}
    for(const owner of ['ontology','harness']){const asset=record(atPath(i.definition.semantic,'assets.'+owner)),ref=record(mapping.definition[owner]);if(ref.product!==owner||ref.id!==asset.id||ref.version!==asset.version||ref.digest!==asset.digest||!same(ref,global.definition[owner]))reject('EXTENSION_MAPPING','Extension mapping uses another selected asset',409);}
    const implementation=record(atPath(i.definition.semantic,'config.implementation')),matches=c.platforms.filter(p=>p.projectId===i.pins.projectId&&['provider','host','repository','repositoryId','defaultBranch','credentialRef'].every(k=>record(p)[k]===implementation[k]));if(matches.length!==1)reject('EXTENSION_SOURCE','One exact project source connection is required',409);
    const binding=configuredPlatform(c,actor,i.pins.projectId,matches[0]!.ref),asset=record(atPath(i.definition.semantic,'assets.'+kind)),assetMap=resource(c,i,asset.mappingRef,'assets.'+kind+'.mappingRef'),reference=assetMap.definition.reference as NativeReference;
    if(!same(reference,mapping.definition[kind])||reference.visibility!==asset.visibility)reject('EXTENSION_MAPPING','Owner asset reference differs from extension requirements',409);
    return{node,kind,c,packet,facts,binding,asset,reference,resources:[check,mapping,global,assetMap,...requirements],predecessors:predecessors(store,i,node)};
  }
  async function source(i:LifecycleInstance,node:EffectiveNode,actor:Principal,signal:AbortSignal):Promise<VerifiedStageSource>{
    if(node.stage==='after-plan'){const p=readPreparationPacket(store,i.pins.projectId,i.pins.targetRef);return{commit:p.input.source.commit,evidenceRef:i.pins.targetRef};}
    if(!connections.source)reject('EXTENSION_SOURCE','A verified implementation source resolver is required',409);return connections.source(i,node.id,actor,signal);
  }
  async function artifacts(i:LifecycleInstance,s:ReturnType<typeof selected>,resolved:VerifiedStageSource,input:CandidateInput|null,signal:AbortSignal):Promise<ArtifactCheckInput|null>{
    if(s.node.action!.actionRef!=='runtime.check.artifact')return null;
    if(s.node.stage==='after-plan')return{schema:'runtime-extension-artifacts/v1',kind:'reviewed-documents',documents:record(s.facts.evidence.documents)};
    const before=s.node.stage==='before-candidate',stage=i.stages[before?'implementation':'candidate'];
    if(stage.status!=='PASSED'||!stage.requestId)reject('EXTENSION_ARTIFACT','Original completed artifact producer is required',409);
    let r=store.object(i.pins.projectId,'stage-request',stage.requestId) as StageRequest|null;
    if(!r)reject('EXTENSION_ARTIFACT','Original artifact producer request is missing',409);
    if(before){const d=readImplementationEvidence(store,r).derivation;if(!d)reject('EXTENSION_ARTIFACT','Verified implementation CI derivation is missing',409);r=d.request;}
    const {digest,...body}=r,p=r.plan.parameters,binding=p.binding as PlatformRegistration;
    const expectedChecks=i.definition.nodes.find(n=>n.id===(before?'implementation':'candidate'))!.checks;
    if(digest!==valueDigest(body)||r.planDigest!==valueDigest(r.plan)||r.plan.bindingDigest!==valueDigest(p)||r.workspaceId!==store.workspaceId||r.projectId!==i.pins.projectId||r.instanceId!==i.id||r.pinsDigest!==i.pinsDigest||r.stageId!==(before?'implementation':'candidate')||p.commit!==resolved.commit||!same(binding,s.binding)||!same(p.expectedChecks,expectedChecks)||p.candidateDigest!==null)reject('EXTENSION_ARTIFACT','Original artifact source or complete producer check set differs',409);
    const verified=store.object(i.pins.projectId,'ci-stage-artifact',r.id) as VerifiedCiArtifact|null;
    if(!verified||verified.schema!=='runtime-ci-verified-artifact/v1'||verified.status!=='PASSED'||!verified.artifactsVerified)reject('EXTENSION_ARTIFACT','Original verified CI archive is required',409);
    const a=verified.sourceArchive;if(!a||a.archiveDigest!==verified.archiveDigest||!before&&(!input||!same(a,input.archive)||!same(verified.candidate,input.manifest)))reject('EXTENSION_ARTIFACT','Artifact must be the exact candidate archive',409);
    const path=join(store.root,'stage-ci-artifacts',hash(a.archiveDigest).slice(7)+'.zip');privateFile(path);const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:Buffer;
    try{const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size!==a.archiveBytes||stat.size>MAX_ARCHIVE_BYTES)reject('EXTENSION_ARTIFACT','Original archive size or file identity differs',409);bytes=readFileSync(fd);}finally{closeSync(fd);}
    signal.throwIfAborted();if(byteDigest(bytes)!==a.archiveDigest)reject('EXTENSION_ARTIFACT','Original archive bytes changed',409);
    const ci:PlatformRunRequest={schema:'runtime-ci-request/v1',requestId:'stage-'+valueDigest({workspaceId:r.workspaceId,projectId:r.projectId,requestId:r.id}).slice(7,55),projectId:r.projectId,bindingDigest:valueDigest(binding),commit:string(p.commit),workflowDigest:hash(p.workflowDigest),inputDigest:r.inputDigest,stageId:r.stageId,candidateDigest:null,requestedAt:r.requestedAt,deadlineAt:r.deadlineAt};
    const archive:PlatformArtifactArchive={...a,requestId:ci.requestId,inputDigest:ci.inputDigest,bindingDigest:ci.bindingDigest,commit:ci.commit,runStatus:'PASSED',name:'runtime-ci',bytes,evidenceRef:verified.evidenceRef};
    const observed=await verifyCiArtifact(archive,ci,expectedChecks,signal);if(!same(observed,verified))reject('EXTENSION_ARTIFACT','Retained producer result differs from independently reverified original bytes',409);
    return{schema:'runtime-extension-artifacts/v1',kind:before?'implementation-ci':'candidate-ci',requestDigest:r.digest,artifact:observed};
  }
  function owner(p:Parameters,c:Readonly<IntegrationConfiguration>,projectId:string){
    if(!c.owners.some(o=>o.ref===p.owner.ref&&o.owner===p.kind&&o.projects.includes(projectId)))reject('OWNER_BINDING_CHANGED','Extension owner registration changed',409);
    const a=connections.owner(p.owner.ref,c);if(a.owner!==p.kind||a.workspaceId!==store.workspaceId||record(a.capabilities()).registrationDigest!==p.owner.registrationDigest)reject('OWNER_BINDING_CHANGED','Extension owner identity changed',409);return a;
  }
  async function original(r:StageRequest,i:LifecycleInstance,actor:Principal,signal:AbortSignal){
    const s=selected(i,r.stageId,actor),p=r.plan.parameters as unknown as Parameters,{digest,...body}=r;
    if(r.workspaceId!==store.workspaceId||r.projectId!==i.pins.projectId||r.instanceId!==i.id||r.pinsDigest!==i.pinsDigest||r.plan.adapterId!==ID||r.plan.adapterDigest!==ADAPTER_DIGEST||r.plan.action!==s.node.action!.actionRef||digest!==valueDigest(body)||r.planDigest!==valueDigest(r.plan)||r.plan.bindingDigest!==valueDigest(p)||!same(p.node,s.node)||p.kind!==s.kind||p.resourceDigest!==valueDigest(s.resources)||!same(p.resources,s.resources)||p.preparationRef!==i.pins.targetRef||p.preparationDigest!==s.packet.digest||p.preparationFactsDigest!==valueDigest(s.facts)||!same(p.predecessors,s.predecessors)||!same(p.binding,s.binding)||p.candidateDigest!==i.candidateDigest||p.toolchainLockDigest!==connections.toolchainLockDigest||p.toolchainManifestDigest!==(connections.toolchainManifestDigest??null))reject('EXTENSION_PLAN_CHANGED','Extension differs from its original source, requirements, resources or toolchain',409);
    const current=await source(i,s.node,actor,signal);if(!same(current,p.source)||!same(p.candidateInput,candidate(store,i,s.node,s.binding,current.commit)))reject('EXTENSION_SOURCE_CHANGED','Original extension source or candidate changed',409);verifyTree(p.sourceTree,p.binding,current.commit);if(!same(p.artifactInput,await artifacts(i,s,current,p.candidateInput,signal)))reject('EXTENSION_ARTIFACT','Artifact verification differs from the original extension input',409);owner(p,s.c,r.projectId);signal.throwIfAborted();return{s,p};
  }
  function retain(actor:Principal,r:StageRequest,kind:string,id:string,value:unknown,replace=false){const old=store.object(r.projectId,kind,id);if(old&&same(old,value))return;if(old&&!replace)reject('EXTENSION_EVIDENCE_CHANGED','Original extension evidence cannot be replaced',409);store.mutate(actor,{projectId:r.projectId,operation:'lifecycle.extension.evidence',requestId:'extension-evidence-'+randomUUID(),expectedRevision:store.revision(r.projectId),input:{kind,id,digest:valueDigest(value)},permission:'read'},()=>({objects:[{kind,id,value}],value:{kind,id},event:{type:'extension-evidence-retained',data:{stageRequestId:r.id,kind,id}}}));}
  function action(r:StageRequest):NativeAction|null{const a=store.object(r.projectId,'extension-native-action',r.id) as NativeAction|null;if(a){const{digest,...body}=a;if(digest!==valueDigest(body)||a.requestDigest!==ownerRequestDigest((r.plan.parameters as unknown as Parameters).kind,a.request))reject('CORRUPT_EXTENSION','Original native action changed',503);}return a;}
  function observation(r:StageRequest,p:Parameters,phase:StageObservation['phase'],ref:string):StageObservation{return{requestId:r.id,inputDigest:r.inputDigest,adapterDigest:ADAPTER_DIGEST,phase,handle:{owner:p.kind,requestId:'extension-native-'+valueDigest({requestDigest:r.digest}).slice(7,51)},outcome:{requestId:r.id,inputDigest:r.inputDigest,receiptRef:'runtime:extension/'+r.id,status:phase==='COMPLETE'?'COMPLETE':phase==='FAILED'?'FAILED':phase==='UNKNOWN'?'UNKNOWN':'RUNNING',expiresAt:r.deadlineAt,checks:phase==='COMPLETE'||phase==='FAILED'?p.node.checks.map(id=>({id,status:phase==='COMPLETE'?'PASS':'FAIL',evidenceRef:ref})):[]}};}
  function payload(r:StageRequest,i:LifecycleInstance,p:Parameters,s:ReturnType<typeof selected>){
    const context:NativeValidationContext={workspaceId:store.workspaceId,scope:{visibility:'private',projectId:r.projectId},projectCandidateDigest:p.candidateDigest??p.preparationDigest,claimId:valueDigest({stageRequestDigest:r.digest}),inputDigest:r.inputDigest,effectiveConfigDigest:p.effectiveConfigDigest,sourceScopeDigest:p.sourceTree.treeDigest,requirementSetDigest:i.pins.requirementsDigest},input={schema:'runtime-extension-observation/v1',stageId:r.stageId,slot:p.node.stage,action:p.node.action,preparation:s.packet.input,predecessors:p.predecessors,source:p.source,sourceTree:p.sourceTree,candidate:p.candidateInput?.manifest??null,...(p.artifactInput?{artifacts:p.artifactInput}:{})};
    const observation={schema:'evopilot-observation/v1',origin:'execution-result',source:{revision:p.source.commit,digest:p.sourceTree.treeDigest},values:{runtimeExtension:input},collectionReceiptRef:{id:'extension:'+r.id,digest:valueDigest(input),claimId:context.claimId},sourceScopeDigest:context.sourceScopeDigest};
    return{context,observation,requestInput:{id:p.owner.reference.id,version:p.owner.reference.version,context,...(p.kind==='harness'?{observation}:{})}};
  }
  async function inspect(r:StageRequest,i:LifecycleInstance,_progress:unknown,actor:Principal,signal:AbortSignal):Promise<StageObservation>{
    const{s,p}=await original(r,i,actor,signal),a=action(r);if(!a)return observation(r,p,'UNKNOWN','runtime:extension/'+r.id);const expected=payload(r,i,p,s);if(a.request.operation!=='native.package.validate'||a.request.requestId!=='extension-native-'+valueDigest({requestDigest:r.digest}).slice(7,51)||!same(a.request.scope,p.owner.scope)||!same(a.request.input,expected.requestInput)||!same(a.context,expected.context)||a.observationDigest!==(p.kind==='harness'?nativeSha256(expected.observation):null))reject('CORRUPT_EXTENSION','Original native request differs from the fixed extension input',503);let receipt:Record<string,unknown>;
    try{receipt=record(await owner(p,s.c,r.projectId).read(actor,r.projectId,{operation:'native.receipt.inspect',scope:a.request.scope,input:{requestId:a.request.requestId}}));}catch(e){if(e instanceof ServiceError&&e.code==='NOT_FOUND')return observation(r,p,'UNKNOWN','runtime:extension/'+r.id);throw e;}
    const result=verifyNativeStageResult(receipt,p.kind,p.owner,a,p.toolchainLockDigest,p.effectiveConfigDigest);signal.throwIfAborted();const receiptRef=valueDigest(receipt),receiptTerminal=result.receiptDigest!==null;retain(actor,r,receiptTerminal?'extension-native-receipt':'extension-native-observation',receiptTerminal?r.id:receiptRef,receipt);
    const evidence={schema:'runtime-native-extension-evidence/v1',requestDigest:r.digest,planDigest:r.planDigest,candidateDigest:p.candidateDigest,source:p.source,actionDigest:a.digest,receiptRef,receiptTerminal,result,executionAuthorized:false,releaseAuthorized:false},ref=valueDigest(evidence);retain(actor,r,'extension-evidence',ref,evidence);retain(actor,r,'extension-evidence-pointer',r.id,{ref},true);
    return observation(r,p,result.status==='PASS'?'COMPLETE':result.status==='FAIL'?'FAILED':'UNKNOWN',ref);
  }
  async function execute(r:StageRequest,i:LifecycleInstance,permit:()=>Promise<Principal>,signal:AbortSignal):Promise<StageObservation>{
    let actor=await permit();const{s,p}=await original(r,i,actor,signal);if(action(r))return inspect(r,i,null,actor,signal);
    const expected=payload(r,i,p,s),context=expected.context,observed=expected.observation,a=owner(p,s.c,r.projectId),state=record(await a.read(actor,r.projectId,{operation:'workspace.inspect',scope:p.owner.scope,input:{}}));
    if(!Number.isSafeInteger(state.revision)||Number(state.revision)<0)reject('OWNER_REVISION_INVALID','Extension needs the current owner revision',409);
    const request:OwnerRequest={operation:'native.package.validate',scope:p.owner.scope,input:expected.requestInput,requestId:'extension-native-'+valueDigest({requestDigest:r.digest}).slice(7,51),expectedRevision:Number(state.revision)},body={request,requestDigest:ownerRequestDigest(p.kind,request),context,observationDigest:p.kind==='harness'?nativeSha256(observed):null};
    actor=await permit();authorize(actor,r.projectId,'execution.request');await original(r,i,actor,signal);if(actor.id!==r.initiatedBy.id||actor.revision!==r.initiatedBy.revision)reject('AUTHORITY_CHANGED','Extension requires the original current execution principal',409);signal.throwIfAborted();
    retain(actor,r,'extension-native-action',r.id,{...body,digest:valueDigest(body)});
    await a.mutate(actor,r.projectId,request,{projectId:r.projectId,owner:p.kind,requestDigest:body.requestDigest,authorityRef:r.authorityRef,expiresAt:r.deadlineAt});return inspect(r,i,null,actor,signal);
  }
  return{async prepare(i,id,actor,signal){
    const s=selected(i,id,actor),resolved=await source(i,s.node,actor,signal),tree=await connections.platform(s.binding).sourceTree(actor,{commit:resolved.commit},signal);verifyTree(tree,s.binding,resolved.commit);
    const a=connections.owner(string(s.asset.adapterRef),s.c),scope={visibility:s.reference.visibility,projectId:string(s.asset.projectId)};if(a.owner!==s.kind||a.workspaceId!==store.workspaceId)reject('OWNER_SCOPE','Extension owner scope differs',409);
    const material=await a.readPackage(actor,i.pins.projectId,scope,s.reference);mappedCriteria(record(material.package),s.kind,s.resources.filter(r=>r.role==='extension.requirement'));
    const pin:OwnerPin={ref:string(s.asset.adapterRef),registrationDigest:hash(record(a.capabilities()).registrationDigest),scope,reference:s.reference,criteria:nativeInventory(record(material.package),s.kind)};let effectiveConfigDigest=hash(s.reference.digest);
    if(s.kind==='harness'){const report=record(material.validation),{reportDigest,...body}=report;if(reportDigest!==nativeSha256(body)||!same(report.reference,s.reference)||report.qualityStatus!=='PASS')reject('OWNER_BASELINE_INVALID','Published Harness baseline is required',409);effectiveConfigDigest=hash(report.effectiveConfigDigest);}
    const candidateInput=candidate(store,i,s.node,s.binding,resolved.commit),artifactInput=await artifacts(i,s,resolved,candidateInput,signal);
    const p:Parameters={node:s.node,kind:s.kind,resources:s.resources,resourceDigest:valueDigest(s.resources),preparationRef:i.pins.targetRef,preparationDigest:s.packet.digest,preparationFactsDigest:valueDigest(s.facts),predecessors:s.predecessors,binding:s.binding,source:resolved,sourceTree:tree,candidateDigest:i.candidateDigest,candidateInput,artifactInput,owner:pin,effectiveConfigDigest,toolchainLockDigest:connections.toolchainLockDigest,toolchainManifestDigest:connections.toolchainManifestDigest??null};signal.throwIfAborted();
    return{adapterId:ID,adapterDigest:ADAPTER_DIGEST,action:String(s.node.action!.actionRef),bindingDigest:valueDigest(p),parameters:p as unknown as Record<string,unknown>};
  },inspect,dispatch:execute,advance:async(r,i,_progress,permit,signal)=>execute(r,i,permit,signal)};
}

// Shared fixed context verifiers; exported only for publisher-owned adapters.
export {nodeFor as extensionNode,resource as extensionResource,predecessors as extensionPredecessors,candidate as extensionCandidate,verifyTree as verifyExtensionSourceTree,mappedCriteria as mappedExtensionCriteria};
