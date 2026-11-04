// Candidate-bound acceptance infrastructure. No fixture binding provider, store
// mutation, implicit service startup or acceptance inference from source tests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {readRegular,canonicalPath} from '../../../dist/compat/project/files.js';
import {readHostConnection,hostHeaders} from '../../../dist/server/security.js';
import {inspectInstalledServiceSelection} from '../../../dist/installation/service-control.js';

export const repository=fileURLToPath(new URL('../../../',import.meta.url));
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=ref=>JSON.parse(fs.readFileSync(ref));
const keys=(v,required,optional=[])=>{
 assert(v&&typeof v==='object'&&!Array.isArray(v));
 assert(required.every(k=>Object.hasOwn(v,k)));assert(Object.keys(v).every(k=>required.includes(k)||optional.includes(k)));
};
const bounded=async response=>{
 const reader=response.body.getReader(),parts=[];let bytes=0;
 try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;assert(bytes<=262144,'Service response exceeds the frozen bound');parts.push(part.value);}}
 finally{reader.releaseLock();}
 assert(bytes===0||response.headers.get('content-type')?.startsWith('application/json'),'Expected JSON or an empty notification acknowledgement from the selected Runtime');
 return Buffer.concat(parts).toString('utf8');
};

export async function openScenario(scenario){
 const selectionRef=process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION;
 assert(selectionRef,'Set EVOPILOT_V090_ACCEPTANCE_SELECTION to a protected, explicit isolated candidate selection');
 const selection=JSON.parse(readRegular(selectionRef,131072,true));
 keys(selection,['schema','installedRoot','expectedManifestDigest','connectionRef','workspaceId','projectId','runId','outputRoot','qualification'],['caseIds']);
 assert.equal(selection.schema,'runtime-v090-acceptance-selection/v1');assert(['DEVELOPMENT','FINAL_CANDIDATE'].includes(selection.qualification));
 assert(/^[a-z][a-z0-9-]{0,47}$/.test(selection.runId));assert(/^[a-f0-9]{64}$/.test(selection.expectedManifestDigest));
 const target=json(path.join(repository,'governance/target-v090.json'));
 const matrixRef=path.join(repository,'governance/parameter-matrix-v090.json'),matrixBytes=fs.readFileSync(matrixRef),matrix=JSON.parse(matrixBytes);
 assert.equal(sha(matrixBytes),target.implementationBindings['governance/parameter-matrix-v090.json']);assert.equal(matrix.count,664);
 const all=matrix.caseInstances.filter(c=>c.scenario===scenario);assert(all.length);
 const selectedIds=selection.caseIds??all.map(c=>c.caseInstanceId);
 assert(Array.isArray(selectedIds)&&selectedIds.length&&new Set(selectedIds).size===selectedIds.length);
 assert(selectedIds.every(id=>all.some(c=>c.caseInstanceId===id)),'The selection may not create or replace a frozen case');
 const cases=all.filter(c=>selectedIds.includes(c.caseInstanceId));
 const current=inspectInstalledServiceSelection(selection.installedRoot);
 const plan=json(path.join(selection.installedRoot,'installation-plan.json'));
 assert.equal(plan.distribution.manifestDigest,selection.expectedManifestDigest);
 const manifest=json(path.join(selection.installedRoot,'distribution-manifest.json'));
 const connection=readHostConnection(selection.connectionRef);
 assert.equal(selection.connectionRef,path.join(selection.installedRoot,'connection.json'));
 assert.equal(connection.workspaceId,selection.workspaceId);assert.equal(connection.projectId,selection.projectId);
 assert.equal(connection.serviceId,current.serviceId);assert.equal(connection.version,manifest.version);
 if(selection.qualification==='FINAL_CANDIDATE')assert.equal(manifest.version,'0.9.0','Development version cannot qualify the final release');
 canonicalPath(path.dirname(selection.outputRoot));assert(!fs.existsSync(selection.outputRoot),'Retain existing campaign evidence; do not overwrite a prior attempt');
 assert(!selection.outputRoot.startsWith(selection.installedRoot+path.sep));fs.mkdirSync(selection.outputRoot,{mode:0o700});
 const write=(name,value)=>fs.writeFileSync(path.join(selection.outputRoot,name),JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
 const candidate={manifestDigest:selection.expectedManifestDigest,archiveDigest:manifest.archiveDigest,version:manifest.version,serviceId:connection.serviceId,workspaceId:selection.workspaceId,projectId:selection.projectId};
 // Candidate identity is the immutable package, not a particular test service
 // or Workspace. Different scenario installations must share this identity.
 const candidateDigest='sha256:'+selection.expectedManifestDigest;
 const collectorPins=Object.fromEntries(['support.mjs',scenario.toLowerCase()+'.test.mjs'].map(name=>[name,sha(fs.readFileSync(new URL(name,import.meta.url)))]));
 write('selection.json',{scenario,qualification:selection.qualification,candidate,candidateDigest,collectorPins,matrixDigest:sha(matrixBytes),selectedCaseIds:selectedIds,scenarioDenominator:all.length,fullDenominator:matrix.count,sourceQualification:'SEPARATE_E20_OBLIGATION'});
 let sequence=0,currentCase=null,uncertain=false;
 const evidence=[],results=[];
 async function request(operation,input={},meta={}){
  assert(!uncertain,'Inspect the original uncertain request before making another mutation');
  const envelope={operation,projectId:selection.projectId,input,...meta},id=String(++sequence).padStart(5,'0'),ref=id+'-request.json';
  write(ref,{caseInstanceId:currentCase,envelope});
  let response,raw;
  try{response=await fetch(connection.origin+'/api/v1/request',{method:'POST',headers:{...hostHeaders(connection),'content-type':'application/json'},body:JSON.stringify(envelope),signal:AbortSignal.timeout(30000),redirect:'error'});raw=await bounded(response);}
  catch(error){uncertain=!!meta.requestId;write(id+'-transport-failure.json',{caseInstanceId:currentCase,operation,requestId:meta.requestId??null,outcome:uncertain?'UNKNOWN':'READ_FAILED',automaticRetry:false});throw error;}
  const body=JSON.parse(raw),responseRef=id+'-response.json';write(responseRef,{caseInstanceId:currentCase,status:response.status,rawBody:raw,body});evidence.push({caseInstanceId:currentCase,request:ref,response:responseRef,responseDigest:sha(raw),fileDigest:sha(fs.readFileSync(path.join(selection.outputRoot,responseRef)))});
  return{status:response.status,body};
 }
 async function protocol(rawBody,options={},mutation=null){
  assert(!uncertain,'Inspect the original uncertain request before another operation');
  keys(options,[],['method','headers']);
  const method=options.method??'POST',extra=options.headers??{};
  assert(['POST','GET','DELETE'].includes(method));
  keys(extra,[],['accept','content-type','mcp-protocol-version','mcp-session-id']);
  assert(Object.values(extra).every(v=>typeof v==='string'&&v.length<=128));
  if(method==='POST'){
   assert.equal(typeof rawBody,'string');assert(Buffer.byteLength(rawBody)<=262144);
   // The raw E09 entry is read-only. Only the typed E03 entry below can supply
   // an exact configuration mutation; it never permits execution or authority.
   if(rawBody.includes('runtime_write'))assert(mutation?.requestId&&scenario==='E03'&&JSON.parse(rawBody).params.arguments.requestId===mutation.requestId,'Protocol qualification must not dispatch business mutations');
  }else assert.equal(rawBody,undefined);
  const safeHeaders={accept:'application/json, text/event-stream','content-type':'application/json',...extra};
  const id=String(++sequence).padStart(5,'0'),ref=id+'-protocol-request.json';
  write(ref,{caseInstanceId:currentCase,method,path:'/mcp',headers:safeHeaders,rawBody:rawBody??null,authentication:'SELECTED_PROTECTED_CONNECTION'});
  let response,raw;
  try{
   response=await fetch(connection.origin+'/mcp',{method,headers:{...hostHeaders(connection),...safeHeaders},...(method==='POST'?{body:rawBody}:{}),signal:AbortSignal.timeout(30000),redirect:'error'});
   assert(!response.headers.get('content-type')?.includes('text/event-stream'),'The selected Runtime declares JSON-only MCP responses; its separate lifecycle event stream is not an MCP SSE channel');
   if(response.body)raw=await bounded(response);else raw='';
  }catch(error){uncertain=!!mutation;write(id+'-protocol-failure.json',{caseInstanceId:currentCase,requestId:mutation?.requestId??null,outcome:uncertain?'UNKNOWN':'READ_FAILED',error:{name:error.name,message:error.message},automaticRetry:false});throw error;}
  const headers=Object.fromEntries(['content-type','mcp-session-id','mcp-protocol-version','x-request-id','allow'].map(k=>[k,response.headers.get(k)]).filter(([,v])=>v!==null));
  const responseRef=id+'-protocol-response.json';write(responseRef,{caseInstanceId:currentCase,status:response.status,headers,rawBody:raw});
  evidence.push({caseInstanceId:currentCase,request:ref,response:responseRef,responseDigest:sha(raw),fileDigest:sha(fs.readFileSync(path.join(selection.outputRoot,responseRef)))});
  return{status:response.status,headers,rawBody:raw,body:raw?JSON.parse(raw):null};
 }
 async function configurationEntry(entry,operation,input={},meta={}){
  assert.equal(scenario,'E03');assert(['http-api','http-mcp','cli'].includes(entry));
  const writes=['lifecycle.draft.save','lifecycle.definition.save-and-activate'];
  const reads=['lifecycle.definition.inspect','lifecycle.definition.validate'];
  assert([...writes,...reads].includes(operation));
  const mutation=writes.includes(operation),envelope={operation,projectId:selection.projectId,input,...meta};
  assert.equal(Boolean(meta.requestId),mutation);assert(!uncertain,'Inspect the original uncertain request before another operation');
  if(entry==='http-api'){const r=await request(operation,input,meta);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;}
  if(entry==='http-mcp'){
   const version='2025-11-25',headers={'mcp-protocol-version':version};
   const init=await protocol(JSON.stringify({jsonrpc:'2.0',id:'initialize-'+(sequence+1),method:'initialize',params:{protocolVersion:version,capabilities:{},clientInfo:{name:'runtime-e03-entry-acceptance',version:'1'}}}));
   assert.equal(init.status,200);assert.equal(init.body.result.protocolVersion,version);
   const ready=await protocol(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'}),{headers});assert.equal(ready.status,202);
   const id='entry-'+(sequence+1),r=await protocol(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:mutation?'runtime_write':'runtime_read',arguments:envelope}}),{headers},mutation?meta:null);
   assert.equal(r.status,200);assert.equal(r.body.id,id);assert(!r.body.error,JSON.stringify(r.body));assert.notEqual(r.body.result.isError,true,JSON.stringify(r.body));
   const body=JSON.parse(r.body.result.content[0].text);assert.equal(body.requestId,r.headers['x-request-id']);return body;
  }
  const id=String(++sequence).padStart(5,'0'),ref=id+'-cli-envelope.json';write(ref,envelope);
  const args=[path.join(selection.installedRoot,'package/dist/server/cli.js'),'request','--url',connection.origin,'--token-ref',connection.tokenRef,'--project',selection.projectId,'--request-ref',path.join(selection.outputRoot,ref)];
  const result=await new Promise(resolve=>execFile(plan.nodeExecutable,args,{timeout:35000,maxBuffer:524288,encoding:'utf8'},(error,stdout,stderr)=>resolve({exitCode:error?error.code:0,signal:error?.signal??null,stdout,stderr})));
  const responseRef=id+'-cli-result.json';write(responseRef,{caseInstanceId:currentCase,executable:plan.nodeExecutable,args,...result});
  evidence.push({caseInstanceId:currentCase,request:ref,response:responseRef,fileDigest:sha(fs.readFileSync(path.join(selection.outputRoot,responseRef)))});
  let body;try{assert(Buffer.byteLength(result.stdout)<=262144);body=JSON.parse(result.stdout);}catch(error){uncertain=mutation;throw error;}
  if(result.signal||body.error?.code==='REQUEST_OUTCOME_UNKNOWN')uncertain=mutation;
  assert.equal(result.exitCode,0,JSON.stringify(body));assert.equal(result.signal,null);return body;
 }
 function artifact(name,value){
  assert(/^[a-z][a-z0-9-]{0,70}\.json$/.test(name));
  const ref=String(++sequence).padStart(5,'0')+'-'+name;write(ref,{caseInstanceId:currentCase,...value});
  const item={caseInstanceId:currentCase,artifact:ref,fileDigest:sha(fs.readFileSync(path.join(selection.outputRoot,ref)))};evidence.push(item);return item;
 }
 async function read(operation,input={}){const r=await request(operation,input);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.result;}
 async function source(revisionId){let offset=0;const chunks=[];for(;;){const page=await read('lifecycle.definition.source.read',{revisionId,offset});assert.equal(page.revisionId,revisionId);chunks.push(Buffer.from(page.data,'base64'));if(page.nextOffset===null)return Buffer.concat(chunks).toString('utf8');assert(page.nextOffset>offset);offset=page.nextOffset;}}
 const status=await read('runtime.status');assert.equal(status.serviceId,connection.serviceId);assert.equal(status.workspaceId,selection.workspaceId);assert.equal(status.version,manifest.version);
 return{selection,candidate,candidateDigest,cases,all,request,read,source,protocol,artifact,configurationEntry,serviceOrigin:connection.origin,
  requestId:(caseId,suffix)=>scenario.toLowerCase()+'-'+sha(selection.runId+'|'+caseId+'|'+suffix).slice(0,48),
  async collect(c,fn){currentCase=c.caseInstanceId;const first=evidence.length;
   try{const assertions=await fn();results.push({caseInstanceId:c.caseInstanceId,status:'PASS',candidateDigest,qualification:selection.qualification,assertions,evidence:evidence.slice(first)});}
   catch(error){results.push({caseInstanceId:c.caseInstanceId,status:'FAILED',candidateDigest,qualification:selection.qualification,error:{name:error.name,message:error.message,code:error.code??null},evidence:evidence.slice(first)});throw error;}
   finally{write(c.caseInstanceId+'.json',results.at(-1));currentCase=null;}
  },
  finish(){
   // Revalidate selected installed bytes after the run. This never certifies CI,
   // actual Codex/browser journeys or another unexecuted acceptance instance.
   const after=inspectInstalledServiceSelection(selection.installedRoot);assert.equal(after.selectionDigest,current.selectionDigest);
   for(const [name,pin] of Object.entries(collectorPins))assert.equal(sha(fs.readFileSync(new URL(name,import.meta.url))),pin,'Collector changed during execution');
   const missing=all.filter(c=>!results.some(r=>r.caseInstanceId===c.caseInstanceId)).map(c=>c.caseInstanceId),passed=results.filter(r=>r.status==='PASS').length;
   const report={scenario,candidate,candidateDigest,qualification:selection.qualification,scenarioDenominator:all.length,fullDenominator:matrix.count,selected:cases.length,executed:results.length,passed,failed:results.length-passed,unexecutedCaseIds:missing,scenarioStatus:missing.length||passed!==all.length?'INCOMPLETE':'OBSERVED_PASS',productAcceptance:'NOT_EVALUATED',releaseAuthorized:false,dailyInstallationChanged:false,setupEvidence:evidence.filter(e=>e.caseInstanceId===null),results};
   write('REPORT.json',report);return report;
  }};
}
