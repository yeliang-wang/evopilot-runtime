import {canonicalEvidence as canonical,evidenceValueDigest as valueDigest,exact,record,reject,string} from '../server/errors.js';
import {atPath} from '../lifecycle/compiler.js';
import {readPreparationPacket} from '../lifecycle/preparation.js';
import type {LifecycleInstance} from '../lifecycle/instance.js';
import type {StageRequest} from '../lifecycle/execution.js';
import type {RuntimeStore} from '../server/store.js';
import type {EffectiveNode} from '../lifecycle/compiler.js';
import type {Principal} from '../server/security.js';
import type {PlatformClient,PlatformRunRequest} from './platforms.js';
import type {PlatformRegistration,IntegrationConfiguration} from './config.js';
import type {SourceRequest,SourceObservation,SourceOutput} from './source.js';
import type {SourceTreeObservation} from './source-tree.js';
import type {VerifiedStageSource} from './stages.js';
import {verifyNativeStageResult,type NativeAction,type OwnerPin} from './stages.js';
import {extensionNode,extensionResource,extensionPredecessors} from './extension-stages.js';
import type {VerifiedCiArtifact} from './artifacts.js';
import {nativeSha256} from '../../vendor/compatibility/v1/native.mjs';
import {ownerRequestDigest,type Owner} from './published-owners.js';

export const CI_PREPARATION_ADAPTER_ID='runtime-ci-preparation-stage-v1';
export const CI_PREPARATION_ADAPTER_DIGEST=valueDigest({id:CI_PREPARATION_ADAPTER_ID,action:'runtime.operation.ci-prepare',source:'exact-parent-dag/v1',owners:'native/v1',output:'runtime-ci-preparation-output/v1'});

export interface CiPreparationInput {
  schema:'runtime-ci-preparation-input/v1';baselineCommit:string;parentCommit:string;
  change:SourceRequest['change'];requirementsDigest:string;
}
export interface CiPreparationOutput {
  schema:'runtime-ci-preparation-output/v1';inputDigest:string;
  source:{commit:string;change:SourceRequest['change'];artifacts:SourceOutput[]};
}
export interface PreparedSourceObservation {
  schema:'runtime-prepared-source-observation/v1';inputDigest:string;outputDigest:string;
  source:Omit<SourceObservation,'observedAt'>;sourceTree:Omit<SourceTreeObservation,'observedAt'>;
  sourceReviewApproved:false;releaseAuthorized:false;
}
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function commit(v:unknown):string{const s=string(v,40);if(!/^[a-f0-9]{40}$/.test(s))reject('CI_PREPARATION_SOURCE','Exact source commit is required',409);return s;}
function digest(v:unknown):string{const s=string(v,71);if(!/^sha256:[a-f0-9]{64}$/.test(s))reject('CI_PREPARATION_SOURCE','Exact SHA256 is required',409);return s;}
function change(v:unknown,provider:string){const c=record(v);exact(c,['kind','id']);if(c.kind!==(provider==='github'?'pull-request':'merge-request')||!['github','gitlab'].includes(provider)||! /^[1-9][0-9]{0,19}$/.test(string(c.id,20)))reject('CI_PREPARATION_SOURCE','Same-provider project change identity is required',409);}
export function validatePreparationInput(value:CiPreparationInput,request:Pick<PlatformRunRequest,'stageId'|'candidateDigest'|'commit'>,provider:string):CiPreparationInput{
  const v=record(value);exact(v,['schema','baselineCommit','parentCommit','change','requirementsDigest']);
  if(v.schema!=='runtime-ci-preparation-input/v1'||!/^project\.[a-z][a-z0-9-]{0,62}$/.test(request.stageId)||request.candidateDigest!==null||commit(v.parentCommit)!==request.commit||commit(v.baselineCommit)===v.parentCommit)reject('CI_PREPARATION_INPUT','Preparation needs a project operation before candidate creation and its exact implementation source',409);
  change(v.change,provider);digest(v.requirementsDigest);return value;
}
export function validatePreparationOutput(value:CiPreparationOutput,input:CiPreparationInput,provider:string):CiPreparationOutput{
  const v=record(value);exact(v,['schema','inputDigest','source']);const s=record(v.source);exact(s,['commit','change','artifacts']);
  if(v.schema!=='runtime-ci-preparation-output/v1'||digest(v.inputDigest)!==valueDigest(input)||commit(s.commit)===input.baselineCommit)reject('CI_PREPARATION_OUTPUT','Preparation output must bind its exact input and retain the implemented change',409);
  change(s.change,provider);if(!Array.isArray(s.artifacts)||!s.artifacts.length||s.artifacts.length>128)reject('CI_PREPARATION_OUTPUT','A bounded exact prepared source output inventory is required',409);
  const paths=new Set<string>();let total=0;
  for(const raw of s.artifacts){const a=record(raw);exact(a,['path','digest','bytes']);const p=string(a.path,1024);if(p.startsWith('/')||p.includes('\\')||/[\u0000-\u001f\u007f]/.test(p)||p.split('/').some(x=>!x||x==='.'||x==='..'||x==='.git')||paths.has(p))reject('CI_PREPARATION_OUTPUT','Prepared source paths must be unique canonical repository files',409);paths.add(p);digest(a.digest);
    if(!Number.isSafeInteger(a.bytes)||Number(a.bytes)<0||Number(a.bytes)>1048576||(total+=Number(a.bytes))>67108864)reject('CI_PREPARATION_OUTPUT','Prepared source bytes exceed the bounded verification profile',409);
  }
  return value;
}
/** Read-only provider observations bind actual commit ancestry, complete change
 * inventory, declared file bytes and full source tree. CI JSON alone is not a
 * trusted source proof or a human review decision. */
