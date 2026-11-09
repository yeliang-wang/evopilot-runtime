import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {startRuntimeServer} from '../../dist/server/http.js';
import {initializeCredentials,tokenDigest} from '../../dist/server/security.js';
import {byteDigest,valueDigest,loadPublisherBase} from '../../dist/lifecycle/base.js';
import {registeredExtensionReview} from '../../dist/lifecycle/extension-review.js';
import {createNativeExtensionStageAdapter} from '../../dist/adapters/extension-stages.js';
import {requiredChecksDigest} from '../../dist/lifecycle/instance.js';
import {compileLifecycle} from '../../dist/lifecycle/compiler.js';
import {registeredAuthorityPolicy} from '../../dist/adapters/authority.js';
import {registeredPreparation,createScopeStageAdapter,createPlanStageAdapter} from '../../dist/adapters/preparation-stages.js';
import {lifecycleBindingExample} from '../fixtures/adapters-v090.mjs';
import {syntheticBindings,yaml,extension,syntheticSourceTree} from '../fixtures/lifecycle-v090.mjs';
import {syntheticDecisionEvidence} from '../fixtures/native/decision-evidence.mjs';
import {ServiceError} from '../../dist/server/errors.js';
import {nativeSha256,NATIVE_CONTRACT_DIGEST} from '../../vendor/compatibility/v1/native.mjs';

