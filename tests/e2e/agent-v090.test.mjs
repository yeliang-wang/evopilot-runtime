// Real service/HTTP/handoff code with explicitly synthetic predecessor evidence,
// source identities and authority. Actual Host acceptance is separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,writeFileSync,readFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {RuntimeStore} from '../../dist/server/store.js';
import {startRuntimeServer} from '../../dist/server/http.js';
import {initializeCredentials,tokenDigest} from '../../dist/server/security.js';
import {ServiceError} from '../../dist/server/errors.js';
import {valueDigest,byteDigest} from '../../dist/lifecycle/base.js';
import {compileLifecycle} from '../../dist/lifecycle/compiler.js';
import {pinInstance,requiredChecksDigest,requestStage,recordStageOutcome} from '../../dist/lifecycle/instance.js';
import {readAgentHandoff,createAgentService} from '../../dist/lifecycle/agent.js';
import {createCodexStageAdapter} from '../../dist/adapters/external-agent.js';
import {lifecycleBindingExample} from '../fixtures/adapters-v090.mjs';
import {yaml,syntheticBindings} from '../fixtures/lifecycle-v090.mjs';
import {NATIVE_CONTRACT_DIGEST} from '../../vendor/compatibility/v1/native.mjs';

async function fixture(options={}){
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'runtime-agent-')),root=join(dir,'state'),workspaceId='synthetic-agent',projectId='alpha',path=join(dir,'integrations.json'),expiresAt='2030-01-01T00:00:00Z';
  const pin=owner=>({product:owner,id:'synthetic-'+owner,version:'1.0.0',specVersion:'v1',visibility:'private',digest:valueDigest(owner),standardDigest:valueDigest(owner+'-standard'),standardLockDigest:valueDigest(owner+'-lock'),producer:{product:owner,version:'0.3.0'},contractDigest:NATIVE_CONTRACT_DIGEST});
  const platform={ref:'binding:alpha/platform',workspaceId,projectId,provider:'github',host:'https://github.com',repository:'synthetic/agent',repositoryId:'42',defaultBranch:'main',credentialRef:'credential:alpha/platform',revision:1,expiresAt,workflowPath:'.github/workflows/test.yml',runner:'ubuntu-latest'},credential={ref:platform.credentialRef,workspaceId,projectId,provider:platform.provider,host:platform.host,tokenFile:join(dir,'unused'),revision:1,expiresAt},ownerRegistrations=['ontology','harness'].map(owner=>({ref:'binding:alpha/'+owner,owner,packageRoot:dir,workspaceRoot:dir,workspaceId,projects:[projectId]}));
  const{configuration:config,data}=lifecycleBindingExample({root:dir,workspaceId,projectId,platform,credential,ownerRegistrations,references:{ontology:pin('ontology'),harness:pin('harness')},assessmentId:'synthetic'});data.config.plan.budget.timeoutSeconds=120;if(options.maxAttempts!==undefined)data.config.plan.budget.maxAttempts=options.maxAttempts;writeFileSync(path,JSON.stringify(config),{mode:0o600});
  const definition=compileLifecycle(yaml(data),projectId).effective,definitionRevisionId=valueDigest('synthetic-agent-definition');
  const prepInput={definitionRevisionId,goalRef:'synthetic:agent-goal',loopRef:'synthetic:agent-loop',target:{id:'agent-target',version:'0.9.0-preview.1',title:'Synthetic bounded coding target',scope:['One bounded synthetic source output'],exclusions:['Production','Release']},source:{provider:'github',repositoryId:'42',commit:'a'.repeat(40)},compatibility:'unchanged',documents:{...Object.fromEntries(['plan','impact','verification','rollback'].map(k=>[k,{path:join(dir,k+'.md'),digest:valueDigest(k)}])),migration:null},verification:{requirementsDigest:requiredChecksDigest(definition),checks:definition.nodes.flatMap(n=>n.checks.map(checkId=>({stageId:n.id,checkId,source:'owner-receipt',procedure:'Synthetic rule validation'})))}};
  const prepBody={schema:'runtime-preparation/v1',workspaceId,projectId,semanticDigest:definition.semanticDigest,input:prepInput},packet={...prepBody,digest:valueDigest(prepBody)},targetRef='preparation:'+packet.digest;
  const authority={projectId,instanceId:'agent-instance',definitionRevisionId,semanticDigest:definition.semanticDigest,requirementsDigest:requiredChecksDigest(definition),goalRef:prepInput.goalRef,targetRef,loopRef:prepInput.loopRef,budget:data.config.plan.budget,evidenceRef:'synthetic:agent-authority',revision:'one',expiresAt};
  const actor={id:'executor',projects:[projectId],permissions:['read','execution.request'],revision:1,expiresAt},tokens=Object.fromEntries(['executor','other','reader','foreign'].map(id=>[id,randomBytes(32).toString('hex')]));
  initializeCredentials(root,workspaceId,Object.entries(tokens).map(([id,token])=>({...actor,id,projects:[id==='foreign'?'beta':projectId],permissions:id==='reader'||id==='foreign'?['read']:actor.permissions,tokenDigest:tokenDigest(token)})));
  let instance=pinInstance('agent-instance',definitionRevisionId,definition,authority);const objects=[{kind:'lifecycle-preparation',id:targetRef,value:packet},{kind:'instance-authority',id:instance.id,value:{evidenceRef:authority.evidenceRef}}];
  for(const stage of ['scope','plan']){
    const id='synthetic-'+stage;instance=requestStage(instance,stage,id,{authority,bindingsCurrent:true});
    const original={schema:'synthetic-predecessor',id,instanceId:instance.id,pinsDigest:instance.pinsDigest,planDigest:valueDigest(stage),digest:valueDigest('synthetic-'+stage)};
    const evidence={schema:'runtime-plan-stage-evidence/v1',requestDigest:original.digest,planDigest:original.planDigest,preparationDigest:packet.digest,synthetic:true},ref=valueDigest(evidence),outcome={requestId:id,inputDigest:instance.stages[stage].inputDigest,receiptRef:'synthetic:predecessor',status:'COMPLETE',expiresAt:new Date(Date.now()+600000).toISOString(),checks:definition.nodes.find(n=>n.id===stage).checks.map(id=>({id,status:'PASS',evidenceRef:ref}))};instance=recordStageOutcome(instance,stage,outcome);
    objects.push({kind:'stage-request',id,value:original},{kind:'stage-progress',id,value:{requestId:id,phase:'COMPLETE',terminal:true,observation:{outcome}}},{kind:'plan-stage-evidence',id:ref,value:evidence});
  }
  objects.push({kind:'lifecycle-instance',id:instance.id,value:instance});const seed=new RuntimeStore(root,workspaceId);seed.mutate(actor,{projectId,operation:'synthetic.fixture',requestId:'seed',expectedRevision:0,input:{synthetic:true},permission:'read'},()=>({objects,value:{synthetic:true},event:{type:'synthetic-predecessors',data:{synthetic:true}}}));seed.close();
  const controls={revoked:false,identityReads:0},bindings=syntheticBindings();let server,sequence=0;
  const identify=async d=>{controls.identityReads++;return{adapter:'codex',version:d.version,executableDigest:d.executable.digest,hostId:d.hostId,modelInvoked:false};};
  const start=async()=>server=await startRuntimeServer({stateRoot:root,workspaceId},bindings.provider,async()=>{if(controls.revoked)throw new ServiceError('AUTHORITY_REVOKED','Synthetic authority revoked',403);return authority;},undefined,s=>createCodexStageAdapter(s,path,identify));await start();
  async function request(operation,input={},write=false,who='executor',meta){
    if(write&&!meta){const s=await request('runtime.status',{},false,who);meta={requestId:'agent-test-'+(++sequence),expectedRevision:s.body.result.revision};}
    const envelope={operation,projectId,input,...meta},response=await fetch(server.url+'/api/v1/request',{method:'POST',headers:{authorization:'Bearer '+tokens[who],'content-type':'application/json'},body:JSON.stringify(envelope)});return{status:response.status,body:await response.json(),envelope};
  }
  async function wait(id,phase){let r;for(let n=0;n<180;n++){r=await request('lifecycle.stage.request.inspect',{stageRequestId:id});if(r.body.result.progress.phase===phase)return r.body.result;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('Expected '+phase+': '+JSON.stringify(r));}
  async function handoff(){const r=await request('lifecycle.stage.request',{instanceId:instance.id,stageId:'implementation'},true);assert.equal(r.status,200,JSON.stringify(r));const id=r.body.result.result.stageRequestId;await wait(id,'WAITING_AGENT');const read=await request('lifecycle.agent.handoff.read',{stageRequestId:id});assert.equal(read.status,200);return read.body.result.handoff;}
  const claimInput=h=>({stageRequestId:h.stageRequestId,handoffDigest:h.digest,host:{hostId:h.agent.hostId,version:h.agent.version,sessionId:'synthetic-host-session',capabilities:[...h.capabilities],permissionMode:'host-managed'}});
  async function claim(h){const r=await request('lifecycle.agent.claim',claimInput(h),true);assert.equal(r.status,200,JSON.stringify(r));return r;}
  const reportInput=(h,c,state='WORKING',previousReportDigest=null)=>({stageRequestId:h.stageRequestId,claimDigest:c.body.result.result.claimDigest,previousReportDigest,state,summary:'Synthetic Host observation',result:null,measurement:null});
  function result(){const content='export const answer = 42;\n';writeFileSync(join(dir,'result.mjs'),content,{mode:0o600});return{commit:'b'.repeat(40),change:{kind:'pull-request',id:'1'},artifacts:[{path:'result.mjs',digest:byteDigest(content),bytes:Buffer.byteLength(content)}]};}
  return{dir,root,config,path,controls,tokens,authority,actor,request,wait,handoff,claimInput,claim,reportInput,result,get server(){return server;},async restart(){await server.close();await start();},async cleanup(){await server.close();rmSync(dir,{recursive:true,force:true});}};
}

