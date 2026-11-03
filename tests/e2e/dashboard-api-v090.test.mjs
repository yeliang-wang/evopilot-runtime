import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {initializeCredentials,tokenDigest} from '../../dist/server/security.js';
import {startRuntimeServer} from '../../dist/server/http.js';
import {RuntimeStore} from '../../dist/server/store.js';
import {compileLifecycle} from '../../dist/lifecycle/compiler.js';
import {valueDigest} from '../../dist/lifecycle/base.js';
import {pinInstance,requiredChecksDigest} from '../../dist/lifecycle/instance.js';
import {lifecycle,yaml,syntheticBindings} from '../fixtures/lifecycle-v090.mjs';
async function fixture(t,{instances=0}={}){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'runtime-browser-')),stateRoot=join(root,'state'),tokens={activator:randomBytes(32).toString('base64url'),reader:randomBytes(32).toString('base64url')};
 const principals=Object.entries(tokens).map(([id,token])=>({id,projects:['alpha','beta'],permissions:id==='reader'?['read']:['read','draft.write','definition.activate'],revision:1,expiresAt:'2030-01-01T00:00:00Z',tokenDigest:tokenDigest(token)}));
 initializeCredentials(stateRoot,'browser',principals);
 if(instances){const s=new RuntimeStore(stateRoot,'browser'),actor=principals[0],definition=compileLifecycle(yaml(lifecycle()),'alpha').effective,revisionId=valueDigest({synthetic:'old-definition'});
  for(let i=0;i<instances;i++){const id='instance-'+String(i).padStart(3,'0'),a={projectId:'alpha',instanceId:id,definitionRevisionId:revisionId,semanticDigest:definition.semanticDigest,goalRef:'synthetic:goal',targetRef:'synthetic:target',loopRef:'synthetic:loop',requirementsDigest:requiredChecksDigest(definition),budget:{timeoutSeconds:60,maxAttempts:1,maxConcurrency:1,maxLoops:1},evidenceRef:'synthetic:authority',revision:'1',expiresAt:actor.expiresAt};s.mutate(actor,{projectId:'alpha',requestId:id,expectedRevision:i,operation:'synthetic.fixture',input:{},permission:'draft.write'},()=>({value:{},objects:[{kind:'lifecycle-instance',id,value:pinInstance(id,revisionId,definition,a)}],event:{type:'synthetic-instance',data:{mustNotReachMonitor:'PRIVATE_EDITOR_PAYLOAD'}}}));}s.close();}
 const bindings=syntheticBindings();let server=await startRuntimeServer({stateRoot,workspaceId:'browser'},bindings.provider);
 t.after(async()=>{await server.close();rmSync(root,{recursive:true,force:true});});
 async function request(path,{method='GET',body,headers={}}={}){const r=await fetch(server.url+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,headers:r.headers,value:await r.json()};}
 async function connect(id='activator',projectId='alpha'){const issue=await request('/api/v1/dashboard-code',{method:'POST',body:{projectId},headers:{authorization:'Bearer '+tokens[id]}});assert.equal(issue.status,200);const exchange=await request('/api/v1/dashboard/session',{method:'POST',body:{code:issue.value.result.code},headers:{origin:server.url}});assert.equal(exchange.status,200);const cookie=exchange.headers.get('set-cookie').split(';')[0],csrf=exchange.value.result.csrf;return{cookie,csrf,async call(operation,input={},extra={}){return request('/api/v1/dashboard/request',{method:'POST',body:{operation,projectId,input,...extra},headers:{cookie,origin:server.url,'x-runtime-csrf':csrf}});}};}
 return{root,stateRoot,tokens,principals,bindings,request,connect,url:()=>server.url,async restart(){await server.close();server=await startRuntimeServer({stateRoot,workspaceId:'browser'},bindings.provider);}};
}
test('browser code requires bearer, exchange requires same origin, cookies cannot authenticate MCP or Agent API',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/api/v1/dashboard-code',{method:'POST',body:{projectId:'alpha'}})).status,401);
 const issue=await f.request('/api/v1/dashboard-code',{method:'POST',body:{projectId:'alpha'},headers:{authorization:'Bearer '+f.tokens.reader}});
 for(const headers of [{},{origin:'https://attacker.example'}])assert.equal((await f.request('/api/v1/dashboard/session',{method:'POST',body:{code:issue.value.result.code},headers})).status,403);
 const s=await f.connect();assert.equal((await f.request('/api/v1/status?projectId=alpha',{headers:{cookie:s.cookie}})).status,401);
 assert.equal((await f.request('/mcp',{method:'POST',body:{jsonrpc:'2.0',id:1,method:'tools/list'},headers:{cookie:s.cookie}})).status,401);
 assert.equal((await f.request('/api/v1/dashboard/request',{method:'POST',body:{operation:'runtime.status',projectId:'alpha',input:{}},headers:{cookie:s.cookie,origin:f.url()}})).status,400);
 assert.equal((await s.call('runtime.status')).status,200);
});
test('editor save and same-entry activation use original validator, CAS and request receipts; browser exposes no execution',async t=>{
 const f=await fixture(t),s=await f.connect(),source='# Keep this comment\n'+yaml(lifecycle());
 const saved=await s.call('lifecycle.draft.save',{yaml:source},{requestId:'draft',expectedRevision:0});assert.equal(saved.status,200);assert.equal(saved.value.result.result.status,'DRAFT');
 const preview=await s.call('lifecycle.definition.validate',{yaml:source});assert.equal(preview.value.result.ready,true);
 const activated=await s.call('lifecycle.definition.save-and-activate',{yaml:source,validationDigest:preview.value.result.validationDigest},{requestId:'activate',expectedRevision:1});assert.equal(activated.value.result.result.status,'ACTIVE');
 const repeat=await s.call('lifecycle.definition.save-and-activate',{yaml:source,validationDigest:preview.value.result.validationDigest},{requestId:'activate',expectedRevision:0});assert.deepEqual(repeat.value.result,activated.value.result);
 assert.equal((await s.call('lifecycle.draft.save',{yaml:source+'\n# concurrent'},{requestId:'stale',expectedRevision:0})).value.error.code,'REVISION_CONFLICT');
 for(const operation of ['lifecycle.instance.create','lifecycle.stage.request','runtime.legacy.write','lifecycle.authority.decide'])assert.equal((await s.call(operation,{})).value.error.code,'DASHBOARD_OPERATION');
 const read=await s.call('lifecycle.definition.source.read',{revisionId:activated.value.result.result.revisionId});assert.equal(Buffer.from(read.value.result.data,'base64').toString(),source);
 f.bindings.state.mode='unknown';const blocked=await s.call('lifecycle.definition.save-and-activate',{yaml:source+'\n# blocked change',validationDigest:null},{requestId:'blocked',expectedRevision:2});assert.equal(blocked.value.result.result.status,'BLOCKED');assert.equal(blocked.value.result.result.activeRevisionId,activated.value.result.result.revisionId);
});
test('reader and cross-project calls cannot write; credential rotation revokes existing browser session',async t=>{
 const f=await fixture(t),s=await f.connect('reader');assert.equal((await s.call('lifecycle.draft.save',{yaml:'x'},{requestId:'no',expectedRevision:0})).status,403);
 const cross=await f.request('/api/v1/dashboard/request',{method:'POST',body:{operation:'runtime.status',projectId:'beta',input:{}},headers:{cookie:s.cookie,origin:f.url(),'x-runtime-csrf':s.csrf}});assert.equal(cross.status,403);
 const auth=JSON.parse(readFileSync(join(f.stateRoot,'auth.json')));auth.principals.find(p=>p.id==='reader').tokenDigest=tokenDigest(randomBytes(32).toString('base64url'));writeFileSync(join(f.stateRoot,'auth.json'),JSON.stringify(auth));
 assert.equal((await f.request('/api/v1/dashboard/session',{headers:{cookie:s.cookie}})).status,401);
});
test('monitor pagination preserves pinned graph and original pending state and never includes YAML or editor payload',async t=>{
 const f=await fixture(t,{instances:51}),s=await f.connect('reader'),headers={cookie:s.cookie};const one=await f.request('/api/v1/dashboard/monitor',{headers});assert.equal(one.status,200);assert.equal(one.value.result.instances.length,50);assert.equal(one.value.result.nextAfter,'instance-049');
 const two=await f.request('/api/v1/dashboard/monitor?after='+one.value.result.nextAfter+'&revision='+one.value.result.revision,{headers});assert.equal(two.value.result.instances.length,1);assert.equal(two.value.result.nextAfter,null);
 assert.equal((await f.request('/api/v1/dashboard/monitor?after=instance-049&revision=0',{headers})).value.error.code,'MONITOR_REVISION_CHANGED');
 const all=one.value.result.instances;assert(all.every(i=>Object.values(i.stages).every(s=>s.status==='PENDING')));assert(!JSON.stringify(one.value).includes('yaml'));assert(!JSON.stringify(one.value).includes('semantic'));assert(!JSON.stringify(one.value).includes('credential'));
 const stream=await fetch(f.url()+'/api/v1/dashboard/events',{headers});const reader=stream.body.getReader();const first=await reader.read();await reader.cancel();const text=new TextDecoder().decode(first.value);assert.match(text,/synthetic-instance/);assert(!text.includes('PRIVATE_EDITOR_PAYLOAD'));assert(!text.includes('"data":'));
 await f.restart();assert.equal((await f.request('/api/v1/dashboard/session',{headers})).status,401);const renewed=await f.connect('reader');const readback=await f.request('/api/v1/dashboard/monitor',{headers:{cookie:renewed.cookie}});assert.deepEqual(readback.value.result.instances,all);
});