// The actual HTTP/store/policy/scope adapters are exercised with explicit
// synthetic asset admission and a read-only synthetic source platform.
async function fixture({plan=false,extensions=[],extensionSlot='after-plan',missingCriterion=false}={}){
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'runtime-preparation-')),root=join(dir,'state'),workspaceId='synthetic',projectId='alpha',path=join(dir,'integrations.json'),expiry='2030-01-01T00:00:00Z';
  const pin=owner=>({product:owner,id:'synthetic-'+owner,version:'1.0.0',specVersion:'v1',visibility:'private',digest:valueDigest(owner),standardDigest:valueDigest(owner+'-standard'),standardLockDigest:valueDigest(owner+'-lock'),producer:{product:owner,version:'0.3.0'},contractDigest:NATIVE_CONTRACT_DIGEST});
  const platform={ref:'binding:alpha/platform',workspaceId,projectId,provider:'github',host:'https://github.com',repository:'synthetic/project',repositoryId:'42',defaultBranch:'main',credentialRef:'credential:alpha/platform',revision:1,expiresAt:expiry,workflowPath:'.github/workflows/build.yml',runner:'ubuntu-latest'};
  const credentials={ref:platform.credentialRef,workspaceId,projectId,provider:platform.provider,host:platform.host,tokenFile:join(dir,'unused-token'),revision:1,expiresAt:expiry},owners=['ontology','harness'].map(owner=>({ref:'binding:alpha/'+owner,owner,packageRoot:dir,workspaceRoot:dir,workspaceId,projects:[projectId]}));
  const {configuration:config,data}=lifecycleBindingExample({root:dir,workspaceId,projectId,platform,credential:credentials,ownerRegistrations:owners,references:{ontology:pin('ontology'),harness:pin('harness')},assessmentId:'synthetic'});
  if(extensions.length){data.config.verification.budget.timeoutSeconds=60;
    data.extensions=extensions.map((kind,index)=>{const e=extension(kind+'-'+index,extensionSlot),action=loadPublisherBase().base.actions.find(a=>a.id===(kind==='review'?'runtime.review.scope':'runtime.check.'+kind));return{...e,actionRef:action.id,actionVersion:action.version,actionDigest:valueDigest(action),type:kind==='review'?'review':e.type,parameters:kind==='review'?{reviewRef:'binding:alpha/review-'+index}:{checkRef:'binding:alpha/'+kind+'-check-'+index},scopeRef:'scope:'+projectId,budget:{...e.budget,timeoutSeconds:60}};});
    for(const [index,e]of data.extensions.entries()){
      const kind=extensions[index]==='review'?'harness':extensions[index],isReview=extensions[index]==='review',definition={kind:'check',owner:kind,criterionId:missingCriterion?'not-published':kind==='ontology'?'scope':'H001',variantIds:['positive']},row={stage:e.id,checkId:e.requirementRefs[0],owner:kind,criterionId:definition.criterionId,variantIds:definition.variantIds,source:isReview?'decision':'owner-receipt'};
      for(const [ref,role,d]of [isReview?[e.parameters.reviewRef,'extension.review',{kind:'review',reviewerIds:['fixture','reviewer'],evidenceRequired:true}]:[e.parameters.checkRef,'extension.check',definition],[e.requirementRefs[0],'extension.requirement',definition],[e.evidenceMappingRef,'extension.mapping',{kind:'evidence-map',ontology:pin('ontology'),harness:pin('harness'),rows:[row]}]])config.resources.push({ref,role,workspaceId,projectId,revision:1,expiresAt:expiry,definition:structuredClone(d)});
      config.resources.find(r=>r.role==='config.verification.evidenceMappingRef').definition.rows.push(row);
    }
  }
  if(plan)data.config.plan.budget.timeoutSeconds=60; // Explicit synthetic recovery budget; no production grant is changed.
  config.resources.find(r=>r.role==='config.release-decision.authorityPolicyRef').definition.principalIds.push('other-decider');
  const save=()=>writeFileSync(path,JSON.stringify(config),{mode:0o600});save();
  const tokens=Object.fromEntries(['fixture','reviewer','reader','other-decider','foreign'].map(id=>[id,randomBytes(32).toString('hex')]));
  const all=['read','draft.write','definition.activate','decision.record','execution.request'];
  initializeCredentials(root,workspaceId,Object.entries(tokens).map(([id,token])=>({id,projects:[id==='foreign'?'beta':projectId],permissions:id==='reader'||id==='foreign'?['read']:all,revision:1,expiresAt:expiry,tokenDigest:tokenDigest(token)})));
  const state={commit:'a'.repeat(40),reads:0,pending:null,fail:null,missing:false,context:false,lost:null,beforeWrite:false,afterWrite:null,manifest:valueDigest('toolchain-manifest')},calls=[],receipts=new Map(),toolchainLockDigest=valueDigest('toolchain-lock'),effectiveConfigDigest=valueDigest('native-config'),bindings=syntheticBindings(),validator=registeredPreparation(path,workspaceId),policy=registeredAuthorityPolicy(path,workspaceId);
  const client={sourceTree:async(_actor,{commit},signal)=>{await state.onTree?.(signal);return syntheticSourceTree(platform,commit);},readiness:async()=>{state.reads++;return{provider:platform.provider,projectId,repositoryId:platform.repositoryId,bindingDigest:valueDigest(platform),commit:state.commit,factsDigest:valueDigest({commit:state.commit}),expiresAt:new Date(Date.now()+60000).toISOString()};}};
  const ownerAdapters=Object.fromEntries(['ontology','harness'].map(kind=>['binding:alpha/'+kind,{owner:kind,workspaceId,capabilities:()=>({registrationDigest:valueDigest(kind+'registration')}),
    readPackage:async()=>{const body={reference:pin('harness'),qualityStatus:'PASS',effectiveConfigDigest};return kind==='ontology'?{package:{manifest:{entrypoints:{cases:'cases.json'}},files:{'cases.json':JSON.stringify({cases:[{id:'positive',requirementIds:['scope']}]})}}}:{validation:{...body,reportDigest:nativeSha256(body)},package:{manifest:{entrypoints:{coverage:'coverage.json'}},files:{'coverage.json':JSON.stringify({requirements:[{id:'requirement-H001',ruleIds:['H001'],caseIds:['positive']}]})}}};},
    read:async(_a,_p,r)=>{if(r.operation==='workspace.inspect')return{revision:0};const receipt=receipts.get(r.input.requestId);if(!receipt)throw new ServiceError('NOT_FOUND','Synthetic missing native receipt',404);return state.pending===kind?{...structuredClone(receipt),status:'RUNNING',result:{status:'RUNNING'}}:structuredClone(receipt);},
    mutate:async(_a,_p,r)=>{
      calls.push({kind,request:r});const stored=activeStore.object(projectId,r.requestId.startsWith('extension-native-')?'extension-native-action':'plan-stage-native-action',r.requestId.startsWith('extension-native-')?activeRequest:activeRequest+':'+kind);assert(stored,'native action must be durable before any effect');
      if(state.lost===kind&&state.beforeWrite)throw new ServiceError('SYNTHETIC_RESPONSE_LOST','Synthetic loss before owner result',503);
      const criteria=(kind==='ontology'?[{criterionId:'scope',variantId:'positive'}]:[{criterionId:'requirement-H001',variantId:'positive'},{criterionId:'requirement-H001',variantId:'actual-observation'}]).map(x=>({...x,status:state.fail===kind?'FAIL':'PASS',evidenceDigest:valueDigest(x)}));if(state.missing)criteria.pop();
      const context=state.context?{...r.input.context,inputDigest:valueDigest('wrong')}:r.input.context;
      const body={context,toolchainLockDigest,criteria,...(kind==='ontology'?{status:state.fail===kind?'NONCONFORMING':'CONFORMS',packageDigest:pin(kind).digest,standardPins:{standardDigest:pin(kind).standardDigest,standardLockDigest:pin(kind).standardLockDigest}}:{reference:pin(kind),qualityStatus:state.fail===kind?'FAIL':'PASS',executionStatus:'SUCCEEDED',effectiveConfigDigest,observationDigest:nativeSha256(r.input.observation)})};
      receipts.set(r.requestId,{requestId:r.requestId,operation:r.operation,scope:r.scope,requestDigest:nativeSha256({operation:r.operation,scope:r.scope,input:r.input}),result:{...body,reportDigest:nativeSha256(body)}});
      state.afterWrite?.(kind);if(state.lost===kind)throw new ServiceError('SYNTHETIC_RESPONSE_LOST','Synthetic lost response after persisted owner result',503);
    },
  }]));
  const reviewConnections=()=>({platform:()=>client,owner:ref=>ownerAdapters[ref],source:async()=>({commit:state.commit,evidenceRef:'synthetic:completed-source'})});
  let server,sequence=0,activeStore,activeRequest;const start=async()=>server=await startRuntimeServer({stateRoot:root,workspaceId},bindings.provider,undefined,policy,(store,services)=>{
    activeStore=store;const scope=createScopeStageAdapter(store,path,{platform:()=>client});if(!plan)return scope;
    const connections={platform:()=>client,owner:ref=>ownerAdapters[ref],toolchainLockDigest,toolchainManifestDigest:state.manifest,source:async()=>({commit:state.commit,evidenceRef:'synthetic:completed-source'})},adapter=createPlanStageAdapter(store,path,connections),nativeExtension=createNativeExtensionStageAdapter(store,path,connections),scopeReview={...services.extensionReviews.adapter,async inspect(...args){const result=await services.extensionReviews.adapter.inspect(...args);await state.afterReviewOutcome?.(result);return result;}};
    // This source/candidate provider is deliberately synthetic. It exercises the
    // real execution core and slot joins, not external Agent/CI qualification.
    const syntheticBase={prepare:async(i,id)=>({adapterId:'synthetic-slot-predecessor',adapterDigest:valueDigest('synthetic-slot-predecessor'),action:'base.'+id,bindingDigest:valueDigest('synthetic'),parameters:{synthetic:true}}),dispatch:async(r,i,permit)=>{const actor=await permit();return syntheticBase.inspect(r,i,null,actor);},inspect:async(r,i,_progress,actor)=>{
      const outcome={requestId:r.id,inputDigest:r.inputDigest,receiptRef:'synthetic:original-predecessor/'+r.id,status:'COMPLETE',expiresAt:r.deadlineAt,checks:i.definition.nodes.find(n=>n.id===r.stageId).checks.map(id=>({id,status:'PASS',evidenceRef:'synthetic:original-check/'+id}))};
      if(r.stageId==='candidate'){outcome.candidate={schema:'runtime-candidate/v1',version:input.target.version,profile:'candidate-verification',sourceDigest:valueDigest({provider:platform.provider,repositoryId:platform.repositoryId,commit:state.commit}),buildDigest:valueDigest('synthetic build'),artifacts:[{name:'fixture.tgz',digest:valueDigest('synthetic artifact'),bytes:100}]};
        const body={schema:'runtime-candidate-source-evidence/v1',requestId:r.id,requestDigest:r.digest,pinsDigest:i.pinsDigest,outcomeDigest:valueDigest(outcome),input:{schema:'runtime-ci-candidate-input/v1',manifest:outcome.candidate,archive:{provider:platform.provider,repositoryId:platform.repositoryId,runId:'1',artifactId:'1',jobId:null,archiveDigest:valueDigest('synthetic archive'),archiveBytes:100}}};
        if(!activeStore.object(projectId,'stage-candidate-source',r.id))activeStore.mutate(actor,{projectId,operation:'synthetic.candidate',requestId:'synthetic-candidate-'+r.id,expectedRevision:activeStore.revision(projectId),input:{synthetic:true},permission:'read'},()=>({objects:[{kind:'stage-candidate-source',id:r.id,value:{...body,digest:valueDigest(body)}}],value:{synthetic:true},event:{type:'synthetic-candidate',data:{}}}));
      }
      await state.beforeBaseOutcome?.(r);return{requestId:r.id,inputDigest:r.inputDigest,adapterDigest:r.plan.adapterDigest,phase:'COMPLETE',handle:null,outcome};
    }},select=id=>id==='scope'?scope:id==='plan'?adapter:id.startsWith('project.')?(data.extensions.find(e=>e.id===id)?.actionRef==='runtime.review.scope'?scopeReview:nativeExtension):syntheticBase;
    return{prepare:(i,s,...a)=>select(s).prepare(i,s,...a),dispatch:(r,...a)=>{activeRequest=r.id;return select(r.stageId).dispatch(r,...a);},inspect:(r,...a)=>select(r.stageId).inspect(r,...a),reconcileAdvance:(r,...a)=>select(r.stageId).reconcileAdvance(r,...a),advance:(r,...a)=>{activeRequest=r.id;return select(r.stageId).advance(r,...a);}};
  },validator,undefined,store=>registeredExtensionReview(store,path,reviewConnections()));await start();
  async function request(operation,input={},write=false,actor='fixture',meta){
    if(write&&!meta){const status=await request('runtime.status',{},false,actor);meta={requestId:'prep-'+(++sequence),expectedRevision:status.result.revision};}
    const envelope={operation,projectId,input,...(meta??{})},response=await fetch(server.url+'/api/v1/request',{method:'POST',headers:{authorization:'Bearer '+tokens[actor],'content-type':'application/json'},body:JSON.stringify(envelope)});
    return{status:response.status,...await response.json(),envelope};
  }
  const source=yaml(data),validated=await request('lifecycle.definition.validate',{yaml:source});assert.equal(validated.result.ready,true);
  const activated=await request('lifecycle.definition.save-and-activate',{yaml:source,validationDigest:validated.result.validationDigest},true);assert.equal(activated.status,200,JSON.stringify(activated));const definitionRevisionId=activated.result.result.revisionId,definition=compileLifecycle(source,projectId).effective;
  const file=name=>{const p=join(dir,name+'.md');writeFileSync(p,'Synthetic reviewed '+name+' procedure; no production or release authority.\n',{mode:0o600});return{path:p,digest:byteDigest(readFileSync(p))};};
  const input={definitionRevisionId,goalRef:'synthetic:goal/scope',loopRef:'synthetic:loop/one',target:{id:'scope-probe',version:'0.9.0-preview.1',title:'Synthetic scope preparation',scope:['One bounded synthetic read'],exclusions:['Real project semantics and release']},source:{provider:'github',repositoryId:'42',commit:state.commit},compatibility:'compatible',documents:{plan:file('plan'),impact:file('impact'),verification:file('verification'),rollback:file('rollback'),migration:null},verification:{requirementsDigest:requiredChecksDigest(definition),checks:definition.nodes.flatMap(n=>n.checks.map(checkId=>({stageId:n.id,checkId,source:n.action?.actionRef==='runtime.review.scope'?'decision':'owner-receipt',procedure:'Evaluate the exact pinned synthetic rule and retain its own evidence.'})))}};
  async function retain(value=input){const r=await request('lifecycle.preparation.save',value,true);assert.equal(r.status,200,JSON.stringify(r));return r;}
  function subject(ref,id='scope-instance'){return{instanceId:id,definitionRevisionId,goalRef:input.goalRef,targetRef:ref,loopRef:input.loopRef,budget:data.config.plan.budget,expiresAt:new Date(Date.now()+3600000).toISOString()};}
  async function grant(ref,id='scope-instance'){
    const s=subject(ref,id),preview=await request('lifecycle.authority.preview',{kind:'execution',subject:s});assert.equal(preview.status,200,JSON.stringify(preview));
    const evidenceRef=syntheticDecisionEvidence(dir,{owner:'runtime',operation:'lifecycle.authority.execution',workspaceId,scope:{visibility:'private',projectId},reviewDigest:preview.result.reviewDigest,decision:'APPROVE'});
    const g=await request('lifecycle.authority.record',{kind:'execution',subject:s,reviewDigest:preview.result.reviewDigest,decision:'APPROVE',evidenceRef},true);assert.equal(g.status,200,JSON.stringify(g));return{ref:g.result.result.authorityRef,preview,subject:s};
  }
  async function instance(ref){const g=await grant(ref),r=await request('lifecycle.instance.create',{instanceId:g.subject.instanceId,definitionRevisionId,authorityRef:g.ref},true);assert.equal(r.status,200,JSON.stringify(r));return g;}
  return{dir,root,path,config,data,input,definition,definitionRevisionId,tokens,state,calls,receipts,request,retain,subject,grant,instance,save,get store(){return activeStore;},get server(){return server;},async restart(){await server.close();await start();},async cleanup(){await server.close();rmSync(dir,{recursive:true,force:true});}};
}
test('preparation is immutable per-instance material, not an activation, decision, Run or asserted PASS',async()=>{
  const f=await fixture();try{
    const r=await f.retain(),ref=r.result.result.preparationRef;assert.equal(r.result.result.executionAuthorized,false);
    const read=await f.request('lifecycle.preparation.read',{preparationRef:ref});assert.equal(read.result.current,true);assert.deepEqual(read.result.packet.input,f.input);
    assert.equal((await f.request('lifecycle.instance.inspect',{instanceId:'scope-instance'})).error.code,'NOT_FOUND');
    const replay=await f.request(r.envelope.operation,r.envelope.input,true,'fixture',{requestId:r.envelope.requestId,expectedRevision:r.envelope.expectedRevision});assert.deepEqual(replay.result,r.result);
    const other=structuredClone(f.input);other.target.title='Second exact target';const second=await f.retain(other);assert.notEqual(second.result.result.preparationRef,ref);assert.deepEqual((await f.request('lifecycle.preparation.read',{preparationRef:ref})).result.packet,read.result.packet);
    assert.equal((await f.request('lifecycle.preparation.save',{...f.input,status:'PASS'},true)).error.code,'INVALID_FIELDS');
    assert.equal((await f.request('lifecycle.preparation.save',f.input,true,'reader')).error.code,'FORBIDDEN');
    assert.equal((await f.request('lifecycle.preparation.read',{preparationRef:ref},false,'foreign')).status,403);
  }finally{await f.cleanup();}
});
test('plan coverage cannot drop, duplicate, retarget or change an evidence source in the fixed denominator',async()=>{
  const f=await fixture();try{
    for(const change of [x=>x.verification.checks.pop(),x=>x.verification.checks.push(x.verification.checks[0]),x=>x.verification.checks[0].checkId='unregistered',x=>x.verification.requirementsDigest=valueDigest('weakened')]){
      const copy=structuredClone(f.input);change(copy);assert.notEqual((await f.request('lifecycle.preparation.save',copy,true)).status,200);
    }
    const changed=structuredClone(f.input);changed.verification.checks[0].source='ci-artifact';assert.equal((await f.request('lifecycle.preparation.save',changed,true)).error.code,'PREPARATION_EVIDENCE_MAPPING');
    assert.equal((await f.request('lifecycle.preparation.save',{...f.input,compatibility:'migration-required'},true)).error.code,'MIGRATION_PLAN_REQUIRED');
    assert.equal((await f.request('lifecycle.preparation.save',{...f.input,source:{...f.input.source,repositoryId:'other'}},true)).status,400);
  }finally{await f.cleanup();}
});
test('preparation file reads stay in registered locations and preserve historical contents after drift',async()=>{
  const f=await fixture();try{
    const changed=structuredClone(f.input);changed.documents.plan={path:process.execPath,digest:valueDigest('not-read')};assert.equal((await f.request('lifecycle.preparation.save',changed,true)).error.code,'PREPARATION_DOCUMENT_SCOPE');
    const link=join(f.dir,'linked.md');symlinkSync(f.input.documents.plan.path,link);changed.documents.plan={...f.input.documents.plan,path:link};assert.equal((await f.request('lifecycle.preparation.save',changed,true)).error.code,'UNSAFE_RESOURCE');
    const ref=(await f.retain()).result.result.preparationRef;writeFileSync(f.input.documents.plan.path,'Unreviewed replacement');
    const read=await f.request('lifecycle.preparation.read',{preparationRef:ref});assert.equal(read.status,200);assert.equal(read.result.current,false);assert.equal(read.result.reason,'RESOURCE_CHANGED');assert.deepEqual(read.result.packet.input,f.input);
    assert.equal((await f.request('lifecycle.authority.preview',{kind:'execution',subject:f.subject(ref)})).error.code,'RESOURCE_CHANGED');
  }finally{await f.cleanup();}
});
test('the exact execution review contains the preparation and requires the configured plan reviewer',async()=>{
  const f=await fixture();try{
    const ref=(await f.retain()).result.result.preparationRef,s=f.subject(ref);
    assert.equal((await f.request('lifecycle.authority.preview',{kind:'execution',subject:s},false,'other-decider')).error.code,'PREPARATION_REVIEWER');
    assert.equal((await f.request('lifecycle.authority.preview',{kind:'execution',subject:{...s,goalRef:'different'}})).error.code,'PREPARATION_SCOPE');
    const g=await f.grant(ref);assert.deepEqual(g.preview.result.preparation.input,f.input);
    writeFileSync(f.input.documents.impact.path,'Changed compatibility assessment');const inspected=await f.request('lifecycle.authority.inspect',{authorityRef:g.ref});assert.equal(inspected.result.usable,false);assert.equal(inspected.result.reason,'RESOURCE_CHANGED');
    const instance=await f.request('lifecycle.instance.create',{instanceId:s.instanceId,definitionRevisionId:f.definitionRevisionId,authorityRef:g.ref},true);assert.equal(instance.error.code,'RESOURCE_CHANGED');
  }finally{await f.cleanup();}
});
test('scope completes from an exact preparation and actual adapter observations without synthetic predecessor seeding',async()=>{
  const f=await fixture();try{
    const ref=(await f.retain()).result.result.preparationRef;await f.instance(ref);
    const started=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:'scope'},true);assert.equal(started.status,200,JSON.stringify(started));const stageRequestId=started.result.result.stageRequestId;
    let result;for(let i=0;i<80;i++){result=await f.request('lifecycle.stage.request.inspect',{stageRequestId});if(result.result.progress.terminal)break;await new Promise(r=>setTimeout(r,20));}
    assert.equal(result.result.progress.phase,'COMPLETE',JSON.stringify(result));assert.equal(f.state.reads,1);
    const evidence=await f.request('lifecycle.scope.evidence.read',{stageRequestId});assert.equal(evidence.result.evidence.source.commit,f.input.source.commit);assert.equal(evidence.result.authorityGranted,false);assert.equal(evidence.result.evidence.preparationDigest,ref.slice('preparation:'.length));
    const before=await f.request('lifecycle.instance.inspect',{instanceId:'scope-instance'});assert.equal(before.result.instance.stages.scope.status,'PASSED');assert.equal(before.result.instance.stages.plan.status,'PENDING');
    await f.restart();assert.deepEqual((await f.request('lifecycle.instance.inspect',{instanceId:'scope-instance'})).result.instance,before.result.instance);
    assert.equal((await f.request('lifecycle.stage.advance',{stageRequestId},true)).result.result.status,'TERMINAL');assert.equal(f.state.reads,1);
    assert.equal((await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:'plan'},true)).error.code,'STAGE_ADAPTER_UNAVAILABLE');
  }finally{await f.cleanup();}
});
test('changed source baseline never completes scope and cannot be retried as a replacement stage',async()=>{
  const f=await fixture();try{
    const ref=(await f.retain()).result.result.preparationRef;await f.instance(ref);f.state.commit='b'.repeat(40);
    const started=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:'scope'},true);assert.equal(started.status,200);const id=started.result.result.stageRequestId;
    let r;for(let i=0;i<80;i++){r=await f.request('lifecycle.stage.request.inspect',{stageRequestId:id});if(r.result.progress.phase==='UNKNOWN')break;await new Promise(r=>setTimeout(r,20));}
    assert.equal(r.result.progress.phase,'UNKNOWN');assert.equal(r.result.progress.reason,'PREPARATION_SOURCE_CHANGED');
    assert.equal((await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:'scope'},true)).error.code,'STAGE_BLOCKED');
    await f.restart();await new Promise(r=>setTimeout(r,1200));assert.equal(f.state.reads,1,'background inspection cannot complete an uncommitted scope or repeat source action');
  }finally{await f.cleanup();}
});
test('MCP uses the same preparation writer and cannot grant execution by submitting model-generated status',async()=>{
  const f=await fixture(),client=new Client({name:'synthetic-preparation-client',version:'1'});try{
    await client.connect(new StreamableHTTPClientTransport(new URL(f.server.url+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+f.tokens.fixture}}}));
    const status=await f.request('runtime.status',{}),result=await client.callTool({name:'runtime_write',arguments:{operation:'lifecycle.preparation.save',projectId:'alpha',input:f.input,requestId:'mcp-preparation',expectedRevision:status.result.revision}});assert.notEqual(result.isError,true);const value=JSON.parse(result.content[0].text).result.result;assert.equal(value.executionAuthorized,false);
    const changed=await client.callTool({name:'runtime_write',arguments:{operation:'lifecycle.preparation.save',projectId:'alpha',input:{...f.input,approved:true},requestId:'mcp-fake-approval',expectedRevision:status.result.revision+1}});assert.equal(changed.isError,true);
    const read=await f.request('lifecycle.preparation.read',{preparationRef:value.preparationRef});assert.equal(read.result.current,true);
  }finally{await client.close();await f.cleanup();}
});

