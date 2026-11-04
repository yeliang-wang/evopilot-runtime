// Synthetic protected grants; real SDK stdio admission. Actual published-owner
// configuration/worker/recovery is separately checked in an installed package.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {join,dirname} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {relocationConfigurationFixture} from '../fixtures/relocation-configuration-v090.mjs';
import {readWorkspaceOperatorConfiguration,validateWorkspaceOperatorGrant} from '../../dist/host/workspace.js';
import {openWorkspaceOperator} from '../../dist/installation/workspace/operator.js';
import {inspectMaintenanceTree} from '../../dist/installation/workspace/stream.js';
import {canonical,digest} from '../../dist/server/errors.js';
const prefix='evopilot_v01_',repo=new URL('../../',import.meta.url).pathname,write=(ref,value)=>{fs.mkdirSync(dirname(ref),{recursive:true,mode:0o700});fs.writeFileSync(ref,canonical(value)+'\n',{mode:0o600});};
function fixture(t){const f=relocationConfigurationFixture(t,false,false,true),config={...f.operatorConfig,calls:['workspace_inspect','online_configure','online_worker'],online:{hosts:[{connectionRef:f.operatorConfig.connectionRef,ownerConfigRef:join(f.root,'not-configured-owner.json'),ownerConfigDigest:'a'.repeat(64)}]}};write(f.ownerHost.workspaceConfigRef,config);return{...f,config,ref:f.ownerHost.workspaceConfigRef,pin:digest(config)};}
const route=f=>openWorkspaceOperator(f.ref,f.pin),call=(r,name,args)=>r.call(prefix+name,args),settings=f=>({scopes:[{projectId:'synthetic',visibility:'private'}],prometheus:[{id:'metrics',origin:'http://127.0.0.1:19090',bearerTokenFile:null,freshnessSeconds:60}],alertmanager:[{id:'alerts',bearerTokenFile:join(f.root,'secret')}],receiverPort:19093,tickSeconds:2});
async function connect(f){const client=new Client({name:'synthetic-online-operator',version:'1'}),transport=new StdioClientTransport({command:fs.realpathSync(process.execPath),args:[join(repo,'dist/installation/workspace-host.js'),'--operator-config-ref',f.ref,'--operator-config-digest',f.pin],stderr:'pipe'});await client.connect(transport);return{client,async close(){await client.close();await transport.close();}};}
const parse=r=>JSON.parse(r.content[0].text);

