// Development regressions using synthetic execution facts and real local HTTP,
// auth and SQLite. These are not the actual Host/provider LC acceptance cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startRuntimeServer } from '../../dist/server/http.js';
import { initializeCredentials, tokenDigest } from '../../dist/server/security.js';
import { valueDigest } from '../../dist/lifecycle/base.js';
import { RuntimeStore } from '../../dist/server/store.js';
import { createCorrectionService } from '../../dist/lifecycle/correction.js';
import { runtimeToolDefinitions } from '../../dist/server/mcp.js';
import { evidenceValueDigest } from '../../dist/server/errors.js';
import { ownerRequestDigest } from '../../dist/adapters/published-owners.js';
import { nativeSha256 } from '../../vendor/compatibility/v1/native.mjs';

async function fixture(tamper, phase='FAILED', expired=false, direct=false, native) {
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'runtime-correction-')), root=join(dir,'state');
  const tokens={editor:randomBytes(32).toString('hex'),reader:randomBytes(32).toString('hex'),outsider:randomBytes(32).toString('hex')};
  const actors=Object.entries(tokens).map(([id,token])=>({id,tokenDigest:tokenDigest(token),revision:1,expiresAt:'2030-01-01T00:00:00Z',projects:[id==='outsider'?'other':'alpha'],permissions:id==='editor'?['read','draft.write','execution.request']:['read']}));
  initializeCredentials(root,'synthetic',actors);
  const scope={visibility:'private',projectId:'alpha'},reference={product:'harness',id:'synthetic-original-only',version:'1.0.0',digest:valueDigest('synthetic-published-reference')},criteria=(native?.statuses??[]).map((status,index)=>({criterionId:'synthetic-rule-'+index,variantId:'synthetic-case',status,evidenceDigest:valueDigest('synthetic-evidence-'+index)}));
  const parameters={kind:'harness',owner:{ref:'binding:alpha/harness',registrationDigest:valueDigest('registration'),scope,reference,criteria:criteria.map(({criterionId,variantId})=>({criterionId,variantId}))},toolchainLockDigest:valueDigest('toolchain'),effectiveConfigDigest:valueDigest('effective-config')};
  const plan=native?{adapterId:'runtime-native-extension-stage-v1',adapterDigest:evidenceValueDigest({id:'runtime-native-extension-stage-v1',actions:['runtime.check.ontology','runtime.check.harness','runtime.check.artifact'],input:'runtime-extension-observation/v1',recovery:'inspect-original-only'}),action:'runtime.check.harness',bindingDigest:valueDigest(parameters),parameters}:{adapterId:'synthetic-test',adapterDigest:valueDigest('adapter'),action:'fixture',bindingDigest:valueDigest('binding'),parameters:{synthetic:true}};
  const body={schema:'runtime-stage-request/v1',id:'failed-request',workspaceId:'synthetic',projectId:'alpha',instanceId:'instance-one',stageId:'verification',pinsDigest:valueDigest('pins'),inputDigest:valueDigest('input'),bindingStamp:valueDigest('binding'),authorityRef:'synthetic-authority',releaseAuthorityRef:null,initiatedBy:{id:'editor',revision:1},plan,planDigest:valueDigest(plan),requestedAt:new Date(Date.now()-60000).toISOString(),deadlineAt:new Date(Date.now()+(expired?-1000:60000)).toISOString()};
  const original={...body,digest:valueDigest(body)};
  const observation={requestId:body.id,inputDigest:body.inputDigest,adapterDigest:plan.adapterDigest,phase,handle:null,outcome:{requestId:body.id,inputDigest:body.inputDigest,status:phase,receiptRef:'synthetic:failed',expiresAt:body.deadlineAt,checks:[]}};
  const extra=[];
  if(native){
    const context={workspaceId:'synthetic',scope,projectCandidateDigest:valueDigest('candidate'),claimId:valueDigest({stageRequestDigest:original.digest}),inputDigest:original.inputDigest,effectiveConfigDigest:parameters.effectiveConfigDigest,sourceScopeDigest:valueDigest('source'),requirementSetDigest:valueDigest('requirements')},observed={schema:'evopilot-observation/v1',origin:'execution-result',values:{synthetic:true}};
    const request={operation:'native.package.validate',scope,input:{id:reference.id,version:reference.version,context,observation:observed},requestId:'extension-native-'+valueDigest({requestDigest:original.digest}).slice(7,51),expectedRevision:0},actionBody={request,requestDigest:ownerRequestDigest('harness',request),context,observationDigest:nativeSha256(observed)},action={...actionBody,digest:evidenceValueDigest(actionBody)};
    const reportBody={reference,context,toolchainLockDigest:parameters.toolchainLockDigest,effectiveConfigDigest:parameters.effectiveConfigDigest,observationDigest:action.observationDigest,qualityStatus:phase==='COMPLETE'?'PASS':'FAIL',executionStatus:'SUCCEEDED',criteria},report={...reportBody,reportDigest:nativeSha256(reportBody)},receipt={requestId:request.requestId,operation:request.operation,scope,requestDigest:nativeSha256({operation:request.operation,scope,input:request.input}),status:'SUCCEEDED',result:report};
    const evidence={schema:'runtime-native-extension-evidence/v1',requestDigest:original.digest,planDigest:original.planDigest,candidateDigest:null,source:{commit:'a'.repeat(40)},actionDigest:action.digest,receiptRef:evidenceValueDigest(receipt),receiptTerminal:true,result:{owner:'harness',status:phase==='COMPLETE'?'PASS':'FAIL',receiptDigest:nativeSha256(receipt),reportDigest:report.reportDigest},executionAuthorized:false,releaseAuthorized:false},ref=evidenceValueDigest(evidence);
    observation.handle={owner:'harness',requestId:request.requestId};observation.outcome.receiptRef='runtime:extension/'+original.id;observation.outcome.checks=[{id:'synthetic-check',status:phase==='COMPLETE'?'PASS':'FAIL',evidenceRef:native.detach?'sha256:'+'0'.repeat(64):ref}];
    extra.push({kind:'extension-native-action',id:original.id,value:action},{kind:'extension-native-receipt',id:original.id,value:receipt},{kind:'extension-evidence',id:ref,value:evidence},{kind:'extension-evidence-pointer',id:original.id,value:{ref}});
    if(native.missing)extra.splice(extra.findIndex(o=>o.kind===native.missing),1);
    if(native.tamper)native.tamper(extra);
  }
  const envelope={schema:'runtime-stage-observation/v1',requestId:body.id,observation,reason:'SYNTHETIC_DEFECT',observedAt:new Date().toISOString()},observationRef=valueDigest(envelope);
  const progress={requestId:body.id,phase,terminal:['FAILED','COMPLETE'].includes(phase),handle:observation.handle,observation,observationRef,reason:envelope.reason,observedAt:envelope.observedAt};
  tamper?.(progress);
  let server,directStore,directService;
  const seed=store=>{
    if(!store.object('alpha','stage-request',body.id)) store.mutate(actors[0],{projectId:'alpha',operation:'synthetic.seed',requestId:'seed',expectedRevision:0,input:{synthetic:true},permission:'draft.write'},()=>({objects:[{kind:'stage-request',id:body.id,value:original},{kind:'stage-progress',id:body.id,value:progress},{kind:'stage-observation',id:observationRef,value:envelope},...extra],value:{synthetic:true},event:{type:'synthetic-seed',data:{}}}));
  };
  const open=async()=>{
    if(direct){directStore=new RuntimeStore(root,'synthetic');seed(directStore);directService=createCorrectionService(directStore,{original:()=>({request:original,progress}),stageAdmission:async()=>({allowed:false,reasons:['SYNTHETIC_ONLY']})});return;}
    server=await startRuntimeServer({stateRoot:root,workspaceId:'synthetic'},undefined,undefined,undefined,store=>{seed(store);return undefined;});
  };
  await open();
  async function request(operation,input={},actor='editor',meta) {
    if(direct){
      try {const principal=actors.find(a=>a.id===actor);const result=operation==='runtime.status'?{revision:directStore.revision('alpha')}:meta?directService.write(principal,'alpha',operation,input,meta.requestId,meta.expectedRevision,()=>principal):await directService.read(principal,'alpha',operation,input);return{status:200,result};}
      catch(error){return{status:error.status??500,error:{code:error.code??'ERROR'}};}
    }
    const response=await fetch(server.url+'/api/v1/request',{method:'POST',headers:{authorization:'Bearer '+tokens[actor],'content-type':'application/json'},body:JSON.stringify({operation,projectId:'alpha',input,...meta})});
    return {status:response.status,...await response.json()};
  }
  return {request,original,progress,restart:async()=>{await server.close();await open();},close:async()=>{if(direct)directStore.close();else await server.close();rmSync(dir,{recursive:true,force:true});}};
}
const proposal={stageRequestId:'failed-request',hypothesis:'Fixture parser may reject a valid old binding.',minimalVerification:'Read the old binding with a fixed isolated fixture.',proposedChanges:[{path:'src/example.ts',expectedEffect:'Separate historic identity from current execution admission.'}]};