async function waitStage(f,id,phase){
  let r;for(let i=0;i<180;i++){r=await f.request('lifecycle.stage.request.inspect',{stageRequestId:id});if(r.result.progress.phase===phase)return r.result;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('Expected '+phase+': '+JSON.stringify(r));
}
async function planStart(f){
  const ref=(await f.retain()).result.result.preparationRef;await f.instance(ref);
  const scope=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:'scope'},true);assert.equal(scope.status,200,JSON.stringify(scope));await waitStage(f,scope.result.result.stageRequestId,'COMPLETE');
  const plan=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:'plan'},true);assert.equal(plan.status,200,JSON.stringify(plan));return plan.result.result.stageRequestId;
}
test('plan uses exact material and native rules; scope and plan complete without seeded predecessors',async()=>{
  const f=await fixture({plan:true});try{
    const id=await planStart(f);await waitStage(f,id,'COMPLETE');assert.equal(f.calls.length,2);
    const observation=f.calls.find(c=>c.kind==='harness').request.input.observation;
    assert.deepEqual(observation.values.runtimePlan.target,f.input.target);assert.deepEqual(observation.values.runtimePlan.verification,f.input.verification);assert.equal(observation.values.tests,undefined,'never invent a test exit code');
    assert.equal(observation.values.runtimePlan.schema,'runtime-plan-observation/v1');assert(observation.collectionReceiptRef.digest);
    const evidence=await f.request('lifecycle.plan.evidence.read',{stageRequestId:id});assert.equal(evidence.status,200,JSON.stringify(evidence));assert(evidence.result.owners.harness.receipt);assert.equal(evidence.result.authorityGranted,false);assert.equal((await f.request('lifecycle.plan.evidence.read',{stageRequestId:id},false,'foreign')).status,403);
    const saved=await f.request('lifecycle.instance.inspect',{instanceId:'scope-instance'});assert.equal(saved.result.instance.stages.plan.status,'PASSED');assert.equal(saved.result.instance.stages.implementation.status,'PENDING');
    await f.restart();assert.deepEqual((await f.request('lifecycle.instance.inspect',{instanceId:'scope-instance'})).result.instance,saved.result.instance);assert.equal(f.calls.length,2);
    assert.equal((await f.request('lifecycle.stage.advance',{stageRequestId:id},true)).result.result.status,'TERMINAL');assert.equal(f.calls.length,2);
  }finally{await f.cleanup();}
});
test('failed plan owner rules cannot be hidden by accepted documents or a successful other owner',async()=>{
  const f=await fixture({plan:true});try{f.state.fail='harness';const id=await planStart(f),r=await waitStage(f,id,'FAILED');assert(r.progress.observation.outcome.checks.some(c=>c.status==='FAIL'));const saved=await f.request('lifecycle.instance.inspect',{instanceId:'scope-instance'});assert.equal(saved.result.instance.stages.plan.status,'FAILED');assert.equal((await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:'implementation'},true)).error.code,'STAGE_BLOCKED');}finally{await f.cleanup();}
});
for(const [control,reason] of [['missing','OWNER_REPORT_INCOMPLETE'],['context','OWNER_REPORT_MISMATCH']])test('plan rejects '+control+' native evidence without accepting a declared PASS',async()=>{
  const f=await fixture({plan:true});try{f.state[control]=true;const id=await planStart(f),r=await waitStage(f,id,'UNKNOWN');assert.equal(r.progress.reason,reason);assert.equal(f.calls.length,1);assert.notEqual((await f.request('lifecycle.instance.inspect',{instanceId:'scope-instance'})).result.instance.stages.plan.status,'PASSED');}finally{await f.cleanup();}
});
test('plan reconciles an original lost owner response and explicitly continues only the remaining action',async()=>{
  const f=await fixture({plan:true});try{
    f.state.lost='ontology';const id=await planStart(f);await waitStage(f,id,'UNKNOWN');assert.equal(f.calls.length,1);f.state.lost=null;await f.restart();await waitStage(f,id,'RUNNING');assert.equal(f.calls.length,1,'observer never dispatches next owner');
    const advanced=await f.request('lifecycle.stage.advance',{stageRequestId:id},true);assert.equal(advanced.status,200,JSON.stringify(advanced));await waitStage(f,id,'COMPLETE');assert.equal(f.calls.length,2);
  }finally{await f.cleanup();}
});
test('plan with an unknown owner outcome never blindly validates again',async()=>{
  const f=await fixture({plan:true});try{
    f.state.lost='ontology';f.state.beforeWrite=true;const id=await planStart(f);await waitStage(f,id,'UNKNOWN');f.state.lost=null;await f.restart();assert.equal((await f.request('lifecycle.stage.advance',{stageRequestId:id},true)).status,200);await waitStage(f,id,'UNKNOWN');assert.equal(f.calls.length,1);assert.equal((await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:'plan'},true)).error.code,'STAGE_BLOCKED');
  }finally{await f.cleanup();}
});
test('plan rechecks exact reviewed files between native actions; drift blocks subsequent writes',async()=>{
  const f=await fixture({plan:true});try{
    f.state.afterWrite=kind=>{if(kind==='ontology')writeFileSync(f.input.documents.plan.path,'Unreviewed plan bytes');};const id=await planStart(f),r=await waitStage(f,id,'UNKNOWN');assert.equal(r.progress.reason,'RESOURCE_CHANGED');assert.equal(f.calls.length,1);assert.equal((await f.request('lifecycle.stage.advance',{stageRequestId:id},true)).error.code,'RESOURCE_CHANGED');
  }finally{await f.cleanup();}
});
test('pending plan pins the actual validator manifest across service restart',async()=>{
  const f=await fixture({plan:true});try{
    f.state.lost='ontology';const id=await planStart(f);await waitStage(f,id,'UNKNOWN');f.state.lost=null;f.state.manifest=valueDigest('changed-tools');await f.restart();const r=await waitStage(f,id,'UNKNOWN');await new Promise(resolve=>setTimeout(resolve,1200));const current=await f.request('lifecycle.stage.request.inspect',{stageRequestId:id});assert.equal(current.result.progress.reason,'TOOLCHAIN_CHANGED');assert.equal(f.calls.length,1);
  }finally{await f.cleanup();}
});