export async function observePreparedSource(client:Pick<PlatformClient,'source'|'sourceTree'>,binding:PlatformRegistration,actor:Principal,input:CiPreparationInput,output:CiPreparationOutput,signal:AbortSignal):Promise<PreparedSourceObservation>{
  validatePreparationInput(input,{stageId:'project.prepare',candidateDigest:null,commit:input.parentCommit},binding.provider);validatePreparationOutput(output,input,binding.provider);signal.throwIfAborted();
  const requested:SourceRequest={baselineCommit:input.baselineCommit,parentCommit:input.parentCommit,...output.source};
  const observation=await client.source(actor,requested,signal),{schema,observedAt,evidenceRef,factsDigest,sourceReviewApproved,ciVerified,releaseAuthorized,...facts}=observation;
  if(schema!=='runtime-source-observation/v1'||factsDigest!==valueDigest(facts)||facts.provider!==binding.provider||facts.projectId!==binding.projectId||facts.repositoryId!==binding.repositoryId||facts.bindingDigest!==valueDigest(binding)||facts.baselineCommit!==input.baselineCommit||facts.parentCommit!==input.parentCommit||facts.commit!==output.source.commit||!same(facts.change,output.source.change)||!same(facts.artifacts,output.source.artifacts)||facts.state!=='OPEN'||sourceReviewApproved!==false||ciVerified!==false||releaseAuthorized!==false)reject('CI_PREPARATION_SOURCE','Exact open prepared source observation is required',409);
  const tree=await client.sourceTree(actor,{commit:output.source.commit},signal),{schema:treeSchema,factsDigest:treeFacts,observedAt:treeTime,contentRead,linksFollowed,sourceApproved,...treeBody}=tree;
  if(treeSchema!=='runtime-source-tree/v1'||treeFacts!==valueDigest(treeBody)||tree.bindingDigest!==valueDigest(binding)||tree.projectId!==binding.projectId||tree.provider!==binding.provider||tree.repositoryId!==binding.repositoryId||tree.commit!==output.source.commit||tree.inventoryDigest!==valueDigest(tree.entries)||tree.treeDigest!==valueDigest({schema:'runtime-git-tree-identity/v1',rootTreeId:tree.rootTreeId,inventoryDigest:tree.inventoryDigest})||contentRead!==false||linksFollowed!==false||sourceApproved!==false||output.source.artifacts.some(a=>!tree.entries.some(e=>e.path===a.path&&e.type==='blob'&&['100644','100755'].includes(e.mode))))reject('CI_PREPARATION_SOURCE','Complete prepared source tree is required',409);
  signal.throwIfAborted();const{observedAt:unusedSourceTime,...source}=observation,{observedAt:unusedTreeTime,...sourceTree}=tree;
  return{schema:'runtime-prepared-source-observation/v1',inputDigest:valueDigest(input),outputDigest:valueDigest(output),source,sourceTree,sourceReviewApproved:false,releaseAuthorized:false};
}

