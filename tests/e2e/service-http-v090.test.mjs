import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, realpathSync, chmodSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { initializeCredentials, tokenDigest, authenticate } from '../../dist/server/security.js';
import { RuntimeStore } from '../../dist/server/store.js';
import { startRuntimeServer } from '../../dist/server/http.js';
import {canonical,canonicalEvidence,canonicalReadback,evidenceValueDigest,EVIDENCE_MAX_BYTES} from '../../dist/server/errors.js';
import {valueDigest} from '../../dist/lifecycle/base.js';

test('original evidence serialization preserves old digests and keeps request/page, depth and structure limits separate',()=>{
  const small={z:[1,true,null],a:'original'};
  assert.equal(canonicalEvidence(small),canonical(small));assert.equal(evidenceValueDigest(small),valueDigest(small));
  const original={stdout:'x'.repeat(300000)};
  assert.deepEqual(JSON.parse(canonicalEvidence(original)),original);
  for(const operation of ['runtime.projects.list','runtime.events.read','lifecycle.definition.read','unknown'])assert.throws(()=>canonicalReadback(operation,original),{code:'INPUT_LIMIT'});
  assert.equal(canonicalReadback('lifecycle.plan.evidence.read',original),canonicalEvidence(original));
  assert.throws(()=>canonicalEvidence({stdout:'x'.repeat(EVIDENCE_MAX_BYTES)}),{code:'INPUT_LIMIT'});
  assert.throws(()=>canonicalEvidence(Array(200001).fill(0)),{code:'INPUT_LIMIT'});
  let deep={};for(let i=0;i<34;i++)deep={child:deep};assert.throws(()=>canonicalEvidence(deep),{code:'INPUT_LIMIT'});
  assert.throws(()=>canonicalEvidence(JSON.parse('{"__proto__":{}}')),{code:'INVALID_INPUT'});
});

test('large original native evidence survives restart; untrusted records and requests retain the small limit with atomic rollback',()=>{
  const f=fixture();let s=new RuntimeStore(f.root,'test');
  try{
    const receipt={result:{stdout:'original native output\n'.repeat(20000)}};
    s.mutate(f.actor,mutation(),()=>({value:{digest:evidenceValueDigest(receipt)},objects:[{kind:'stage-native-receipt',id:'original',value:receipt}],event:{type:'fixture-written',data:{original:true}}}));
    s.close();s=new RuntimeStore(f.root,'test');assert.deepEqual(s.object('alpha','stage-native-receipt','original'),receipt);
    assert.throws(()=>s.mutate(f.actor,{...mutation('large-input',1),input:receipt},()=>change()),{code:'INPUT_LIMIT'});
    assert.throws(()=>s.mutate(f.actor,mutation('ordinary-object',1),()=>({value:{},objects:[{kind:'stage-native-receipt',id:'uncommitted',value:receipt},{kind:'fixture',id:'untrusted',value:receipt}],event:{type:'fixture-written',data:{}}})),{code:'INPUT_LIMIT'});
    assert.equal(s.revision('alpha'),1);assert.equal(s.object('alpha','stage-native-receipt','uncommitted'),null);
    assert.throws(()=>s.mutate(f.actor,mutation('too-large-evidence',1),()=>({value:{},objects:[{kind:'stage-native-receipt',id:'large',value:{stdout:'x'.repeat(EVIDENCE_MAX_BYTES)}}],event:{type:'fixture-written',data:{}}})),{code:'INPUT_LIMIT'});
    assert.equal(s.revision('alpha'),1);
  }finally{s.close();f.cleanup();}
});

