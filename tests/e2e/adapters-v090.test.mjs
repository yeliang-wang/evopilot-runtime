import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownerDistributionIdentity, verifyOwnerDistribution, openPublishedOwner, ownerRequestDigest, verifyReadinessView } from '../../dist/adapters/published-owners.js';
import { createHash } from 'node:crypto';
import { validatePlatformRegistration, readIntegrationConfiguration, configuredPlatform, readPlatformToken } from '../../dist/adapters/config.js';
import { githubClient } from '../../dist/adapters/github.js';
import { gitlabClient } from '../../dist/adapters/gitlab.js';
import { fileBytes, platformReader } from '../../dist/adapters/platforms.js';
import { syntheticReadinessMaterial, lifecycleBindingExample } from '../fixtures/adapters-v090.mjs';
import { nativeSha256 } from '../../vendor/compatibility/v1/native.mjs';
import { READINESS_STANDARD_DIGEST, noReconstruction } from '../../vendor/compatibility/usability/v2/contract.mjs';
import { createRegisteredBindings, openRegisteredBindings } from '../../dist/adapters/bindings.js';
import { compileLifecycle } from '../../dist/lifecycle/compiler.js';
import { validateBindings } from '../../dist/lifecycle/bindings.js';
import { valueDigest } from '../../dist/lifecycle/base.js';
import { yaml } from '../fixtures/lifecycle-v090.mjs';
import { inspectExternalAgent } from '../../dist/adapters/external-agent.js';

function fixture(){const dir=mkdtempSync(join(realpathSync(tmpdir()),'runtime-owner-boundary-'));return{dir,cleanup:()=>rmSync(dir,{recursive:true,force:true})};}
test('supported owner distribution metadata pins GitHub release packages and production dependency installations',()=>{
  const ontology=ownerDistributionIdentity('ontology'),harness=ownerDistributionIdentity('harness');
  assert.equal(ontology.version,'0.8.3');assert.equal(harness.version,'0.8.3');assert.equal(ontology.files,1075);assert.equal(harness.files,496);
  assert.equal(ontology.packageDigest,'sha256:acc195f006aeeadb0ad8e01121ef258ab2b171c7a6b48a01b424beae8ddc345b');
  assert.equal(harness.packageDigest,'sha256:24be3cb65c8b7dbe07d4970730cece928c9cac1a31a08a0359a4ca4560f64dc6');
  assert.notEqual(ontology.distributionDigest,harness.distributionDigest);
  assert.throws(()=>ownerDistributionIdentity('arbitrary-provider'),{code:'UNSUPPORTED_OWNER'});
});

test('a claimed owner version or partial source tree cannot replace the verified published package',()=>{
  const f=fixture();try{
    writeFileSync(join(f.dir,'package.json'),JSON.stringify({name:'@evopilot-next/ontology',version:'0.8.3'}));
    assert.throws(()=>verifyOwnerDistribution('ontology',f.dir),{code:'OWNER_DISTRIBUTION_CHANGED'});
    rmSync(join(f.dir,'package.json'));assert.throws(()=>verifyOwnerDistribution('ontology',f.dir),{code:'OWNER_DISTRIBUTION_CHANGED'});
    writeFileSync(join(f.dir,'arbitrary-provider.js'),'throw new Error("must not load");');assert.throws(()=>verifyOwnerDistribution('harness',f.dir),{code:'OWNER_DISTRIBUTION_CHANGED'});
  }finally{f.cleanup();}
});

test('linked and writable distribution roots are rejected',()=>{
  const f=fixture();try{
    const root=join(f.dir,'package'),link=join(f.dir,'link');mkdirSync(root);symlinkSync(root,link);
    assert.throws(()=>verifyOwnerDistribution('ontology',link),{code:'UNTRUSTED_OWNER_PATH'});
    chmodSync(root,0o777);assert.throws(()=>verifyOwnerDistribution('ontology',root),{code:'UNTRUSTED_OWNER_PATH'});
  }finally{f.cleanup();}
});

