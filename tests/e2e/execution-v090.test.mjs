// Development regression: synthetic assets/decisions, real service persistence,
// protected policy, evidence files and HTTP/MCP/CLI. No real release authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  f.open=async()=>f.server=await startRuntimeServer(f.options,bindings.provider,undefined,policy);
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