test('HTTP and actual Streamable MCP read the same bounded original plan evidence without granting cross-project or request-size access',async()=>{
  const f=fixture();let s=new RuntimeStore(f.root,'test'),server;const client=new Client({name:'original-evidence-probe',version:'1'});
  try{
    // Synthetic retained bytes test transport/recovery only, never native PASS.
    const id='original',requestDigest=valueDigest('synthetic request'),planDigest=valueDigest('synthetic plan'),body={requestDigest,planDigest},input={...body,digest:valueDigest(body)},receipt={result:{stdout:'synthetic original output\n'.repeat(16000)}};
    s.mutate(f.actor,mutation(),()=>({value:{retained:true},objects:[{kind:'plan-stage-input',id,value:input},{kind:'stage-request',id,value:{id,projectId:'alpha',workspaceId:'test',stageId:'plan',digest:requestDigest,planDigest}},{kind:'plan-stage-native-receipt',id:id+':harness',value:receipt}],event:{type:'fixture-written',data:{}}}));
    s.close();s=null;server=await startRuntimeServer({stateRoot:f.root,workspaceId:'test'});
    const http=await request(server,f.token,'lifecycle.plan.evidence.read','alpha',{stageRequestId:id});assert.equal(http.status,200);assert.deepEqual(http.body.result.owners.harness.receipt,receipt);assert(Buffer.byteLength(JSON.stringify(http.body))>262144);
    assert.equal((await request(server,f.other,'lifecycle.plan.evidence.read','alpha',{stageRequestId:id})).status,403);
    assert.equal((await request(server,f.token,'lifecycle.plan.evidence.read','alpha',{stageRequestId:id,untrusted:'x'.repeat(300000)})).status,413);
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+f.token}}}));
    const result=await client.callTool({name:'runtime_read',arguments:{operation:'lifecycle.plan.evidence.read',projectId:'alpha',input:{stageRequestId:id}}});assert.notEqual(result.isError,true);assert.deepEqual(JSON.parse(result.content[0].text).result,http.body.result);
  }finally{await client.close();await server?.close();s?.close();f.cleanup();}
});

function fixture() {
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'runtime-v090-http-')),root=join(dir,'state');
  const token=randomBytes(32).toString('hex'), other=randomBytes(32).toString('hex');
  const actor={id:'fixture',projects:['alpha','beta'],permissions:['read','draft.write'],revision:1,expiresAt:'2030-01-01T00:00:00Z'};
  initializeCredentials(root,'test',[{...actor,tokenDigest:tokenDigest(token)},{id:'reader',projects:['beta'],permissions:['read'],revision:1,expiresAt:actor.expiresAt,tokenDigest:tokenDigest(other)}]);
  return {dir,root,token,other,actor,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
const mutation=(requestId='one',expectedRevision=0)=>({projectId:'alpha',operation:'fixture.write',requestId,expectedRevision,input:{synthetic:true},permission:'draft.write'});
const change=(value=1)=>({value:{value},objects:[{kind:'fixture',id:'one',value:{value}}],event:{type:'fixture-written',data:{value}}});
async function request(server,token,operation='runtime.status',projectId='alpha',input={}) {
  const response=await fetch(server.url+'/api/v1/request',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({operation,projectId,input})});
  return {status:response.status,body:await response.json()};
}
function worker(f,mode) { return spawn(process.execPath,[new URL('../fixtures/service-v090-worker.mjs',import.meta.url).pathname,mode,f.root,'test'],{stdio:['ignore','pipe','pipe']}); }
function rawStatus(url,headers) { return new Promise((resolve,reject)=>{
  const req=httpRequest(url,{headers},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});req.once('error',reject);req.end();
}); }

test('service store atomically retains object, audit, receipt, events and exact replay across restart',()=>{
  const f=fixture();let s=new RuntimeStore(f.root,'test');
  try {
    const receipt=s.mutate(f.actor,mutation(),()=>change());
    assert.equal(receipt.revision,1);assert.deepEqual(s.object('alpha','fixture','one'),{value:1});
    assert.deepEqual(s.mutate(f.actor,mutation(),()=>{throw Error('must not execute replay');}),receipt);
    assert.throws(()=>s.mutate(f.actor,{...mutation(),input:{different:true}},()=>change()),{code:'REQUEST_CONFLICT'});
    assert.throws(()=>s.mutate(f.actor,mutation('two',0),()=>change()),{code:'REVISION_CONFLICT'});
    s.close();s=new RuntimeStore(f.root,'test');
    assert.deepEqual(s.receipt(f.actor,'alpha','one'),receipt);assert.equal(s.events(f.actor,'alpha').events.length,1);
    const db=new DatabaseSync(join(f.root,'service.sqlite'),{readOnly:true});
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit').get().n,1);db.close();
  } finally{s.close();f.cleanup();}
});