test('online tools require an explicit protected per-project grant and never appear through an ordinary operator',t=>{
 const f=fixture(t),grant={projectRoot:f.config.selection.projectRoot,referenceFiles:[],owners:f.config.owners,calls:['online_worker'],expiresAt:f.config.expiresAt};
 assert.throws(()=>validateWorkspaceOperatorGrant(grant),{code:'WORKSPACE_OPERATOR_CONFIGURATION'});assert.deepEqual(validateWorkspaceOperatorGrant({...grant,online:f.config.online}).online,f.config.online);
 for(const online of [{hosts:[]},{hosts:[...f.config.online.hosts,...f.config.online.hosts]},{hosts:[{...f.config.online.hosts[0],ownerConfigRef:'relative'}]}])assert.throws(()=>validateWorkspaceOperatorGrant({...grant,online}));
 const ordinary={...f.config,calls:['workspace_inspect']};delete ordinary.online;write(f.ref,ordinary);const r=openWorkspaceOperator(f.ref,digest(ordinary));assert.deepEqual(r.definitions.map(t=>t.name),[prefix+'workspace_inspect']);assert.equal(r.has(prefix+'online_worker'),false);
});
test('online discovery and unconfigured inspection remain passive and never borrow a project credential',async t=>{
 const f=fixture(t),r=route(f),before=inspectMaintenanceTree(f.root);assert.equal(r.definitions.length,3);
 assert.equal(r.requiresActiveSession(prefix+'online_worker',{operation:'inspect',requestId:'inspect'}),false);
 const result=await call(r,'online_worker',{operation:'inspect',requestId:'inspect'});assert.equal(result.worker,null);assert.equal(result.configurationDigest,null);assert(result.diagnostic);assert.deepEqual(inspectMaintenanceTree(f.root),before);
 assert(!fs.existsSync(f.source.serviceRoot+'.evopilot-operations'));assert(!JSON.stringify(result).includes('synthetic_client_credential_'));
});
test('new configuration and control require activation; configuration deactivates and refreshes only the transport binding',t=>{
 const f=fixture(t),r=route(f),args={settings:settings(f),expectedDigest:null,requestId:'configure'};
 assert.equal(r.requiresActiveSession(prefix+'online_configure',args),true);for(const operation of ['start','stop','uninstall'])assert.equal(r.requiresActiveSession(prefix+'online_worker',{operation,requestId:operation}),true);
 assert.equal(r.deactivatesSession(prefix+'online_configure'),true);assert.equal(r.refreshesBinding(prefix+'online_configure'),true);assert.equal(r.deactivatesSession(prefix+'online_worker'),false);
 assert.throws(()=>r.requiresActiveSession(prefix+'online_configure',{...args,command:'shell'}),{code:'INVALID_FIELDS'});assert.throws(()=>r.requiresActiveSession(prefix+'online_worker',{operation:'run',requestId:'run'}),{code:'ONLINE_WORKER_ARGUMENTS'});
});
test('same original request permits only recovery while changed input, changed binding or corrupt journal is refused',t=>{
 const f=fixture(t),r=route(f),action='online_worker',args={operation:'start',requestId:'original'},body={schema:'runtime-online-operator-request/v1',configurationDigest:f.pin,intentDigest:digest({configurationDigest:f.pin,action,args}),action,args,state:'UNKNOWN'},ref=join(f.source.serviceRoot+'.evopilot-operations','online','original.json'),save=value=>write(ref,{...value,journalDigest:digest(value)});save(body);
 assert.equal(r.requiresActiveSession(prefix+action,args),false);assert.throws(()=>r.requiresActiveSession(prefix+action,{...args,operation:'stop'}),{code:'REQUEST_CONFLICT'});
 save({...body,configurationDigest:'b'.repeat(64),intentDigest:digest({configurationDigest:'b'.repeat(64),action,args})});assert.throws(()=>r.requiresActiveSession(prefix+action,args),{code:'REQUEST_CONFLICT'});
 write(ref,{...body,journalDigest:'c'.repeat(64)});assert.throws(()=>r.requiresActiveSession(prefix+action,args),{code:'ONLINE_OPERATION_JOURNAL'});
 save({...body,state:'COMPLETE'});assert.throws(()=>r.requiresActiveSession(prefix+action,args),{code:'ONLINE_OPERATION_JOURNAL'});
});
test('connected operator cannot inherit widened permissions or expired grants',async t=>{
 const f=fixture(t),r=route(f),original=fs.readFileSync(f.ref);write(f.ref,{...f.config,online:{hosts:[{...f.config.online.hosts[0],ownerConfigDigest:'b'.repeat(64)}]}});await assert.rejects(call(r,'online_worker',{operation:'inspect',requestId:'inspect'}),{code:'WORKSPACE_OPERATOR_CHANGED'});fs.writeFileSync(f.ref,original);
 const expired={...f.config,expiresAt:'2020-01-01T00:00:00Z'};write(f.ref,expired);await assert.rejects(call(openWorkspaceOperator(f.ref,digest(expired)),'online_worker',{operation:'inspect',requestId:'inspect'}),{code:'WORKSPACE_OPERATOR_EXPIRED'});
 fs.chmodSync(f.ref,0o644);assert.throws(()=>readWorkspaceOperatorConfiguration(f.ref),{code:'UNSAFE_STATE'});
});
test('actual stdio exposes selected online tools offline but blocks a new inactive configure/start without writes',async t=>{
 const f=fixture(t),m=await connect(f),before=inspectMaintenanceTree(f.root);try{
  const tools=(await m.client.listTools()).tools.map(v=>v.name);assert(tools.includes(prefix+'online_configure'));assert(tools.includes(prefix+'online_worker'));assert(!tools.includes('runtime_write'));
  const inspected=await m.client.callTool({name:prefix+'online_worker',arguments:{operation:'inspect',requestId:'inspect'}});assert(!inspected.isError);assert.equal(parse(inspected).result.worker,null);
  for(const [name,args] of [['online_configure',{settings:settings(f),expectedDigest:null,requestId:'configure'}],['online_worker',{operation:'start',requestId:'start'}]]){const result=await m.client.callTool({name:prefix+name,arguments:args});assert.equal(result.isError,true);assert.equal(parse(result).error.code,'SESSION_INACTIVE');}
  assert.deepEqual(inspectMaintenanceTree(f.root),before);
 }finally{await m.close();}
});
