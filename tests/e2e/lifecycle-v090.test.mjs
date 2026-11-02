import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadPublisherBase, verifyBaseDistribution, valueDigest } from '../../dist/lifecycle/base.js';
import { compileLifecycle } from '../../dist/lifecycle/compiler.js';
import { validateBindings } from '../../dist/lifecycle/bindings.js';
import { startRuntimeServer } from '../../dist/server/http.js';
import { initializeCredentials, tokenDigest } from '../../dist/server/security.js';
import { serviceMain } from '../../dist/server/cli.js';
import { pinInstance, stageAdmission, requestStage, recordStageOutcome, requiredChecksDigest, candidateDigest } from '../../dist/lifecycle/instance.js';
import { lifecycle, yaml, setPath, extension, syntheticBindings } from '../fixtures/lifecycle-v090.mjs';

const compile=data=>compileLifecycle(yaml(data),'alpha');
const codes=r=>r.issues.map(i=>i.code);
function fixture(){
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'runtime-v090-lifecycle-')),root=join(dir,'state'),tokens={};
  const principals=Object.entries({reader:['read'],editor:['read','draft.write'],activator:['read','definition.activate'],owner:['read','draft.write','definition.activate'],executor:['read','execution.request']}).map(([id,permissions])=>{tokens[id]=randomBytes(32).toString('hex');return{id,permissions,projects:['alpha'],revision:1,expiresAt:'2030-01-01T00:00:00Z',tokenDigest:tokenDigest(tokens[id])};});
  initializeCredentials(root,'synthetic',principals);
  return{dir,root,tokens,principals,options:{stateRoot:root,workspaceId:'synthetic'},cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
async function request(s,f,operation,input={},meta={},actor='owner'){
  const r=await fetch(s.url+'/api/v1/request',{method:'POST',headers:{authorization:'Bearer '+f.tokens[actor],'content-type':'application/json'},body:JSON.stringify({operation,projectId:'alpha',input,...meta})});
  return{status:r.status,...await r.json()};
}
const save=(s,f,source,id,rev)=>request(s,f,'lifecycle.draft.save',{yaml:source},{requestId:id,expectedRevision:rev});
const validate=(s,f,source,actor='owner')=>request(s,f,'lifecycle.definition.validate',{yaml:source},{},actor);
const activate=(s,f,source,digest,id,rev)=>request(s,f,'lifecycle.definition.save-and-activate',{yaml:source,validationDigest:digest},{requestId:id,expectedRevision:rev});

for(const provider of ['github','gitlab'])test('complete '+provider+' branch compiles; every applicable required field rejects missing and invalid values',()=>{
  const baseline=lifecycle(provider),good=compile(baseline);assert.equal(good.valid,true,JSON.stringify(good.issues));assert.equal(good.effective.nodes.length,8);
  let tested=0;
  for(const field of loadPublisherBase().base.fields.filter(f=>f.providers.includes(provider))){
    for(const variant of ['missing','invalid']){
      const changed=structuredClone(baseline);setPath(changed,field.path,variant==='missing'?undefined:null);
      const result=compile(changed);assert.equal(result.valid,false,field.path+' '+variant);assert.ok(result.issues.some(x=>x.path===field.path),field.path+' '+JSON.stringify(result.issues));tested++;
    }
  }
  assert.equal(tested,166); // 83 selected fields × two variants, per provider.
  setPath(baseline,'config.implementation.'+(provider==='github'?'pipelinePath':'workflowPath'),'other.yml');assert.ok(codes(compile(baseline)).includes('INACTIVE_PROVIDER_FIELD'));
});

test('publisher Base bytes are immutable; project cannot weaken stages or inherit another base',()=>{
  const manifest=readFileSync(new URL('../../lifecycle/base/manifest.json',import.meta.url)),base=readFileSync(new URL('../../lifecycle/base/software-release-0.9.0.json',import.meta.url));
  assert.throws(()=>verifyBaseDistribution(Buffer.concat([manifest,Buffer.from(' ')]),base),{code:'UNTRUSTED_BASE'});
  assert.throws(()=>verifyBaseDistribution(manifest,Buffer.concat([base,Buffer.from(' ')])),{code:'UNTRUSTED_BASE'});
  const trusted=loadPublisherBase();assert.ok(Object.isFrozen(trusted.base.stages));
  for(const modify of [d=>d.extends.version='latest',d=>d.extends.digest='sha256:'+'0'.repeat(64),d=>d.extends=[d.extends],d=>d.stages=[],d=>d.config.verification.optional=true,d=>d.assets.ontology.projectId='beta',d=>d.config.publication.channel='gitlab-release']){
    const d=lifecycle();modify(d);assert.equal(compile(d).valid,false);
  }
});

test('YAML rejects duplicate keys, aliases/tags, excess depth, unsafe objects and secrets without echoing values',()=>{
  for(const source of ['a: 1\na: 2\n','a: &value {}\nb: *value\n','a: !!str text\n','%YAML 1.1\n---\na: 1\n','__proto__: {}\n','a: '+ '['.repeat(40)+'0'+']'.repeat(40), 'token: TOP_SECRET_SYNTHETIC_ONLY']){
    const r=compileLifecycle(source,'alpha');assert.equal(r.valid,false);assert.ok(r.issues.length);assert.ok(!JSON.stringify(r.issues).includes('TOP_SECRET_SYNTHETIC_ONLY'));
  }
});

test('all four slots add mandatory AND dependencies and preserve every Base check',()=>{
  const d=lifecycle(),base=loadPublisherBase().base;
  d.extensions=Object.keys(base.slots).flatMap((slot,i)=>[extension('a'+i,slot),extension('b'+i,slot,['project.a'+i])]);
  const c=compile(d);assert.equal(c.valid,true,JSON.stringify(c.issues));
  for(const [slot,spec] of Object.entries(base.slots)){
    const successor=c.effective.nodes.find(n=>n.id===spec.successor),extensions=d.extensions.filter(e=>e.slot===slot);
    for(const e of extensions)assert.ok(successor.dependsOn.includes(e.id));assert.ok(successor.dependsOn.includes(spec.predecessor));
  }
  for(const stage of base.stages)for(const check of stage.checks)assert.ok(c.effective.nodes.find(n=>n.id===stage.id).checks.includes(check));
});

test('extension DAG rejects cycles, cross-slot bypasses, arbitrary actions, code, scope and budget expansion',()=>{
  const variants=[d=>d.extensions[0].dependsOn=['project.a'],d=>{d.extensions.push(extension('b','before-candidate'));d.extensions[0].dependsOn=['project.b'];},d=>d.extensions[0].actionRef='shell.exec',d=>d.extensions[0].actionDigest='sha256:'+'f'.repeat(64),d=>d.extensions[0].parameters.command='rm -rf /',d=>d.extensions[0].scopeRef='scope:beta',d=>d.extensions[0].budget.maxAttempts=99,d=>d.extensions[0].optional=true,d=>d.extensions.push(structuredClone(d.extensions[0])),d=>d.extensions[0].dependsOn=['candidate'],d=>{d.extensions=[extension('a','candidate-checks',[],'operation')];}];
  for(const modify of variants){const d=lifecycle();d.extensions=[extension('a')];modify(d);assert.equal(compile(d).valid,false);}
});

test('comments, ordering and layout do not change execution semantics; changed rules do',()=>{
  const d=lifecycle();d.extensions=[extension('b'),extension('a')];const a=compile(d);
  d.extensions.reverse();d.presentation={label:'测试项目',notes:'Operator explanation',layout:{scope:{x:10,y:20}}};
  const b=compileLifecycle('# preserved comment\n'+yaml(d),'alpha');assert.equal(b.valid,true);assert.equal(a.effective.semanticDigest,b.effective.semanticDigest);assert.notEqual(a.sourceDigest,b.sourceDigest);assert.notEqual(a.presentationDigest,b.presentationDigest);
  d.config.plan.budget.timeoutSeconds=2;assert.notEqual(compile(d).effective.semanticDigest,b.effective.semanticDigest);
});

test('binding verification fails closed on missing, partial, stale, mismatched and timed-out adapter evidence',async()=>{
  const definition=compile(lifecycle()).effective,f=fixture(),actor=f.principals[3];
  try{
    assert.equal((await validateBindings(definition,actor)).ready,false);
    const b=syntheticBindings();assert.equal((await validateBindings(definition,actor,b.provider)).ready,true);
    for(const change of [rows=>rows.slice(1),rows=>rows.map((r,i)=>i? r:{...r,inputDigest:'sha256:'+'0'.repeat(64)}),rows=>rows.map(r=>({...r,expiresAt:'2000-01-01T00:00:00Z'})),rows=>rows.map(r=>({...r,status:'UNKNOWN'})),rows=>rows.map(r=>({...r,token:'SYNTHETIC_SECRET_MUST_NOT_ESCAPE'}))]){
      const rejected=await validateBindings(definition,actor,async(...args)=>change(await b.provider(...args)));
      assert.equal(rejected.ready,false);assert.deepEqual(rejected.checks,[]);assert.ok(!JSON.stringify(rejected).includes('SYNTHETIC_SECRET_MUST_NOT_ESCAPE'));
    }
    let aborted=false;
    const result=await validateBindings(definition,actor,async(_d,_p,_r,signal)=>new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve([]);})),Date.now(),20);
    assert.equal(result.ready,false);assert.equal(aborted,true);
  }finally{f.cleanup();}
});

