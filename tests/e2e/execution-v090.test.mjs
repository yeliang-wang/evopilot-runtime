// Development regression: synthetic assets/decisions, real service persistence,
// protected policy, evidence files and HTTP/MCP/CLI. No real release authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { initializeCredentials, tokenDigest, currentPrincipal } from '../../dist/server/security.js';
import { startRuntimeServer } from '../../dist/server/http.js';
import { serviceMain } from '../../dist/server/cli.js';
import { RuntimeStore } from '../../dist/server/store.js';
import { valueDigest } from '../../dist/lifecycle/base.js';
import { requestStage, recordStageOutcome, stageAdmission } from '../../dist/lifecycle/instance.js';
import { createAuthorityService, registeredAuthorityPolicy } from '../../dist/adapters/authority.js';
import { lifecycle, yaml, syntheticBindings } from '../fixtures/lifecycle-v090.mjs';

function fixture(){
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'runtime-v090-execution-')),root=join(dir,'state'),tokens={};
  const permissions={reader:['read'],owner:['read','draft.write','definition.activate'],executor:['read','execution.request'],decider:['read','decision.record'],outsider:['read','decision.record'],publisher:['read','execution.request','release.request']};
  const principals=Object.entries(permissions).map(([id,permissions])=>{tokens[id]=randomBytes(32).toString('hex');return{id,permissions,projects:['alpha'],revision:1,expiresAt:'2030-01-01T00:00:00Z',tokenDigest:tokenDigest(tokens[id])};});
  initializeCredentials(root,'synthetic',principals);
  const data=lifecycle();for(const stage of ['plan','verification'])data.config[stage].budget={timeoutSeconds:600,maxAttempts:2,maxConcurrency:2,maxLoops:1};
  const config={schema:'runtime-integrations/v1',workspaceId:'synthetic',revision:1,owners:[],platforms:[],credentials:[],resources:['authorityPolicyRef','decisionSourceRef'].map(field=>({ref:data.config['release-decision'][field],workspaceId:'synthetic',projectId:'alpha',role:'config.release-decision.'+field,revision:1,expiresAt:'2030-01-01T00:00:00Z',definition:field==='authorityPolicyRef'?{kind:'authority-policy',principalIds:['decider'],exactSubjectRequired:true}:{kind:'decision-source',backend:'runtime',decisionTypes:['execution','release']}}))};
  const configPath=join(dir,'integrations.json'),saveConfig=()=>writeFileSync(configPath,JSON.stringify(config),{mode:0o600});saveConfig();
  const bindings=syntheticBindings(),policy=registeredAuthorityPolicy(configPath,'synthetic');
  const f={dir,root,tokens,principals,data,config,configPath,saveConfig,bindings,policy,revision:0,sequence:0,options:{stateRoot:root,workspaceId:'synthetic'},cleanup:()=>rmSync(dir,{recursive:true,force:true})};
  f.open=async()=>f.server=await startRuntimeServer(f.options,bindings.provider,undefined,policy,f.executor);
  return f;
}
async function request(f,operation,input={},actor='owner',meta={}){
  const r=await fetch(f.server.url+'/api/v1/request',{method:'POST',headers:{authorization:'Bearer '+f.tokens[actor],'content-type':'application/json'},body:JSON.stringify({operation,projectId:'alpha',input,...meta})});
  const value={status:r.status,...await r.json()};if(value.result?.revision)f.revision=value.result.revision;return value;
}
const write=(f,operation,input,actor='decider',meta={})=>request(f,operation,input,actor,{requestId:'request-'+(++f.sequence),expectedRevision:f.revision,...meta});
async function activate(f){
  const source=yaml(f.data),preview=await request(f,'lifecycle.definition.validate',{yaml:source});
  const activated=await write(f,'lifecycle.definition.save-and-activate',{yaml:source,validationDigest:preview.result.validationDigest},'owner');
  assert.equal(activated.result.result.status,'ACTIVE');f.definitionRevisionId=activated.result.result.activeRevisionId;
}
function executionSubject(f,id='one'){return{instanceId:id,definitionRevisionId:f.definitionRevisionId,goalRef:'synthetic:goal/one',targetRef:'synthetic:target/one',loopRef:'synthetic:loop/one',budget:{...f.data.config.plan.budget},expiresAt:new Date(Date.now()+3600000).toISOString()};}
function evidence(f,review,decision='APPROVE',mutate=v=>v){
  const serial=++f.sequence,source=join(f.dir,'synthetic-source-'+serial+'.txt');
  writeFileSync(source,'Synthetic decision fixture only; not a user approval. '+serial,{mode:0o600});
  const pin=path=>pathToFileURL(path).href+'#sha256='+createHash('sha256').update(readFileSync(path)).digest('hex');
  const path=join(f.dir,'synthetic-decision-'+serial+'.json');
  const content={schema:'evopilot-decision-evidence/v1',subject:{owner:'runtime',operation:'lifecycle.authority.'+review.kind,workspaceId:'synthetic',scope:{visibility:'private',projectId:'alpha'},reviewDigest:review.reviewDigest,decision},source:{reference:pin(source),description:'Synthetic authority regression fixture'}};
  writeFileSync(path,JSON.stringify(mutate(content)),{mode:0o600});return{ref:pin(path),path,source};
}
async function reviewed(f,kind='execution',subject=executionSubject(f),choice='APPROVE'){
  const preview=await request(f,'lifecycle.authority.preview',{kind,subject},'decider');assert.equal(preview.status,200,JSON.stringify(preview));
  const proof=evidence(f,preview.result,choice);return{kind,subject,reviewDigest:preview.result.reviewDigest,decision:choice,evidenceRef:proof.ref,proof};
}
async function grant(f,kind,subject,choice){const {proof,...input}=await reviewed(f,kind,subject,choice),result=await write(f,'lifecycle.authority.record',input);assert.equal(result.status,200,JSON.stringify(result));return{input,proof,ref:result.result.result.authorityRef,receipt:result.result};}
async function create(f,grant,id='one'){return write(f,'lifecycle.instance.create',{instanceId:id,definitionRevisionId:f.definitionRevisionId,authorityRef:grant.ref},'executor');}
async function inspect(f,ref){return request(f,'lifecycle.authority.inspect',{authorityRef:ref},'reader');}

