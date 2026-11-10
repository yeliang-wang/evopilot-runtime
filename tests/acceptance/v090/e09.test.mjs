import {pathToFileURL as collectorPathToFileURL} from 'node:url';
import {resolve as collectorResolve} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {openScenario,repository,sha} from './support.mjs';

const versions=['2025-06-18','2025-11-25'];
const rpc=(id,method,params)=>JSON.stringify({jsonrpc:'2.0',...(id===null?{}:{id}),method,...(params===undefined?{}:{params})});
const refs=versions.map(version=>({version,transport:`https://modelcontextprotocol.io/specification/${version}/basic/transports`,lifecycle:`https://modelcontextprotocol.io/specification/${version}/basic/lifecycle`,cancellation:`https://modelcontextprotocol.io/specification/${version}/basic/utilities/cancellation`}));

export async function executeE09() {
 const run=await openScenario('E09');let seq=0;
 const call=(version,method,params,options={})=>run.protocol(rpc(++seq,method,params),{headers:{'mcp-protocol-version':version,...options.headers}});
 const identity=result=>{
  assert.equal(result.serviceId,run.candidate.serviceId);assert.equal(result.version,run.candidate.version);
  assert.equal(result.workspaceId,run.selection.workspaceId);assert.equal(result.projectId,run.selection.projectId);
  assert.equal(result.independentLlm,false);assert.deepEqual(result.protocols,versions);
 };
 const snapshot=async()=>({definition:await run.read('lifecycle.definition.inspect'),events:await run.read('runtime.events.read')});
 async function initialize(proposed,headers={}){
  const response=await run.protocol(rpc(++seq,'initialize',{protocolVersion:proposed,capabilities:{},clientInfo:{name:'runtime-independent-protocol-acceptance',version:'1.0.0'}}),{headers});
  assert.equal(response.status,200);assert.equal(response.body.id,seq);assert.equal(response.body.jsonrpc,'2.0');
  assert.equal(response.body.result.serverInfo.name,'evopilot-runtime');assert.equal(response.body.result.serverInfo.version,run.candidate.version);
  assert.equal(response.body.result.protocolVersion,versions.includes(proposed)?proposed:versions.at(-1));
  assert.equal(response.headers['mcp-session-id'],undefined,'2025 transport permits stateless operation, but still uses initialization');
  assert.match(response.headers['content-type'],/^application\/json/);return response.body.result;
 }
 async function wire(version){
  const before=await snapshot();await initialize(version);
  const ready=await run.protocol(rpc(null,'notifications/initialized'),{headers:{'mcp-protocol-version':version}});assert.equal(ready.status,202);assert.equal(ready.rawBody,'');
  const list=await call(version,'tools/list');assert.equal(list.status,200);assert.equal(list.body.id,seq);
  assert.deepEqual(list.body.result.tools.map(t=>t.name),['runtime_read','runtime_write']);assert.equal(list.body.result.tools[0].annotations.readOnlyHint,true);
  const result=await call(version,'tools/call',{name:'runtime_read',arguments:{operation:'runtime.status',projectId:run.selection.projectId,input:{}}});
  assert.equal(result.status,200);assert.equal(result.body.id,seq);assert.notEqual(result.body.result.isError,true);
  const content=JSON.parse(result.body.result.content[0].text);identity(content.result);assert.equal(content.requestId,result.headers['x-request-id']);
  const ping=await call(version,'ping');assert.equal(ping.status,200);assert.deepEqual(ping.body.result,{});
  const cancel=await run.protocol(rpc(null,'notifications/cancelled',{requestId:seq,reason:'Already-completed read; must not undo or dispatch work'}),{headers:{'mcp-protocol-version':version}});
  assert.equal(cancel.status,202);assert.equal(cancel.rawBody,'');
  const get=await run.protocol(undefined,{method:'GET',headers:{accept:'text/event-stream','mcp-protocol-version':version}});assert.equal(get.status,405);assert.equal(get.headers.allow,'POST');
  const end=await run.protocol(undefined,{method:'DELETE',headers:{'mcp-protocol-version':version}});assert.equal(end.status,405);
  assert.deepEqual(await snapshot(),before);return{protocolVersion:version,initialization:true,discovery:true,scopedToolCall:true,jsonResponses:true,optionalMcpSse:'NOT_OFFERED_HTTP_405',sessionId:'NOT_ISSUED',lateCancellation:'ACCEPTED_WITHOUT_BUSINESS_CHANGE',stateUnchanged:true};
 }
 async function errors(){
  const before=await snapshot();await initialize('unsupported-proposal');
  const badHeader=await call('2099-01-01','ping');assert.equal(badHeader.status,400);assert.equal(badHeader.body.error.code,'UNSUPPORTED_PROTOCOL');
  const absent=await run.protocol(rpc(++seq,'tools/list'));assert.equal(absent.status,400);assert.equal(absent.body.error.code,'UNSUPPORTED_PROTOCOL');
  const conflict=await call(versions.join(', '),'ping');assert.equal(conflict.status,400);assert.equal(conflict.body.error.code,'UNSUPPORTED_PROTOCOL');
  const mime=await run.protocol(rpc(++seq,'ping'),{headers:{'mcp-protocol-version':versions[1],'content-type':'text/plain'}});assert.equal(mime.status,415);
  const malformed=await run.protocol('{not-json',{headers:{'mcp-protocol-version':versions[1]}});assert.equal(malformed.status,400);
  const badShape=await run.protocol('{"jsonrpc":"1.0","id":12,"method":"ping"}',{headers:{'mcp-protocol-version':versions[1]}});assert.equal(badShape.status,400);assert.equal(typeof badShape.body.error.code,'number');
  const unknown=await call(versions[1],'unknown/acceptance-method');assert.equal(unknown.status,200);assert.equal(unknown.body.error.code,-32601);
  const params=await call(versions[1],'tools/call',{name:'runtime_read',arguments:[]});assert.equal(params.status,200);assert.equal(params.body.error.code,-32602);
  const tool=await call(versions[1],'tools/call',{name:'not-a-runtime-tool',arguments:{operation:'runtime.status',projectId:run.selection.projectId,input:{}}});assert.equal(tool.status,200);assert.equal(tool.body.result.isError,true);assert.equal(JSON.parse(tool.body.result.content[0].text).error.code,'UNKNOWN_TOOL');
  const accept=await call(versions[1],'ping',undefined,{headers:{accept:'application/json'}});assert.equal(accept.status,406);
  assert.deepEqual(await snapshot(),before);return{unsupportedProposalNegotiated:true,unsupportedOrConflictingHeadersRejected:true,contentTypeAndJsonRejected:true,invalidParametersAndUnknownMethodsRejected:true,notificationsDoNotAuthorizeWork:true,stateUnchanged:true};
 }
 async function officialClient(){
  const before=await snapshot(),client=new Client({name:'runtime-sdk-acceptance',version:'1.0.0'});
  const endpoint=new URL(run.serviceOrigin+'/mcp');
  // The SDK's real HTTP requests go through the evidence recorder to the exact
  // selected service. No response, dispatcher, store or owner is stubbed.
  const transport=new StreamableHTTPClientTransport(endpoint,{fetch:async(input,init)=>{
   assert.equal(String(input),String(endpoint));const headers=new Headers(init?.headers),kept={};
   for(const name of ['accept','content-type','mcp-protocol-version','mcp-session-id'])if(headers.has(name))kept[name]=headers.get(name);
   const observed=await run.protocol(init?.body,{method:init?.method??'GET',headers:kept});
   return new Response(observed.rawBody||null,{status:observed.status,headers:observed.headers});
  }});
  try{
   await client.connect(transport);assert.equal(client.getServerVersion().version,run.candidate.version);
   assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['runtime_read','runtime_write']);
   const result=await client.callTool({name:'runtime_read',arguments:{operation:'runtime.status',projectId:run.selection.projectId,input:{}}});assert.notEqual(result.isError,true);identity(JSON.parse(result.content[0].text).result);
  }finally{await client.close();}
  assert.deepEqual(await snapshot(),before);return{officialSdkActualTransport:true,independentWireClientAlsoRequired:true,stateUnchanged:true};
 }
 const completed=new Map();
 try{
  const metadata=JSON.parse(fs.readFileSync(path.join(run.selection.installedRoot,'package/package.json'))),lockBytes=fs.readFileSync(path.join(repository,'package-lock.json')),lock=JSON.parse(lockBytes);
  const sdk=lock.packages['node_modules/@modelcontextprotocol/sdk'];assert(sdk?.integrity);assert.equal(metadata.dependencies['@modelcontextprotocol/sdk'],sdk.version);
  run.artifact('protocol-contract.json',{references:refs,implementationChoices:{versions,response:'application/json',mcpSse:false,sessionIds:false,initialization:true,independentRuntimeEventStream:true},sdk:{version:sdk.version,integrity:sdk.integrity,sourceLockDigest:sha(lockBytes)},coverage:{matrixInstances:664,scenarioInstances:6,staticMappingIsNotE2E:true}});
  const selected=run.cases.filter(c=>c.caseInstanceId!=='E09.CV07');
  for(const c of selected)await run.collect(c,async()=>{
   let result;
   if(c.kind==='PROTOCOL')result=await wire(c.parameters.protocolVersion);
   else if(c.caseInstanceId==='E09.journey')result={...await officialClient(),...await errors()};
   else if(c.caseInstanceId==='E09.variant.01')result={versions:await PromiseSequential(versions,wire)};
   else if(c.caseInstanceId==='E09.variant.02')result={compatibleVersion:await wire(versions[0]),scope:'Explicit older supported protocol has its own wire exchange'};
   else throw Error('Unimplemented fixed E09 instance '+c.caseInstanceId);
   completed.set(c.caseInstanceId,result);return result;
  });
  const coverage=run.cases.find(c=>c.caseInstanceId==='E09.CV07');if(coverage)await run.collect(coverage,async()=>{
   const required=run.all.filter(c=>c.caseInstanceId!==coverage.caseInstanceId).map(c=>c.caseInstanceId);
   assert.deepEqual([...completed.keys()].sort(),required.sort(),'CV07 requires every frozen E09 journey and protocol, not a selected subset');
   run.artifact('protocol-coverage.json',{candidateDigest:run.candidateDigest,required,originalCases:required.map(id=>({caseInstanceId:id,ref:id+'.json',sha256:sha(fs.readFileSync(path.join(run.selection.outputRoot,id+'.json')))})),scope:'This E09 coverage record references actual same-campaign results; other scenarios remain separate obligations'});
   return{frozenInstances:run.all.map(c=>c.caseInstanceId),independentProtocolResults:versions.map(v=>({version:v,...completed.get('E09.http.'+v)})),fullDenominator:664,crossScenarioCoverage:'Requires separate E01/E02/E03/E18/E20 reports'};
  });
 }finally{run.finish();}
}
if(process.argv[1]&&collectorPathToFileURL(collectorResolve(process.argv[1])).href===import.meta.url)test('E09 installed candidate Streamable HTTP contract',executeE09);

async function PromiseSequential(items,fn){const out=[];for(const item of items)out.push(await fn(item));return out;}