test('real HTTP draft, preview and activation preserve exact YAML, receipts and active revision across restart',async()=>{
  const f=fixture(),b=syntheticBindings();let s=await startRuntimeServer(f.options,b.provider);
  try{
    const source='# human comment\n'+yaml(lifecycle());
    const saved=await save(s,f,source,'save-1',0);assert.equal(saved.status,200);assert.equal(saved.result.result.status,'DRAFT');
    const preview=await validate(s,f,source);assert.equal(preview.result.ready,true);
    const enabled=await activate(s,f,source,preview.result.validationDigest,'activate-1',1);assert.equal(enabled.result.result.status,'ACTIVE');assert.equal(enabled.result.result.executionAuthorized,false);assert.equal(enabled.result.result.releaseAuthorized,false);
    const activeId=enabled.result.result.activeRevisionId;
    const restored=await request(s,f,'lifecycle.definition.source.read',{revisionId:activeId});assert.equal(Buffer.from(restored.result.data,'base64').toString(),source);
    const count=b.state.calls;assert.deepEqual((await activate(s,f,source,preview.result.validationDigest,'activate-1',1)).result,enabled.result);assert.equal(b.state.calls,count);
    const invalid='projectId: alpha\n';const blocked=await activate(s,f,invalid,null,'blocked-1',2);assert.equal(blocked.result.result.status,'BLOCKED');assert.equal(blocked.result.result.activeRevisionId,activeId);
    await s.close();s=await startRuntimeServer(f.options,b.provider);
    const state=await request(s,f,'lifecycle.definition.inspect');assert.equal(state.result.active.id,activeId);assert.notEqual(state.result.draft.id,activeId);assert.equal(state.result.revision,3);
    const conflict=await save(s,f,source,'stale-save',0);assert.equal(conflict.status,409);assert.equal(conflict.error.code,'REVISION_CONFLICT');
    const receipt=await request(s,f,'runtime.receipt.read',{requestId:'activate-1'});assert.deepEqual(receipt.result,enabled.result);
  }finally{await s.close();f.cleanup();}
});