for(const kind of ['ontology','harness'])test(kind+' extension uses its exact native owner, original predecessor and scoped evidence across restart',async()=>{
 const f=await fixture({plan:true,extensions:[kind]});try{
  const plan=await planStart(f);await waitStage(f,plan,'COMPLETE');assert.equal((await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:'implementation'},true)).error.code,'STAGE_BLOCKED');
  const submitted=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:f.data.extensions[0].id},true);assert.equal(submitted.status,200,JSON.stringify(submitted));const id=submitted.result.result.stageRequestId;await waitStage(f,id,'COMPLETE');assert.equal(f.calls.length,3);assert.equal(f.calls.at(-1).kind,kind);
  if(kind==='harness'){const observed=f.calls.at(-1).request.input.observation;assert.equal(observed.values.runtimeExtension.stageId,f.data.extensions[0].id);assert.equal(observed.values.runtimeExtension.source.commit,f.input.source.commit);assert.equal(observed.values.tests,undefined);assert.equal(observed.values.runtimeExtension.candidate,null);}
  const evidence=await f.request('lifecycle.extension.evidence.read',{stageRequestId:id});assert.equal(evidence.status,200,JSON.stringify(evidence));assert.equal(evidence.result.evidence.result.status,'PASS');assert.equal(evidence.result.releaseAuthorized,false);assert.equal((await f.request('lifecycle.extension.evidence.read',{stageRequestId:id},false,'foreign')).status,403);
  await f.restart();assert.deepEqual((await f.request('lifecycle.extension.evidence.read',{stageRequestId:id})).result,evidence.result);assert.equal((await f.request('lifecycle.stage.advance',{stageRequestId:id},true)).result.result.status,'TERMINAL');assert.equal(f.calls.length,3);
 }finally{await f.cleanup();}
});
for(const failure of ['fail','missing','context'])test('extension '+failure+' evidence blocks the original AND successor',async()=>{
 const f=await fixture({plan:true,extensions:['harness']});try{await waitStage(f,await planStart(f),'COMPLETE');f.state[failure]=failure==='fail'?'harness':true;const start=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:f.data.extensions[0].id},true);assert.equal(start.status,200,JSON.stringify(start));const r=await waitStage(f,start.result.result.stageRequestId,failure==='fail'?'FAILED':'UNKNOWN');assert.notEqual(r.progress.phase,'COMPLETE');assert.equal((await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:'implementation'},true)).error.code,'STAGE_BLOCKED');assert.equal(f.calls.length,3);}finally{await f.cleanup();}
});
for(const before of [true,false])test('extension lost response '+(before?'before':'after')+' owner effect preserves the original action across restart',async()=>{
 const f=await fixture({plan:true,extensions:['harness']});try{await waitStage(f,await planStart(f),'COMPLETE');f.state.lost='harness';f.state.beforeWrite=before;const start=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:f.data.extensions[0].id},true);assert.equal(start.status,200,JSON.stringify(start));const id=start.result.result.stageRequestId;await waitStage(f,id,'UNKNOWN');const original=f.calls.at(-1).request.requestId;f.state.lost=null;await f.restart();await waitStage(f,id,before?'UNKNOWN':'COMPLETE');if(before){const advanced=await f.request('lifecycle.stage.advance',{stageRequestId:id},true);assert.equal(advanced.status,200,JSON.stringify(advanced));await waitStage(f,id,'UNKNOWN');}assert.equal(f.calls.length,3);assert.equal(f.calls.at(-1).request.requestId,original);}finally{await f.cleanup();}
});
for(const variation of ['owner','criterion','mapping','toolchain'])test('extension rejects '+variation+' binding drift before further native effects',async()=>{
 const f=await fixture({plan:true,extensions:['harness']});try{await waitStage(f,await planStart(f),'COMPLETE');f.state.lost='harness';f.state.beforeWrite=true;const start=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:f.data.extensions[0].id},true);assert.equal(start.status,200,JSON.stringify(start));const id=start.result.result.stageRequestId;await waitStage(f,id,'UNKNOWN');f.state.lost=null;
  if(variation==='toolchain')f.state.manifest=valueDigest('changed-manifest');else{const e=f.data.extensions[0];if(variation==='owner')f.config.resources.find(r=>r.ref===e.parameters.checkRef).definition.owner='ontology';if(variation==='criterion')f.config.resources.find(r=>r.ref===e.requirementRefs[0]).definition.criterionId='another';if(variation==='mapping')f.config.resources.find(r=>r.ref===e.evidenceMappingRef).definition.rows=[];f.save();}
  await f.restart();const result=await f.request('lifecycle.stage.advance',{stageRequestId:id},true);if(variation==='toolchain'){assert.equal(result.status,200,JSON.stringify(result));let observed;for(let n=0;n<100;n++){observed=await f.request('lifecycle.stage.request.inspect',{stageRequestId:id});if(observed.result.progress.reason==='EXTENSION_PLAN_CHANGED')break;await new Promise(resolve=>setTimeout(resolve,20));}assert.equal(observed.result.progress.reason,'EXTENSION_PLAN_CHANGED');}else assert.equal(result.status,409,JSON.stringify(result));assert.equal(f.calls.length,3);
 }finally{await f.cleanup();}
});