test('owner consumer refuses unverified code before import and never creates a missing owner workspace',async()=>{
  const f=fixture();try{
    const workspaceRoot=join(f.dir,'workspace'),packageRoot=join(f.dir,'package'),marker=join(f.dir,'IMPORTED');
    mkdirSync(workspaceRoot);writeFileSync(join(workspaceRoot,'workspace.json'),'{}');mkdirSync(join(workspaceRoot,'state/ontology'),{recursive:true});writeFileSync(join(workspaceRoot,'state/ontology/ontology.db'),'');
    mkdirSync(join(packageRoot,'dist'),{recursive:true});writeFileSync(join(packageRoot,'dist/service.js'),"import {writeFileSync} from 'node:fs'; writeFileSync("+JSON.stringify(marker)+",'executed');");
    const config={owner:'ontology',packageRoot,workspaceRoot,workspaceId:'test',projects:['alpha']};
    await assert.rejects(()=>openPublishedOwner(config),{code:'OWNER_DISTRIBUTION_CHANGED'});assert.equal(existsSync(marker),false);
    await assert.rejects(()=>openPublishedOwner({...config,workspaceRoot:join(f.dir,'absent')}));assert.equal(existsSync(join(f.dir,'absent')),false);
    await assert.rejects(()=>openPublishedOwner({...config,importPath:'arbitrary.js'}),{code:'INVALID_FIELDS'});
  }finally{f.cleanup();}
});

test('owner mutation permit digest fixes owner, scope, input, request ID and owner CAS revision',()=>{
  const r={operation:'native.package.validate',scope:{projectId:'alpha',visibility:'private'},input:{id:'package',version:'1.0.0'},requestId:'exact',expectedRevision:4},d=ownerRequestDigest('ontology',r);
  for(const changed of [{...r,scope:{...r.scope,projectId:'beta'}},{...r,input:{...r.input,version:'2.0.0'}},{...r,requestId:'blind-retry'},{...r,expectedRevision:5}])assert.notEqual(ownerRequestDigest('ontology',changed),d);
  assert.notEqual(ownerRequestDigest('harness',r),d);assert.equal(ownerRequestDigest('ontology',structuredClone(r)),d);
});