test('definition activation needs exact fresh binding preview and cannot use a different principal preview',async()=>{
  const f=fixture(),b=syntheticBindings(),s=await startRuntimeServer(f.options,b.provider);
  try{
    const source=yaml(lifecycle()),preview=await validate(s,f,source);b.state.revision='synthetic-2';
    const stale=await activate(s,f,source,preview.result.validationDigest,'stale-binding',0);assert.equal(stale.result.result.status,'BLOCKED');assert.ok(stale.result.result.issues.some(i=>i.code==='VALIDATION_STALE'));
    const readerPreview=await validate(s,f,source,'reader');const other=await activate(s,f,source,readerPreview.result.validationDigest,'other-preview',1);assert.equal(other.result.result.status,'BLOCKED');
    assert.equal((await request(s,f,'lifecycle.draft.save',{yaml:source},{requestId:'reader-save',expectedRevision:2},'reader')).status,403);
    assert.equal((await request(s,f,'lifecycle.definition.save-and-activate',{yaml:source,validationDigest:null},{requestId:'editor-enable',expectedRevision:2},'editor')).status,403);
    assert.equal((await request(s,f,'lifecycle.definition.save-and-activate',{yaml:source,validationDigest:null},{requestId:'activator-save',expectedRevision:2},'activator')).status,403);
  }finally{await s.close();f.cleanup();}
});

