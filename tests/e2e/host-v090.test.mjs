import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,writeFileSync,readFileSync,rmSync,chmodSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {startRuntimeServer} from '../../dist/server/http.js';
import {initializeCredentials,tokenDigest} from '../../dist/server/security.js';
import {createRuntimeHttpClient,hostHeaders,readHostConnection,localOrigin} from '../../dist/host/client.js';
import {runtimePluginMaterial,quoteHelperArgument} from '../../dist/host/plugin.js';
import {lifecycle,yaml,syntheticBindings} from '../fixtures/lifecycle-v090.mjs';
import {digest} from '../../dist/server/errors.js';
import {serviceMain} from '../../dist/server/cli.js';

const repo=realpathSync(fileURLToPath(new URL('../../',import.meta.url))),node=realpathSync(process.execPath),bridge=join(repo,'dist/host/bridge.js');
async function fixture({reader=false}={}){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'runtime-host-')),stateRoot=join(root,'state'),token=randomBytes(32).toString('base64url'),tokenRef=join(root,'client.json'),connectionRef=join(root,'connection.json');
 initializeCredentials(stateRoot,'host-test',[{id:'host',projects:['alpha'],permissions:reader?['read']:['read','draft.write','definition.activate'],revision:1,expiresAt:'2030-01-01T00:00:00Z',tokenDigest:tokenDigest(token)}]);
 const server=await startRuntimeServer({stateRoot,workspaceId:'host-test'},syntheticBindings().provider),credential={schema:'runtime-client-credential/v1',workspaceId:'host-test',principalId:'host',projectId:'alpha',token};
 const connection={schema:'runtime-host-connection/v1',origin:server.url,workspaceId:'host-test',projectId:'alpha',principalId:'host',serviceId:server.identity.serviceId,version:server.identity.version,tokenRef};
 const put=(path,value)=>writeFileSync(path,JSON.stringify(value),{mode:0o600});put(tokenRef,credential);put(connectionRef,connection);
 return{root,stateRoot,token,tokenRef,connectionRef,connection,credential,put,server,client:createRuntimeHttpClient(connectionRef),async cleanup(){await server.close();rmSync(root,{recursive:true,force:true});}};
}
const envelope=(operation,input={},extra={})=>({operation,projectId:'alpha',input,...extra});
for(const role of ['activator','operator'])test('local '+role+' bootstrap never substitutes for exact execution authority',async()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'runtime-role-')),stateRoot=join(root,'state');let server;
 try{
  let output='';assert.equal(await serviceMain(['auth-init','--state-root',stateRoot,'--workspace-id','host-test','--project','alpha','--principal','host','--role',role],{write:v=>{output+=v;}}),0);
  const initialized=JSON.parse(output);assert.equal(initialized.executionAuthorized,false);assert.equal(initialized.releaseAuthorized,false);
  const credential=JSON.parse(readFileSync(initialized.tokenRef));assert(!output.includes(credential.token));
  server=await startRuntimeServer({stateRoot,workspaceId:'host-test'},syntheticBindings().provider);
  const request=async(operation,input,meta={})=>{const response=await fetch(server.url+'/api/v1/request',{method:'POST',headers:{authorization:'Bearer '+credential.token,'content-type':'application/json'},body:JSON.stringify(envelope(operation,input,meta))});return{status:response.status,body:await response.json()};};
  const text=yaml(lifecycle()),preview=await request('lifecycle.definition.validate',{yaml:text});assert.equal(preview.body.result.ready,true);
  const active=await request('lifecycle.definition.save-and-activate',{yaml:text,validationDigest:preview.body.result.validationDigest},{requestId:'configure',expectedRevision:0});assert.equal(active.status,200);
  const denied=await request('lifecycle.instance.create',{instanceId:'unauthorized',definitionRevisionId:active.body.result.result.revisionId,authorityRef:'authority:sha256:'+'0'.repeat(64)},{requestId:'deny-execution',expectedRevision:1});
  assert.equal(denied.status,role==='operator'?404:403);assert.equal(denied.body.error.code,role==='operator'?'NOT_FOUND':'FORBIDDEN');assert.equal((await request('runtime.status',{})).body.result.revision,1);
  const auth=readFileSync(join(stateRoot,'auth.json'));output='';assert.equal(await serviceMain(['auth-init','--state-root',stateRoot,'--workspace-id','host-test','--project','alpha','--principal','host','--role','operator'],{write:v=>{output+=v;}}),1);assert.deepEqual(readFileSync(join(stateRoot,'auth.json')),auth);
 }finally{await server?.close();rmSync(root,{recursive:true,force:true});}
});
test('protected HTTP client reads exact live identity and enforces immutable connection scope',async()=>{
 const f=await fixture();try{
  const status=await f.client.status();assert.equal(status.result.serviceId,f.server.identity.serviceId);assert.equal(status.result.independentLlm,false);
  const base=await f.client.request(envelope('lifecycle.base.inspect'));assert.equal(base.result.stages.length,8);
  await assert.rejects(()=>f.client.request({...envelope('runtime.status'),projectId:'beta'}),{code:'CREDENTIAL_SCOPE'});
  f.put(f.connectionRef,{...f.connection,serviceId:'foreign-service'});await assert.rejects(()=>f.client.status(),{code:'CONNECTION_CHANGED'});await assert.rejects(()=>createRuntimeHttpClient(f.connectionRef).status(),{code:'SERVICE_IDENTITY_CHANGED'});
 }finally{await f.cleanup();}
});
test('connection and credential files reject unsafe modes, links, wrong scope and nonlocal endpoints',async()=>{
 const f=await fixture();try{
  for(const origin of ['https://example.org','http://example.org:3000','http://127.0.0.1:1234/mcp','http://user:secret@127.0.0.1:1234','http://127.0.0.1:1234/?token=x'])assert.throws(()=>localOrigin(origin),{code:'INVALID_URL'});
  f.put(f.tokenRef,{...f.credential,projectId:'beta'});assert.throws(()=>hostHeaders(readHostConnection(f.connectionRef)),{code:'CREDENTIAL_SCOPE'});f.put(f.tokenRef,f.credential);
  chmodSync(f.tokenRef,0o644);assert.throws(()=>hostHeaders(readHostConnection(f.connectionRef)),{code:'UNSAFE_STATE'});chmodSync(f.tokenRef,0o600);
  const link=join(f.root,'linked.json');symlinkSync(f.tokenRef,link);f.put(f.connectionRef,{...f.connection,tokenRef:link});assert.throws(()=>readHostConnection(f.connectionRef),{code:'UNSAFE_AUTH'});
 }finally{await f.cleanup();}
});
test('stdio bridge and direct HTTP MCP use one service, revision and exact idempotent draft receipt',async()=>{
 const f=await fixture(),stdio=new Client({name:'synthetic-legacy-transport',version:'1'}),http=new Client({name:'synthetic-http',version:'1'});try{
  await stdio.connect(new StdioClientTransport({command:node,args:[bridge,'--connection-ref',f.connectionRef],stderr:'pipe'}));await http.connect(new StreamableHTTPClientTransport(new URL(f.server.url+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+f.token}}}));
  assert.deepEqual((await stdio.listTools()).tools.filter(tool=>tool.name!=='evopilot_v01_guide'),(await http.listTools()).tools);
  const args=envelope('lifecycle.draft.save',{yaml:yaml(lifecycle())},{requestId:'draft-one',expectedRevision:0});const first=await stdio.callTool({name:'runtime_write',arguments:args});assert.notEqual(first.isError,true);const receipt=JSON.parse(first.content[0].text).result;
  const replay=await http.callTool({name:'runtime_write',arguments:args});assert.notEqual(replay.isError,true);assert.deepEqual(JSON.parse(replay.content[0].text).result,receipt);assert.equal((await f.client.status()).result.revision,1);
  const read=await f.client.request(envelope('lifecycle.definition.inspect'));assert.equal(read.result.draft.id,receipt.result.revisionId);assert.equal(read.result.active,null);
  const cross=await stdio.callTool({name:'runtime_read',arguments:{...envelope('runtime.status'),projectId:'beta'}});assert.equal(cross.isError,true);assert.equal(JSON.parse(cross.content[0].text).error.code,'CREDENTIAL_SCOPE');
  const wrongTool=await stdio.callTool({name:'runtime_read',arguments:args});assert.equal(wrongTool.isError,true);assert.equal((await f.client.status()).result.revision,1);
  await stdio.close();assert.equal((await f.client.status()).result.serviceId,f.connection.serviceId);
 }finally{await stdio.close();await http.close();await f.cleanup();}
});
test('read-only bridge credential never gains draft or activation authority',async()=>{
 const f=await fixture({reader:true}),client=new Client({name:'synthetic-reader',version:'1'});try{
  await client.connect(new StdioClientTransport({command:node,args:[bridge,'--connection-ref',f.connectionRef],stderr:'pipe'}));const result=await client.callTool({name:'runtime_write',arguments:envelope('lifecycle.draft.save',{yaml:yaml(lifecycle())},{requestId:'denied',expectedRevision:0})});assert.equal(result.isError,true);assert.equal(JSON.parse(result.content[0].text).error.code,'FORBIDDEN');assert.equal((await f.client.status()).result.revision,0);
 }finally{await client.close();await f.cleanup();}
});
test('one Runtime plugin contains Expert and HTTP configuration without embedding the credential',async()=>{
 const f=await fixture();try{
  const material=runtimePluginMaterial(repo,f.connectionRef,node);assert.equal(material.name,'evopilot-runtime');assert.equal(material.version,f.connection.version);assert.equal(material.credentialEmbedded,false);assert(material.files.has('skills/evopilot-runtime-expert/SKILL.md'));
  const mcp=JSON.parse(material.files.get('.mcp.json'));assert.deepEqual(Object.keys(mcp.mcpServers),['evopilot_runtime']);assert.equal(mcp.mcpServers.evopilot_runtime.type,'http');assert.equal(mcp.mcpServers.evopilot_runtime.url,f.server.url+'/mcp');assert.equal(mcp.mcpServers.evopilot_runtime.command,undefined);
  for(const bytes of material.files.values())assert(!bytes.toString().includes(f.token));
  const helper=mcp.mcpServers.evopilot_runtime.http_headers_helper,result=spawnSync('/bin/sh',['-c',helper],{encoding:'utf8',timeout:5000});assert.equal(result.status,0);assert.deepEqual(JSON.parse(result.stdout),{Authorization:'Bearer '+f.token});assert.equal(result.stderr,'');
  f.put(f.connectionRef,{...f.connection,version:'99.0.0'});assert.throws(()=>runtimePluginMaterial(repo,f.connectionRef,node),{code:'PLUGIN_VERSION_MISMATCH'});
 }finally{await f.cleanup();}
});
test('optional packaged legacy entry retains one plugin, HTTP primary and no duplicate modern tools',async()=>{
 const f=await fixture(),client=new Client({name:'synthetic-packaged-legacy-only',version:'1'});try{
  const material=runtimePluginMaterial(repo,f.connectionRef,node,{}),mcp=JSON.parse(material.files.get('.mcp.json')),legacy=mcp.mcpServers.evopilot_runtime_legacy;
  assert.deepEqual(Object.keys(mcp.mcpServers),['evopilot_runtime','evopilot_runtime_legacy']);assert.equal(mcp.mcpServers.evopilot_runtime.type,'http');assert.equal(legacy.command,node);assert.deepEqual(legacy.args,[bridge,'--connection-ref',f.connectionRef,'--legacy-only']);
  await client.connect(new StdioClientTransport({...legacy,stderr:'pipe'}));assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),['evopilot_v01_guide'],'unbound service advertises only passive guidance');
  const rejected=await client.callTool({name:'runtime_read',arguments:envelope('runtime.status')});assert.equal(rejected.isError,true);assert.equal(JSON.parse(rejected.content[0].text).error.code,'UNKNOWN_TOOL');assert.equal((await f.client.status()).result.revision,0);
 }finally{await client.close();await f.cleanup();}
});
test('packaged owner routes pin exact permission config and migrated service without embedding secrets',async()=>{
 const f=await fixture();try{
  const ref=join(f.root,'owners.json'),legacyBindingRef=join(f.root,'legacy.json');
  f.put(legacyBindingRef,{workspaceRoot:f.root,workspaceId:f.connection.workspaceId,serviceId:f.connection.serviceId,migrationDigest:'a'.repeat(64)});
  const config={schema:'runtime-legacy-owner-host/v1',workspaceId:f.connection.workspaceId,projectId:'alpha',legacyBindingRef,expiresAt:'2030-01-01T00:00:00Z',owners:Object.fromEntries(['ontology','harness'].map(owner=>[owner,{packageRoot:join(f.root,owner),calls:['request:workspace.inspect']}]))};f.put(ref,config);
  const selection={ownerConfigRef:ref,ownerConfigDigest:digest(config)},material=runtimePluginMaterial(repo,f.connectionRef,node,selection),mcp=JSON.parse(material.files.get('.mcp.json'));
  assert.deepEqual(mcp.mcpServers.evopilot_runtime_legacy.args.slice(-4),['--owner-config-ref',ref,'--owner-config-digest',selection.ownerConfigDigest]);for(const bytes of material.files.values())assert(!bytes.toString().includes(f.token));
  f.put(ref,{...config,expiresAt:'2031-01-01T00:00:00Z'});assert.throws(()=>runtimePluginMaterial(repo,f.connectionRef,node,selection),{code:'OWNER_HOST_CHANGED'});f.put(ref,config);
  f.put(legacyBindingRef,{workspaceRoot:f.root,workspaceId:f.connection.workspaceId,serviceId:'another-service',migrationDigest:'a'.repeat(64)});assert.throws(()=>runtimePluginMaterial(repo,f.connectionRef,node,selection),{code:'OWNER_HOST_SCOPE'});
 }finally{await f.cleanup();}
});
test('helper command arguments preserve quotes and shell metacharacters as literal path bytes',()=>{
 const literal="a ' quoted $(exit 33) `exit 44` ; $VALUE \\ path",command=[node,'-e','process.stdout.write(process.argv[1])',literal].map(quoteHelperArgument).join(' '),result=spawnSync('/bin/sh',['-c',command],{encoding:'utf8',timeout:5000});assert.equal(result.status,0);assert.equal(result.stdout,literal);assert.equal(result.stderr,'');
});
test('credential helper failure does not emit a partial token or private error content',async()=>{
 const f=await fixture();try{
  f.put(f.tokenRef,{...f.credential,projectId:'beta'});const result=spawnSync(node,[join(repo,'dist/host/header-helper.js'),'--connection-ref',f.connectionRef],{encoding:'utf8',timeout:5000});assert.equal(result.status,1);assert.equal(result.stdout,'');assert(!result.stderr.includes(f.token));assert(!result.stderr.includes(f.root));assert.equal(JSON.parse(result.stderr).error.code,'CREDENTIAL_SCOPE');
 }finally{await f.cleanup();}
});
for(const failure of ['lost','malformed','incomplete'])test(failure+' write response remains unknown and the HTTP client never retries or refreshes its request key',async()=>{
 const f=await fixture();let proxy;try{
  let mutations=0;const originals=[];proxy=createServer(async(req,res)=>{
   if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({result:{...f.server.identity,projectId:'alpha',revision:0}}));return;}
   let text='';for await(const chunk of req)text+=chunk;mutations++;originals.push(JSON.parse(text));if(failure==='lost')req.socket.destroy();else{res.setHeader('content-type','application/json');res.end(failure==='malformed'?'not JSON':'{}');}
  });proxy.listen(0,'127.0.0.1');await once(proxy,'listening');f.put(f.connectionRef,{...f.connection,origin:'http://127.0.0.1:'+proxy.address().port});const client=createRuntimeHttpClient(f.connectionRef),original=envelope('lifecycle.draft.save',{yaml:yaml(lifecycle())},{requestId:'original-uncertain',expectedRevision:0});
  await assert.rejects(()=>client.request(original),{code:'REQUEST_OUTCOME_UNKNOWN'});assert.equal(mutations,1);assert.deepEqual(originals,[original]);assert.equal((await f.client.status().catch(e=>({error:e.code}))).error,'CONNECTION_CHANGED');
 }finally{await new Promise(resolve=>proxy?proxy.close(resolve):resolve());await f.cleanup();}
});

