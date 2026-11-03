// Protected first-use routing and real SDK transport. Permissions and service
// observations below are synthetic; actual installed/public-owner journeys are
// retained independently and do not count as final candidate acceptance.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {readWorkspaceSetupConfiguration,validateWorkspaceSetupGrant} from '../../dist/host/setup.js';
import {openWorkspaceSetupOperator} from '../../dist/installation/workspace/setup-operator.js';
import {setupHostMain} from '../../dist/installation/setup-host.js';
import {runtimePluginMaterial} from '../../dist/host/plugin.js';
import {createStdioBridge} from '../../dist/host/bridge.js';
import {canonical,digest,ServiceError} from '../../dist/server/errors.js';
const repo=fs.realpathSync(new URL('../../',import.meta.url).pathname),prefix='evopilot_v01_',put=(p,v)=>fs.writeFileSync(p,canonical(v)+'\n',{mode:0o600}),parse=r=>JSON.parse(r.content[0].text);
function fixture(t){
 const root=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'runtime-setup-host-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const serviceRoot=join(root,'installed');fs.mkdirSync(serviceRoot,{mode:0o700});
 const tokenRef=join(serviceRoot,'client.json');put(tokenRef,{schema:'runtime-client-credential/v1',workspaceId:'setup-test',projectId:'alpha',principalId:'host',token:'synthetic_token_not_used_for_service_access_12345'});
 const connection={schema:'runtime-host-connection/v1',origin:'http://127.0.0.1:33331',workspaceId:'setup-test',projectId:'alpha',principalId:'host',serviceId:'synthetic-service',version:JSON.parse(fs.readFileSync(join(repo,'package.json'))).version,tokenRef};const connectionRef=join(serviceRoot,'connection.json');put(connectionRef,connection);
 const grant={projectRoot:join(root,'project'),workspaceRoot:join(root,'workspace'),owners:{ontology:join(root,'ontology'),harness:join(root,'harness')},ownerHost:null,workspaceOperator:null,serviceAfterSetup:'running',expiresAt:new Date(Date.now()+3600000).toISOString()};
 const config={schema:'runtime-workspace-setup-operator/v1',...grant,serviceRoot,workspaceId:'setup-test',serviceId:connection.serviceId,connectionRef,installationPlanDigest:'a'.repeat(64),specificationDigest:'b'.repeat(64),connectionDigest:digest(connection)},ref=join(serviceRoot,'workspace-setup.json');put(ref,config);
 return{root,config,grant,ref,pin:digest(config),connection};
}
test('first-use selection is exact and read-only, and one plugin retains HTTP primary with the protected setup entry',t=>{
 const f=fixture(t),before=fs.readdirSync(f.root);assert.deepEqual(readWorkspaceSetupConfiguration(f.ref),f.config);const r=openWorkspaceSetupOperator(f.ref,f.pin);assert.deepEqual(r.connectionSelection(),{connectionRef:f.config.connectionRef});assert.deepEqual(r.definitions.map(t=>t.name),[prefix+'workspace_initialize',prefix+'workspace_attach',prefix+'workspace_inspect']);
 const material=runtimePluginMaterial(repo,f.config.connectionRef,fs.realpathSync(process.execPath),{setupConfigRef:f.ref,setupConfigDigest:f.pin}),servers=JSON.parse(material.files.get('.mcp.json')).mcpServers;
 assert.deepEqual(Object.keys(servers),['evopilot_runtime','evopilot_runtime_legacy']);assert.equal(servers.evopilot_runtime.type,'http');assert(servers.evopilot_runtime_legacy.args.includes(join(repo,'dist/installation/setup-host.js')));assert(servers.evopilot_runtime_legacy.args.includes(f.pin));assert.deepEqual(fs.readdirSync(f.root),before);assert(!fs.existsSync(f.config.projectRoot));assert(!fs.existsSync(f.config.workspaceRoot));
});
test('caller-supplied roots, missing attach fields and arbitrary arguments cannot widen the installed selection',async t=>{
 const f=fixture(t),r=openWorkspaceSetupOperator(f.ref,f.pin);
 await assert.rejects(r.call(prefix+'workspace_initialize',{requestId:'wrong',projectRoot:join(f.root,'foreign')}),{code:'SETUP_SCOPE'});
 await assert.rejects(r.call(prefix+'workspace_attach',{requestId:'missing'}),{code:'INVALID_FIELDS'});
 await assert.rejects(r.call(prefix+'workspace_initialize',{requestId:'bad',command:'shell'}),{code:'INVALID_FIELDS'});
 assert(!fs.existsSync(f.config.workspaceRoot));assert(!fs.existsSync(f.config.serviceRoot+'.evopilot-onboarding'));
 for(const change of [{workspaceRoot:f.grant.projectRoot},{serviceAfterSetup:'automatic'},{expiresAt:'invalid'},{extra:true}])assert.throws(()=>validateWorkspaceSetupGrant({...f.grant,...change}));
});
test('changed, expired, unsafe and foreign connection grants fail before any Workspace mutation',async t=>{
 const f=fixture(t),r=openWorkspaceSetupOperator(f.ref,f.pin),original=fs.readFileSync(f.ref);put(f.ref,{...f.config,expiresAt:'2035-01-01T00:00:00Z'});await assert.rejects(r.call(prefix+'workspace_initialize',{requestId:'changed'}),{code:'SETUP_CONFIGURATION_CHANGED'});fs.writeFileSync(f.ref,original);
 const expired={...f.config,expiresAt:'2020-01-01T00:00:00Z'};put(f.ref,expired);await assert.rejects(openWorkspaceSetupOperator(f.ref,digest(expired)).call(prefix+'workspace_initialize',{requestId:'expired'}),{code:'SETUP_EXPIRED'});fs.writeFileSync(f.ref,original);
 put(f.config.connectionRef,{...f.connection,serviceId:'foreign'});assert.throws(()=>runtimePluginMaterial(repo,f.config.connectionRef,fs.realpathSync(process.execPath),{setupConfigRef:f.ref,setupConfigDigest:f.pin}),{code:'SETUP_CONFIGURATION'});await assert.rejects(r.call(prefix+'workspace_initialize',{requestId:'foreign'}),{code:'SETUP_SCOPE'});put(f.config.connectionRef,f.connection);
 fs.chmodSync(f.ref,0o644);assert.throws(()=>readWorkspaceSetupConfiguration(f.ref),{code:'UNSAFE_STATE'});assert(!fs.existsSync(f.config.workspaceRoot));
});
test('setup bootstrap rejects duplicate or mismatched transport and owner flags before opening a connection',async t=>{
 const f=fixture(t),args=['--setup-config-ref',f.ref,'--setup-config-digest',f.pin,'--connection-ref',f.config.connectionRef,'--legacy-only'];
 await assert.rejects(setupHostMain([...args,'--setup-config-ref',f.ref]),{code:'INVALID_ARGUMENT'});
 await assert.rejects(setupHostMain([...args,'--owner-config-ref',f.ref]),{code:'INVALID_ARGUMENT'});
 await assert.rejects(setupHostMain(['--setup-config-ref',f.ref,'--setup-config-digest',f.pin,'--connection-ref',join(f.root,'foreign.json')]),{code:'WORKSPACE_OPERATOR_SCOPE'});
 assert(!fs.existsSync(f.config.workspaceRoot));
});
test('same SDK session refreshes discovery after setup, serializes overlapping calls and requires explicit session activation',async()=>{
 let bound=false,release,entered;const enteredPromise=new Promise(r=>entered=r),pending=new Promise(r=>release=r),trace=[];
 const fake={connection:{workspaceId:'synthetic',projectId:'alpha',serviceId:'same',version:'0.8.3'},async status(){trace.push('status');return{requestId:'synthetic',result:{legacy:bound?{bound:true}:null}};}};
 const name=prefix+'workspace_initialize',operator={definitions:[{name,description:'Synthetic retained setup',inputSchema:{type:'object',properties:{},additionalProperties:false}}],has:n=>n===name,requiresActiveSession:()=>false,deactivatesSession:()=>true,refreshesBinding:()=>true,async call(){trace.push('setup-start');entered();await pending;bound=true;trace.push('setup-end');return{sessionActivated:false};}};
 const server=createStdioBridge(fake,undefined,true,operator),client=new Client({name:'synthetic-setup-session',version:'1'}),[left,right]=InMemoryTransport.createLinkedPair();
 try{
  await server.connect(left);await client.connect(right);assert(!(await client.listTools()).tools.some(t=>t.name===prefix+'activate'));
  const setup=client.callTool({name,arguments:{}});await enteredPromise;const activation=client.callTool({name:prefix+'activate',arguments:{}});release();assert.equal(parse(await setup).result.sessionActivated,false);assert.equal(parse(await activation).sessionActive,true);assert(trace.indexOf('setup-end')>trace.indexOf('setup-start'));assert(!trace.slice(trace.indexOf('setup-start')+1,trace.indexOf('setup-end')).includes('status'));
  assert((await client.listTools()).tools.some(t=>t.name===prefix+'request'));
  await client.callTool({name,arguments:{}});const inactive=await client.callTool({name:prefix+'capabilities',arguments:{}});assert.equal(inactive.isError,true);assert.equal(parse(inactive).error.code,'SESSION_INACTIVE');
 }finally{release();await client.close();await server.close();}
});
test('a failed setup invalidates a previously cached unavailable binding without creating a fake active session',async()=>{
 let available=false;const fake={connection:{workspaceId:'synthetic',projectId:'alpha',serviceId:'same',version:'0.8.3'},async status(){if(!available)throw new ServiceError('SERVICE_UNAVAILABLE','synthetic outage');return{requestId:'read',result:{legacy:{bound:true}}};}},name=prefix+'workspace_attach';
 const operator={definitions:[{name,description:'Synthetic failure',inputSchema:{type:'object',properties:{},additionalProperties:false}}],has:n=>n===name,requiresActiveSession:()=>false,deactivatesSession:()=>true,refreshesBinding:()=>true,async call(){available=true;throw new ServiceError('SETUP_INTERRUPTED','synthetic partial result');}};
 const server=createStdioBridge(fake,undefined,true,operator),client=new Client({name:'synthetic-setup-recovery',version:'1'}),[left,right]=InMemoryTransport.createLinkedPair();try{await server.connect(left);await client.connect(right);await client.listTools();const failed=await client.callTool({name,arguments:{}});assert.equal(failed.isError,true);assert((await client.listTools()).tools.some(t=>t.name===prefix+'activate'));const inactive=await client.callTool({name:prefix+'capabilities',arguments:{}});assert.equal(parse(inactive).error.code,'SESSION_INACTIVE');}finally{await client.close();await server.close();}
});