// One execution approval is consumed by one immutable instance identity; restart
// and a repeated API request reuse its receipts rather than renewing the budget.
test('exact authenticated evidence enables one inert instance, survives restart, and cannot reset or widen scope',async()=>{
  const f=fixture();await f.open();try{
    await activate(f);
    const denied=await write(f,'lifecycle.instance.create',{instanceId:'one',definitionRevisionId:f.definitionRevisionId,authorityRef:'authority:'+valueDigest('missing')},'executor');assert.equal(denied.status,404);
    assert.equal((await request(f,'lifecycle.authority.preview',{kind:'execution',subject:executionSubject(f)},'owner')).status,403);
    const g=await grant(f);assert.equal(g.receipt.result.executionDispatched,false);
    assert.equal((await inspect(f,g.ref)).result.usable,true);
    assert.equal((await create(f,g,'another-instance')).error.code,'AUTHORITY_MISMATCH');
    const created=await create(f,g);assert.equal(created.status,200,JSON.stringify(created));assert.equal(created.result.result.executionDispatched,false);
    const snapshot=await request(f,'lifecycle.instance.inspect',{instanceId:'one'});assert.deepEqual(snapshot.result.instance.requestIds,[]);
    const replayMeta={requestId:created.result.requestId,expectedRevision:0};
    assert.deepEqual((await write(f,'lifecycle.instance.create',{instanceId:'one',definitionRevisionId:f.definitionRevisionId,authorityRef:g.ref},'executor',replayMeta)).result,created.result);
    assert.equal((await request(f,'lifecycle.authority.preview',{kind:'execution',subject:executionSubject(f)},'decider')).error.code,'INSTANCE_EXISTS');
    await f.server.close();await f.open();
    assert.deepEqual((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance,snapshot.result.instance);
    assert.equal((await request(f,'lifecycle.stage.admission',{instanceId:'one',stageId:'scope'},'executor')).result.allowed,true);
    const rev=await write(f,'lifecycle.authority.revoke',{authorityRef:g.ref,reason:'Synthetic withdrawal'});assert.equal(rev.result.result.status,'REVOKED');
    const prior=await inspect(f,g.ref);assert.equal(prior.result.decision.choice,'APPROVE');assert.equal(prior.result.usable,false);assert.equal(prior.result.reason,'AUTHORITY_REVOKED');
    assert.equal((await request(f,'lifecycle.stage.admission',{instanceId:'one',stageId:'scope'},'executor')).error.code,'AUTHORITY_REVOKED');
    assert.deepEqual((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance,snapshot.result.instance);
    assert.deepEqual((await write(f,'lifecycle.authority.record',g.input,'decider',{requestId:g.receipt.requestId,expectedRevision:0})).result,g.receipt,'replay retains history, not a new usable grant');
  }finally{await f.server.close();f.cleanup();}
});

test('decision permission alone, spoofed fields, wrong evidence scope and stale review cannot grant authority',async()=>{
  const f=fixture();await f.open();try{
    await activate(f);const {proof,...input}=await reviewed(f);
    assert.equal((await write(f,'lifecycle.authority.record',input,'outsider')).error.code,'DECISION_PRINCIPAL');
    const before=f.revision;
    for(const changed of [{...input,subject:{...input.subject,goalRef:'synthetic:goal/different'}},{...input,subject:{...input.subject,budget:{...input.subject.budget,maxAttempts:3}}},{...input,reviewDigest:valueDigest('wrong')},{...input,evidenceRef:'conversation:APPROVED'},{...input,decision:'PASS'},{...input,subject:{...input.subject,approved:true}}])assert.notEqual((await write(f,'lifecycle.authority.record',changed)).status,200);
    const preview=(await request(f,'lifecycle.authority.preview',{kind:input.kind,subject:input.subject},'decider')).result;
    for(const mutate of [v=>({...v,subject:{...v.subject,scope:{visibility:'private',projectId:'beta'}}}),v=>({...v,subject:{...v.subject,operation:'lifecycle.authority.release'}}),v=>({...v,subject:{...v.subject,decision:'REJECT'}})]){
      const p=evidence(f,preview,'APPROVE',mutate);assert.equal((await write(f,'lifecycle.authority.record',{...input,evidenceRef:p.ref})).error.code,'DECISION_EVIDENCE_REQUIRED');
    }
    assert.equal(f.revision,before);
    f.config.resources[0].revision++;f.saveConfig();assert.equal((await write(f,'lifecycle.authority.record',input)).error.code,'AUTHORITY_REVIEW_STALE');
    assert.equal(f.revision,before);
    writeFileSync(proof.source,'changed synthetic source');assert.equal((await write(f,'lifecycle.authority.record',input)).status,409);
  }finally{await f.server.close();f.cleanup();}
});

test('current policy, grantor capability, credential revision, evidence bytes and expiry are rechecked before use',async()=>{
  for(const variant of ['policy','scope','capability','revision','evidence','expiry']){
    const f=fixture();await f.open();try{
      await activate(f);const g=await grant(f);
      if(variant==='policy'){f.config.resources[0].revision++;f.saveConfig();}
      if(variant==='expiry'){f.config.resources[0].expiresAt='2020-01-01T00:00:00Z';f.saveConfig();}
      if(variant==='evidence')writeFileSync(g.proof.source,'modified source');
      if(['scope','capability','revision'].includes(variant)){
        const path=join(f.root,'auth.json'),auth=JSON.parse(readFileSync(path));const d=auth.principals.find(p=>p.id==='decider');
        if(variant==='scope')d.projects=['beta'];if(variant==='capability')d.permissions=['read'];if(variant==='revision')d.revision++;
        writeFileSync(path,JSON.stringify(auth));
      }
      assert.equal((await inspect(f,g.ref)).result.usable,false,variant);
      assert.notEqual((await create(f,g)).status,200,variant);
      assert.equal((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).status,404,variant);
    }finally{await f.server.close();f.cleanup();}
  }
});

test('reject decisions remain readable; policy-less service never promotes activation to execution or a file to authority',async()=>{
  const f=fixture();await f.open();try{
    await activate(f);const g=await grant(f,'execution',executionSubject(f),'REJECT');assert.equal((await inspect(f,g.ref)).result.usable,false);
    assert.notEqual((await create(f,g)).status,200);
    await f.server.close();f.server=await startRuntimeServer(f.options,f.bindings.provider);
    assert.equal((await request(f,'lifecycle.authority.preview',{kind:'execution',subject:executionSubject(f)},'decider')).error.code,'AUTHORITY_POLICY_UNAVAILABLE');
    assert.equal((await request(f,'lifecycle.definition.inspect')).result.active.id,f.definitionRevisionId);
  }finally{await f.server.close();f.cleanup();}
});

test('revocation during asynchronous current binding verification prevents instance commit',async()=>{
  const f=fixture();await f.open();try{
    await activate(f);const g=await grant(f);
    f.bindings.state.during=async()=>{
      f.bindings.state.during=null;
      assert.equal((await write(f,'lifecycle.authority.revoke',{authorityRef:g.ref,reason:'Synthetic concurrent revocation'})).status,200);
    };
    const denied=await create(f,g);assert.notEqual(denied.status,200);
    assert.equal((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).status,404);
    assert.equal((await inspect(f,g.ref)).result.usable,false);
  }finally{await f.server.close();f.cleanup();}
});

test('removing grantor capability during binding verification rejects even without a service revision change',async()=>{
  const f=fixture();await f.open();try{
    await activate(f);const g=await grant(f);
    f.bindings.state.during=async()=>{f.bindings.state.during=null;const p=join(f.root,'auth.json'),c=JSON.parse(readFileSync(p));c.principals.find(x=>x.id==='decider').permissions=['read'];writeFileSync(p,JSON.stringify(c));};
    const denied=await create(f,g);assert.equal(denied.error.code,'FORBIDDEN');assert.equal((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).status,404);
  }finally{await f.server.close();f.cleanup();}
});

// Test fixture advances the reducer via the store's internal trusted API. The
// HTTP API intentionally has no client-supplied PASS/StageOutcome endpoint.
async function syntheticVerification(f,g){
  await f.server.close();const store=new RuntimeStore(f.root,'synthetic');
  try{
    const actor=currentPrincipal(f.root,'synthetic','executor'),svc=createAuthorityService(store,f.policy,id=>currentPrincipal(f.root,'synthetic',id));
    let instance=store.object('alpha','lifecycle-instance','one');const authority=await svc.resolveExecution(g.ref,instance.definition,actor,new AbortController().signal);
    for(const stage of ['scope','plan','implementation','candidate','verification']){
      instance=requestStage(instance,stage,'synthetic-'+stage,{authority,bindingsCurrent:true});
      instance=recordStageOutcome(instance,stage,{requestId:instance.stages[stage].requestId,inputDigest:instance.stages[stage].inputDigest,receiptRef:'synthetic:receipt/'+stage,status:'COMPLETE',expiresAt:new Date(Date.now()+3600000).toISOString(),checks:instance.definition.nodes.find(n=>n.id===stage).checks.map(id=>({id,status:'PASS',evidenceRef:'synthetic:check/'+id})),...(stage==='candidate'?{candidate:{schema:'runtime-candidate/v1',version:'test-rc',profile:'candidate-verification',sourceDigest:valueDigest('synthetic-source'),buildDigest:valueDigest('synthetic-build'),artifacts:[{name:'synthetic.tgz',digest:valueDigest('synthetic-bytes'),bytes:64}]}}:{})});
    }
    const r=store.mutate(actor,{projectId:'alpha',operation:'synthetic-test-stage-fixture',requestId:'synthetic-fixture',expectedRevision:store.revision('alpha'),input:{pins:instance.pinsDigest},permission:'execution.request'},()=>({objects:[{kind:'lifecycle-instance',id:'one',value:instance}],value:{fixtureOnly:true},event:{type:'synthetic-fixture',data:{fixtureOnly:true}}}));f.revision=r.revision;return instance;
  }finally{store.close();await f.open();}
}

test('separate release decision pins verified instance, requirements and immutable candidate; rejection/revocation never falls back',async()=>{
  const f=fixture();await f.open();try{
    await activate(f);const g=await grant(f);await create(f,g);
    assert.equal((await request(f,'lifecycle.authority.preview',{kind:'release',subject:{instanceId:'one',candidateDigest:valueDigest('none'),expiresAt:g.input.subject.expiresAt}},'decider')).error.code,'CANDIDATE_REQUIRED');
    const instance=await syntheticVerification(f,g),subject={instanceId:'one',candidateDigest:instance.candidateDigest,expiresAt:g.input.subject.expiresAt};
    assert.equal((await request(f,'lifecycle.authority.preview',{kind:'release',subject:{...subject,candidateDigest:valueDigest('other')}},'decider')).error.code,'CANDIDATE_REQUIRED');
    const release=await grant(f,'release',subject);assert.equal((await inspect(f,release.ref)).result.usable,true);
    assert.equal((await request(f,'lifecycle.stage.admission',{instanceId:'one',stageId:'publication'},'executor')).status,403);
    const pending=await request(f,'lifecycle.stage.admission',{instanceId:'one',stageId:'publication'},'publisher');assert.equal(pending.result.allowed,false,'decision still cannot bypass the release-decision stage');assert.ok(!pending.result.reasons.includes('EXACT_RELEASE_AUTHORITY_REQUIRED'));
    await f.server.close();const store=new RuntimeStore(f.root,'synthetic');try{
      const svc=createAuthorityService(store,f.policy,id=>currentPrincipal(f.root,'synthetic',id)),actor=currentPrincipal(f.root,'synthetic','publisher'),exact=svc.resolveRelease(instance,actor);
      assert.equal(exact.instanceId,'one');assert.equal(exact.pinsDigest,instance.pinsDigest);assert.equal(exact.requirementsDigest,instance.pins.requirementsDigest);
      const authority=await svc.resolveExecution(g.ref,instance.definition,actor,new AbortController().signal);
      for(const changed of [{...exact,instanceId:'two'},{...exact,pinsDigest:valueDigest('other')},{...exact,definitionRevisionId:valueDigest('other')},{...exact,requirementsDigest:valueDigest('other')}])assert.ok(stageAdmission(instance,'publication',{authority,bindingsCurrent:true,releaseAuthority:changed}).reasons.includes('EXACT_RELEASE_AUTHORITY_REQUIRED'));
    }finally{store.close();await f.open();}
    await grant(f,'release',subject,'REJECT');assert.notEqual((await request(f,'lifecycle.stage.admission',{instanceId:'one',stageId:'publication'},'publisher')).status,200,'latest rejection cannot resurrect earlier approval');
    const again=await grant(f,'release',subject);await write(f,'lifecycle.authority.revoke',{authorityRef:again.ref,reason:'Synthetic release revoked'});
    assert.notEqual((await request(f,'lifecycle.stage.admission',{instanceId:'one',stageId:'publication'},'publisher')).status,200);
  }finally{await f.server.close();f.cleanup();}
});

test('MCP separates read/write decisions and CLI uses the same protected decision envelope and durable receipt',async()=>{
  const f=fixture();await f.open();const client=new Client({name:'synthetic-authority-regression',version:'1.0.0'});try{
    await activate(f);const {proof,...input}=await reviewed(f);
    await client.connect(new StreamableHTTPClientTransport(new URL(f.server.url+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+f.tokens.decider}}}));
    const envelope={operation:'lifecycle.authority.record',projectId:'alpha',input,requestId:'same-authority',expectedRevision:f.revision};
    assert.equal((await client.callTool({name:'runtime_read',arguments:envelope})).isError,true);
    const result=await client.callTool({name:'runtime_write',arguments:envelope});assert.notEqual(result.isError,true,JSON.stringify(result));const receipt=JSON.parse(result.content[0].text).result;f.revision=receipt.revision;
    const tokenRef=join(f.dir,'client.json'),requestRef=join(f.dir,'request.json');
    writeFileSync(tokenRef,JSON.stringify({schema:'runtime-client-credential/v1',workspaceId:'synthetic',projectId:'alpha',principalId:'decider',token:f.tokens.decider}),{mode:0o600});writeFileSync(requestRef,JSON.stringify(envelope),{mode:0o600});
    let output='';assert.equal(await serviceMain(['request','--url',f.server.url,'--token-ref',tokenRef,'--project','alpha','--request-ref',requestRef],{write:v=>output+=v}),0);assert.deepEqual(JSON.parse(output).result,receipt);assert.ok(!output.includes(f.tokens.decider));
    assert.equal((await request(f,'runtime.status')).result.revision,f.revision);
  }finally{await client.close();await f.server.close();f.cleanup();}
});

