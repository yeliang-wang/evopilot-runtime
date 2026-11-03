import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {startRuntimeServer} from '../../dist/server/http.js';
import {RuntimeStore} from '../../dist/server/store.js';
import {initializeCredentials,tokenDigest} from '../../dist/server/security.js';
import {createRuntimeService} from '../../dist/service.js';
import {createRuntimeService as createHistoricalFixture} from '../fixtures/historical-runtime-v020.mjs';
import {createManagedLegacyService} from '../../dist/compat/managed-service.js';
import {LEGACY_CATALOG,LEGACY_READ,LEGACY_WRITE,legacyNativeFamily,legacyOperation} from '../../dist/compat/catalog.js';
import {inspectLegacyWorkspace,createLegacyBackup,adoptLegacyWorkspace} from '../../dist/installation/migration.js';
import {createRuntimeHttpClient} from '../../dist/host/client.js';
import {forwardLegacyRuntime} from '../../dist/host/legacy-tools.js';
import {nativeSha256} from '../../vendor/compatibility/v1/native.mjs';
import {syntheticReadinessMaterial} from '../fixtures/adapters-v090.mjs';
import {syntheticDecisionEvidence} from '../fixtures/native/decision-evidence.mjs';

const repo=realpathSync(fileURLToPath(new URL('../../',import.meta.url))),scope={visibility:'private',projectId:'alpha'};
const put=(path,value)=>writeFileSync(path,JSON.stringify(value),{mode:0o600});
async function fixture(t,{providers={},unbound=false,historicalRun=false}={}){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'runtime-legacy-http-')),stateRoot=join(root,'service'),options={workspaceRoot:join(root,'original'),workspaceId:'legacy-http'};
  const tokens={editor:randomBytes(32).toString('base64url'),reader:randomBytes(32).toString('base64url')};
  const principals=Object.entries(tokens).map(([id,token])=>({id,projects:['alpha'],permissions:id==='reader'?['read']:['read','draft.write','definition.activate','execution.request','decision.record','release.request'],revision:1,expiresAt:'2030-01-01T00:00:00Z',tokenDigest:tokenDigest(token)}));
  initializeCredentials(stateRoot,options.workspaceId,principals);
  const store=new RuntimeStore(stateRoot,options.workspaceId),serviceId=store.serviceId;store.close();
  const legacyDigest='sha256:'+'a'.repeat(64),resolve=({reference,workspace})=>({reference,workspace,scope,published:true,materialDigest:legacyDigest,descriptor:{kind:reference.product+'-composition/v1',digest:legacyDigest}});
  const old=historicalRun?createHistoricalFixture(options,{resolveOntology:resolve,resolveHarness:resolve,execute:()=>undefined}):createRuntimeService(options,providers);old.initialize();
  const original={operation:'project.create',scope,input:{name:'Original project'},requestId:'original-project',expectedRevision:0};const receipt=old.execute(original);
  old.execute({operation:'goal.create',scope,input:{id:'original-goal',description:'Existing goal'},requestId:'original-goal',expectedRevision:1});
  let retainedRun=null;
  if(historicalRun){
    const write=(operation,input,requestId)=>old.execute({operation,scope,input,requestId,expectedRevision:old.execute({operation:'workspace.inspect',scope,input:{}}).revision});
    const reference=product=>({product,id:product,version:'1.0.0',specVersion:'v1',visibility:'private',digest:legacyDigest});
    const prepared=write('run.prepare',{id:'historical-unknown',goalId:'original-goal',ontology:reference('ontology'),harness:reference('harness'),input:{schema:'runtime-composition/v1',ontologyInstance:{entities:[],relations:[]},harness:{mode:'composed',evidence:{},configuration:{}}}},'historical-prepare').result;
    write('run.decide',{id:prepared.id,reviewDigest:prepared.reviewDigest,decision:'APPROVE',humanEvidenceRef:'synthetic:historical-migration-fixture-only'},'historical-decision');
    await old.dispatch({scope,id:prepared.id,requestId:'historical-dispatch',expectedRevision:old.execute({operation:'workspace.inspect',scope,input:{}}).revision});
    retainedRun=old.execute({operation:'run.inspect',scope,input:{id:prepared.id}});assert.equal(retainedRun.stage,'UNKNOWN');
  }
  old.close();const nativeInitializer=createRuntimeService(options,providers);nativeInitializer.initialize();await nativeInitializer.native({operation:'workspace.inspect',scope,input:{}});nativeInitializer.close();
  const snapshot=inspectLegacyWorkspace(options.workspaceRoot,options.workspaceId),backupRoot=join(root,'backup'),backup=createLegacyBackup(options.workspaceRoot,options.workspaceId,snapshot.snapshotDigest,backupRoot);
  const adopted=adoptLegacyWorkspace({...options,serviceId,expectedSnapshotDigest:snapshot.snapshotDigest,backupRoot,expectedBackupDigest:backup.backupDigest});
  const bindingRef=join(root,'legacy-binding.json');put(bindingRef,adopted.binding);
  let server=await startRuntimeServer({stateRoot,workspaceId:options.workspaceId,...(unbound?{}:{legacyBindingRef:bindingRef})},undefined,undefined,undefined,undefined,undefined,undefined,undefined,providers);
  const connections={};
  for(const id of Object.keys(tokens)){
    const tokenRef=join(root,id+'-token.json'),connectionRef=join(root,id+'-connection.json');
    put(tokenRef,{schema:'runtime-client-credential/v1',workspaceId:options.workspaceId,principalId:id,projectId:'alpha',token:tokens[id]});
    const connection={schema:'runtime-host-connection/v1',origin:server.url,workspaceId:options.workspaceId,projectId:'alpha',principalId:id,serviceId,version:server.identity.version,tokenRef};put(connectionRef,connection);
    connections[id]={connectionRef,connection,client:createRuntimeHttpClient(connectionRef)};
  }
  t.after(async()=>{await server.close();rmSync(root,{recursive:true,force:true});});
  return{root,stateRoot,options,tokens,principals,adopted,bindingRef,receipt,original,retainedRun,connections,server:()=>server,async restart(){await server.close();server=await startRuntimeServer({stateRoot,workspaceId:options.workspaceId,legacyBindingRef:bindingRef},undefined,undefined,undefined,undefined,undefined,undefined,undefined,providers);for(const value of Object.values(connections)){value.connection.origin=server.url;put(value.connectionRef,value.connection);value.client=createRuntimeHttpClient(value.connectionRef);}}};
}
const request=(family,operation,input={},extra={})=>({operation,scope,input,...extra});
const legacy=(client,family,operation,input={},extra={})=>forwardLegacyRuntime(client,family,request(family,operation,input,extra));
const unwrap=result=>JSON.parse(result.content[0].text);
async function cli(args,value){const child=spawn(process.execPath,[join(repo,'dist/cli.js'),...args],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);const timer=setTimeout(()=>child.kill('SIGTERM'),10000);child.stdin.end(JSON.stringify(value));const [code]=await once(child,'exit');clearTimeout(timer);return{code,stdout,stderr,value:JSON.parse(stdout)};}