for(const slot of ['after-plan','before-candidate','candidate-checks','before-release-decision'])for(const fail of [false,true])test(slot+' native extensions enforce every AND branch '+(fail?'with one failure':'until both pass'),async()=>{
 const f=await fixture({plan:true,extensions:['ontology','harness'],extensionSlot:slot});try{
  await waitStage(f,await planStart(f),'COMPLETE');const predecessors={'after-plan':[],'before-candidate':['implementation'],'candidate-checks':['implementation','candidate'],'before-release-decision':['implementation','candidate','verification']},successor={'after-plan':'implementation','before-candidate':'candidate','candidate-checks':'verification','before-release-decision':'release-decision'}[slot];
  for(const stageId of predecessors[slot]){const result=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId},true);assert.equal(result.status,200,JSON.stringify(result));await waitStage(f,result.result.result.stageRequestId,'COMPLETE');}
  assert.equal((await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:successor},true)).error.code,'STAGE_BLOCKED');
  let first=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:f.data.extensions[0].id},true);assert.equal(first.status,200,JSON.stringify(first));await waitStage(f,first.result.result.stageRequestId,'COMPLETE');
  assert.equal((await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:successor},true)).error.code,'STAGE_BLOCKED');if(fail)f.state.fail='harness';
  const second=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:f.data.extensions[1].id},true);assert.equal(second.status,200,JSON.stringify(second));await waitStage(f,second.result.result.stageRequestId,fail?'FAILED':'COMPLETE');
  const view=await f.request('lifecycle.extension.evidence.read',{stageRequestId:second.result.result.stageRequestId});assert.equal(view.result.request.plan.parameters.node.stage,slot);assert.equal(Boolean(view.result.request.plan.parameters.candidateInput),['candidate-checks','before-release-decision'].includes(slot));
  const next=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:successor},true);assert.equal(next.status,fail?409:200,JSON.stringify(next));if(fail)assert.equal(next.error.code,'STAGE_BLOCKED');
  assert.equal(f.calls.filter(c=>c.request.requestId.startsWith('extension-native-')).length,2);
 }finally{await f.cleanup();}
});