const actor={id:'fixture',projects:['alpha'],permissions:['read'],revision:1,expiresAt:'2030-01-01T00:00:00Z'};
function platform(provider='github'){
  return{ref:'binding:alpha/platform',workspaceId:'test',projectId:'alpha',provider,host:provider==='github'?'https://github.com':'https://gitlab.example.test',repository:'synthetic/project',repositoryId:'42',defaultBranch:'main',credentialRef:'credential:alpha/platform',revision:1,expiresAt:'2030-01-01T00:00:00Z',...(provider==='github'?{workflowPath:'.github/workflows/test.yml',runner:'ubuntu-latest'}:{pipelinePath:'.gitlab-ci.yml',runner:'56'})};
}
function configFixture(provider='github'){
  const f=fixture(),p=platform(provider),tokenFile=join(f.dir,'token'),path=join(f.dir,'integrations.json');
  writeFileSync(tokenFile,'synthetic-token-0123456789',{mode:0o600});
  const config={schema:'runtime-integrations/v1',workspaceId:'test',revision:1,platforms:[p],credentials:[{ref:p.credentialRef,workspaceId:'test',projectId:'alpha',provider,host:p.host,tokenFile,revision:1,expiresAt:p.expiresAt}],owners:[]};
  const save=()=>writeFileSync(path,JSON.stringify(config),{mode:0o600});save();return{...f,p,path,tokenFile,config,save};
}
test('protected configuration rejects cross-scope, duplicates, unknown providers, code and inline secrets',()=>{
  const f=configFixture();try{
    const c=readIntegrationConfiguration(f.path,'test');assert.equal(c.platforms[0].repositoryId,'42');assert(Object.isFrozen(c.platforms[0]));
    assert.throws(()=>readIntegrationConfiguration(f.path,'other'),{code:'INTEGRATION_SCOPE'});
    for(const [mutate,code] of [[c=>c.credentials[0].projectId='beta','CREDENTIAL_SCOPE'],[c=>c.credentials[0].host='https://other.test','UNSUPPORTED_PLATFORM_HOST']]){const copy=structuredClone(f.config);mutate(copy);writeFileSync(f.path,JSON.stringify(copy));assert.throws(()=>readIntegrationConfiguration(f.path,'test'),{code});}
    const copy=structuredClone(f.config);copy.platforms.push({...copy.platforms[0]});writeFileSync(f.path,JSON.stringify(copy));assert.throws(()=>readIntegrationConfiguration(f.path,'test'),{code:'DUPLICATE_REGISTRATION'});
    for(const extra of [{token:'synthetic-token'},{importPath:'/tmp/evil.js'},{callback:'execute'},{apiUrl:'https://attacker.test'}]){writeFileSync(f.path,JSON.stringify({...f.config,...extra}));assert.throws(()=>readIntegrationConfiguration(f.path,'test'),{code:'INVALID_FIELDS'});}
    for(const p of [{...f.p,provider:'custom'},{...f.p,host:'http://github.com'},{...f.p,host:'https://github.com/path'},{...f.p,repository:'../escape'},{...f.p,workflowPath:'.github/workflows/../outside.yml'},{...f.p,pipelinePath:'.gitlab-ci.yml'}])assert.throws(()=>validatePlatformRegistration(p));
  }finally{f.cleanup();}
});
test('configuration and credential access checks ownership, symlinks, scope, revocation, expiry and exact current registration',()=>{
  const f=configFixture();try{
    const c=readIntegrationConfiguration(f.path,'test'),p=configuredPlatform(c,actor,'alpha',f.p.ref);
    assert.equal(readPlatformToken(f.path,p,actor),'synthetic-token-0123456789');
    assert.throws(()=>configuredPlatform(c,actor,'beta',p.ref),{code:'FORBIDDEN'});
    assert.throws(()=>readPlatformToken(f.path,p,{...actor,permissions:[]}),{code:'FORBIDDEN'});
    f.config.platforms[0].revision=2;f.save();assert.throws(()=>readPlatformToken(f.path,p,actor),{code:'PLATFORM_BINDING_CHANGED'});
    f.config.platforms[0].revision=1;f.config.credentials[0].expiresAt='2020-01-01T00:00:00Z';f.save();assert.throws(()=>readPlatformToken(f.path,p,actor),{code:'CREDENTIAL_EXPIRED'});
    f.config.credentials[0].expiresAt=p.expiresAt;f.save();chmodSync(f.tokenFile,0o644);assert.throws(()=>readPlatformToken(f.path,p,actor),{code:'UNSAFE_PLATFORM_CREDENTIAL'});chmodSync(f.tokenFile,0o600);
    const link=join(f.dir,'link');symlinkSync(f.tokenFile,link);f.config.credentials[0].tokenFile=link;f.save();assert.throws(()=>readPlatformToken(f.path,p,actor),{code:'UNSAFE_PLATFORM_CREDENTIAL'});
    chmodSync(f.path,0o644);assert.throws(()=>readIntegrationConfiguration(f.path,'test'),{code:'UNSAFE_STATE'});
  }finally{f.cleanup();}
});