test('correction suggestions preserve original facts, survive restart and replay without execution authority',async()=>{
  const f=await fixture();try {
    const before=await f.request('lifecycle.stage.request.inspect',{stageRequestId:'failed-request'});
    assert.equal(before.status,200);
    const meta={requestId:'correction-one',expectedRevision:1};
    const saved=await f.request('lifecycle.correction.propose',proposal,'editor',meta);
    assert.equal(saved.status,200,JSON.stringify(saved));
    assert.equal(saved.result.result.executionAuthorized,false);
    assert.equal(saved.result.result.hypothesisVerified,false);
    const ref=saved.result.result.correctionRef;
    const read=await f.request('lifecycle.correction.inspect',{stageRequestId:'failed-request',correctionRef:ref},'reader');
    assert.equal(read.status,200);assert.equal(read.result.proposalCurrent,true);
    assert.equal(read.result.proposal.input.hypothesis,proposal.hypothesis);
    assert.equal(read.result.facts.phase,'FAILED');assert.equal(read.result.facts.reason,'SYNTHETIC_DEFECT');
    await f.restart();
    const replay=await f.request('lifecycle.correction.propose',proposal,'editor',meta);
    assert.deepEqual(replay.result,saved.result);
    const after=await f.request('lifecycle.stage.request.inspect',{stageRequestId:'failed-request'});
    assert.deepEqual(after.result.request,before.result.request);assert.deepEqual(after.result.progress,before.result.progress);
    const reread=await f.request('lifecycle.correction.inspect',{stageRequestId:'failed-request',correctionRef:ref},'reader');
    assert.deepEqual(reread.result.proposal,read.result.proposal);
    const conflict=await f.request('lifecycle.correction.propose',{...proposal,hypothesis:'Changed replay'},'editor',meta);
    assert.equal(conflict.status,409);
  } finally {await f.close();}
});

