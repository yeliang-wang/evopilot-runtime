// Development regression: synthetic assets/decisions, real service persistence,
// protected policy, evidence files and HTTP/MCP/CLI. No real release authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
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
import { valueDigest, byteDigest } from '../../dist/lifecycle/base.js';
import { evidenceValueDigest } from '../../dist/server/errors.js';
import { requestStage, recordStageOutcome, stageAdmission, pinInstance, requiredChecksDigest } from '../../dist/lifecycle/instance.js';
import { createAuthorityService, registeredAuthorityPolicy } from '../../dist/adapters/authority.js';
import { createReleaseStageAdapter } from '../../dist/adapters/release-stages.js';
import { ciSourceDigest } from '../../dist/adapters/artifacts.js';
import { releaseDocuments } from '../../dist/adapters/documents.js';
import { lifecycle, yaml, syntheticBindings } from '../fixtures/lifecycle-v090.mjs';

function fixture(){
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'runtime-v090-execution-')),root=join(dir,'state'),tokens={};
  const permissions={reader:['read'],owner:['read','draft.write','definition.activate'],executor:['read','execution.request'],decider:['read','decision.record'],outsider:['read','decision.record'],publisher:['read','execution.request','release.request']};
  const principals=Object.entries(permissions).map(([id,permissions])=>{tokens[id]=randomBytes(32).toString('hex');return{id,permissions,projects:['alpha'],revision:1,expiresAt:'2030-01-01T00:00:00Z',tokenDigest:tokenDigest(tokens[id])};});
  initializeCredentials(root,'synthetic',principals);
  const data=lifecycle();for(const stage of ['plan','verification'])data.config[stage].budget={timeoutSeconds:600,maxAttempts:2,maxConcurrency:2,maxLoops:1};
  const config={schema:'runtime-integrations/v1',workspaceId:'synthetic',revision:1,owners:[],platforms:[],credentials:[],resources:['authorityPolicyRef','decisionSourceRef'].map(field=>({ref:data.config['release-decision'][field],workspaceId:'synthetic',projectId:'alpha',role:'config.release-decision.'+field,revision:1,expiresAt:'2030-01-01T00:00:00Z',definition:field==='authorityPolicyRef'?{kind:'authority-policy',principalIds:['decider'],exactSubjectRequired:true}:{kind:'decision-source',backend:'runtime',decisionTypes:['execution','release']}}))};
  config.platforms.push({ref:'binding:alpha/platform',workspaceId:'synthetic',projectId:'alpha',provider:'github',host:'https://github.com',repository:'synthetic/release',repositoryId:'42',defaultBranch:'main',credentialRef:'credential:alpha/platform',revision:1,expiresAt:'2030-01-01T00:00:00Z',workflowPath:'.github/workflows/test.yml',runner:'ubuntu-latest'});
  config.credentials.push({ref:'credential:alpha/platform',workspaceId:'synthetic',projectId:'alpha',provider:'github',host:'https://github.com',tokenFile:join(dir,'unused-synthetic-token'),revision:1,expiresAt:'2030-01-01T00:00:00Z'});
  config.resources.push({ref:data.config['release-decision'].evidencePolicyRef,workspaceId:'synthetic',projectId:'alpha',role:'config.release-decision.evidencePolicyRef',revision:1,expiresAt:'2030-01-01T00:00:00Z',definition:{kind:'evidence-policy',requireAll:true,requireCurrent:true,allowSkipped:false,documentation:[{role:'release-notes',path:'RELEASE.md'},{role:'migration',path:'MIGRATION.md'},{role:'readme',path:'README.md'},{role:'technical',path:'docs/technical.md'}]}});
  const configPath=join(dir,'integrations.json'),saveConfig=()=>writeFileSync(configPath,JSON.stringify(config),{mode:0o600});saveConfig();
  const bindings=syntheticBindings(),policy=registeredAuthorityPolicy(configPath,'synthetic');
  const f={dir,root,tokens,principals,data,config,configPath,saveConfig,bindings,policy,revision:0,sequence:0,options:{stateRoot:root,workspaceId:'synthetic'},cleanup:()=>rmSync(dir,{recursive:true,force:true})};
  f.open=async()=>f.server=await startRuntimeServer(f.options,bindings.provider,f.authorities,policy,f.executor,f.preparation);
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
function executionSubject(f,id='one'){return{instanceId:id,definitionRevisionId:f.definitionRevisionId,goalRef:'synthetic:goal/'+id,targetRef:'synthetic:target/one',loopRef:'synthetic:loop/'+id,budget:{...f.data.config.plan.budget},expiresAt:new Date(Date.now()+3600000).toISOString()};}
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
async function grant(f,kind,subject,choice){const {proof,...input}=await reviewed(f,kind,subject,choice);await request(f,'runtime.status');const result=await write(f,'lifecycle.authority.record',input);assert.equal(result.status,200,JSON.stringify(result));return{input,proof,ref:result.result.result.authorityRef,receipt:result.result};}
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
async function syntheticVerification(f,g,collect=true){
  await f.server.close();const store=new RuntimeStore(f.root,'synthetic');
  try{
    const actor=currentPrincipal(f.root,'synthetic','executor'),svc=createAuthorityService(store,f.policy,id=>currentPrincipal(f.root,'synthetic',id));
    let instance=store.object('alpha','lifecycle-instance','one');const authority=await svc.resolveExecution(g.ref,instance.definition,actor,new AbortController().signal),binding=f.config.platforms[0],commit='b'.repeat(40);let candidateInput;
    for(const stage of ['scope','plan','implementation','candidate','verification']){
      const prior=instance,objects=[],admitted=svc.recovery.admission(prior,authority,stage,actor);assert.equal(admitted.allowed,true);
      instance=requestStage(instance,stage,'synthetic-'+stage,{authority,bindingsCurrent:true});
      const plan={adapterId:'synthetic-ci',adapterDigest:valueDigest('synthetic-ci'),action:'base.'+stage,bindingDigest:valueDigest(binding),parameters:{binding,commit,...(candidateInput?{candidateInput}:{})}},body={schema:'runtime-stage-request/v1',id:'synthetic-'+stage,workspaceId:'synthetic',projectId:'alpha',instanceId:'one',stageId:stage,pinsDigest:instance.pinsDigest,inputDigest:instance.stages[stage].inputDigest,bindingStamp:valueDigest('synthetic'),authorityRef:g.ref,releaseAuthorityRef:null,initiatedBy:{id:actor.id,revision:actor.revision},plan,planDigest:valueDigest(plan),requestedAt:new Date().toISOString(),deadlineAt:admitted.deadlineAt},original={...body,digest:valueDigest(body)};
      const outcome={requestId:original.id,inputDigest:original.inputDigest,receiptRef:'synthetic:receipt/'+stage,status:'COMPLETE',expiresAt:original.deadlineAt,checks:instance.definition.nodes.find(n=>n.id===stage).checks.map(id=>({id,status:'PASS',evidenceRef:'synthetic:check/'+id})),...(stage==='candidate'?{candidate:{schema:'runtime-candidate/v1',version:'test-rc',profile:'candidate-verification',sourceDigest:ciSourceDigest({commit},'github','42'),buildDigest:valueDigest('synthetic-build'),artifacts:[{name:'synthetic.tgz',digest:valueDigest('synthetic-bytes'),bytes:64}]}}:{})};
      instance=recordStageOutcome(instance,stage,outcome);
      const observation={requestId:original.id,inputDigest:original.inputDigest,adapterDigest:plan.adapterDigest,phase:'COMPLETE',handle:{synthetic:true},outcome};
      const envelope={schema:'runtime-stage-observation/v1',requestId:original.id,observation,reason:null,observedAt:new Date().toISOString()};
      objects.push({kind:'stage-request',id:original.id,value:original},{kind:'stage-observation',id:valueDigest(envelope),value:envelope},{kind:'stage-progress',id:original.id,value:{requestId:original.id,phase:'COMPLETE',terminal:true,handle:observation.handle,observation,observationRef:valueDigest(envelope),reason:null,observedAt:envelope.observedAt}});
      if(stage==='candidate'){
        candidateInput={schema:'runtime-ci-candidate-input/v1',manifest:instance.candidate,archive:{provider:'github',repositoryId:'42',runId:'10',artifactId:'11',jobId:null,archiveDigest:valueDigest('synthetic-archive'),archiveBytes:64}};
        const proof={schema:'runtime-candidate-source-evidence/v1',requestId:original.id,requestDigest:original.digest,pinsDigest:instance.pinsDigest,outcomeDigest:instance.stages.candidate.outcomeDigest,input:candidateInput};objects.push({kind:'stage-candidate-source',id:original.id,value:{...proof,digest:valueDigest(proof)}});
      }
      objects.push({kind:'lifecycle-instance',id:'one',value:instance});
      store.mutate(actor,{projectId:'alpha',operation:'synthetic-test-stage-fixture',requestId:'synthetic-fixture-'+stage,expectedRevision:store.revision('alpha'),input:{pins:instance.pinsDigest},permission:'execution.request'},()=>({objects:[...objects,...svc.recovery.claim(prior,authority,original,actor)],value:{fixtureOnly:true},event:{type:'synthetic-fixture',data:{fixtureOnly:true}}}));
    }
    f.releaseControls={documentReads:0,verificationReads:0,failVerification:false,failDocuments:false};
    f.releaseFactory=(s,services)=>createReleaseStageAdapter(s,f.configPath,{verification:{async inspect(r){f.releaseControls.verificationReads++;const p=s.object('alpha','stage-progress',r.id);return f.releaseControls.failVerification?{...p.observation,phase:'UNKNOWN'}:p.observation;}},platform:()=>({async documents(_a,input){f.releaseControls.documentReads++;if(f.releaseControls.failDocuments)throw Error('Synthetic document interruption');const documents=releaseDocuments(input.documents).map(d=>{const text=f.releaseControls.documentText??('# Synthetic '+d.role+'\nDocumentation fixture, not release approval.\n');return{...d,text,digest:byteDigest(text),bytes:Buffer.byteLength(text)};}),facts={provider:binding.provider,projectId:'alpha',repositoryId:binding.repositoryId,bindingDigest:valueDigest(binding),commit:input.commit,documents};return{schema:'runtime-release-documents/v1',...facts,factsDigest:evidenceValueDigest(facts),observedAt:new Date().toISOString(),releaseAuthorized:false};}})},services.releaseAuthority,services.authorityPolicy);
    if(collect){
      const prior=instance,admitted=svc.recovery.admission(prior,authority,'release-decision',actor);assert.equal(admitted.allowed,true);
      const adapter=f.releaseFactory(store,{releaseAuthority:svc.resolveRelease,authorityPolicy:f.policy}),plan=await adapter.prepare(instance,'release-decision',actor,new AbortController().signal);instance=requestStage(instance,'release-decision','synthetic-release',{authority,bindingsCurrent:true});
      const body={schema:'runtime-stage-request/v1',id:'synthetic-release',workspaceId:'synthetic',projectId:'alpha',instanceId:'one',stageId:'release-decision',pinsDigest:instance.pinsDigest,inputDigest:instance.stages['release-decision'].inputDigest,bindingStamp:valueDigest('synthetic'),authorityRef:g.ref,releaseAuthorityRef:null,initiatedBy:{id:actor.id,revision:actor.revision},plan,planDigest:valueDigest(plan),requestedAt:new Date().toISOString(),deadlineAt:admitted.deadlineAt},r={...body,digest:valueDigest(body)};
      store.mutate(actor,{projectId:'alpha',operation:'synthetic-release-request-fixture',requestId:'synthetic-release-request',expectedRevision:store.revision('alpha'),input:{fixtureOnly:true},permission:'execution.request'},()=>({objects:[{kind:'lifecycle-instance',id:'one',value:instance},{kind:'stage-request',id:r.id,value:r},{kind:'stage-progress',id:r.id,value:{requestId:r.id,phase:'DISPATCHING',terminal:false,handle:null,observation:null,observationRef:null,reason:null,observedAt:r.requestedAt}},...svc.recovery.claim(prior,authority,r,actor)],value:{fixtureOnly:true},event:{type:'synthetic-fixture',data:{fixtureOnly:true}}}));
      const observed=await adapter.dispatch(r,instance,async()=>actor,new AbortController().signal);assert.equal(observed.phase,'RUNNING');
      instance=recordStageOutcome(instance,'release-decision',observed.outcome);
      const envelope={schema:'runtime-stage-observation/v1',requestId:r.id,observation:observed,reason:null,observedAt:new Date().toISOString()};
      store.mutate(actor,{projectId:'alpha',operation:'synthetic-release-progress-fixture',requestId:'synthetic-release-progress',expectedRevision:store.revision('alpha'),input:{fixtureOnly:true},permission:'read'},()=>({objects:[{kind:'lifecycle-instance',id:'one',value:instance},{kind:'stage-observation',id:valueDigest(envelope),value:envelope},{kind:'stage-progress',id:r.id,value:{requestId:r.id,phase:observed.phase,terminal:false,handle:observed.handle,observation:observed,observationRef:valueDigest(envelope),reason:null,observedAt:envelope.observedAt}}],value:{fixtureOnly:true},event:{type:'synthetic-fixture',data:{fixtureOnly:true}}}));
    }
    f.revision=store.revision('alpha');return instance;
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

async function releaseFixture(){
  const f=fixture();await f.open();try{await activate(f);const g=await grant(f);await create(f,g);const instance=await syntheticVerification(f,g,false);await f.server.close();f.executor=f.releaseFactory;await f.open();return{f,g,instance,subject:{instanceId:'one',candidateDigest:instance.candidateDigest,expiresAt:g.input.subject.expiresAt}};}catch(e){await f.server.close();f.cleanup();throw e;}
}
async function releaseRequest(f){const r=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'release-decision'});assert.equal(r.status,200,JSON.stringify(r));return r.result.result.stageRequestId;}
const releaseMaterial=(f,id)=>request(f,'lifecycle.release.evidence.read',{stageRequestId:id},'reader');