test('handoff pins reviewed work and waits without launching an Agent; restart cannot create a new claim',async()=>{
  const f=await fixture();try{
    const h=await f.handoff();assert.equal(h.runtimeStartsAgent,false);assert.equal(h.releaseAuthorized,false);assert.equal(h.agent.modelInvoked,false);assert.equal(h.workspaceRoot,f.dir);assert.equal(h.preparation.target.id,'agent-target');assert.equal(f.controls.identityReads,2);
    assert.equal((await f.request('lifecycle.agent.handoff.read',{stageRequestId:h.stageRequestId},false,'foreign')).status,403);await f.restart();await f.wait(h.stageRequestId,'WAITING_AGENT');assert.equal(f.controls.identityReads,2,'observation cannot query or start the external Agent');
    assert.deepEqual((await f.request('lifecycle.agent.handoff.read',{stageRequestId:h.stageRequestId})).body.result.handoff,h);
    const c=await f.claim(h),replay=await f.request(c.envelope.operation,c.envelope.input,true,'executor',{requestId:c.envelope.requestId,expectedRevision:c.envelope.expectedRevision});assert.deepEqual(replay.body.result,c.body.result);
    assert.equal((await f.request('lifecycle.agent.claim',f.claimInput(h),true)).body.error.code,'AGENT_ALREADY_CLAIMED');
    const read=await f.request('lifecycle.agent.handoff.read',{stageRequestId:h.stageRequestId});assert.equal(read.body.result.claim.deadlineAt,h.deadlineAt);assert.equal(read.body.result.hostSessionAttested,false);assert.equal(read.body.result.latestReport,null);
  }finally{await f.cleanup();}
});
test('claim cannot change principal, Host, version, capabilities, permission policy or handoff',async()=>{
  const f=await fixture();try{
    const h=await f.handoff();assert.equal((await f.request('lifecycle.agent.claim',f.claimInput(h),true,'other')).body.error.code,'AGENT_PRINCIPAL_MISMATCH');assert.equal((await f.request('lifecycle.agent.claim',f.claimInput(h),true,'reader')).status,403);
    for(const alter of [x=>x.host.hostId='wrong',x=>x.host.version='wrong',x=>x.host.capabilities.push('release'),x=>x.host.permissionMode='bypass',x=>x.handoffDigest=valueDigest('wrong')]){const input=f.claimInput(h);alter(input);assert.notEqual((await f.request('lifecycle.agent.claim',input,true)).status,200);}
    f.controls.revoked=true;assert.equal((await f.request('lifecycle.agent.claim',f.claimInput(h),true)).body.error.code,'AUTHORITY_REVOKED');assert.equal((await f.request('lifecycle.agent.handoff.read',{stageRequestId:h.stageRequestId})).body.result.claim,null);
  }finally{await f.cleanup();}
});
test('submitted exact outputs remain pending independent review/CI and cannot be overwritten or declared PASS',async()=>{
  const f=await fixture();try{
    const h=await f.handoff(),c=await f.claim(h),working=await f.request('lifecycle.agent.report',f.reportInput(h,c),true);assert.equal(working.status,200,JSON.stringify(working));const prior=working.body.result.result.reportDigest;
    const input={...f.reportInput(h,c,'SUBMITTED',prior),result:f.result()},submitted=await f.request('lifecycle.agent.report',input,true);assert.equal(submitted.status,200,JSON.stringify(submitted));assert.equal(submitted.body.result.result.lifecycleCompleted,false);await f.wait(h.stageRequestId,'RUNNING');
    const report=await f.request('lifecycle.agent.report.read',{stageRequestId:h.stageRequestId});assert.equal(report.body.result.report.measurement,null);assert.equal(report.body.result.measurementSource,'unavailable');assert.equal(report.body.result.report.independentlyVerified,false);
    const inspected=await f.request('lifecycle.instance.inspect',{instanceId:'agent-instance'});assert.equal(inspected.body.result.instance.stages.implementation.status,'RUNNING');assert.equal((await f.request('lifecycle.stage.request',{instanceId:'agent-instance',stageId:'candidate'},true)).body.error.code,'STAGE_BLOCKED');
    await f.restart();await f.wait(h.stageRequestId,'RUNNING');assert.deepEqual((await f.request('lifecycle.agent.report.read',{stageRequestId:h.stageRequestId})).body.result,report.body.result);
    assert.equal((await f.request('lifecycle.agent.report',{...input,previousReportDigest:report.body.result.report.digest},true)).body.error.code,'AGENT_RESULT_FROZEN');
    assert.equal((await f.request('lifecycle.agent.report',{...input,status:'PASS'},true)).body.error.code,'INVALID_FIELDS');
    const previous=await f.request('lifecycle.agent.report.read',{stageRequestId:h.stageRequestId,reportDigest:prior});assert.equal(previous.body.result.report.state,'WORKING');
  }finally{await f.cleanup();}
});
test('reports require the exact claim chain and never accept caller lifecycle outcomes',async()=>{
  const f=await fixture();try{
    const h=await f.handoff(),c=await f.claim(h),base=f.reportInput(h,c);
    for(const input of [{...base,claimDigest:valueDigest('wrong')},{...base,previousReportDigest:valueDigest('wrong')},{...base,state:'PASS'},{...base,result:f.result()},{...base,budget:{timeoutSeconds:999}}])assert.notEqual((await f.request('lifecycle.agent.report',input,true)).status,200);
    const a=await f.request('lifecycle.agent.report',base,true);assert.equal(a.status,200);assert.equal((await f.request('lifecycle.agent.report',base,true)).body.error.code,'AGENT_REPORT_CONFLICT');
    const replay=await f.request(a.envelope.operation,a.envelope.input,true,'executor',{requestId:a.envelope.requestId,expectedRevision:a.envelope.expectedRevision});assert.deepEqual(replay.body.result,a.body.result);
  }finally{await f.cleanup();}
});
test('output inventory rejects escape, links, changed bytes and wrong provider without reading arbitrary files',async()=>{
  const f=await fixture();try{
    const h=await f.handoff(),c=await f.claim(h),base=f.reportInput(h,c,'SUBMITTED');const link=join(f.dir,'linked.mjs');f.result();symlinkSync(join(f.dir,'result.mjs'),link);
    for(const alter of [x=>x.artifacts[0].path='../outside',x=>x.artifacts[0].path='linked.mjs',x=>x.artifacts[0].digest=valueDigest('wrong'),x=>x.artifacts[0].bytes++,x=>x.change.kind='merge-request',x=>x.artifacts.push(x.artifacts[0])]){const result=f.result();alter(result);assert.notEqual((await f.request('lifecycle.agent.report',{...base,result},true)).status,200);}
    assert.equal((await f.request('lifecycle.agent.report.read',{stageRequestId:h.stageRequestId})).body.result.report,null);
  }finally{await f.cleanup();}
});
test('usage stays unavailable unless explicitly sourced; malformed totals and invented budgets are rejected',async()=>{
  const f=await fixture();try{
    const h=await f.handoff(),c=await f.claim(h),base=f.reportInput(h,c,'WAITING'),measurement={provider:'synthetic',model:'synthetic-model',inputTokens:10,outputTokens:2,totalTokens:12,cost:null,source:{reference:'synthetic:host-receipt',digest:valueDigest('usage')}};
    for(const value of [{...measurement,totalTokens:0},{...measurement,inputTokens:-1},{...measurement,source:null},{...measurement,apiKey:'sk-synthetic-secret'}])assert.notEqual((await f.request('lifecycle.agent.report',{...base,measurement:value},true)).status,200);
    const r=await f.request('lifecycle.agent.report',{...base,measurement},true);assert.equal(r.status,200);const read=await f.request('lifecycle.agent.report.read',{stageRequestId:h.stageRequestId});assert.deepEqual(read.body.result.report.measurement,measurement);assert.equal(read.body.result.measurementSource,'host-reported');assert.equal(read.body.result.independentlyVerified,false);
  }finally{await f.cleanup();}
});
test('revocation blocks new coding activity but retains the original submitted result as unverified evidence',async()=>{
  const f=await fixture();try{
    const h=await f.handoff(),c=await f.claim(h);f.controls.revoked=true;assert.equal((await f.request('lifecycle.agent.report',f.reportInput(h,c),true)).body.error.code,'AUTHORITY_REVOKED');
    const r=await f.request('lifecycle.agent.report',{...f.reportInput(h,c,'SUBMITTED'),result:f.result()},true);assert.equal(r.status,200);assert.equal(r.body.result.result.lifecycleCompleted,false);assert.equal((await f.request('lifecycle.stage.advance',{stageRequestId:h.stageRequestId},true)).body.error.code,'AUTHORITY_REVOKED');
  }finally{await f.cleanup();}
});
test('Host inactivity becomes waiting without replacing the claim or recording task success',async()=>{
  const f=await fixture();const now=Date.now;try{
    const h=await f.handoff(),c=await f.claim(h);assert.equal((await f.request('lifecycle.agent.report',f.reportInput(h,c),true)).status,200);await f.wait(h.stageRequestId,'RUNNING');Date.now=()=>now()+31000;await f.wait(h.stageRequestId,'WAITING_AGENT');
    const read=await f.request('lifecycle.agent.handoff.read',{stageRequestId:h.stageRequestId});assert.equal(read.body.result.claim.digest,c.body.result.result.claimDigest);assert.equal(read.body.result.claim.deadlineAt,h.deadlineAt);assert.equal(read.body.result.latestReport.state,'WORKING');
  }finally{Date.now=now;await f.cleanup();}
});
test('known Host failure is retained as failure and cannot become a new coding attempt automatically',async()=>{
  const f=await fixture();try{const h=await f.handoff(),c=await f.claim(h);assert.equal((await f.request('lifecycle.agent.report',f.reportInput(h,c,'FAILED'),true)).status,200);await f.wait(h.stageRequestId,'FAILED');assert.equal(f.controls.identityReads,2);assert.equal((await f.request('lifecycle.agent.claim',f.claimInput(h),true)).body.error.code,'AGENT_ALREADY_CLAIMED');}finally{await f.cleanup();}
});
test('MCP shares the exact claim writer without model credentials or a second execution engine',async()=>{
  const f=await fixture(),client=new Client({name:'synthetic-agent-client',version:'1'});try{
    const h=await f.handoff();await client.connect(new StreamableHTTPClientTransport(new URL(f.server.url+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+f.tokens.executor}}}));const status=await f.request('runtime.status');
    const result=await client.callTool({name:'runtime_write',arguments:{operation:'lifecycle.agent.claim',projectId:'alpha',input:f.claimInput(h),requestId:'mcp-agent-claim',expectedRevision:status.body.result.revision}});assert.notEqual(result.isError,true);const value=JSON.parse(result.content[0].text).result.result;
    assert.equal((await f.request('lifecycle.agent.handoff.read',{stageRequestId:h.stageRequestId})).body.result.claim.digest,value.claimDigest);assert.equal(status.body.result.independentLlm,false);
  }finally{await client.close();await f.cleanup();}
});

