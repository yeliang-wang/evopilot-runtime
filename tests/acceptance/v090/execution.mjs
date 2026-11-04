// E13 uses only the exact installed service and its original native records.
// This helper has no decision/report writer, provider adapter or database API.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {sha} from './support.mjs';

export function exactKeys(value,required){
 assert(value&&typeof value==='object'&&!Array.isArray(value));
 assert.deepEqual(Object.keys(value).sort(),[...required].sort(),'Missing or unsupported interruption fixture fields');
}
export function interruptionFixture(run){
 const pin=run.selection.interruptionFixture;assert(pin,'Select a protected original interruption fixture; source tests cannot establish installed acceptance');exactKeys(pin,['ref','sha256']);
 assert.equal(fs.realpathSync(pin.ref),pin.ref);const stat=fs.lstatSync(pin.ref);
 assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.uid===process.getuid()&&(stat.mode&0o077)===0&&stat.size<=1048576);
 const bytes=fs.readFileSync(pin.ref);assert.equal(sha(bytes),pin.sha256);const fixture=JSON.parse(bytes);
 exactKeys(fixture,['schema','candidateDigest','workspaceId','projectId','syntheticAssets','syntheticDecisions','casePlans']);
 assert.equal(fixture.schema,'runtime-v090-interruption-fixture/v1');assert.equal(fixture.candidateDigest,run.candidateDigest);
 assert.equal(fixture.workspaceId,run.selection.workspaceId);assert.equal(fixture.projectId,run.selection.projectId);
 assert.equal(fixture.syntheticAssets,true);assert.equal(fixture.syntheticDecisions,true);
 assert(fixture.casePlans&&typeof fixture.casePlans==='object'&&!Array.isArray(fixture.casePlans));
 for(const id of Object.keys(fixture.casePlans))assert(run.all.some(c=>c.caseInstanceId===id),'Fixture cannot introduce an acceptance case');
 run.artifact('interruption-fixture.json',{reference:pin.ref,sha256:pin.sha256,candidateDigest:fixture.candidateDigest,selectedCaseIds:Object.keys(fixture.casePlans),syntheticAssets:true,syntheticDecisions:true});
 return fixture;
}

