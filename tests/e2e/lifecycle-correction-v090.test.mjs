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

async function fixture(tamper, phase='FAILED', expired=false, direct=false) {
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'runtime-correction-')), root=join(dir,'state');
  const tokens={editor:randomBytes(32).toString('hex'),reader:randomBytes(32).toString('hex'),outsider:randomBytes(32).toString('hex')};
  const actors=Object.entries(tokens).map(([id,token])=>({id,tokenDigest:tokenDigest(token),revision:1,expiresAt:'2030-01-01T00:00:00Z',projects:[id==='outsider'?'other':'alpha'],permissions:id==='editor'?['read','draft.write','execution.request']:['read']}));
  initializeCredentials(root,'synthetic',actors);
  const plan={adapterId:'synthetic-test',adapterDigest:valueDigest('adapter'),action:'fixture',bindingDigest:valueDigest('binding'),parameters:{synthetic:true}};
  const body={schema:'runtime-stage-request/v1',id:'failed-request',workspaceId:'synthetic',projectId:'alpha',instanceId:'instance-one',stageId:'verification',pinsDigest:valueDigest('pins'),inputDigest:valueDigest('input'),bindingStamp:valueDigest('binding'),authorityRef:'synthetic-authority',releaseAuthorityRef:null,initiatedBy:{id:'editor',revision:1},plan,planDigest:valueDigest(plan),requestedAt:new Date(Date.now()-60000).toISOString(),deadlineAt:new Date(Date.now()+(expired?-1000:60000)).toISOString()};
  const original={...body,digest:valueDigest(body)};
  const observation={requestId:body.id,inputDigest:body.inputDigest,adapterDigest:plan.adapterDigest,phase,handle:null,outcome:{requestId:body.id,inputDigest:body.inputDigest,status:phase,receiptRef:'synthetic:failed',expiresAt:body.deadlineAt,checks:[]}};
  const envelope={schema:'runtime-stage-observation/v1',requestId:body.id,observation,reason:'SYNTHETIC_DEFECT',observedAt:new Date().toISOString()},observationRef=valueDigest(envelope);
  const progress={requestId:body.id,phase,terminal:['FAILED','COMPLETE'].includes(phase),handle:null,observation,observationRef,reason:envelope.reason,observedAt:envelope.observedAt};
  tamper?.(progress);
  let server,directStore,directService;
  const seed=store=>{
    if(!store.object('alpha','stage-request',body.id)) store.mutate(actors[0],{projectId:'alpha',operation:'synthetic.seed',requestId:'seed',expectedRevision:0,input:{synthetic:true},permission:'draft.write'},()=>({objects:[{kind:'stage-request',id:body.id,value:original},{kind:'stage-progress',id:body.id,value:progress},{kind:'stage-observation',id:observationRef,value:envelope}],value:{synthetic:true},event:{type:'synthetic-seed',data:{}}}));
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
    for(const input of [{...proposal,facts:{status:'PASS'}},{...proposal,proposedChanges:[{path:'../outside',expectedEffect:'escape'}]},{...proposal,proposedChanges:[]}]) assert.equal((await f.request('lifecycle.correction.propose',input,'editor',meta)).status,400);
    assert.equal((await f.request('lifecycle.correction.propose',{...proposal,stageRequestId:'missing'},'editor',meta)).status,404);
    const read=await f.request('runtime.status',{},'reader');assert.equal(read.result.revision,1);
    const tools=runtimeToolDefinitions();
    assert(tools.find(t=>t.name==='runtime_read').inputSchema.properties.operation.enum.includes('lifecycle.correction.admission'));
    assert(tools.find(t=>t.name==='runtime_write').inputSchema.properties.operation.enum.includes('lifecycle.correction.propose'));
    assert(!tools.find(t=>t.name==='runtime_write').inputSchema.properties.operation.enum.includes('lifecycle.correction.execute'));
  } finally {await f.close();}
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