test('only stage.request can receive a response beyond fifteen seconds; other writes and caller cancellation remain bounded without retry',async()=>{
 const f=await fixture();let proxy;const timers=new Set(),originals=[],cancellation=new AbortController();
 try{
  proxy=createServer(async(req,res)=>{
   res.setHeader('content-type','application/json');
   if(req.method==='GET'){res.end(JSON.stringify({result:{...f.server.identity,projectId:'alpha',revision:0}}));return;}
   let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);originals.push(body);if(body.requestId==='cancelled-stage')cancellation.abort();
   const timer=setTimeout(()=>{timers.delete(timer);if(!res.destroyed)res.end(JSON.stringify({requestId:body.requestId,result:{syntheticTransportOnly:true,originalRequestId:body.requestId}}));},16000);timers.add(timer);
  });proxy.listen(0,'127.0.0.1');await once(proxy,'listening');f.put(f.connectionRef,{...f.connection,origin:'http://127.0.0.1:'+proxy.address().port});const client=createRuntimeHttpClient(f.connectionRef);
  const stage=envelope('lifecycle.stage.request',{instanceId:'one',stageId:'scope'},{requestId:'slow-stage',expectedRevision:0}),draft=envelope('lifecycle.draft.save',{yaml:yaml(lifecycle())},{requestId:'slow-draft',expectedRevision:0}),cancelled={...stage,requestId:'cancelled-stage'};
  const completed=client.request(stage),limited=assert.rejects(()=>client.request(draft),{code:'REQUEST_OUTCOME_UNKNOWN'}),cancel=assert.rejects(()=>client.request(cancelled,cancellation.signal),{code:'REQUEST_OUTCOME_UNKNOWN'});
  const result=await completed;await Promise.all([limited,cancel]);assert.equal(result.requestId,stage.requestId);assert.equal(result.result.originalRequestId,stage.requestId);
  assert.equal(originals.length,3);for(const expected of [stage,draft,cancelled])assert.deepEqual(originals.filter(v=>v.requestId===expected.requestId),[expected]);
 }finally{for(const timer of timers)clearTimeout(timer);proxy?.closeAllConnections();await new Promise(resolve=>proxy?proxy.close(resolve):resolve());await f.cleanup();}
});
