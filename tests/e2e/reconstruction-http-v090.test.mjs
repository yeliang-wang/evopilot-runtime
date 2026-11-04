// Real HTTP/stdio and macOS sandbox; synthetic plans, policy and specification.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createLocalReconstructionAdapter,describeLocalReconstruction} from '@evopilot-next/runtime/reconstruction-adapters';
import {reconstructionFixture,hash,observation} from '../fixtures/reconstruction.mjs';
import {nativeBytesDigest} from '../../vendor/compatibility/v1/native.mjs';
import {RuntimeStore} from '../../dist/server/store.js';
import {initializeCredentials,tokenDigest} from '../../dist/server/security.js';
import {startRuntimeServer} from '../../dist/server/http.js';
import {inspectLegacyWorkspace,createLegacyBackup,adoptLegacyWorkspace} from '../../dist/installation/migration.js';
import {createRuntimeHttpClient} from '../../dist/host/client.js';
import {forwardLegacyRuntime} from '../../dist/host/legacy-tools.js';
import {createLegacyOwnerProviders} from '../../dist/host/legacy-owner-providers.js';
import {createManagedLegacyService} from '../../dist/compat/managed-service.js';

const put=(ref,value)=>fs.writeFileSync(ref,JSON.stringify(value),{mode:0o600});
async function fixture(t){
  const cleanup=[],f=await reconstructionFixture({after:fn=>cleanup.push(fn)},{prepare:false,budget:{wallMs:20000,maxTokens:0,maxCostMicros:0,maxOutputBytes:65536}}),root=join(f.root,'builder'),tools=join(f.root,'tools');fs.mkdirSync(root,{mode:0o700});fs.mkdirSync(tools,{mode:0o700});
  const programs={generation:`import fs from 'node:fs';const spec=JSON.parse(JSON.parse(fs.readFileSync(process.env.EVOPILOT_SPECIFICATION)).files[0].content);process.stdout.write(JSON.stringify({files:[{path:'app.mjs',content:'export const transform = x => x + '+spec.add+';'}],usage:{tokens:0,costMicros:0,iterations:1}}));`,build:`const app=await import(process.env.EVOPILOT_OUTPUT+'/app.mjs');if(typeof app.transform!=='function')throw Error('missing export');`,run:`const app=await import(process.env.EVOPILOT_OUTPUT+'/app.mjs');process.stdout.write(JSON.stringify({actual:app.transform(2)}));`};
  const stages=Object.fromEntries(Object.entries(programs).map(([name,code])=>{const entry=join(tools,name+'.mjs');fs.writeFileSync(entry,code,{mode:0o600});return[name,{entry,argv:[]}];}));
  const input={files:[{path:'specification.json',content:JSON.stringify({add:3})}],tools:Object.values(stages).map(s=>({path:s.entry,digest:nativeBytesDigest(fs.readFileSync(s.entry))})),stages},pins=describeLocalReconstruction(input);
  const plan={...f.plan,...Object.fromEntries(['inputManifestDigest','environmentDigest','dependenciesDigest'].map(k=>[k,pins[k]])),executor:{id:'seatbelt-node-v1',version:'1',provider:'local-offline',model:'none',executableDigest:pins.executableDigest,configurationDigest:pins.configurationDigest}};
  const adapter=createLocalReconstructionAdapter({root,resolve:async()=>input,verify:async p=>({planDigest:hash(p),current:true}),observe:async({claim,receipt})=>{
    const value=observation(claim,receipt),actual=JSON.parse(fs.readFileSync(join(root,claim.claimId.slice(7),'run.stdout')));delete value.digest;
    value.cases=[{caseId:'addition',inputDigest:hash({value:2}),status:'COMPLETE',actual:{output:actual.actual,state:null,error:null,effects:[]}}];return{...value,digest:hash(value)};
  }});
  f.close();Object.assign(f.providers,adapter);f.open();const binding=await f.freeze(plan);f.close();
  const stateRoot=join(f.root,'service'),workspaceId=f.options.workspaceId,projectId=f.scope.projectId,tokens={operator:randomBytes(32).toString('base64url'),reader:randomBytes(32).toString('base64url')};
  initializeCredentials(stateRoot,workspaceId,Object.entries(tokens).map(([id,token])=>({id,projects:[projectId],permissions:id==='reader'?['read']:['read','execution.request','decision.record'],revision:1,expiresAt:'2030-01-01T00:00:00Z',tokenDigest:tokenDigest(token)})));
  const store=new RuntimeStore(stateRoot,workspaceId),serviceId=store.serviceId;store.close();const snapshot=inspectLegacyWorkspace(f.options.workspaceRoot,workspaceId),backupRoot=join(f.root,'backup'),backup=createLegacyBackup(f.options.workspaceRoot,workspaceId,snapshot.snapshotDigest,backupRoot),adoption=adoptLegacyWorkspace({...f.options,serviceId,expectedSnapshotDigest:snapshot.snapshotDigest,backupRoot,expectedBackupDigest:backup.backupDigest});
  const bindingRef=join(f.root,'legacy-binding.json');put(bindingRef,adoption.binding);
  const serverOptions={stateRoot,workspaceId,legacyBindingRef:bindingRef};let server=await startRuntimeServer(serverOptions,undefined,undefined,undefined,undefined,undefined,undefined,undefined,adapter);
  const connections={};function connect(){for(const [id,token]of Object.entries(tokens)){const tokenRef=join(f.root,id+'-token.json'),connectionRef=join(f.root,id+'-connection.json');put(tokenRef,{schema:'runtime-client-credential/v1',workspaceId,projectId,principalId:id,token});put(connectionRef,{schema:'runtime-host-connection/v1',origin:server.url,workspaceId,projectId,principalId:id,serviceId,version:server.identity.version,tokenRef});connections[id]={connectionRef,client:createRuntimeHttpClient(connectionRef)};}}connect();
  t.after(async()=>{await server.close();for(const fn of cleanup)await fn();});
  const send=(request,id='operator')=>forwardLegacyRuntime(connections[id].client,'reconstruction',request).then(v=>v.result),read=(operation,input={})=>send({operation,scope:f.scope,input});let serial=0;
  const request=async(operation,input)=>({operation,scope:f.scope,input,requestId:'http-reconstruction-'+(++serial),expectedRevision:(await read('reconstruction.inspect')).revision});
  return{...f,root,binding,adapter,adoption,connections,send,read,request,async restart(providers=adapter){await server.close();server=await startRuntimeServer(serverOptions,undefined,undefined,undefined,undefined,undefined,undefined,undefined,providers);connect();}};
}