test('a consistently renamed but unpublished extension criterion cannot be blessed by native baseline PASS',async()=>{
 const f=await fixture({plan:true,extensions:['harness'],missingCriterion:true});try{await waitStage(f,await planStart(f),'COMPLETE');const e=f.data.extensions[0];const result=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:e.id},true);assert.equal(result.status,409,JSON.stringify(result));assert.equal(result.error.code,'EXTENSION_MAPPING');assert.equal(f.calls.length,2);}finally{await f.cleanup();}
});
for(const slot of ['before-candidate','candidate-checks'])test(slot+' extension cannot reuse an unknown native action after source drift',async()=>{
 const f=await fixture({plan:true,extensions:['harness'],extensionSlot:slot});try{await waitStage(f,await planStart(f),'COMPLETE');for(const stageId of slot==='before-candidate'?['implementation']:['implementation','candidate']){const start=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId},true);assert.equal(start.status,200,JSON.stringify(start));await waitStage(f,start.result.result.stageRequestId,'COMPLETE');}f.state.lost='harness';f.state.beforeWrite=true;const start=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:f.data.extensions[0].id},true);assert.equal(start.status,200,JSON.stringify(start));const id=start.result.result.stageRequestId;await waitStage(f,id,'UNKNOWN');f.state.commit='b'.repeat(40);f.state.lost=null;await f.restart();const advance=await f.request('lifecycle.stage.advance',{stageRequestId:id},true);assert.equal(advance.status,200,JSON.stringify(advance));let view;for(let n=0;n<100;n++){view=await f.request('lifecycle.stage.request.inspect',{stageRequestId:id});if(view.result.progress.reason==='EXTENSION_SOURCE_CHANGED')break;await new Promise(resolve=>setTimeout(resolve,20));}assert.equal(view.result.progress.reason,'EXTENSION_SOURCE_CHANGED');assert.equal(f.calls.length,3);}finally{await f.cleanup();}
});
test('actual Streamable MCP reads original extension evidence and cannot grant another project access',async()=>{
 const f=await fixture({plan:true,extensions:['harness']}),client=new Client({name:'synthetic-extension-reader',version:'1'});try{await waitStage(f,await planStart(f),'COMPLETE');const start=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:f.data.extensions[0].id},true);assert.equal(start.status,200,JSON.stringify(start));const id=start.result.result.stageRequestId;await waitStage(f,id,'COMPLETE');await client.connect(new StreamableHTTPClientTransport(new URL(f.server.url+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+f.tokens.fixture}}}));const result=await client.callTool({name:'runtime_read',arguments:{operation:'lifecycle.extension.evidence.read',projectId:'alpha',input:{stageRequestId:id}}});assert.notEqual(result.isError,true);const expected=await f.request('lifecycle.extension.evidence.read',{stageRequestId:id});assert.deepEqual(JSON.parse(result.content[0].text).result,expected.result);const foreign=await client.callTool({name:'runtime_read',arguments:{operation:'lifecycle.extension.evidence.read',projectId:'beta',input:{stageRequestId:id}}});assert.equal(foreign.isError,true);assert.equal(f.calls.length,3);}finally{await client.close();await f.cleanup();}
});

for(const kind of ['ontology','harness'])test(kind+' running extension receipt can complete the same original action after restart',async()=>{
 const f=await fixture({plan:true,extensions:[kind]});try{
  await waitStage(f,await planStart(f),'COMPLETE');f.state.pending=kind;
  const start=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:f.data.extensions[0].id},true);assert.equal(start.status,200,JSON.stringify(start));const id=start.result.result.stageRequestId;await waitStage(f,id,'UNKNOWN');
  const pending=await f.request('lifecycle.extension.evidence.read',{stageRequestId:id});assert.equal(pending.status,200,JSON.stringify(pending));assert.equal(pending.result.receipt.status,'RUNNING');assert.equal(pending.result.evidence.receiptTerminal,false);assert.equal(pending.result.evidence.result.status,'UNKNOWN');
  assert.equal((await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:'implementation'},true)).error.code,'STAGE_BLOCKED');
  await f.restart();assert.deepEqual((await f.request('lifecycle.extension.evidence.read',{stageRequestId:id})).result,pending.result);f.state.pending=null;await waitStage(f,id,'COMPLETE');
  const complete=await f.request('lifecycle.extension.evidence.read',{stageRequestId:id});assert.equal(complete.status,200,JSON.stringify(complete));assert.equal(complete.result.evidence.receiptTerminal,true);assert.equal(complete.result.evidence.result.status,'PASS');assert.equal(complete.result.action.digest,pending.result.action.digest);assert.equal(f.calls.length,3);
 }finally{await f.cleanup();}
});