// Network doubles here establish parser/error boundaries only. Real provider
// observations are retained separately; these tests never claim live CI E2E.
const commit='a'.repeat(40),wrongCommit='b'.repeat(40),content=Buffer.from('name: Synthetic\non: workflow_dispatch\njobs:\n  fixture:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo synthetic\n');
const contentDigest=createHash('sha256').update(content).digest('hex');
const blob=createHash('sha1').update(Buffer.from('blob '+content.length+'\0')).update(content).digest('hex');
const json=v=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});
function responses(provider){
  const p=platform(provider),base=provider==='github'?'https://api.github.com/repos/synthetic/project':'https://gitlab.example.test/api/v4/projects/42';
  const repository={id:42,default_branch:'main',archived:false,...(provider==='github'?{full_name:p.repository}:{path_with_namespace:p.repository,jobs_enabled:true,ci_config_path:null})};
  const routes=new Map([[base,repository]]);
  if(provider==='github'){
    routes.set(base+'/branches/main',{name:'main',commit:{sha:commit}});
    routes.set(base+'/actions/workflows/test.yml',{id:11,path:p.workflowPath,state:'active'});
    routes.set(base+'/contents/'+p.workflowPath+'?ref='+commit,{type:'file',path:p.workflowPath,encoding:'base64',content:content.toString('base64').match(/.{1,20}/g).join('\n')+'\n',size:content.length,sha:blob});
    routes.set(base+'/actions/runs/23',{id:23,repository:{id:42},head_sha:commit,head_branch:'main',path:p.workflowPath});
    routes.set(base+'/actions/jobs/24',{id:24,run_id:23,head_sha:commit,status:'completed',conclusion:'success',runner_id:25,labels:['ubuntu-latest']});
  }else{
    routes.set(base+'/repository/branches/main',{name:'main',commit:{id:commit}});
    routes.set(base+'/repository/files/.gitlab-ci.yml?ref='+commit,{file_path:p.pipelinePath,encoding:'base64',content:content.toString('base64'),size:content.length,commit_id:commit,content_sha256:contentDigest});
    routes.set(base+'/runners?per_page=100&page=1',[{id:56,active:true,paused:false,online:true,status:'online'}]);
    routes.set(base+'/pipelines/23',{id:23,project_id:42,sha:commit,ref:'main'});
    routes.set(base+'/jobs/24',{id:24,pipeline:{id:23},commit:{id:commit},runner:{id:56},status:'success'});
  }
  return{p,base,routes};
}
async function withNetwork(provider,run){
  const old=globalThis.fetch,f=responses(provider),calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,options});assert.equal(options.redirect,'error');assert.equal(options.method,undefined);const v=f.routes.get(url);assert(v!==undefined,'Unexpected URL '+url);return v instanceof Response?v:json(v);};
  const client=(provider==='github'?githubClient:gitlabClient)(f.p,async()=> 'synthetic-token-0123456789');
  try{await run({...f,client,calls});}finally{globalThis.fetch=old;}
}
for(const provider of ['github','gitlab']){
  test(provider+' readiness binds exact repository, commit and hashed workflow without claiming execution',()=>withNetwork(provider,async f=>{
    const result=await f.client.readiness(actor,AbortSignal.timeout(5000));
    assert.equal(result.commit,commit);assert.equal(result.workflowDigest,'sha256:'+contentDigest);assert.equal(result.executionAuthorized,false);assert.equal(result.workflowExecuted,false);
    assert.equal(JSON.stringify(result).includes('synthetic-token'),false);
    f.routes.get(f.base).id=43;await assert.rejects(()=>f.client.readiness(actor,AbortSignal.timeout(5000)),{code:'PLATFORM_IDENTITY_CHANGED'});
  }));
  test(provider+' job observations bind exact run/job/source and treat skipped, unknown and pending as non-passing',()=>withNetwork(provider,async f=>{
    const signal=()=>AbortSignal.timeout(5000),path=f.base+(provider==='github'?'/actions/jobs/24':'/jobs/24'),job=f.routes.get(path);
    assert.equal((await f.client.job(actor,'23','24',commit,signal())).status,'PASSED');
    const statuses=provider==='github'?['skipped','neutral','failure']:['skipped','canceled','failed'];
    for(const status of statuses){if(provider==='github')job.conclusion=status;else job.status=status;const r=await f.client.job(actor,'23','24',commit,signal());assert.equal(r.status,'FAILED');assert.equal(r.lifecycleAcceptance,false);assert.equal(r.artifactsVerified,false);}
    job.status='new-unrecognized-status';const unknown=await f.client.job(actor,'23','24',commit,signal());assert.equal(unknown.status,'UNKNOWN');assert.equal(unknown.providerStatus,'unknown');
    await assert.rejects(()=>f.client.job(actor,'23','24',wrongCommit,signal()),{code:'PLATFORM_RECEIPT_MISMATCH'});
    assert.equal(f.calls.some(c=>c.options.method),false);
  }));
  test(provider+' current role and expiry are checked before credential access or network',()=>withNetwork(provider,async f=>{
    await assert.rejects(()=>f.client.readiness({...actor,projects:['beta']},AbortSignal.timeout(5000)),{code:'FORBIDDEN'});assert.equal(f.calls.length,0);
    const expired=(provider==='github'?githubClient:gitlabClient)({...f.p,expiresAt:'2020-01-01T00:00:00Z'},async()=>{throw Error('must not resolve');});
    await assert.rejects(()=>expired.readiness(actor,AbortSignal.timeout(5000)),{code:'PLATFORM_NOT_REGISTERED'});assert.equal(f.calls.length,0);
  }));
}
test('workflow bytes reject corrupt encodings, wrong lengths and oversized payloads',()=>{
  assert.equal(fileBytes(content.toString('base64')+'\n',content.length).toString(),content.toString());
  for(const [value,size] of [['YWJj$',3],['YWJj',2],['YWJj',1048577],['YW Jj',3]])assert.throws(()=>fileBytes(value,size),{code:'PLATFORM_RESPONSE_INVALID'});
});
test('a nonresponsive credential resolver honors cancellation without sending a request',async()=>{
  const old=globalThis.fetch;let called=false;globalThis.fetch=async()=>{called=true;return json({});};
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10);
  try{await assert.rejects(()=>platformReader(platform(),()=>new Promise(()=>{})).get(actor,'',controller.signal),{code:'PLATFORM_UNAVAILABLE'});assert.equal(called,false);}
  finally{clearTimeout(timer);globalThis.fetch=old;}
});
test('GitLab runner pauses and workflow content tampering fail closed',()=>withNetwork('gitlab',async f=>{
  const runner=f.routes.get(f.base+'/runners?per_page=100&page=1')[0];runner.paused=true;
  await assert.rejects(()=>f.client.readiness(actor,AbortSignal.timeout(5000)),{code:'RUNNER_NOT_READY'});runner.paused=false;
  f.routes.get(f.base+'/repository/files/.gitlab-ci.yml?ref='+commit).content_sha256='c'.repeat(64);
  await assert.rejects(()=>f.client.readiness(actor,AbortSignal.timeout(5000)),{code:'WORKFLOW_CONTENT_CHANGED'});
}));
test('platform transport bounds responses, denies arbitrary routes, and never echoes upstream secret-bearing errors',async()=>{
  const old=globalThis.fetch,reader=platformReader(platform(),async()=> 'synthetic-token-0123456789');
  try{
    globalThis.fetch=async()=>new Response('sensitive-provider-body synthetic-token-0123456789',{status:403});
    await assert.rejects(()=>reader.get(actor,'',AbortSignal.timeout(5000)),e=>e.code==='PLATFORM_PERMISSION_DENIED'&&!e.message.includes('synthetic-token'));
    globalThis.fetch=async()=>{throw Error('https://user:secret@attacker.test');};
    await assert.rejects(()=>reader.get(actor,'',AbortSignal.timeout(5000)),e=>e.code==='PLATFORM_UNAVAILABLE'&&!e.message.includes('secret'));
    await assert.rejects(()=>reader.get(actor,'https://attacker.test',AbortSignal.timeout(5000)),{code:'INVALID_PLATFORM_ROUTE'});
    globalThis.fetch=async()=>new Response('x'.repeat(2097153),{headers:{'content-type':'application/json'}});
    await assert.rejects(()=>reader.get(actor,'',AbortSignal.timeout(5000)),{code:'PLATFORM_RESPONSE_LIMIT'});
    globalThis.fetch=async()=>new Response('{}',{headers:{'content-type':'text/html'}});
    await assert.rejects(()=>reader.get(actor,'',AbortSignal.timeout(5000)),{code:'PLATFORM_RESPONSE_INVALID'});
    let called=false;globalThis.fetch=async()=>{called=true;return json({});};const abort=new AbortController();abort.abort();
    await assert.rejects(()=>reader.get(actor,'',abort.signal),{code:'PLATFORM_UNAVAILABLE'});assert.equal(called,false);
  }finally{globalThis.fetch=old;}
});

