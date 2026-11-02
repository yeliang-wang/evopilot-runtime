// Synthetic source/owner/CI contracts exercise real stage composition and
// persistence. These are not real project acceptance or release decisions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { crc32 } from 'node:zlib';
import { RuntimeStore } from '../../dist/server/store.js';
import { initializeCredentials, tokenDigest } from '../../dist/server/security.js';
import { startRuntimeServer } from '../../dist/server/http.js';
import { ServiceError } from '../../dist/server/errors.js';
import { valueDigest, byteDigest } from '../../dist/lifecycle/base.js';
import { compileLifecycle } from '../../dist/lifecycle/compiler.js';
import { pinInstance, requiredChecksDigest, requestStage, recordStageOutcome, stageAdmission } from '../../dist/lifecycle/instance.js';
import { createCiStageAdapter } from '../../dist/adapters/stages.js';
import {readVerificationFeedback} from '../../dist/adapters/stage-feedback.js';
import { ciSourceDigest, ciBuildDigest } from '../../dist/adapters/artifacts.js';
import { nativeSha256, NATIVE_CONTRACT_DIGEST } from '../../vendor/compatibility/v1/native.mjs';
import { lifecycle, yaml, syntheticBindings, syntheticSourceTree } from '../fixtures/lifecycle-v090.mjs';
function zip(entries){
  const local=[],central=[];let offset=0;
  for(const [path,value] of entries){const name=Buffer.from(path),data=Buffer.from(value),crc=crc32(data),l=Buffer.alloc(30),c=Buffer.alloc(46);
    l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt32LE(crc,14);l.writeUInt32LE(data.length,18);l.writeUInt32LE(data.length,22);l.writeUInt16LE(name.length,26);
    c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);local.push(l,name,data);central.push(c,name);offset+=l.length+name.length+data.length;
  }
  const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,cd,end]);
}
async function fixture({targetVersion,publicAssets=false}={}){
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'runtime-ci-stage-')),stateRoot=join(dir,'state'),workspaceId='test',projectId='alpha';
  const actor={id:'executor',projects:[projectId],permissions:['read','execution.request'],revision:1,expiresAt:'2030-01-01T00:00:00Z'},data=lifecycle();
  const binding={ref:'binding:alpha/platform',workspaceId,projectId,provider:'github',host:'https://github.com',repository:'synthetic/project',repositoryId:'42',defaultBranch:'main',credentialRef:'credential:alpha/platform',workflowPath:'.github/workflows/test.yml',runner:'ubuntu-latest',revision:1,expiresAt:actor.expiresAt};
  Object.assign(data.config.implementation,{provider:binding.provider,host:binding.host,repository:binding.repository,repositoryId:binding.repositoryId,defaultBranch:binding.defaultBranch});
  for(const stage of ['plan','verification'])data.config[stage].budget={timeoutSeconds:600,maxAttempts:2,maxConcurrency:2,maxLoops:1};
  const pin=owner=>({product:owner,id:'synthetic-'+owner,version:'1.0.0',specVersion:'v1',visibility:publicAssets?'public':'private',digest:nativeSha256(owner),standardDigest:nativeSha256(owner+'standard'),standardLockDigest:nativeSha256(owner+'lock'),producer:{product:owner,version:'0.3.0'},contractDigest:NATIVE_CONTRACT_DIGEST}),references={ontology:pin('ontology'),harness:pin('harness')};
  const resources=[],owners=[];
  for(const kind of ['ontology','harness']){
    const reference=references[kind];Object.assign(data.assets[kind],{id:reference.id,version:reference.version,digest:reference.digest,visibility:reference.visibility});
    owners.push({ref:data.assets[kind].adapterRef,owner:kind,packageRoot:dir,workspaceRoot:dir,workspaceId,projects:[projectId]});
    resources.push({ref:data.assets[kind].mappingRef,workspaceId,projectId,role:'assets.'+kind+'.mappingRef',revision:1,expiresAt:actor.expiresAt,definition:{kind:'asset-map',owner:kind,reference,assessmentId:kind==='ontology'?'synthetic':null,evidenceOrigin:'SYNTHETIC'}});
  }
  for(const [stage,field,purpose] of [['candidate','buildWorkflowRef','build'],['verification','verifyWorkflowRef','verify']])resources.push({ref:data.config[stage][field],workspaceId,projectId,role:'config.'+stage+'.'+field,revision:1,expiresAt:actor.expiresAt,definition:{kind:'workflow',platformRef:binding.ref,purpose,outputContract:'runtime-ci/v1'}});
  const config={schema:'runtime-integrations/v1',workspaceId,revision:1,owners,resources,platforms:[binding],credentials:[{ref:binding.credentialRef,workspaceId,projectId,provider:binding.provider,host:binding.host,tokenFile:join(dir,'unused-token'),revision:1,expiresAt:actor.expiresAt}]},path=join(dir,'integrations.json'),save=()=>writeFileSync(path,JSON.stringify(config),{mode:0o600});save();
  const definition=compileLifecycle(yaml(data),projectId).effective;assert(definition);
  const prepInput={definitionRevisionId:valueDigest('revision'),goalRef:'synthetic:goal',loopRef:'synthetic:loop',target:{id:'synthetic-target',version:targetVersion??'1.0.0-rc.1',title:'Synthetic candidate version test',scope:['Synthetic candidate bytes'],exclusions:[]},source:{provider:'github',repositoryId:'42',commit:'a'.repeat(40)},compatibility:'unchanged',documents:{...Object.fromEntries(['plan','impact','verification','rollback'].map(k=>[k,{path:join(dir,k+'.md'),digest:valueDigest(k)}])),migration:null},verification:{requirementsDigest:requiredChecksDigest(definition),checks:definition.nodes.flatMap(n=>n.checks.map(checkId=>({stageId:n.id,checkId,source:'owner-receipt',procedure:'Synthetic test binding'})))}};
  const prepBody={schema:'runtime-preparation/v1',workspaceId,projectId,semanticDigest:definition.semanticDigest,input:prepInput},prep={...prepBody,digest:valueDigest(prepBody)};
  const authority={projectId,instanceId:'instance',definitionRevisionId:valueDigest('revision'),semanticDigest:definition.semanticDigest,requirementsDigest:requiredChecksDigest(definition),goalRef:'synthetic:goal',targetRef:targetVersion?'preparation:'+prep.digest:'synthetic:target',loopRef:'synthetic:loop',budget:data.config.plan.budget,evidenceRef:'synthetic:authority',revision:'one',expiresAt:actor.expiresAt},admission={authority,bindingsCurrent:true};
  let instance=pinInstance('instance',authority.definitionRevisionId,definition,authority),store=new RuntimeStore(stateRoot,workspaceId),adapter,request;
  if(targetVersion)store.mutate(actor,{projectId,operation:'synthetic.fixture',requestId:'synthetic-preparation',expectedRevision:0,input:{synthetic:true},permission:'read'},()=>({objects:[{kind:'lifecycle-preparation',id:authority.targetRef,value:prep}],value:{synthetic:true},event:{type:'synthetic-preparation-fixture',data:{synthetic:true}}}));
  for(const id of ['scope','plan','implementation']){instance=requestStage(instance,id,'synthetic-'+id,admission);instance=recordStageOutcome(instance,id,{requestId:'synthetic-'+id,inputDigest:instance.stages[id].inputDigest,receiptRef:'synthetic:predecessor',status:'COMPLETE',expiresAt:new Date(Date.now()+600000).toISOString(),checks:definition.nodes.find(n=>n.id===id).checks.map(id=>({id,status:'PASS',evidenceRef:'synthetic:check'}))});}
  const controls={status:'PASSED',ownerFail:null,ownerLost:null,missingCriterion:false,wrongContext:false,observationMissing:false,commit:'a'.repeat(40),sourceCommit:'a'.repeat(40),sourceRef:'synthetic:verified-implementation',runId:'23',changedArchive:false},calls=[],receipts=new Map(),toolchainLockDigest=valueDigest('synthetic-toolchain'),effectiveConfigDigest=valueDigest({params:{}});
  const ownerAdapters=Object.fromEntries(['ontology','harness'].map(kind=>[owners.find(o=>o.owner===kind).ref,{owner:kind,workspaceId,
    capabilities:()=>({registrationDigest:valueDigest({kind,synthetic:true})}),
    readPackage:async()=>{
      if(kind==='ontology')return{package:{manifest:{entrypoints:{cases:'cases.json'}},files:{'cases.json':JSON.stringify({cases:[{id:'positive',requirementIds:['scope']}]})}}};
      const body={reference:references.harness,qualityStatus:'PASS',effectiveConfigDigest};return{validation:{...body,reportDigest:nativeSha256(body)},package:{manifest:{entrypoints:{coverage:'coverage.json'}},files:{'coverage.json':JSON.stringify({requirements:[{id:'requirement',caseIds:['positive']}]})}}};
    },
    read:async(_a,_p,r)=>{calls.push({kind,operation:r.operation});if(r.operation==='workspace.inspect')return{revision:0};const receipt=receipts.get(r.input.requestId);if(!receipt)throw new ServiceError('NOT_FOUND','Synthetic absent receipt',404);return structuredClone(receipt);},
    mutate:async(_a,_p,r)=>{
      calls.push({kind,operation:r.operation,request:r});assert(store.object(projectId,'stage-native-action',request.id+':'+kind),'durable before effect');
      const context=controls.wrongContext?{...r.input.context,inputDigest:valueDigest('wrong')}:r.input.context,criteria=(kind==='ontology'?[{criterionId:'scope',variantId:'positive'}]:[{criterionId:'requirement',variantId:'positive'},{criterionId:'requirement',variantId:'actual-observation'}]).map(p=>({...p,status:controls.ownerFail===kind?'FAIL':'PASS',evidenceDigest:valueDigest(p)}));
      if(controls.missingCriterion)criteria.pop();
      const body={context,toolchainLockDigest,criteria,...(kind==='ontology'?{status:controls.ownerFail===kind?'NONCONFORMING':'CONFORMS',packageDigest:references.ontology.digest,standardPins:{standardDigest:references.ontology.standardDigest,standardLockDigest:references.ontology.standardLockDigest}}:{reference:references.harness,qualityStatus:controls.ownerFail===kind?'FAIL':'PASS',executionStatus:'SUCCEEDED',observationDigest:nativeSha256(r.input.observation),effectiveConfigDigest})};
      const receipt={requestId:r.requestId,operation:r.operation,scope:r.scope,requestDigest:nativeSha256({operation:r.operation,scope:r.scope,input:r.input}),result:{...body,reportDigest:nativeSha256(body)}};receipts.set(r.requestId,receipt);
      if(controls.ownerLost===kind)throw new ServiceError('SYNTHETIC_RESPONSE_LOST','Synthetic loss',503);return receipt;
    },
  }]));
  const platform={revision:async(_actor,selected)=>({bindingDigest:valueDigest(binding),projectId,repositoryId:'42',commit:selected,workflowDigest:valueDigest('workflow'),expiresAt:actor.expiresAt,sourceSelection:'exact-commit',branchHeadCommit:controls.commit}),readiness:async()=>({bindingDigest:valueDigest(binding),projectId,repositoryId:'42',commit:controls.commit,workflowDigest:valueDigest('workflow'),expiresAt:actor.expiresAt}),
    sourceTree:async(_actor,{commit})=>{calls.push({operation:'source.tree',commit});const tree=syntheticSourceTree(binding,commit);if(controls.invalidTree)tree.commit='f'.repeat(40);return tree;},
    dispatch:async(ci,permit)=>{await permit(ci);const retained=store.object(projectId,'lifecycle-instance',instance.id)?.stages[ci.stageId].requestId;if(retained)request=store.object(projectId,'stage-request',retained)??request;calls.push({operation:'ci.dispatch',ci});return run(ci);},run:async(_a,ci)=>{calls.push({operation:'ci.inspect',ci});return run(ci);},
    artifact:async(_a,ci)=>{
      calls.push({operation:'ci.artifact'});const values=JSON.stringify({schema:'runtime-ci-owner-values/v1',values:{healthy:!controls.changedArchive}}),content='synthetic software bytes',path=controls.observationMissing?'evidence/other.json':'evidence/owner-values.json';
      const result={schema:'runtime-ci/v1',requestId:ci.requestId,inputDigest:ci.inputDigest,provider:'github',repositoryId:'42',runId:controls.runId,sourceCommit:ci.commit,workflowDigest:ci.workflowDigest,stageId:ci.stageId,candidateDigest:ci.candidateDigest,checks:request.plan.parameters.expectedChecks.map(id=>({id,status:'PASS',evidence:[{path,digest:byteDigest(values),bytes:Buffer.byteLength(values)}]}))};
      if(ci.stageId==='candidate')result.candidate={schema:'runtime-candidate/v1',profile:'candidate-verification',version:'1.0.0-rc.1',sourceDigest:ciSourceDigest(ci,'github','42'),buildDigest:ciBuildDigest(ci,controls.runId),artifacts:[{name:'software.tgz',digest:byteDigest(content),bytes:Buffer.byteLength(content)}]};
      if(ci.candidateInput)result.candidateConsumption={inputDigest:valueDigest(ci.candidateInput),artifacts:ci.candidateInput.manifest.artifacts};const bytes=zip([['runtime-result.json',JSON.stringify(result)],[path,values],...(ci.stageId==='candidate'?[['artifacts/software.tgz',content]]:[]),...(ci.candidateInput?[['candidate/software.tgz',content]]:[])]);
      return{provider:'github',repositoryId:'42',requestId:ci.requestId,inputDigest:ci.inputDigest,bindingDigest:ci.bindingDigest,commit:ci.commit,runId:controls.runId,runStatus:controls.status,artifactId:'99',jobId:null,name:'runtime-ci',archiveDigest:byteDigest(bytes),archiveBytes:bytes.length,bytes,evidenceRef:'https://github.com/synthetic/project/actions/runs/'+controls.runId};
    }};
  function run(ci){return{schema:'runtime-ci-observation/v1',requestId:ci.requestId,inputDigest:ci.inputDigest,provider:'github',repositoryId:'42',ref:'evopilot-runtime/'+ci.requestId,commit:ci.commit,runId:controls.runId,status:controls.status,jobs:[],evidenceRef:'synthetic:ci',observedAt:'2026-01-01T00:00:00Z',factsDigest:valueDigest('synthetic'),artifactsVerified:false,lifecycleAcceptance:false};}
  const connect=()=>adapter=createCiStageAdapter(store,path,{platform:()=>platform,owner:ref=>ownerAdapters[ref],source:async()=>({commit:controls.sourceCommit,evidenceRef:controls.sourceRef}),toolchainLockDigest,...(controls.toolchainManifestDigest?{toolchainManifestDigest:controls.toolchainManifestDigest}:{})});connect();
  const signal=()=>AbortSignal.timeout(5000),permit=async()=>actor,progress={requestId:'unused',phase:'RUNNING',terminal:false,handle:null,observation:null,observationRef:null,reason:null,observedAt:new Date().toISOString()};
  async function prepare(stage='candidate'){
    const plan=await adapter.prepare(instance,stage,actor,signal()),id='request-'+stage,inputDigest=stageAdmission(instance,stage,admission).inputDigest,body={schema:'runtime-stage-request/v1',id,workspaceId,projectId,instanceId:instance.id,stageId:stage,pinsDigest:instance.pinsDigest,inputDigest,bindingStamp:valueDigest('synthetic'),authorityRef:authority.evidenceRef,releaseAuthorityRef:null,initiatedBy:{id:actor.id,revision:actor.revision},plan,planDigest:valueDigest(plan),requestedAt:new Date().toISOString(),deadlineAt:new Date(Date.now()+120000).toISOString()};
    request={...body,digest:valueDigest(body)};instance=requestStage(instance,stage,id,admission);return request;
  }
  return{dir,config,save,actor,controls,calls,receipts,signal,prepare,permit,get store(){return store;},get request(){return request;},get instance(){return instance;},get adapter(){return adapter;},dispatch:()=>adapter.dispatch(request,instance,permit,signal()),inspect:()=>adapter.inspect(request,instance,progress,actor,signal()),advance:(p=permit)=>adapter.advance(request,instance,progress,p,signal()),complete(o){instance=recordStageOutcome(instance,request.stageId,o.outcome);},restart(){store.close();store=new RuntimeStore(stateRoot,workspaceId);connect();},
    async startService(){
      const token='a'.repeat(64);initializeCredentials(stateRoot,workspaceId,[{...actor,tokenDigest:tokenDigest(token)}]);
      store.mutate(actor,{projectId,operation:'synthetic.fixture',requestId:'seed',expectedRevision:0,input:{synthetic:true},permission:'read'},()=>({objects:[{kind:'lifecycle-instance',id:instance.id,value:instance},{kind:'instance-authority',id:instance.id,value:{evidenceRef:authority.evidenceRef}}],value:{synthetic:true},event:{type:'synthetic-fixture',data:{synthetic:true}}}));store.close();
      const bindings=syntheticBindings(),server=await startRuntimeServer({stateRoot,workspaceId},bindings.provider,async()=>authority,undefined,s=>{store=s;connect();return adapter;});return{server,token};
    },cleanup(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('candidate CI success waits for explicit owner continuation; exact receipts complete and persist its manifest',async()=>{
  const f=await fixture();try{
    await f.prepare();assert.equal((await f.dispatch()).phase,'RUNNING');assert.equal(f.calls.filter(x=>x.operation==='native.package.validate').length,0);
    assert.equal((await f.inspect()).phase,'RUNNING');const o=await f.advance();assert.equal(o.phase,'COMPLETE');assert.equal(o.outcome.candidate.version,'1.0.0-rc.1');assert.equal(o.outcome.checks.every(c=>c.status==='PASS'),true);
    assert.equal(f.calls.filter(x=>x.operation==='ci.dispatch').length,1);assert.equal(f.calls.filter(x=>x.operation==='native.package.validate').length,2);
    assert.equal(readdirSync(join(f.store.root,'stage-ci-artifacts')).filter(p=>p.endsWith('.zip')).length,1);f.complete(o);assert.equal(f.instance.stages.candidate.status,'PASSED');
  }finally{f.cleanup();}
});
test('a candidate must match the reviewed target version before owner validation can run',async()=>{
  const wrong=await fixture({targetVersion:'2.0.0'});try{await wrong.prepare();const result=await wrong.dispatch();assert.equal(result.phase,'FAILED');assert.equal(result.outcome.candidate,undefined);assert.equal(result.outcome.checks.find(c=>c.id==='base.candidate.immutable-manifest').status,'FAIL');assert.equal(wrong.calls.filter(x=>x.operation==='native.package.validate').length,0);}finally{wrong.cleanup();}
  const matching=await fixture({targetVersion:'1.0.0-rc.1'});try{await matching.prepare();await matching.dispatch();assert.equal((await matching.advance()).phase,'COMPLETE');}finally{matching.cleanup();}
});
test('restarting CI/native composition reuses original run and native receipts without new validation',async()=>{
  const f=await fixture();try{await f.prepare();await f.dispatch();await f.advance();f.restart();assert.equal((await f.inspect()).phase,'COMPLETE');assert.equal((await f.advance()).phase,'COMPLETE');assert.equal(f.calls.filter(x=>x.operation==='ci.dispatch').length,1);assert.equal(f.calls.filter(x=>x.operation==='native.package.validate').length,2);}finally{f.cleanup();}
});
test('CI-running inspection and explicit continuation never start owner effects early',async()=>{
  const f=await fixture();try{await f.prepare();f.controls.status='RUNNING';assert.equal((await f.dispatch()).phase,'CI_RUNNING');assert.equal((await f.advance()).phase,'CI_RUNNING');assert.equal(f.calls.filter(x=>x.operation==='native.package.validate').length,0);f.controls.status='PASSED';assert.equal((await f.advance()).phase,'COMPLETE');}finally{f.cleanup();}
});
test('lost first owner response is independently reconciled and only the remaining owner is dispatched',async()=>{
  const f=await fixture();try{await f.prepare();await f.dispatch();f.controls.ownerLost='ontology';await assert.rejects(()=>f.advance(),{code:'SYNTHETIC_RESPONSE_LOST'});f.restart();assert.equal((await f.inspect()).phase,'RUNNING');f.controls.ownerLost=null;assert.equal((await f.advance()).phase,'COMPLETE');assert.equal(f.calls.filter(x=>x.operation==='native.package.validate').length,2);}finally{f.cleanup();}
});
test('failed native quality cannot be replaced by CI success or a complete artifact',async()=>{
  const f=await fixture();try{await f.prepare();await f.dispatch();f.controls.ownerFail='harness';const o=await f.advance();assert.equal(o.phase,'FAILED');assert.equal(o.outcome.candidate,undefined);assert(o.outcome.checks.every(c=>c.status==='FAIL'));}finally{f.cleanup();}
});
test('a known failed CI run stays failed even when it has no usable artifact',async()=>{
  const f=await fixture();try{await f.prepare();f.controls.status='FAILED';const o=await f.dispatch();assert.equal(o.phase,'FAILED');assert.equal(f.calls.filter(x=>x.operation==='ci.artifact'||x.operation==='native.package.validate').length,0);}finally{f.cleanup();}
});
test('an owner execution failure receipt is a failure, not a manufactured quality PASS',async()=>{
  const f=await fixture();try{
    await f.prepare();await f.dispatch();await f.advance();
    const request=f.calls.find(x=>x.kind==='harness'&&x.operation==='native.package.validate').request,receipt=f.receipts.get(request.requestId);receipt.status='FAILED';receipt.result=null;
    const o=await f.inspect();assert.equal(o.phase,'FAILED');assert.equal(o.outcome.candidate,undefined);
  }finally{f.cleanup();}
});
for(const [control,code] of [['missingCriterion','OWNER_REPORT_INCOMPLETE'],['wrongContext','OWNER_REPORT_MISMATCH'],['observationMissing','OWNER_OBSERVATION_MISSING']])test('native stage rejects '+control+' evidence rather than inferring owner quality',async()=>{
  const f=await fixture();try{f.controls[control]=true;await f.prepare();await f.dispatch();await assert.rejects(()=>f.advance(),{code});}finally{f.cleanup();}
});
test('reconciliation cannot replace an original run, artifact or platform registration',async()=>{
  const f=await fixture();try{
    await f.prepare();await f.dispatch();f.controls.runId='24';await assert.rejects(()=>f.inspect(),{code:'STAGE_EVIDENCE_CHANGED'});f.controls.runId='23';f.controls.changedArchive=true;await assert.rejects(()=>f.inspect(),{code:'STAGE_EVIDENCE_CHANGED'});
    f.config.platforms[0].revision++;f.save();await assert.rejects(()=>f.inspect(),{code:'PLATFORM_BINDING_CHANGED'});
  }finally{f.cleanup();}
});
test('registered native manifest remains pinned across restart even when the declared native lock stays the same',async()=>{
  const f=await fixture();try{
    f.controls.toolchainManifestDigest=valueDigest('original-manifest');f.restart();await f.prepare();await f.dispatch();
    assert.equal(f.request.plan.parameters.toolchainManifestDigest,f.controls.toolchainManifestDigest);
    f.controls.toolchainManifestDigest=valueDigest('changed-manifest');f.restart();await assert.rejects(()=>f.inspect(),{code:'TOOLCHAIN_CHANGED'});await assert.rejects(()=>f.advance(),{code:'TOOLCHAIN_CHANGED'});
    assert.equal(f.calls.filter(x=>x.operation==='native.package.validate').length,0);assert.equal(f.calls.filter(x=>x.operation==='ci.dispatch').length,1);
    f.controls.toolchainManifestDigest=valueDigest('original-manifest');f.restart();assert.equal((await f.advance()).phase,'COMPLETE');
  }finally{f.cleanup();}
});
test('a revoked continuation permit cannot mutate owners, and unrelated stages remain unavailable',async()=>{
  const f=await fixture();try{await f.prepare();await f.dispatch();await assert.rejects(()=>f.advance(async()=>{throw new ServiceError('AUTHORITY_REVOKED','Synthetic revocation',403);}),{code:'AUTHORITY_REVOKED'});assert.equal(f.calls.filter(x=>x.operation==='native.package.validate').length,0);await assert.rejects(()=>f.adapter.prepare(f.instance,'publication',f.actor,f.signal()),{code:'STAGE_ADAPTER_UNAVAILABLE'});}finally{f.cleanup();}
});
test('verification pins the prior candidate and cannot rebuild or follow another source commit',async()=>{
  const f=await fixture();try{
    await f.prepare();await f.dispatch();f.complete(await f.advance());const digest=f.instance.candidateDigest;
    f.controls.sourceCommit='b'.repeat(40);await assert.rejects(()=>f.adapter.prepare(f.instance,'verification',f.actor,f.signal()),{code:'CANDIDATE_SOURCE_CHANGED'});f.controls.sourceCommit='a'.repeat(40);f.controls.commit='c'.repeat(40);
    await f.prepare('verification');await f.dispatch();const o=await f.advance();assert.equal(o.phase,'COMPLETE');assert.equal(o.outcome.candidate,undefined);f.complete(o);assert.equal(f.instance.candidateDigest,digest);
  }finally{f.cleanup();}
});
test('HTTP service owns the native CI adapter store and completes the same original stage through explicit advance',async()=>{
  const f=await fixture();let server;
  try{
    const opened=await f.startService();server=opened.server;let serial=0;
    const call=async(operation,input={},write=false)=>{
      const response=await fetch(server.url+'/api/v1/request',{method:'POST',headers:{authorization:'Bearer '+opened.token,'content-type':'application/json'},body:JSON.stringify({operation,projectId:'alpha',input,...(write?{requestId:'http-'+(++serial),expectedRevision:f.store.revision('alpha')}:{})})});
      const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body.result;
    };
    const started=await call('lifecycle.stage.request',{instanceId:'instance',stageId:'candidate'},true),id=started.result.stageRequestId;
    const wait=async(phase,stageRequestId=id)=>{for(let n=0;n<100;n++){const state=await call('lifecycle.stage.request.inspect',{stageRequestId});if(state.progress.phase===phase)return state;await new Promise(r=>setTimeout(r,10));}assert.fail('Expected native stage phase '+phase);};
    await wait('RUNNING');assert.equal(f.calls.filter(x=>x.operation==='native.package.validate').length,0);
    const advanced=await call('lifecycle.stage.advance',{stageRequestId:id},true);assert.equal(advanced.result.newAttempt,false);await wait('COMPLETE');
    const saved=await call('lifecycle.instance.inspect',{instanceId:'instance'});assert.equal(saved.instance.stages.candidate.attempts,1);assert(saved.instance.candidateDigest);assert.equal(f.calls.filter(x=>x.operation==='ci.dispatch').length,1);assert.equal(f.calls.filter(x=>x.operation==='native.package.validate').length,2);
    const verified=await call('lifecycle.stage.request',{instanceId:'instance',stageId:'verification'},true),verificationId=verified.result.stageRequestId;
    await wait('RUNNING',verificationId);await call('lifecycle.stage.advance',{stageRequestId:verificationId},true);await wait('COMPLETE',verificationId);
    const feedback=await call('lifecycle.verification.feedback.read',{stageRequestId:verificationId});assert.equal(feedback.event.stage,'SUCCEEDED');assert.equal(feedback.event.projectCandidateDigest,saved.instance.candidateDigest);assert.equal(feedback.feedbackDelivered,false);assert.equal(feedback.releaseAuthorized,false);assert.equal(f.calls.filter(x=>x.operation==='native.package.validate').length,4);
  }finally{await server?.close();f.cleanup();}
});

test('new native CI requests bind complete source scope and preserve the original collected observation',async()=>{
  const f=await fixture();try{await f.prepare();assert.equal(f.request.plan.adapterId,'runtime-ci-owner-stage-v2');const p=f.request.plan.parameters;assert.equal(p.sourceScope.treeDigest,p.sourceTree.treeDigest);assert.equal(p.sourceScope.inventoryDigest,p.sourceTree.inventoryDigest);assert.equal(p.sourceScope.requirementsDigest,f.instance.pins.requirementsDigest);await f.dispatch();await f.advance();const a=f.store.object('alpha','stage-native-action',f.request.id+':harness');assert.equal(a.context.sourceScopeDigest,nativeSha256(p.sourceScope));assert.equal(a.request.input.observation.source.digest,p.sourceTree.treeDigest);assert.equal(a.request.input.observation.source.revision,p.commit);assert.equal(a.request.input.observation.collectionReceiptRef.claimId,a.context.claimId);f.restart();assert.equal((await f.inspect()).phase,'COMPLETE');assert.equal(f.calls.filter(x=>x.operation==='source.tree').length,1);}finally{f.cleanup();}
});
test('wrong source inventory blocks new CI preparation without dispatch or owner mutation',async()=>{
  const f=await fixture();try{f.controls.invalidTree=true;await assert.rejects(()=>f.prepare(),{code:'SOURCE_TREE_CHANGED'});assert.equal(f.calls.filter(x=>x.operation==='ci.dispatch'||x.operation==='native.package.validate').length,0);}finally{f.cleanup();}
});
test('retained source scope cannot change even if outer plan digests are recomputed',async()=>{
  const f=await fixture();try{await f.prepare();const r=f.request;r.plan.parameters.sourceScope.treeDigest=valueDigest('foreign-tree');r.plan.bindingDigest=valueDigest(r.plan.parameters);r.planDigest=valueDigest(r.plan);const{digest,...body}=r;r.digest=valueDigest(body);await assert.rejects(()=>f.dispatch(),{code:'SOURCE_TREE_CHANGED'});assert.equal(f.calls.filter(x=>x.operation==='ci.dispatch').length,0);}finally{f.cleanup();}
});
test('historical v1 CI request readback preserves its original context and does not gain source inventory',async()=>{
  const f=await fixture();try{await f.prepare();const r=f.request;delete r.plan.parameters.sourceScope;delete r.plan.parameters.sourceTree;r.plan.adapterId='runtime-ci-owner-stage-v1';r.plan.adapterDigest=valueDigest({id:r.plan.adapterId,stages:['implementation','candidate','verification'],source:'verified-exact-commit/v1',candidate:'immutable-archive-consumption/v1',workflow:'runtime-ci/v1',owners:'native/v1',observation:'runtime-ci-owner-values/v1',continuation:'explicit-original-request/v1'});r.plan.bindingDigest=valueDigest(r.plan.parameters);r.planDigest=valueDigest(r.plan);const{digest,...body}=r;r.digest=valueDigest(body);await f.dispatch();const result=await f.advance();assert.equal(result.phase,'COMPLETE');assert.equal(result.adapterDigest,r.plan.adapterDigest);const a=f.store.object('alpha','stage-native-action',r.id+':harness');assert.equal(a.context.sourceScopeDigest,ciSourceDigest({commit:r.plan.parameters.commit},'github','42'));assert.equal(a.request.input.observation.source.digest,a.context.sourceScopeDigest);f.restart();assert.equal((await f.inspect()).phase,'COMPLETE');assert.equal(f.request.plan.parameters.sourceTree,undefined);assert.equal(f.calls.filter(x=>x.operation==='native.package.validate').length,2);}finally{f.cleanup();}
});

function syntheticCoreCommit(f,outcome){
  f.complete(outcome);const r=f.request,projectId='alpha',objects=[{kind:'stage-request',id:r.id,value:r},{kind:'lifecycle-instance',id:f.instance.id,value:f.instance},{kind:'stage-progress',id:r.id,value:{requestId:r.id,phase:outcome.phase,terminal:true,handle:outcome.handle,observation:outcome,observationRef:valueDigest(outcome),reason:null,observedAt:new Date().toISOString()}}];
  f.store.mutate(f.actor,{projectId,operation:'synthetic.core.commit',requestId:'synthetic-core-'+r.id,expectedRevision:f.store.revision(projectId),input:{synthetic:true},permission:'read'},()=>({objects,value:{synthetic:true},event:{type:'synthetic-core-terminal',data:{synthetic:true}}}));
}
const feedbackId=f=>nativeSha256({workspaceId:'test',scope:{visibility:'private',projectId:'alpha'},claimId:valueDigest({stageRequestDigest:f.request.digest})});
async function verificationFixture(options){const f=await fixture(options);await f.prepare();await f.dispatch();f.complete(await f.advance());await f.prepare('verification');await f.dispatch();return f;}
test('registered terminal verification feedback reuses exact native claims, source, CI and original receipts across restart',async()=>{
  const f=await verificationFixture();try{const outcome=await f.advance();syntheticCoreCommit(f,outcome);const id=feedbackId(f),event=readVerificationFeedback(f.store,f.actor,'alpha',id);assert.equal(event.stage,'SUCCEEDED');assert.equal(event.runId,'verification:'+f.request.id);assert.equal(event.runReviewDigest,f.request.planDigest);assert.deepEqual(event.source,f.request.plan.parameters.sourceScope);assert.equal(event.observation.sourceScopeDigest,nativeSha256(event.source));assert.equal(event.observation.source.digest,event.source.treeDigest);assert.equal(event.claimId,event.observation.collectionReceiptRef.claimId);assert.equal(event.collectionRefs[0].digest,event.observation.collectionReceiptRef.digest);for(const owner of ['ontology','harness'])assert.deepEqual(event.results[owner],f.store.object('alpha','stage-native-receipt',f.request.id+':'+owner));f.restart();assert.deepEqual(readVerificationFeedback(f.store,f.actor,'alpha',id),event);assert.equal(f.calls.filter(c=>c.operation==='native.package.validate').length,4);}finally{f.cleanup();}
});
test('native success retained before the execution core terminal commit cannot be delivered as completed feedback',async()=>{
  const f=await verificationFixture();try{const id=feedbackId(f);assert.throws(()=>readVerificationFeedback(f.store,f.actor,'alpha',id),{code:'FEEDBACK_RUN_INCOMPLETE'});const outcome=await f.advance();assert(f.store.object('alpha','stage-evaluation-run',f.request.id));assert.throws(()=>readVerificationFeedback(f.store,f.actor,'alpha',id),{code:'FEEDBACK_RUN_INCOMPLETE'});syntheticCoreCommit(f,outcome);assert.equal(readVerificationFeedback(f.store,f.actor,'alpha',id).stage,'SUCCEEDED');assert.throws(()=>readVerificationFeedback(f.store,{...f.actor,projects:['beta']},'alpha',id),{code:'FORBIDDEN'});assert.throws(()=>readVerificationFeedback(f.store,f.actor,'alpha',{id,status:'PASS'}));}finally{f.cleanup();}
});
test('native verification failures stay failed in the registered feedback event',async()=>{
  const f=await verificationFixture();try{f.controls.ownerFail='harness';const result=await f.advance();assert.equal(result.phase,'FAILED');syntheticCoreCommit(f,result);const event=readVerificationFeedback(f.store,f.actor,'alpha',feedbackId(f));assert.equal(event.stage,'FAILED');assert.equal(event.results.harness.result.qualityStatus,'FAIL');assert.equal(event.pins.harness.version,'1.0.0');}finally{f.cleanup();}
});
test('changed original native receipt prevents reuse of an otherwise retained feedback event',async()=>{
  const f=await verificationFixture();try{syntheticCoreCommit(f,await f.advance());const id=feedbackId(f),event=readVerificationFeedback(f.store,f.actor,'alpha',id),value=structuredClone(event.results.harness);value.result.qualityStatus='FAIL';f.store.mutate(f.actor,{projectId:'alpha',operation:'synthetic.fault',requestId:'synthetic-receipt-fault',expectedRevision:f.store.revision('alpha'),input:{synthetic:true},permission:'read'},()=>({objects:[{kind:'stage-native-receipt',id:f.request.id+':harness',value}],value:{synthetic:true},event:{type:'synthetic-fault',data:{synthetic:true}}}));assert.throws(()=>readVerificationFeedback(f.store,f.actor,'alpha',id),{code:'OWNER_REPORT_MISMATCH'});}finally{f.cleanup();}
});
test('public asset references do not make private project feedback public',async()=>{
  const f=await verificationFixture({publicAssets:true});try{syntheticCoreCommit(f,await f.advance());const event=readVerificationFeedback(f.store,f.actor,'alpha',feedbackId(f));assert.equal(event.scope.visibility,'private');assert.equal(event.scope.projectId,'alpha');assert.equal(event.pins.ontology.visibility,'public');assert.equal(event.pins.harness.visibility,'public');}finally{f.cleanup();}
});

test('a missing or modified original CI archive cannot back a retained terminal feedback event',async()=>{
  const f=await verificationFixture();try{syntheticCoreCommit(f,await f.advance());const id=feedbackId(f),ci=f.store.object('alpha','ci-stage-artifact',f.request.id),path=join(f.store.root,'stage-ci-artifacts',ci.archiveDigest.slice(7)+'.zip'),bytes=readFileSync(path);bytes[bytes.length-1]^=1;writeFileSync(path,bytes);assert.throws(()=>readVerificationFeedback(f.store,f.actor,'alpha',id),{code:'FEEDBACK_RUN_MISMATCH'});}finally{f.cleanup();}
});
