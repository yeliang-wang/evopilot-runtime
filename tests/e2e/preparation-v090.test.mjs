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
import {byteDigest,valueDigest} from '../../dist/lifecycle/base.js';
import {requiredChecksDigest} from '../../dist/lifecycle/instance.js';
import {compileLifecycle} from '../../dist/lifecycle/compiler.js';
import {registeredAuthorityPolicy} from '../../dist/adapters/authority.js';
import {registeredPreparation,createScopeStageAdapter,createPlanStageAdapter} from '../../dist/adapters/preparation-stages.js';
import {lifecycleBindingExample} from '../fixtures/adapters-v090.mjs';
import {syntheticBindings,yaml} from '../fixtures/lifecycle-v090.mjs';
import {syntheticDecisionEvidence} from '../fixtures/native/decision-evidence.mjs';
import {ServiceError} from '../../dist/server/errors.js';
import {nativeSha256,NATIVE_CONTRACT_DIGEST} from '../../vendor/compatibility/v1/native.mjs';

// The actual HTTP/store/policy/scope adapters are exercised with explicit
// synthetic asset admission and a read-only synthetic source platform.
async function fixture({plan=false}={}){
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'runtime-preparation-')),root=join(dir,'state'),workspaceId='synthetic',projectId='alpha',path=join(dir,'integrations.json'),expiry='2030-01-01T00:00:00Z';
  const pin=owner=>({product:owner,id:'synthetic-'+owner,version:'1.0.0',specVersion:'v1',visibility:'private',digest:valueDigest(owner),standardDigest:valueDigest(owner+'-standard'),standardLockDigest:valueDigest(owner+'-lock'),producer:{product:owner,version:'0.3.0'},contractDigest:NATIVE_CONTRACT_DIGEST});
  const platform={ref:'binding:alpha/platform',workspaceId,projectId,provider:'github',host:'https://github.com',repository:'synthetic/project',repositoryId:'42',defaultBranch:'main',credentialRef:'credential:alpha/platform',revision:1,expiresAt:expiry,workflowPath:'.github/workflows/build.yml',runner:'ubuntu-latest'};
  const credentials={ref:platform.credentialRef,workspaceId,projectId,provider:platform.provider,host:platform.host,tokenFile:join(dir,'unused-token'),revision:1,expiresAt:expiry},owners=['ontology','harness'].map(owner=>({ref:'binding:alpha/'+owner,owner,packageRoot:dir,workspaceRoot:dir,workspaceId,projects:[projectId]}));
  const {configuration:config,data}=lifecycleBindingExample({root:dir,workspaceId,projectId,platform,credential:credentials,ownerRegistrations:owners,references:{ontology:pin('ontology'),harness:pin('harness')},assessmentId:'synthetic'});
  if(plan)data.config.plan.budget.timeoutSeconds=60; // Explicit synthetic recovery budget; no production grant is changed.
  config.resources.find(r=>r.role==='config.release-decision.authorityPolicyRef').definition.principalIds.push('other-decider');
  const save=()=>writeFileSync(path,JSON.stringify(config),{mode:0o600});save();
  const tokens=Object.fromEntries(['fixture','reader','other-decider','foreign'].map(id=>[id,randomBytes(32).toString('hex')]));
  const all=['read','draft.write','definition.activate','decision.record','execution.request'];
  initializeCredentials(root,workspaceId,Object.entries(tokens).map(([id,token])=>({id,projects:[id==='foreign'?'beta':projectId],permissions:id==='reader'||id==='foreign'?['read']:all,revision:1,expiresAt:expiry,tokenDigest:tokenDigest(token)})));
  const state={commit:'a'.repeat(40),reads:0,fail:null,missing:false,context:false,lost:null,beforeWrite:false,afterWrite:null,manifest:valueDigest('toolchain-manifest')},calls=[],receipts=new Map(),toolchainLockDigest=valueDigest('toolchain-lock'),effectiveConfigDigest=valueDigest('native-config'),bindings=syntheticBindings(),validator=registeredPreparation(path,workspaceId),policy=registeredAuthorityPolicy(path,workspaceId);
  const client={readiness:async()=>{state.reads++;return{provider:platform.provider,projectId,repositoryId:platform.repositoryId,bindingDigest:valueDigest(platform),commit:state.commit,factsDigest:valueDigest({commit:state.commit}),expiresAt:new Date(Date.now()+60000).toISOString()};}};
  const ownerAdapters=Object.fromEntries(['ontology','harness'].map(kind=>['binding:alpha/'+kind,{owner:kind,workspaceId,capabilities:()=>({registrationDigest:valueDigest(kind+'registration')}),
    readPackage:async()=>{const body={reference:pin('harness'),qualityStatus:'PASS',effectiveConfigDigest};return kind==='ontology'?{package:{manifest:{entrypoints:{cases:'cases.json'}},files:{'cases.json':JSON.stringify({cases:[{id:'positive',requirementIds:['scope']}]})}}}:{validation:{...body,reportDigest:nativeSha256(body)},package:{manifest:{entrypoints:{coverage:'coverage.json'}},files:{'coverage.json':JSON.stringify({requirements:[{id:'requirement-H001',caseIds:['positive']}]})}}};},
    read:async(_a,_p,r)=>{if(r.operation==='workspace.inspect')return{revision:0};const receipt=receipts.get(r.input.requestId);if(!receipt)throw new ServiceError('NOT_FOUND','Synthetic missing native receipt',404);return structuredClone(receipt);},
    mutate:async(_a,_p,r)=>{
      calls.push({kind,request:r});const stored=activeStore.object(projectId,'plan-stage-native-action',activeRequest+':'+kind);assert(stored,'native action must be durable before any effect');
      if(state.lost===kind&&state.beforeWrite)throw new ServiceError('SYNTHETIC_RESPONSE_LOST','Synthetic loss before owner result',503);
      const criteria=(kind==='ontology'?[{criterionId:'scope',variantId:'positive'}]:[{criterionId:'requirement-H001',variantId:'positive'},{criterionId:'requirement-H001',variantId:'actual-observation'}]).map(x=>({...x,status:state.fail===kind?'FAIL':'PASS',evidenceDigest:valueDigest(x)}));if(state.missing)criteria.pop();
      const context=state.context?{...r.input.context,inputDigest:valueDigest('wrong')}:r.input.context;
      const body={context,toolchainLockDigest,criteria,...(kind==='ontology'?{status:state.fail===kind?'NONCONFORMING':'CONFORMS',packageDigest:pin(kind).digest,standardPins:{standardDigest:pin(kind).standardDigest,standardLockDigest:pin(kind).standardLockDigest}}:{reference:pin(kind),qualityStatus:state.fail===kind?'FAIL':'PASS',executionStatus:'SUCCEEDED',effectiveConfigDigest,observationDigest:nativeSha256(r.input.observation)})};
      receipts.set(r.requestId,{requestId:r.requestId,operation:r.operation,scope:r.scope,requestDigest:nativeSha256({operation:r.operation,scope:r.scope,input:r.input}),result:{...body,reportDigest:nativeSha256(body)}});
      state.afterWrite?.(kind);if(state.lost===kind)throw new ServiceError('SYNTHETIC_RESPONSE_LOST','Synthetic lost response after persisted owner result',503);
    },
  }]));
  let server,sequence=0,activeStore,activeRequest;const start=async()=>server=await startRuntimeServer({stateRoot:root,workspaceId},bindings.provider,undefined,policy,store=>{
    activeStore=store;const scope=createScopeStageAdapter(store,path,{platform:()=>client});if(!plan)return scope;
    const adapter=createPlanStageAdapter(store,path,{platform:()=>client,owner:ref=>ownerAdapters[ref],toolchainLockDigest,toolchainManifestDigest:state.manifest});
    return{prepare:(i,s,...a)=>(s==='scope'?scope:adapter).prepare(i,s,...a),dispatch:(r,...a)=>{activeRequest=r.id;return(r.stageId==='scope'?scope:adapter).dispatch(r,...a);},inspect:(r,...a)=>(r.stageId==='scope'?scope:adapter).inspect(r,...a),advance:(r,...a)=>{activeRequest=r.id;return(r.stageId==='scope'?scope:adapter).advance(r,...a);}};
  },validator);await start();
  async function request(operation,input={},write=false,actor='fixture',meta){
    if(write&&!meta){const status=await request('runtime.status',{},false,actor);meta={requestId:'prep-'+(++sequence),expectedRevision:status.result.revision};}
    const envelope={operation,projectId,input,...(meta??{})},response=await fetch(server.url+'/api/v1/request',{method:'POST',headers:{authorization:'Bearer '+tokens[actor],'content-type':'application/json'},body:JSON.stringify(envelope)});
    return{status:response.status,...await response.json(),envelope};
  }
  const source=yaml(data),validated=await request('lifecycle.definition.validate',{yaml:source});assert.equal(validated.result.ready,true);
  const activated=await request('lifecycle.definition.save-and-activate',{yaml:source,validationDigest:validated.result.validationDigest},true);assert.equal(activated.status,200,JSON.stringify(activated));const definitionRevisionId=activated.result.result.revisionId,definition=compileLifecycle(source,projectId).effective;
  const file=name=>{const p=join(dir,name+'.md');writeFileSync(p,'Synthetic reviewed '+name+' procedure; no production or release authority.\n',{mode:0o600});return{path:p,digest:byteDigest(readFileSync(p))};};
  const input={definitionRevisionId,goalRef:'synthetic:goal/scope',loopRef:'synthetic:loop/one',target:{id:'scope-probe',version:'0.9.0-preview.1',title:'Synthetic scope preparation',scope:['One bounded synthetic read'],exclusions:['Real project semantics and release']},source:{provider:'github',repositoryId:'42',commit:state.commit},compatibility:'compatible',documents:{plan:file('plan'),impact:file('impact'),verification:file('verification'),rollback:file('rollback'),migration:null},verification:{requirementsDigest:requiredChecksDigest(definition),checks:definition.nodes.flatMap(n=>n.checks.map(checkId=>({stageId:n.id,checkId,source:'owner-receipt',procedure:'Evaluate the exact pinned synthetic rule and retain its own evidence.'})))}};
  async function retain(value=input){const r=await request('lifecycle.preparation.save',value,true);assert.equal(r.status,200,JSON.stringify(r));return r;}
  function subject(ref,id='scope-instance'){return{instanceId:id,definitionRevisionId,goalRef:input.goalRef,targetRef:ref,loopRef:input.loopRef,budget:data.config.plan.budget,expiresAt:new Date(Date.now()+3600000).toISOString()};}
  async function grant(ref,id='scope-instance'){
    const s=subject(ref,id),preview=await request('lifecycle.authority.preview',{kind:'execution',subject:s});assert.equal(preview.status,200,JSON.stringify(preview));
    const evidenceRef=syntheticDecisionEvidence(dir,{owner:'runtime',operation:'lifecycle.authority.execution',workspaceId,scope:{visibility:'private',projectId},reviewDigest:preview.result.reviewDigest,decision:'APPROVE'});
    const g=await request('lifecycle.authority.record',{kind:'execution',subject:s,reviewDigest:preview.result.reviewDigest,decision:'APPROVE',evidenceRef},true);assert.equal(g.status,200,JSON.stringify(g));return{ref:g.result.result.authorityRef,preview,subject:s};
  }
  async function instance(ref){const g=await grant(ref),r=await request('lifecycle.instance.create',{instanceId:g.subject.instanceId,definitionRevisionId,authorityRef:g.ref},true);assert.equal(r.status,200,JSON.stringify(r));return g;}
  return{dir,root,path,config,data,input,definition,definitionRevisionId,tokens,state,calls,receipts,request,retain,subject,grant,instance,save,get server(){return server;},async restart(){await server.close();await start();},async cleanup(){await server.close();rmSync(dir,{recursive:true,force:true});}};
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