test('expired original task cannot resume coding or renew budget; late output remains historical evidence',async()=>{
  const f=await fixture(),now=Date.now;try{
    const h=await f.handoff(),c=await f.claim(h);Date.now=()=>now()+3600000;
    assert.equal((await f.request('lifecycle.agent.report',f.reportInput(h,c),true)).body.error.code,'EXECUTION_DEADLINE');
    const submitted=await f.request('lifecycle.agent.report',{...f.reportInput(h,c,'SUBMITTED'),result:f.result()},true);assert.equal(submitted.status,200,JSON.stringify(submitted));
    const read=await f.request('lifecycle.agent.report.read',{stageRequestId:h.stageRequestId});assert.equal(read.body.result.report.late,true);assert.equal(read.body.result.independentlyVerified,false);assert.equal((await f.request('lifecycle.stage.advance',{stageRequestId:h.stageRequestId},true)).body.error.code,'EXECUTION_DEADLINE');
    assert.equal((await f.request('lifecycle.agent.handoff.read',{stageRequestId:h.stageRequestId})).body.result.claim.deadlineAt,h.deadlineAt);
  }finally{Date.now=now;await f.cleanup();}
});

test('historical handoff and report remain readable after a new attempt without reopening old writes',async()=>{
 const f=await fixture({maxAttempts:2});let store;
 try {
  const h=await f.handoff(),claim=await f.claim(h);
  assert.equal((await f.request('lifecycle.agent.report',f.reportInput(h,claim,'FAILED'),true)).status,200);
  await f.wait(h.stageRequestId,'FAILED');
  const original=await f.request('lifecycle.agent.handoff.read',{stageRequestId:h.stageRequestId});
  await f.server.close();store=new RuntimeStore(f.root,'synthetic-agent');
  const saved=store.object('alpha','lifecycle-instance',h.instanceId);
  // Fixture authority already pins maxAttempts; do not fabricate a new grant.
  assert(saved.pins.budget.maxAttempts>=2,'Historical retry fixture needs existing two-attempt authority');
  const next=requestStage(saved,'implementation','synthetic-next-attempt',{authority:f.authority,bindingsCurrent:true});
  store.mutate(f.actor,{projectId:'alpha',operation:'synthetic.next-attempt',requestId:'synthetic-history-transition',expectedRevision:store.revision('alpha'),input:{synthetic:true},permission:'read'},()=>({objects:[{kind:'lifecycle-instance',id:saved.id,value:next}],value:{synthetic:true},event:{type:'synthetic-history-transition',data:{}}}));
  let permits=0;const agent=createAgentService(store,async()=>{permits++;throw new Error('Old attempt must not reach permit');});
  const read=agent.read(f.actor,'alpha','lifecycle.agent.handoff.read',{stageRequestId:h.stageRequestId});
  assert.deepEqual(read.handoff,original.body.result.handoff);assert.deepEqual(read.latestReport,original.body.result.latestReport);
  assert.throws(()=>readAgentHandoff(store,'alpha',h.stageRequestId),{code:'CORRUPT_AGENT_EVIDENCE'});
  await assert.rejects(agent.write(f.actor,'alpha','lifecycle.agent.report',f.reportInput(h,claim,'WORKING'),'old-report-rewrite',store.revision('alpha'),()=>f.actor),{code:'CORRUPT_AGENT_EVIDENCE'});
  assert.equal(permits,0);
 }finally{store?.close();await f.cleanup();}
});
