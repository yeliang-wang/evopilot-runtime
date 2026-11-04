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

// First independent E01/E02 readback cases. This is not a journey shortcut:
// every case rereads the complete native original chain, original Host proof,
// five provider archives, both published owner inboxes and distribution bytes.
export const LIFECYCLE_READBACK_CASES=Object.freeze({'E01.variant.01':'non-rc','E01.variant.05':'feedback-publication','E02.variant.01':'non-rc','E02.variant.04':'feedback-publication'});
function readbackPrivate(pin,max=1048576){
 exactKeys(pin,['ref','sha256']);assert(/^[a-f0-9]{64}$/.test(pin.sha256));assert.equal(fs.realpathSync(pin.ref),pin.ref);const s=fs.lstatSync(pin.ref);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o077)===0&&s.size>0&&s.size<=max);
 const bytes=fs.readFileSync(pin.ref);assert.equal(sha(bytes),pin.sha256);return{bytes,value:JSON.parse(bytes)};
}
export function lifecycleReadbackPlan(run,c,provider){
 assert(['github','gitlab'].includes(provider));assert(c.caseInstanceId.startsWith(provider==='github'?'E01.':'E02.'));assert(Object.hasOwn(LIFECYCLE_READBACK_CASES,c.caseInstanceId));
 const pin=run.selection.lifecycleVariants;assert(pin,'Select exact original lifecycle records; a journey result label cannot supply this independent case');const {value:f}=readbackPrivate(pin);
 exactKeys(f,['schema','candidateDigest','workspaceId','projectId','provider','syntheticAssets','syntheticDecisions','casePlans']);assert.equal(f.schema,'runtime-v090-lifecycle-variants-fixture/v1');assert.equal(f.candidateDigest,run.candidateDigest);assert.equal(f.workspaceId,run.selection.workspaceId);assert.equal(f.projectId,run.selection.projectId);assert.equal(f.provider,provider);assert.equal(f.syntheticAssets,true);assert.equal(f.syntheticDecisions,true);
 assert(f.casePlans&&typeof f.casePlans==='object'&&!Array.isArray(f.casePlans));for(const id of Object.keys(f.casePlans))assert(run.all.some(row=>row.caseInstanceId===id)&&Object.hasOwn(LIFECYCLE_READBACK_CASES,id));const p=f.casePlans[c.caseInstanceId];assert(p);exactKeys(p,['instanceId','expectedVersion','preparation','ownerFixture','codingSourceSelection','exchangeRoot']);assert(/^[a-z0-9][a-z0-9._-]{0,127}$/.test(p.instanceId));assert(typeof p.expectedVersion==='string'&&p.expectedVersion.length>0&&p.expectedVersion.length<=128);assert.equal(fs.realpathSync(p.exchangeRoot),p.exchangeRoot);assert.equal(fs.lstatSync(p.exchangeRoot).mode&0o777,0o700);
 for(const key of ['preparation','ownerFixture'])readbackPrivate(p[key]);if(p.codingSourceSelection.kind==='CURRENT_JOURNEY')exactKeys(p.codingSourceSelection,['kind']);else{exactKeys(p.codingSourceSelection,['kind','ref','sha256']);assert.equal(p.codingSourceSelection.kind,'ORIGINAL_RECORD');readbackPrivate({ref:p.codingSourceSelection.ref,sha256:p.codingSourceSelection.sha256});}run.artifact('independent-lifecycle-case-plan.json',{caseInstanceId:c.caseInstanceId,reference:pin,plan:p,provider,source:'Original selected records, not another case status',syntheticAssets:true,syntheticDecisions:true});return p;
}
export function requireClosedLifecycle(instance,plan,caseId){
 const stages=['scope','plan','implementation','candidate','verification','release-decision','publication','closure'];assert.equal(instance.id,plan.instanceId);assert.deepEqual(Object.keys(instance.stages).sort(),[...stages].sort());
 for(const id of stages){const s=instance.stages[id];assert.equal(s.status,'PASSED','Incomplete original '+id+' cannot qualify an independent full-chain case');assert(Number.isSafeInteger(s.attempts)&&s.attempts>0);assert(typeof s.requestId==='string'&&s.requestId.length>0);assert(/^sha256:[a-f0-9]{64}$/.test(s.inputDigest));assert(/^sha256:[a-f0-9]{64}$/.test(s.outcomeDigest));}
 assert(instance.candidate);assert.equal(instance.candidate.version,plan.expectedVersion);assert(/^sha256:[a-f0-9]{64}$/.test(instance.candidateDigest));
 if(LIFECYCLE_READBACK_CASES[caseId]==='non-rc')assert(!/(?:^|[.+_-])rc(?:\d|[.+_-]|$)/i.test(plan.expectedVersion),'This case must select an actual non-RC development candidate');
 return stages;
}
export async function collectLifecycleReadback(run,c,provider,proveCodingHost,currentSource=null){
 assert.equal(typeof proveCodingHost,'function');const plan=lifecycleReadbackPlan(run,c,provider),deadline=Date.now()+600000,signal=AbortSignal.timeout(600000),boundedSignal=ms=>AbortSignal.any([signal,AbortSignal.timeout(ms)]),time=()=>{signal.throwIfAborted();assert(Date.now()<deadline,'Independent readback exceeded its fixed 600-second bound');};
 const load=relative=>import(pathToFileURL(path.join(run.selection.installedRoot,'package/dist',relative)).href);
 const base=await load('lifecycle/base.js'),instanceApi=await load('lifecycle/instance.js'),configApi=await load('adapters/config.js'),security=await load('server/security.js'),platformApi=await load('adapters/platforms.js'),artifactApi=await load('adapters/artifacts.js'),github=await load('adapters/github.js'),gitlab=await load('adapters/gitlab.js'),control=await load('installation/service-control.js'),feedbackApi=await load('adapters/feedback.js'),ownerApi=await load('adapters/published-owners.js');
 const spec=JSON.parse(fs.readFileSync(path.join(run.selection.installedRoot,'service-specification.json'))),selectedService=control.inspectInstalledServiceSelection(run.selection.installedRoot);assert.equal(selectedService.serviceId,run.candidate.serviceId);assert.equal(selectedService.distributionManifestDigest,run.candidate.manifestDigest);
 const initialRevision=(await run.read('runtime.status')).revision,{value:preparation}=readbackPrivate(plan.preparation),{value:fixture}=readbackPrivate(plan.ownerFixture);
 const selectedHost=plan.codingSourceSelection.kind==='CURRENT_JOURNEY'?currentSource:readbackPrivate({ref:plan.codingSourceSelection.ref,sha256:plan.codingSourceSelection.sha256}).value;assert(selectedHost,'CURRENT_JOURNEY requires the actual in-memory original source selection from this campaign');
 assert.equal(preparation.source.provider,provider);assert.equal(fixture.syntheticAssets,true);assert.equal(fixture.syntheticDecisions,true);assert.equal(fixture.workspaceId,run.selection.workspaceId);assert.equal(fixture.scope.projectId,run.selection.projectId);assert.equal(selectedHost.selection.preparationRoot,path.dirname(plan.exchangeRoot));assert.equal(selectedHost.selectionRef,path.join(plan.exchangeRoot,'CODING-HOST-SELECTION.json'));
 const actor=()=>{const value=security.currentPrincipal(path.join(run.selection.installedRoot,'data'),run.selection.workspaceId,spec.principalId);assert(value);return value;};
 const configuration=()=>{assert(spec.integrationsRef);return configApi.readIntegrationConfiguration(spec.integrationsRef,run.selection.workspaceId);};
 const checkBinding=binding=>{assert.equal(binding.provider,provider);assert.equal(binding.repositoryId,preparation.source.repositoryId);assert.equal(binding.projectId,run.selection.projectId);assert.deepEqual(configApi.configuredPlatform(configuration(),actor(),run.selection.projectId,binding.ref),binding);};
 const numeric=/^[1-9][0-9]{0,19}$/;
 const read=async(operation,input={})=>{time();const result=await run.read(operation,input);time();return result;};
 const initial=await read('lifecycle.instance.inspect',{instanceId:plan.instanceId}),instance=instanceApi.inspectInstance(initial.instance),stages=requireClosedLifecycle(instance,plan,c.caseInstanceId);assert.equal(instance.pins.projectId,run.selection.projectId);assert.equal(base.isCurrentBase(instance.pins.base),true);
 const originals={},snapshots={};
 for(const id of stages){
  const value=await read('lifecycle.stage.request.inspect',{stageRequestId:instance.stages[id].requestId}),r=value.request,{digest,...body}=r;assert.equal(base.valueDigest(body),digest);assert.equal(base.valueDigest(r.plan),r.planDigest);assert.equal(r.id,instance.stages[id].requestId);assert.equal(r.stageId,id);assert.equal(r.instanceId,instance.id);assert.equal(r.workspaceId,run.selection.workspaceId);assert.equal(r.projectId,run.selection.projectId);assert.equal(r.pinsDigest,instance.pinsDigest);assert.equal(r.inputDigest,instance.stages[id].inputDigest);assert.equal(value.automaticRedispatch,false);assert.equal(value.workerError,null);assert.equal(value.progress.phase,'COMPLETE');assert.equal(value.progress.terminal,true);
  const observation=await read('lifecycle.stage.observation.read',{stageRequestId:r.id,observationRef:value.progress.observationRef});assert.equal(base.valueDigest(observation.evidence),observation.observationRef);assert.equal(observation.evidence.requestId,r.id);assert.deepEqual(observation.evidence.observation,value.progress.observation);assert.equal(base.valueDigest(value.progress.observation.outcome),instance.stages[id].outcomeDigest);originals[id]=r;snapshots[id]=value;
 }
 const scope=await read('lifecycle.scope.evidence.read',{stageRequestId:originals.scope.id}),planning=await read('lifecycle.plan.evidence.read',{stageRequestId:originals.plan.id}),implementation=await read('lifecycle.implementation.evidence.read',{stageRequestId:originals.implementation.id}),handoff=await read('lifecycle.agent.handoff.read',{stageRequestId:originals.implementation.id}),reported=await read('lifecycle.agent.report.read',{stageRequestId:originals.implementation.id});
 assert(handoff.claim&&reported.report?.state==='SUBMITTED');assert.equal(handoff.latestReport.digest,reported.report.digest);assert.equal(reported.report.result.change.kind,provider==='github'?'pull-request':'merge-request');assert.equal(handoff.handoff.runtimeStartsAgent,false);assert.equal(handoff.handoff.stageRequestId,originals.implementation.id);
 const hostRun={...run,selection:{...run.selection,lifecycleExecution:{exchangeRoot:plan.exchangeRoot}}},hostProof=await proveCodingHost(hostRun,selectedHost,handoff.handoff,reported.report,handoff.claim,spec.nodeExecutable,base.valueDigest);time();
 const commit=reported.report.result.commit,feedback=await read('lifecycle.verification.feedback.read',{stageRequestId:originals.verification.id}),publication=await read('lifecycle.publication.evidence.read',{stageRequestId:originals.publication.id}),closure=await read('lifecycle.closure.evidence.read',{stageRequestId:originals.closure.id}),release=await read('lifecycle.release.evidence.read',{stageRequestId:originals['release-decision'].id});
 assert.equal(feedback.event.stage,'SUCCEEDED');assert.equal(feedback.event.projectCandidateDigest,instance.candidateDigest);assert.equal(feedback.event.runId,'verification:'+originals.verification.id);assert.equal(feedback.event.inputDigest,originals.verification.inputDigest);assert.equal(feedback.event.source.revision,commit);assert.equal(feedback.releaseAuthorized,false);assert.equal(closure.evidence.archive.status,'COMPLETE');assert.equal(publication.evidence.harness.status,'PASS');assert.equal(publication.evidence.distribution.candidateDigest,instance.candidateDigest);assert.equal(closure.evidence.smoke.status,'PASSED');assert.equal(closure.evidence.distribution.candidateDigest,instance.candidateDigest);
 for(const owner of ['ontology','harness']){assert.deepEqual(feedback.event.pins[owner],fixture.references[owner]);assert.equal(closure.evidence.feedback[owner].status,'REUSE_APPROVED');assert.equal(feedback.event.results[owner].result.context.projectCandidateDigest,instance.candidateDigest);assert.equal(feedback.event.results[owner].result.context.inputDigest,originals.verification.inputDigest);assert.equal(feedback.event.results[owner].result.context.requirementSetDigest,instance.pins.requirementsDigest);}
 run.artifact('independent-native-complete-chain.json',{caseInstanceId:c.caseInstanceId,instance,originals,scope,planning,implementation,feedback,publication,closure,release,originalCodingHost:hostProof.summary,historicalReadOnly:true,currentExecutionAuthorized:false,softwareReleaseAuthorized:false});
 function originalCi(r){
  const p=r.plan.parameters;assert.equal(r.workspaceId,run.selection.workspaceId);assert.equal(r.projectId,run.selection.projectId);assert.equal(p.commit,p.source.commit);assert.equal(p.stageId,r.stageId);assert.equal(r.plan.adapterId,'runtime-ci-owner-stage-v2');
  return platformApi.validateRunRequest({schema:'runtime-ci-request/v1',requestId:'stage-'+base.valueDigest({workspaceId:r.workspaceId,projectId:r.projectId,requestId:r.id}).slice(7,55),projectId:r.projectId,bindingDigest:base.valueDigest(p.binding),commit:p.commit,workflowDigest:p.workflowDigest,inputDigest:r.inputDigest,stageId:r.stageId,candidateDigest:p.candidateDigest,...(p.candidateInput?{candidateInput:p.candidateInput}:{}),requestedAt:r.requestedAt,deadlineAt:r.deadlineAt},p.binding);
 }
 async function githubEvidence(label,r,ci,expectedChecks,expectedArtifact=null){
  const p=r.plan.parameters;checkBinding(p.binding);assert.equal(r.planDigest,base.valueDigest(r.plan));assert.equal(ci.projectId,run.selection.projectId);assert.equal(ci.inputDigest,r.inputDigest);assert.equal(ci.commit,p.commit);assert.equal(ci.workflowDigest,p.workflowDigest);assert.equal(ci.stageId,r.stageId);
  platformApi.validateRunRequest(ci,p.binding);
  const credentials=async(binding,principal,signal)=>{signal.throwIfAborted();return configApi.readPlatformToken(spec.integrationsRef,binding,principal);};
  const client=github.githubClient(p.binding,credentials),transport=platformApi.platformReader(p.binding,credentials);
  const observed=await client.run(actor(),ci,expectedArtifact?.runId??null,boundedSignal(30000));
  run.artifact('github-original-run-observation.json',{stage:label,binding:p.binding,request:ci,observed});
  assert.equal(observed.status,'PASSED');assert.equal(observed.provider,'github');assert.equal(observed.repositoryId,preparation.source.repositoryId);assert.equal(observed.requestId,ci.requestId);assert.equal(observed.commit,ci.commit);assert.equal(observed.inputDigest,ci.inputDigest);assert.equal(observed.ref,platformApi.ciSourceRef(ci));assert(numeric.test(observed.runId));assert(observed.jobs.length>0);
  const rawRun=await transport.get(actor(),'/actions/runs/'+observed.runId,boundedSignal(15000));
  run.artifact('github-original-run.json',{stage:label,raw:rawRun});
  assert.equal(String(rawRun.id),observed.runId);assert.equal(String(rawRun.repository.id),preparation.source.repositoryId);assert.equal(rawRun.path,p.binding.workflowPath);assert.equal(rawRun.run_attempt,1);assert.equal(rawRun.event,'workflow_dispatch');assert.equal(rawRun.head_sha,ci.commit);assert.equal(rawRun.head_branch,platformApi.ciSourceRef(ci));assert.equal(rawRun.display_title,platformApi.ciRunTitle(ci));assert.equal(rawRun.conclusion,'success');
  for(const job of observed.jobs){
   assert.equal(job.status,'PASSED');assert.equal(job.runId,observed.runId);assert.equal(job.commit,ci.commit);assert(numeric.test(job.jobId)&&numeric.test(job.runnerId));
   const raw=await transport.get(actor(),'/actions/jobs/'+job.jobId,boundedSignal(15000));run.artifact('github-original-job.json',{stage:label,raw});
   assert.equal(String(raw.id),job.jobId);assert.equal(String(raw.run_id),observed.runId);assert.equal(raw.run_attempt,1);assert.equal(raw.head_sha,ci.commit);assert.equal(raw.status,'completed');assert.equal(raw.conclusion,'success');assert.equal(String(raw.runner_id),job.runnerId);assert(raw.labels.includes(p.binding.runner));
  }
  const archive=await client.artifact(actor(),ci,observed.runId,boundedSignal(60000));assert.equal(archive.provider,'github');assert.equal(archive.repositoryId,preparation.source.repositoryId);assert.equal(archive.jobId,null);assert(numeric.test(archive.artifactId));assert.equal(archive.name,'runtime-ci');assert.equal(archive.runId,observed.runId);assert.equal(archive.commit,ci.commit);assert.equal(archive.archiveBytes,archive.bytes.length);assert(archive.archiveBytes<=8388608,'The isolated fixture has an explicit 8 MiB archive bound');assert.equal(archive.archiveDigest,'sha256:'+sha(archive.bytes));
  const verified=await artifactApi.verifyCiArtifact(archive,ci,expectedChecks,boundedSignal(30000));assert.equal(verified.status,'PASSED');assert.equal(verified.artifactsVerified,true);assert.equal(verified.ownerEvaluationsVerified,false);assert.equal(verified.lifecycleAcceptance,false);if(expectedArtifact)assert.deepEqual(verified,expectedArtifact);
  const entries=await artifactApi.readArtifactArchive(archive.bytes,boundedSignal(30000)),result=JSON.parse(entries.get('runtime-result.json').toString());
  run.artifact('github-original-artifact.json',{stage:label,request:ci,verified,result,recording:'Exact installed adapter download and verification; not a source-test response'});
  for(let offset=0;offset<archive.bytes.length;offset+=262144){const bytes=archive.bytes.subarray(offset,offset+262144);run.artifact('github-original-archive-part.json',{stage:label,archiveDigest:archive.archiveDigest,archiveBytes:archive.archiveBytes,offset,bytes:bytes.length,sha256:sha(bytes),base64:bytes.toString('base64')});}
  return{request:ci,observation:observed,verified,client,transport};
 }
 async function gitlabEvidence(label,r,ci,expectedChecks,expectedArtifact=null){
  const p=r.plan.parameters;checkBinding(p.binding);assert.equal(r.planDigest,base.valueDigest(r.plan));assert.equal(ci.projectId,run.selection.projectId);assert.equal(ci.inputDigest,r.inputDigest);assert.equal(ci.commit,p.commit);assert.equal(ci.workflowDigest,p.workflowDigest);assert.equal(ci.stageId,r.stageId);
  platformApi.validateRunRequest(ci,p.binding);
  const credentials=async(binding,principal,signal)=>{signal.throwIfAborted();return configApi.readPlatformToken(spec.integrationsRef,binding,principal);};
  const client=gitlab.gitlabClient(p.binding,credentials),transport=platformApi.platformReader(p.binding,credentials);
  const observed=await client.run(actor(),ci,expectedArtifact?.runId??null,boundedSignal(30000));
  run.artifact('gitlab-original-run-observation.json',{stage:label,binding:p.binding,request:ci,observed});
  assert.equal(observed.status,'PASSED');assert.equal(observed.provider,'gitlab');assert.equal(observed.repositoryId,preparation.source.repositoryId);assert.equal(observed.requestId,ci.requestId);assert.equal(observed.commit,ci.commit);assert.equal(observed.inputDigest,ci.inputDigest);assert.equal(observed.ref,platformApi.ciSourceRef(ci));assert(numeric.test(observed.runId));assert(observed.jobs.length>0);
  const rawRun=await transport.get(actor(),'/pipelines/'+observed.runId,boundedSignal(15000));
  run.artifact('gitlab-original-pipeline.json',{stage:label,raw:rawRun});
  assert.equal(String(rawRun.id),observed.runId);assert.equal(String(rawRun.project_id),preparation.source.repositoryId);assert.equal(rawRun.source,'api');assert.equal(rawRun.sha,ci.commit);assert.equal(rawRun.ref,platformApi.ciSourceRef(ci));assert.equal(rawRun.status,'success');
  // GitLab has no GitHub-style run_attempt. Original attempts are identified
  // by complete include_retried job inventory; duplicate stage/name refuses.
  const rawJobs=[];let completeJobs=false;
  for(let page=1;page<=10;page++){
   const rows=await transport.get(actor(),'/pipelines/'+observed.runId+'/jobs?include_retried=true&per_page=100&page='+page,boundedSignal(15000));run.artifact('gitlab-original-attempt-inventory.json',{stage:label,page,raw:rows});assert(Array.isArray(rows)&&rows.length<=100);rawJobs.push(...rows);if(rows.length<100){completeJobs=true;break;}
  }
  assert.equal(completeJobs,true,'No truncated GitLab job-attempt inventory');assert.equal(new Set(rawJobs.map(j=>JSON.stringify([j.stage,j.name]))).size,rawJobs.length,'Retried jobs cannot represent the original attempt');assert.deepEqual(rawJobs.map(j=>String(j.id)).sort(),observed.jobs.map(j=>j.jobId).sort());
  for(const job of observed.jobs){
   assert.equal(job.status,'PASSED');assert.equal(job.runId,observed.runId);assert.equal(job.commit,ci.commit);assert(numeric.test(job.jobId)&&numeric.test(job.runnerId));
   const raw=await transport.get(actor(),'/jobs/'+job.jobId,boundedSignal(15000));run.artifact('gitlab-original-job.json',{stage:label,raw});
   assert.equal(String(raw.id),job.jobId);assert.equal(String(raw.pipeline.id),observed.runId);assert.equal(raw.commit.id,ci.commit);assert.equal(raw.status,'success');assert.equal(String(raw.runner.id),job.runnerId);assert.equal(job.runnerId,p.binding.runner);
  }
  const archive=await client.artifact(actor(),ci,observed.runId,boundedSignal(60000));assert.equal(archive.provider,'gitlab');assert.equal(archive.repositoryId,preparation.source.repositoryId);assert(numeric.test(archive.jobId));assert.equal(archive.artifactId,archive.jobId);assert(numeric.test(archive.artifactId));assert.equal(archive.name,'runtime-ci');assert.equal(archive.runId,observed.runId);assert.equal(archive.commit,ci.commit);assert.equal(archive.archiveBytes,archive.bytes.length);assert(archive.archiveBytes<=8388608,'The isolated fixture has an explicit 8 MiB archive bound');assert.equal(archive.archiveDigest,'sha256:'+sha(archive.bytes));
  const verified=await artifactApi.verifyCiArtifact(archive,ci,expectedChecks,boundedSignal(30000));assert.equal(verified.status,'PASSED');assert.equal(verified.artifactsVerified,true);assert.equal(verified.ownerEvaluationsVerified,false);assert.equal(verified.lifecycleAcceptance,false);if(expectedArtifact)assert.deepEqual(verified,expectedArtifact);
  const entries=await artifactApi.readArtifactArchive(archive.bytes,boundedSignal(30000)),result=JSON.parse(entries.get('runtime-result.json').toString());
  run.artifact('gitlab-original-artifact.json',{stage:label,request:ci,verified,result,recording:'Exact installed adapter download and verification; not a source-test response'});
  for(let offset=0;offset<archive.bytes.length;offset+=262144){const bytes=archive.bytes.subarray(offset,offset+262144);run.artifact('gitlab-original-archive-part.json',{stage:label,archiveDigest:archive.archiveDigest,archiveBytes:archive.archiveBytes,offset,bytes:bytes.length,sha256:sha(bytes),base64:bytes.toString('base64')});}
  return{request:ci,observation:observed,verified,client,transport};
 }
 const ciEvidence=provider==='github'?githubEvidence:gitlabEvidence;
 const ciProofs={};
 ciProofs.implementation=await ciEvidence('implementation',implementation.derivation.request,originalCi(implementation.derivation.request),implementation.derivation.request.plan.parameters.expectedChecks,implementation.ci.artifact);
 for(const id of ['candidate','verification'])ciProofs[id]=await ciEvidence(id,originals[id],originalCi(originals[id]),originals[id].plan.parameters.expectedChecks);
 ciProofs.publication=await ciEvidence('publication',originals.publication,publication.ciRequest,originals.publication.plan.parameters.expectedChecks,publication.evidence.artifact);
 ciProofs.closure=await ciEvidence('closure',originals.closure,closure.ciRequest.ci,['base.closure.delivery-acceptance'],closure.evidence.smoke.ci);
 assert.equal(new Set(Object.values(ciProofs).map(x=>x.observation.runId)).size,5);assert.equal(ciProofs.candidate.verified.candidateDigest,instance.candidateDigest);assert.deepEqual(ciProofs.candidate.verified.candidate,instance.candidate);assert.equal(ciProofs.verification.request.candidateDigest,instance.candidateDigest);assert.deepEqual(ciProofs.verification.request.candidateInput.manifest,instance.candidate);assert.deepEqual(ciProofs.verification.request.candidateInput.archive,ciProofs.candidate.verified.sourceArchive);
 for(const proof of Object.values(ciProofs)){assert.equal(proof.request.commit,commit);assert.equal(proof.observation.provider,provider);assert.equal(proof.observation.repositoryId,preparation.source.repositoryId);}
 const change=reported.report.result.change,source=await ciProofs.implementation.client.source(actor(),{baselineCommit:preparation.source.commit,commit,change,artifacts:reported.report.result.artifacts},boundedSignal(60000));run.artifact('independent-original-source-review.json',source);assert.equal(source.provider,provider);assert.equal(source.commit,commit);assert.equal(source.repositoryId,preparation.source.repositoryId);assert.deepEqual(source.change,change);assert.deepEqual(source.artifacts,reported.report.result.artifacts);assert.equal(source.sourceReviewApproved,false);assert.equal(source.releaseAuthorized,false);
 const distribution=publication.evidence.distribution,target=originals.publication.plan.parameters.publication.target;
 assert.equal(distribution.provider,provider);assert.equal(distribution.repositoryId,preparation.source.repositoryId);assert.equal(distribution.status,'PASSED');assert.equal(distribution.commit,commit);assert.equal(distribution.releaseAuthorized,false);assert.equal(distribution.candidateDigest,instance.candidateDigest);assert.equal(distribution.tag,originals.publication.plan.parameters.publication.tag);
 const downloaded=await ciProofs.publication.client.distribution(actor(),{commit,candidate:instance.candidate,tag:distribution.tag,prerelease:target.prerelease,packageName:target.packageName,descriptionDigest:distribution.release.descriptionDigest},boundedSignal(60000));run.artifact('independent-original-distribution-download.json',{caseInstanceId:c.caseInstanceId,provider,downloaded});assert.equal(downloaded.status,'PASSED');assert.equal(downloaded.factsDigest,distribution.factsDigest);assert.deepEqual(downloaded.artifacts.map(x=>({name:x.name,digest:x.digest,bytes:x.bytes})).sort((a,b)=>a.name.localeCompare(b.name)),instance.candidate.artifacts.map(x=>({name:x.name,digest:x.digest,bytes:x.bytes})).sort((a,b)=>a.name.localeCompare(b.name)));
 // Stop only this selected isolated service before opening the two official
 // owner services. No feedback propose/decide/publish or business write occurs.
 assert.equal(run.selection.browserConfiguration?.allowServiceRestart,true);assert.equal(JSON.parse(fs.readFileSync(path.join(run.selection.installedRoot,'installation-plan.json'))).codex,null);assert.equal(spec.projectId,run.selection.projectId);const config=configuration();for(const item of config.owners)assert(item.projects.every(id=>id===run.selection.projectId),'Owner readback requires the selected isolated single-project service');
 const execution=await openExecution(run,signal),beforeEvents=await execution.events();
 for(const id of new Set(beforeEvents.filter(x=>x.type==='lifecycle-instance-created').map(x=>x.data.instanceId))){const other=(await read('lifecycle.instance.inspect',{instanceId:id})).instance;assert(Object.values(other.stages).every(s=>!['RUNNING','UNKNOWN'].includes(s.status)),'Do not stop a service with another in-flight or unknown instance');}
 assert.equal((await read('runtime.status')).observationWorker.inFlight,0);
 const owners={},registrations={};
 for(const owner of ['ontology','harness']){const matches=config.owners.filter(o=>o.owner===owner&&o.workspaceRoot===fixture.workspaceRoot&&o.workspaceId===fixture.workspaceId&&o.projects.includes(run.selection.projectId));assert.equal(matches.length,1);assert.equal(matches[0].packageRoot,fixture.packageRoots[owner]);registrations[owner]=matches[0];}
 let stopped=false,readFailure;
 const service=async(operation,cleanup=false)=>{if(!cleanup)time();assert.deepEqual(control.inspectInstalledServiceSelection(run.selection.installedRoot),selectedService);const value=await control.operateInstalledService(selectedService,operation);run.artifact('independent-feedback-service-control.json',{operation,selection:selectedService,result:value});assert.equal(value.businessWorkDispatched,false);assert.equal(value.hostRegistered,false);assert.equal(value.service.running,operation==='start');if(operation==='stop')assert.equal(value.service.registered,false);return value;};
 try{
  await service('stop');stopped=true;
  for(const owner of ['ontology','harness']){
   time();const registration=registrations[owner],identity=ownerApi.verifyOwnerDistribution(owner,registration.packageRoot);assert.equal(identity.version,'0.8.3');const api=await import(pathToFileURL(path.join(registration.packageRoot,'dist/service.js')).href),native=api[owner==='ontology'?'createOntologyService':'createHarnessService']({workspaceRoot:registration.workspaceRoot,workspaceId:registration.workspaceId},{});
   try{native.initialize();const call=async operation=>{time();const request={operation,scope:feedback.event.scope,input:operation==='feedback.read'?{id:feedback.event.id}:{}};const response=await native.feedback(request);run.artifact('independent-owner-feedback-readback.json',{caseInstanceId:c.caseInstanceId,owner,identity,request,response});return response;};const before=await call('feedback.inspect'),inbox=await call('feedback.read'),after=await call('feedback.inspect');assert.deepEqual(after,before);assert.equal(before.workspaceId,run.selection.workspaceId);assert.equal(before.owner,owner);assert.deepEqual(before.scope,feedback.event.scope);const checked=feedbackApi.verifyOwnerFeedbackInbox(inbox,feedback.event,owner);assert.equal(checked.status,'REUSE_APPROVED');assert.deepEqual(checked,closure.evidence.feedback[owner]);assert.deepEqual(inbox.review.reference,fixture.references[owner]);owners[owner]={identity,checked,inboxDigest:base.valueDigest(inbox),revision:before.revision};}finally{native.close();}
  }
 }catch(error){readFailure=error;throw error;}finally{if(stopped){try{await service('start',true);}catch(error){throw new AggregateError([...(readFailure?[readFailure]:[]),error],'Independent owner readback cleanup incomplete');}}}
 time();assert.deepEqual((await read('lifecycle.instance.inspect',{instanceId:instance.id})).instance,instance);assert.deepEqual(await read('lifecycle.verification.feedback.read',{stageRequestId:originals.verification.id}),feedback);assert.deepEqual(await read('lifecycle.closure.evidence.read',{stageRequestId:originals.closure.id}),closure);assert.deepEqual(await execution.events(),beforeEvents);assert.equal((await read('runtime.status')).revision,initialRevision);
 for(const id of stages)assert.deepEqual(await read('lifecycle.stage.request.inspect',{stageRequestId:originals[id].id}),snapshots[id]);
 run.artifact('independent-coding-source-recheck.json',hostProof.revalidate());for(const key of ['preparation','ownerFixture'])readbackPrivate(plan[key]);if(plan.codingSourceSelection.kind==='ORIGINAL_RECORD')readbackPrivate({ref:plan.codingSourceSelection.ref,sha256:plan.codingSourceSelection.sha256});lifecycleReadbackPlan(run,c,provider);assert.equal((await read('runtime.status')).independentLlm,false);
 const identities=Object.fromEntries(Object.entries(ciProofs).map(([id,v])=>[id,{requestId:v.request.requestId,runId:v.observation.runId,jobs:v.observation.jobs.map(j=>({jobId:j.jobId,runnerId:j.runnerId})),archive:v.verified.sourceArchive,resultDigest:v.verified.resultDigest}]));
 return{caseInstanceId:c.caseInstanceId,purpose:LIFECYCLE_READBACK_CASES[c.caseInstanceId],provider,instanceId:instance.id,version:instance.candidate.version,candidateDigest:instance.candidateDigest,allEightOriginalStagesPassed:true,originalHostRecordsVerified:true,originalSourceChange:change,originalCi:identities,independentDistributionDownload:true,independentOwnerInboxes:owners,priorCasePassLabelConsumed:false,nativeMutations:0,providerWrites:0,authorityCreatedOrExtended:false,assetGradeMeaning:'CONTENT_ONLY_NOT_SOFTWARE_ACCEPTANCE_OR_AUTHORITY',currentSoftwareReleaseAuthorized:false,remainingCasesNotCredited:true};
}