test('optional adapters dispatch through stdio into the same HTTP-managed Runtime, with exact receipts and independent owner readback',async t=>{
  const f=await fixture(t),client=new Client({name:'synthetic-reconstruction-compatibility',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[new URL('../../dist/host/bridge.js',import.meta.url).pathname,'--connection-ref',f.connections.operator.connectionRef],stderr:'pipe'});await client.connect(transport);
  const call=async(name,args)=>{const value=await client.callTool({name,arguments:args});assert(!value.isError,JSON.stringify(value));return JSON.parse(value.content[0].text).result;};
  try{
    await call('evopilot_v01_activate',{});const request=await f.request('reconstruction.dispatch',{planDigest:f.binding.digest}),first=await call('evopilot_v01_native',{owner:'runtime',envelope:request});assert.equal(first.attempt.status,'SUCCEEDED',JSON.stringify(first));
    assert.equal((await f.read('reconstruction.attempt',{id:request.requestId})).receipt.digest,first.attempt.receipt.digest);assert.deepEqual(await f.send(request),first);assert.equal(fs.readdirSync(f.root).length,1);
    const second=await f.send(await f.request('reconstruction.dispatch',{planDigest:f.binding.digest}));assert.equal(second.attempt.status,'SUCCEEDED');assert.notEqual(first.attempt.receipt.workspaceId,second.attempt.receipt.workspaceId);
    const owners=createLegacyOwnerProviders({workspaceId:f.options.workspaceId,projectId:f.scope.projectId,client:f.connections.operator.client,guard:()=>({scope:f.scope}),readOwner:async()=>{throw Error('Runtime evidence must use HTTP');}});
    const evidence=await owners.readReconstructionEvidence({workspaceId:f.options.workspaceId,scope:f.scope,attemptId:first.attempt.id},new AbortController().signal);assert.equal(evidence.cases[0].actual.output,5);assert.equal(evidence.execution.receiptDigest,first.attempt.receipt.digest);assert.equal(evidence.origin,'SYNTHETIC');
    assert.throws(()=>createManagedLegacyService(f.adoption.binding),{code:'LEGACY_WRITER_ACTIVE'});
    await client.close();await f.restart();assert.equal((await f.read('reconstruction.attempt',{id:first.attempt.id})).receipt.digest,first.attempt.receipt.digest);
    fs.appendFileSync(join(f.root,first.attempt.claim.claimId.slice(7),'run.stdout'),'changed');await assert.rejects(f.read('reconstruction.evidence',{id:first.attempt.id}),{code:'BUILDER_TRACE_DRIFT'});
  }finally{await client.close();}
});

test('reader and cross-project requests cannot dispatch or register a reconstruction adapter through JSON',async t=>{
  const f=await fixture(t),request=await f.request('reconstruction.dispatch',{planDigest:f.binding.digest});await assert.rejects(f.send(request,'reader'),{code:'FORBIDDEN'});await assert.rejects(f.send({...request,scope:{...f.scope,projectId:'other'}}),{code:'CREDENTIAL_SCOPE'});
  await assert.rejects(f.send({...request,input:{...request.input,provider:{execute:'/bin/sh'}}}));assert.deepEqual(fs.readdirSync(f.root),[]);
  assert.equal((await f.connections.operator.client.status()).result.independentLlm,false);
});

test('without optional trusted providers the original evidence remains readable, but import and HTTP connection do not enable execution',async t=>{
  const f=await fixture(t);await f.restart({});assert.equal((await f.read('reconstruction.plan',{digest:f.binding.digest})).digest,f.binding.digest);
  await assert.rejects(f.send(await f.request('reconstruction.dispatch',{planDigest:f.binding.digest})),{code:'RECONSTRUCTION_UNSUPPORTED'});assert.deepEqual(fs.readdirSync(f.root),[]);
});