test('failed callback and revoked transaction authority leave no partial object, audit, event or receipt',()=>{
  const f=fixture(),s=new RuntimeStore(f.root,'test');
  try {
    assert.throws(()=>s.mutate(f.actor,mutation(),()=>{throw Error('fixture fault');}),/fixture fault/);
    assert.throws(()=>s.mutate(f.actor,mutation(),()=>change(),()=>({...f.actor,permissions:['read'],revision:2})),{code:'FORBIDDEN'});
    assert.equal(s.revision('alpha'),0);assert.equal(s.object('alpha','fixture','one'),null);assert.equal(s.events(f.actor,'alpha').events.length,0);
    assert.throws(()=>s.receipt(f.actor,'alpha','one'),{code:'NOT_FOUND'});
  } finally{s.close();f.cleanup();}
});

for(const phase of ['before','after'])test('OS crash '+phase+' commit recovers transaction and single-writer lock without redispatch',async()=>{
  const f=fixture();let s;
  try {
    const child=worker(f,'crash-'+phase+'-commit');
    const [code,signal]=await once(child,'exit',{signal:AbortSignal.timeout(10000)});
    assert.equal(signal,'SIGKILL');assert.equal(code,null);
    s=new RuntimeStore(f.root,'test');
    assert.equal(s.revision('alpha'),phase==='after'?1:0);
    if(phase==='after'){
      assert.equal(s.receipt(f.actor,'alpha','worker-write').revision,1);
      assert.equal(s.events(f.actor,'alpha').events.length,1);
    }else{assert.equal(s.object('alpha','fixture','one'),null);assert.equal(s.events(f.actor,'alpha').events.length,0);}
  } finally{s?.close();f.cleanup();}
});

test('live second writer is rejected, killed writer releases OS lock and retains committed evidence',async()=>{
  const f=fixture();let s,child;
  try {
    child=worker(f,'hold');await once(child.stdout,'data',{signal:AbortSignal.timeout(10000)});
    assert.throws(()=>new RuntimeStore(f.root,'test'),{code:'WRITER_ACTIVE'});
    const exit=once(child,'exit');child.kill('SIGKILL');await exit;
    s=new RuntimeStore(f.root,'test');assert.equal(s.revision('alpha'),1);
  }finally{if(child?.exitCode===null && child?.signalCode===null)child.kill('SIGKILL');s?.close();f.cleanup();}
});

test('unknown schema and wrong workspace fail without silently adopting state',()=>{
  const f=fixture();let s=new RuntimeStore(f.root,'test');s.close();
  try {
    assert.throws(()=>new RuntimeStore(f.root,'other'),{code:'WRONG_WORKSPACE'});
    const db=new DatabaseSync(join(f.root,'service.sqlite'));db.exec('PRAGMA user_version=99;');db.close();
    assert.throws(()=>new RuntimeStore(f.root,'test'),{code:'INCOMPATIBLE_STATE'});
    const read=new DatabaseSync(join(f.root,'service.sqlite'),{readOnly:true});assert.equal(read.prepare('PRAGMA user_version').get().user_version,99);read.close();
  }finally{f.cleanup();}
});

test('restart detects forged receipt contents and a missing required table',()=>{
  const f=fixture(),s=new RuntimeStore(f.root,'test');s.mutate(f.actor,mutation(),()=>change());s.close();
  try{
    const db=new DatabaseSync(join(f.root,'service.sqlite'));
    const saved=db.prepare('SELECT data FROM receipts').get().data;
    const forged=JSON.parse(saved);forged.result.value=999;db.prepare('UPDATE receipts SET data=?').run(JSON.stringify(forged));db.close();
    assert.throws(()=>new RuntimeStore(f.root,'test'),{code:'CORRUPT_STATE'});
    const repair=new DatabaseSync(join(f.root,'service.sqlite'));repair.prepare('UPDATE receipts SET data=?').run(saved);const originalEvent=repair.prepare('SELECT data FROM events').get().data;repair.prepare('UPDATE events SET data=?').run('{"forged":true}');repair.close();
    assert.throws(()=>new RuntimeStore(f.root,'test'),{code:'CORRUPT_STATE'});
    const missingTable=new DatabaseSync(join(f.root,'service.sqlite'));missingTable.prepare('UPDATE events SET data=?').run(originalEvent);missingTable.exec('DROP TABLE audit;');missingTable.close();
    assert.throws(()=>new RuntimeStore(f.root,'test'),{code:'CORRUPT_STATE'});
  }finally{f.cleanup();}
});