test('revoking authority during binding verification rolls back the write; no configured adapter cannot activate',async()=>{
  const f=fixture(),b=syntheticBindings();let s=await startRuntimeServer(f.options);
  try{
    const source=yaml(lifecycle()),blocked=await activate(s,f,source,null,'missing-adapter',0);assert.equal(blocked.result.result.status,'BLOCKED');
    await s.close();s=await startRuntimeServer(f.options,b.provider);
    const preview=await validate(s,f,source);b.state.during=async()=>{const path=join(f.root,'auth.json'),auth=JSON.parse(readFileSync(path));auth.principals.find(p=>p.id==='owner').permissions=['read'];writeFileSync(path,JSON.stringify(auth));};
    const revoked=await activate(s,f,source,preview.result.validationDigest,'revoked-1',1);assert.equal(revoked.status,403);
    const inspected=await request(s,f,'lifecycle.definition.inspect');assert.equal(inspected.result.revision,1);assert.equal(inspected.result.active,null);
  }finally{await s.close();f.cleanup();}
});

test('MCP read tool cannot smuggle a write even with editor permissions; explicit write uses the same durable API',async()=>{
  const f=fixture(),s=await startRuntimeServer(f.options),client=new Client({name:'synthetic-lifecycle-client',version:'1'});
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL(s.url+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+f.tokens.owner}}}));
    const args={operation:'lifecycle.draft.save',projectId:'alpha',input:{yaml:yaml(lifecycle())},requestId:'mcp-save',expectedRevision:0};
    const bad=await client.callTool({name:'runtime_read',arguments:args});assert.equal(bad.isError,true);assert.equal(JSON.parse(bad.content[0].text).error.code,'UNKNOWN_TOOL');
    const good=await client.callTool({name:'runtime_write',arguments:args});assert.equal(JSON.parse(good.content[0].text).result.result.status,'DRAFT');
    const state=await request(s,f,'lifecycle.definition.inspect');assert.equal(state.result.revision,1);
  }finally{await client.close();await s.close();f.cleanup();}
});

test('CLI request only forwards a protected exact envelope and uses service authority and receipt state',async()=>{
  const f=fixture(),s=await startRuntimeServer(f.options);
  try{
    const tokenRef=join(f.dir,'client.json'),requestRef=join(f.dir,'request.json');
    writeFileSync(tokenRef,JSON.stringify({schema:'runtime-client-credential/v1',workspaceId:'synthetic',principalId:'editor',projectId:'alpha',token:f.tokens.editor}),{mode:0o600});
    const envelope={operation:'lifecycle.draft.save',projectId:'alpha',input:{yaml:yaml(lifecycle())},requestId:'cli-save',expectedRevision:0};
    writeFileSync(requestRef,JSON.stringify(envelope),{mode:0o600});
    const args=['request','--url',s.url,'--token-ref',tokenRef,'--project','alpha','--request-ref',requestRef];
    let text='';const output={write:value=>text+=value};
    assert.equal(await serviceMain(args,output),0);assert.equal(JSON.parse(text).result.result.status,'DRAFT');assert.ok(!text.includes(f.tokens.editor));
    writeFileSync(requestRef,JSON.stringify({...envelope,operation:'lifecycle.definition.save-and-activate',input:{...envelope.input,validationDigest:null},requestId:'cli-denied',expectedRevision:1}));text='';
    assert.equal(await serviceMain(args,output),1);assert.equal(JSON.parse(text).error.code,'FORBIDDEN');
    writeFileSync(requestRef,JSON.stringify({...envelope,projectId:'beta'}));text='';assert.equal(await serviceMain(args,output),1);assert.equal(JSON.parse(text).error.code,'CREDENTIAL_SCOPE');
    const state=await request(s,f,'lifecycle.definition.inspect');assert.equal(state.result.revision,1);assert.equal(state.result.active,null);
  }finally{await s.close();f.cleanup();}
});