test('a later exact execution rejection supersedes an older approval without erasing history',async()=>{
  const f=fixture();await f.open();try{
    await activate(f);const subject=executionSubject(f),approved=await grant(f,'execution',subject);
    const denied=await grant(f,'execution',subject,'REJECT');
    assert.equal((await inspect(f,approved.ref)).result.reason,'AUTHORITY_SUPERSEDED');
    assert.equal((await inspect(f,denied.ref)).result.usable,false);
    assert.notEqual((await create(f,approved)).status,200);
    const reviewedAgain=await grant(f,'execution',subject);assert.equal((await create(f,reviewedAgain)).status,200);
  }finally{await f.server.close();f.cleanup();}
});

test('execution review rejects expired/over-limit budgets and preserves policy across unrelated config revisions',async()=>{
  const f=fixture();await f.open();try{
    await activate(f);const subject=executionSubject(f);
    for(const changed of [{...subject,expiresAt:'2020-01-01T00:00:00Z'},{...subject,expiresAt:'2035-01-01T00:00:00Z'},{...subject,budget:{...subject.budget,timeoutSeconds:3601}},{...subject,budget:{...subject.budget,maxAttempts:0}},{...subject,budget:{...subject.budget,timeoutSeconds:1}}])assert.notEqual((await request(f,'lifecycle.authority.preview',{kind:'execution',subject:changed},'decider')).status,200);
    const g=await grant(f,'execution',subject);f.config.revision++;f.saveConfig();assert.equal((await inspect(f,g.ref)).result.usable,true);
    const path=join(f.root,'auth.json'),auth=JSON.parse(readFileSync(path));auth.principals.find(p=>p.id==='decider').expiresAt='2020-01-01T00:00:00Z';writeFileSync(path,JSON.stringify(auth));
    assert.equal((await inspect(f,g.ref)).result.usable,false);assert.notEqual((await create(f,g)).status,200);
  }finally{await f.server.close();f.cleanup();}
});