export interface PreparationSourceProof {stageId:string;input:VerifiedStageSource;output:VerifiedStageSource;}

/** Current typed resources, protected publisher action and exact required rows.
 * This is independent of successful CI, owner results or execution authority. */
export function preparationConfiguration(store:RuntimeStore,config:Readonly<IntegrationConfiguration>,instance:LifecycleInstance,id:string){
  const node=extensionNode(instance,id);
  if(node.action!.actionRef!=='runtime.operation.ci-prepare'||node.stage!=='before-candidate'||instance.candidate)reject('CI_PREPARATION_ACTION','Registered CI preparation is allowed only before candidate creation',409);
  const resource=(ref:unknown,role:string)=>extensionResource(config,instance,ref,role),workflow=resource(record(node.action!.parameters).workflowRef,'extension.workflow'),requirements=(node.action!.requirementRefs as string[]).map(ref=>resource(ref,'extension.requirement')),mapping=resource(node.action!.evidenceMappingRef,'extension.mapping'),global=resource(atPath(instance.definition.semantic,'config.verification.evidenceMappingRef'),'config.verification.evidenceMappingRef');
  if(workflow.definition.purpose!=='prepare'||workflow.definition.outputContract!=='runtime-ci/v1')reject('CI_PREPARATION_WORKFLOW','Preparation requires the exact registered preparation workflow',409);
  const rows=(mapping.definition.rows as Record<string,unknown>[]).filter(r=>r.stage===id),globalRows=(global.definition.rows as Record<string,unknown>[]).filter(r=>r.stage===id),sorted=(v:Record<string,unknown>[])=>[...v].sort((a,b)=>String(a.checkId).localeCompare(String(b.checkId)));
  if(rows.length!==node.checks.length||!same(rows.map(r=>r.checkId).sort(),[...node.checks].sort())||!same(sorted(rows),sorted(globalRows)))reject('CI_PREPARATION_MAPPING','Local and global mappings must include every required preparation check',409);
  for(const required of requirements){const row=rows.find(r=>r.checkId===required.ref)!;if(row.source!=='ci-artifact'||row.owner!==required.definition.owner||row.criterionId!==required.definition.criterionId||!same([...(row.variantIds as string[])].sort(),[...(required.definition.variantIds as string[])].sort()))reject('CI_PREPARATION_MAPPING','Preparation checks must map to exact CI evidence and published owner criteria',409);}
  for(const kind of ['ontology','harness'] as const){const asset=record(atPath(instance.definition.semantic,'assets.'+kind)),mapped=resource(asset.mappingRef,'assets.'+kind+'.mappingRef');if(!same(mapped.definition.reference,mapping.definition[kind])||!same(mapped.definition.reference,global.definition[kind]))reject('CI_PREPARATION_MAPPING','Preparation must bind both exact published project assets',409);}
  const packet=readPreparationPacket(store,instance.pins.projectId,instance.pins.targetRef);
  if(packet.input.definitionRevisionId!==instance.pins.definitionRevisionId||packet.semanticDigest!==instance.pins.semanticDigest||packet.input.goalRef!==instance.pins.goalRef||packet.input.loopRef!==instance.pins.loopRef)reject('CI_PREPARATION_SCOPE','Preparation must retain its original target and definition',409);
  return{node,workflow,requirements,resources:[workflow,mapping,global,...requirements],predecessors:extensionPredecessors(store,instance,node),preparationRef:instance.pins.targetRef,preparationDigest:packet.digest,baselineCommit:packet.input.source.commit};
}

/** Native receipts must evaluate this preparation's resulting source, not a
 * self-consistent report for another input or the pre-preparation source. */