function readinessFixture(){
  const m=syntheticReadinessMaterial('test','alpha'),h='sha256:'+'a'.repeat(64);
  const reference={id:'synthetic-content',version:'1.0.0',visibility:'private',product:'ontology',specVersion:'v1',producer:{product:'ontology',version:'0.3.0'},digest:h,standardDigest:h,standardLockDigest:h,contractDigest:h};
  const body={schema:'evopilot-readiness-projection/v2',workspaceId:'test',scope:m.definition.scope,reference,published:true,specification:m.specification,specificationDigest:nativeSha256(m.specification),files:{'readiness/contract.md':m.files['readiness/contract.md']},authority:false};
  const projection={...body,digest:nativeSha256(body)};
  const result={schema:'evopilot-asset-readiness-result/v2',standardVersion:'v2',standardDigest:READINESS_STANDARD_DIGEST,workspaceId:'test',scope:m.definition.scope,intentDigest:m.intentDigest,projectionDigest:projection.digest,specificationDigest:projection.specificationDigest,reference,targetLevel:'L3',assetAssessment:{level:'L3',status:'QUALIFIED',freshness:'CURRENT',gaps:[],required:m.specification.statements.length,reviewDigest:h,evidenceOrigin:'SYNTHETIC'},reconstructionVerification:noReconstruction(),assessedAt:'2026-11-02T00:00:00Z',authority:false,softwareRelease:false};
  const wrap=body=>{const result={...body,digest:nativeSha256(body)};return{result,recordedDigest:h,currentViewDigest:nativeSha256(result),authority:false};};
  return{projection,result,wrap};
}
test('content readiness binds the fresh owner view and explicitly excludes reconstruction and software release authority',()=>{
  const f=readinessFixture(),view=f.wrap(f.result);
  const result=verifyReadinessView(view,f.projection,'L3','SYNTHETIC');
  assert.equal(result.level,'L3');assert.equal(result.meaning,'ASSET_CONTENT_ONLY');assert.equal(result.softwareRelease,false);
  assert.equal(verifyReadinessView(view,f.projection,'L1','SYNTHETIC').level,'L3');
  assert.equal(view.result.reconstructionVerification.status,'NOT_REQUESTED');
  assert.throws(()=>verifyReadinessView(view,f.projection,'L3','ACTUAL'),{code:'ASSET_NOT_READY'});
  assert.throws(()=>verifyReadinessView(view.result,f.projection,'L3','SYNTHETIC'),{code:'INVALID_FIELDS'});
});
test('stale, incomplete, forged and mismatched readiness views cannot certify a grade even with internally recomputed digests',()=>{
  const f=readinessFixture();
  for(const mutate of [r=>r.assetAssessment.freshness='UNKNOWN',r=>r.assetAssessment.freshness='STALE',r=>r.assetAssessment.status='INCOMPLETE',r=>r.assetAssessment.gaps.push({criterionId:'closure:C08',code:'MISSING'}),r=>r.assetAssessment.level='L2',r=>r.assetAssessment.required=0,r=>r.assetAssessment.reviewDigest=null]){
    const copy=structuredClone(f.result);mutate(copy);assert.throws(()=>verifyReadinessView(f.wrap(copy),f.projection,'L3','SYNTHETIC'),{code:'ASSET_NOT_READY'});
  }
  for(const mutate of [r=>r.scope.projectId='beta',r=>r.projectionDigest='sha256:'+'b'.repeat(64),r=>r.reference.version='2.0.0',r=>r.authority=true,r=>r.softwareRelease=true]){
    const copy=structuredClone(f.result);mutate(copy);assert.throws(()=>verifyReadinessView(f.wrap(copy),f.projection,'L3','SYNTHETIC'),{code:'ASSET_READINESS_INTEGRITY'});
  }
  const view=f.wrap(f.result);view.result.assetAssessment.level='L2';assert.throws(()=>verifyReadinessView(view,f.projection,'L3','SYNTHETIC'),{code:'ASSET_READINESS_INTEGRITY'});
});