test('expired transitive verification evidence invalidates release authority without rewriting its historical decision',async()=>{
  const f=fixture();await f.open();try{
    await activate(f);const g=await grant(f);await create(f,g);const instance=await syntheticVerification(f,g);
    const subject={instanceId:'one',candidateDigest:instance.candidateDigest,expiresAt:g.input.subject.expiresAt},release=await grant(f,'release',subject);
    await f.server.close();const store=new RuntimeStore(f.root,'synthetic');try{
      const actor=currentPrincipal(f.root,'synthetic','executor'),stale=structuredClone(store.object('alpha','lifecycle-instance','one'));stale.stages.scope.expiresAt='2020-01-01T00:00:00Z';
      const r=store.mutate(actor,{projectId:'alpha',operation:'synthetic-expired-evidence-fixture',requestId:'synthetic-expiry',expectedRevision:store.revision('alpha'),input:{fixtureOnly:true},permission:'execution.request'},()=>({objects:[{kind:'lifecycle-instance',id:'one',value:stale}],value:{fixtureOnly:true},event:{type:'synthetic-evidence-expired',data:{fixtureOnly:true}}}));f.revision=r.revision;
    }finally{store.close();await f.open();}
    const retained=await inspect(f,release.ref);assert.equal(retained.result.decision.choice,'APPROVE');assert.equal(retained.result.usable,false);assert.equal(retained.result.reason,'RELEASE_EVIDENCE_REQUIRED');
    assert.equal((await request(f,'lifecycle.authority.preview',{kind:'release',subject},'decider')).error.code,'RELEASE_EVIDENCE_REQUIRED');
    assert.equal((await request(f,'lifecycle.stage.admission',{instanceId:'one',stageId:'publication'},'publisher')).error.code,'RELEASE_EVIDENCE_REQUIRED');
  }finally{await f.server.close();f.cleanup();}
});

