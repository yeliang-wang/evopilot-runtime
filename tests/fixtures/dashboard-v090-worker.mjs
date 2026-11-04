// Real HTTP service + browser development fixture. Asset bindings and stage
// observations are explicitly synthetic; no product acceptance or remote CI.
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {channel} from 'node:diagnostics_channel';
import {initializeCredentials,tokenDigest} from '../../dist/server/security.js';
import {startRuntimeServer} from '../../dist/server/http.js';
import {valueDigest} from '../../dist/lifecycle/base.js';
import {compileLifecycle} from '../../dist/lifecycle/compiler.js';
import {requiredChecksDigest} from '../../dist/lifecycle/instance.js';
import {lifecycle,yaml,syntheticBindings} from './lifecycle-v090.mjs';

export async function dashboardFixture({seed=true}={}){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'runtime-dashboard-browser-')),stateRoot=join(root,'state'),tokens={},authorities=new Map(),bindings=syntheticBindings();
 const principals=Object.entries({owner:['read','draft.write','definition.activate'],reader:['read'],executor:['read','execution.request']}).map(([id,permissions])=>{tokens[id]=randomBytes(32).toString('base64url');return{id,permissions,projects:['alpha','beta'],revision:1,expiresAt:'2030-01-01T00:00:00Z',tokenDigest:tokenDigest(tokens[id])};});
 initializeCredentials(stateRoot,'browser-fixture',principals);
 const data=lifecycle();for(const stage of ['plan','verification'])data.config[stage].budget={timeoutSeconds:600,maxAttempts:2,maxConcurrency:2,maxLoops:1};
 const initialSource='# Browser development fixture, not project acceptance\n'+yaml(data),controls={phase:'UNKNOWN',dispatches:0},adapterDigest=valueDigest('synthetic-browser-adapter');
 const observe=r=>({requestId:r.id,inputDigest:r.inputDigest,adapterDigest,phase:controls.phase,handle:{synthetic:r.id},outcome:{requestId:r.id,inputDigest:r.inputDigest,receiptRef:'synthetic:browser/'+r.id,status:controls.phase==='FAILED'?'FAILED':'UNKNOWN',expiresAt:new Date(Date.now()+60000).toISOString(),checks:[]}});
 const adapter={async prepare(_i,stageId){return{adapterId:'synthetic-browser',adapterDigest,action:'base.'+stageId,bindingDigest:valueDigest('synthetic-browser-binding'),parameters:{synthetic:true}};},async dispatch(r,_i,permit){await permit();controls.dispatches++;return observe(r);},async inspect(r){return observe(r);}};
 let server,afterCommitRequest=null;const postCommitFaults=[];
 const open=async port=>server=await startRuntimeServer({stateRoot,workspaceId:'browser-fixture',port},bindings.provider,async ref=>authorities.get(ref)??null,undefined,store=>{
  // Source-test-only scheduling fault: run the original synchronous transaction
  // completely, then rotate this fixture identity before HTTP's final auth check.
  // No fake response, receipt, database seed, or installed acceptance is involved.
  const mutate=store.mutate.bind(store);store.mutate=(actor,request,...rest)=>{
   const receipt=mutate(actor,request,...rest);
   if(request.requestId===afterCommitRequest){assert.equal(actor.id,'owner');assert(['lifecycle.draft.save','lifecycle.definition.save-and-activate'].includes(request.operation));afterCommitRequest=null;rotate();postCommitFaults.push({requestId:request.requestId,revision:receipt.revision,actualCommit:true});}
   return receipt;
  };return adapter;
 });
 function rotateAfterCommit(requestId){assert.equal(afterCommitRequest,null);assert(/^[a-f0-9-]{36}$/.test(requestId));afterCommitRequest=requestId;}
 await open();
 // Fault injection touches only this fixture's actual HTTP responses. Browser
 // offline emulation does not reliably close an already established SSE socket.
 const eventResponses=new Set(),requests=channel('http.server.request.start');
 const captureEvents=({request,response,socket})=>{if(socket.localPort===server.port&&request.url?.split('?')[0]==='/api/v1/dashboard/events'){eventResponses.add(response);response.once('close',()=>eventResponses.delete(response));}};
 requests.subscribe(captureEvents);
 function disconnectEvents(){const responses=[...eventResponses];for(const response of responses)response.destroy();return responses.length;}
 async function call(operation,input={},extra={},actor='owner',projectId='alpha'){
  const r=await fetch(server.url+'/api/v1/request',{method:'POST',headers:{authorization:'Bearer '+tokens[actor],'content-type':'application/json'},body:JSON.stringify({operation,projectId,input,...extra})}),body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body.result;
 }
 async function write(operation,input,actor='owner',projectId='alpha'){
  const view=await call('lifecycle.definition.inspect',{}, {},actor,projectId);return call(operation,input,{requestId:randomUUID(),expectedRevision:view.revision},actor,projectId);
 }
 async function source(revisionId,projectId='alpha'){
  let offset=0,result='';for(;;){const p=await call('lifecycle.definition.source.read',{revisionId,offset},{},'owner',projectId);result+=Buffer.from(p.data,'base64').toString();if(p.nextOffset===null)return result;offset=p.nextOffset;}
 }
 async function activate(text=initialSource){const preview=await call('lifecycle.definition.validate',{yaml:text});assert.equal(preview.ready,true);return write('lifecycle.definition.save-and-activate',{yaml:text,validationDigest:preview.validationDigest});}
 async function createInstance(id='browser-instance'){
  const view=await call('lifecycle.definition.inspect'),text=await source(view.active.id),definition=compileLifecycle(text,'alpha').effective;
  const authority={projectId:'alpha',instanceId:id,definitionRevisionId:view.active.id,semanticDigest:definition.semanticDigest,requirementsDigest:requiredChecksDigest(definition),goalRef:'synthetic:goal/browser',targetRef:'synthetic:target/browser',loopRef:'synthetic:loop/browser',budget:data.config.plan.budget,evidenceRef:'synthetic:authority/'+id,revision:'1',expiresAt:'2030-01-01T00:00:00Z'};
  authorities.set(authority.evidenceRef,authority);await write('lifecycle.instance.create',{instanceId:id,definitionRevisionId:view.active.id,authorityRef:authority.evidenceRef},'executor');return{id,revisionId:view.active.id};
 }
 async function code(actor='owner',projectId='alpha'){const r=await fetch(server.url+'/api/v1/dashboard-code',{method:'POST',headers:{authorization:'Bearer '+tokens[actor],'content-type':'application/json'},body:JSON.stringify({projectId})}),v=await r.json();assert.equal(r.status,200,JSON.stringify(v));return v.result.code;}
 function rotate(actor='owner'){const path=join(stateRoot,'auth.json'),auth=JSON.parse(readFileSync(path));auth.principals.find(p=>p.id===actor).revision++;writeFileSync(path,JSON.stringify(auth));}
 async function appendEvents(count){
  assert(Number.isSafeInteger(count)&&count>0&&count<=1100);let revision=(await call('runtime.status')).revision;
  // Actual service mutations, not table edits or fabricated stream frames.
  for(let n=0;n<count;n++){const result=await call('lifecycle.draft.save',{yaml:'# Synthetic browser replay exercise\nprojectId: alpha\n'},{requestId:randomUUID(),expectedRevision:revision});revision=result.revision;}
  return revision;
 }
 if(seed)await write('lifecycle.draft.save',{yaml:initialSource});
 return{root,bindings,controls,data,initialSource,call,write,source,activate,createInstance,code,rotate,rotateAfterCommit,postCommitFaults,appendEvents,disconnectEvents,get url(){return server.url;},async restart(){const port=server.port;await server.close();await open(port);},async close(){requests.unsubscribe(captureEvents);await server.close();rmSync(root,{recursive:true,force:true});}};
}
