// SYNTHETIC workspace records/permissions. Real filesystem, SDK stdio and
// isolated Runtime HTTP exercise transport and recovery, not domain approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {relocationConfigurationFixture} from '../fixtures/relocation-configuration-v090.mjs';
import {openWorkspaceOperator} from '../../dist/installation/workspace/operator.js';
import {workspaceHostMain} from '../../dist/installation/workspace-host.js';
import {readWorkspaceOperatorConfiguration} from '../../dist/host/workspace.js';
import {runtimePluginMaterial} from '../../dist/host/plugin.js';
import {inspectManagedWorkspace} from '../../dist/installation/workspace/snapshot.js';
import {inspectMaintenanceTree} from '../../dist/installation/workspace/stream.js';
import {startRuntimeServer} from '../../dist/server/http.js';
import {canonical,digest} from '../../dist/server/errors.js';

const repo=new URL('../../',import.meta.url).pathname,node=fs.realpathSync(process.execPath),entry=join(repo,'dist/installation/workspace-host.js'),prefix='evopilot_v01_';
const write=(file,value)=>fs.writeFileSync(file,canonical(value)+'\n',{mode:0o600});
const fixture=t=>{const f=relocationConfigurationFixture(t,false,false,true);return{...f,ref:f.ownerHost.workspaceConfigRef,pin:f.ownerHost.workspaceConfigDigest};};
const route=f=>openWorkspaceOperator(f.ref,f.pin),call=(r,name,input={})=>r.call(prefix+name,input);
const parse=reply=>JSON.parse(reply.content[0].text);
test('operator bootstrap rejects a different transport installation or repeated permission selection before opening stdio',async t=>{
 const f=fixture(t),before=inspectMaintenanceTree(f.root),args=['--operator-config-ref',f.ref,'--operator-config-digest',f.pin];
 await assert.rejects(workspaceHostMain([...args,'--connection-ref',join(f.root,'foreign-connection.json')]),{code:'WORKSPACE_OPERATOR_SCOPE'});
 await assert.rejects(workspaceHostMain([...args,'--operator-config-ref',f.ref]),{code:'INVALID_ARGUMENT'});
 await assert.rejects(workspaceHostMain(['--operator-config-ref',f.ref]),{code:'INVALID_ARGUMENT'});
 assert.deepEqual(inspectMaintenanceTree(f.root),before);
});
async function connect(f,{connection=false,ref=f.ref}={}){
 const client=new Client({name:'synthetic-workspace-host',version:'1'}),transport=new StdioClientTransport({command:node,args:[entry,'--operator-config-ref',ref,'--operator-config-digest',f.pin,...(connection?['--connection-ref',f.operatorConfig.connectionRef,'--legacy-only']:[])],stderr:'pipe'});
 await client.connect(transport);return{client,transport,async close(){await client.close();await transport.close();}};
}

test('passive Workspace inspection/capacity expose only the selected roots and create no state or service',async t=>{
 const f=fixture(t),r=route(f),before=inspectMaintenanceTree(f.root),inspected=await call(r,'workspace_inspect');
 assert.equal(inspected.service.registered,false);assert.equal(inspected.consistentSnapshot,false);assert.equal(inspected.authority,false);assert.equal(inspected.serviceStarted,false);
 const capacity=await call(r,'workspace_capacity');assert.equal(capacity.consistentSnapshot,false);assert(capacity.state.entries>0);assert(capacity.service.bytes>0);
 assert.deepEqual(inspectMaintenanceTree(f.root),before);assert(!JSON.stringify({inspected,capacity}).includes('synthetic_client_credential_'));assert.equal(r.definitions.length,6);
});

