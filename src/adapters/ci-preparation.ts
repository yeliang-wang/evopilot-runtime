import {canonical,exact,record,reject,string} from '../server/errors.js';
import {valueDigest} from '../lifecycle/base.js';
import type {EffectiveNode} from '../lifecycle/compiler.js';
import type {Principal} from '../server/security.js';
import type {PlatformClient,PlatformRunRequest} from './platforms.js';
import type {PlatformRegistration} from './config.js';
import type {SourceRequest,SourceObservation,SourceOutput} from './source.js';
import type {SourceTreeObservation} from './source-tree.js';
import type {VerifiedStageSource} from './stages.js';

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