test('explicit compatibility catalog covers every existing public Runtime family and original read/write semantics',()=>{
  const service=createRuntimeService({workspaceRoot:'/unused',workspaceId:'unused'}),caps=service.capabilities();
  for(const [family,field]of Object.entries({native:'nativeOperations',planning:'planningOperations',readiness:'readinessOperations',readable:'readableOperations',feedback:'feedbackOperations',online:'onlineOperations',response:'responseOperations',reconstruction:'reconstructionOperations'})){
    assert.deepEqual([...LEGACY_CATALOG[family].read,...Object.keys(LEGACY_CATALOG[family].write)].sort(),[...caps[field]].sort(),family);
    for(const op of caps[field])assert.equal(legacyNativeFamily(op),family);
  }
  assert.equal(legacyOperation('native','run.dispatch').write,true);assert.equal(legacyOperation('readiness','readiness.intent.review').write,false);assert.equal(legacyOperation('native','native.package.publish'),null);assert.equal(legacyOperation('__proto__','anything'),null);service.close();
});
test('same service reads original project and receipt and retains original CAS independently from its transport audit',async t=>{
  const f=await fixture(t),client=f.connections.editor.client;
  assert.equal((await client.status()).result.legacy.migrationDigest,f.adopted.binding.migrationDigest);
  assert.deepEqual((await legacy(client,'request','receipt.inspect',{requestId:'original-project'})).result,f.receipt);
  assert.deepEqual((await forwardLegacyRuntime(client,'request',f.original)).result,f.receipt);
  assert.equal((await client.status()).result.revision,1,'transport admission audit has its own project counter');
  assert.equal((await legacy(client,'request','workspace.inspect')).result.revision,2,'legacy family counter is unchanged on exact replay');
  const update={operation:'goal.create',scope,input:{id:'next',description:'One exact original intent'},requestId:'next-goal',expectedRevision:2};
  const written=await forwardLegacyRuntime(client,'request',update);assert.equal(written.result.revision,3);
  assert.deepEqual((await forwardLegacyRuntime(client,'request',{...update,expectedRevision:0})).result,written.result);
  assert.equal((await legacy(client,'request','workspace.inspect')).result.revision,3);
  assert.equal((await client.request({operation:'lifecycle.definition.inspect',projectId:'alpha',input:{}})).result.active,null);
  const events=(await client.request({operation:'runtime.events.read',projectId:'alpha',input:{}})).result.events;assert(events.every(e=>e.type==='legacy-call-admitted'));
  assert(events.every(e=>!JSON.stringify(e).includes('One exact original intent')),'audit retains intent digest and IDs, not the private full input');
  await f.restart();const restarted=f.connections.editor.client;
  assert.deepEqual((await legacy(restarted,'request','receipt.inspect',{requestId:'next-goal'})).result,written.result);
  assert.throws(()=>createManagedLegacyService(f.adopted.binding),{code:'LEGACY_WRITER_ACTIVE'});
});
test('reader, cross-project, unknown owner family and read-as-write bypasses are refused before original mutation',async t=>{
  const f=await fixture(t),reader=f.connections.reader.client,editor=f.connections.editor.client;
  await assert.rejects(()=>legacy(reader,'request','goal.create',{id:'forbidden',description:'Denied'},{requestId:'forbidden',expectedRevision:2}),{code:'FORBIDDEN'});
  await assert.rejects(()=>forwardLegacyRuntime(editor,'request',{operation:'project.inspect',scope:{...scope,projectId:'beta'},input:{}}),{code:'CREDENTIAL_SCOPE'});
  for(const input of [{family:'ontology',envelope:{operation:'native.package.publish',scope,input:{}}},{family:'request',envelope:{operation:'goal.create',scope,input:{id:'hidden',description:'Denied'}}}])await assert.rejects(()=>editor.request({operation:LEGACY_READ,projectId:'alpha',input}));
  await assert.rejects(()=>editor.request({operation:LEGACY_WRITE,projectId:'alpha',input:{family:'request',envelope:{operation:'project.inspect',scope,input:{}}},requestId:'wrong-mode',expectedRevision:2}),{code:'LEGACY_OPERATION_MODE'});
  assert.equal((await legacy(editor,'request','workspace.inspect')).result.revision,2);assert.equal((await editor.status()).result.revision,0);
});
test('legacy stdio tool names and direct HTTP MCP retrieve the same original records without a second writer',async t=>{
  const f=await fixture(t,{historicalRun:true}),stdio=new Client({name:'legacy-fixture',version:'1'}),http=new Client({name:'http-fixture',version:'1'});
  t.after(async()=>{await stdio.close();await http.close();});
  await stdio.connect(new StdioClientTransport({command:process.execPath,args:[join(repo,'dist/host/bridge.js'),'--connection-ref',f.connections.editor.connectionRef],stderr:'pipe'}));
  await http.connect(new StreamableHTTPClientTransport(new URL(f.server().url+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+f.tokens.editor}}}));
  assert((await stdio.listTools()).tools.some(tool=>tool.name==='evopilot_v01_native'));
  assert.equal(unwrap(await stdio.callTool({name:'evopilot_v01_request',arguments:{owner:'runtime',envelope:{operation:'project.inspect',scope,input:{}}}})).error.code,'SESSION_INACTIVE');
  assert.equal(unwrap(await stdio.callTool({name:'evopilot_v01_activate',arguments:{}})).result.serviceStarted,false);
  const old=unwrap(await stdio.callTool({name:'evopilot_v01_request',arguments:{owner:'runtime',envelope:{operation:'receipt.inspect',scope,input:{requestId:'original-project'}}}}));
  const fresh=unwrap(await http.callTool({name:'runtime_read',arguments:{operation:LEGACY_READ,projectId:'alpha',input:{family:'request',envelope:{operation:'receipt.inspect',scope,input:{requestId:'original-project'}}}}}));
  assert.deepEqual(old.result,f.receipt);assert.deepEqual(fresh.result,f.receipt);
  const oldRun=unwrap(await stdio.callTool({name:'evopilot_v01_request',arguments:{owner:'runtime',envelope:{operation:'run.inspect',scope,input:{id:'historical-unknown'}}}}));
  const newRun=unwrap(await http.callTool({name:'runtime_read',arguments:{operation:LEGACY_READ,projectId:'alpha',input:{family:'request',envelope:{operation:'run.inspect',scope,input:{id:'historical-unknown'}}}}}));
  assert.deepEqual(oldRun.result,f.retainedRun);assert.deepEqual(newRun.result,f.retainedRun);assert.equal(newRun.result.stage,'UNKNOWN');
  const revision=(await legacy(f.connections.editor.client,'request','workspace.inspect')).result.revision;
  const write=unwrap(await stdio.callTool({name:'evopilot_v01_request',arguments:{owner:'runtime',envelope:{operation:'goal.create',scope,input:{id:'bridge-goal',description:'Original bridge operation'},requestId:'bridge-goal',expectedRevision:revision}}}));assert.equal(write.result.revision,revision+1);
  assert.deepEqual((await legacy(f.connections.editor.client,'request','receipt.inspect',{requestId:'bridge-goal'})).result,write.result);
  assert.equal(unwrap(await stdio.callTool({name:'evopilot_v01_deactivate',arguments:{}})).result.serviceStopped,false);assert.equal((await f.connections.editor.client.status()).result.serviceId,f.server().identity.serviceId);
});
test('installed-style legacy CLI forwards original request through its protected connection and never opens the adopted database locally',async t=>{
  const f=await fixture(t),value={operation:'receipt.inspect',scope,input:{requestId:'original-project'}};
  const result=await cli(['request','--connection-ref',f.connections.editor.connectionRef],value);assert.equal(result.code,0,result.stderr);assert.deepEqual(result.value.result,f.receipt);
  const denial=await cli(['request','--connection-ref',f.connections.reader.connectionRef],{operation:'goal.create',scope,input:{id:'denied',description:'Denied'},requestId:'cli-denied',expectedRevision:2});assert.equal(denial.code,1);assert.equal(denial.value.error.code,'FORBIDDEN');
  const local=await cli(['request','--workspace',f.options.workspaceRoot,'--workspace-id',f.options.workspaceId],value);assert.equal(local.code,1);assert.equal((await legacy(f.connections.editor.client,'request','workspace.inspect')).result.revision,2);
});
test('new readiness intent preserves v2 content semantics, original family receipts and managed schema without enabling lifecycle',async t=>{
  const f=await fixture(t),client=f.connections.editor.client,material=syntheticReadinessMaterial(f.options.workspaceId,'alpha');
  const review=(await legacy(client,'readiness','readiness.intent.review',{standardVersion:'v2',definition:material.definition,previousDigest:null})).result;
  const evidence=syntheticDecisionEvidence(f.root,{owner:'runtime',operation:'readiness.intent.record',workspaceId:f.options.workspaceId,scope,reviewDigest:review.reviewDigest,decision:'ACCEPT'});
  const before=(await legacy(client,'readiness','readiness.inspect',{standardVersion:'v2'})).result;
  const result=await legacy(client,'readiness','readiness.intent.record',{standardVersion:'v2',definition:material.definition,previousDigest:null,humanEvidenceRef:evidence},{requestId:'original-intent',expectedRevision:before.revision});
  assert.equal(result.result.result.definition.targetLevel,'L3');
  assert.deepEqual((await legacy(client,'readiness','readiness.receipt.inspect',{standardVersion:'v2',requestId:'original-intent'})).result,result.result);
  const {tokenDigest:unused,...actor}=f.principals.find(p=>p.id==='reader');
  const source=f.server().legacyIntentSource;
  assert.equal(source.workspaceRoot,f.options.workspaceRoot);
  assert.equal((await source.read(actor,'alpha',{workspaceId:f.options.workspaceId,scope,digest:review.reviewDigest})).digest,review.reviewDigest);
  await assert.rejects(()=>source.read(actor,'alpha',{workspaceId:'foreign',scope,digest:review.reviewDigest}),{code:'LEGACY_SCOPE'});
  assert.equal((await legacy(client,'request','workspace.inspect')).result.revision,2);
  await f.restart();assert.equal((await legacy(f.connections.editor.client,'readiness','readiness.intent.list',{standardVersion:'v2'})).result.items.length,1);
  await assert.rejects(()=>source.read(actor,'alpha',{workspaceId:f.options.workspaceId,scope,digest:review.reviewDigest}),{code:'CLOSED'});
  assert.equal((await f.connections.editor.client.request({operation:'lifecycle.definition.inspect',projectId:'alpha',input:{}})).result.active,null);
});
test('wrong service adoption at startup releases the new service store and cannot fall back to direct legacy writing',async t=>{
  const f=await fixture(t);await f.server().close();
  put(f.bindingRef,{...f.adopted.binding,serviceId:'different-service'});
  await assert.rejects(()=>startRuntimeServer({stateRoot:f.stateRoot,workspaceId:f.options.workspaceId,legacyBindingRef:f.bindingRef}),{code:'LEGACY_SERVICE_MISMATCH'});
  put(f.bindingRef,f.adopted.binding);await f.restart();
  assert.equal((await legacy(f.connections.editor.client,'request','workspace.inspect')).result.revision,2);
});
test('revocation during an original async provider read prevents the later legacy commit',async t=>{
  let entered,release;const started=new Promise(resolve=>entered=resolve),waiting=new Promise(resolve=>release=resolve);
  const requirements=[{criterionId:'synthetic',variantIds:['synthetic.01'],origin:'execution-result'}];
  const sourceScope={direction:'reverse',locator:'synthetic:gateway',revision:'1',treeDigest:nativeSha256('source'),inventoryDigest:nativeSha256(['source']),requirementsDigest:nativeSha256(requirements)};
  const standardPins=Object.fromEntries(['ontology','harness'].map(owner=>[owner,{standardDigest:nativeSha256({owner,spec:1}),standardLockDigest:nativeSha256({owner,lock:1})}]));
  const providers={nativeStandards:standardPins,inspectSource:async()=>{entered();await waiting;return sourceScope;},resolveRequirements:()=>requirements};
  const f=await fixture(t,{providers}),client=f.connections.editor.client;
  const pending=legacy(client,'native','project.prepare',{id:'pending-project',goalId:'original-goal',sourceScope,standardPins,requirements},{requestId:'pending-project',expectedRevision:0});
  const outcome=pending.then(value=>({value}),error=>({error}));await started;
  put(join(f.stateRoot,'auth.json'),{schema:'runtime-auth/v1',workspaceId:f.options.workspaceId,principals:f.principals.map(p=>p.id==='editor'?{...p,revision:2,permissions:['read']}:p)});release();
  assert.equal((await outcome).error.code,'AUTHORITY_CHANGED');
  const after=await legacy(client,'native','workspace.inspect');assert.equal(after.result.revision,0);
  await assert.rejects(()=>legacy(client,'native','receipt.inspect',{requestId:'pending-project'}),{code:'NOT_FOUND'});
});
test('lost committed legacy response remains unknown; original receipt lookup and exact retry do not redispatch',async t=>{
  const f=await fixture(t);let posts=0;
  const proxy=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;const response=await fetch(f.server().url+req.url,{method:req.method,headers:{authorization:'Bearer '+f.tokens.editor,...(req.method==='POST'?{'content-type':'application/json'}:{})},...(req.method==='POST'?{body}:{})});const text=await response.text();if(req.method==='POST'){posts++;req.socket.destroy();}else{res.writeHead(response.status,{'content-type':'application/json'});res.end(text);}});
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');t.after(()=>new Promise(resolve=>proxy.close(resolve)));
  const ref=join(f.root,'proxy-connection.json');put(ref,{...f.connections.editor.connection,origin:'http://127.0.0.1:'+proxy.address().port});
  const value={operation:'goal.create',scope,input:{id:'uncertain',description:'Keep original request identity'},requestId:'original-uncertain',expectedRevision:2};
  await assert.rejects(()=>forwardLegacyRuntime(createRuntimeHttpClient(ref),'request',value),{code:'REQUEST_OUTCOME_UNKNOWN'});assert.equal(posts,1);
  const retained=(await legacy(f.connections.editor.client,'request','receipt.inspect',{requestId:'original-uncertain'})).result;
  assert.deepEqual((await forwardLegacyRuntime(f.connections.editor.client,'request',value)).result,retained);assert.equal((await legacy(f.connections.editor.client,'request','workspace.inspect')).result.revision,3);
});
test('unbound service does not advertise legacy stdio aliases and cannot initialize or adopt caller-selected state',async t=>{
  const f=await fixture(t,{unbound:true}),stdio=new Client({name:'unbound',version:'1'});t.after(()=>stdio.close());
  await assert.rejects(()=>legacy(f.connections.editor.client,'request','workspace.inspect'),{code:'LEGACY_NOT_BOUND'});
  await stdio.connect(new StdioClientTransport({command:process.execPath,args:[join(repo,'dist/host/bridge.js'),'--connection-ref',f.connections.editor.connectionRef],stderr:'pipe'}));
  assert(!(await stdio.listTools()).tools.some(tool=>tool.name.startsWith('evopilot_v01_')&&tool.name!=='evopilot_v01_guide'));
  assert.equal((await f.connections.editor.client.status()).result.legacy,null);
});