test('event pagination is bounded, persistent and rejects forged or cross-project cursors',()=>{
  const f=fixture(),s=new RuntimeStore(f.root,'test');
  try{
    for(let i=0;i<63;i++)s.mutate(f.actor,mutation('event-'+i,i),()=>change(i));
    const first=s.events(f.actor,'alpha');assert.equal(first.events.length,50);
    const second=s.events(f.actor,'alpha',first.cursor);assert.equal(second.events.length,13);
    assert.equal(s.events(f.actor,'alpha',second.cursor).events.length,0);
    assert.throws(()=>s.events(f.actor,'beta',first.cursor),{code:'INVALID_CURSOR'});
    assert.throws(()=>s.events(f.actor,'alpha',first.cursor+'z'),{code:'INVALID_CURSOR'});
    assert.ok(Buffer.byteLength(JSON.stringify(first))<=262144);
  }finally{s.close();f.cleanup();}
});

test('HTTP binds authenticated scope and reads revocation on the next request without restart',async()=>{
  const f=fixture(),server=await startRuntimeServer({stateRoot:f.root,workspaceId:'test'});
  try{
    let r=await request(server,f.token);assert.equal(r.status,200);assert.equal(r.body.result.independentLlm,false);assert.equal(r.body.result.projectId,'alpha');assert.equal(r.body.result.productAcceptance,'NOT_EVALUATED');
    assert.equal((await request(server,f.other)).status,403);
    assert.equal((await request(server,'x'.repeat(64))).status,401);
    assert.equal((await request(server,f.token,'runtime.status','alpha',{unknown:true})).status,400);
    assert.equal((await request(server,f.token,'definition.activate')).status,404);
    const config=JSON.parse(readFileSync(join(f.root,'auth.json'),'utf8'));config.principals[0].permissions=['draft.write'];config.principals[0].revision++;
    writeFileSync(join(f.root,'auth.json'),JSON.stringify(config));
    assert.equal((await request(server,f.token)).status,403);
    config.principals[0].expiresAt='2020-01-01T00:00:00Z';writeFileSync(join(f.root,'auth.json'),JSON.stringify(config));
    assert.equal((await request(server,f.token)).status,401);
  }finally{await server.close();f.cleanup();}
});

test('HTTP rejects foreign Host/Origin, URL credentials, unknown headers and oversized or malformed inputs',async()=>{
  const f=fixture(),server=await startRuntimeServer({stateRoot:f.root,workspaceId:'test'});
  const headers={authorization:'Bearer '+f.token,'content-type':'application/json'};
  try{
    for(const extra of [{host:'evil.example'},{origin:'https://evil.example'},{'sec-fetch-site':'cross-site'}]){
      assert.equal(await rawStatus(server.url+'/api/v1/status?projectId=alpha',{...headers,...extra}),403,JSON.stringify(Object.keys(extra)));
    }
    assert.equal((await fetch(server.url+'/api/v1/status?projectId=alpha&token=secret',{headers})).status,400);
    assert.equal((await fetch(server.url+'/api/v1/request',{method:'POST',headers,body:'{bad'})).status,400);
    assert.equal((await fetch(server.url+'/api/v1/request',{method:'POST',headers,body:JSON.stringify({large:'x'.repeat(262144)})})).status,413);
    assert.equal((await fetch(server.url+'/api/v1/request',{method:'POST',headers:{...headers,'content-type':'text/plain'},body:'{}'})).status,415);
    assert.equal((await fetch(server.url+'/api/v1/request',{method:'POST',headers,body:'{"__proto__":{}}'})).status,400);
  }finally{await server.close();f.cleanup();}
});