test('protected local scope rejects permission widening, expired grants, different installations and arbitrary commands',async t=>{
 const f=fixture(t),r=route(f),original=fs.readFileSync(f.ref);
 write(f.ref,{...f.operatorConfig,expiresAt:'2035-01-01T00:00:00Z'});await assert.rejects(call(r,'workspace_inspect'),{code:'WORKSPACE_OPERATOR_CHANGED'});fs.writeFileSync(f.ref,original);
 const expired={...f.operatorConfig,expiresAt:'2020-01-01T00:00:00Z'};write(f.ref,expired);await assert.rejects(call(openWorkspaceOperator(f.ref,digest(expired)),'workspace_inspect'),{code:'WORKSPACE_OPERATOR_EXPIRED'});fs.writeFileSync(f.ref,original);
 const readOnly={...f.operatorConfig,calls:['workspace_inspect']};write(f.ref,readOnly);await assert.rejects(call(openWorkspaceOperator(f.ref,digest(readOnly)),'workspace_backup',{destinationRoot:join(f.root,'no-copy'),requestId:'no-copy'}),{code:'WORKSPACE_OPERATOR_FORBIDDEN'});fs.writeFileSync(f.ref,original);
 await assert.rejects(call(r,'workspace_inspect',{command:'arbitrary shell'}),{code:'INVALID_FIELDS'});
 const specFile=join(f.source.serviceRoot,'service-specification.json'),spec=fs.readFileSync(specFile);write(specFile,{...f.spec,port:f.spec.port+1});await assert.rejects(call(r,'workspace_inspect'),{code:'WORKSPACE_OPERATOR_SCOPE'});fs.writeFileSync(specFile,spec);
 fs.chmodSync(f.ref,0o644);assert.throws(()=>readWorkspaceOperatorConfiguration(f.ref),{code:'UNSAFE_STATE'});
});

test('local backup and anchored readback retain exact original identity; completed retry does not capture newer work',async t=>{
 const f=fixture(t),r=route(f),input={destinationRoot:join(f.root,'operator-backup'),requestId:'backup-one'},before=await inspectManagedWorkspace(f.source,'before');
 const first=await call(r,'workspace_backup',input);assert.equal(first.serviceStarted,false);assert.equal(first.businessWorkDispatched,false);assert.equal(first.value.snapshotDigest,before.snapshotDigest);
 const inspected=await call(r,'workspace_backup_inspect',{backupRoot:input.destinationRoot,requestId:'read-backup'});assert.equal(inspected.backupDigest,first.value.backupDigest);
 fs.writeFileSync(join(f.source.projectRoot,'new-work'),'later work',{mode:0o600});assert.deepEqual(await call(r,'workspace_backup',input),first);
 assert.equal(r.requiresActiveSession(prefix+'workspace_backup',input),false);assert.equal(r.requiresActiveSession(prefix+'workspace_backup',{...input,requestId:'new-request'}),true);
 await assert.rejects(call(r,'workspace_backup',{...input,destinationRoot:join(f.root,'different')}),{code:'MAINTENANCE_CONFLICT'});assert(!fs.existsSync(join(f.root,'different')));
});

test('an interrupted copy keeps its exact request and can resume after session deactivation without new source authority',async t=>{
 const f=fixture(t),r=route(f),input={destinationRoot:join(f.root,'interrupted-backup'),requestId:'recover-copy'},rename=fs.renameSync;let failed=false;
 fs.renameSync=(from,to)=>{rename(from,to);if(!failed&&to===join(input.destinationRoot,'project/assets/asset.json')){failed=true;throw Object.assign(new Error('synthetic fault'),{code:'SYNTHETIC_COPY_INTERRUPTED'});}};
 try{await assert.rejects(call(r,'workspace_backup',input),{code:'SYNTHETIC_COPY_INTERRUPTED'});}finally{fs.renameSync=rename;}
 assert.equal(r.requiresActiveSession(prefix+'workspace_backup',input),false);const result=await call(r,'workspace_backup',input);assert.equal(result.value.backupRoot,input.destinationRoot);assert.equal(result.action,'workspace_backup');
});