test('correction HTTP boundary rejects caller facts, path escape, missing original and unprivileged writes',async()=>{
  const f=await fixture();try {
    const meta={requestId:'denied',expectedRevision:1};
    assert.equal((await f.request('lifecycle.correction.propose',proposal,'reader',meta)).status,403);
    assert.equal((await f.request('lifecycle.correction.inspect',{stageRequestId:'failed-request'},'outsider')).status,403);
    assert.equal((await f.request('lifecycle.correction.admission',{stageRequestId:'failed-request'},'reader')).status,403);
    for(const input of [{...proposal,facts:{status:'PASS'}},{...proposal,proposedChanges:[{path:'../outside',expectedEffect:'escape'}]}]) assert.equal((await f.request('lifecycle.correction.propose',input,'editor',meta)).status,400);
    assert.equal((await f.request('lifecycle.correction.propose',{...proposal,stageRequestId:'missing'},'editor',meta)).status,404);
    const read=await f.request('runtime.status',{},'reader');assert.equal(read.result.revision,1);
    const tools=runtimeToolDefinitions();
    assert(tools.find(t=>t.name==='runtime_read').inputSchema.properties.operation.enum.includes('lifecycle.correction.admission'));
    assert(tools.find(t=>t.name==='runtime_write').inputSchema.properties.operation.enum.includes('lifecycle.correction.propose'));
    assert(!tools.find(t=>t.name==='runtime_write').inputSchema.properties.operation.enum.includes('lifecycle.correction.execute'));
  } finally {await f.close();}
});

test('engineering prerequisite proposals can explicitly declare no source changes',async()=>{
  const f=await fixture();try{
    const response=await f.request('lifecycle.correction.propose',{...proposal,proposedChanges:[]},'editor',{requestId:'no-source-change',expectedRevision:1});assert.equal(response.status,200,JSON.stringify(response));
    const read=await f.request('lifecycle.correction.inspect',{stageRequestId:'failed-request',correctionRef:response.result.result.correctionRef},'reader');assert.deepEqual(read.result.proposal.input.proposedChanges,[]);assert.equal(read.result.executionAuthorized,false);
  }finally{await f.close();}
});

test('mutable progress cannot substitute a fabricated failure for the retained observation',async()=>{
 for(const tamper of [p=>p.reason='INVENTED_CAUSE',p=>p.terminal=false,p=>{p.observation=structuredClone(p.observation);p.observation.phase='COMPLETE';},p=>p.observationRef=null]) {
  const f=await fixture(tamper,'FAILED',false,true);try {
   const read=await f.request('lifecycle.correction.inspect',{stageRequestId:'failed-request'});
   assert.equal(read.status,503);assert.equal(read.error.code,'CORRUPT_STAGE_OBSERVATION');
   const saved=await f.request('lifecycle.correction.propose',proposal,'editor',{requestId:'must-not-save',expectedRevision:1});assert.equal(saved.status,503);
   assert.equal((await f.request('runtime.status')).result.revision,1);
  }finally{await f.close();}
 }
});