for(const version of ['2025-06-18','2025-11-25','unsupported-proposal'])test('actual Streamable HTTP negotiation and scoped tool call: '+version,async()=>{
  const f=fixture(),server=await startRuntimeServer({stateRoot:f.root,workspaceId:'test'});
  const headers={authorization:'Bearer '+f.token,'content-type':'application/json',accept:'application/json, text/event-stream'};
  try{
    let r=await fetch(server.url+'/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:version,capabilities:{},clientInfo:{name:'synthetic-protocol-client',version:'1'}}})});
    assert.equal(r.status,200);const reply=await r.json();assert.equal(reply.result.protocolVersion,version==='unsupported-proposal'?'2025-11-25':version);
    r=await fetch(server.url+'/mcp',{method:'POST',headers:{...headers,'mcp-protocol-version':reply.result.protocolVersion},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'runtime_read',arguments:{operation:'runtime.status',projectId:'beta',input:{}}}})});
    const tool=await r.json();const content=JSON.parse(tool.result.content[0].text);assert.equal(content.result.projectId,'beta');assert.equal(content.requestId,r.headers.get('x-request-id'));
    assert.equal((await fetch(server.url+'/mcp',{method:'POST',headers:{...headers,'mcp-protocol-version':'unsupported'},body:'{}'})).status,400);
  }finally{await server.close();f.cleanup();}
});

test('official SDK client uses the same dispatcher and cannot read a project outside its credential',async()=>{
  const f=fixture(),server=await startRuntimeServer({stateRoot:f.root,workspaceId:'test'});
  const client=new Client({name:'sdk-acceptance',version:'1'});
  const transport=new StreamableHTTPClientTransport(new URL(server.url+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+f.other}}});
  try{
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['runtime_read','runtime_write']);
    const ok=await client.callTool({name:'runtime_read',arguments:{operation:'runtime.status',projectId:'beta',input:{}}});
    assert.equal(JSON.parse(ok.content[0].text).result.projectId,'beta');
    const bad=await client.callTool({name:'runtime_read',arguments:{operation:'runtime.status',projectId:'alpha',input:{}}});
    assert.equal(bad.isError,true);assert.equal(JSON.parse(bad.content[0].text).error.code,'FORBIDDEN');
  }finally{await client.close();await server.close();f.cleanup();}
});

test('event stream reads persisted events and closes after permission revocation',async()=>{
  const f=fixture();const seed=new RuntimeStore(f.root,'test');seed.mutate(f.actor,mutation(),()=>change());seed.close();
  const server=await startRuntimeServer({stateRoot:f.root,workspaceId:'test'}),abort=new AbortController();
  try{
    const response=await fetch(server.url+'/api/v1/events?projectId=alpha',{headers:{authorization:'Bearer '+f.token},signal:abort.signal});
    assert.equal(response.status,200);const reader=response.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value),/fixture-written/);
    const config=JSON.parse(readFileSync(join(f.root,'auth.json'),'utf8'));config.principals=[];writeFileSync(join(f.root,'auth.json'),JSON.stringify(config));
    const next=await reader.read();assert.match(new TextDecoder().decode(next.value),/UNAUTHENTICATED/);assert.equal((await reader.read()).done,true);
  }finally{abort.abort();await server.close();f.cleanup();}
});

test('private credentials reject insecure permissions and symlinks',()=>{
  const f=fixture();const path=join(f.root,'auth.json');
  try{
    chmodSync(path,0o644);assert.throws(()=>authenticate(f.root,'test','Bearer '+f.token),{code:'UNSAFE_STATE'});
    chmodSync(path,0o600);renameSync(path,path+'.real');symlinkSync(path+'.real',path);assert.throws(()=>authenticate(f.root,'test','Bearer '+f.token),{code:'UNSAFE_STATE'});
  }finally{f.cleanup();}
});

test('port conflict does not disturb the other service and releases the failed installation writer',async()=>{
  const f=fixture(),other=fixture(),a=await startRuntimeServer({stateRoot:f.root,workspaceId:'test'});let b;
  try{
    await assert.rejects(startRuntimeServer({stateRoot:other.root,workspaceId:'test',port:a.port}),{code:'EADDRINUSE'});
    assert.equal((await request(a,f.token)).status,200);
    b=await startRuntimeServer({stateRoot:other.root,workspaceId:'test'});assert.equal((await request(b,other.token)).status,200);
  }finally{await b?.close();await a.close();f.cleanup();other.cleanup();}
});