test('full large release documents survive HTTP, MCP, restart and exact review without enlarging mutation requests',async()=>{
  const{f,subject}=await releaseFixture(),client=new Client({name:'synthetic-large-release-review',version:'1.0.0'});
  try{
    const text=('# Synthetic complete document\n'+'x'.repeat(1048576)).slice(0,1048576);f.releaseControls.documentText=text;
    const id=await releaseRequest(f),material=(await until(()=>releaseMaterial(f,id),v=>v.status===200)).result.material;
    await until(()=>request(f,'lifecycle.stage.request.inspect',{stageRequestId:id}),v=>v.result.progress.phase==='RUNNING');
    assert(Buffer.byteLength(JSON.stringify(material))>4194304);
    for(const d of material.documents.documents){assert.equal(d.text,text);assert.equal(d.bytes,1048576);assert.equal(d.digest,byteDigest(text));}
    const response=await request(f,'lifecycle.authority.preview',{kind:'release',subject},'decider');assert.equal(response.status,200);
    const preview=response.result,{reviewDigest,authorityGranted,executionDispatched,...review}=preview;
    assert.equal(reviewDigest,evidenceValueDigest(review));assert.deepEqual(preview.releaseMaterial,material);assert.equal(authorityGranted,false);
    const changed=structuredClone(review);changed.releaseMaterial.documents.documents[2].text+='!';assert.notEqual(evidenceValueDigest(changed),reviewDigest);
    await client.connect(new StreamableHTTPClientTransport(new URL(f.server.url+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+f.tokens.decider}}}));
    const mcp=await client.callTool({name:'runtime_read',arguments:{operation:'lifecycle.authority.preview',projectId:'alpha',input:{kind:'release',subject}}});assert.notEqual(mcp.isError,true);assert.deepEqual(JSON.parse(mcp.content[0].text).result,preview);
    await client.close();await f.server.close();await f.open();
    assert.deepEqual((await releaseMaterial(f,id)).result.material,material);
    assert.deepEqual((await request(f,'lifecycle.authority.preview',{kind:'release',subject},'decider')).result,preview);assert.equal(f.releaseControls.documentReads,1);
    const proof=evidence(f,preview),input={kind:'release',subject,reviewDigest,decision:'APPROVE',evidenceRef:proof.ref};
    const oversized=await write(f,'lifecycle.authority.record',{...input,extra:text});assert.equal(oversized.status,413);
    const stale=await execWrite(f,'lifecycle.authority.record',{...input,reviewDigest:evidenceValueDigest(changed)},'decider');assert.equal(stale.error.code,'AUTHORITY_REVIEW_STALE');
    const recorded=await execWrite(f,'lifecycle.authority.record',input,'decider');assert.equal(recorded.status,200,JSON.stringify(recorded));
    assert.equal(recorded.result.result.reviewDigest,reviewDigest);
    await execWrite(f,'lifecycle.stage.reconcile',{stageRequestId:id},'reader');
    await until(()=>request(f,'lifecycle.stage.request.inspect',{stageRequestId:id}),v=>v.result.progress.phase==='COMPLETE');
    assert.equal(f.releaseControls.documentReads,1);assert.equal((await inspect(f,recorded.result.result.authorityRef)).result.usable,true);
  }finally{await client.close();await f.server.close();f.cleanup();}
});

test('same release stage collects reviewable documents, survives restart and completes only after the separate exact decision',async()=>{
  const{f,subject}=await releaseFixture();const client=new Client({name:'synthetic-release-read',version:'1.0.0'});try{
    assert.equal((await request(f,'lifecycle.authority.preview',{kind:'release',subject},'decider')).error.code,'RELEASE_EVIDENCE_REQUIRED');
    const id=await releaseRequest(f),material=(await until(()=>releaseMaterial(f,id),v=>v.status===200)).result.material;
    await until(()=>request(f,'lifecycle.stage.request.inspect',{stageRequestId:id}),v=>v.result.progress.phase==='RUNNING');
    assert.equal(material.releaseAuthorized,false);assert.equal(material.documents.documents.length,4);assert.equal(material.candidateDigest,subject.candidateDigest);
    const before=(await request(f,'lifecycle.stage.request.inspect',{stageRequestId:id})).result.request;
    const preview=(await request(f,'lifecycle.authority.preview',{kind:'release',subject},'decider')).result;
    assert.deepEqual(preview.releaseMaterial,material);assert.equal(preview.subject.releaseMaterialDigest,material.digest);assert(preview.releaseMaterial.documents.documents.every(d=>d.text.includes('Synthetic')));
    await client.connect(new StreamableHTTPClientTransport(new URL(f.server.url+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+f.tokens.reader}}}));
    const result=await client.callTool({name:'runtime_read',arguments:{operation:'lifecycle.release.evidence.read',projectId:'alpha',input:{stageRequestId:id}}});assert.notEqual(result.isError,true);assert.equal(JSON.parse(result.content[0].text).result.material.digest,material.digest);await client.close();
    assert.equal((await request(f,'lifecycle.release.evidence.read',{stageRequestId:'synthetic-verification'},'reader')).error.code,'STAGE_SCOPE');
    await f.server.close();await f.open();assert.deepEqual((await releaseMaterial(f,id)).result.material,material);assert.equal(f.releaseControls.documentReads,1);
    const release=await grant(f,'release',subject);await execWrite(f,'lifecycle.stage.reconcile',{stageRequestId:id},'reader');
    const complete=await until(()=>request(f,'lifecycle.stage.request.inspect',{stageRequestId:id}),v=>v.result.progress.phase==='COMPLETE');assert.deepEqual(complete.result.request,before);
    assert(complete.result.progress.observation.outcome.checks.every(c=>c.status==='PASS'));assert.equal(f.releaseControls.documentReads,1);assert(f.releaseControls.verificationReads>=2);
    const instance=(await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance;assert.equal(instance.stages['release-decision'].attempts,1);assert.equal(instance.stages.publication.status,'PENDING');assert.equal((await inspect(f,release.ref)).result.usable,true);
    assert.equal((await request(f,'lifecycle.stage.admission',{instanceId:'one',stageId:'publication'},'publisher')).result.allowed,true);
  }finally{await client.close();await f.server.close();f.cleanup();}
});