test('completed and expired requests return read-only next actions, not repair instructions',async()=>{
 for(const [phase,expired,nextAction] of [['COMPLETE',false,'STAGE_ALREADY_COMPLETE'],['FAILED',true,'INSPECT_ORIGINAL_EVIDENCE'],['UNKNOWN',false,'RECONCILE_ORIGINAL_REQUEST']]) {
  const f=await fixture(undefined,phase,expired,true);try {
   const result=await f.request('lifecycle.correction.admission',{stageRequestId:'failed-request'});
   assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.result.allowed,false);
   assert.equal(result.result.nextAction,nextAction);assert.equal(result.result.executionAuthorized,false);
   assert.equal(result.result.stageAdmission,null);
  }finally{await f.close();}
 }
});

test('protected original native evidence preserves criterion outcomes without conferring repair meaning',async()=>{
 const f=await fixture(undefined,'FAILED',false,false,{statuses:['PASS','FAIL','ERROR','UNKNOWN','SKIPPED']});try{
  const before=(await f.request('runtime.status')).result.revision;
  const inspected=await f.request('lifecycle.correction.inspect',{stageRequestId:'failed-request'},'reader');assert.equal(inspected.status,200,JSON.stringify(inspected));
  const original=inspected.result.nativeEvidence;assert.equal(original.status,'AVAILABLE');assert.equal(original.purpose,'ORIGINAL_STAGE_VALIDATION');assert.equal(original.repairProof,false);assert.equal(original.originalRequestDigest,f.original.digest);assert.deepEqual(original.owners[0].criterionStatuses,{PASS:1,FAIL:1,ERROR:1,UNKNOWN:1,SKIPPED:1});assert.equal(original.owners[0].qualityStatus,'FAIL');assert.equal(original.missingRepairBindings.length,4);assert.equal(Object.hasOwn(original,'failureClass'),false);assert.equal(Object.hasOwn(original,'rounds'),false);
  await f.restart();assert.deepEqual((await f.request('lifecycle.correction.inspect',{stageRequestId:'failed-request'},'reader')).result.nativeEvidence,original);assert.equal((await f.request('runtime.status')).result.revision,before);
  assert.equal((await f.request('lifecycle.correction.inspect',{stageRequestId:'failed-request',nativeEvidence:original},'reader')).error.code,'INVALID_FIELDS');assert.equal((await f.request('lifecycle.correction.inspect',{stageRequestId:'failed-request'},'outsider')).status,403);
 }finally{await f.close();}
});

test('an original native PASS remains original stage validation and never becomes repair approval',async()=>{
 const f=await fixture(undefined,'COMPLETE',false,false,{statuses:['PASS']});try{
  const inspected=await f.request('lifecycle.correction.inspect',{stageRequestId:'failed-request'},'reader');assert.equal(inspected.result.nativeEvidence.status,'AVAILABLE');assert.equal(inspected.result.nativeEvidence.owners[0].qualityStatus,'PASS');assert.equal(inspected.result.nativeEvidence.repairProof,false);
  const result=await f.request('lifecycle.correction.admission',{stageRequestId:'failed-request'});assert.equal(result.result.allowed,false);assert.equal(result.result.nextAction,'STAGE_ALREADY_COMPLETE');assert.equal(result.result.executionAuthorized,false);
 }finally{await f.close();}
});

for(const native of [{statuses:['FAIL'],missing:'extension-native-action'},{statuses:['FAIL'],missing:'extension-native-receipt'},{statuses:['FAIL'],detach:true},{statuses:['FAIL'],tamper:objects=>{objects.find(o=>o.kind==='extension-native-receipt').value.result.criteria[0].status='PASS';}}])test('missing or detached native records cannot establish protected repair evidence '+JSON.stringify({missing:native.missing,detach:native.detach,tamper:!!native.tamper}),async()=>{
 const f=await fixture(undefined,'FAILED',false,false,native);try{
  const read=await f.request('lifecycle.correction.inspect',{stageRequestId:'failed-request'});assert.equal(read.status,200,JSON.stringify(read));assert.equal(read.result.nativeEvidence.status,'UNAVAILABLE');assert.equal(read.result.nativeEvidence.repairProof,false);assert.match(read.result.nativeEvidence.reason,/^(CORRUPT_EXTENSION|CORRECTION_NATIVE_EVIDENCE_MISMATCH)$/);assert.equal(read.result.executionAuthorized,false);assert.equal((await f.request('runtime.status')).result.revision,1);
 }finally{await f.close();}
});