function stageAdapter(f){
  const state={dispatches:0,inspections:0,mode:'complete',inspectMode:'unknown',prepare:null,dispatch:null};
  const adapterDigest=valueDigest('synthetic-stage-adapter-v1');
  function observe(r,i,mode){
    const phase=mode==='complete'?'COMPLETE':mode==='fail'?'FAILED':mode==='running'?'CI_RUNNING':mode==='waiting'?'WAITING_AGENT':'UNKNOWN';
    return{requestId:r.id,inputDigest:r.inputDigest,adapterDigest,phase,handle:mode==='unknown'?null:{syntheticRequest:r.id},outcome:{requestId:r.id,inputDigest:r.inputDigest,receiptRef:'synthetic:receipt/'+r.id,status:phase==='COMPLETE'?'COMPLETE':phase==='FAILED'?'FAILED':phase==='UNKNOWN'?'UNKNOWN':'RUNNING',expiresAt:new Date(Date.now()+60000).toISOString(),checks:phase==='COMPLETE'?i.definition.nodes.find(n=>n.id===r.stageId).checks.map(id=>({id,status:'PASS',evidenceRef:'synthetic:check/'+id})):[]}};
  }
  const adapter={
    async prepare(i,stageId){if(state.prepare)await state.prepare();return{adapterId:'synthetic-stage-adapter',adapterDigest,action:'base.'+stageId,bindingDigest:valueDigest('synthetic-binding'),parameters:{synthetic:true}};},
    async dispatch(r,i,permit,signal){await permit();state.dispatches++;if(state.dispatch)return state.dispatch(r,i,signal);if(state.mode==='hang')return new Promise(()=>{});return observe(r,i,state.mode);},
    async inspect(r,i,p){state.inspections++;const o=observe(r,i,state.inspectMode);if(p.handle!==null)o.handle=p.handle;return o;},
  };
  f.executor=adapter;return{state,adapter,observe};
}
async function execWrite(f,op,input,actor='executor',meta={}){await request(f,'runtime.status');return write(f,op,input,actor,meta);}
async function stageState(f,id){return request(f,'lifecycle.stage.request.inspect',{stageRequestId:id},'reader');}
async function until(probe,predicate,timeout=5000){const end=Date.now()+timeout;let value;do{value=await probe();if(predicate(value))return value;await new Promise(r=>setTimeout(r,10));}while(Date.now()<end);assert.fail('Timed out waiting for exact retained stage state: '+JSON.stringify(value));}
async function executingFixture(){const f=fixture(),adapter=stageAdapter(f);await f.open();await activate(f);const g=await grant(f);assert.equal((await create(f,g)).status,200);return{f,g,...adapter};}

