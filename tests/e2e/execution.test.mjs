import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,realpathSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createRuntimeService } from '../../src/service.mjs';
import { operate, resolveMaterials } from '../../src/operations.mjs';
import { claimRun, invoke, receiptOutcome } from '../../src/execution.mjs';
import { validateState, LIMITS } from '../../src/state.mjs';
import { sha256, frozenClone } from '../../vendor/compatibility/v1/reference.mjs';

const digest='sha256:'+'a'.repeat(64),scope={visibility:'private',projectId:'alpha'};
const ref=product=>({product,id:product,version:'0.1.0',specVersion:'v1',visibility:'public',digest});
const input={schema:'runtime-composition/v1',ontologyInstance:{entities:[{id:'Asset:1',conceptRef:'domain/Asset@1',properties:{'quality.score':[0.75],'Lifecycle':['READY'],'description':['$(echo inert)',null,true]}}],relations:[{id:'Relation:1',relationRef:'domain/related@1',from:'Asset:1',to:'Asset:1'}]},harness:{mode:'component',evidence:{id:'evidence:1',version:'1.0.0',source:{locator:'file:///inert/descriptor',revision:'revision:1',digest},values:{score:0.75}},configuration:{threshold:0.5}}};
const resolver=({reference,workspace})=>({reference,workspace,scope:{visibility:'public',projectId:'shared'},published:true,materialDigest:digest,descriptor:{kind:reference.product+'-composition/v1',digest}});
const receipt=claim=>({claimId:claim.claimId,inputDigest:claim.inputDigest,pins:claim.pins,providerReceiptId:'synthetic-receipt',status:'SUCCEEDED',result:{evaluation:'FAIL',evidenceDigest:digest}});
// Pure boundary fixtures exercise the real operations without opening SQLite.
function boundary(runScope=scope) {
  const store={identity:{schema:'evopilot-workspace/v1',id:'test',canonicalRoot:'/inert/workspace',ownerUid:1},uid:1};
  const state={projects:[{scope:runScope,name:'Alpha'}],goals:[{scope:runScope,id:'goal',description:'Evaluate instance',revision:1}],runs:[]};
  const providers={resolveOntology:resolver,resolveHarness:resolver,execute:receipt};
  const prepare=(value=input)=>operate(store,state,{operation:'run.prepare',scope:runScope,input:{id:'run',goalId:'goal',ontology:ref('ontology'),harness:ref('harness'),input:value}},providers,1);
  const approve=run=>operate(store,state,{operation:'run.decide',scope:runScope,input:{id:'run',reviewDigest:run.reviewDigest,decision:'APPROVE',humanEvidenceRef:'human:fixture'}},providers,2);
  return {store,state,providers,prepare,approve};
}
test('boundary: public project scope and exact workspace/pins precede claim',()=>{
  for (const visibility of ['public','private']) for (const projectId of ['alpha','shared','unrelated']) {
    const f=boundary({visibility,projectId:'alpha'});
    f.providers.resolveHarness=r=>({...resolver(r),scope:{visibility:'public',projectId}});
    if (projectId==='unrelated') { const before=structuredClone(f.state);assert.throws(f.prepare,{code:'MATERIAL_SCOPE'});assert.deepEqual(f.state,before); }
    else {const run=f.prepare();f.approve(run);assert.equal(claimRun(f.store,f.state,run,f.providers),true);}
  }
  for (const change of [r=>({...resolver(r),workspace:{...r.workspace,id:'elsewhere'}}),r=>({...resolver(r),reference:{...r.reference,version:'9.0.0'}}),r=>({...resolver(r),scope:{visibility:'private',projectId:'other'},reference:{...r.reference,visibility:'private'}})]) {
    const f=boundary();const run=f.prepare();f.approve(run);const before=structuredClone(f.state);
    f.providers.resolveOntology=change;assert.throws(()=>claimRun(f.store,f.state,run,f.providers));assert.deepEqual(f.state,before);
  }
  for (const visibility of ['public','private']) {
    const f=boundary({visibility,projectId:'alpha'}),plan={workspace:f.store.identity,scope:{visibility,projectId:'alpha'},pins:{ontology:{...ref('ontology'),visibility:'private'},harness:ref('harness')}};
    f.providers.resolveOntology=r=>({...resolver(r),scope:{visibility:'private',projectId:'alpha'}});
    if (visibility==='private') assert.equal(resolveMaterials(f.providers,plan).ontology.scope.projectId,'alpha');
    else assert.throws(()=>resolveMaterials(f.providers,plan),{code:'MATERIAL_SCOPE'});
  }
});
test('boundary: native component/composed payload is unchanged and frozen at provider',async()=>{
  for (const mode of ['component','composed']) {
    const value=structuredClone(input);
    if(mode==='composed') value.harness={mode,evidence:{'harness:Component@1.0.0':value.harness.evidence},configuration:{'harness:Component@1.0.0':{threshold:0.5}}};
    const f=boundary(),run=f.prepare(value);f.approve(run);claimRun(f.store,f.state,run,f.providers);
    const outcome=await invoke(c=>{assert.deepEqual(c.input,value);assert(Object.isFrozen(c.input.harness.configuration));assert(Object.isFrozen(c.input.ontologyInstance.entities[0].properties['quality.score']));return {...receipt(c),result:{evaluation:'INDETERMINATE',evidenceDigest:digest}};},run.claim,100,new Set());
    assert.equal(outcome.status,'SUCCEEDED');assert.equal(outcome.receipt.result.evaluation,'INDETERMINATE');
    run.stage=outcome.status;run.outcome=outcome;assert.deepEqual(validateState(JSON.parse(JSON.stringify(f.state))),f.state);
  }
});
test('boundary: malformed native envelopes and synthetic new inputs are refused',()=>{
  const changes=[v=>{v.command='echo unsafe';},v=>{v.providerUrl='https://inert.invalid';},v=>{v.ontologyInstance.facts=[];},v=>{v.ontologyInstance.entities={};},v=>{v.ontologyInstance.entities[0].properties.score=[{}];},v=>{v.ontologyInstance.relations[0].command='x';},v=>{v.harness.config={mode:'evaluate'};},v=>{delete v.harness.mode;},v=>{v.harness.mode='other';},v=>{v.harness.configuration=[];},v=>{v.harness.evidence.source.command='x';},v=>{v.harness.evidence.values=[];},v=>{v.harness.evidence={};},v=>{v.harness.configuration.callback=()=>{};},v=>{v.harness.configuration.huge='x'.repeat(LIMITS.requestBytes);},v=>{v.ontologyInstance={facts:[{id:'fact',value:true}]};v.harness={evidence:[],config:{mode:'evaluate'}};}];
  for (const change of changes) { const f=boundary(),value=structuredClone(input);change(value);assert.throws(()=>f.prepare(value));assert.equal(f.state.runs.length,0); }
});
test('boundary: existing synthetic stored input remains readable without migration',()=>{
  const f=boundary(),run=f.prepare();
  run.plan.input={schema:'runtime-composition/v1',ontologyInstance:{facts:[{id:'fact',value:true}]},harness:{evidence:[],config:{mode:'evaluate'}}};
  run.reviewDigest=sha256(run.plan);
  const before=frozenClone(f.state);assert.deepEqual(validateState(f.state),before);
  assert.deepEqual(operate(f.store,f.state,{operation:'run.inspect',scope,input:{id:'run'}},f.providers,2).plan.input,before.runs[0].plan.input);
  assert.deepEqual(f.state,before);
});
test('boundary: closed aggregate results retain business status and exact receipt binding',()=>{
  const f=boundary(),run=f.prepare();f.approve(run);claimRun(f.store,f.state,run,f.providers);
  for (const evaluation of ['PASS','FAIL','ERROR','INDETERMINATE','N/A','NOT_CHECKED','NOT_EVALUATED']) {
    const value={...receipt(run.claim),result:{evaluation,evidenceDigest:digest}};
    assert.deepEqual(receiptOutcome(value,run.claim).receipt,value);
  }
  for (const change of [v=>{delete v.result.evaluation;},v=>{v.result.evaluation='UNKNOWN';},v=>{v.result.released=true;},v=>{v.result.evidenceDigest='bad';},v=>{v.providerReceiptId='';},v=>{v.inputDigest=digest;},v=>{v.pins.harness.version='9.0.0';},v=>{v.status='RUNNING';}]) {
    const value=structuredClone(receipt(run.claim));change(value);assert.equal(receiptOutcome(value,run.claim).status,'UNKNOWN');
  }
});
function fixture(t,extra={}) {
  const parent=mkdtempSync(join(realpathSync(tmpdir()),'runtime-exec-'));t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const options={workspaceRoot:join(parent,'workspace'),workspaceId:'test'};
  let calls=0,last,serial=0;
  const providers={resolveOntology:resolver,resolveHarness:resolver,execute:c=>{calls++;last=c;return receipt(c);},...extra};
  for (const key of Object.keys(providers)) if (providers[key] === undefined) delete providers[key];
  const service=createRuntimeService(options,providers);service.initialize();t.after(()=>service.close());
  const read=(operation,id)=>service.execute({operation,scope,input:id?{id}:{}});
  const args=()=>({scope,id:'run',requestId:'req-'+ ++serial,expectedRevision:read('workspace.inspect').revision});
  const write=(operation,input)=>{const a=args();return service.execute({operation,scope,input,requestId:a.requestId,expectedRevision:a.expectedRevision});};
  write('project.create',{name:'Alpha'});write('goal.create',{id:'goal',description:'Evaluate facts'});
  const prepare=()=>write('run.prepare',{id:'run',goalId:'goal',ontology:ref('ontology'),harness:ref('harness'),input}).result;
  const approve=()=>{const run=prepare();write('run.decide',{id:'run',reviewDigest:run.reviewDigest,decision:'APPROVE',humanEvidenceRef:'human:synthetic-review'});return run;};
  return {service,options,providers,read,args,write,prepare,approve,calls:()=>calls,last:()=>last};
}
test('forward plan requires exact approval; dispatch pins and failed evaluation remain distinct',async t=>{
  const f=fixture(t);const run=f.prepare();assert.equal(run.stage,'PREPARED');assert.equal(f.calls(),0);
  await assert.rejects(f.service.dispatch(f.args()),{code:'APPROVAL_REQUIRED'});
  assert.throws(()=>f.write('run.decide',{id:'run',reviewDigest:digest,decision:'APPROVE',humanEvidenceRef:'human:test'}),{code:'REVIEW_MISMATCH'});
  f.write('run.decide',{id:'run',reviewDigest:run.reviewDigest,decision:'APPROVE',humanEvidenceRef:'human:test'});
  const request=f.args(),done=await f.service.dispatch(request);assert.equal(done.result.stage,'SUCCEEDED');assert.equal(done.result.outcome.receipt.result.evaluation,'FAIL');
  assert.equal(f.calls(),1);assert(Object.isFrozen(f.last().pins));assert.deepEqual(done.result.plan.pins,run.plan.pins);
  assert.deepEqual(f.last().input,input);assert(Object.isFrozen(f.last().input.ontologyInstance.entities[0].properties['quality.score']));
  await f.service.dispatch(request);await f.service.dispatch(f.args());assert.equal(f.calls(),1);
});
test('pending duplicate across instances invokes once; timeout reconciles original claim; late completion cannot overwrite',async t=>{
  let finish,claim,calls=0;
  const f=fixture(t,{timeoutMs:20,execute:c=>{calls++;claim=c;return new Promise(r=>{finish=r;});},inspectReceipt:c=>receipt(c)});f.approve();
  const request=f.args(),pending=f.service.dispatch(request);
  await Promise.resolve();
  const second=createRuntimeService(f.options,f.providers);second.initialize();t.after(()=>second.close());
  assert.equal((await second.dispatch(request)).result.stage,'RUNNING');assert.equal(calls,1);
  assert.equal((await pending).result.stage,'UNKNOWN');
  const reconciled=await f.service.reconcile(f.args());assert.equal(reconciled.result.stage,'SUCCEEDED');assert.equal(calls,1);assert.equal(reconciled.result.claim.claimId,claim.claimId);
  finish({...receipt(claim),status:'FAILED'});await new Promise(r=>setImmediate(r));assert.equal(f.read('run.inspect','run').stage,'SUCCEEDED');
});
test('wrong receipts, thrown responses, absent executor and material drift never fake success',async t=>{
  for(const execute of [()=>({}),c=>({...receipt(c),claimId:digest}),()=>{throw Error('dropped');}]) {
    const f=fixture(t,{execute});f.approve();assert.equal((await f.service.dispatch(f.args())).result.stage,'UNKNOWN');assert.equal(f.read('run.inspect','run').attemptCount,1);
  }
  const missing=fixture(t,{execute:undefined});missing.approve();await assert.rejects(missing.service.dispatch(missing.args()),{code:'MISSING_EXECUTOR'});assert.equal(missing.read('run.inspect','run').claim,null);
  let drift=false;const f=fixture(t,{resolveHarness:r=>({...resolver(r),reference:{...r.reference,version:drift?'9.0.0':'0.1.0'}})});f.approve();drift=true;await assert.rejects(f.service.dispatch(f.args()));assert.equal(f.calls(),0);assert.equal(f.read('run.inspect','run').claim,null);
});
test('closed composition and trusted material privacy; async resolver rejection consumed',async t=>{
  const f=fixture(t);assert.throws(()=>f.write('run.prepare',{id:'run',goalId:'goal',ontology:ref('ontology'),harness:ref('harness'),input:{...input,command:'echo unsafe'}}));
  const absent=fixture(t,{resolveOntology:undefined});assert.throws(absent.prepare,{code:'MISSING_RESOLVER'});
  const asyncResolver=fixture(t,{resolveOntology:()=>Promise.reject(Error('late'))});assert.throws(asyncResolver.prepare,{code:'ASYNC_RESOLVER'});await new Promise(r=>setImmediate(r));
  const privateMaterial=fixture(t,{resolveOntology:r=>({...resolver(r),scope:{visibility:'private',projectId:'other'},reference:{...r.reference,visibility:'private'}})});assert.throws(privateMaterial.prepare,{code:'MATERIAL_SCOPE'});
});
test('process exit after durable claim: restart retains RUNNING and reconciles without execution',async t=>{
  const f=fixture(t);f.approve();const request=f.args();f.service.close();
  const child=fork(new URL('../fixtures/service-worker.mjs',import.meta.url),[],{stdio:['ignore','ignore','pipe','ipc']});
  t.after(()=>child.kill());const exited=once(child,'exit');child.send({options:f.options,request});const [code]=await exited;assert.equal(code,0);
  let calls=0;const service=createRuntimeService(f.options,{...f.providers,execute:()=>{calls++;throw Error('must not replay');},inspectReceipt:receipt});service.initialize();t.after(()=>service.close());
  assert.equal(service.execute({operation:'run.inspect',scope,input:{id:'run'}}).stage,'RUNNING');
  await service.dispatch(request);assert.equal(calls,0);
  const revision=service.execute({operation:'workspace.inspect',scope,input:{}}).revision;
  const done=await service.reconcile({scope,id:'run',requestId:'reconcile',expectedRevision:revision});assert.equal(done.result.stage,'SUCCEEDED');assert.equal(done.result.attemptCount,1);assert.equal(calls,0);
});
test('scope rejection leaves revision, receipts and approved claim unchanged',async t=>{
  let unrelated=false;
  const f=fixture(t,{resolveHarness:r=>({...resolver(r),scope:{visibility:'public',projectId:unrelated?'unrelated':'alpha'}})});
  f.approve();const before=f.read('run.inspect','run'),request=f.args();unrelated=true;
  await assert.rejects(f.service.dispatch(request),{code:'MATERIAL_SCOPE'});
  assert.equal(f.read('workspace.inspect').revision,request.expectedRevision);assert.deepEqual(f.read('run.inspect','run'),before);assert.equal(f.calls(),0);
  assert.throws(()=>f.service.execute({operation:'receipt.inspect',scope,input:{requestId:request.requestId}}),{code:'NOT_FOUND'});
  const bad=fixture(t,{resolveHarness:r=>({...resolver(r),scope:{visibility:'public',projectId:'unrelated'}})});
  const revision=bad.read('workspace.inspect').revision;assert.throws(bad.prepare,{code:'MATERIAL_SCOPE'});assert.equal(bad.read('workspace.inspect').revision,revision);assert.deepEqual(bad.read('run.list'),[]);
  assert.throws(()=>bad.service.execute({operation:'receipt.inspect',scope,input:{requestId:'req-3'}}),{code:'NOT_FOUND'});
});
test('INDETERMINATE survives durable completion and restart',async t=>{
  const f=fixture(t,{execute:c=>({...receipt(c),result:{evaluation:'INDETERMINATE',evidenceDigest:digest}})});f.approve();
  const done=await f.service.dispatch(f.args());assert.equal(done.result.stage,'SUCCEEDED');assert.equal(done.result.outcome.receipt.result.evaluation,'INDETERMINATE');f.service.close();
  const service=createRuntimeService(f.options);service.initialize();t.after(()=>service.close());
  assert.deepEqual(service.execute({operation:'run.inspect',scope,input:{id:'run'}}),done.result);
});
test('cancel preserves external claim; close and late rejection cannot reopen it',async t=>{
  let reject,started;
  const f=fixture(t,{execute:c=>{started=c;return new Promise((_,r)=>{reject=r;});}});const prepared=f.approve();
  const pending=f.service.dispatch(f.args());await Promise.resolve();
  const cancelled=f.write('run.cancel',{id:'run',reviewDigest:prepared.reviewDigest,humanEvidenceRef:'human:cancel'}).result;
  assert.equal(cancelled.stage,'CANCELLED');assert.equal(cancelled.cancellation.externalUnresolved,true);assert.equal(cancelled.claim.claimId,started.claimId);
  f.service.close();await pending;reject(Error('late'));await new Promise(r=>setImmediate(r));
  const s=createRuntimeService(f.options);s.initialize();t.after(()=>s.close());assert.equal(s.execute({operation:'run.inspect',scope,input:{id:'run'}}).stage,'CANCELLED');
});