function pinned(extensions=[]){
  const d=lifecycle();for(const stage of ['plan','verification'])d.config[stage].budget={timeoutSeconds:600,maxAttempts:2,maxConcurrency:2,maxLoops:1};d.extensions=extensions;
  const definition=compile(d).effective,revisionId=valueDigest({syntheticRevision:true,source:yaml(d)}),now=Date.now();
  const authority={projectId:'alpha',instanceId:'synthetic-instance',definitionRevisionId:revisionId,semanticDigest:definition.semanticDigest,goalRef:'synthetic:goal/one',targetRef:'synthetic:target/one',loopRef:'synthetic:loop/one',requirementsDigest:requiredChecksDigest(definition),budget:{timeoutSeconds:600,maxAttempts:2,maxConcurrency:2,maxLoops:1},evidenceRef:'synthetic:authority/one',revision:'1',expiresAt:new Date(now+3600000).toISOString()};
  return{definition,authority,context:{authority,bindingsCurrent:true,now},instance:pinInstance('synthetic-instance',revisionId,definition,authority,now)};
}
const candidate=()=>({schema:'runtime-candidate/v1',version:'0.9.0-beta.1',profile:'candidate-verification',sourceDigest:valueDigest('synthetic-source'),buildDigest:valueDigest('synthetic-build'),artifacts:[{name:'synthetic.tgz',digest:valueDigest('synthetic-bytes'),bytes:64}]});
function observed(instance,id,changes={}){const state=instance.stages[id];return{requestId:state.requestId,inputDigest:state.inputDigest,receiptRef:'synthetic:receipt/'+state.requestId,status:'COMPLETE',expiresAt:new Date(Date.now()+3600000).toISOString(),checks:instance.definition.nodes.find(n=>n.id===id).checks.map(check=>({id:check,status:'PASS',evidenceRef:'synthetic:check/'+check})),...changes};}
function pass(instance,id,context,extra={}){const requested=requestStage(instance,id,'synthetic-request-'+id,context);return recordStageOutcome(requested,id,observed(requested,id,extra),context.now);}

test('instance pins are independent of later YAML edits and enforce exact authority/requirements',()=>{
  const f=pinned([extension('review')]),before=JSON.stringify(f.instance);
  f.definition.semantic.extensions=[];assert.equal(JSON.stringify(f.instance),before);assert.ok(f.instance.definition.nodes.some(n=>n.id==='project.review'));assert.ok(Object.isFrozen(f.instance.pins));
  const other=pinned();assert.throws(()=>pinInstance('other',other.instance.pins.definitionRevisionId,other.definition,{...other.authority,requirementsDigest:valueDigest([])}),{code:'AUTHORITY_MISMATCH'});
  const forged=structuredClone(f.instance);forged.definition.nodes.pop();assert.throws(()=>stageAdmission(forged,'scope',f.context),{code:'CORRUPT_INSTANCE'});
  assert.ok(stageAdmission(f.instance,'scope',{...f.context,authority:null}).reasons.includes('AUTHORITY_REQUIRED'));
  assert.ok(stageAdmission(f.instance,'scope',{...f.context,bindingsCurrent:false}).reasons.includes('BINDINGS_NOT_CURRENT'));
});