test('explicit stage advance retains the original plan and budget; replay and background inspection cannot repeat it',async()=>{
  const {f,state,adapter,observe}=await executingFixture();let advances=0;
  try{
    state.mode='running';state.inspectMode='running';adapter.advance=async(r,i,p,permit)=>{await permit();advances++;const o=observe(r,i,'complete');o.handle=p.handle;return o;};
    const started=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=started.result.result.stageRequestId;
    const original=await until(()=>stageState(f,id),r=>r.result.progress.phase==='CI_RUNNING');
    assert.equal(advances,0);assert.equal((await execWrite(f,'lifecycle.stage.advance',{stageRequestId:id},'reader')).status,403);
    assert.equal((await execWrite(f,'lifecycle.stage.advance',{stageRequestId:id,command:'arbitrary'})).error.code,'INVALID_FIELDS');
    const advanced=await execWrite(f,'lifecycle.stage.advance',{stageRequestId:id});assert.equal(advanced.status,200,JSON.stringify(advanced));assert.equal(advanced.result.result.newAttempt,false);
    assert.equal(advanced.result.result.deadlineAt,original.result.request.deadlineAt);await until(()=>stageState(f,id),r=>r.result.progress.phase==='COMPLETE');
    const replay=await execWrite(f,'lifecycle.stage.advance',{stageRequestId:id},'executor',{requestId:advanced.result.requestId,expectedRevision:0});assert.deepEqual(replay.result,advanced.result);
    assert.equal(advances,1);assert.equal(state.dispatches,1);
    const saved=(await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance;assert.equal(saved.stages.scope.attempts,1);assert.equal(saved.requestIds.length,1);
    await f.server.close();await f.open();assert.equal((await stageState(f,id)).result.progress.phase,'COMPLETE');assert.equal(advances,1);
  }finally{await f.server.close();f.cleanup();}
});
test('stage advance cannot bypass revocation or substitute another execution principal',async()=>{
  const {f,g,state,adapter,observe}=await executingFixture();let advances=0;
  try{
    state.mode='running';state.inspectMode='running';adapter.advance=async(r,i,p,permit)=>{await permit();advances++;return observe(r,i,'complete');};
    const started=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=started.result.result.stageRequestId;await until(()=>stageState(f,id),r=>r.result.progress.phase==='CI_RUNNING');
    assert.equal((await execWrite(f,'lifecycle.stage.advance',{stageRequestId:id},'publisher')).error.code,'AUTHORITY_CHANGED');
    await execWrite(f,'lifecycle.authority.revoke',{authorityRef:g.ref,reason:'Synthetic withdrawal'},'decider');
    assert.equal((await execWrite(f,'lifecycle.stage.advance',{stageRequestId:id})).error.code,'AUTHORITY_REVOKED');assert.equal(advances,0);assert.equal(state.dispatches,1);
    assert.equal((await execWrite(f,'lifecycle.stage.reconcile',{stageRequestId:id},'reader')).status,200);
  }finally{await f.server.close();f.cleanup();}
});

test('stage request is durable before adapter side effects; exact replay never redispatches and client PASS is rejected',async()=>{
  const {f,state,observe}=await executingFixture();try{
    state.dispatch=async(r,i)=>{
      const retained=await stageState(f,r.id);assert.equal(retained.status,200);assert.equal(retained.result.request.digest,r.digest);assert.equal(retained.result.progress.phase,'DISPATCHING');
      const events=await request(f,'runtime.events.read',{},'reader');assert.ok(events.result.events.some(e=>e.type==='stage-requested'&&e.data.stageRequestId===r.id));
      return observe(r,i,'complete');
    };
    assert.equal((await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'},'reader')).status,403);
    assert.equal((await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope',status:'PASS'})).error.code,'INVALID_FIELDS');
    const dispatched=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'});assert.equal(dispatched.status,200,JSON.stringify(dispatched));
    const id=dispatched.result.result.stageRequestId,result=await until(()=>stageState(f,id),r=>r.result.progress.terminal);
    assert.equal(result.result.progress.phase,'COMPLETE');assert.equal(state.dispatches,1);
    const replay=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'},'executor',{requestId:dispatched.result.requestId,expectedRevision:0});assert.deepEqual(replay.result,dispatched.result);assert.equal(state.dispatches,1);
    assert.equal((await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'plan'},'executor',{requestId:dispatched.result.requestId,expectedRevision:0})).error.code,'REQUEST_CONFLICT');
    assert.equal((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance.stages.scope.status,'PASSED');
    const events=await request(f,'runtime.events.read',{},'reader');assert.ok(events.result.events.some(e=>e.type==='stage-observed'&&e.data.phase==='COMPLETE'));
  }finally{await f.server.close();f.cleanup();}
});

test('unknown original requests cannot be retried; read-only reconciliation can retain actual completion after authority revocation',async()=>{
  const {f,g,state}=await executingFixture();try{
    state.mode='unknown';const sent=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=sent.result.result.stageRequestId;
    await until(()=>stageState(f,id),r=>r.result.progress.phase==='UNKNOWN');
    const before=(await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance;
    assert.equal((await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'})).error.code,'STAGE_BLOCKED');assert.equal(state.dispatches,1);
    await execWrite(f,'lifecycle.authority.revoke',{authorityRef:g.ref,reason:'Synthetic withdrawal after original dispatch'},'decider');
    state.inspectMode='complete';assert.equal((await execWrite(f,'lifecycle.stage.reconcile',{stageRequestId:id},'reader')).status,200);
    const done=await until(()=>stageState(f,id),r=>r.result.progress.terminal);assert.equal(done.result.progress.phase,'COMPLETE');assert.equal(state.dispatches,1);
    const after=(await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance;assert.deepEqual(after.requestIds,before.requestIds);assert.equal(after.stages.scope.attempts,1);
    assert.equal((await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'plan'})).error.code,'AUTHORITY_REVOKED');
  }finally{await f.server.close();f.cleanup();}
});

test('pending CI and waiting Agent remain distinct; owned observation continues without any client polling request',async()=>{
  const {f,state}=await executingFixture();try{
    state.mode='running';state.inspectMode='complete';const sent=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=sent.result.result.stageRequestId;
    const ongoing=await until(()=>stageState(f,id),r=>r.result.progress.phase==='CI_RUNNING');assert.equal(ongoing.result.progress.observation.outcome.status,'RUNNING');
    // No reconcile request: the service worker observes the already retained job.
    await new Promise(r=>setTimeout(r,3300));const finished=await stageState(f,id);assert.equal(finished.result.progress.phase,'COMPLETE');assert.equal(state.dispatches,1);assert.ok(state.inspections>=1);
    state.mode='waiting';state.inspectMode='waiting';const waiting=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'plan'});assert.equal(waiting.status,200,JSON.stringify(waiting));
    assert.equal((await until(()=>stageState(f,waiting.result.result.stageRequestId),r=>r.result.progress.phase==='WAITING_AGENT')).result.progress.terminal,false);
    assert.equal((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance.stages.plan.status,'RUNNING');
  }finally{await f.server.close();f.cleanup();}
});

test('service restart retains the same pending request, inspects it and does not redispatch',async()=>{
  const {f,state}=await executingFixture();try{
    state.mode='running';state.inspectMode='running';const sent=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=sent.result.result.stageRequestId;
    const before=await until(()=>stageState(f,id),r=>r.result.progress.phase==='CI_RUNNING');await f.server.close();state.inspectMode='complete';await f.open();
    const restored=await stageState(f,id);assert.deepEqual(restored.result.request,before.result.request);assert.equal(restored.result.progress.phase,'UNKNOWN');assert.equal(restored.result.progress.reason,'SERVICE_RESTART_RECONCILE');
    const old=await request(f,'lifecycle.stage.observation.read',{stageRequestId:id,observationRef:before.result.progress.observationRef},'reader');assert.equal(old.result.historical,true);assert.deepEqual(old.result.evidence.observation,before.result.progress.observation);
    assert.equal((await until(()=>stageState(f,id),r=>r.result.progress.terminal)).result.progress.phase,'COMPLETE');assert.equal(state.dispatches,1);
    assert.deepEqual((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance.requestIds,[id]);
  }finally{await f.server.close();f.cleanup();}
});

test('missing executor fails closed and unknown service receipts never accept substituted adapter input or handles',async()=>{
  const {f,state,observe}=await executingFixture();try{
    state.dispatch=async(r,i)=>({...observe(r,i,'complete'),inputDigest:valueDigest('different-request')});
    const bad=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=bad.result.result.stageRequestId;
    const rejected=await until(()=>stageState(f,id),r=>r.result.progress.phase==='UNKNOWN');assert.equal(rejected.result.progress.reason,'OBSERVATION_MISMATCH');assert.equal((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance.stages.scope.status,'UNKNOWN');
    await f.server.close();f.executor=undefined;await f.open();const retained=await stageState(f,id);assert.equal(retained.status,200);assert.equal(retained.result.progress.phase,'UNKNOWN');
    assert.equal((await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'})).error.code,'EXECUTOR_UNAVAILABLE');assert.equal(state.dispatches,1);
  }finally{await f.server.close();f.cleanup();}
});

test('revocation during read-only prepare causes no dispatch; an exhausted attempt budget cannot be renewed',async()=>{
  const first=await executingFixture();try{
    first.state.prepare=async()=>{first.state.prepare=null;await execWrite(first.f,'lifecycle.authority.revoke',{authorityRef:first.g.ref,reason:'Synthetic during prepare'},'decider');};
    assert.notEqual((await execWrite(first.f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'})).status,200);assert.equal(first.state.dispatches,0);
    assert.deepEqual((await request(first.f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance.requestIds,[]);
  }finally{await first.f.server.close();first.f.cleanup();}
  const {f,state}=await executingFixture();try{
    state.mode='fail';for(let n=0;n<2;n++){const sent=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'});assert.equal(sent.status,200);await until(()=>stageState(f,sent.result.result.stageRequestId),r=>r.result.progress.terminal);}
    assert.equal((await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'})).error.code,'STAGE_BLOCKED');assert.equal(state.dispatches,2);
    const fixed=(await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance;assert.equal(fixed.stages.scope.attempts,2);assert.equal(new Set(fixed.requestIds).size,2);
  }finally{await f.server.close();f.cleanup();}
});

test('shutdown aborts observation waiting, preserves unknown request and excludes unsafe or incomplete adapter evidence',async()=>{
  const {f,state,observe}=await executingFixture();try{
    state.mode='hang';const sent=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=sent.result.result.stageRequestId;
    await until(async()=>state.dispatches,n=>n===1);await f.server.close();state.inspectMode='unknown';await f.open();
    assert.equal((await stageState(f,id)).result.progress.phase,'UNKNOWN');assert.equal(state.dispatches,1);
    f.executor.inspect=async(r,i)=>{const o=observe(r,i,'complete');o.outcome.checks=[];return o;};
    await execWrite(f,'lifecycle.stage.reconcile',{stageRequestId:id},'reader');assert.equal((await until(()=>stageState(f,id),r=>r.result.progress.reason==='CHECKS_NOT_PASSED')).result.progress.terminal,false);
    f.executor.inspect=async(r,i)=>({...observe(r,i,'complete'),handle:{token:'synthetic-forbidden-raw-token'}});
    await execWrite(f,'lifecycle.stage.reconcile',{stageRequestId:id},'reader');assert.equal((await until(()=>stageState(f,id),r=>r.result.progress.reason==='INLINE_SECRET')).result.progress.terminal,false);
  }finally{await f.server.close();f.cleanup();}
});

test('a multi-call dispatch may exceed ten seconds without renewing its original stage deadline or attempt',async()=>{
  const {f,state,observe}=await executingFixture();try{
    state.dispatch=async(r,i,signal)=>{await new Promise(resolve=>setTimeout(resolve,10500));signal.throwIfAborted();return observe(r,i,'complete');};
    const sent=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=sent.result.result.stageRequestId;
    const before=(await stageState(f,id)).result.request;
    const finished=await until(()=>stageState(f,id),r=>r.result.progress.terminal,15000);
    assert.equal(finished.result.progress.phase,'COMPLETE');assert.deepEqual(finished.result.request,before);assert.equal(state.dispatches,1);assert.equal(state.inspections,0);
    const instance=(await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance;assert.equal(instance.stages.scope.attempts,1);
  }finally{await f.server.close();f.cleanup();}
});

test('real process death before/after a synthetic provider side effect preserves original identity and never redispatches',async()=>{
  for(const mode of ['execution-crash-before-dispatch','execution-crash-after-dispatch']){
    const {f,state,observe}=await executingFixture();await f.server.close();let worker;
    try{
      worker=spawn(process.execPath,[fileURLToPath(new URL('../fixtures/service-v090-worker.mjs',import.meta.url)),mode,f.root,'synthetic'],{stdio:['ignore','pipe','pipe']});
      let stderr='';worker.stderr.on('data',d=>stderr+=d);const exited=once(worker,'exit');
      const ready=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Crash worker not ready: '+stderr)),5000);worker.stdout.on('data',d=>{text+=d;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]));}});worker.once('exit',()=>{clearTimeout(timer);reject(Error('Crash worker exited before ready: '+stderr));});});
      f.server={url:ready.url,close:async()=>{}};
      await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'},'executor',{requestId:'crash-bound-request'}).catch(()=>{});
      const [code,signal]=await exited;assert.equal(code,null);assert.equal(signal,'SIGKILL');
      f.executor.inspect=async(r,i,p)=>{
        state.inspections++;
        if(mode==='execution-crash-before-dispatch')return observe(r,i,'unknown');
        const actual=JSON.parse(readFileSync(join(f.root,'synthetic-provider-request.json')));assert.equal(actual.requestId,r.id);assert.equal(actual.inputDigest,r.inputDigest);return observe(r,i,'complete');
      };
      await f.open();const original=await request(f,'runtime.receipt.read',{requestId:'crash-bound-request'},'executor');assert.equal(original.status,200);const id=original.result.result.stageRequestId;
      assert.equal((await stageState(f,id)).result.progress.phase,'UNKNOWN');
      if(mode==='execution-crash-after-dispatch')assert.equal((await until(()=>stageState(f,id),r=>r.result.progress.terminal)).result.progress.phase,'COMPLETE');
      else{await execWrite(f,'lifecycle.stage.reconcile',{stageRequestId:id},'reader');assert.equal((await stageState(f,id)).result.progress.terminal,false);assert.equal((await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'})).error.code,'STAGE_BLOCKED');}
      assert.equal(state.dispatches,0,'replacement process must only observe, never dispatch');assert.deepEqual((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance.requestIds,[id]);
    }finally{if(worker&&worker.exitCode===null&&worker.signalCode===null){worker.kill('SIGKILL');await once(worker,'exit');}await f.server.close();f.cleanup();}
  }
});

test('referenced execution resources cannot be retargeted under an old authority; unrelated registrations and metadata are not scope changes',async()=>{
  const f=fixture();stageAdapter(f);const path=join(f.dir,'target.md');writeFileSync(path,'Synthetic accepted target, revision one',{mode:0o600});
  const resource={ref:f.data.config.scope.targetInputRef,workspaceId:'synthetic',projectId:'alpha',role:'config.scope.targetInputRef',revision:1,expiresAt:'2030-01-01T00:00:00Z',definition:{kind:'document',format:'markdown',file:{path,digest:'sha256:'+createHash('sha256').update(readFileSync(path)).digest('hex')}}};
  f.config.resources.push(resource);f.saveConfig();await f.open();try{
    await activate(f);const g=await grant(f);await create(f,g);
    const sent=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'});await until(()=>stageState(f,sent.result.result.stageRequestId),r=>r.result.progress.terminal);
    resource.revision++;f.config.resources.push({...resource,ref:'binding:synthetic/unrelated',definition:{...resource.definition,format:'json'}});f.saveConfig();assert.equal((await inspect(f,g.ref)).result.usable,true);
    writeFileSync(path,'Synthetic changed target, not covered by the first decision');resource.definition.file.digest='sha256:'+createHash('sha256').update(readFileSync(path)).digest('hex');f.saveConfig();
    assert.equal((await inspect(f,g.ref)).result.reason,'AUTHORITY_BINDINGS_CHANGED');assert.equal((await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'plan'})).error.code,'AUTHORITY_BINDINGS_CHANGED');
    const saved=(await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance;assert.equal(saved.stages.plan.status,'PENDING');assert.equal(saved.requestIds.length,1);
  }finally{await f.server.close();f.cleanup();}
});

test('an observed provider handle cannot be swapped during reconciliation and its original receipt stays readable',async()=>{
  const {f,state,observe}=await executingFixture();try{
    state.mode='running';const sent=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=sent.result.result.stageRequestId;
    const original=await until(()=>stageState(f,id),r=>r.result.progress.phase==='CI_RUNNING');
    f.executor.inspect=async(r,i)=>({...observe(r,i,'complete'),handle:{syntheticRequest:'another-job'}});
    await execWrite(f,'lifecycle.stage.reconcile',{stageRequestId:id},'reader');
    const unknown=await until(()=>stageState(f,id),r=>r.result.progress.reason==='PROVIDER_HANDLE_CHANGED');assert.deepEqual(unknown.result.progress.handle,original.result.progress.handle);assert.equal(unknown.result.progress.terminal,false);
    const old=await request(f,'lifecycle.stage.observation.read',{stageRequestId:id,observationRef:original.result.progress.observationRef},'reader');assert.equal(old.result.evidence.observation.phase,'CI_RUNNING');assert.equal(state.dispatches,1);
  }finally{await f.server.close();f.cleanup();}
});

test('observation persistence failure is visible and recovery inspects the original action without dispatching again',async()=>{
  const {f,state}=await executingFixture(),original=RuntimeStore.prototype.mutate;
  try{
    RuntimeStore.prototype.mutate=function(actor,input,...rest){if(input.operation==='lifecycle.stage.observed')throw Error('Synthetic disk failure');return original.call(this,actor,input,...rest);};
    const sent=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=sent.result.result.stageRequestId;
    const failed=await until(()=>stageState(f,id),r=>r.result.workerError==='OBSERVATION_PERSISTENCE_FAILED');assert.equal(failed.result.progress.terminal,false);assert.equal((await request(f,'runtime.status')).result.observationWorker.state,'DEGRADED');
    RuntimeStore.prototype.mutate=original;state.inspectMode='complete';await execWrite(f,'lifecycle.stage.reconcile',{stageRequestId:id},'reader');
    const recovered=await until(()=>stageState(f,id),r=>r.result.progress.terminal);assert.equal(recovered.result.progress.phase,'COMPLETE');assert.equal(recovered.result.workerError,null);assert.equal(state.dispatches,1);assert.equal((await request(f,'runtime.status')).result.observationWorker.state,'READY');
  }finally{RuntimeStore.prototype.mutate=original;await f.server.close();f.cleanup();}
});