export async function openExecution(run,signal){
 const load=relative=>import(pathToFileURL(path.join(run.selection.installedRoot,'package/dist',relative)).href);
 const security=await load('server/security.js'),base=await load('lifecycle/base.js'),instanceApi=await load('lifecycle/instance.js'),control=await load('installation/service-control.js');
 const connection=security.readHostConnection(run.selection.connectionRef);
 assert.equal(connection.origin,run.serviceOrigin);assert.equal(connection.serviceId,run.candidate.serviceId);assert.equal(connection.projectId,run.selection.projectId);
 const origin=new URL(connection.origin);assert.equal(origin.protocol,'http:');assert.equal(origin.hostname,'127.0.0.1');assert.equal(origin.pathname,'/');
 function intact(value){const {digest,...body}=value;assert.equal(digest,base.valueDigest(body));return value;}
 async function instance(id){
  const result=await run.read('lifecycle.instance.inspect',{instanceId:id}),saved=instanceApi.inspectInstance(result.instance);
  assert.equal(saved.id,id);assert.equal(saved.pins.projectId,run.selection.projectId);assert.equal(base.isCurrentBase(saved.pins.base),true);
  return result;
 }
 async function original(id){
  const value=await run.read('lifecycle.stage.request.inspect',{stageRequestId:id}),request=intact(value.request);
  assert.equal(request.id,id);assert.equal(request.workspaceId,run.selection.workspaceId);assert.equal(request.projectId,run.selection.projectId);assert.equal(request.planDigest,base.valueDigest(request.plan));
  const saved=await instance(request.instanceId);assert.equal(saved.instance.pinsDigest,request.pinsDigest);assert.equal(saved.instance.stages[request.stageId].requestId,id);assert.equal(saved.instance.stages[request.stageId].inputDigest,request.inputDigest);
  assert.equal(value.automaticRedispatch,false);assert.equal(value.progress.requestId,id);
  if(value.progress.observationRef){const observed=await run.read('lifecycle.stage.observation.read',{stageRequestId:id,observationRef:value.progress.observationRef});assert.equal(observed.observationRef,base.valueDigest(observed.evidence));assert.deepEqual(observed.evidence.observation,value.progress.observation);}
  return{...value,instance:saved.instance};
 }
 async function events(){
  const result=[];let cursor;
  for(let page=0;page<400;page++){
   signal?.throwIfAborted();const value=await run.read('runtime.events.read',cursor?{cursor}:{});assert(Array.isArray(value.events)&&value.events.length<=50);assert(Buffer.byteLength(JSON.stringify(value))<=262144);
   for(const event of value.events){assert(event.seq>(result.at(-1)?.seq??0));result.push(event);}
   if(value.events.length===0)return result;assert.notEqual(value.cursor,cursor);cursor=value.cursor;
  }
  throw Error('Original event inventory exceeds the explicit 20000-event evidence bound');
 }
 async function until(id,predicate,description,timeoutMs=15000){
  const started=performance.now();let last;
  do{signal?.throwIfAborted();last=await original(id);if(predicate(last))return last;await new Promise(resolve=>setTimeout(resolve,150));}while(performance.now()-started<timeoutMs);
  run.artifact('stage-observation-timeout.json',{stageRequestId:id,description,timeoutMs,lastProgress:last?.progress??null,automaticRetry:false});throw Error('Original stage did not reach '+description+' within its bounded observation window');
 }
 async function interrupt(envelope,point){
  signal?.throwIfAborted();
  assert(['BEFORE_COMPLETE_REQUEST_BODY','AFTER_RESPONSE_HEADERS_BEFORE_BODY'].includes(point));
  exactKeys(envelope,['operation','projectId','input','requestId','expectedRevision']);assert.equal(envelope.operation,'lifecycle.stage.request');assert.equal(envelope.projectId,run.selection.projectId);exactKeys(envelope.input,['instanceId','stageId']);assert.equal(envelope.input.stageId,'implementation');
  const raw=Buffer.from(JSON.stringify(envelope));assert(raw.length>2&&raw.length<=262144);
  run.artifact('interrupted-request-intent.json',{envelope,rawBody:raw.toString(),rawBodySha256:sha(raw),faultPoint:point,path:'/api/v1/request',authentication:'SELECTED_PROTECTED_CONNECTION',automaticRetry:false});
  const started=performance.now(),metadata={faultPoint:point,requestId:envelope.requestId,bodyBytes:raw.length,bodyBytesSubmitted:0,responseBodyBytesConsumed:0,responseStatus:null,responseRequestId:null,faultApplied:false,transportCode:null};
  // Do not record Node/HTTP error messages: they can contain authenticated
  // request options. Only the fixed safe outcome and an errno-style code remain.
  await new Promise((resolve,reject)=>{
   let settled=false,timer;
   const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve();};
   const request=http.request(new URL('/api/v1/request',connection.origin),{method:'POST',headers:{...security.hostHeaders(connection),'content-type':'application/json','content-length':String(raw.length)},agent:false});
   const abort=()=>{metadata.transportCode='COLLECTOR_ABORTED';request.destroy();finish(Error('E13 transport observation was cancelled; inspect the original request'));};
   signal?.addEventListener('abort',abort,{once:true});
   timer=setTimeout(()=>{metadata.transportCode='OBSERVATION_TIMEOUT';request.destroy();finish(Error('E13 interrupted transport exceeded 30000 ms; inspect the original request'));},30000);
   request.on('error',error=>{metadata.transportCode=/^[A-Z0-9_]{1,48}$/.test(error.code??'')?error.code:'TRANSPORT_ERROR';if(!metadata.faultApplied)finish(Error('E13 transport failed before its selected fault point; inspect the original request'));});
   request.on('response',response=>{
    response.on('error',error=>{metadata.transportCode=/^[A-Z0-9_]{1,48}$/.test(error.code??'')?error.code:'RESPONSE_TRANSPORT_ERROR';});
    metadata.responseStatus=response.statusCode;const id=response.headers['x-request-id'];metadata.responseRequestId=typeof id==='string'&&/^[a-zA-Z0-9-]{1,100}$/.test(id)?id:null;
    if(point!=='AFTER_RESPONSE_HEADERS_BEFORE_BODY'){response.destroy();request.destroy();finish(Error('Incomplete request unexpectedly received a response before fault injection'));return;}
    // Never attach a data listener. The response is deliberately unavailable to
    // this client; only the native receipt can subsequently establish commit.
    metadata.faultApplied=true;response.destroy();request.destroy();
   });
   request.on('close',()=>{metadata.faultApplied?finish():finish(Error('E13 connection closed before the exact selected fault point'));});
   if(point==='BEFORE_COMPLETE_REQUEST_BODY'){
    const partial=raw.subarray(0,raw.length-1);request.flushHeaders();request.write(partial,error=>{if(error){request.destroy();finish(Error('E13 partial request could not reach its injection point'));return;}metadata.bodyBytesSubmitted=partial.length;metadata.faultApplied=true;request.destroy();});
   }else{metadata.bodyBytesSubmitted=raw.length;request.end(raw);}
  }).finally(()=>run.artifact('interrupted-transport-observation.json',{...metadata,elapsedMs:performance.now()-started,responseBodyKnown:false,transportCancellationImpliesRollback:false,automaticRetry:false}));
  assert.equal(metadata.faultApplied,true);assert.equal(metadata.responseBodyBytesConsumed,0);
  if(point==='AFTER_RESPONSE_HEADERS_BEFORE_BODY')assert.equal(metadata.responseStatus,200,'Only the subsequent original native receipt can establish successful admission');
  return metadata;
 }
 async function restart(){
  signal?.throwIfAborted();const selection=control.inspectInstalledServiceSelection(run.selection.installedRoot);
  assert.equal(selection.serviceId,run.candidate.serviceId);assert.equal(selection.distributionManifestDigest,run.selection.expectedManifestDigest);
  // The installed native operator already provides bounded launchd readiness,
  // exact process ownership and immutable operation receipts. Never replay an
  // old installation plan or fall back to an unscoped process kill.
  for(const operation of ['stop','start']){
   signal?.throwIfAborted();
   run.artifact('service-recovery-intent.json',{operation,selectionDigest:selection.selectionDigest,serviceId:selection.serviceId,originalRequestsOnly:true});
   let result;try{result=await control.operateInstalledService(selection,operation);}catch(error){run.artifact('service-recovery-failure.json',{operation,code:typeof error.code==='string'?error.code:'UNKNOWN',automaticRetry:false});throw Error('Native installed service '+operation+' failed; inspect its original operation receipt');}
   run.artifact('service-recovery-result.json',{operation,result});assert.equal(result.businessWorkDispatched,false);assert.equal(result.hostRegistered,false);assert.equal(result.service.running,operation==='start');
  }
  assert.equal((await run.read('runtime.status')).serviceId,selection.serviceId);
 }
 return{instance,original,events,until,interrupt,restart,intact};
}