export function verifyPreparationNativeAction(r:StageRequest,kind:Owner,action:NativeAction,prepared:PreparedSourceObservation,artifact:VerifiedCiArtifact):void{
  const p=r.plan.parameters,preparation=record(p.preparation),input=record(preparation.input),binding=record(p.binding),pin=record(record(p.owners)[kind]),reference=record(pin.reference),tree=prepared.sourceTree;
  const sourceScope={direction:'reverse',locator:binding.host+'/'+binding.repository,revision:prepared.source.commit,treeDigest:tree.treeDigest,inventoryDigest:tree.inventoryDigest,requirementsDigest:input.requirementsDigest};
  const context={workspaceId:r.workspaceId,scope:{visibility:'private',projectId:r.projectId},projectCandidateDigest:r.pinsDigest,claimId:valueDigest({stageRequestDigest:r.digest}),inputDigest:r.inputDigest,effectiveConfigDigest:p.effectiveConfigDigest,sourceScopeDigest:nativeSha256(sourceScope),requirementSetDigest:input.requirementsDigest};
  const {digest,...body}=action,request=action.request;
  if(digest!==valueDigest(body)||action.requestDigest!==ownerRequestDigest(kind,request)||request.operation!=='native.package.validate'||request.requestId!=='stage-native-'+valueDigest({requestId:r.id,projectId:r.projectId,owner:kind}).slice(7,55)||!same(request.scope,pin.scope)||request.input.id!==reference.id||request.input.version!==reference.version||!same(request.input.context,context)||!same(action.context,context))reject('CORRUPT_CI_PREPARATION','Native action must bind the original preparation and resulting source',503);
  if(kind==='harness'){
    const observation=record(request.input.observation),values=record(observation.values);
    if(observation.schema!=='evopilot-observation/v1'||observation.origin!=='execution-result'||!same(observation.source,{revision:prepared.source.commit,digest:tree.treeDigest})||observation.sourceScopeDigest!==context.sourceScopeDigest||!same(observation.collectionReceiptRef,{id:'ci-stage:'+r.id,digest:artifact.resultDigest,claimId:context.claimId})||!same(values.runtimePreparation,{input:preparation.input,output:artifact.preparationOutput,verifiedSource:prepared,configuration:preparation.configuration})||action.observationDigest!==nativeSha256(observation))reject('CORRUPT_CI_PREPARATION','Native observation must retain the exact independently verified preparation facts',503);
  }else if(action.observationDigest!==null||Object.hasOwn(request.input,'observation'))reject('CORRUPT_CI_PREPARATION','Ontology validation cannot substitute a Harness observation',503);
}

export function readCiPreparationEvidence(store:RuntimeStore,r:StageRequest){
  const {digest:requestDigest,...requestBody}=r,p=r.plan.parameters,original=store.object(r.projectId,'stage-request',r.id);
  if(!original||!same(original,r)||r.schema!=='runtime-stage-request/v1'||r.workspaceId!==store.workspaceId||requestDigest!==valueDigest(requestBody)||r.planDigest!==valueDigest(r.plan)||r.plan.bindingDigest!==valueDigest(p)||r.plan.adapterId!==CI_PREPARATION_ADAPTER_ID||r.plan.adapterDigest!==CI_PREPARATION_ADAPTER_DIGEST||r.plan.action!=='runtime.operation.ci-prepare')reject('CORRUPT_CI_PREPARATION','Original immutable preparation request is required',503);
  const prepared=store.object(r.projectId,'ci-preparation-observation',r.id),artifact=store.object(r.projectId,'ci-stage-artifact',r.id) as VerifiedCiArtifact|null,proof=store.object(r.projectId,'ci-preparation-source',r.id);
  if(prepared){const v=record(prepared),{digest,...body}=v,observation=record(v.observation);if(digest!==valueDigest(body)||v.requestDigest!==r.digest||!artifact||v.artifactDigest!==valueDigest(artifact)||observation.inputDigest!==valueDigest(record(p.preparation).input)||observation.outputDigest!==valueDigest(artifact.preparationOutput)||record(observation.source).commit!==artifact.preparationOutput?.source.commit||record(observation.source).parentCommit!==p.commit)reject('CORRUPT_CI_PREPARATION','Original preparation observation or artifact changed',503);}
  const owners=Object.fromEntries((['ontology','harness'] as const).map(kind=>{const action=store.object(r.projectId,'stage-native-action',r.id+':'+kind) as NativeAction|null,receipt=store.object(r.projectId,'stage-native-receipt',r.id+':'+kind);let result=null;if(action){if(!prepared||!artifact)reject('CORRUPT_CI_PREPARATION','Native preparation action requires its original source and CI artifact',503);verifyPreparationNativeAction(r,kind,action,record(prepared).observation as unknown as PreparedSourceObservation,artifact);if(receipt)result=verifyNativeStageResult(record(receipt),kind,record(p.owners)[kind] as OwnerPin,action,String(p.toolchainLockDigest),String(p.effectiveConfigDigest));}else if(receipt)reject('CORRUPT_CI_PREPARATION','Native receipt is missing its original action',503);return[kind,{action,receipt,result}];}));
  if(proof){const v=record(proof),{digest,...body}=v;if(digest!==valueDigest(body)||v.schema!=='runtime-prepared-source/v1'||v.requestDigest!==r.digest||v.pinsDigest!==r.pinsDigest||!prepared||v.observationDigest!==record(prepared).digest||!same(v.input,p.source)||record(v.output).commit!==record(record(record(prepared).observation).source).commit||record(v.output).evidenceRef!==record(prepared).digest)reject('CORRUPT_CI_PREPARATION','Original completed preparation source proof changed',503);}
  return{request:r,run:store.object(r.projectId,'ci-stage-run',r.id),runObservation:store.object(r.projectId,'ci-stage-observation',r.id),artifact,prepared,proof,owners,historical:true,executionAuthorized:false,releaseAuthorized:false};
}