test('AND stage admission waits for every extension branch and refuses failed, unknown or absent evidence',()=>{
  const f=pinned([extension('a'),extension('b')]);let i=pass(f.instance,'scope',f.context);i=pass(i,'plan',f.context);
  i=pass(i,'project.a',f.context);
  assert.ok(stageAdmission(i,'implementation',f.context).reasons.includes('PREDECESSOR_NOT_PASSED:project.b'));
  i=requestStage(i,'project.b','branch-b',f.context);
  assert.throws(()=>recordStageOutcome(i,'project.b',observed(i,'project.b',{checks:[]})),{code:'CHECKS_NOT_PASSED'});
  i=recordStageOutcome(i,'project.b',observed(i,'project.b',{status:'UNKNOWN',checks:[]}));
  assert.ok(stageAdmission(i,'project.b',f.context).reasons.includes('RECONCILE_ORIGINAL_REQUEST'));
  assert.throws(()=>requestStage(i,'project.b','blind-retry',f.context),{code:'STAGE_BLOCKED'});
  assert.throws(()=>recordStageOutcome(i,'project.b',{...observed(i,'project.b'),requestId:'new-request'}),{code:'RECEIPT_MISMATCH'});
  const result=observed(i,'project.b');i=recordStageOutcome(i,'project.b',result);
  assert.equal(recordStageOutcome(i,'project.b',result),i);assert.equal(stageAdmission(i,'implementation',f.context).allowed,true);
  assert.throws(()=>recordStageOutcome(i,'project.b',{...result,status:'UNKNOWN'}),{code:'STAGE_OUTCOME_CONFLICT'});
});

test('bounded attempts and elapsed budget cannot be reset by a new request or an amended authority',()=>{
  const f=pinned();let i=requestStage(f.instance,'scope','try-one',f.context);
  i=recordStageOutcome(i,'scope',observed(i,'scope',{status:'FAILED',checks:[]}));
  assert.throws(()=>requestStage(i,'scope','try-one',f.context),{code:'REQUEST_CONFLICT'});
  i=requestStage(i,'scope','try-two',f.context);i=recordStageOutcome(i,'scope',observed(i,'scope',{status:'FAILED',checks:[]}));
  assert.ok(stageAdmission(i,'scope',f.context).reasons.includes('ATTEMPT_BUDGET_EXHAUSTED'));
  assert.ok(stageAdmission(f.instance,'scope',{...f.context,now:f.context.now+600001}).reasons.includes('INSTANCE_TIME_BUDGET_EXHAUSTED'));
  assert.ok(stageAdmission(f.instance,'scope',{...f.context,authority:{...f.authority,revision:'2'}}).reasons.includes('AUTHORITY_STALE'));
});

test('candidate validation requires immutable artifacts, not RC naming; publication needs its own exact authority',()=>{
  const f=pinned();let i=f.instance;
  for(const id of ['scope','plan','implementation'])i=pass(i,id,f.context);
  assert.ok(stageAdmission(i,'verification',f.context).reasons.includes('CANDIDATE_REQUIRED'));
  i=requestStage(i,'candidate','make-candidate',f.context);
  assert.throws(()=>recordStageOutcome(i,'candidate',observed(i,'candidate')),{code:'CANDIDATE_REQUIRED'});
  assert.throws(()=>candidateDigest({...candidate(),version:'0.9.0-rc.1',artifacts:[]}),{code:'INVALID_CANDIDATE'});
  i=recordStageOutcome(i,'candidate',observed(i,'candidate',{candidate:candidate()}));
  const fixed=i.candidateDigest;assert.equal(stageAdmission(i,'verification',f.context).allowed,true);
  i=requestStage(i,'verification','verify-candidate',f.context);
  assert.throws(()=>recordStageOutcome(i,'verification',observed(i,'verification',{candidate:candidate()})),{code:'CANDIDATE_MUTATION'});
  assert.throws(()=>recordStageOutcome(i,'verification',observed(i,'verification',{inputDigest:valueDigest('other-source')})),{code:'RECEIPT_MISMATCH'});
  i=recordStageOutcome(i,'verification',observed(i,'verification'));i=pass(i,'release-decision',f.context);
  assert.ok(stageAdmission(i,'publication',f.context).reasons.includes('EXACT_RELEASE_AUTHORITY_REQUIRED'));
  const releaseAuthority={projectId:'alpha',instanceId:i.id,pinsDigest:i.pinsDigest,definitionRevisionId:i.pins.definitionRevisionId,requirementsDigest:i.pins.requirementsDigest,semanticDigest:i.pins.semanticDigest,candidateDigest:fixed,channel:'github-release',decisionRef:'synthetic:release-decision/one',expiresAt:f.authority.expiresAt};
  assert.equal(stageAdmission(i,'publication',{...f.context,releaseAuthority}).allowed,true);
  assert.ok(stageAdmission(i,'publication',{...f.context,releaseAuthority:{...releaseAuthority,candidateDigest:valueDigest('other-candidate')}}).reasons.includes('EXACT_RELEASE_AUTHORITY_REQUIRED'));
  i=pass(i,'publication',{...f.context,releaseAuthority});i=pass(i,'closure',f.context);assert.equal(Object.values(i.stages).every(s=>s.status==='PASSED'),true);assert.equal(i.candidateDigest,fixed);
});