async function reviewStart(f,slot='after-plan'){
 await waitStage(f,await planStart(f),'COMPLETE');for(const stageId of ({'after-plan':[],'before-candidate':['implementation'],'candidate-checks':['implementation','candidate'],'before-release-decision':['implementation','candidate','verification']})[slot]){const s=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId},true);assert.equal(s.status,200,JSON.stringify(s));await waitStage(f,s.result.result.stageRequestId,'COMPLETE');}
 const s=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:f.data.extensions[0].id},true);assert.equal(s.status,200,JSON.stringify(s));const id=s.result.result.stageRequestId;await waitStage(f,id,'RUNNING');return id;
}
async function reviewDecision(f,id,choice='APPROVE',actor='reviewer'){
 const p=await f.request('lifecycle.extension.review.preview',{stageRequestId:id},false,actor);assert.equal(p.status,200,JSON.stringify(p));const evidenceRef=syntheticDecisionEvidence(f.dir,{owner:'runtime',operation:'lifecycle.extension.review',workspaceId:'synthetic',scope:{visibility:'private',projectId:'alpha'},reviewDigest:p.result.reviewDigest,decision:choice});const d=await f.request('lifecycle.extension.review.record',{stageRequestId:id,reviewDigest:p.result.reviewDigest,decision:choice,evidenceRef},true,actor);assert.equal(d.status,200,JSON.stringify(d));return{preview:p,decision:d,evidenceRef};
}
for(const slot of ['after-plan','before-candidate','candidate-checks','before-release-decision'])for(const choice of ['APPROVE','REJECT'])test(slot+' exact scope '+choice+' controls its original AND successor',async()=>{
 const f=await fixture({plan:true,extensions:['review'],extensionSlot:slot});try{
  const id=await reviewStart(f,slot),successor=({'after-plan':'implementation','before-candidate':'candidate','candidate-checks':'verification','before-release-decision':'release-decision'})[slot];assert.equal((await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:successor},true)).error.code,'STAGE_BLOCKED');
  const d=await reviewDecision(f,id,choice);assert.equal(d.preview.result.facts.node.stage,slot);assert.equal(Boolean(d.preview.result.facts.candidateInput),['candidate-checks','before-release-decision'].includes(slot));assert.equal(d.decision.result.result.releaseAuthorized,false);await waitStage(f,id,choice==='APPROVE'?'COMPLETE':'FAILED');
  const view=await f.request('lifecycle.extension.evidence.read',{stageRequestId:id});assert.equal(view.status,200,JSON.stringify(view));assert.equal(view.result.decision.choice,choice);assert.equal(view.result.decision.ref,d.decision.result.result.reviewRef);assert.equal(f.calls.length,2,'scope review does not mutate owner assets or native validations');
  await f.restart();assert.deepEqual((await f.request('lifecycle.extension.evidence.read',{stageRequestId:id})).result,view.result);const next=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:successor},true);assert.equal(next.status,choice==='APPROVE'?200:409,JSON.stringify(next));
 }finally{await f.cleanup();}
});
test('scope review needs a configured current reviewer and exact retained decision evidence',async()=>{
 const f=await fixture({plan:true,extensions:['review']});try{const id=await reviewStart(f),p=await f.request('lifecycle.extension.review.preview',{stageRequestId:id},false,'other-decider'),input={stageRequestId:id,reviewDigest:p.result.reviewDigest,decision:'APPROVE',evidenceRef:'synthetic:no-decision'};
  assert.equal((await f.request('lifecycle.extension.review.record',input,true,'other-decider')).error.code,'EXTENSION_REVIEWER');assert.equal((await f.request('lifecycle.extension.review.record',input,true,'reader')).status,403);
  const own=await f.request('lifecycle.extension.review.preview',{stageRequestId:id});input.reviewDigest=own.result.reviewDigest;assert.equal((await f.request('lifecycle.extension.review.record',input,true)).error.code,'DECISION_EVIDENCE_REQUIRED');assert.equal((await f.request('lifecycle.extension.review.record',{...input,decision:'PASS'},true)).error.code,'INVALID_DECISION');assert.equal((await f.request('lifecycle.extension.review.record',{...input,reviewDigest:valueDigest('different')},true)).error.code,'EXTENSION_REVIEW_STALE');assert.equal((await f.request('lifecycle.extension.review.preview',{stageRequestId:id},false,'foreign')).status,403);assert.equal(f.calls.length,2);
 }finally{await f.cleanup();}
});
test('lost scope decision response replays the exact receipt and cannot replace a terminal decision',async()=>{
 const f=await fixture({plan:true,extensions:['review']});try{const id=await reviewStart(f),d=await reviewDecision(f,id);await waitStage(f,id,'COMPLETE');await f.restart();const e=d.decision.envelope,replay=await f.request(e.operation,e.input,true,'reviewer',{requestId:e.requestId,expectedRevision:e.expectedRevision});assert.deepEqual(replay.result,d.decision.result);const replacement=await f.request(e.operation,e.input,true,'reviewer');assert.equal(replacement.error.code,'EXTENSION_REVIEW_CLOSED');assert.equal((await f.request('lifecycle.extension.review.inspect',{reviewRef:d.decision.result.result.reviewRef})).result.usable,true);}finally{await f.cleanup();}
});
test('revoking a completed scope review retains history and blocks the next stage',async()=>{
 const f=await fixture({plan:true,extensions:['review']});try{const id=await reviewStart(f),d=await reviewDecision(f,id);await waitStage(f,id,'COMPLETE');const ref=d.decision.result.result.reviewRef,revoke=await f.request('lifecycle.extension.review.revoke',{reviewRef:ref,reason:'Synthetic changed scope'},true,'reviewer');assert.equal(revoke.status,200,JSON.stringify(revoke));await f.restart();const view=await f.request('lifecycle.extension.review.inspect',{reviewRef:ref});assert.equal(view.result.usable,false);assert.equal(view.result.reason,'EXTENSION_REVIEW_REVOKED');const next=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:'implementation'},true);assert.equal(next.error.code,'EXTENSION_REVIEW_REVOKED');assert.equal((await f.request('lifecycle.instance.inspect',{instanceId:'scope-instance'})).result.instance.stages[f.data.extensions[0].id].status,'PASSED');assert.equal((await f.request('lifecycle.extension.evidence.read',{stageRequestId:id})).result.decision.choice,'APPROVE');}finally{await f.cleanup();}
});
test('source drift after scope approval blocks candidate admission without rewriting the original decision',async()=>{
 const f=await fixture({plan:true,extensions:['review'],extensionSlot:'before-candidate'});try{const id=await reviewStart(f,'before-candidate'),d=await reviewDecision(f,id);await waitStage(f,id,'COMPLETE');f.state.commit='b'.repeat(40);const next=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:'candidate'},true);assert.equal(next.error.code,'EXTENSION_REVIEW_STALE');const historical=await f.request('lifecycle.extension.review.inspect',{reviewRef:d.decision.result.result.reviewRef});assert.equal(historical.result.usable,false);assert.equal(historical.result.decision.choice,'APPROVE');}finally{await f.cleanup();}
});
test('MCP scope review uses the same exact subject and authenticated decision workflow as HTTP',async()=>{
 const f=await fixture({plan:true,extensions:['review']}),client=new Client({name:'synthetic-reviewer',version:'1'});try{const id=await reviewStart(f);await client.connect(new StreamableHTTPClientTransport(new URL(f.server.url+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+f.tokens.reviewer}}}));const preview=await client.callTool({name:'runtime_read',arguments:{operation:'lifecycle.extension.review.preview',projectId:'alpha',input:{stageRequestId:id}}});assert.notEqual(preview.isError,true);const p=JSON.parse(preview.content[0].text).result,http=await f.request('lifecycle.extension.review.preview',{stageRequestId:id},false,'reviewer');assert.deepEqual(p,http.result);
  const evidenceRef=syntheticDecisionEvidence(f.dir,{owner:'runtime',operation:'lifecycle.extension.review',workspaceId:'synthetic',scope:{visibility:'private',projectId:'alpha'},reviewDigest:p.reviewDigest,decision:'APPROVE'}),status=await f.request('runtime.status');const write=await client.callTool({name:'runtime_write',arguments:{operation:'lifecycle.extension.review.record',projectId:'alpha',requestId:'mcp-scope-decision',expectedRevision:status.result.revision,input:{stageRequestId:id,reviewDigest:p.reviewDigest,decision:'APPROVE',evidenceRef}}});assert.notEqual(write.isError,true,JSON.stringify(write));await waitStage(f,id,'COMPLETE');const foreign=await client.callTool({name:'runtime_read',arguments:{operation:'lifecycle.extension.review.preview',projectId:'beta',input:{stageRequestId:id}}});assert.equal(foreign.isError,true);assert.equal(f.calls.length,2);
 }finally{await client.close();await f.cleanup();}
});