/** A retained source is usable only after the exact complete original stage,
 * archive and both native owners pass. Missing records never become a fallback
 * to the old implementation source. */
export function completedPreparationSource(store:RuntimeStore,instance:LifecycleInstance,id:string):PreparationSourceProof{
  const stage=instance.stages[id],r=stage?.requestId?store.object(instance.pins.projectId,'stage-request',stage.requestId) as StageRequest|null:null;
  if(stage?.status!=='PASSED'||!r||r.instanceId!==instance.id||r.pinsDigest!==instance.pinsDigest||r.inputDigest!==stage.inputDigest)reject('CI_PREPARATION_INCOMPLETE','Every required original preparation must be complete',409);
  const view=readCiPreparationEvidence(store,r),progress=record(store.object(r.projectId,'stage-progress',r.id)),outcome=record(record(progress.observation).outcome),proof=record(view.proof),required=instance.definition.nodes.find(n=>n.id===id)!.checks;
  if(progress.phase!=='COMPLETE'||progress.terminal!==true||outcome.requestId!==r.id||outcome.inputDigest!==r.inputDigest||outcome.status!=='COMPLETE'||valueDigest(outcome)!==stage.outcomeDigest||proof.outcomeDigest!==stage.outcomeDigest||!Array.isArray(outcome.checks)||!same(outcome.checks.map(c=>record(c).id).sort(),[...required].sort())||outcome.checks.some(c=>record(c).status!=='PASS'||record(c).evidenceRef!==proof.evidenceRef)||view.artifact?.status!=='PASSED'||Object.values(view.owners).some(o=>o.result?.status!=='PASS'))reject('CI_PREPARATION_INCOMPLETE','Prepared source needs its complete fixed CI and native outcomes',409);
  const expectedCiId='stage-'+valueDigest({workspaceId:r.workspaceId,projectId:r.projectId,requestId:r.id}).slice(7,55),run=record(view.run),observed=record(view.runObservation),binding=record(r.plan.parameters.binding);
  if(view.artifact.requestId!==expectedCiId||view.artifact.inputDigest!==r.inputDigest||run.requestId!==expectedCiId||run.runId!==view.artifact.runId||observed.requestId!==expectedCiId||observed.runId!==run.runId||observed.status!=='PASSED'||observed.commit!==r.plan.parameters.commit||view.artifact.sourceArchive.provider!==binding.provider||view.artifact.sourceArchive.repositoryId!==binding.repositoryId)reject('CORRUPT_CI_PREPARATION','Original provider run and artifact identity are required',503);
  const evidence=store.object(r.projectId,'ci-stage-evidence',String(proof.evidenceRef));if(!evidence||valueDigest(evidence)!==proof.evidenceRef||record(evidence).requestId!==r.id||record(evidence).preparationRef!==record(view.prepared).digest||!same(record(evidence).ci,view.artifact)||!same(record(evidence).owners,Object.values(view.owners).map(o=>o.result)))reject('CORRUPT_CI_PREPARATION','Completed preparation evidence differs from the original outcome',503);
  return{stageId:id,input:proof.input as unknown as VerifiedStageSource,output:proof.output as unknown as VerifiedStageSource};
}
/** Exact preparation ancestors, used to retain every consumed archive. */
export function preparationAncestorIds(nodes:readonly EffectiveNode[],consumerId:string):string[]{
  const byId=new Map(nodes.map(n=>[n.id,n])),active=new Set<string>(),seen=new Set<string>(),result=new Set<string>();
  if(byId.size!==nodes.length)reject('CI_PREPARATION_LINEAGE','Duplicate lifecycle nodes',409);
  function visit(id:string){if(active.has(id)||!byId.has(id))reject('CI_PREPARATION_LINEAGE','Invalid original dependency graph',409);if(seen.has(id))return;active.add(id);for(const parent of byId.get(id)!.dependsOn){visit(parent);const n=byId.get(parent)!;if(n.action?.actionRef==='runtime.operation.ci-prepare'){if(n.source!=='project'||n.stage!=='before-candidate')reject('CI_PREPARATION_LINEAGE','Preparation operation is outside its allowed slot',409);result.add(parent);}}active.delete(id);seen.add(id);}
  visit(consumerId);return [...result].sort();
}