test('interrupted release collection requires explicit same-request continuation and never invents a material or decision',async()=>{
  const{f,subject}=await releaseFixture();try{
    f.releaseControls.failDocuments=true;const id=await releaseRequest(f);await until(()=>request(f,'lifecycle.stage.request.inspect',{stageRequestId:id}),v=>v.result.progress.phase==='UNKNOWN');
    assert.equal((await releaseMaterial(f,id)).error.code,'RELEASE_MATERIAL_REQUIRED');assert.equal((await request(f,'lifecycle.authority.preview',{kind:'release',subject},'decider')).error.code,'RELEASE_MATERIAL_REQUIRED');
    const before=(await request(f,'lifecycle.stage.request.inspect',{stageRequestId:id})).result.request;f.releaseControls.failDocuments=false;
    await execWrite(f,'lifecycle.stage.reconcile',{stageRequestId:id},'reader');await until(()=>request(f,'lifecycle.stage.request.inspect',{stageRequestId:id}),v=>v.result.progress.phase==='RUNNING');assert.equal(f.releaseControls.documentReads,1,'inspection cannot collect or dispatch');
    await until(()=>request(f,'runtime.status'),v=>v.result.observationWorker.inFlight===0);const advanced=await execWrite(f,'lifecycle.stage.advance',{stageRequestId:id});assert.equal(advanced.status,200,JSON.stringify(advanced));
    const m=await until(()=>releaseMaterial(f,id),v=>v.status===200);assert.equal(m.result.releaseAuthorized,false);assert.equal(f.releaseControls.documentReads,2);assert.deepEqual((await request(f,'lifecycle.stage.request.inspect',{stageRequestId:id})).result.request,before);
    assert.equal((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance.stages['release-decision'].attempts,1);
  }finally{await f.server.close();f.cleanup();}
});

test('collected documents cannot bypass changed configuration, original verification failure or revoked release authority',async()=>{
  for(const variant of ['configuration','verification','revocation']){
    const{f,subject}=await releaseFixture();try{
      const id=await releaseRequest(f);await until(()=>releaseMaterial(f,id),v=>v.status===200);await until(()=>request(f,'runtime.status'),v=>v.result.observationWorker.inFlight===0);
      if(variant==='configuration'){
        f.config.resources.find(r=>r.role==='config.release-decision.evidencePolicyRef').definition.documentation[0].path='OTHER.md';f.saveConfig();
        assert.equal((await request(f,'lifecycle.authority.preview',{kind:'release',subject},'decider')).error.code,'RELEASE_BINDINGS_CHANGED');
      }else{
        if(variant==='verification')f.releaseControls.failVerification=true;
        const release=await grant(f,'release',subject);
        if(variant==='revocation')await execWrite(f,'lifecycle.authority.revoke',{authorityRef:release.ref,reason:'Synthetic authority withdrawal'},'decider');
      }
      await execWrite(f,'lifecycle.stage.reconcile',{stageRequestId:id},'reader');const observed=await until(()=>request(f,'lifecycle.stage.request.inspect',{stageRequestId:id}),v=>v.result.progress.phase==='UNKNOWN');
      assert.equal(observed.result.progress.reason,variant==='configuration'?'RELEASE_BINDINGS_CHANGED':variant==='verification'?'RELEASE_VERIFICATION_CHANGED':'AUTHORITY_REVOKED');
      assert.notEqual((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance.stages['release-decision'].status,'PASSED');
      assert.equal((await releaseMaterial(f,id)).status,200,'retained original review material remains readable');assert.equal(f.releaseControls.documentReads,1);
    }finally{await f.server.close();f.cleanup();}
  }
});

function stageAdapter(f){
  const state={dispatches:0,inspections:0,mode:'complete',inspectMode:'unknown',prepare:null,dispatch:null};
  const adapterDigest=valueDigest('synthetic-stage-adapter-v1');
  function observe(r,i,mode){
    const phase=mode==='complete'?'COMPLETE':mode==='fail'?'FAILED':mode==='running'?'CI_RUNNING':mode==='waiting'?'WAITING_AGENT':'UNKNOWN';
    return{requestId:r.id,inputDigest:r.inputDigest,adapterDigest,phase,handle:mode==='unknown'?null:{syntheticRequest:r.id},outcome:{requestId:r.id,inputDigest:r.inputDigest,receiptRef:'synthetic:receipt/'+r.id,status:phase==='COMPLETE'?'COMPLETE':phase==='FAILED'?'FAILED':phase==='UNKNOWN'?'UNKNOWN':'RUNNING',expiresAt:new Date(Date.now()+60000).toISOString(),checks:phase==='COMPLETE'?i.definition.nodes.find(n=>n.id===r.stageId).checks.map(id=>({id,status:'PASS',evidenceRef:'synthetic:check/'+id})):[]}};
  }
  const adapter={
    async prepare(i,stageId,actor,signal){if(state.prepare)await state.prepare(signal);return{adapterId:'synthetic-stage-adapter',adapterDigest,action:'base.'+stageId,bindingDigest:valueDigest('synthetic-binding'),parameters:{synthetic:true}};},
    async dispatch(r,i,permit,signal){await permit();state.dispatches++;if(state.dispatch)return state.dispatch(r,i,signal);if(state.mode==='hang')return new Promise(()=>{});return observe(r,i,state.mode);},
    async inspect(r,i,p){state.inspections++;const o=observe(r,i,state.inspectMode);if(p.handle!==null)o.handle=p.handle;return o;},
  };
  f.executor=adapter;return{state,adapter,observe};
}
// Trusted adapter fixture only: these facts stand in for independently read
// owner evidence. Production adapters remain unavailable until that read exists.
function trustedRepairFixture(adapter){
  const state={calls:0,changed:true,failureClass:'DETERMINISTIC',noProgress:false,semanticRevision:'v1',verify:null};
  adapter.verifyRepair=async(subject,actor,signal)=>{
    state.calls++;if(state.verify)await state.verify(subject,actor,signal,state.calls);
    const attempt=subject.history.length,inputs=n=>({sourceDigest:valueDigest('synthetic-source-'+n),candidateDigest:subject.candidateDigest,toolchainDigest:valueDigest('synthetic-toolchain'),dependencyClosureDigest:valueDigest('synthetic-input-closure-'+n)});
    const before=inputs(attempt-1),after=state.changed?inputs(attempt):structuredClone(before);
    if(state.semanticRevision!=='v1')after.dependencyClosureDigest=valueDigest(state.semanticRevision);
    const count=state.noProgress?Math.max(2,attempt):attempt;
    const rounds=Array.from({length:count},(_,n)=>({evidenceRef:'synthetic:actual-repair-round-'+n,beforeFactsDigest:valueDigest('before-'+n),afterFactsDigest:valueDigest(state.noProgress?'before-'+n:'after-'+n)}));
    return{schema:'runtime-stage-repair-facts/v1',subjectDigest:valueDigest(subject),failureClass:state.failureClass,before,after,rounds,evidenceRef:'synthetic:native-repair/'+attempt,expiresAt:new Date(Date.now()+60000).toISOString()};
  };
  return state;
}
async function execWrite(f,op,input,actor='executor',meta={}){await request(f,'runtime.status');return write(f,op,input,actor,meta);}
async function stageState(f,id){return request(f,'lifecycle.stage.request.inspect',{stageRequestId:id},'reader');}
async function until(probe,predicate,timeout=5000){const end=Date.now()+timeout;let value;do{value=await probe();if(predicate(value))return value;await new Promise(r=>setTimeout(r,10));}while(Date.now()<end);assert.fail('Timed out waiting for exact retained stage state: '+JSON.stringify(value));}
async function seedLegacyNativeInstance(f,g){
 await f.server.close();const store=new RuntimeStore(f.root,'synthetic');
 try{const actor=currentPrincipal(f.root,'synthetic','executor'),native=createAuthorityService(store,f.policy,id=>currentPrincipal(f.root,'synthetic',id)),definition=store.object('alpha','definition-revision',f.definitionRevisionId).compilation.effective,authority=await native.resolveExecution(g.ref,definition,actor,new AbortController().signal),legacy=pinInstance('one',f.definitionRevisionId,definition,authority);store.mutate(actor,{projectId:'alpha',operation:'synthetic.pre-correction-instance',requestId:'legacy-seed',expectedRevision:store.revision('alpha'),input:{synthetic:true},permission:'execution.request'},()=>({objects:[{kind:'lifecycle-instance',id:'one',value:legacy},{kind:'instance-authority',id:'one',value:{evidenceRef:g.ref}}],value:{synthetic:true},event:{type:'synthetic-legacy-instance',data:{synthetic:true}}}));}finally{store.close();await f.open();}
}
async function executingFixture(legacy=false){const f=fixture(),adapter=stageAdapter(f);await f.open();await activate(f);const g=await grant(f);if(legacy)await seedLegacyNativeInstance(f,g);else assert.equal((await create(f,g)).status,200);return{f,g,...adapter};}

test('fresh read-only preparation can exceed five seconds without renewing original execution pins',async()=>{
  const {f,state}=await executingFixture();try{
    const before=(await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance;
    state.prepare=async signal=>{await new Promise(resolve=>setTimeout(resolve,6100));signal.throwIfAborted();assert.equal(state.dispatches,0);};
    const sent=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'});assert.equal(sent.status,200,JSON.stringify(sent));
    const original=(await until(()=>stageState(f,sent.result.result.stageRequestId),v=>v.result.progress.terminal)).result;
    assert.equal(original.progress.phase,'COMPLETE');assert.equal(state.dispatches,1);
    const after=(await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance;
    assert.deepEqual(after.pins,before.pins);assert.equal(after.createdAt,before.createdAt);assert.equal(after.stages.scope.attempts,1);
    assert(Date.parse(original.request.deadlineAt)<=Math.min(Date.parse(before.createdAt)+before.pins.budget.timeoutSeconds*1000,Date.parse(before.pins.authorityExpiresAt)));
    assert.equal(original.request.pinsDigest,before.pinsDigest);
  }finally{await f.server.close();f.cleanup();}
});

for(const cutoff of ['instance','authority'])test('the original '+cutoff+' deadline aborts read-only preparation before any receipt, attempt or dispatch',async()=>{
  const f=fixture(),{state}=stageAdapter(f);let release,aborted=false,entered=false;await f.open();
  try{
    if(cutoff==='instance')for(const configuration of Object.values(f.data.config))if(configuration.budget)configuration.budget.timeoutSeconds=2;
    await activate(f);const subject=executionSubject(f);if(cutoff==='instance')subject.budget.timeoutSeconds=2;else subject.expiresAt=new Date(Date.now()+2000).toISOString();
    const g=await grant(f,'execution',subject);assert.equal((await create(f,g)).status,200);
    const before=(await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance,revision=(await request(f,'runtime.status')).result.revision;
    const late=new Promise(resolve=>release=resolve);state.prepare=async signal=>{entered=true;signal.addEventListener('abort',()=>{aborted=true;},{once:true});await late;};
    const originalId='short-'+cutoff+'-original',result=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'},'executor',{requestId:originalId});
    assert.equal(result.status,409,JSON.stringify(result));assert.equal(result.error.code,'OBSERVATION_INTERRUPTED');assert.equal(entered,true);assert.equal(aborted,true);
    release();await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(state.dispatches,0);assert.equal(state.inspections,0);assert.equal((await request(f,'runtime.receipt.read',{requestId:originalId},'executor')).status,404);
    assert.deepEqual((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance,before);assert.equal((await request(f,'runtime.status')).result.revision,revision);
  }finally{release?.();await f.server.close();f.cleanup();}
});

for(const cutoff of ['instance','authority'])test('an already expired '+cutoff+' preserves native admission rejection without preparing or retaining a request',async()=>{
  const f=fixture(),{state}=stageAdapter(f);let preparations=0;await f.open();
  try{
    if(cutoff==='instance')for(const configuration of Object.values(f.data.config))if(configuration.budget)configuration.budget.timeoutSeconds=2;
    await activate(f);const subject=executionSubject(f);if(cutoff==='authority')subject.expiresAt=new Date(Date.now()+2000).toISOString();
    const g=await grant(f,'execution',subject);assert.equal((await create(f,g)).status,200);
    const before=(await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance,revision=(await request(f,'runtime.status')).result.revision;
    state.prepare=async()=>{preparations++;};const deadline=cutoff==='instance'?Date.parse(before.createdAt)+before.pins.budget.timeoutSeconds*1000:Date.parse(before.pins.authorityExpiresAt);
    await new Promise(resolve=>setTimeout(resolve,Math.max(1,deadline-Date.now()+25)));
    const originalId='expired-'+cutoff+'-original',result=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'},'executor',{requestId:originalId});
    assert.equal(result.status,cutoff==='authority'?400:409,JSON.stringify(result));assert.equal(result.error.code,cutoff==='authority'?'AUTHORITY_EXPIRED':'STAGE_BLOCKED');if(cutoff==='instance')assert.equal(result.error.message,'INSTANCE_TIME_BUDGET_EXHAUSTED');
    assert.equal(preparations,0);assert.equal(state.dispatches,0);assert.equal(state.inspections,0);assert.equal((await request(f,'runtime.receipt.read',{requestId:originalId},'executor')).status,404);
    assert.deepEqual((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance,before);assert.equal((await request(f,'runtime.status')).result.revision,revision);
  }finally{await f.server.close();f.cleanup();}
});

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

test('an exact continuation reserves its worker during async permission checks without observer starvation or duplicate advance',async()=>{
  const f=fixture(),{state,adapter,observe}=stageAdapter(f),originalBindings=f.bindings.provider;
  let pause=false,entered,releasePermit,advances=0;
  const inPermit=new Promise(r=>entered=r),permitGate=new Promise(r=>releasePermit=r);
  f.bindings.provider=async(...args)=>{if(pause){entered();await permitGate;}return originalBindings(...args);};
  adapter.advance=async(r,i,p,permit)=>{await permit();advances++;const o=observe(r,i,'complete');o.handle=p.handle;return o;};
  state.mode='running';state.inspectMode='running';await f.open();
  try{
    await activate(f);const g=await grant(f);await create(f,g);
    const started=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=started.result.result.stageRequestId;
    await until(()=>stageState(f,id),v=>v.result.progress.phase==='CI_RUNNING');
    await until(()=>request(f,'runtime.status'),v=>v.result.observationWorker.inFlight===0);
    const inspections=state.inspections,original=(await stageState(f,id)).result.request;pause=true;
    const advancing=execWrite(f,'lifecycle.stage.advance',{stageRequestId:id},'executor',{requestId:'reserved-original-advance'});
    await Promise.race([inPermit,new Promise((_,fail)=>setTimeout(()=>fail(Error('permit did not begin')),5000))]);
    assert.equal((await request(f,'runtime.status')).result.observationWorker.inFlight,1);
    const busy=await execWrite(f,'lifecycle.stage.advance',{stageRequestId:id});assert.equal(busy.status,429);assert.equal(busy.error.code,'EXECUTOR_BUSY');
    await new Promise(resolve=>setTimeout(resolve,3100));assert.equal(state.inspections,inspections,'Background observer cannot acquire the reserved original request');assert.equal(advances,0);
    pause=false;releasePermit();const continued=await advancing;assert.equal(continued.status,200,JSON.stringify(continued));assert.equal(continued.result.result.deadlineAt,original.deadlineAt);
    await until(()=>stageState(f,id),v=>v.result.progress.phase==='COMPLETE');assert.equal(advances,1);assert.equal(state.dispatches,1);
    const instance=(await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance;assert.equal(instance.stages.scope.attempts,1);assert.equal(instance.requestIds.length,1);
  }finally{pause=false;releasePermit();await f.server.close();f.cleanup();}
});

for(const fault of ['binding','revocation','cas','timeout'])test('continuation reservation releases after '+fault+' without a receipt or late adapter action',async()=>{
  const f=fixture(),{state,adapter,observe}=stageAdapter(f),bindings=f.bindings.provider;let pause=false,entered,release,advances=0;
  const inPermit=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  f.bindings.provider=async(...args)=>{if(pause){entered();await gate;}return bindings(...args);};
  adapter.advance=async(r,i,p,permit)=>{await permit();advances++;const o=observe(r,i,'complete');o.handle=p.handle;return o;};
  state.mode='running';state.inspectMode='running';await f.open();
  try{
    await activate(f);const grantRef=await grant(f);await create(f,grantRef);
    const start=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=start.result.result.stageRequestId;
    await until(()=>stageState(f,id),v=>v.result.progress.phase==='CI_RUNNING');await until(()=>request(f,'runtime.status'),v=>v.result.observationWorker.inFlight===0);
    const original=(await stageState(f,id)).result.request,requestId='reserved-failure-'+fault;pause=true;
    const pending=execWrite(f,'lifecycle.stage.advance',{stageRequestId:id},'executor',{requestId});await inPermit;
    if(fault==='binding')f.bindings.state.mode='unknown';
    if(fault==='revocation')assert.equal((await execWrite(f,'lifecycle.authority.revoke',{authorityRef:grantRef.ref,reason:'Synthetic in-flight withdrawal'},'decider')).status,200);
    if(fault==='cas')assert.equal((await execWrite(f,'lifecycle.draft.save',{yaml:yaml(f.data)+'\n# concurrent draft\n'},'owner')).status,200);
    if(fault!=='timeout'){pause=false;release();}
    const result=await pending;assert.equal(result.status,fault==='revocation'?403:409,JSON.stringify(result));
    assert.equal(result.error.code,{binding:'EXECUTION_BINDING_CHANGED',revocation:'AUTHORITY_REVOKED',cas:'REVISION_CONFLICT',timeout:'EXECUTION_BINDING_CHANGED'}[fault]);
    pause=false;release();f.bindings.state.mode='valid';await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(advances,0);assert.equal(state.dispatches,1);assert.equal((await request(f,'runtime.receipt.read',{requestId},'executor')).status,404);assert.deepEqual((await stageState(f,id)).result.request,original);
    await until(()=>request(f,'runtime.status'),v=>v.result.observationWorker.inFlight===0);
    if(fault!=='revocation'){const recovered=await execWrite(f,'lifecycle.stage.advance',{stageRequestId:id},'executor',{requestId});assert.equal(recovered.status,200,JSON.stringify(recovered));await until(()=>stageState(f,id),v=>v.result.progress.phase==='COMPLETE');assert.equal(advances,1);}
  }finally{pause=false;release();await f.server.close();f.cleanup();}
});

test('closing the service aborts an uncommitted continuation reservation and ignores its late permission result',async()=>{
  const f=fixture(),{state,adapter,observe}=stageAdapter(f),bindings=f.bindings.provider;let pause=false,entered,release,advances=0;
  const inPermit=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  f.bindings.provider=async(...args)=>{if(pause){entered();await gate;}return bindings(...args);};
  adapter.advance=async(r,i,p,permit)=>{await permit();advances++;const o=observe(r,i,'complete');o.handle=p.handle;return o;};state.mode='running';state.inspectMode='running';await f.open();
  try{
    await activate(f);await create(f,await grant(f));const started=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=started.result.result.stageRequestId;
    await until(()=>stageState(f,id),v=>v.result.progress.phase==='CI_RUNNING');await until(()=>request(f,'runtime.status'),v=>v.result.observationWorker.inFlight===0);const original=(await stageState(f,id)).result.request;
    pause=true;const pending=execWrite(f,'lifecycle.stage.advance',{stageRequestId:id},'executor',{requestId:'closed-reservation'}).catch(()=>null);await inPermit;
    await f.server.close();await pending;pause=false;release();await new Promise(resolve=>setTimeout(resolve,25));await f.open();
    assert.equal((await request(f,'runtime.receipt.read',{requestId:'closed-reservation'},'executor')).status,404);assert.deepEqual((await stageState(f,id)).result.request,original);assert.equal(advances,0);assert.equal(state.dispatches,1);
  }finally{pause=false;release();await f.server.close();f.cleanup();}
});

test('the original stage deadline releases a reservation before a late binding result can commit',async()=>{
  const f=fixture(),{state,adapter,observe}=stageAdapter(f),bindings=f.bindings.provider;let pause=false,entered,release,advances=0;
  const inPermit=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  f.bindings.provider=async(...args)=>{if(pause){entered();await gate;}return bindings(...args);};
  adapter.advance=async(r,i,p,permit)=>{await permit();advances++;const o=observe(r,i,'complete');o.handle=p.handle;return o;};state.mode='running';state.inspectMode='running';
  for(const configuration of Object.values(f.data.config))if(configuration.budget)configuration.budget.timeoutSeconds=2;
  await f.open();
  try{
    await activate(f);await create(f,await grant(f));const start=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=start.result.result.stageRequestId;
    await until(()=>stageState(f,id),v=>v.result.progress.phase==='CI_RUNNING');await until(()=>request(f,'runtime.status'),v=>v.result.observationWorker.inFlight===0);const original=(await stageState(f,id)).result.request;
    pause=true;const pending=execWrite(f,'lifecycle.stage.advance',{stageRequestId:id},'executor',{requestId:'deadline-reservation'});await inPermit;
    const result=await pending;assert.equal(result.status,409);assert.equal(result.error.code,'OBSERVATION_INTERRUPTED');assert(Date.now()>=Date.parse(original.deadlineAt));
    pause=false;release();await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal((await request(f,'runtime.receipt.read',{requestId:'deadline-reservation'},'executor')).status,404);assert.deepEqual((await stageState(f,id)).result.request,original);assert.equal(advances,0);assert.equal(state.dispatches,1);
  }finally{pause=false;release();await f.server.close();f.cleanup();}
});

test('continuation rechecks its original deadline inside the commit callback before writing a receipt',async()=>{
  const {f,state,adapter,observe}=await executingFixture(),originalMutate=RuntimeStore.prototype.mutate;let advances=0,commitChecks=0;
  state.mode='running';state.inspectMode='running';adapter.advance=async(r,i,p,permit)=>{await permit();advances++;const o=observe(r,i,'complete');o.handle=p.handle;return o;};
  try{
    const started=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=started.result.result.stageRequestId;
    await until(()=>stageState(f,id),v=>v.result.progress.phase==='CI_RUNNING');await until(()=>request(f,'runtime.status'),v=>v.result.observationWorker.inFlight===0);
    const original=(await stageState(f,id)).result.request,deadline=Date.parse(original.deadlineAt),requestId='commit-deadline-reservation';
    RuntimeStore.prototype.mutate=function(principal,mutation,operation,reauthorize){
      if(mutation.requestId!==requestId)return originalMutate.call(this,principal,mutation,operation,reauthorize);
      return originalMutate.call(this,principal,mutation,()=>{const now=Date.now;Date.now=()=>deadline;commitChecks++;try{return operation();}finally{Date.now=now;}},reauthorize);
    };
    const denied=await execWrite(f,'lifecycle.stage.advance',{stageRequestId:id},'executor',{requestId});
    assert.equal(denied.status,409,JSON.stringify(denied));assert.equal(denied.error.code,'EXECUTION_DEADLINE');assert.equal(commitChecks,1);
    assert.equal((await request(f,'runtime.receipt.read',{requestId},'executor')).status,404);assert.deepEqual((await stageState(f,id)).result.request,original);assert.equal(advances,0);assert.equal(state.dispatches,1);
    assert.equal((await request(f,'runtime.status')).result.observationWorker.inFlight,0);
  }finally{RuntimeStore.prototype.mutate=originalMutate;await f.server.close();f.cleanup();}
});

test('continuation cannot cancel or replace an already active original observer',async()=>{
  const {f,state,adapter,observe}=await executingFixture();let entered,release,observingSignal,advances=0;
  const inspecting=new Promise(r=>entered=r),gate=new Promise(r=>release=r),originalInspect=adapter.inspect;
  state.mode='running';state.inspectMode='running';adapter.advance=async(r,i,p,permit)=>{await permit();advances++;const o=observe(r,i,'complete');o.handle=p.handle;return o;};
  try{
    const started=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=started.result.result.stageRequestId;
    await until(()=>stageState(f,id),v=>v.result.progress.phase==='CI_RUNNING');
    adapter.inspect=async(...args)=>{observingSignal=args[4];entered();await gate;return originalInspect(...args);};
    await Promise.race([inspecting,new Promise((_,fail)=>setTimeout(()=>fail(Error('original observer did not begin')),5000))]);
    const original=(await stageState(f,id)).result.request,denied=await execWrite(f,'lifecycle.stage.advance',{stageRequestId:id},'executor',{requestId:'active-observer-denial'});
    assert.equal(denied.status,429);assert.equal(denied.error.code,'EXECUTOR_BUSY');assert.equal(observingSignal.aborted,false);assert.equal(advances,0);assert.equal((await request(f,'runtime.receipt.read',{requestId:'active-observer-denial'},'executor')).status,404);
    release();await until(()=>request(f,'runtime.status'),v=>v.result.observationWorker.inFlight===0);assert.deepEqual((await stageState(f,id)).result.request,original);
    assert.equal((await execWrite(f,'lifecycle.stage.advance',{stageRequestId:id})).status,200);await until(()=>stageState(f,id),v=>v.result.progress.phase==='COMPLETE');assert.equal(advances,1);assert.equal(state.dispatches,1);
  }finally{release();await f.server.close();f.cleanup();}
});

test('four pending continuation reservations preserve capacity and reject an earlier fifth admission before commit',async()=>{
  const f=fixture(),{state,adapter,observe}=stageAdapter(f),bindings=f.bindings.provider;let pause=false,entered=0,release,prepared,releasePrepare,advances=0;
  const permits=new Promise(r=>release=r),inPrepare=new Promise(r=>prepared=r),prepareGate=new Promise(r=>releasePrepare=r);
  f.bindings.provider=async(...args)=>{if(pause){entered++;await permits;}return bindings(...args);};
  const originalPrepare=adapter.prepare;adapter.prepare=async(i,...args)=>{if(i.id==='five'){prepared();await prepareGate;}return originalPrepare(i,...args);};
  adapter.advance=async(r,i,p,permit)=>{await permit();advances++;const o=observe(r,i,'complete');o.handle=p.handle;return o;};state.mode='running';state.inspectMode='running';await f.open();
  const waiting=[];
  try{
    await activate(f);for(const name of ['one','two','three','four','five'])assert.equal((await create(f,await grant(f,'execution',executionSubject(f,name)),name)).status,200);
    const ids=[];for(const name of ['one','two','three','four']){const start=await execWrite(f,'lifecycle.stage.request',{instanceId:name,stageId:'scope'});assert.equal(start.status,200,JSON.stringify(start));ids.push(start.result.result.stageRequestId);await until(()=>stageState(f,ids.at(-1)),v=>v.result.progress.phase==='CI_RUNNING');}
    await until(()=>request(f,'runtime.status'),v=>v.result.observationWorker.inFlight===0);
    const fifth=execWrite(f,'lifecycle.stage.request',{instanceId:'five',stageId:'scope'},'executor',{requestId:'fifth-capacity-admission'});waiting.push(fifth);await inPrepare;pause=true;
    for(const id of ids)waiting.push(execWrite(f,'lifecycle.stage.advance',{stageRequestId:id}));
    await until(async()=>entered,v=>v===4);assert.equal((await request(f,'runtime.status')).result.observationWorker.inFlight,4);
    releasePrepare();const denied=await fifth;assert.equal(denied.status,429,JSON.stringify(denied));assert.equal(denied.error.code,'EXECUTOR_BUSY');assert.equal((await request(f,'runtime.receipt.read',{requestId:'fifth-capacity-admission'},'executor')).status,404);
    const unchanged=(await request(f,'lifecycle.instance.inspect',{instanceId:'five'})).result.instance;assert.equal(unchanged.stages.scope.attempts,0);assert.equal(unchanged.requestIds.length,0);
    pause=false;release();const results=await Promise.all(waiting.slice(1));assert.equal(results.filter(v=>v.status===200).length,1);for(const r of results.filter(v=>v.status!==200))assert.equal(r.error.code,'REVISION_CONFLICT');
    await until(()=>request(f,'runtime.status'),v=>v.result.observationWorker.inFlight===0);assert.equal(advances,1);assert.equal(state.dispatches,4);
  }finally{pause=false;release();releasePrepare();await Promise.allSettled(waiting);await f.server.close();f.cleanup();}
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
  const {f,state,adapter}=await executingFixture();trustedRepairFixture(adapter);try{
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

test('direct failed stage.request cannot bypass missing trusted repair proof or substitute a plan timestamp',async()=>{
 const {f,state,adapter}=await executingFixture();try{
  state.mode='fail';const first=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=first.result.result.stageRequestId;
  await until(()=>stageState(f,id),v=>v.result.progress.terminal);const before=(await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance;
  const prepare=adapter.prepare;adapter.prepare=async(...args)=>({...await prepare(...args),parameters:{synthetic:true,refreshedAt:new Date().toISOString()}});
  let denied=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'},'executor',{requestId:'missing-repair-proof'});
  assert.equal(denied.error.code,'REPAIR_VERIFIER_UNAVAILABLE');assert.equal((await request(f,'runtime.receipt.read',{requestId:'missing-repair-proof'},'executor')).status,404);
  assert.deepEqual((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance,before);assert.equal(state.dispatches,1);
  const repair=trustedRepairFixture(adapter);repair.changed=false;
  denied=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'});assert.equal(denied.error.code,'UNCHANGED_DETERMINISTIC_FAILURE');assert.equal(state.dispatches,1);
  repair.changed=true;repair.noProgress=true;denied=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'});assert.equal(denied.error.code,'TWO_NO_PROGRESS_ROUNDS');
  repair.noProgress=false;adapter.verifyRepair=async()=>null;denied=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'});assert.equal(denied.error.code,'REPAIR_EVIDENCE_REQUIRED');assert.equal(state.dispatches,1);
 }finally{await f.server.close();f.cleanup();}
});

test('verified semantic repair uses retained grant, attempt history and original cutoff across restart',async()=>{
 const {f,state,adapter}=await executingFixture();const repair=trustedRepairFixture(adapter);try{
  state.mode='fail';const first=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=first.result.result.stageRequestId;
  const original=(await until(()=>stageState(f,id),v=>v.result.progress.terminal)).result.request;
  await f.server.close();await f.open();state.mode='complete';
  const retried=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'});assert.equal(retried.status,200,JSON.stringify(retried));const nextId=retried.result.result.stageRequestId;
  const next=(await until(()=>stageState(f,nextId),v=>v.result.progress.terminal)).result;
  assert.equal(next.progress.phase,'COMPLETE');assert.equal(next.request.deadlineAt,original.deadlineAt);assert.equal(next.request.authorityRef,original.authorityRef);assert.equal(next.request.pinsDigest,original.pinsDigest);assert.equal(next.request.inputDigest,original.inputDigest,'same reducer digest is not semantic repair proof');assert.equal(next.request.planDigest,original.planDigest,'same plan digest can still address independently proved semantic repair');assert(next.repairAdmission);assert.equal(next.repairAdmission.requestDigest,next.request.digest);assert(repair.calls>=3,'admission and each permit independently reread trusted repair evidence');
  assert.equal(state.dispatches,2);assert.deepEqual((await stageState(f,id)).result.request,original);
  const instance=(await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance;assert.equal(instance.stages.scope.attempts,2);assert.deepEqual(instance.requestIds,[id,nextId]);
 }finally{await f.server.close();f.cleanup();}
});

test('prepared repair changes before dispatch block the retry side effect and preserve original evidence',async()=>{
 const {f,state,adapter}=await executingFixture();try{
  state.mode='fail';const first=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=first.result.result.stageRequestId;
  await until(()=>stageState(f,id),v=>v.result.progress.terminal);
  const repair=trustedRepairFixture(adapter);repair.verify=async(_subject,_actor,_signal,calls)=>{if(calls>1)repair.semanticRevision='changed-after-admission';};
  const retry=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'});assert.equal(retry.status,200,JSON.stringify(retry));
  const observed=await until(()=>stageState(f,retry.result.result.stageRequestId),v=>v.result.progress.phase==='UNKNOWN');assert.equal(observed.result.progress.reason,'REPAIR_FACTS_CHANGED');assert.equal(state.dispatches,1);assert.equal((await stageState(f,id)).result.progress.phase,'FAILED');
 }finally{await f.server.close();f.cleanup();}
});

test('UNKNOWN cannot bypass original observation through stage.advance with a trusted retry adapter',async()=>{
 const {f,state,adapter,observe}=await executingFixture();let advances=0;trustedRepairFixture(adapter);try{
  state.mode='unknown';adapter.advance=async(r,i,_p,permit)=>{await permit();advances++;return observe(r,i,'complete');};
  const first=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=first.result.result.stageRequestId;await until(()=>stageState(f,id),v=>v.result.progress.phase==='UNKNOWN');
  assert.equal((await execWrite(f,'lifecycle.stage.advance',{stageRequestId:id})).error.code,'RECONCILE_ORIGINAL_REQUEST');assert.equal((await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'})).error.code,'STAGE_BLOCKED');assert.equal(advances,0);assert.equal(state.dispatches,1);
 }finally{await f.server.close();f.cleanup();}
});

for(const variant of ['revocation','revision','deadline'])test('trusted repair verification preserves '+variant+' rejection before request commit',async()=>{
 const {f,g,state,adapter}=await executingFixture();const originalMutate=RuntimeStore.prototype.mutate;try{
  state.mode='fail';const first=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=first.result.result.stageRequestId;
  const original=(await until(()=>stageState(f,id),v=>v.result.progress.terminal)).result.request;
  const before=(await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance,repair=trustedRepairFixture(adapter),requestId='repair-denied-'+variant;
  if(variant==='deadline')RuntimeStore.prototype.mutate=function(principal,mutation,operation,reauthorize){if(mutation.requestId!==requestId)return originalMutate.call(this,principal,mutation,operation,reauthorize);return originalMutate.call(this,principal,mutation,()=>{const now=Date.now;Date.now=()=>Date.parse(original.deadlineAt);try{return operation();}finally{Date.now=now;}},reauthorize);};
  else repair.verify=async()=>{repair.verify=null;if(variant==='revocation')await execWrite(f,'lifecycle.authority.revoke',{authorityRef:g.ref,reason:'Synthetic trusted repair read revoked'},'decider');else await execWrite(f,'lifecycle.stage.reconcile',{stageRequestId:id},'reader');};
  const denied=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'},'executor',{requestId});assert.notEqual(denied.status,200,JSON.stringify(denied));if(variant==='revision')assert.equal(denied.error.code,'REVISION_CONFLICT');if(variant==='deadline')assert.equal(denied.error.code,'EXECUTION_DEADLINE');
  assert.equal((await request(f,'runtime.receipt.read',{requestId},'executor')).status,404);assert.deepEqual((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance,before);assert.equal(state.dispatches,1);
 }finally{RuntimeStore.prototype.mutate=originalMutate;await f.server.close();f.cleanup();}
});

test('repair verifier timeout aborts lookup without a replacement receipt or late dispatch',async()=>{
 const {f,state,adapter}=await executingFixture();let finish,aborted=false;try{
  state.mode='fail';const first=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=first.result.result.stageRequestId;await until(()=>stageState(f,id),v=>v.result.progress.terminal);
  const repair=trustedRepairFixture(adapter);repair.verify=async(_subject,_actor,signal)=>{signal.addEventListener('abort',()=>{aborted=true;},{once:true});await new Promise(resolve=>finish=resolve);};
  const denied=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'},'executor',{requestId:'repair-timeout'});assert.equal(denied.error.code,'OBSERVATION_INTERRUPTED');assert.equal(aborted,true);finish();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(state.dispatches,1);assert.equal((await request(f,'runtime.receipt.read',{requestId:'repair-timeout'},'executor')).status,404);assert.equal((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance.stages.scope.attempts,1);
 }finally{finish?.();await f.server.close();f.cleanup();}
});

test('retry rejects inconsistent failure progress and immutable observation envelope before trusted verification',async()=>{
 const {f,state,adapter}=await executingFixture(),originalObject=RuntimeStore.prototype.object;const repair=trustedRepairFixture(adapter);
 try{
  state.mode='fail';const first=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=first.result.result.stageRequestId;
  const observed=(await until(()=>stageState(f,id),v=>v.result.progress.terminal)).result;
  const envelope=(await request(f,'lifecycle.stage.observation.read',{stageRequestId:id,observationRef:observed.progress.observationRef},'reader')).result.evidence;
  const before=(await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance;
  for(const variant of ['phase','terminal','handle','reason','observedAt','envelope-schema','envelope-request','envelope-reason','envelope-observedAt']){
   const corrupted=structuredClone(observed.progress),forged=structuredClone(envelope);
   if(variant==='phase'){corrupted.observation.phase='COMPLETE';corrupted.observation.outcome.status='COMPLETE';}
   else if(variant==='terminal')corrupted.terminal='true';
   else if(variant==='handle')corrupted.handle=null;
   else if(variant==='reason')corrupted.reason='synthetic substituted failure reason';
   else if(variant==='observedAt')corrupted.observedAt=new Date(Date.parse(corrupted.observedAt)+1).toISOString();
   else{
    if(variant==='envelope-schema')forged.schema='runtime-stage-observation/v99';
    if(variant==='envelope-request')forged.requestId='another-original-request';
    if(variant==='envelope-reason')forged.reason='synthetic replaced envelope reason';
    if(variant==='envelope-observedAt')forged.observedAt=new Date(Date.parse(forged.observedAt)+1).toISOString();
    corrupted.observationRef=valueDigest(forged);
   }
   // Inject a faulty retained read only in this isolated fixture. Original
   // durable request, envelope, progress and audit are never rewritten.
   RuntimeStore.prototype.object=function(projectId,kind,objectId){
    if(projectId==='alpha'&&kind==='stage-progress'&&objectId===id)return structuredClone(corrupted);
    if(projectId==='alpha'&&kind==='stage-observation'&&objectId===corrupted.observationRef&&variant.startsWith('envelope-'))return structuredClone(forged);
    return originalObject.call(this,projectId,kind,objectId);
   };
   const requestId='corrupt-repair-'+variant,denied=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'},'executor',{requestId});
   RuntimeStore.prototype.object=originalObject;
   assert.equal(denied.error.code,'CORRUPT_STAGE_OBSERVATION',variant+': '+JSON.stringify(denied));assert.equal(repair.calls,0);assert.equal(state.dispatches,1);
   assert.equal((await request(f,'runtime.receipt.read',{requestId},'executor')).status,404);
   assert.deepEqual((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance,before);
   assert.deepEqual((await stageState(f,id)).result.progress,observed.progress);
  }
 }finally{RuntimeStore.prototype.object=originalObject;await f.server.close();f.cleanup();}
});

test('first execution of an independent stage does not reinterpret unrelated historical request contracts',async()=>{
 // Explicit pre-correction native fixture: no fabricated recovery root.
 const {f,state}=await executingFixture(true),originalObject=RuntimeStore.prototype.object;try{
  const first=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=first.result.result.stageRequestId;
  const original=(await until(()=>stageState(f,id),v=>v.result.progress.terminal)).result.request;
  RuntimeStore.prototype.object=function(projectId,kind,objectId){
   if(projectId==='alpha'&&kind==='stage-request'&&objectId===id)return{schema:'synthetic-historical-predecessor/v1',id,stageId:'scope'};
   return originalObject.call(this,projectId,kind,objectId);
  };
  const next=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'plan'});RuntimeStore.prototype.object=originalObject;
  assert.equal(next.status,200,JSON.stringify(next));await until(()=>stageState(f,next.result.result.stageRequestId),v=>v.result.progress.terminal);
  assert.equal(state.dispatches,2);assert.deepEqual((await stageState(f,id)).result.request,original);
 }finally{RuntimeStore.prototype.object=originalObject;await f.server.close();f.cleanup();}
});

test('selected retry history still rejects synthetic contracts and missing stage membership',async()=>{
 const {f,state,adapter}=await executingFixture(),originalObject=RuntimeStore.prototype.object;const repair=trustedRepairFixture(adapter);try{
  state.mode='fail';const first=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=first.result.result.stageRequestId;
  const original=(await until(()=>stageState(f,id),v=>v.result.progress.terminal)).result.request;
  for(const variant of ['synthetic','hidden']){
   RuntimeStore.prototype.object=function(projectId,kind,objectId){
    if(projectId==='alpha'&&kind==='stage-request'&&objectId===id)return variant==='synthetic'?{schema:'synthetic-predecessor/v1',id,stageId:'scope'}:{...original,stageId:'plan'};
    return originalObject.call(this,projectId,kind,objectId);
   };
   const denied=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'});RuntimeStore.prototype.object=originalObject;
   assert.equal(denied.error.code,variant==='synthetic'?'CORRUPT_STAGE_REQUEST':'REPAIR_HISTORY_REQUIRED',JSON.stringify(denied));assert.equal(repair.calls,0);assert.equal(state.dispatches,1);
   assert.deepEqual((await stageState(f,id)).result.request,original);
  }
 }finally{RuntimeStore.prototype.object=originalObject;await f.server.close();f.cleanup();}
});

test('UNKNOWN continuation recovers original receipts read-only and permits only the resolved remaining action',async()=>{
 const {f,state,adapter,observe}=await executingFixture();let reconciliations=0,advances=0;
 try{
  state.mode='unknown';adapter.reconcileAdvance=async(r,i,p,actor)=>{reconciliations++;assert.deepEqual(actor.permissions,['read']);assert.equal(p.phase,'UNKNOWN');return observe(r,i,'running');};
  adapter.advance=async(r,i,p,permit)=>{assert.equal(p.phase,'CI_RUNNING');await permit();advances++;return observe(r,i,'complete');};
  const first=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=first.result.result.stageRequestId;await until(()=>stageState(f,id),v=>v.result.progress.phase==='UNKNOWN');await until(()=>request(f,'runtime.status'),v=>v.result.observationWorker.inFlight===0);
  const original=(await stageState(f,id)).result.request,advanced=await execWrite(f,'lifecycle.stage.advance',{stageRequestId:id});assert.equal(advanced.status,200,JSON.stringify(advanced));await until(()=>stageState(f,id),v=>v.result.progress.phase==='COMPLETE');
  assert.equal(reconciliations,1);assert.equal(advances,1);assert.equal(state.dispatches,1);assert.deepEqual((await stageState(f,id)).result.request,original);assert.equal((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance.stages.scope.attempts,1);
 }finally{await f.server.close();f.cleanup();}
});

test('unresolved original receipt recovery accepts observation without entering advance or dispatch',async()=>{
 const {f,state,adapter,observe}=await executingFixture();let reconciliations=0,advances=0;
 try{
  state.mode='unknown';adapter.reconcileAdvance=async(r,i,_p,actor)=>{reconciliations++;assert.deepEqual(actor.permissions,['read']);return observe(r,i,'unknown');};
  adapter.advance=async(r,i,_p,permit)=>{await permit();advances++;return observe(r,i,'complete');};
  const first=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=first.result.result.stageRequestId;await until(()=>stageState(f,id),v=>v.result.progress.phase==='UNKNOWN');await until(()=>request(f,'runtime.status'),v=>v.result.observationWorker.inFlight===0);
  const original=(await stageState(f,id)).result.request,advanced=await execWrite(f,'lifecycle.stage.advance',{stageRequestId:id});assert.equal(advanced.status,200,JSON.stringify(advanced));await until(()=>request(f,'runtime.status'),v=>v.result.observationWorker.inFlight===0);
  assert.equal(reconciliations,1);assert.equal(advances,0);assert.equal(state.dispatches,1);assert.equal((await stageState(f,id)).result.progress.phase,'UNKNOWN');assert.deepEqual((await stageState(f,id)).result.request,original);
 }finally{await f.server.close();f.cleanup();}
});

test('authority revoked during read-only recovery cannot authorize a remaining action',async()=>{
 const {f,g,state,adapter,observe}=await executingFixture();let advances=0;
 try{
  state.mode='unknown';adapter.reconcileAdvance=async(r,i)=>{await execWrite(f,'lifecycle.authority.revoke',{authorityRef:g.ref,reason:'Synthetic revocation during original receipt lookup'},'decider');return observe(r,i,'running');};
  adapter.advance=async(r,i,_p,permit)=>{await permit();advances++;return observe(r,i,'complete');};
  const first=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=first.result.result.stageRequestId;await until(()=>stageState(f,id),v=>v.result.progress.phase==='UNKNOWN');await until(()=>request(f,'runtime.status'),v=>v.result.observationWorker.inFlight===0);
  assert.equal((await execWrite(f,'lifecycle.stage.advance',{stageRequestId:id})).status,200);
  await until(()=>stageState(f,id),v=>v.result.progress.reason==='AUTHORITY_REVOKED');assert.equal(advances,0);assert.equal(state.dispatches,1);assert.equal((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance.stages.scope.attempts,1);
 }finally{await f.server.close();f.cleanup();}
});

async function recoveryView(f,id='one'){return(await request(f,'lifecycle.instance.inspect',{instanceId:id})).result.recovery;}
async function successor(f,original,id){const root=await recoveryView(f),subject={...original.input.subject,instanceId:id,recoveryRootRef:root.rootRef,expiresAt:root.deadlineAt},approved=await grant(f,'execution',subject);assert.equal((await create(f,approved,id)).status,200);return approved;}

test('native successor authority must explicitly bind the original root without widening scope or budgets',async()=>{
 const {f,g}=await executingFixture();try{
  const root=await recoveryView(f);assert.match(root.rootRef,/^recovery-root:sha256:/);assert.equal(root.originalInstanceId,'one');assert.equal(root.originalAuthorityRef,g.ref);assert.equal(root.originalTargetRef,g.input.subject.targetRef);
  const base={...g.input.subject,instanceId:'two',expiresAt:root.deadlineAt};
  for(const [subject,code] of [[base,'RECOVERY_ROOT_REQUIRED'],[{...base,recoveryRootRef:'recovery-root:'+valueDigest('absent')},'RECOVERY_ROOT_NOT_FOUND'],[{...base,recoveryRootRef:root.rootRef,goalRef:'synthetic:goal/unrelated'},'RECOVERY_SCOPE_CHANGED'],[{...base,recoveryRootRef:root.rootRef,expiresAt:new Date(Date.parse(root.deadlineAt)+1000).toISOString()},'RECOVERY_BUDGET_WIDENED'],[{...base,recoveryRootRef:root.rootRef,budget:{...base.budget,maxAttempts:3}},'RECOVERY_BUDGET_WIDENED']])assert.equal((await request(f,'lifecycle.authority.preview',{kind:'execution',subject},'decider')).error.code,code);
  const linked=await successor(f,g,'two');const decision=(await inspect(f,linked.ref)).result.decision;assert.equal(decision.subject.recoveryRootRef,root.rootRef);assert.equal(decision.subject.recoveryRootDigest,root.rootDigest);assert.equal((await recoveryView(f,'two')).rootRef,root.rootRef);
  assert.equal((await write(f,'lifecycle.instance.create',{instanceId:'three',definitionRevisionId:f.definitionRevisionId,authorityRef:linked.ref,recoveryRootRef:root.rootRef},'executor')).error.code,'INVALID_FIELDS');
  assert.equal(Object.hasOwn((await inspect(f,g.ref)).result.decision.subject,'recoveryRootRef'),false,'original decision bytes are not rewritten');
 }finally{await f.server.close();f.cleanup();}
});

test('PASSED stages rerun only within cumulative root attempts across successor, restart and relocated state',async()=>{
 const {f,g,state}=await executingFixture();try{
  const first=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),firstId=first.result.result.stageRequestId;const original=(await until(()=>stageState(f,firstId),v=>v.result.progress.terminal)).result.request;
  await successor(f,g,'two');await f.server.close();const relocated=join(f.dir,'relocated-state');renameSync(f.root,relocated);f.root=relocated;f.options.stateRoot=relocated;await f.open();
  const second=await execWrite(f,'lifecycle.stage.request',{instanceId:'two',stageId:'scope'},'publisher');assert.equal(second.status,200,JSON.stringify(second));const secondId=second.result.result.stageRequestId;await until(()=>stageState(f,secondId),v=>v.result.progress.terminal);
  assert.equal((await stageState(f,secondId)).result.request.deadlineAt,original.deadlineAt);assert.deepEqual((await stageState(f,firstId)).result.request,original);assert.equal(state.dispatches,2);
  await successor(f,g,'three');const denied=await execWrite(f,'lifecycle.stage.request',{instanceId:'three',stageId:'scope'},'executor',{requestId:'root-exhausted'});assert.equal(denied.error.code,'STAGE_BLOCKED');assert.match(denied.error.message,/RECOVERY_ATTEMPTS_EXHAUSTED/);assert.equal((await request(f,'runtime.receipt.read',{requestId:'root-exhausted'},'executor')).status,404);
  const root=await recoveryView(f,'three');assert.deepEqual(root.attempts.map(a=>a.requestId),[firstId,secondId]);assert.equal((await request(f,'lifecycle.instance.inspect',{instanceId:'three'})).result.instance.stages.scope.attempts,0);
 }finally{await f.server.close();f.cleanup();}
});

for(const [mode,reason]of [['unknown','RECONCILE_ORIGINAL_REQUEST'],['running','RECONCILE_ORIGINAL_REQUEST'],['fail','RECOVERY_REPAIR_EVIDENCE_REQUIRED']])test('successor cannot bypass '+mode+' original stage through a new instance',async()=>{
 const {f,g,state}=await executingFixture();try{
  state.mode=mode;state.inspectMode=mode;const first=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=first.result.result.stageRequestId;await until(()=>stageState(f,id),v=>v.result.progress.phase===(mode==='fail'?'FAILED':mode==='running'?'CI_RUNNING':'UNKNOWN'));
  await successor(f,g,'two');const denied=await execWrite(f,'lifecycle.stage.request',{instanceId:'two',stageId:'scope'});assert.equal(denied.error.code,'STAGE_BLOCKED',JSON.stringify(denied));assert.match(denied.error.message,new RegExp(reason));assert.equal(state.dispatches,1);
 }finally{await f.server.close();f.cleanup();}
});

test('root concurrency spans member instances while separately reviewed goals remain independent',async()=>{
 const f=fixture(),{state}=stageAdapter(f);for(const phase of ['plan','verification'])f.data.config[phase].budget.maxConcurrency=1;await f.open();try{
  await activate(f);const g=await grant(f);await create(f,g);const scope=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'});await until(()=>stageState(f,scope.result.result.stageRequestId),v=>v.result.progress.terminal);
  await successor(f,g,'two');state.mode='running';state.inspectMode='running';const planning=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'plan'});await until(()=>stageState(f,planning.result.result.stageRequestId),v=>v.result.progress.phase==='CI_RUNNING');
  const denied=await execWrite(f,'lifecycle.stage.request',{instanceId:'two',stageId:'scope'});assert.equal(denied.error.code,'STAGE_BLOCKED');assert.match(denied.error.message,/RECOVERY_CONCURRENCY_EXHAUSTED/);
  const separate=await grant(f,'execution',executionSubject(f,'independent'));assert.equal((await create(f,separate,'independent')).status,200);assert.notEqual((await recoveryView(f,'independent')).rootRef,(await recoveryView(f)).rootRef);assert.equal((await execWrite(f,'lifecycle.stage.request',{instanceId:'independent',stageId:'scope'})).status,200);
 }finally{await f.server.close();f.cleanup();}
});

test('expired recovery root cannot be revived by successor approval; its original history remains readable',async()=>{
 const {f,g,state}=await executingFixture();const now=Date.now;try{
  const root=await recoveryView(f);Date.now=()=>Date.parse(root.deadlineAt)+1;
  const subject={...g.input.subject,instanceId:'two',recoveryRootRef:root.rootRef,expiresAt:new Date(Date.now()+60000).toISOString()},denied=await request(f,'lifecycle.authority.preview',{kind:'execution',subject},'decider');assert.equal(denied.error.code,'RECOVERY_DEADLINE_EXHAUSTED',JSON.stringify(denied));
  assert.deepEqual(await recoveryView(f),root);assert.equal((await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'})).status,409);assert.equal(state.dispatches,0);
 }finally{Date.now=now;await f.server.close();f.cleanup();}
});

test('legacy native instances remain rootless and cannot be silently backfilled or replaced by a fresh root',async()=>{
 const f=fixture();await f.open();try{
  await activate(f);const g=await grant(f);await seedLegacyNativeInstance(f,g);
  assert.equal(await recoveryView(f),null);const subject={...g.input.subject,instanceId:'two'};assert.equal((await request(f,'lifecycle.authority.preview',{kind:'execution',subject},'decider')).error.code,'RECOVERY_ORIGIN_UNAVAILABLE');assert.equal(await recoveryView(f),null);
 }finally{await f.server.close();f.cleanup();}
});

for(const variant of ['missing-ledger','omitted-request','omitted-request-and-counter','missing-member','binding-downgrade','binding-and-member-downgrade'])test('native recovery rejects '+variant+' instead of renewing cumulative authority',async()=>{
 const {f,g,state}=await executingFixture(),originalObject=RuntimeStore.prototype.object;try{
  const first=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=first.result.result.stageRequestId;await until(()=>stageState(f,id),v=>v.result.progress.terminal);await until(()=>request(f,'runtime.status'),v=>v.result.observationWorker.inFlight===0);
  await successor(f,g,'two');const root=await recoveryView(f),before=(await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance;
  RuntimeStore.prototype.object=function(projectId,kind,objectId){
   const raw=originalObject.call(this,projectId,kind,objectId);if(projectId!=='alpha')return raw;
   if(kind==='lifecycle-recovery-ledger'&&objectId==='attempts:'+root.rootRef){if(variant==='missing-ledger')return null;if(variant.startsWith('omitted-request')){const{digest,...body}=raw;body.entries=[];return{...body,digest:valueDigest(body)};}}
   if(kind==='lifecycle-recovery-ledger'&&objectId==='member:one'&&['missing-member','binding-and-member-downgrade'].includes(variant))return null;
   if(kind==='instance-authority'&&objectId==='one'&&variant.includes('downgrade'))return{evidenceRef:raw.evidenceRef};
   if(kind==='lifecycle-instance'&&objectId==='one'&&variant==='omitted-request-and-counter'){const saved=structuredClone(raw);saved.requestIds=[];saved.stages.scope={status:'PENDING',attempts:0,requestId:null,inputDigest:null,requestedAt:null,receiptRef:null,outcomeDigest:null,expiresAt:null};return saved;}
   return raw;
  };
  const denied=await execWrite(f,'lifecycle.stage.request',{instanceId:'two',stageId:'scope'},'executor',{requestId:'tampered-root-'+variant});
  assert.equal(denied.status,503,JSON.stringify(denied));assert.match(denied.error.code,/^CORRUPT_RECOVERY_(LEDGER|MEMBER)$/);assert.equal(state.dispatches,1);
  RuntimeStore.prototype.object=originalObject;
  assert.deepEqual((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance,before);assert.equal((await request(f,'runtime.receipt.read',{requestId:'tampered-root-'+variant},'executor')).status,404);assert.deepEqual(await recoveryView(f),root);
 }finally{RuntimeStore.prototype.object=originalObject;await f.server.close();f.cleanup();}
});

test('native preparation identity preserves target id and version across explicitly reviewed source successors',async()=>{
 const f=fixture();stageAdapter(f);
 // Only this trusted fixture validator supplies preparation facts. The native
 // service still retains and checks the complete packet; no client trust flags.
 f.preparation=()=>({reviewerIds:['decider'],evidence:{syntheticFixture:true}});await f.open();try{
  await activate(f);const definition=(await request(f,'lifecycle.definition.read',{revisionId:f.definitionRevisionId})).result.compilation.effective,base=executionSubject(f);
  const input={definitionRevisionId:f.definitionRevisionId,goalRef:base.goalRef,loopRef:base.loopRef,target:{id:'synthetic-recovery',version:'0.9.0',title:'Synthetic prepared successor',scope:['Synthetic recovery identity only'],exclusions:['Real owner or repair qualification']},source:{provider:'github',repositoryId:'42',commit:'a'.repeat(40)},compatibility:'compatible',documents:Object.fromEntries(['plan','impact','verification','rollback','migration'].map(role=>[role,role==='migration'?null:{path:join(f.dir,'synthetic-'+role+'.md'),digest:valueDigest('synthetic-'+role)}])),verification:{requirementsDigest:requiredChecksDigest(definition),checks:definition.nodes.flatMap(n=>n.checks.map(checkId=>({stageId:n.id,checkId,source:'owner-receipt',procedure:'Synthetic fixture evidence only'})))}};
  const retain=async packet=>{const r=await write(f,'lifecycle.preparation.save',packet,'owner');assert.equal(r.status,200,JSON.stringify(r));return r.result.result.preparationRef;};
  const firstRef=await retain(input),g=await grant(f,'execution',{...base,targetRef:firstRef});assert.equal((await create(f,g)).status,200);const root=await recoveryView(f);
  assert.deepEqual(root.identity.target,{kind:'preparation',id:input.target.id,version:input.target.version});assert.equal(root.originalTargetRef,firstRef);
  const nextRef=await retain({...input,source:{...input.source,commit:'b'.repeat(40)}}),subject={...base,instanceId:'two',targetRef:nextRef,recoveryRootRef:root.rootRef,expiresAt:root.deadlineAt};assert.notEqual(nextRef,firstRef);
  assert.equal((await request(f,'lifecycle.authority.preview',{kind:'execution',subject:{...subject,recoveryRootRef:undefined}},'decider')).error.code,'RECOVERY_ROOT_REQUIRED');
  const next=await grant(f,'execution',subject);assert.equal((await create(f,next,'two')).status,200);assert.equal((await recoveryView(f,'two')).rootRef,root.rootRef);assert.equal((await request(f,'lifecycle.instance.inspect',{instanceId:'two'})).result.instance.pins.targetRef,nextRef);
  for(const target of [{...input.target,id:'another-target'},{...input.target,version:'0.9.1'}]){const ref=await retain({...input,target});const denied=await request(f,'lifecycle.authority.preview',{kind:'execution',subject:{...subject,instanceId:'three',targetRef:ref}},'decider');assert.equal(denied.error.code,'RECOVERY_SCOPE_CHANGED');}
  assert.equal((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance.pins.targetRef,firstRef);
 }finally{await f.server.close();f.cleanup();}
});

test('concurrent successor claims cannot both consume the last original stage attempt',async()=>{
 const {f,g,state}=await executingFixture();let release;try{
  const first=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'});await until(()=>stageState(f,first.result.result.stageRequestId),v=>v.result.progress.terminal);
  await successor(f,g,'two');await successor(f,g,'three');let entered=0;const hold=new Promise(resolve=>release=resolve);state.prepare=async()=>{entered++;await hold;};
  const a=execWrite(f,'lifecycle.stage.request',{instanceId:'two',stageId:'scope'},'executor',{requestId:'last-attempt-two'}),b=execWrite(f,'lifecycle.stage.request',{instanceId:'three',stageId:'scope'},'publisher',{requestId:'last-attempt-three'});await until(async()=>entered,v=>v===2);release();
  const results=await Promise.all([a,b]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);const accepted=results.find(r=>r.status===200),denied=results.find(r=>r.status!==200);assert.equal(denied.error.code,'REVISION_CONFLICT');await until(()=>stageState(f,accepted.result.result.stageRequestId),v=>v.result.progress.terminal);assert.equal(state.dispatches,2);
  assert.equal((await recoveryView(f)).attempts.length,2);assert.equal((await request(f,'runtime.receipt.read',{requestId:results[0].status===200?'last-attempt-three':'last-attempt-two'},results[0].status===200?'publisher':'executor')).status,404);
 }finally{release?.();await f.server.close();f.cleanup();}
});

test('revoking original native authority blocks a separately approved successor without rewriting history',async()=>{
 const {f,g,state}=await executingFixture();try{
  await successor(f,g,'two');const root=await recoveryView(f);assert.equal((await execWrite(f,'lifecycle.authority.revoke',{authorityRef:g.ref,reason:'Synthetic root withdrawal'},'decider')).status,200);
  const denied=await execWrite(f,'lifecycle.stage.request',{instanceId:'two',stageId:'scope'});assert.equal(denied.error.code,'RECOVERY_AUTHORITY_REVOKED');assert.equal(state.dispatches,0);assert.deepEqual(await recoveryView(f),root);assert.equal((await recoveryView(f,'two')).rootRef,root.rootRef);
 }finally{await f.server.close();f.cleanup();}
});

test('an active narrower native grant constrains a looser sibling starting a different stage',async()=>{
 const {f,g,state}=await executingFixture();try{
  for(const stageId of ['scope','plan']){const r=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId});assert.equal(r.status,200,JSON.stringify(r));await until(()=>stageState(f,r.result.result.stageRequestId),v=>v.result.progress.terminal);}
  const root=await recoveryView(f);for(const phase of ['plan','verification'])f.data.config[phase].budget.maxConcurrency=1;await request(f,'runtime.status');await activate(f);
  const subject={...g.input.subject,instanceId:'narrow',definitionRevisionId:f.definitionRevisionId,budget:{...g.input.subject.budget,maxConcurrency:1},expiresAt:root.deadlineAt,recoveryRootRef:root.rootRef},narrow=await grant(f,'execution',subject);assert.equal((await create(f,narrow,'narrow')).status,200);
  const scope=await execWrite(f,'lifecycle.stage.request',{instanceId:'narrow',stageId:'scope'});await until(()=>stageState(f,scope.result.result.stageRequestId),v=>v.result.progress.terminal);
  state.mode='running';state.inspectMode='running';const active=await execWrite(f,'lifecycle.stage.request',{instanceId:'narrow',stageId:'plan'});assert.equal(active.status,200,JSON.stringify(active));await until(()=>stageState(f,active.result.result.stageRequestId),v=>v.result.progress.phase==='CI_RUNNING');
  const before=state.dispatches,denied=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'implementation'},'executor',{requestId:'looser-sibling'});assert.equal(denied.error.code,'STAGE_BLOCKED');assert.match(denied.error.message,/RECOVERY_CONCURRENCY_EXHAUSTED/);assert.doesNotMatch(denied.error.message,/RECONCILE_ORIGINAL_REQUEST/);assert.equal(state.dispatches,before);assert.equal((await request(f,'runtime.receipt.read',{requestId:'looser-sibling'},'executor')).status,404);
 }finally{await f.server.close();f.cleanup();}
});

test('rootless injected legacy instances remain readable under native service without blocking unrelated native lineage',async()=>{
 const f=fixture();f.authorities=async(ref,definition)=>({projectId:'alpha',instanceId:'legacy-injected',definitionRevisionId:f.definitionRevisionId,semanticDigest:definition.semanticDigest,requirementsDigest:requiredChecksDigest(definition),goalRef:'synthetic:legacy/goal',targetRef:'synthetic:legacy/target',loopRef:'synthetic:legacy/loop',budget:f.data.config.plan.budget,evidenceRef:ref,revision:'synthetic-legacy-1',expiresAt:'2030-01-01T00:00:00Z'});await f.open();try{
  await activate(f);const created=await write(f,'lifecycle.instance.create',{instanceId:'legacy-injected',definitionRevisionId:f.definitionRevisionId,authorityRef:'synthetic:legacy-authority'},'executor');assert.equal(created.status,200,JSON.stringify(created));const original=(await request(f,'lifecycle.instance.inspect',{instanceId:'legacy-injected'})).result.instance;
  await f.server.close();f.authorities=undefined;await f.open();const historical=await request(f,'lifecycle.instance.inspect',{instanceId:'legacy-injected'});assert.equal(historical.status,200,JSON.stringify(historical));assert.deepEqual(historical.result.instance,original);assert.equal(historical.result.recovery,null);
  const native=await grant(f);assert.equal((await create(f,native)).status,200);assert.match((await recoveryView(f)).rootRef,/^recovery-root:sha256:/);assert.deepEqual((await request(f,'lifecycle.instance.inspect',{instanceId:'legacy-injected'})).result.instance,original);
 }finally{await f.server.close();f.cleanup();}
});

test('a counterfeit PASSED predecessor projection cannot override its original UNKNOWN receipt',async()=>{
 const {f,state}=await executingFixture(),originalObject=RuntimeStore.prototype.object;try{
  state.mode='unknown';state.inspectMode='unknown';const original=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=original.result.result.stageRequestId,retained=(await until(()=>stageState(f,id),v=>v.result.progress.phase==='UNKNOWN')).result;
  await until(()=>request(f,'runtime.status'),v=>v.result.observationWorker.inFlight===0);const before=(await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance;
  RuntimeStore.prototype.object=function(projectId,kind,objectId){const raw=originalObject.call(this,projectId,kind,objectId);if(projectId==='alpha'&&kind==='lifecycle-instance'&&objectId==='one'){const forged=structuredClone(raw);forged.stages.scope.status='PASSED';forged.stages.scope.expiresAt='2030-01-01T00:00:00Z';return forged;}return raw;};
  const denied=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'plan'},'executor',{requestId:'forged-predecessor'});assert.equal(denied.error.code,'CORRUPT_RECOVERY_LEDGER');assert.equal(state.dispatches,1);
  RuntimeStore.prototype.object=originalObject;assert.deepEqual((await stageState(f,id)).result,retained);assert.deepEqual((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance,before);assert.equal((await request(f,'runtime.receipt.read',{requestId:'forged-predecessor'},'executor')).status,404);
 }finally{RuntimeStore.prototype.object=originalObject;await f.server.close();f.cleanup();}
});

test('a pending candidate stage cannot carry a fabricated self-consistent candidate manifest',async()=>{
 const {f,state}=await executingFixture(),originalObject=RuntimeStore.prototype.object;try{
  const before=(await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance,candidate={schema:'runtime-candidate/v1',version:'synthetic-fabricated',profile:'candidate-verification',sourceDigest:valueDigest('fabricated-source'),buildDigest:valueDigest('fabricated-build'),artifacts:[{name:'synthetic.tgz',digest:valueDigest('fabricated-bytes'),bytes:1}]};
  RuntimeStore.prototype.object=function(projectId,kind,objectId){const raw=originalObject.call(this,projectId,kind,objectId);if(projectId==='alpha'&&kind==='lifecycle-instance'&&objectId==='one')return{...raw,candidate,candidateDigest:valueDigest(candidate)};return raw;};
  const denied=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'},'executor',{requestId:'fabricated-candidate'});assert.equal(denied.error.code,'CORRUPT_RECOVERY_LEDGER');assert.equal(state.dispatches,0);
  RuntimeStore.prototype.object=originalObject;assert.deepEqual((await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance,before);assert.equal((await request(f,'runtime.receipt.read',{requestId:'fabricated-candidate'},'executor')).status,404);
 }finally{RuntimeStore.prototype.object=originalObject;await f.server.close();f.cleanup();}
});

async function shortStageRecoveryFixture(mode='complete'){
 const f=fixture(),adapter=stageAdapter(f);f.data.config.plan.budget.timeoutSeconds=10;await f.open();await activate(f);
 // Both bounds are reviewed before the first request: a short single stage,
 // inside a longer original root window. No later budget amendment is made.
 const subject=executionSubject(f);subject.budget.timeoutSeconds=600;const g=await grant(f,'execution',subject);await create(f,g);adapter.state.mode=mode;adapter.state.inspectMode=mode;
 const first=await execWrite(f,'lifecycle.stage.request',{instanceId:'one',stageId:'scope'}),id=first.result.result.stageRequestId,original=(await until(()=>stageState(f,id),v=>v.result.progress.phase===(mode==='complete'?'COMPLETE':mode==='fail'?'FAILED':'UNKNOWN'))).result;
 return{f,g,...adapter,id,original};
}

test('reviewed successor really reruns an expired prior PASS within the unchanged root window',async()=>{
 const{f,g,state,id,original}=await shortStageRecoveryFixture(),now=Date.now;try{
  const root=await recoveryView(f);assert(Date.parse(original.request.deadlineAt)<Date.parse(root.deadlineAt));Date.now=()=>Date.parse(original.request.deadlineAt)+100;
  await successor(f,g,'two');const next=await execWrite(f,'lifecycle.stage.request',{instanceId:'two',stageId:'scope'});assert.equal(next.status,200,JSON.stringify(next));const result=(await until(()=>stageState(f,next.result.result.stageRequestId),v=>v.result.progress.terminal)).result;
  assert.equal(result.progress.phase,'COMPLETE');assert.equal(state.dispatches,2);assert(Date.parse(result.request.deadlineAt)>Date.parse(original.request.deadlineAt));assert(Date.parse(result.request.deadlineAt)<=Date.parse(root.deadlineAt));assert(Date.parse(result.request.deadlineAt)<=Date.parse(result.request.requestedAt)+10000);
  assert.deepEqual((await stageState(f,id)).result.request,original.request);assert.deepEqual((await stageState(f,id)).result.progress,original.progress);assert.deepEqual((await recoveryView(f,'two')).budget,root.budget);assert.equal((await recoveryView(f,'two')).attempts.length,2);
 }finally{Date.now=now;await f.server.close();f.cleanup();}
});

for(const mode of ['fail','unknown'])test('reviewed successor preserves the expired original '+mode+' cutoff',async()=>{
 const{f,g,state,original}=await shortStageRecoveryFixture(mode),now=Date.now;try{
  await successor(f,g,'two');Date.now=()=>Date.parse(original.request.deadlineAt)+100;
  const denied=await execWrite(f,'lifecycle.stage.request',{instanceId:'two',stageId:'scope'});assert.equal(denied.error.code,'STAGE_BLOCKED',JSON.stringify(denied));assert.match(denied.error.message,/RECOVERY_DEADLINE_EXHAUSTED/);assert.equal(state.dispatches,1);
 }finally{Date.now=now;await f.server.close();f.cleanup();}
});

test('completed prior PASS cannot renew an expired original root through a preapproved successor',async()=>{
 const{f,g,state}=await shortStageRecoveryFixture(),now=Date.now;try{
  await successor(f,g,'two');const root=await recoveryView(f);Date.now=()=>Date.parse(root.deadlineAt)+1;
  const denied=await execWrite(f,'lifecycle.stage.request',{instanceId:'two',stageId:'scope'});assert.notEqual(denied.status,200);assert.equal(state.dispatches,1);assert.equal((await recoveryView(f,'two')).attempts.length,1);
 }finally{Date.now=now;await f.server.close();f.cleanup();}
});

test('forged COMPLETE progress cannot remove a failed ancestor request cutoff',async()=>{
 const{f,g,state,id,original}=await shortStageRecoveryFixture('fail'),now=Date.now,object=RuntimeStore.prototype.object;try{
  await successor(f,g,'two');Date.now=()=>Date.parse(original.request.deadlineAt)+100;
  RuntimeStore.prototype.object=function(projectId,kind,ref){const raw=object.call(this,projectId,kind,ref);if(projectId==='alpha'&&kind==='stage-progress'&&ref===id){const fake=structuredClone(raw);fake.phase='COMPLETE';fake.observation.phase='COMPLETE';fake.observation.outcome.status='COMPLETE';return fake;}return raw;};
  const denied=await execWrite(f,'lifecycle.stage.request',{instanceId:'two',stageId:'scope'});assert.equal(denied.error.code,'CORRUPT_RECOVERY_LEDGER',JSON.stringify(denied));assert.equal(state.dispatches,1);
 }finally{RuntimeStore.prototype.object=object;Date.now=now;await f.server.close();f.cleanup();}
});

for(const sameInputs of [false,true])test(sameInputs?'new request and receipt metadata cannot repair unchanged v2 deterministic inputs':'reviewed successor consumes all original failures and one trusted v2 proof in the original root CAS',async()=>{
 const {f,g,state,adapter,observe}=await executingFixture();let calls=0,omit=true,noProgress=false;
 try{
  state.dispatch=(r,i)=>{const o=observe(r,i,r.stageId==='verification'&&i.id==='one'?'fail':'complete');if(r.stageId==='candidate')o.outcome.candidate={schema:'runtime-candidate/v1',version:'0.9.0',profile:'candidate-verification',sourceDigest:valueDigest('synthetic-source-'+(sameInputs?'same':i.id)),buildDigest:valueDigest('synthetic-build-'+(sameInputs?'same':i.id)),artifacts:[{name:'fixture.tgz',digest:valueDigest('synthetic-artifact-'+(sameInputs?'same':i.id)),bytes:10}]};return o;};
  async function execute(id,stage){const response=await execWrite(f,'lifecycle.stage.request',{instanceId:id,stageId:stage});assert.equal(response.status,200,JSON.stringify(response));return(await until(()=>stageState(f,response.result.result.stageRequestId),v=>v.result.progress.terminal)).result;}
  for(const stage of ['scope','plan','implementation','candidate'])await execute('one',stage);const original=await execute('one','verification');assert.equal(original.progress.phase,'FAILED');
  await successor(f,g,'two');for(const stage of ['scope','plan','implementation'])await execute('two',stage);
  const proposal=await execWrite(f,'lifecycle.correction.propose',{stageRequestId:original.request.id,hypothesis:'Synthetic reviewed successor',minimalVerification:'Existing candidate and trusted adapter fixture',proposedChanges:[],verification:{instanceId:'two',stageId:'candidate'}},'owner');assert.equal(proposal.status,200,JSON.stringify(proposal));const correctionRef=proposal.result.result.correctionRef;
  await execute('two','candidate');
  adapter.verifyRepair=async subject=>{
   calls++;assert.equal(subject.schema,'runtime-stage-repair-subject/v2');assert.equal(subject.origins.length,1);assert.equal(subject.origins[0].request.id,original.request.id);
   const inputs=(candidate,suffix)=>({sourceDigest:valueDigest(sameInputs?'same':suffix),candidateDigest:candidate,toolchainDigest:valueDigest('synthetic-tools'),dependencyClosureDigest:valueDigest('synthetic-inputs-'+(sameInputs?'same':suffix))});
   return{schema:'runtime-stage-repair-facts/v2',subjectDigest:valueDigest(subject),rootRef:subject.root.ref,rootDigest:subject.root.digest,originsDigest:valueDigest(subject.origins),failureClass:'DETERMINISTIC',failureKind:'FIXED_PRODUCT_CHECK',origins:omit?[]:subject.origins.map(origin=>({requestId:origin.request.id,requestDigest:origin.request.digest,observationRef:origin.progress.observationRef,before:inputs(origin.candidateDigest,'old'),failedCriteria:[{criterionId:'synthetic-fixed',variantId:'actual-observation',evidenceDigest:valueDigest('synthetic-failure')}],coverage:[{criterionId:'synthetic-fixed',captureDigest:valueDigest('capture'),roundDigest:valueDigest('round'),nativeActionDigest:valueDigest('native-action'),nativeReceiptDigest:valueDigest('native-receipt'),comparisonActionDigest:valueDigest('comparison-action'),comparisonReceiptDigest:valueDigest('comparison-receipt'),probeCandidateDigest:subject.candidateDigest}]})),after:inputs(subject.candidateDigest,'new'),rounds:noProgress?[0,1].map(n=>({evidenceRef:'synthetic:round-'+n,beforeFactsDigest:valueDigest('same'),afterFactsDigest:valueDigest('same')})):[{evidenceRef:'synthetic:actual-round',beforeFactsDigest:valueDigest('old'),afterFactsDigest:valueDigest('new')}],evidenceRef:'synthetic:actual-round',expiresAt:original.request.deadlineAt};
  };
  const denied=await execWrite(f,'lifecycle.stage.request',{instanceId:'two',stageId:'verification'});assert.equal(denied.error.code,'REPAIR_FACTS_MISMATCH');assert.equal((await request(f,'lifecycle.instance.inspect',{instanceId:'two'})).result.instance.stages.verification.attempts,0);
  omit=false;
  if(!sameInputs){noProgress=true;const stopped=await execWrite(f,'lifecycle.stage.request',{instanceId:'two',stageId:'verification'});assert.equal(stopped.error.code,'TWO_NO_PROGRESS_ROUNDS');noProgress=false;}
  const previewInput={stageRequestId:original.request.id,correctionRef};
  assert.equal((await request(f,'lifecycle.correction.admission',previewInput,'reader')).status,403);
  const wrong=(await request(f,'lifecycle.instance.inspect',{instanceId:'one'})).result.instance.stages.scope.requestId;assert.equal((await request(f,'lifecycle.correction.admission',{stageRequestId:wrong,correctionRef},'executor')).error.code,'CORRECTION_SCOPE');
  if(!sameInputs){const inspected=await request(f,'lifecycle.correction.inspect',previewInput,'executor'),foreign=structuredClone(inspected.result.proposal);foreign.verificationBinding.rootRef='recovery-root:'+valueDigest('another-root');foreign.verificationBinding.rootDigest=valueDigest('another-root');delete foreign.digest;foreign.digest=valueDigest(foreign);const foreignRef='correction:'+foreign.digest,get=RuntimeStore.prototype.object,before=state.dispatches;
   try{RuntimeStore.prototype.object=function(project,kind,id){return project==='alpha'&&kind==='lifecycle-correction-proposal'&&id===foreignRef?structuredClone(foreign):get.call(this,project,kind,id);};const scoped=await request(f,'lifecycle.correction.admission',{stageRequestId:original.request.id,correctionRef:foreignRef},'executor');assert.equal(scoped.result.allowed,false);assert(scoped.result.reasons.includes('CORRECTION_SCOPE'));assert.equal(state.dispatches,before);}finally{RuntimeStore.prototype.object=get;}}
  const preview=await request(f,'lifecycle.correction.admission',previewInput,'executor');assert.equal(preview.status,200,JSON.stringify(preview));assert.equal(preview.result.allowed,!sameInputs,JSON.stringify(preview));assert.equal(preview.result.executionAuthorized,false);if(!sameInputs){assert.equal(preview.result.repairAdmission.instanceId,'two');assert.equal(preview.result.repairAdmission.stageId,'verification');}
  if(sameInputs){const before=state.dispatches,blocked=await execWrite(f,'lifecycle.stage.request',{instanceId:'two',stageId:'verification'});assert.equal(blocked.error.code,'REPAIR_ORIGIN_UNPROVEN');assert.equal(state.dispatches,before);assert.equal((await stageState(f,original.request.id)).result.progress.phase,'FAILED');return;}const rerun=await execute('two','verification');assert.equal(rerun.progress.phase,'COMPLETE');assert.equal(rerun.repairAdmission.schema,'runtime-stage-repair-admission/v2');assert(calls>=3);assert(Date.parse(rerun.request.deadlineAt)<=Date.parse(original.request.deadlineAt));assert.equal((await stageState(f,original.request.id)).result.progress.phase,'FAILED');
  const root=await recoveryView(f,'two');assert.equal(root.attempts.filter(r=>r.stageId==='verification').length,2);
 }finally{await f.server.close();f.cleanup();}
});