test('reviewer revocation during source observation prevents an old approval from advancing',async()=>{
 const f=await fixture({plan:true,extensions:['review']});try{const id=await reviewStart(f),d=await reviewDecision(f,id);await waitStage(f,id,'COMPLETE');let changed=false;f.state.onTree=()=>{if(changed)return;changed=true;const path=join(f.root,'auth.json'),auth=JSON.parse(readFileSync(path));auth.principals.find(p=>p.id==='reviewer').revision++;writeFileSync(path,JSON.stringify(auth),{mode:0o600});};const next=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:'implementation'},true);assert.equal(next.error.code,'EXTENSION_REVIEWER_CHANGED',JSON.stringify(next));assert.equal(changed,true);const view=await f.request('lifecycle.extension.review.inspect',{reviewRef:d.decision.result.result.reviewRef});assert.equal(view.result.usable,false);assert.equal(view.result.reason,'EXTENSION_REVIEWER_CHANGED');}finally{await f.cleanup();}
});

test('revocation during successor execution prevents its successful outcome from committing',async()=>{
 const f=await fixture({plan:true,extensions:['review']});try{const id=await reviewStart(f),d=await reviewDecision(f,id);await waitStage(f,id,'COMPLETE');let revoked=false;f.state.beforeBaseOutcome=async r=>{if(r.stageId!=='implementation'||revoked)return;revoked=true;const result=await f.request('lifecycle.extension.review.revoke',{reviewRef:d.decision.result.result.reviewRef,reason:'Synthetic concurrent revocation'},true,'reviewer');assert.equal(result.status,200,JSON.stringify(result));};const started=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:'implementation'},true);assert.equal(started.status,200,JSON.stringify(started));const pending=await waitStage(f,started.result.result.stageRequestId,'UNKNOWN');assert.equal(pending.progress.reason,'EXTENSION_REVIEW_REVOKED');assert.equal(revoked,true);assert.notEqual((await f.request('lifecycle.instance.inspect',{instanceId:'scope-instance'})).result.instance.stages.implementation.status,'PASSED');}finally{await f.cleanup();}
});
test('an approved pre-candidate scope remains its original subject while later candidate identity is added',async()=>{
 const f=await fixture({plan:true,extensions:['review']});try{const id=await reviewStart(f),d=await reviewDecision(f,id);await waitStage(f,id,'COMPLETE');for(const stageId of ['implementation','candidate','verification']){const s=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId},true);assert.equal(s.status,200,JSON.stringify(s));await waitStage(f,s.result.result.stageRequestId,'COMPLETE');}const current=await f.request('lifecycle.extension.review.preview',{stageRequestId:id},false,'reviewer');assert.equal(current.status,200,JSON.stringify(current));assert.equal(current.result.reviewDigest,d.preview.result.reviewDigest);assert.equal(current.result.facts.candidateInput,null);assert((await f.request('lifecycle.instance.inspect',{instanceId:'scope-instance'})).result.instance.candidateDigest);}finally{await f.cleanup();}
});
test('a scope reviewer may decide with read and decision permissions without gaining execution authority',async()=>{
 const f=await fixture({plan:true,extensions:['review']});try{const id=await reviewStart(f),path=join(f.root,'auth.json'),auth=JSON.parse(readFileSync(path));auth.principals.find(p=>p.id==='reviewer').permissions=['read','decision.record'];writeFileSync(path,JSON.stringify(auth),{mode:0o600});const d=await reviewDecision(f,id);await waitStage(f,id,'COMPLETE');assert.equal(d.decision.result.result.executionAuthorized,false);const run=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:'implementation'},true,'reviewer');assert.equal(run.status,403);assert.equal((await f.request('lifecycle.extension.review.inspect',{reviewRef:d.decision.result.result.reviewRef},false,'reviewer')).result.usable,true);}finally{await f.cleanup();}
});

test('a superseded rejection cannot commit a stale terminal failure during review observation',async()=>{
 const f=await fixture({plan:true,extensions:['review']});try{const id=await reviewStart(f);let replacement=null;f.state.afterReviewOutcome=async result=>{if(result.phase!=='FAILED'||replacement)return;replacement='in-flight';replacement=await reviewDecision(f,id,'APPROVE');};const rejected=await reviewDecision(f,id,'REJECT');const stale=await waitStage(f,id,'UNKNOWN');assert.equal(stale.progress.reason,'EXTENSION_REVIEW_REVOKED');await waitStage(f,id,'COMPLETE');assert(replacement&&replacement!=='in-flight');const old=await f.request('lifecycle.extension.review.inspect',{reviewRef:rejected.decision.result.result.reviewRef});assert.equal(old.result.usable,false);assert.equal(old.result.decision.choice,'REJECT');const current=await f.request('lifecycle.extension.evidence.read',{stageRequestId:id});assert.equal(current.result.decision.ref,replacement.decision.result.result.reviewRef);assert.equal(current.result.decision.choice,'APPROVE');}finally{await f.cleanup();}
});

test('service stop cancels a pending review guard and restart observes the original successor request',async()=>{
 const f=await fixture({plan:true,extensions:['review']});try{const id=await reviewStart(f);await reviewDecision(f,id);await waitStage(f,id,'COMPLETE');let observing=false,aborted=false;f.state.beforeBaseOutcome=()=>{f.state.onTree=signal=>new Promise(resolve=>{observing=true;signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true});if(signal.aborted){aborted=true;resolve();}});};const next=await f.request('lifecycle.stage.request',{instanceId:'scope-instance',stageId:'implementation'},true);assert.equal(next.status,200,JSON.stringify(next));for(let n=0;n<100&&!observing;n++)await new Promise(r=>setTimeout(r,20));assert.equal(observing,true);const at=Date.now();await f.server.close();assert(Date.now()-at<2500,'shutdown must cancel its current read rather than wait for a new provider timeout');assert.equal(aborted,true);f.state.onTree=null;f.state.beforeBaseOutcome=null;await f.restart();await waitStage(f,next.result.result.stageRequestId,'COMPLETE');const stage=(await f.request('lifecycle.instance.inspect',{instanceId:'scope-instance'})).result.instance.stages.implementation;assert.equal(stage.requestId,next.result.result.stageRequestId);assert.equal(stage.attempts,1);}finally{await f.cleanup();}
});
