import test from 'node:test';
import assert from 'node:assert/strict';
import {valueDigest,byteDigest} from '../../dist/lifecycle/base.js';
import {validatePreparationInput,validatePreparationOutput,observePreparedSource,resolvePreparationLineage} from '../../dist/adapters/ci-preparation.js';
import {ciInputs,validateRunRequest} from '../../dist/adapters/platforms.js';
import {syntheticSourceTree} from '../fixtures/lifecycle-v090.mjs';
const baseline='a'.repeat(40),parent='b'.repeat(40),prepared='c'.repeat(40),h=byteDigest('fixed'),who={id:'reader',projects:['alpha'],permissions:['read'],revision:1,expiresAt:'2030-01-01T00:00:00Z'};
function fixture(provider='github'){
 const binding={ref:'binding:alpha/prepare',workspaceId:'test',projectId:'alpha',provider,host:provider==='github'?'https://github.com':'https://gitlab.example.test',repository:'synthetic/project',repositoryId:'42',defaultBranch:'main',credentialRef:'credential:alpha/platform',revision:1,expiresAt:'2030-01-01T00:00:00Z',...(provider==='github'?{workflowPath:'.github/workflows/prepare.yml',runner:'ubuntu-latest'}:{pipelinePath:'.gitlab-ci.yml',runner:'56'})};
 const input={schema:'runtime-ci-preparation-input/v1',baselineCommit:baseline,parentCommit:parent,change:{kind:provider==='github'?'pull-request':'merge-request',id:'1'},requirementsDigest:h},output={schema:'runtime-ci-preparation-output/v1',inputDigest:valueDigest(input),source:{commit:prepared,change:input.change,artifacts:[{path:'generated/output.ts',bytes:4,digest:byteDigest('test')}]}};
 const request={schema:'runtime-ci-request/v1',requestId:'prepare-fixture',projectId:'alpha',bindingDigest:valueDigest(binding),commit:parent,workflowDigest:h,inputDigest:h,stageId:'project.prepare',candidateDigest:null,requestedAt:new Date().toISOString(),deadlineAt:new Date(Date.now()+60000).toISOString(),preparationInput:input};
 const facts={provider,projectId:'alpha',repositoryId:'42',bindingDigest:valueDigest(binding),baselineCommit:baseline,parentCommit:parent,...output.source,state:'OPEN',draft:true,sourceBranch:'prepared',targetBranch:'main',changes:[{path:'generated/output.ts',previousPath:null,status:'added'}]},source={schema:'runtime-source-observation/v1',...facts,evidenceRef:'synthetic:change/1',observedAt:new Date().toISOString(),factsDigest:valueDigest(facts),sourceReviewApproved:false,ciVerified:false,releaseAuthorized:false},tree=syntheticSourceTree(binding,prepared),calls=[];
 tree.entries=[{path:'generated/output.ts',type:'blob',mode:'100644',objectId:'d'.repeat(40)}];tree.inventoryDigest=valueDigest(tree.entries);tree.treeDigest=valueDigest({schema:'runtime-git-tree-identity/v1',rootTreeId:tree.rootTreeId,inventoryDigest:tree.inventoryDigest});const{schema,observedAt,factsDigest,contentRead,linksFollowed,sourceApproved,...treeFacts}=tree;tree.factsDigest=valueDigest(treeFacts);
 return{binding,input,output,request,source,tree,calls,client:{async source(actor,v,signal){assert.equal(actor,who);assert.equal(signal.aborted,false);calls.push(v);return source;},async sourceTree(actor,v){assert.equal(actor,who);assert.deepEqual(v,{commit:prepared});return tree;}}};
}
for(const provider of ['github','gitlab']){
 test(provider+' typed preparation carries its exact source input without release or candidate authority',()=>{
  const f=fixture(provider);assert.equal(validateRunRequest(f.request,f.binding).preparationInput,f.input);assert.deepEqual(JSON.parse(ciInputs(f.request).runtime_preparation_input),f.input);assert.equal(validatePreparationOutput(f.output,f.input,provider),f.output);
  for(const mutate of [r=>r.stageId='candidate',r=>r.candidateDigest=h,r=>r.preparationInput.parentCommit=prepared,r=>r.preparationInput.baselineCommit=parent,r=>r.preparationInput.command='echo forbidden',r=>r.preparationInput.change.kind='other']){const r=structuredClone(f.request);mutate(r);assert.throws(()=>validateRunRequest(r,f.binding));}
 });
 test(provider+' prepared source is independently observed against original baseline and exact parent',async()=>{
  const f=fixture(provider),v=await observePreparedSource(f.client,f.binding,who,f.input,f.output,AbortSignal.timeout(1000));assert.equal(v.source.baselineCommit,baseline);assert.equal(v.source.parentCommit,parent);assert.equal(v.source.commit,prepared);assert.equal(v.sourceReviewApproved,false);assert.equal(v.releaseAuthorized,false);assert(!('observedAt' in v.source));assert(!('observedAt' in v.sourceTree));assert.deepEqual(f.calls,[{baselineCommit:baseline,parentCommit:parent,...f.output.source}]);
 });
 test(provider+' wrong scope, provider observations and tree cannot manufacture prepared source proof',async()=>{
  for(const mutate of [f=>f.source.repositoryId='43',f=>f.source.parentCommit=baseline,f=>f.source.commit=parent,f=>f.source.state='CLOSED',f=>f.source.sourceReviewApproved=true,f=>f.tree.commit=parent,f=>f.tree.entries=[],f=>f.tree.sourceApproved=true]){const f=fixture(provider);mutate(f);await assert.rejects(()=>observePreparedSource(f.client,f.binding,who,f.input,f.output,AbortSignal.timeout(1000)),{code:'CI_PREPARATION_SOURCE'});}
  const f=fixture(provider);await assert.rejects(()=>observePreparedSource(f.client,f.binding,who,f.input,f.output,AbortSignal.abort()));assert.equal(f.calls.length,0);
 });
}
test('preparation output rejects arbitrary commands, stale input and unsafe or incomplete declared files',()=>{
 const f=fixture();for(const mutate of [v=>v.command='echo forbidden',v=>v.inputDigest=byteDigest('wrong'),v=>v.source.commit=baseline,v=>v.source.artifacts=[],v=>v.source.artifacts[0].path='../secret',v=>v.source.artifacts[0].bytes=1048577,v=>v.source.artifacts.push(v.source.artifacts[0]),v=>v.source.change.id='../2']){const v=structuredClone(f.output);mutate(v);assert.throws(()=>validatePreparationOutput(v,f.input,'github'));}
 const v=structuredClone(f.output);v.source.commit=parent;assert.equal(validatePreparationOutput(v,f.input,'github').source.commit,parent);
});
const initial={commit:parent,evidenceRef:h};
function node(id,dependsOn=[],operation=false){return{id,dependsOn,source:id.startsWith('project.')?'project':'base',stage:id.startsWith('project.')?'before-candidate':id,...(operation?{action:{actionRef:'runtime.operation.ci-prepare'}}:{})};}
const output=(id,commit=prepared)=>({commit,evidenceRef:byteDigest(id)});
test('source selection follows only operation ancestors and ignores completion order of unrelated branches',()=>{
 const nodes=[node('implementation'),node('project.a',['implementation'],true),node('project.b',['implementation'],true),node('project.check',['project.a']),node('candidate',['project.check','project.b'])],calls=[];
 const selected=resolvePreparationLineage(nodes,'project.check',initial,id=>{calls.push(id);if(id!=='project.a')throw Error('Unrelated operation read');return{stageId:id,input:initial,output:output(id)};});assert.deepEqual(selected,output('project.a'));assert.deepEqual(calls,['project.a']);
 assert.deepEqual(resolvePreparationLineage(nodes,'project.a',initial,()=>{throw Error('No completed input operation exists');}),initial);
});
test('sequential prepared commits propagate through checks and reviews into the following candidate',()=>{
 const nodes=[node('implementation'),node('project.a',['implementation'],true),node('project.review',['project.a']),node('project.b',['project.review'],true),node('candidate',['project.b'])],a=output('a'),b=output('b','d'.repeat(40)),proofs={'project.a':{stageId:'project.a',input:initial,output:a},'project.b':{stageId:'project.b',input:a,output:b}};
 assert.deepEqual(resolvePreparationLineage(nodes,'candidate',initial,id=>proofs[id]),b);proofs['project.b'].input=initial;assert.throws(()=>resolvePreparationLineage(nodes,'candidate',initial,id=>proofs[id]),{code:'CI_PREPARATION_LINEAGE'});
});
test('candidate requires all parallel preparation branches and conflicting commits fail closed',()=>{
 const nodes=[node('implementation'),node('project.a',['implementation'],true),node('project.b',['implementation'],true),node('candidate',['project.a','project.b'])],proofs={'project.a':{stageId:'project.a',input:initial,output:output('a')},'project.b':{stageId:'project.b',input:initial,output:output('b','d'.repeat(40))}};
 assert.throws(()=>resolvePreparationLineage(nodes,'candidate',initial,id=>proofs[id]),{code:'CI_PREPARATION_CONFLICT'});assert.throws(()=>resolvePreparationLineage(nodes,'candidate',initial,id=>{if(id==='project.b')throw Error('Original complete evidence missing');return proofs[id];}),/Original complete evidence missing/);
 proofs['project.b'].output.commit=prepared;const selected=resolvePreparationLineage(nodes,'candidate',initial,id=>proofs[id]);assert.equal(selected.commit,prepared);assert.notEqual(selected.evidenceRef,proofs['project.a'].output.evidenceRef);assert.notEqual(selected.evidenceRef,proofs['project.b'].output.evidenceRef);assert.deepEqual(resolvePreparationLineage([...nodes].reverse(),'candidate',initial,id=>proofs[id]),selected);
 proofs['project.b'].output.evidenceRef=byteDigest('different proof');assert.notEqual(resolvePreparationLineage(nodes,'candidate',initial,id=>proofs[id]).evidenceRef,selected.evidenceRef);
});
test('lineage never permits missing nodes, cycles, illegal operation slots or substituted proof IDs',()=>{
 const nodes=[node('implementation'),node('project.a',['implementation'],true),node('candidate',['project.a'])];
 for(const mutate of [n=>n[1].dependsOn=['missing'],n=>n[1].dependsOn=['candidate'],n=>n[1].stage='candidate-checks',n=>n.push(n[0])]){const n=structuredClone(nodes);mutate(n);assert.throws(()=>resolvePreparationLineage(n,'candidate',initial,id=>({stageId:id,input:initial,output:output(id)})),{code:'CI_PREPARATION_LINEAGE'});}
 assert.throws(()=>resolvePreparationLineage(nodes,'candidate',initial,()=>({stageId:'project.wrong',input:initial,output:output('a')})),{code:'CI_PREPARATION_LINEAGE'});
});