test('HTTP instance creation has separate authority, pins old definition, persists on restart and never dispatches',async()=>{
  const f=fixture(),bindings=syntheticBindings();let currentAuthority=null,authorityReads=0;
  const resolver=async ref=>{authorityReads++;return currentAuthority?.evidenceRef===ref?currentAuthority:null;};
  let s=await startRuntimeServer(f.options,bindings.provider,resolver);
  try{
    const p=pinned(),source=yaml(p.definition.semantic),preview=await validate(s,f,source);
    const enabled=await activate(s,f,source,preview.result.validationDigest,'instance-definition',0),revisionId=enabled.result.result.activeRevisionId;
    currentAuthority={...p.authority,instanceId:'http-instance',definitionRevisionId:revisionId};
    const input={instanceId:'http-instance',definitionRevisionId:revisionId,authorityRef:currentAuthority.evidenceRef},meta={requestId:'create-instance',expectedRevision:1};
    assert.equal((await request(s,f,'lifecycle.instance.create',input,meta)).status,403,'definition owner is not an executor');
    const created=await request(s,f,'lifecycle.instance.create',input,meta,'executor');assert.equal(created.status,200,JSON.stringify(created));assert.equal(created.result.result.executionDispatched,false);
    const reads=authorityReads;assert.deepEqual((await request(s,f,'lifecycle.instance.create',input,meta,'executor')).result,created.result);assert.equal(authorityReads,reads);
    const initial=await request(s,f,'lifecycle.instance.inspect',{instanceId:input.instanceId});assert.equal(initial.result.instance.requestIds.length,0);assert.ok(Object.values(initial.result.instance.stages).every(x=>x.status==='PENDING'));
    const changed=lifecycle();changed.config.plan.budget.timeoutSeconds=2;const nextSource=yaml(changed),nextPreview=await validate(s,f,nextSource);
    const newDefinition=await activate(s,f,nextSource,nextPreview.result.validationDigest,'new-definition',2);assert.equal(newDefinition.result.result.status,'ACTIVE');
    assert.notEqual(newDefinition.result.result.activeRevisionId,revisionId);
    await s.close();s=await startRuntimeServer(f.options,bindings.provider,resolver);
    const restored=await request(s,f,'lifecycle.instance.inspect',{instanceId:input.instanceId});assert.deepEqual(restored.result.instance,initial.result.instance);
    const admission=await request(s,f,'lifecycle.stage.admission',{instanceId:input.instanceId,stageId:'scope'},{},'executor');assert.equal(admission.result.allowed,true);assert.equal(admission.result.executionDispatched,false);
    bindings.state.mode='unknown';const invalid=await request(s,f,'lifecycle.stage.admission',{instanceId:input.instanceId,stageId:'scope'},{},'executor');assert.equal(invalid.result.allowed,false);assert.ok(invalid.result.reasons.includes('BINDINGS_NOT_CURRENT'));
    assert.equal((await request(s,f,'lifecycle.instance.create',input,{requestId:'create-from-old-definition',expectedRevision:3},'executor')).error.code,'DEFINITION_NOT_ACTIVE');
  }finally{await s.close();f.cleanup();}
});
