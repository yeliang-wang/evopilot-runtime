import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownerDistributionIdentity, verifyOwnerDistribution, openPublishedOwner, ownerRequestDigest, verifyReadinessView } from '../../dist/adapters/published-owners.js';
import { createHash } from 'node:crypto';
import { validatePlatformRegistration, readIntegrationConfiguration, configuredPlatform, readPlatformToken, readRegisteredNativeToolchain } from '../../dist/adapters/config.js';
import { githubClient } from '../../dist/adapters/github.js';
import { gitlabClient } from '../../dist/adapters/gitlab.js';
import { ciInputs, ciRunTitle, ciSourceRef, fileBytes, platformReader } from '../../dist/adapters/platforms.js';
import { candidateDigest } from '../../dist/lifecycle/instance.js';
import { syntheticReadinessMaterial, lifecycleBindingExample } from '../fixtures/adapters-v090.mjs';
import { nativeSha256 } from '../../vendor/compatibility/v1/native.mjs';
import { READINESS_STANDARD_DIGEST, noReconstruction } from '../../vendor/compatibility/usability/v2/contract.mjs';
import { createRegisteredBindings, openRegisteredBindings } from '../../dist/adapters/bindings.js';
import { compileLifecycle } from '../../dist/lifecycle/compiler.js';
import { validateBindings } from '../../dist/lifecycle/bindings.js';
import { valueDigest } from '../../dist/lifecycle/base.js';
import { registeredAuthorityPolicy } from '../../dist/adapters/authority.js';
import { yaml } from '../fixtures/lifecycle-v090.mjs';
import { inspectExternalAgent } from '../../dist/adapters/external-agent.js';
import { createOwnerFeedbackDelivery, verifyOwnerFeedbackInbox } from '../../dist/adapters/feedback.js';
import { RuntimeStore } from '../../dist/server/store.js';
import { ServiceError } from '../../dist/server/errors.js';
import { NATIVE_CONTRACT_DIGEST } from '../../vendor/compatibility/v1/native.mjs';
import { syntheticDecisionEvidence } from '../fixtures/native/decision-evidence.mjs';

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
    routes.set(base+'/commits/'+commit,{sha:commit});
    routes.set(base+'/branches/main',{name:'main',commit:{sha:commit}});
    routes.set(base+'/actions/workflows/test.yml',{id:11,path:p.workflowPath,state:'active'});
    routes.set(base+'/contents/'+p.workflowPath+'?ref='+commit,{type:'file',path:p.workflowPath,encoding:'base64',content:content.toString('base64').match(/.{1,20}/g).join('\n')+'\n',size:content.length,sha:blob});
    routes.set(base+'/actions/runs/23',{id:23,repository:{id:42},head_sha:commit,head_branch:'main',path:p.workflowPath});
    routes.set(base+'/actions/jobs/24',{id:24,run_id:23,head_sha:commit,status:'completed',conclusion:'success',runner_id:25,labels:['ubuntu-latest']});
  }else{
    routes.set(base+'/repository/commits/'+commit,{id:commit});
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
  test(provider+' exact revision readiness preserves its source selection independently of branch HEAD',()=>withNetwork(provider,async f=>{
    const branch=f.routes.get(f.base+(provider==='github'?'/branches/main':'/repository/branches/main'));branch.commit[provider==='github'?'sha':'id']=wrongCommit;
    const r=await f.client.revision(actor,commit,AbortSignal.timeout(5000));assert.equal(r.sourceSelection,'exact-commit');assert.equal(r.branchHeadCommit,wrongCommit);assert.equal(r.commit,commit);assert.equal(r.workflowDigest,'sha256:'+contentDigest);assert.equal(r.executionAuthorized,false);
    const{schema,observedAt,expiresAt,evidenceRef,executionAuthorized,workflowExecuted,factsDigest,...facts}=r;assert.equal(factsDigest,valueDigest(facts));assert(!f.calls.some(c=>c.url.endsWith('?ref='+wrongCommit)));
    const route=f.base+(provider==='github'?'/contents/'+f.p.workflowPath:'/repository/files/'+f.p.pipelinePath)+'?ref=';f.routes.set(route+wrongCommit,{...f.routes.get(route+commit),...(provider==='gitlab'?{commit_id:wrongCommit}:{})});
    const current=await f.client.readiness(actor,AbortSignal.timeout(5000));assert.equal(current.commit,wrongCommit);assert.equal(current.sourceSelection,undefined);
  }));
  test(provider+' exact revision cannot invent a missing commit or substitute workflow bytes',()=>withNetwork(provider,async f=>{
    const source=f.base+(provider==='github'?'/commits/':'/repository/commits/')+commit;
    f.routes.set(source,new Response('{}',{status:404}));await assert.rejects(()=>f.client.revision(actor,commit,AbortSignal.timeout(5000)),{code:'PLATFORM_RESOURCE_MISSING'});
    f.routes.set(source,provider==='github'?{sha:commit}:{id:commit});const file=f.routes.get(f.base+(provider==='github'?'/contents/'+f.p.workflowPath:'/repository/files/'+f.p.pipelinePath)+'?ref='+commit);file.content=Buffer.from('changed').toString('base64');file.size=7;
    await assert.rejects(()=>f.client.revision(actor,commit,AbortSignal.timeout(5000)),{code:'WORKFLOW_CONTENT_CHANGED'});assert(f.calls.every(c=>c.options.method===undefined));
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

// Stateful provider double: records each side effect independently from its
// response, so timeout/recovery tests cannot pass by silently redispatching.
const ciActor={...actor,permissions:['read','execution.request']};
const ghContract='name: Synthetic\nrun-name: "evopilot:${{ inputs.runtime_request_id }}:${{ inputs.runtime_input_digest }}"\non:\n  workflow_dispatch:\n    inputs:\n'+['runtime_request_id','runtime_input_digest','runtime_source_commit','runtime_stage','runtime_candidate_digest','runtime_workflow_digest','runtime_binding_digest','runtime_candidate_input'].map(k=>'      '+k+':\n        type: string\n        required: true\n').join('')+'jobs:\n  fixture:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo synthetic\n';
const glContract='workflow:\n  rules:\n    - if: \'$CI_COMMIT_TAG =~ /^evopilot-runtime\\// && $CI_PIPELINE_SOURCE != "api"\'\n      when: never\n    - if: \'$CI_PIPELINE_SOURCE == "api"\'\n      when: always\nfixture:\n  script: echo synthetic\n';
async function withDispatch(provider,run){
  const old=globalThis.fetch,f=responses(provider),calls=[],writes=[];
  const bytes=Buffer.from(provider==='github'?ghContract:glContract),workflowDigest='sha256:'+createHash('sha256').update(bytes).digest('hex');
  const request={schema:'runtime-ci-request/v1',requestId:'fixture-original-01',projectId:'alpha',bindingDigest:valueDigest(f.p),commit,workflowDigest,inputDigest:'sha256:'+'d'.repeat(64),stageId:'candidate',candidateDigest:null,requestedAt:new Date().toISOString(),deadlineAt:new Date(Date.now()+60000).toISOString()};
  const sourceRef=ciSourceRef(request),state={ref:false,run:false,timeout:false,dispatch204:false};
  const refPath=provider==='github'?'/git/ref/tags/'+sourceRef:'/repository/tags/'+encodeURIComponent(sourceRef);
  const createPath=provider==='github'?'/git/refs':'/repository/tags',dispatchPath=provider==='github'?'/actions/workflows/test.yml/dispatches':'/pipeline';
  const filePath=provider==='github'?'/contents/'+f.p.workflowPath+'?ref='+commit:'/repository/files/.gitlab-ci.yml?ref='+commit;
  const file=f.routes.get(f.base+filePath);Object.assign(file,{content:bytes.toString('base64'),size:bytes.length,...(provider==='github'?{sha:createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex')}:{content_sha256:workflowDigest.slice(7)})});
  const runPath=provider==='github'?'/actions/runs/23':'/pipelines/23',jobPath=provider==='github'?'/actions/jobs/24':'/jobs/24';
  const providerRun=f.routes.get(f.base+runPath),providerJob=f.routes.get(f.base+jobPath);
  const listPath=provider==='github'?'/actions/workflows/test.yml/runs?event=workflow_dispatch&head_sha='+commit+'&per_page=100&page=1':'/pipelines?ref='+encodeURIComponent(sourceRef)+'&sha='+commit+'&source=api&per_page=100&page=1';
  const jobsPath=provider==='github'?'/actions/runs/23/jobs?filter=all&per_page=100&page=1':'/pipelines/23/jobs?include_retried=true&per_page=100&page=1';
  if(provider==='github'){
    Object.assign(providerRun,{head_branch:sourceRef,event:'workflow_dispatch',display_title:ciRunTitle(request),run_attempt:1,status:'completed',conclusion:'success'});providerJob.run_attempt=1;
    f.routes.set(f.base+'/contents/.github/workflows?ref='+commit,[{type:'file',path:f.p.workflowPath}]);
    f.routes.set(f.base+jobsPath,{jobs:[providerJob]});
  }else{
    Object.assign(providerRun,{ref:sourceRef,source:'api',status:'success'});Object.assign(providerJob,{name:'fixture',stage:'test'});
    f.routes.set(f.base+'/pipelines/23/variables',Object.entries(ciInputs(request)).map(([key,value])=>({key,value,variable_type:'env_var'})));
    f.routes.set(f.base+jobsPath,[providerJob]);f.routes.set(f.base+'/pipelines/23/bridges?per_page=100',[]);
  }
  globalThis.fetch=async(url,options)=>{
    calls.push({url,options});assert.equal(options.redirect,'error');
    if(options.method==='POST'){
      const body=JSON.parse(options.body);writes.push({url,body});
      if(url===f.base+createPath){assert.equal(state.ref,false);state.ref=true;assert.deepEqual(body,provider==='github'?{ref:'refs/tags/'+sourceRef,sha:commit}:{tag_name:sourceRef,ref:commit});return json({});}
      assert.equal(url,f.base+dispatchPath);assert.equal(state.ref,true);assert.equal(state.run,false);state.run=true;
      assert.deepEqual(body,provider==='github'?{ref:sourceRef,inputs:ciInputs(request),return_run_details:true}:{ref:sourceRef,variables:Object.entries(ciInputs(request)).map(([key,value])=>({key,value,variable_type:'env_var'}))});
      if(state.timeout)throw Error('provider accepted then disconnected: sensitive');
      return state.dispatch204?new Response(null,{status:204}):json(provider==='github'?{workflow_run_id:23}:{id:23});
    }
    assert.equal(options.method,undefined);
    if(url===f.base+refPath)return state.ref?json(provider==='github'?{ref:'refs/tags/'+sourceRef,object:{type:'commit',sha:state.wrongRef?wrongCommit:commit}}:{name:sourceRef,target:state.wrongRef?wrongCommit:commit,commit:{id:commit}}):new Response('{}',{status:404});
    if(url===f.base+listPath){const runs=state.run?[providerRun]:[];if(state.duplicate)runs.push({...providerRun});return json(provider==='github'?{workflow_runs:runs}:runs);}
    const value=f.routes.get(url);assert.notEqual(value,undefined,'Unexpected CI URL '+url);return json(value);
  };
  const client=(provider==='github'?githubClient:gitlabClient)(f.p,async()=> 'synthetic-token-0123456789');
  const permit=async r=>{assert.deepEqual(r,request);return ciActor;};
  try{await run({...f,client,request,permit,state,writes,calls,providerRun,providerJob,file,jobsPath,sourceRef});}finally{globalThis.fetch=old;}
}
for(const provider of ['github','gitlab']){
  test(provider+' dispatch pins source, checks current permits and recovers original run without repeating writes',()=>withDispatch(provider,async f=>{
    let permits=0;const result=await f.client.dispatch(f.request,async r=>{permits++;return f.permit(r);},AbortSignal.timeout(5000));
    assert.equal(result.runId,'23');assert.equal(result.status,'PASSED');assert.equal(result.ref,f.sourceRef);assert.equal(result.artifactsVerified,false);assert.equal(result.lifecycleAcceptance,false);assert.equal(f.writes.length,2);assert.equal(permits,3);
    assert.equal(JSON.stringify(result).includes('synthetic-token'),false);
    assert.equal((await f.client.run(actor,f.request,null,AbortSignal.timeout(5000))).runId,'23');
    assert.equal((await f.client.dispatch(f.request,f.permit,AbortSignal.timeout(5000))).runId,'23');assert.equal(f.writes.length,2);
  }));
  test(provider+' rejects missing execution/release authority and mismatched requests before network',()=>withDispatch(provider,async f=>{
    await assert.rejects(()=>f.client.dispatch(f.request,async()=>actor,AbortSignal.timeout(5000)),{code:'FORBIDDEN'});
    const manifest={schema:'runtime-candidate/v1',version:'0.9.0-preview.1',profile:'candidate-verification',sourceDigest:valueDigest({provider,repositoryId:f.p.repositoryId,commit}),buildDigest:valueDigest('synthetic build'),artifacts:[{name:'software.tgz',bytes:100,digest:valueDigest('synthetic bytes')}]};
    const publication={...f.request,stageId:'publication',candidateDigest:candidateDigest(manifest),candidateInput:{schema:'runtime-ci-candidate-input/v1',manifest,archive:{provider,repositoryId:f.p.repositoryId,runId:'9',artifactId:'10',jobId:provider==='github'?null:'10',archiveDigest:valueDigest('synthetic archive'),archiveBytes:100}},publicationInput:{schema:'runtime-publication-input/v1',target:{tagPrefix:'v',prerelease:true,packageName:provider==='github'?null:'software'},tag:'v'+manifest.version,releaseMaterialDigest:valueDigest('synthetic material'),releaseAuthorityRef:'authority:'+valueDigest('synthetic authority'),notes:[{path:'CHANGELOG.md',digest:valueDigest('synthetic notes'),bytes:10}]}};
    await assert.rejects(()=>f.client.dispatch(publication,async()=>ciActor,AbortSignal.timeout(5000)),{code:'FORBIDDEN'});
    await assert.rejects(()=>f.client.dispatch({...f.request,stageId:'publication'},async()=>ciActor,AbortSignal.timeout(5000)),{code:'PUBLICATION_INPUT'});
    for(const changes of [{projectId:'beta'},{bindingDigest:'sha256:'+'e'.repeat(64)},{stageId:'arbitrary-code'},{requestId:'../escape'},{extra:'input'}])await assert.rejects(()=>f.client.dispatch({...f.request,...changes},f.permit,AbortSignal.timeout(5000)));
    await assert.rejects(()=>f.client.dispatch({...f.request,requestedAt:'2020-01-01',deadlineAt:'2020-01-02'},f.permit,AbortSignal.timeout(5000)),{code:'CI_DISPATCH_EXPIRED'});assert.equal(f.calls.length,0);
  }));
  test(provider+' mismatched exact source and tag-trigger unsafe contracts cannot start CI',()=>withDispatch(provider,async f=>{
    f.routes.set(f.base+(provider==='github'?'/commits/':'/repository/commits/')+wrongCommit,provider==='github'?{sha:commit}:{id:commit});
    await assert.rejects(()=>f.client.dispatch({...f.request,commit:wrongCommit},async()=>ciActor,AbortSignal.timeout(5000)),{code:'CI_SOURCE_CHANGED'});assert.equal(f.writes.length,0);
    const bytes=Buffer.from(provider==='github'?ghContract.replace('  workflow_dispatch:','  push:\n  workflow_dispatch:'):glContract.replace('when: never','when: always'));
    const digest=createHash('sha256').update(bytes).digest('hex');Object.assign(f.file,{content:bytes.toString('base64'),size:bytes.length,...(provider==='github'?{sha:createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex')}:{content_sha256:digest})});
    await assert.rejects(()=>f.client.dispatch({...f.request,workflowDigest:'sha256:'+digest},async()=>ciActor,AbortSignal.timeout(5000)),{code:'CI_REF_AUTOTRIGGER'});assert.equal(f.writes.length,0);
  }));
  test(provider+' dispatch retains its reviewed commit when the default branch advances',()=>withDispatch(provider,async f=>{
    const branch=f.routes.get(f.base+(provider==='github'?'/branches/main':'/repository/branches/main'));branch.commit[provider==='github'?'sha':'id']=wrongCommit;
    const result=await f.client.dispatch(f.request,f.permit,AbortSignal.timeout(5000));assert.equal(result.commit,commit);assert.equal(result.status,'PASSED');assert.equal(f.writes.length,2);
    assert(f.calls.some(c=>c.url===f.base+(provider==='github'?'/commits/':'/repository/commits/')+commit));
    assert(!f.calls.some(c=>c.url.endsWith('?ref='+wrongCommit)));
  }));
  test(provider+' authority revoked after source pinning prevents dispatch and never blindly retries',()=>withDispatch(provider,async f=>{
    let permits=0;await assert.rejects(()=>f.client.dispatch(f.request,async()=>++permits===3?actor:ciActor,AbortSignal.timeout(5000)),{code:'FORBIDDEN'});assert.equal(f.writes.length,1);assert.equal(f.state.run,false);
    const result=await f.client.dispatch(f.request,f.permit,AbortSignal.timeout(5000));assert.equal(result.status,'UNKNOWN');assert.equal(result.runId,null);assert.equal(f.writes.length,1);
  }));
  test(provider+' ambiguous dispatch response is inspected using the original correlation without another POST',()=>withDispatch(provider,async f=>{
    f.state.timeout=true;await assert.rejects(()=>f.client.dispatch(f.request,f.permit,AbortSignal.timeout(5000)),{code:'CI_DISPATCH_OUTCOME_UNKNOWN'});
    const result=await f.client.run(actor,f.request,null,AbortSignal.timeout(5000));assert.equal(result.status,'PASSED');assert.equal(result.runId,'23');assert.equal(f.writes.length,2);
  }));
  test(provider+' rejects retargeted source, duplicate runs, wrong correlation and nonpassing jobs',()=>withDispatch(provider,async f=>{
    f.state.ref=true;f.state.run=true;f.state.wrongRef=true;await assert.rejects(()=>f.client.run(actor,f.request,null,AbortSignal.timeout(5000)),{code:'CI_REF_CHANGED'});f.state.wrongRef=false;
    f.state.duplicate=true;await assert.rejects(()=>f.client.run(actor,f.request,null,AbortSignal.timeout(5000)),{code:'CI_DUPLICATE_RUNS'});f.state.duplicate=false;
    if(provider==='github')f.providerRun.display_title='wrong';else f.routes.get(f.base+'/pipelines/23/variables')[0].value='wrong';
    await assert.rejects(()=>f.client.run(actor,f.request,'23',AbortSignal.timeout(5000)),{code:'CI_RUN_MISMATCH'});
    if(provider==='github'){f.providerRun.display_title=ciRunTitle(f.request);f.providerJob.conclusion='skipped';}else{f.routes.get(f.base+'/pipelines/23/variables')[0].value=f.request.requestId;f.providerJob.status='skipped';}
    assert.equal((await f.client.run(actor,f.request,'23',AbortSignal.timeout(5000))).status,'FAILED');assert.equal(f.writes.length,0);
  }));
  test(provider+' retries cannot overwrite original attempt evidence',()=>withDispatch(provider,async f=>{
    f.state.ref=true;f.state.run=true;if(provider==='github')f.providerRun.run_attempt=2;else f.routes.get(f.base+f.jobsPath).push({...f.providerJob,id:25});
    await assert.rejects(()=>f.client.run(actor,f.request,'23',AbortSignal.timeout(5000)),{code:'CI_RUN_MISMATCH'});assert.equal(f.writes.length,0);
  }));
  test(provider+' cancellation bounds a stalled execution permit without provider side effects',()=>withDispatch(provider,async f=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10);
    try{await assert.rejects(()=>f.client.dispatch(f.request,()=>new Promise(()=>{}),controller.signal),{code:'PLATFORM_UNAVAILABLE'});assert.equal(f.calls.length,0);}finally{clearTimeout(timer);}
  }));
}
test('GitHub dispatch 204 is reconciled using exact run title rather than latest run',()=>withDispatch('github',async f=>{
  f.state.dispatch204=true;assert.equal((await f.client.dispatch(f.request,f.permit,AbortSignal.timeout(5000))).runId,'23');assert.equal(f.writes.length,2);
}));
test('GitLab downstream pipelines cannot be treated as verified local jobs',()=>withDispatch('gitlab',async f=>{
  f.state.ref=true;f.state.run=true;f.routes.set(f.base+'/pipelines/23/bridges?per_page=100',[{id:999}]);
  await assert.rejects(()=>f.client.run(actor,f.request,'23',AbortSignal.timeout(5000)),{code:'CI_DOWNSTREAM_UNVERIFIED'});
}));
for(const provider of ['github','gitlab'])test(provider+' success with no executed runner or no job evidence remains unknown',()=>withDispatch(provider,async f=>{
  f.state.ref=true;f.state.run=true;if(provider==='github')f.providerJob.runner_id=0;else f.providerJob.runner=null;
  assert.equal((await f.client.run(actor,f.request,'23',AbortSignal.timeout(5000))).status,'UNKNOWN');
  f.routes.set(f.base+f.jobsPath,provider==='github'?{jobs:[]}:[]);
  assert.equal((await f.client.run(actor,f.request,'23',AbortSignal.timeout(5000))).status,'UNKNOWN');assert.equal(f.writes.length,0);
}));
test('GitHub rejects an additional automatic create workflow before source-ref creation',()=>withDispatch('github',async f=>{
  const path='.github/workflows/other.yml',bytes=Buffer.from('on: create\njobs: {}\n');
  f.routes.get(f.base+'/contents/.github/workflows?ref='+commit).push({type:'file',path});
  f.routes.set(f.base+'/contents/'+path+'?ref='+commit,{type:'file',path,encoding:'base64',content:bytes.toString('base64'),size:bytes.length,sha:createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex')});
  await assert.rejects(()=>f.client.dispatch(f.request,f.permit,AbortSignal.timeout(5000)),{code:'CI_REF_AUTOTRIGGER'});assert.equal(f.writes.length,0);
}));
test('CI write transport cannot be used for an arbitrary provider mutation',async()=>{
  const old=globalThis.fetch;let called=false;globalThis.fetch=async()=>{called=true;return json({});};
  try{await assert.rejects(()=>platformReader(platform(),async()=> 'synthetic-token-0123456789').post(ciActor,'/releases',{tag_name:'v9.0.0'},async()=>ciActor,AbortSignal.timeout(5000)),{code:'INVALID_PLATFORM_ROUTE'});assert.equal(called,false);}finally{globalThis.fetch=old;}
});
for(const provider of ['github','gitlab'])test(provider+' exact artifact download rejects stale, ambiguous and tampered provider metadata',()=>withDispatch(provider,async f=>{
  f.state.ref=true;f.state.run=true;const bytes=Buffer.from('synthetic archive transport bytes'),digest='sha256:'+createHash('sha256').update(bytes).digest('hex'),expires='2030-01-01T00:00:00Z';
  let metadata;
  if(provider==='github'){
    metadata={id:99,name:'runtime-ci',expired:false,expires_at:expires,digest,size_in_bytes:bytes.length,workflow_run:{id:23,repository_id:42,head_sha:commit,head_branch:f.sourceRef}};
    f.routes.set(f.base+'/actions/runs/23/artifacts?per_page=100&page=1',{artifacts:[metadata]});f.routes.set(f.base+'/actions/artifacts/99',metadata);
  }else{metadata=f.providerJob;metadata.artifacts_file={filename:'runtime-ci.zip',size:bytes.length};metadata.artifacts_expire_at=expires;}
  const priorFetch=globalThis.fetch;let downloads=0;
  globalThis.fetch=async(url,options)=>{if(url===f.base+(provider==='github'?'/actions/artifacts/99/zip':'/jobs/24/artifacts')){downloads++;assert.equal(options.redirect,'manual');assert.equal(options.method,undefined);return new Response(bytes,{headers:{'content-length':String(bytes.length)}});}return priorFetch(url,options);};
  const archive=await f.client.artifact(actor,f.request,'23',AbortSignal.timeout(5000));assert.equal(archive.archiveDigest,digest);assert.deepEqual(archive.bytes,bytes);assert.equal(archive.bindingDigest,f.request.bindingDigest);assert.equal(f.writes.length,0);assert.equal(downloads,1);
  if(provider==='github')metadata.digest='sha256:'+'c'.repeat(64);else metadata.artifacts_file.size++;
  await assert.rejects(()=>f.client.artifact(actor,f.request,'23',AbortSignal.timeout(5000)),{code:'CI_ARTIFACT_INTEGRITY'});
  if(provider==='github'){metadata.digest=digest;metadata.expired=true;}else{metadata.artifacts_file.size=bytes.length;metadata.artifacts_expire_at='2020-01-01T00:00:00Z';}
  await assert.rejects(()=>f.client.artifact(actor,f.request,'23',AbortSignal.timeout(5000)),{code:'CI_ARTIFACT_MISMATCH'});
  if(provider==='github'){metadata.expired=false;f.routes.get(f.base+'/actions/runs/23/artifacts?per_page=100&page=1').artifacts.push({...metadata});}
  else{metadata.artifacts_expire_at=expires;const second={...metadata,id:25,name:'another',artifacts_file:{...metadata.artifacts_file}};f.routes.get(f.base+f.jobsPath).push(second);f.routes.set(f.base+'/jobs/25',second);}
  await assert.rejects(()=>f.client.artifact(actor,f.request,'23',AbortSignal.timeout(5000)),{code:'CI_ARTIFACT_AMBIGUOUS'});assert.equal(f.writes.length,0);
}));

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
function nativeManifest(f){
  const tool={executable:process.execPath,version:'synthetic',sha256:'a'.repeat(64)},file=join(f.dir,'native-toolchain.json');
  const value={schema:'evopilot-native-toolchain/v1',platform:process.platform,arch:process.arch,lockDigest:valueDigest('synthetic-native-lock'),tools:{python:tool,pyshacl:tool,opa:tool,conftest:tool},dependencyLockDigest:valueDigest('synthetic-dependencies'),environmentRoot:f.dir,dependencyFiles:[{path:process.execPath,sha256:'a'.repeat(64)}],timeoutMs:60000,maxInputBytes:1048576,maxPackageBytes:1048576};
  const save=()=>{const bytes=JSON.stringify(value);writeFileSync(file,bytes,{mode:0o600});return{path:file,digest:'sha256:'+createHash('sha256').update(bytes).digest('hex'),lockDigest:value.lockDigest};};
  return{file,value,save};
}
test('native stage toolchain requires a protected exact manifest; a descriptor never proves installed validator readiness',()=>{
  const f=configFixture(),t=nativeManifest(f);try{
    assert.throws(()=>readRegisteredNativeToolchain(readIntegrationConfiguration(f.path,'test')),{code:'TOOLCHAIN_NOT_REGISTERED'});
    f.config.nativeToolchain=t.save();f.save();const config=readIntegrationConfiguration(f.path,'test'),result=readRegisteredNativeToolchain(config);
    assert.equal(result.lockDigest,t.value.lockDigest);assert(Object.isFrozen(result.tools));
    writeFileSync(t.file,'changed');assert.throws(()=>readRegisteredNativeToolchain(config),{code:'TOOLCHAIN_CHANGED'});t.save();
    assert.throws(()=>readRegisteredNativeToolchain({...config,nativeToolchain:{...config.nativeToolchain,lockDigest:valueDigest('other')}}),{code:'TOOLCHAIN_MISMATCH'});
    chmodSync(t.file,0o644);assert.throws(()=>readRegisteredNativeToolchain(config),{code:'UNSAFE_STATE'});chmodSync(t.file,0o600);
    const link=join(f.dir,'linked');symlinkSync(t.file,link);assert.throws(()=>readRegisteredNativeToolchain({...config,nativeToolchain:{...config.nativeToolchain,path:link}}),{code:'UNSAFE_TOOLCHAIN'});
    t.value.tools.custom={...t.value.tools.python};f.config.nativeToolchain=t.save();f.save();assert.throws(()=>readRegisteredNativeToolchain(readIntegrationConfiguration(f.path,'test')),{code:'INVALID_FIELDS'});
    delete t.value.tools.custom;t.value.timeoutMs=0;f.config.nativeToolchain=t.save();f.save();assert.throws(()=>readRegisteredNativeToolchain(readIntegrationConfiguration(f.path,'test')),{code:'INVALID_TOOLCHAIN'});
    f.config.nativeToolchain={...t.save(),command:['arbitrary']};f.save();assert.throws(()=>readIntegrationConfiguration(f.path,'test'),{code:'INVALID_FIELDS'});
  }finally{f.cleanup();}
});
test('native manifest changes bind execution authority even when project YAML is unchanged',()=>{
  const f=bindingFixture(),t=nativeManifest(f);try{
    const policy=registeredAuthorityPolicy(f.path,'test'),original=policy(f.definition(),actor);
    f.configuration.nativeToolchain=t.save();f.save();const pinned=policy(f.definition(),actor);
    assert.equal(original.digest,pinned.digest);assert.notEqual(original.bindingContextDigest,pinned.bindingContextDigest);
    f.configuration.nativeToolchain.digest=valueDigest('replacement-manifest');f.save();assert.notEqual(policy(f.definition(),actor).bindingContextDigest,pinned.bindingContextDigest);
    f.configuration.nativeToolchain=t.save();f.configuration.credentials[0].revision++;f.save();assert.equal(policy(f.definition(),actor).bindingContextDigest,pinned.bindingContextDigest);
  }finally{f.cleanup();}
});
test('registered executor is lazy, shares the service store, refuses wrong scope and cannot reopen after close',async()=>{
  const f=fixture(),composition=await openRegisteredBindings(join(f.dir,'absent.json'),'test'),store=new RuntimeStore(join(f.dir,'state'),'test'),other=new RuntimeStore(join(f.dir,'other'),'other');
  try{
    assert.throws(()=>composition.executor(other),{code:'INTEGRATION_SCOPE'});const adapter=composition.executor(store);
    await assert.rejects(()=>adapter.prepare({},'candidate',actor,AbortSignal.timeout(1000)),{code:'UNSAFE_INTEGRATION_CONFIG'});
    composition.close();await assert.rejects(()=>adapter.prepare({},'candidate',actor,AbortSignal.timeout(1000)),{code:'CLOSED'});
    assert.equal(store.revision('alpha'),0);assert.equal(existsSync(join(f.dir,'absent.json')),false);
  }finally{composition.close();store.close();other.close();f.cleanup();}
});
test('ordinary service cannot activate a lifecycle or request a native stage with an omitted validator manifest',async()=>{
  const f=bindingFixture(),composition=await openRegisteredBindings(f.path,'test'),store=new RuntimeStore(join(f.dir,'stage-state'),'test');
  try{
    const validation=await validateBindings(f.definition(),actor,composition.provider);assert.equal(validation.ready,false);
    await assert.rejects(()=>composition.executor(store).prepare({},'candidate',actor,AbortSignal.timeout(1000)),{code:'TOOLCHAIN_NOT_REGISTERED'});
    assert.equal(store.revision('alpha'),0);
  }finally{composition.close();store.close();f.cleanup();}
});
test('GitHub runner binding rejects a wrong workflow label and mismatched completed job runner',()=>withNetwork('github',async f=>{
  const bytes=Buffer.from(content.toString().replace('ubuntu-latest','windows-latest')),file=f.routes.get(f.base+'/contents/'+f.p.workflowPath+'?ref='+commit);
  file.content=bytes.toString('base64');file.size=bytes.length;file.sha=createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');
  await assert.rejects(()=>f.client.readiness(actor,AbortSignal.timeout(5000)),{code:'RUNNER_NOT_READY'});
  f.routes.get(f.base+'/actions/jobs/24').labels=['windows-latest'];await assert.rejects(()=>f.client.job(actor,'23','24',commit,AbortSignal.timeout(5000)),{code:'PLATFORM_RECEIPT_MISMATCH'});
}));

// Synthetic owner responses exercise the delivery and decision trust boundary;
// these tests are not actual project semantic review or final acceptance.
function feedbackFixture(){
  const f=fixture(),scope={visibility:'private',projectId:'alpha'},workspaceId='test';
  const hash=nativeSha256,pin=owner=>({product:owner,id:'synthetic-'+owner,version:'1.0.0',specVersion:'v1',visibility:'private',digest:hash({owner,asset:true}),standardDigest:hash({owner,standard:true}),standardLockDigest:hash({owner,lock:true}),producer:{product:owner,version:'0.3.0'},contractDigest:NATIVE_CONTRACT_DIGEST});
  const claimId=hash('synthetic-registered-claim'),body={schema:'evopilot-feedback-event/v1',id:hash({workspaceId,scope,claimId}),workspaceId,scope,projectId:'alpha',projectCandidateDigest:hash('candidate'),source:{direction:'reverse',locator:'synthetic:feedback-fixture',revision:'r1',treeDigest:hash('tree'),inventoryDigest:hash('inventory'),requirementsDigest:hash('requirements')},runId:'synthetic-run',runReviewDigest:hash('run-review'),claimId,inputDigest:hash('input'),receiptDigest:hash('receipt'),causeId:claimId,origin:'registered-runtime-run',stage:'SUCCEEDED',pins:{ontology:pin('ontology'),harness:pin('harness')},results:{ontology:{synthetic:true},harness:{synthetic:true}},collectionRefs:[],observation:{synthetic:true}};
  const event={...body,digest:hash(body)},principal={...actor,permissions:['read','execution.request']};
  const inboxes=new Map(),calls=[],controls={lost:false,unavailable:null,identity:1,source:event};
  function inbox(owner){const receiptBody={eventId:event.id,eventDigest:event.digest,owner,workspaceId,scope,candidateId:event.id+':'+owner},receipt={...receiptBody,digest:hash(receiptBody)};return{event,receipt,candidate:{id:receipt.candidateId,kind:owner==='ontology'?'semantic-impact':'regression',evidenceDigest:event.receiptDigest,status:'REVIEW_REQUIRED'},review:null,disposition:null};}
  function decide(owner,mode='REUSE',choice='APPROVE'){
    const value=inbox(owner),reference=mode==='REUSE'?event.pins[owner]:{...event.pins[owner],version:'1.1.0',digest:hash('next')};
    const body={mode,reference,rationale:'Synthetic owner review only',changes:mode==='REUSE'?[]:[{kind:'rule',identifiers:['rule'],sourcePaths:['source.md'],explanation:'Synthetic rule correction'}],eventId:event.id,eventDigest:event.digest,owner,workspaceId,scope,sourceDigest:hash(event.source),baseline:event.pins[owner],changedFiles:mode==='REUSE'?[]:['policy.rego'],dependentHarness:[]};
    value.review={...body,reviewDigest:hash(body)};const d={review:value.review,decision:choice,humanEvidenceRef:syntheticDecisionEvidence(f.dir,{owner,operation:'feedback.decide',workspaceId,scope,reviewDigest:value.review.reviewDigest,decision:choice})};
    value.disposition={...d,digest:hash(d)};return value;
  }
  const adapters=Object.fromEntries(['ontology','harness'].map(owner=>[owner,{owner,workspaceId,
    capabilities:()=>({registrationDigest:hash({owner,revision:controls.identity})}),
    read:async(_actor,_project,r)=>{calls.push({owner,operation:r.operation});if(controls.unavailable===owner)throw new ServiceError('OWNER_UNAVAILABLE','Synthetic outage',503);if(r.operation==='feedback.inspect')return{owner,workspaceId,scope,revision:0};const value=inboxes.get(owner);if(!value)throw new ServiceError('NOT_FOUND','Synthetic missing inbox',404);return structuredClone(value);},
    mutate:async(_actor,_project,r,p)=>{calls.push({owner,operation:r.operation,request:r,permit:p});assert.equal(p.requestDigest,ownerRequestDigest(owner,r));assert.equal(r.input.digest,event.digest);inboxes.set(owner,inbox(owner));if(controls.lost)throw new ServiceError('SYNTHETIC_RESPONSE_LOSS','Response lost',503);return{claimedPass:true};},
  }]));
  let store=new RuntimeStore(join(f.dir,'state'),workspaceId),service;
  const connect=()=>service=createOwnerFeedbackDelivery(store,{event:async()=>controls.source,owner:(_e,owner)=>adapters[owner]});connect();
  const permit=async()=>({actor:principal,authorityRef:'authority:synthetic-fixture-only',expiresAt:'2030-01-01T00:00:00Z'});
  const signal=()=>AbortSignal.timeout(5000),retain=()=>service.retain(principal,'alpha',event.id,signal());
  const deliver=(owner='ontology',grant=permit,s=signal())=>service.deliver(principal,'alpha',event.id,owner,grant,s);
  const inspect=(owner='ontology')=>service.inspect(actor,'alpha',event.id,owner,signal());
  return{...f,event,principal,controls,calls,inboxes,adapters,inbox,decide,retain,deliver,inspect,signal,get service(){return service;},get store(){return store;},restart(){store.close();store=new RuntimeStore(join(f.dir,'state'),workspaceId);connect();},cleanup(){store.close();f.cleanup();}};
}
test('feedback consumes an exact registered event, independently reads inbox and leaves delivery at REVIEW_REQUIRED',async()=>{
  const f=feedbackFixture();try{
    await f.retain();const observation=await f.deliver();assert.equal(observation.status,'REVIEW_REQUIRED');assert.equal(observation.softwareRelease,false);
    assert.equal(f.calls.filter(x=>x.operation==='feedback.ingest').length,1);assert.equal(f.calls.at(-1).operation,'feedback.read');
    await f.deliver();assert.equal(f.calls.filter(x=>x.operation==='feedback.ingest').length,1);
    const d=f.store.object('alpha','owner-feedback-delivery',f.event.id+':ontology');assert.equal(d.initiatedBy.id,'fixture');assert.equal(d.request.input.id,f.event.id);
    assert.equal(f.store.object('alpha','owner-feedback-permit',f.event.id+':ontology').requestDigest,d.requestDigest);
  }finally{f.cleanup();}
});
test('feedback response loss survives restart and reconciles original owner receipt without redispatch',async()=>{
  const f=feedbackFixture();try{
    await f.retain();f.controls.lost=true;assert.equal((await f.deliver()).status,'UNKNOWN');f.restart();
    assert.equal((await f.inspect()).status,'REVIEW_REQUIRED');assert.equal((await f.deliver()).status,'REVIEW_REQUIRED');assert.equal(f.calls.filter(x=>x.operation==='feedback.ingest').length,1);
  }finally{f.cleanup();}
});
test('feedback interrupted before dispatch keeps its original plan and never treats absence as permission to retry',async()=>{
  const f=feedbackFixture();try{
    await f.retain();assert.equal((await f.deliver('ontology',async()=>{throw new ServiceError('AUTHORITY_REVOKED','Synthetic revocation',403);})).status,'UNKNOWN');
    f.restart();assert.equal((await f.inspect()).status,'UNKNOWN');assert.equal((await f.deliver()).status,'UNKNOWN');assert.equal(f.calls.filter(x=>x.operation==='feedback.ingest').length,0);
  }finally{f.cleanup();}
});
test('feedback cancellation while permit is pending prevents late owner mutation',async()=>{
  const f=feedbackFixture(),controller=new AbortController();let release,entered;
  const waiting=new Promise(resolve=>entered=resolve);try{
    await f.retain();const pending=f.deliver('ontology',()=>{entered();return new Promise(resolve=>release=resolve);},controller.signal);await waiting;controller.abort();
    assert.equal((await pending).status,'UNKNOWN');release({actor:f.principal,authorityRef:'synthetic',expiresAt:'2030-01-01T00:00:00Z'});await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.calls.filter(x=>x.operation==='feedback.ingest').length,0);
  }finally{f.cleanup();}
});
test('concurrent feedback delivery permits at most one owner write',async()=>{
  const f=feedbackFixture();try{
    await f.retain();await Promise.all([f.deliver(),f.deliver(),f.deliver()]);assert.equal(f.calls.filter(x=>x.operation==='feedback.ingest').length,1);
  }finally{f.cleanup();}
});
test('partial owner delivery keeps the successful inbox and leaves the other owner pending',async()=>{
  const f=feedbackFixture();try{
    await f.retain();await f.deliver('ontology');f.controls.unavailable='harness';await assert.rejects(()=>f.deliver('harness'),{code:'OWNER_UNAVAILABLE'});
    assert.equal((await f.inspect('ontology')).status,'REVIEW_REQUIRED');assert.equal(f.inboxes.has('harness'),false);
    f.controls.unavailable=null;assert.equal((await f.deliver('harness')).status,'REVIEW_REQUIRED');assert.equal(f.calls.filter(x=>x.operation==='feedback.ingest').length,2);
  }finally{f.cleanup();}
});
test('feedback scope, registration drift and current write permission are independently checked',async()=>{
  const f=feedbackFixture();try{
    await assert.rejects(()=>f.service.retain(actor,'alpha',f.event.id,f.signal()),{code:'FORBIDDEN'});
    await f.retain();await assert.rejects(()=>f.service.inspect(actor,'beta',f.event.id,'ontology',f.signal()),{code:'FORBIDDEN'});
    const source={...f.event,projectId:'beta'};delete source.digest;f.controls.source={...source,digest:nativeSha256(source)};await assert.rejects(()=>f.retain(),{code:'FEEDBACK_SCOPE'});
    assert.equal((await f.deliver('ontology',async()=>{f.controls.identity++;return{actor:f.principal,authorityRef:'synthetic',expiresAt:'2030-01-01T00:00:00Z'};})).status,'UNKNOWN');assert.equal(f.calls.filter(x=>x.operation==='feedback.ingest').length,0);
  }finally{f.cleanup();}
});
for(const owner of ['ontology','harness'])test(owner+' feedback distinguishes exact REUSE, rejection and DELIVER without granting software release',()=>{
  const f=feedbackFixture();try{
    assert.equal(verifyOwnerFeedbackInbox(f.inbox(owner),f.event,owner).status,'REVIEW_REQUIRED');
    for(const [mode,decision,status] of [['REUSE','APPROVE','REUSE_APPROVED'],['REUSE','REJECT','REJECTED'],['DELIVER','APPROVE','REBIND_REQUIRED']]){
      const result=verifyOwnerFeedbackInbox(f.decide(owner,mode,decision),f.event,owner);assert.equal(result.status,status);assert.equal(result.softwareRelease,false);assert(result.dispositionDigest);
    }
  }finally{f.cleanup();}
});
test('owner feedback validation rejects substituted events, receipts, candidates, review pins and unattested approval',()=>{
  const f=feedbackFixture();try{
    const mutations=[v=>v.event.projectId='beta',v=>v.receipt.owner='harness',v=>v.candidate.status='APPROVED',v=>v.review.baseline.version='9.0.0',v=>v.disposition.decision='PASS',v=>v.disposition.review.rationale='changed'];
    for(const mutate of mutations){const value=structuredClone(f.decide('ontology'));mutate(value);assert.throws(()=>verifyOwnerFeedbackInbox(value,f.event,'ontology'));}
    const value=f.decide('ontology');value.disposition.humanEvidenceRef='file:///unavailable';const {digest,...body}=value.disposition;value.disposition.digest=nativeSha256(body);
    assert.throws(()=>verifyOwnerFeedbackInbox(value,f.event,'ontology'),{code:'FEEDBACK_DECISION_EVIDENCE'});
    const missing=f.decide('ontology');missing.review=null;assert.throws(()=>verifyOwnerFeedbackInbox(missing,f.event,'ontology'),{code:'FEEDBACK_REVIEW_REQUIRED'});
  }finally{f.cleanup();}
});
test('owner feedback approval ceases to verify when retained decision source bytes disappear',()=>{
  const f=feedbackFixture();try{
    const value=f.decide('ontology');assert.equal(verifyOwnerFeedbackInbox(value,f.event,'ontology').status,'REUSE_APPROVED');
    rmSync(join(f.dir,'synthetic-decision-evidence'),{recursive:true});assert.throws(()=>verifyOwnerFeedbackInbox(value,f.event,'ontology'),{code:'FEEDBACK_DECISION_EVIDENCE'});
  }finally{f.cleanup();}
});
test('feedback receipt recovery cannot silently move to a changed owner connection',async()=>{
  const f=feedbackFixture();try{
    await f.retain();await f.deliver();f.restart();f.controls.identity++;
    await assert.rejects(()=>f.inspect(),{code:'FEEDBACK_CONNECTION_CHANGED'});
    await assert.rejects(()=>f.deliver(),{code:'FEEDBACK_CONNECTION_CHANGED'});
    assert.equal(f.calls.filter(x=>x.operation==='feedback.ingest').length,1);
  }finally{f.cleanup();}
});
test('feedback refuses changed registered event content and raw credentials without overwriting history',async()=>{
  const f=feedbackFixture();try{
    await f.retain();const {digest,...body}=f.event,changed={...body,receiptDigest:nativeSha256('different-run-receipt')};f.controls.source={...changed,digest:nativeSha256(changed)};
    await assert.rejects(()=>f.retain(),{code:'FEEDBACK_EVENT_CHANGED'});
    assert.deepEqual(await f.service.readEvent(actor,'alpha',f.event.id),f.event);
    const secret={...body,observation:{apiKey:'synthetic-key-never-send'}};f.controls.source={...secret,digest:nativeSha256(secret)};
    await assert.rejects(()=>f.retain(),{code:'INLINE_SECRET'});assert.equal(f.calls.length,0);
  }finally{f.cleanup();}
});