test('independent CLI bootstraps protected reference, serves and reads real HTTP without raw command-line tokens',async()=>{
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'runtime-v090-cli-')),root=join(dir,'state');
  const cli=new URL('../../dist/server/cli.js',import.meta.url).pathname;
  const run=(args)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:15000});
  let child;
  try{
    const init=run(['auth-init','--state-root',root,'--workspace-id','cli-test','--project','alpha','--principal','tester','--role','activator']);
    assert.equal(init.status,0,init.stderr);const output=JSON.parse(init.stdout);
    assert.equal(output.executionAuthorized,false);assert.equal(output.releaseAuthorized,false);
    const credential=JSON.parse(readFileSync(output.tokenRef,'utf8'));assert.equal(init.stdout.includes(credential.token),false);
    child=spawn(process.execPath,[cli,'serve','--state-root',root,'--workspace-id','cli-test'],{stdio:['ignore','pipe','pipe']});
    const [bytes]=await once(child.stdout,'data',{signal:AbortSignal.timeout(10000)});const ready=JSON.parse(bytes.toString());assert.equal(ready.ready,true);
    // Do not block this process's own HTTP server: the CLI's server is an independent child.
    const status=run(['status','--url',ready.url,'--token-ref',output.tokenRef,'--project','alpha']);assert.equal(status.status,0,status.stderr);assert.equal(JSON.parse(status.stdout).result.workspaceId,'cli-test');
    const denied=run(['status','--url','https://example.invalid','--token-ref',output.tokenRef,'--project','alpha']);assert.equal(denied.status,1);assert.equal(JSON.parse(denied.stdout).error.code,'INVALID_URL');
    const stopped=once(child,'exit');child.kill('SIGTERM');assert.equal((await stopped)[0],0);
    const repeat=run(['auth-init','--state-root',root,'--workspace-id','cli-test','--project','alpha','--principal','tester','--role','activator']);assert.equal(repeat.status,1);assert.equal(JSON.parse(readFileSync(output.tokenRef,'utf8')).token,credential.token);
  }finally{if(child?.exitCode===null && child?.signalCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}rmSync(dir,{recursive:true,force:true});}
});

test('standalone registered executor leaves status/history available when owner or validator registration is unavailable',async()=>{
  const f=fixture(),cli=new URL('../../dist/server/cli.js',import.meta.url).pathname,path=join(f.dir,'integrations.json');let child;
  try{
    writeFileSync(path,JSON.stringify({schema:'runtime-integrations/v1',workspaceId:'test',revision:1,owners:[],platforms:[],credentials:[],nativeToolchain:{path:join(f.dir,'missing-toolchain.json'),digest:'sha256:'+'a'.repeat(64),lockDigest:'sha256:'+'b'.repeat(64)}}),{mode:0o600});
    child=spawn(process.execPath,[cli,'serve','--state-root',f.root,'--workspace-id','test','--integrations-ref',path],{stdio:['ignore','pipe','pipe']});
    const [bytes]=await once(child.stdout,'data',{signal:AbortSignal.timeout(10000)}),ready=JSON.parse(bytes.toString());assert.equal(ready.ready,true);
    const r=await request(ready,f.token);assert.equal(r.status,200);assert.equal(r.body.result.projectId,'alpha');
    assert.equal((await request(ready,f.token,'lifecycle.instance.inspect','alpha',{instanceId:'absent'})).body.error.code,'NOT_FOUND');
    const ended=once(child,'exit');child.kill('SIGTERM');assert.equal((await ended)[0],0);
    const store=new RuntimeStore(f.root,'test');try{assert.equal(store.revision('alpha'),0);}finally{store.close();}
  }finally{if(child?.exitCode===null&&child?.signalCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}f.cleanup();}
});