/** The reader must verify retained completed requests and original evidence.
 * This reducer only selects their deterministic DAG lineage. It never reads a
 * sibling operation merely because it happened to complete first. */
export function resolvePreparationLineage(nodes:readonly EffectiveNode[],consumerId:string,initial:VerifiedStageSource,read:(stageId:string)=>PreparationSourceProof):VerifiedStageSource{
  commit(initial.commit);string(initial.evidenceRef,256);const byId=new Map(nodes.map(n=>[n.id,n]));
  if(byId.size!==nodes.length||!byId.has(consumerId))reject('CI_PREPARATION_LINEAGE','Exact unique lifecycle nodes are required',409);
  const cache=new Map<string,Set<string>>(),visiting=new Set<string>();
  function ancestors(id:string):Set<string>{
    const prior=cache.get(id);if(prior)return prior;const node=byId.get(id);if(!node||visiting.has(id))reject('CI_PREPARATION_LINEAGE','Preparation dependencies must retain an acyclic complete graph',409);
    visiting.add(id);const found=new Set<string>();
    for(const parent of node.dependsOn){for(const ancestor of ancestors(parent))found.add(ancestor);const p=byId.get(parent)!;if(p.action?.actionRef==='runtime.operation.ci-prepare'){if(p.source!=='project'||p.stage!=='before-candidate')reject('CI_PREPARATION_LINEAGE','Only publisher-approved preparation slots may change source',409);found.add(parent);}}
    visiting.delete(id);cache.set(id,found);return found;
  }
  const proofs=new Map<string,PreparationSourceProof>(),resolved=new Map<string,VerifiedStageSource>();
  function before(id:string):VerifiedStageSource{
    const prior=resolved.get(id);if(prior)return prior;const all=ancestors(id),frontier=new Set(all);
    for(const operation of all)for(const earlier of ancestors(operation))frontier.delete(earlier);
    const sources=[...frontier].sort().map(stageId=>{
      let proof=proofs.get(stageId);if(!proof){proof=read(stageId);proofs.set(stageId,proof);}
      if(proof.stageId!==stageId||!same(proof.input,before(stageId)))reject('CI_PREPARATION_LINEAGE','Prepared output must extend its exact predecessor evidence',409);
      commit(proof.output.commit);string(proof.output.evidenceRef,256);return{stageId,source:proof.output};
    });
    if(new Set(sources.map(s=>s.source.commit)).size>1)reject('CI_PREPARATION_CONFLICT','Required preparation branches produced different commits; an explicit governed merge is needed',409);
    const result=!sources.length?initial:sources.length===1?sources[0]!.source:{commit:sources[0]!.source.commit,evidenceRef:valueDigest({schema:'runtime-preparation-join/v1',sources})};resolved.set(id,result);return result;
  }
  return before(consumerId);
}