test('real stdio discovers passive tools offline but never starts Runtime to satisfy an unactivated backup',async t=>{
 const f=fixture(t),m=await connect(f);try{
  const tools=(await m.client.listTools()).tools.map(v=>v.name);assert(tools.includes(prefix+'workspace_inspect'));assert(tools.includes(prefix+'workspace_restore'));assert(!tools.includes('runtime_write'));
  const view=await m.client.callTool({name:prefix+'workspace_inspect',arguments:{}});assert(!view.isError);assert.equal(parse(view).result.service.registered,false);
  const denied=await m.client.callTool({name:prefix+'workspace_backup',arguments:{destinationRoot:join(f.root,'unactivated'),requestId:'denied'}});assert.equal(denied.isError,true);assert.equal(parse(denied).error.code,'SESSION_INACTIVE');assert(!fs.existsSync(join(f.root,'unactivated')));
 }finally{await m.close();}
});

test('offline rescue stdio restores missing original roots from the known anchor and never starts a service',async t=>{
 const f=fixture(t),saved=await call(route(f),'workspace_backup',{destinationRoot:join(f.root,'rescue-backup'),requestId:'before-rescue'}),rescue=join(f.root,'rescue-operator.json');fs.copyFileSync(f.ref,rescue);
 for(const role of ['projectRoot','workspaceRoot','serviceRoot'])fs.renameSync(f.source[role],f.source[role]+'.retained');
 const m=await connect(f,{ref:rescue});try{
  const reply=await m.client.callTool({name:prefix+'workspace_restore',arguments:{backupRoot:saved.value.backupRoot,requestId:'rescue-one'}});assert(!reply.isError,JSON.stringify(reply));const restored=parse(reply).result;
  assert.equal(restored.value.status,'VERIFIED');assert.equal(restored.serviceStarted,false);assert.equal(restored.businessWorkDispatched,false);
  assert.equal((await inspectManagedWorkspace(f.source,'after-rescue')).snapshotDigest,saved.value.snapshotDigest);
 }finally{await m.close();}
});

test('real HTTP activation cannot override another writer; the same retained maintenance request resumes offline after that writer closes',async t=>{
 const f=fixture(t);let server,m;
 try{
  server=await startRuntimeServer({stateRoot:join(f.source.serviceRoot,'data'),workspaceId:f.source.workspaceId,legacyBindingRef:join(f.source.serviceRoot,'legacy-binding.json')});
  f.spec.port=Number(new URL(server.url).port);write(join(f.source.serviceRoot,'service-specification.json'),f.spec);
  const connection=JSON.parse(fs.readFileSync(f.operatorConfig.connectionRef));connection.origin=server.url;write(f.operatorConfig.connectionRef,connection);f.operatorConfig.specificationDigest=digest(f.spec);write(f.ref,f.operatorConfig);f.pin=digest(f.operatorConfig);f.ownerHost.workspaceConfigDigest=f.pin;
  for(const [name,bytes] of runtimePluginMaterial(join(f.source.serviceRoot,'package'),f.operatorConfig.connectionRef,node,f.ownerHost).files)fs.writeFileSync(join(f.source.serviceRoot,'plugin',name),bytes);
  m=await connect(f,{connection:true});const activate=await m.client.callTool({name:prefix+'activate',arguments:{}});assert(!activate.isError,JSON.stringify(activate));
  const args={destinationRoot:join(f.root,'live-backup'),requestId:'same-request'},first=await m.client.callTool({name:prefix+'workspace_backup',arguments:args});assert.equal(first.isError,true);assert.equal(parse(first).error.code,'LEGACY_WRITER_ACTIVE');
  const capabilities=await m.client.callTool({name:prefix+'capabilities',arguments:{}});assert.equal(capabilities.isError,true);assert.equal(parse(capabilities).error.code,'SESSION_INACTIVE');
  await server.close();server=null;
  const resumed=await m.client.callTool({name:prefix+'workspace_backup',arguments:args});assert(!resumed.isError,JSON.stringify(resumed));assert.equal(parse(resumed).result.requestId,'same-request');assert.equal(parse(resumed).result.serviceStarted,false);
 }finally{await m?.close();await server?.close();}
});