test('project pagination covers every authorized project once and retains its cursor across restart',()=>{
  const f=fixture();let s=new RuntimeStore(f.root,'test');
  try{
    const ids=Array.from({length:137},(_,i)=>'project-'+String(i).padStart(3,'0')),actor={...f.actor,projects:[...ids].reverse()};
    const first=s.projects(actor);assert.equal(first.projects.length,50);assert.equal(first.hasMore,true);assert(first.nextCursor);s.close();s=new RuntimeStore(f.root,'test');
    const next=s.projects(actor,first.nextCursor,70),last=s.projects(actor,next.nextCursor);assert.equal(next.projects.length,70);assert.equal(last.projects.length,17);assert.equal(last.hasMore,false);assert.equal(last.nextCursor,null);
    assert.deepEqual([...first.projects,...next.projects,...last.projects].map(p=>p.projectId),ids);assert([...first.projects,...next.projects,...last.projects].every(p=>p.revision===0));
    assert.throws(()=>s.projects(actor,first.nextCursor+'x'),{code:'INVALID_CURSOR'});
    assert.throws(()=>s.projects(actor,first.nextCursor.split('.')[0]+'.'+'é'.repeat(43)),{code:'INVALID_CURSOR'});
    assert.throws(()=>s.events(f.actor,'alpha',first.nextCursor),{code:'INVALID_CURSOR'});
    assert.throws(()=>s.events(f.actor,'alpha',s.events(f.actor,'alpha').cursor.split('.')[0]+'.'+'é'.repeat(43)),{code:'INVALID_CURSOR'});
    assert.throws(()=>s.projects({...actor,id:'another-reader'},first.nextCursor),{code:'INVALID_CURSOR'});
    assert.throws(()=>s.projects({...actor,revision:2},first.nextCursor),{code:'INVALID_CURSOR'});
    assert.throws(()=>s.projects({...actor,projects:ids.slice(1)},first.nextCursor),{code:'INVALID_CURSOR'});
    assert.throws(()=>s.projects({...actor,permissions:[]}),{code:'FORBIDDEN'});
    assert.throws(()=>s.projects({...actor,expiresAt:'2020-01-01T00:00:00Z'}),{code:'FORBIDDEN'});
    assert.throws(()=>s.projects(actor,s.events(f.actor,'alpha').cursor),{code:'INVALID_CURSOR'});
    for(const limit of [0,-1,101,1.5,'10',null])assert.throws(()=>s.projects(actor,undefined,limit),{code:'INVALID_LIMIT'});
  }finally{s.close();f.cleanup();}
});
test('HTTP and MCP share project pagination and reject old cursors after live scope changes',async()=>{
  const f=fixture(),config=JSON.parse(readFileSync(join(f.root,'auth.json'),'utf8'));
  config.principals[0].projects=['alpha',...Array.from({length:76},(_,i)=>'project-'+String(i).padStart(3,'0'))];writeFileSync(join(f.root,'auth.json'),JSON.stringify(config));
  let server=await startRuntimeServer({stateRoot:f.root,workspaceId:'test'});const client=new Client({name:'synthetic-pagination-client',version:'1'});
  try{
    const first=await request(server,f.token,'runtime.projects.list','alpha');assert.equal(first.status,200);assert.equal(first.body.result.projects.length,50);
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+f.token}}}));
    const next=await client.callTool({name:'runtime_read',arguments:{operation:'runtime.projects.list',projectId:'alpha',input:{cursor:first.body.result.nextCursor,limit:100}}});assert.notEqual(next.isError,true);const result=JSON.parse(next.content[0].text).result;assert.equal(result.projects.length,27);assert.equal(result.nextCursor,null);
    assert.equal((await request(server,f.other,'runtime.projects.list','beta',{cursor:first.body.result.nextCursor})).status,400);
    assert.equal((await request(server,f.token,'runtime.projects.list','alpha',{limit:'100'})).status,400);
    config.principals[0].projects.splice(-1,1);config.principals[0].revision++;writeFileSync(join(f.root,'auth.json'),JSON.stringify(config));
    const stale=await request(server,f.token,'runtime.projects.list','alpha',{cursor:first.body.result.nextCursor});assert.equal(stale.body.error.code,'INVALID_CURSOR');
    const fresh=await request(server,f.token,'runtime.projects.list','alpha',{limit:100});assert.equal(fresh.body.result.projects.length,76);assert(!fresh.body.result.projects.some(p=>p.projectId==='project-075'));
    config.principals[0].permissions=['draft.write'];writeFileSync(join(f.root,'auth.json'),JSON.stringify(config));assert.equal((await request(server,f.token,'runtime.projects.list','alpha')).status,403);
  }finally{await client.close();await server.close();f.cleanup();}
});