function bindingFixture(){
  const f=configFixture(),r=readinessFixture(),references={ontology:r.projection.reference,harness:{...r.projection.reference,id:'synthetic-rules',product:'harness',producer:{product:'harness',version:'0.3.0'}}};
  const ownerRegistrations=['ontology','harness'].map(owner=>({ref:'binding:alpha/'+owner,owner,packageRoot:f.dir,workspaceRoot:f.dir,workspaceId:'test',projects:['alpha']}));
  const example=lifecycleBindingExample({root:f.dir,workspaceId:'test',projectId:'alpha',platform:f.p,credential:f.config.credentials[0],ownerRegistrations,references,assessmentId:'synthetic-content'});
  const ontologyPackage={manifest:{entrypoints:{coverage:'coverage.json',cases:'cases.json'},sourceBindingRef:'bindings.json'},files:{'coverage.json':JSON.stringify({requiredCaseIds:['positive'],expectedEntities:[{id:'https://example.invalid/r1/project'}],requiredShapeIds:['https://example.invalid/r1/ProjectShape']}),'bindings.json':JSON.stringify({requirements:[{id:'scope'}]}),'cases.json':JSON.stringify({cases:[{id:'positive',requirementIds:['scope']}]})}};
  const harnessPackage={manifest:{entrypoints:{coverage:'coverage.json'},dependencies:[references.ontology]},files:{'coverage.json':JSON.stringify({requiredRuleIds:['H001'],requiredCaseIds:['positive'],requirements:[{id:'requirement-H001',ruleIds:['H001'],caseIds:['positive']}]})}};
  const state={current:true,ownerReads:0,platformReads:0,during:null};
  const owners=Object.fromEntries(ownerRegistrations.map(({ref,...registration})=>[registration.owner,{owner:registration.owner,workspaceId:'test',capabilities:()=>({registrationDigest:valueDigest(registration)}),readPackage:async()=>{state.ownerReads++;return{package:registration.owner==='ontology'?ontologyPackage:harnessPackage};},read:async(_actor,_project,request)=>{
    state.ownerReads++;if(request.operation==='readiness.package.inspect')return r.projection;
    const copy=structuredClone(r.result);if(!state.current){copy.assetAssessment.freshness='STALE';copy.assetAssessment.level=null;copy.assetAssessment.status='STALE';}return r.wrap(copy);
  }}]));
  const connections={owner:ref=>owners[ref.split('/').at(-1)],agent:async d=>({adapter:'codex',version:d.version,executableDigest:d.executable.digest,hostId:d.hostId,modelInvoked:false}),platform:p=>({readiness:async()=>{state.platformReads++;if(state.during)await state.during();return{provider:p.provider,projectId:p.projectId,repositoryId:p.repositoryId,bindingDigest:valueDigest(p),factsDigest:valueDigest({synthetic:p.ref}),expiresAt:new Date(Date.now()+60000).toISOString()};}})};
  const save=()=>writeFileSync(f.path,JSON.stringify(example.configuration),{mode:0o600});save();
  const definition=()=>{const c=compileLifecycle(yaml(example.data),'alpha');assert.equal(c.valid,true);return c.effective;};
  return{...f,...example,definition,state,connections,save,provider:createRegisteredBindings(f.path,'test',connections),cleanup:f.cleanup};
}
test('registered admission resolves every required role, exact owner inventories and platform facts without dispatch',async()=>{
  const f=bindingFixture();try{
    const result=await validateBindings(f.definition(),actor,f.provider);assert.equal(result.ready,true,JSON.stringify(result.issues));assert.equal(result.checks.length>40,true);assert.equal(f.state.platformReads,1);
    assert.equal(result.checks.every(c=>c.status==='VALID'),true);assert.equal(JSON.stringify(result).includes('token-0123'),false);
    const first=result.stamp;f.configuration.credentials[0].revision++;f.save();const changed=await validateBindings(f.definition(),actor,f.provider);assert.equal(changed.ready,true);assert.notEqual(changed.stamp,first);
  }finally{f.cleanup();}
});
test('required registrations cannot be replaced by a generic document, missing reference, changed scope or weakened policy',async()=>{
  const f=bindingFixture();try{
    const original=structuredClone(f.configuration.resources);
    for(const role of ['config.scope.targetInputRef','config.plan.recoveryPolicyRef','config.implementation.agentBindingRef','config.candidate.buildWorkflowRef','config.verification.evidenceMappingRef','assets.ontology.mappingRef','assets.harness.standardRef']){
      f.configuration.resources=original.filter(r=>r.role!==role);f.save();const result=await validateBindings(f.definition(),actor,f.provider);assert.equal(result.ready,false,role);assert(result.issues.some(i=>i.path===role),role);
    }
    f.configuration.resources=structuredClone(original);const review=f.configuration.resources.find(r=>r.role==='config.plan.reviewPolicyRef');review.definition={kind:'document',...f.configuration.resources[0].definition};f.save();assert.equal((await validateBindings(f.definition(),actor,f.provider)).ready,false);
    f.configuration.resources=structuredClone(original);f.configuration.resources.find(r=>r.role==='config.verification.failurePolicyRef').definition.onUnknown='PASS';f.save();assert.equal((await validateBindings(f.definition(),actor,f.provider)).ready,false);
    f.configuration.resources=structuredClone(original);f.configuration.resources.find(r=>r.role==='config.plan.adrLocationRef').projectId='beta';f.save();assert.equal((await validateBindings(f.definition(),actor,f.provider)).ready,false);
  }finally{f.cleanup();}
});
test('admission rejects stale grades, wrong published rule/variant, missing fixed mappings and owner registration drift',async()=>{
  const f=bindingFixture();try{
    f.state.current=false;assert.equal((await validateBindings(f.definition(),actor,f.provider)).ready,false);f.state.current=true;
    const mapping=f.configuration.resources.find(r=>r.role==='config.verification.evidenceMappingRef'),original=structuredClone(mapping.definition);
    mapping.definition.rows.pop();f.save();assert.equal((await validateBindings(f.definition(),actor,f.provider)).ready,false);
    mapping.definition=structuredClone(original);mapping.definition.rows[0].criterionId='UNPUBLISHED';f.save();assert.equal((await validateBindings(f.definition(),actor,f.provider)).ready,false);
    mapping.definition=structuredClone(original);mapping.definition.rows[0].variantIds=['unknown-variant'];f.save();assert.equal((await validateBindings(f.definition(),actor,f.provider)).ready,false);
    mapping.definition=structuredClone(original);f.configuration.owners[0].packageRoot=join(f.dir,'other');f.save();assert.equal((await validateBindings(f.definition(),actor,f.provider)).ready,false);
  }finally{f.cleanup();}
});
test('protected resource byte drift and configuration mutation during live verification invalidate admission',async()=>{
  const f=bindingFixture();try{
    writeFileSync(join(f.dir,'target.md'),'changed target');assert.equal((await validateBindings(f.definition(),actor,f.provider)).ready,false);
    f.state.during=async()=>{f.configuration.revision++;f.save();};const checked=await validateBindings(f.definition(),actor,f.provider);assert.equal(checked.ready,false);assert.equal(checked.issues[0].code,'BINDINGS_UNKNOWN');
  }finally{f.cleanup();}
});
test('external Agent identity probe cannot treat another executable, changed bytes or a caller-defined command as Codex',async()=>{
  const f=bindingFixture();try{
    const d=f.configuration.resources.find(r=>r.role==='config.implementation.agentBindingRef').definition;
    await assert.rejects(()=>inspectExternalAgent(d,AbortSignal.timeout(5000)),{code:'AGENT_IDENTITY_CHANGED'});
    await assert.rejects(()=>inspectExternalAgent({...d,command:['exec','do-work']},AbortSignal.timeout(5000)),{code:'INVALID_FIELDS'});
    await assert.rejects(()=>inspectExternalAgent({...d,executable:{...d.executable,digest:'sha256:'+'f'.repeat(64)}},AbortSignal.timeout(5000)),{code:'AGENT_IDENTITY_CHANGED'});
  }finally{f.cleanup();}
});
test('unavailable owner composition is lazy and blocks validation without preventing service/history startup',async()=>{
  const f=bindingFixture(),connections=await openRegisteredBindings(join(f.dir,'missing-integrations.json'),'test');
  try{const result=await validateBindings(f.definition(),actor,connections.provider);assert.equal(result.ready,false);assert.equal(result.issues[0].code,'BINDINGS_UNKNOWN');}
  finally{connections.close();f.cleanup();}
});
test('GitHub runner binding rejects a wrong workflow label and mismatched completed job runner',()=>withNetwork('github',async f=>{
  const bytes=Buffer.from(content.toString().replace('ubuntu-latest','windows-latest')),file=f.routes.get(f.base+'/contents/'+f.p.workflowPath+'?ref='+commit);
  file.content=bytes.toString('base64');file.size=bytes.length;file.sha=createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');
  await assert.rejects(()=>f.client.readiness(actor,AbortSignal.timeout(5000)),{code:'RUNNER_NOT_READY'});
  f.routes.get(f.base+'/actions/jobs/24').labels=['windows-latest'];await assert.rejects(()=>f.client.job(actor,'23','24',commit,AbortSignal.timeout(5000)),{code:'PLATFORM_RECEIPT_MISMATCH'});
}));
