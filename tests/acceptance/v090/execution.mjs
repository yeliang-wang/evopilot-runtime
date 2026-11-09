// Native installed execution collectors retain original records and bounded
// lifecycle configuration probes. They never prepare owner assets or decisions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {sha,assertLiveChildReport,repository} from './support.mjs';
import {execFileSync} from 'node:child_process';
import {parse,stringify} from 'yaml';
import {openBrowser} from './browser.mjs';

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
// each case reads its own native records and original Host/provider evidence.
// Non-RC and feedback/publication cases retain the complete eight-stage chain;
// candidate drift needs the five stages through full verification, not release.
export const LIFECYCLE_READBACK_CASES=Object.freeze({'E01.variant.01':'non-rc','E01.variant.02':'candidate-drift','E01.variant.03':'candidate-drift','E01.variant.05':'feedback-publication','E02.variant.01':'non-rc','E02.variant.02':'candidate-drift','E02.variant.04':'feedback-publication','E05.journey':'candidate-drift','E05.variant.02':'missing-rc-candidate'});
function readbackPrivate(pin,max=1048576){
 exactKeys(pin,['ref','sha256']);assert(/^[a-f0-9]{64}$/.test(pin.sha256));assert.equal(fs.realpathSync(pin.ref),pin.ref);const s=fs.lstatSync(pin.ref);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o077)===0&&s.size>0&&s.size<=max);
 const bytes=fs.readFileSync(pin.ref);assert.equal(sha(bytes),pin.sha256);return{bytes,value:JSON.parse(bytes)};
}
function lifecycleRecordPlan(p){
 exactKeys(p,['instanceId','expectedVersion','preparation','ownerFixture','codingSourceSelection','exchangeRoot']);assert(/^[a-z0-9][a-z0-9._-]{0,127}$/.test(p.instanceId));assert(typeof p.expectedVersion==='string'&&p.expectedVersion.length>0&&p.expectedVersion.length<=128);assert.equal(fs.realpathSync(p.exchangeRoot),p.exchangeRoot);assert.equal(fs.lstatSync(p.exchangeRoot).mode&0o777,0o700);
 for(const key of ['preparation','ownerFixture'])readbackPrivate(p[key]);if(p.codingSourceSelection.kind==='CURRENT_JOURNEY')exactKeys(p.codingSourceSelection,['kind']);else{exactKeys(p.codingSourceSelection,['kind','ref','sha256']);assert.equal(p.codingSourceSelection.kind,'ORIGINAL_RECORD');readbackPrivate({ref:p.codingSourceSelection.ref,sha256:p.codingSourceSelection.sha256});}return p;
}
export function lifecycleReadbackPlan(run,c,provider){
 assert(['github','gitlab'].includes(provider));assert(['E05.journey','E05.variant.02'].includes(c.caseInstanceId)||c.caseInstanceId.startsWith(provider==='github'?'E01.':'E02.'));assert(Object.hasOwn(LIFECYCLE_READBACK_CASES,c.caseInstanceId));
 const pin=run.selection.lifecycleVariants;assert(pin,'Select exact original lifecycle records; a journey result label cannot supply this independent case');const {value:f}=readbackPrivate(pin);
 exactKeys(f,['schema','candidateDigest','workspaceId','projectId','provider','syntheticAssets','syntheticDecisions','casePlans']);assert.equal(f.schema,'runtime-v090-lifecycle-variants-fixture/v1');assert.equal(f.candidateDigest,run.candidateDigest);assert.equal(f.workspaceId,run.selection.workspaceId);assert.equal(f.projectId,run.selection.projectId);assert.equal(f.provider,provider);assert.equal(f.syntheticAssets,true);assert.equal(f.syntheticDecisions,true);
 assert(f.casePlans&&typeof f.casePlans==='object'&&!Array.isArray(f.casePlans));for(const id of Object.keys(f.casePlans))assert(run.all.some(row=>row.caseInstanceId===id)&&Object.hasOwn(LIFECYCLE_READBACK_CASES,id));const p=f.casePlans[c.caseInstanceId];assert(p);
 if(LIFECYCLE_READBACK_CASES[c.caseInstanceId]==='candidate-drift'){exactKeys(p,['before','after']);lifecycleRecordPlan(p.before);lifecycleRecordPlan(p.after);assert.notEqual(p.before.instanceId,p.after.instanceId,'Candidate evolution cannot reset one immutable instance');assert.notEqual(p.before.exchangeRoot,p.after.exchangeRoot,'Both actual Host exchanges need their own original records');}else lifecycleRecordPlan(p);
 run.artifact('independent-lifecycle-case-plan.json',{caseInstanceId:c.caseInstanceId,reference:pin,plan:p,provider,source:'Original selected records, not another case status',syntheticAssets:true,syntheticDecisions:true});return p;
}
export function requireClosedLifecycle(instance,plan,caseId){
 const stages=['scope','plan','implementation','candidate','verification','release-decision','publication','closure'];assert.equal(instance.id,plan.instanceId);assert.deepEqual(Object.keys(instance.stages).sort(),[...stages].sort());
 for(const id of stages){const s=instance.stages[id];assert.equal(s.status,'PASSED','Incomplete original '+id+' cannot qualify an independent full-chain case');assert(Number.isSafeInteger(s.attempts)&&s.attempts>0);assert(typeof s.requestId==='string'&&s.requestId.length>0);assert(/^sha256:[a-f0-9]{64}$/.test(s.inputDigest));assert(/^sha256:[a-f0-9]{64}$/.test(s.outcomeDigest));}
 assert(instance.candidate);assert.equal(instance.candidate.version,plan.expectedVersion);assert(/^sha256:[a-f0-9]{64}$/.test(instance.candidateDigest));
 if(LIFECYCLE_READBACK_CASES[caseId]==='non-rc')assert(!/(?:^|[.+_-])rc(?:\d|[.+_-]|$)/i.test(plan.expectedVersion),'This case must select an actual non-RC development candidate');
 return stages;
}
function requireVerifiedLifecycle(instance,plan){
 const selected=['scope','plan','implementation','candidate','verification'];assert.equal(instance.id,plan.instanceId);
 assert.deepEqual(Object.keys(instance.stages).sort(),[...selected,'release-decision','publication','closure'].sort());
 for(const id of selected){const s=instance.stages[id];assert.equal(s.status,'PASSED','Changed-candidate evidence requires original '+id+' to have passed');assert(Number.isSafeInteger(s.attempts)&&s.attempts>0);assert(typeof s.requestId==='string'&&s.requestId);assert(/^sha256:[a-f0-9]{64}$/.test(s.inputDigest));assert(/^sha256:[a-f0-9]{64}$/.test(s.outcomeDigest));}
 assert(instance.candidate);assert.equal(instance.candidate.version,plan.expectedVersion);assert(/^sha256:[a-f0-9]{64}$/.test(instance.candidateDigest));return selected;
}
export async function collectLifecycleReadback(run,c,provider,proveCodingHost,currentSource=null){
 assert.equal(typeof proveCodingHost,'function');const plan=lifecycleReadbackPlan(run,c,provider),deadline=Date.now()+600000;
 if(LIFECYCLE_READBACK_CASES[c.caseInstanceId]==='missing-rc-candidate')return(await lifecycleRecordEvidence(run,c,provider,proveCodingHost,plan,currentSource,deadline,false,true)).summary;
 if(LIFECYCLE_READBACK_CASES[c.caseInstanceId]==='candidate-drift')return collectCandidateDrift(run,c,provider,proveCodingHost,plan,currentSource,deadline);
 return(await lifecycleRecordEvidence(run,c,provider,proveCodingHost,plan,currentSource,deadline)).summary;
}
async function lifecycleRecordEvidence(run,c,provider,proveCodingHost,plan,currentSource,deadline,throughVerification=false,missingCandidate=false,recheckPlan=()=>lifecycleReadbackPlan(run,c,provider)){
 assert(Date.now()<deadline);const signal=AbortSignal.timeout(deadline-Date.now()),boundedSignal=ms=>AbortSignal.any([signal,AbortSignal.timeout(ms)]),time=()=>{signal.throwIfAborted();assert(Date.now()<deadline,'Independent readback exceeded its fixed 600-second bound');};
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
 const initial=await read('lifecycle.instance.inspect',{instanceId:plan.instanceId}),instance=instanceApi.inspectInstance(initial.instance),stages=missingCandidate?requireMissingRcLifecycle(instance,plan):throughVerification?requireVerifiedLifecycle(instance,plan):requireClosedLifecycle(instance,plan,c.caseInstanceId);assert.equal(instance.pins.projectId,run.selection.projectId);assert.equal(base.isCurrentBase(instance.pins.base),true);
 const originals={},snapshots={};
 for(const id of stages){
  const value=await read('lifecycle.stage.request.inspect',{stageRequestId:instance.stages[id].requestId}),r=value.request,{digest,...body}=r;assert.equal(base.valueDigest(body),digest);assert.equal(base.valueDigest(r.plan),r.planDigest);assert.equal(r.id,instance.stages[id].requestId);assert.equal(r.stageId,id);assert.equal(r.instanceId,instance.id);assert.equal(r.workspaceId,run.selection.workspaceId);assert.equal(r.projectId,run.selection.projectId);assert.equal(r.pinsDigest,instance.pinsDigest);assert.equal(r.inputDigest,instance.stages[id].inputDigest);assert.equal(value.automaticRedispatch,false);assert.equal(value.workerError,null);if(missingCandidate&&id==='candidate'){assert.equal(value.progress.phase,'UNKNOWN');assert.equal(value.progress.terminal,false);assert.equal(value.progress.reason,'CI_ARTIFACT_INTEGRITY');}else{assert.equal(value.progress.phase,'COMPLETE');assert.equal(value.progress.terminal,true);}
  const observation=await read('lifecycle.stage.observation.read',{stageRequestId:r.id,observationRef:value.progress.observationRef});assert.equal(base.valueDigest(observation.evidence),observation.observationRef);assert.equal(observation.evidence.requestId,r.id);assert.deepEqual(observation.evidence.observation,value.progress.observation);assert.equal(base.valueDigest(value.progress.observation.outcome),instance.stages[id].outcomeDigest);originals[id]=r;snapshots[id]=value;
 }
 const scope=await read('lifecycle.scope.evidence.read',{stageRequestId:originals.scope.id}),planning=await read('lifecycle.plan.evidence.read',{stageRequestId:originals.plan.id}),implementation=await read('lifecycle.implementation.evidence.read',{stageRequestId:originals.implementation.id}),handoff=await read('lifecycle.agent.handoff.read',{stageRequestId:originals.implementation.id}),reported=await read('lifecycle.agent.report.read',{stageRequestId:originals.implementation.id});
 assert(handoff.claim&&reported.report?.state==='SUBMITTED');assert.equal(handoff.latestReport.digest,reported.report.digest);assert.equal(reported.report.result.change.kind,provider==='github'?'pull-request':'merge-request');assert.equal(handoff.handoff.runtimeStartsAgent,false);assert.equal(handoff.handoff.stageRequestId,originals.implementation.id);
 const hostRun={...run,selection:{...run.selection,lifecycleExecution:{exchangeRoot:plan.exchangeRoot}}},hostProof=await proveCodingHost(hostRun,selectedHost,handoff.handoff,reported.report,handoff.claim,spec.nodeExecutable,base.valueDigest);time();
 const commit=reported.report.result.commit,feedback=missingCandidate?null:await read('lifecycle.verification.feedback.read',{stageRequestId:originals.verification.id}),publication=throughVerification||missingCandidate?null:await read('lifecycle.publication.evidence.read',{stageRequestId:originals.publication.id}),closure=throughVerification||missingCandidate?null:await read('lifecycle.closure.evidence.read',{stageRequestId:originals.closure.id}),release=throughVerification||missingCandidate?null:await read('lifecycle.release.evidence.read',{stageRequestId:originals['release-decision'].id});
 if(!missingCandidate){
 assert.equal(feedback.event.stage,'SUCCEEDED');assert.equal(feedback.event.projectCandidateDigest,instance.candidateDigest);assert.equal(feedback.event.runId,'verification:'+originals.verification.id);assert.equal(feedback.event.inputDigest,originals.verification.inputDigest);assert.equal(feedback.event.source.revision,commit);assert.equal(feedback.releaseAuthorized,false);if(!throughVerification){assert.equal(closure.evidence.archive.status,'COMPLETE');assert.equal(publication.evidence.harness.status,'PASS');assert.equal(publication.evidence.distribution.candidateDigest,instance.candidateDigest);assert.equal(closure.evidence.smoke.status,'PASSED');assert.equal(closure.evidence.distribution.candidateDigest,instance.candidateDigest);}
 for(const owner of ['ontology','harness']){assert.deepEqual(feedback.event.pins[owner],fixture.references[owner]);if(!throughVerification)assert.equal(closure.evidence.feedback[owner].status,'REUSE_APPROVED');assert.equal(feedback.event.results[owner].result.context.projectCandidateDigest,instance.candidateDigest);assert.equal(feedback.event.results[owner].result.context.inputDigest,originals.verification.inputDigest);assert.equal(feedback.event.results[owner].result.context.requirementSetDigest,instance.pins.requirementsDigest);}
 run.artifact(throughVerification?'independent-native-verification-chain.json':'independent-native-complete-chain.json',{caseInstanceId:c.caseInstanceId,verifiedStages:stages,instance,originals,scope,planning,implementation,feedback,publication,closure,release,originalCodingHost:hostProof.summary,historicalReadOnly:true,currentExecutionAuthorized:false,softwareReleaseAuthorized:false});
 }
 function originalCi(r){
  const p=r.plan.parameters;assert.equal(r.workspaceId,run.selection.workspaceId);assert.equal(r.projectId,run.selection.projectId);assert.equal(p.commit,p.source.commit);assert.equal(p.stageId,r.stageId);assert.equal(r.plan.adapterId,'runtime-ci-owner-stage-v2');
  return platformApi.validateRunRequest({schema:'runtime-ci-request/v1',requestId:'stage-'+base.valueDigest({workspaceId:r.workspaceId,projectId:r.projectId,requestId:r.id}).slice(7,55),projectId:r.projectId,bindingDigest:base.valueDigest(p.binding),commit:p.commit,workflowDigest:p.workflowDigest,inputDigest:r.inputDigest,stageId:r.stageId,candidateDigest:p.candidateDigest,...(p.candidateInput?{candidateInput:p.candidateInput}:{}),requestedAt:r.requestedAt,deadlineAt:r.deadlineAt},p.binding);
 }
 async function githubEvidence(label,r,ci,expectedChecks,expectedArtifact=null,missingVersion=null){
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
  const inspected=await originalArchive(archive,ci,expectedChecks,expectedArtifact,missingVersion),{verified,result,rejection}=inspected;
  run.artifact('github-original-artifact.json',{stage:label,request:ci,verified,result,...(rejection?{rejection}:{}),recording:'Exact installed adapter download and verification; not a source-test response'});
  for(let offset=0;offset<archive.bytes.length;offset+=262144){const bytes=archive.bytes.subarray(offset,offset+262144);run.artifact('github-original-archive-part.json',{stage:label,archiveDigest:archive.archiveDigest,archiveBytes:archive.archiveBytes,offset,bytes:bytes.length,sha256:sha(bytes),base64:bytes.toString('base64')});}
  return{request:ci,observation:observed,verified,client,transport,archive,...(rejection?{rejection,declaredCandidate:result.candidate}:{})};
 }
 async function gitlabEvidence(label,r,ci,expectedChecks,expectedArtifact=null,missingVersion=null){
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
  const inspected=await originalArchive(archive,ci,expectedChecks,expectedArtifact,missingVersion),{verified,result,rejection}=inspected;
  run.artifact('gitlab-original-artifact.json',{stage:label,request:ci,verified,result,...(rejection?{rejection}:{}),recording:'Exact installed adapter download and verification; not a source-test response'});
  for(let offset=0;offset<archive.bytes.length;offset+=262144){const bytes=archive.bytes.subarray(offset,offset+262144);run.artifact('gitlab-original-archive-part.json',{stage:label,archiveDigest:archive.archiveDigest,archiveBytes:archive.archiveBytes,offset,bytes:bytes.length,sha256:sha(bytes),base64:bytes.toString('base64')});}
  return{request:ci,observation:observed,verified,client,transport,archive,...(rejection?{rejection,declaredCandidate:result.candidate}:{})};
 }
 async function originalArchive(archive,ci,expectedChecks,expectedArtifact,missingVersion){
  if(missingVersion){
   const entries=await artifactApi.readArtifactArchive(archive.bytes,boundedSignal(30000));assert(entries.has('runtime-result.json'));const result=JSON.parse(entries.get('runtime-result.json').toString());
   const missingPaths=assertMissingRcPayload(result,entries,missingVersion,ci,archive,expectedChecks,instanceApi.candidateDigest,artifactApi);
   let error;try{await artifactApi.verifyCiArtifact(archive,ci,expectedChecks,boundedSignal(30000));}catch(e){error={code:e.code,status:e.status};}assert.equal(error?.code,'CI_ARTIFACT_INTEGRITY');assert.equal(error.status,409);
   return{verified:null,result,rejection:{status:'REJECTED_MISSING_CANDIDATE_PAYLOAD',missingPaths,error,declaredVersion:result.candidate.version,expectedFailureOnly:true}};
  }
  const verified=await artifactApi.verifyCiArtifact(archive,ci,expectedChecks,boundedSignal(30000));assert.equal(verified.status,'PASSED');assert.equal(verified.artifactsVerified,true);assert.equal(verified.ownerEvaluationsVerified,false);assert.equal(verified.lifecycleAcceptance,false);if(expectedArtifact)assert.deepEqual(verified,expectedArtifact);
  const entries=await artifactApi.readArtifactArchive(archive.bytes,boundedSignal(30000)),result=JSON.parse(entries.get('runtime-result.json').toString());return{verified,result,rejection:null};
 }
 const ciEvidence=provider==='github'?githubEvidence:gitlabEvidence;
 const ciProofs={};
 ciProofs.implementation=await ciEvidence('implementation',implementation.derivation.request,originalCi(implementation.derivation.request),implementation.derivation.request.plan.parameters.expectedChecks,implementation.ci.artifact);
 if(missingCandidate){
  const candidate=await ciEvidence('candidate-missing-rc-payload',originals.candidate,originalCi(originals.candidate),originals.candidate.plan.parameters.expectedChecks,null,plan.expectedVersion);time();
  assert.notEqual(candidate.observation.runId,ciProofs.implementation.observation.runId);assert.equal(candidate.request.commit,commit);assert.equal(candidate.request.candidateDigest,null);
  const prepared=await read('lifecycle.preparation.read',{preparationRef:instance.pins.targetRef});assert.equal(prepared.packet.input.target.version,plan.expectedVersion);assert.equal(prepared.packet.input.definitionRevisionId,instance.pins.definitionRevisionId);assert.equal(prepared.packet.digest,base.valueDigest((({digest,...body})=>body)(prepared.packet)));
  const change=reported.report.result.change,source=await ciProofs.implementation.client.source(actor(),{baselineCommit:preparation.source.commit,commit,change,artifacts:reported.report.result.artifacts},boundedSignal(60000));assert.equal(source.provider,provider);assert.equal(source.repositoryId,preparation.source.repositoryId);assert.equal(source.commit,commit);assert.deepEqual(source.change,change);assert.deepEqual(source.artifacts,reported.report.result.artifacts);assert.equal(source.releaseAuthorized,false);
  const driver=await openExecution(run,signal),events=await driver.events(),authority=await read('lifecycle.authority.inspect',{authorityRef:originals.candidate.authorityRef}),input={kind:'release',subject:{instanceId:instance.id,candidateDigest:instanceApi.candidateDigest(candidate.declaredCandidate),expiresAt:instance.pins.authorityExpiresAt}};
  // A syntactically RC manifest is observed, never installed as a candidate.
  // Release refusal supplements the original candidate action and real archive.
  const refused=await run.request('lifecycle.authority.preview',input);assert.equal(refused.status,409);assert.equal(refused.body.error?.code,'CANDIDATE_REQUIRED');
  assert.deepEqual((await read('lifecycle.instance.inspect',{instanceId:instance.id})).instance,instance);for(const id of stages)assert.deepEqual(await read('lifecycle.stage.request.inspect',{stageRequestId:originals[id].id}),snapshots[id]);
  const finalAuthority=await read('lifecycle.authority.inspect',{authorityRef:originals.candidate.authorityRef});assert.deepEqual(finalAuthority.decision,authority.decision);assert.deepEqual(finalAuthority.revocation,authority.revocation);assert.deepEqual(await driver.events(),events);assert.equal((await read('runtime.status')).revision,initialRevision);run.artifact('missing-rc-candidate-host-recheck.json',hostProof.revalidate());recheckPlan();for(const key of ['preparation','ownerFixture'])readbackPrivate(plan[key]);if(plan.codingSourceSelection.kind==='ORIGINAL_RECORD')readbackPrivate({ref:plan.codingSourceSelection.ref,sha256:plan.codingSourceSelection.sha256});
  const summary={caseInstanceId:c.caseInstanceId,provider,instanceId:instance.id,declaredRcVersion:plan.expectedVersion,originalCandidateRequestId:originals.candidate.id,originalProviderRunId:candidate.observation.runId,archiveDigest:candidate.archive.archiveDigest,missingPaths:candidate.rejection.missingPaths,nativeCandidatePhase:'UNKNOWN',nativeCandidateReason:'CI_ARTIFACT_INTEGRITY',productCandidatePassed:false,candidateRemainsNull:true,expectedRefusalProved:true,originalHostAndImplementationVerified:true,priorCasePassLabelConsumed:false,nativeRedispatches:0,newGrants:0,newProviderWrites:0,remainingCasesNotCredited:true};
  run.artifact('missing-rc-candidate-native-refusal.json',{summary,instance,originals,snapshots,scope,planning,implementation,originalCodingHost:hostProof.summary,prepared,source,candidateRequest:candidate.request,candidateRun:candidate.observation,rejection:candidate.rejection,releasePreviewInput:input,releasePreviewResponse:refused,authority,originalHistoryUnchanged:true});return{summary};
 }

 for(const id of ['candidate','verification'])ciProofs[id]=await ciEvidence(id,originals[id],originalCi(originals[id]),originals[id].plan.parameters.expectedChecks);
 if(!throughVerification){ciProofs.publication=await ciEvidence('publication',originals.publication,publication.ciRequest,originals.publication.plan.parameters.expectedChecks,publication.evidence.artifact);
 ciProofs.closure=await ciEvidence('closure',originals.closure,closure.ciRequest.ci,['base.closure.delivery-acceptance'],closure.evidence.smoke.ci);}
 assert.equal(new Set(Object.values(ciProofs).map(x=>x.observation.runId)).size,throughVerification?3:5);assert.equal(ciProofs.candidate.verified.candidateDigest,instance.candidateDigest);assert.deepEqual(ciProofs.candidate.verified.candidate,instance.candidate);assert.equal(ciProofs.verification.request.candidateDigest,instance.candidateDigest);assert.deepEqual(ciProofs.verification.request.candidateInput.manifest,instance.candidate);assert.deepEqual(ciProofs.verification.request.candidateInput.archive,ciProofs.candidate.verified.sourceArchive);
 for(const proof of Object.values(ciProofs)){assert.equal(proof.request.commit,commit);assert.equal(proof.observation.provider,provider);assert.equal(proof.observation.repositoryId,preparation.source.repositoryId);}
 const change=reported.report.result.change,source=await ciProofs.implementation.client.source(actor(),{baselineCommit:preparation.source.commit,commit,change,artifacts:reported.report.result.artifacts},boundedSignal(60000));run.artifact('independent-original-source-review.json',source);assert.equal(source.provider,provider);assert.equal(source.commit,commit);assert.equal(source.repositoryId,preparation.source.repositoryId);assert.deepEqual(source.change,change);assert.deepEqual(source.artifacts,reported.report.result.artifacts);assert.equal(source.sourceReviewApproved,false);assert.equal(source.releaseAuthorized,false);
 if(throughVerification){
  time();assert.deepEqual((await read('lifecycle.instance.inspect',{instanceId:instance.id})).instance,instance);assert.deepEqual(await read('lifecycle.verification.feedback.read',{stageRequestId:originals.verification.id}),feedback);
  for(const id of stages)assert.deepEqual(await read('lifecycle.stage.request.inspect',{stageRequestId:originals[id].id}),snapshots[id]);assert.equal((await read('runtime.status')).revision,initialRevision);run.artifact('independent-candidate-host-source-recheck.json',hostProof.revalidate());
  for(const key of ['preparation','ownerFixture'])readbackPrivate(plan[key]);if(plan.codingSourceSelection.kind==='ORIGINAL_RECORD')readbackPrivate({ref:plan.codingSourceSelection.ref,sha256:plan.codingSourceSelection.sha256});recheckPlan();
  const summary={caseInstanceId:c.caseInstanceId,purpose:'candidate-drift',provider,instanceId:instance.id,version:instance.candidate.version,candidateDigest:instance.candidateDigest,verifiedOriginalStages:stages,originalHostRecordsVerified:true,originalSourceChange:change,originalCi:Object.fromEntries(Object.entries(ciProofs).map(([id,v])=>[id,{requestId:v.request.requestId,runId:v.observation.runId,archive:v.verified.sourceArchive,resultDigest:v.verified.resultDigest}])),nativeMutations:0,providerWrites:0,authorityCreatedOrExtended:false,releaseOrClosureRequiredForThisCase:false,priorCasePassLabelConsumed:false};
  return{summary,instance,originals,snapshots,ciProofs,handoff,reported,feedback,hostProof};
 }
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
 run.artifact('independent-coding-source-recheck.json',hostProof.revalidate());for(const key of ['preparation','ownerFixture'])readbackPrivate(plan[key]);if(plan.codingSourceSelection.kind==='ORIGINAL_RECORD')readbackPrivate({ref:plan.codingSourceSelection.ref,sha256:plan.codingSourceSelection.sha256});recheckPlan();assert.equal((await read('runtime.status')).independentLlm,false);
 const identities=Object.fromEntries(Object.entries(ciProofs).map(([id,v])=>[id,{requestId:v.request.requestId,runId:v.observation.runId,jobs:v.observation.jobs.map(j=>({jobId:j.jobId,runnerId:j.runnerId})),archive:v.verified.sourceArchive,resultDigest:v.verified.resultDigest}]));
 const summary={caseInstanceId:c.caseInstanceId,purpose:LIFECYCLE_READBACK_CASES[c.caseInstanceId]??'provider-inventory',provider,instanceId:instance.id,version:instance.candidate.version,candidateDigest:instance.candidateDigest,allEightOriginalStagesPassed:true,originalHostRecordsVerified:true,originalSourceChange:change,originalCi:identities,independentDistributionDownload:true,independentOwnerInboxes:owners,priorCasePassLabelConsumed:false,nativeMutations:0,providerWrites:0,authorityCreatedOrExtended:false,assetGradeMeaning:'CONTENT_ONLY_NOT_SOFTWARE_ACCEPTANCE_OR_AUTHORITY',currentSoftwareReleaseAuthorized:false,remainingCasesNotCredited:true};
 return{summary,instance,originals,snapshots,ciProofs,handoff,reported,feedback,closure,hostProof,events:beforeEvents};
}

// Each fixed candidate-change case independently re-reads both real original
// chains and makes its own native refusal. A shared A/B pair is permitted;
// another case's status is never an input and no stage/decision is rewritten.
export function candidateEvolution(before,after){
 assert.notEqual(before.id,after.id);assert.notEqual(before.candidateDigest,after.candidateDigest,'A renamed test label is not a changed candidate');
 const changed={source:before.candidate.sourceDigest!==after.candidate.sourceDigest,build:before.candidate.buildDigest!==after.candidate.buildDigest,artifacts:JSON.stringify(before.candidate.artifacts)!==JSON.stringify(after.candidate.artifacts)};
 assert(Object.values(changed).some(Boolean),'Require changed source/build/artifact identity, not only a version string');
 const earlier=before.definition.nodes.find(n=>n.id==='verification').checks,later=after.definition.nodes.find(n=>n.id==='verification').checks;
 assert(earlier.every(id=>later.includes(id)),'Required verification checks cannot be removed to pass the changed candidate');
 assert.notEqual(before.stages.candidate.requestId,after.stages.candidate.requestId);assert.notEqual(before.stages.verification.requestId,after.stages.verification.requestId);assert.notEqual(before.stages.verification.inputDigest,after.stages.verification.inputDigest);
 return{changed,requiredChecks:[...later]};
}
async function collectCandidateDrift(run,c,provider,proveCodingHost,plan,currentSource,deadline){
 const time=()=>assert(Date.now()<deadline,'Candidate comparison shares one fixed 600-second readback bound'),signal=AbortSignal.timeout(Math.max(1,deadline-Date.now()));time();
 const before=await lifecycleRecordEvidence(run,c,provider,proveCodingHost,plan.before,currentSource,deadline,true);time();
 const after=await lifecycleRecordEvidence(run,c,provider,proveCodingHost,plan.after,currentSource,deadline,true);time();
 const evolution=candidateEvolution(before.instance,after.instance),a=before.ciProofs.verification,b=after.ciProofs.verification;
 assert.equal(a.request.candidateDigest,before.instance.candidateDigest);assert.equal(b.request.candidateDigest,after.instance.candidateDigest);
 assert.notEqual(a.request.requestId,b.request.requestId);assert.notEqual(a.observation.runId,b.observation.runId);assert.notEqual(a.archive.artifactId,b.archive.artifactId);
 assert.notEqual(before.handoff.handoff.digest,after.handoff.handoff.digest);assert.notEqual(before.handoff.claim.digest,after.handoff.claim.digest);assert.notEqual(before.reported.report.digest,after.reported.report.digest);
 assert.deepEqual([...after.originals.verification.plan.parameters.expectedChecks].sort(),[...evolution.requiredChecks].sort());
 for(const checks of [b.verified.checks,after.snapshots.verification.progress.observation.outcome.checks]){assert.deepEqual(checks.map(x=>x.id).sort(),[...evolution.requiredChecks].sort());assert(checks.every(x=>x.status==='PASS'));}
 assert.deepEqual(b.request.candidateInput.archive,after.ciProofs.candidate.verified.sourceArchive);assert.deepEqual(b.request.candidateInput.manifest,after.instance.candidate);
 for(const owner of ['ontology','harness']){const result=after.feedback.event.results[owner].result;assert.equal(result.context.projectCandidateDigest,after.instance.candidateDigest);assert.equal(result.context.inputDigest,after.originals.verification.inputDigest);assert.equal(result.context.requirementSetDigest,after.instance.pins.requirementsDigest);}
 const driver=await openExecution(run,signal),revision=(await run.read('runtime.status')).revision,events=await driver.events();time();
 const originalAuthorities=[];
 for(const record of [before,after])for(const ref of new Set([record.originals.scope.authorityRef])){assert(typeof ref==='string'&&ref.length>0);originalAuthorities.push({ref,value:await run.read('lifecycle.authority.inspect',{authorityRef:ref})});time();}
 const revisionIsolation=c.caseInstanceId==='E05.journey'?await collectRevisionIsolation(run,c,before,after,driver,events,revision,deadline):null;time();
 // This is an actual native HTTP refusal. Its candidate comparison precedes
 // expiry/material checks; no old expired grant is presented as usable.
 const input={kind:'release',subject:{instanceId:after.instance.id,candidateDigest:before.instance.candidateDigest,expiresAt:after.instance.pins.authorityExpiresAt}};
 time();const refusal=await run.request('lifecycle.authority.preview',input);time();run.artifact('candidate-drift-native-refusal.json',{caseInstanceId:c.caseInstanceId,operation:'lifecycle.authority.preview',projectId:run.selection.projectId,input,response:refusal,oldCandidate:before.instance.candidateDigest,newCandidate:after.instance.candidateDigest,readOnly:true,newDecisionRequested:false});
 assert.equal(refusal.status,409);assert.equal(refusal.body.error?.code,'CANDIDATE_REQUIRED');assert.equal(typeof refusal.body.requestId,'string');assert(!Object.hasOwn(refusal.body,'result'));
 const artifactApi=await import(pathToFileURL(path.join(run.selection.installedRoot,'package/dist/adapters/artifacts.js')).href);
 const bounded=()=>AbortSignal.any([signal,AbortSignal.timeout(30000)]),archiveBefore=sha(a.archive.bytes);assert.equal(a.archive.archiveDigest,'sha256:'+archiveBefore);
 let archiveError;try{await artifactApi.verifyCiArtifact(a.archive,b.request,evolution.requiredChecks,bounded());}catch(error){archiveError={code:error.code,status:error.status};}time();
 assert.equal(archiveError?.code,'CI_ARTIFACT_MISMATCH','Unmodified old original archive must not satisfy the new request');assert.equal(archiveError.status,409);assert.equal(sha(a.archive.bytes),archiveBefore);
 let inputError;try{artifactApi.validateCandidateInput(a.request.candidateInput,b.request,provider,a.archive.repositoryId);}catch(error){inputError={code:error.code,status:error.status};}
 assert.equal(inputError?.code,'CI_CANDIDATE_INPUT_INVALID');assert.equal(inputError.status,409);time();
 run.artifact('candidate-drift-original-artifact-refusal.json',{caseInstanceId:c.caseInstanceId,provenance:'EXACT_INSTALLED_ADAPTER_CALL_NOT_NATIVE_STAGE_INGESTION',oldRequest:a.request,newRequest:b.request,oldArchive:{...a.archive,bytes:undefined},archiveBytesUnchanged:true,archiveError,inputError,nativeRefusalRequestId:refusal.body.requestId,adapterRefusalDoesNotReplaceNativeRefusal:true});
 for(const record of [before,after]){
  assert.deepEqual((await run.read('lifecycle.instance.inspect',{instanceId:record.instance.id})).instance,record.instance);time();
  assert.deepEqual(await run.read('lifecycle.verification.feedback.read',{stageRequestId:record.originals.verification.id}),record.feedback);time();
  for(const id of Object.keys(record.originals)){const current=await run.read('lifecycle.stage.request.inspect',{stageRequestId:record.originals[id].id});if(c.caseInstanceId==='E05.journey')assertHistoricalInspection(record.snapshots[id],current);else assert.deepEqual(current,record.snapshots[id]);time();}
  run.artifact('candidate-drift-host-source-recheck.json',record.hostProof.revalidate());
 }
 for(const item of originalAuthorities){const current=await run.read('lifecycle.authority.inspect',{authorityRef:item.ref});assert.deepEqual(current.decision,item.value.decision);assert.deepEqual(current.revocation,item.value.revocation);time();}
 assert.deepEqual(await driver.events(),revisionIsolation?.events??events);assert.equal((await run.read('runtime.status')).revision,revisionIsolation?.revision??revision);assert.deepEqual(lifecycleReadbackPlan(run,c,provider),plan);time();
 run.artifact('candidate-drift-full-revalidation.json',{caseInstanceId:c.caseInstanceId,provider,before:before.summary,after:after.summary,...evolution,verificationPolicy:'ALL_NEW_CANDIDATE_REQUIRED_CHECKS_REEXECUTED',newOriginalVerificationRequest:b.request,newOriginalVerificationRun:b.observation,newOriginalVerificationArtifact:b.verified,nativeRefusalRequestId:refusal.body.requestId,adapterErrors:{archive:archiveError,input:inputError},oldHistoryUnchanged:true,originalAuthorityUnchanged:true,priorCasePassLabelConsumed:false,newNativeBusinessWrites:revisionIsolation?1:0,newProviderWrites:0,...(revisionIsolation?{revisionIsolation:revisionIsolation.summary}:{})});
 return{caseInstanceId:c.caseInstanceId,provider,beforeInstance:before.instance.id,afterInstance:after.instance.id,beforeCandidate:before.instance.candidateDigest,afterCandidate:after.instance.candidateDigest,...evolution,bothOriginalFiveStageVerificationChainsVerified:true,bothOriginalHostRecordsVerified:true,newVerificationRequestId:b.request.requestId,newVerificationRunId:b.observation.runId,oldCandidateNativeRefused:true,unmodifiedOldArchiveRefusedByInstalledAdapter:true,newRequiredChecksAllPassed:true,oldHistoryUnchanged:true,newNativeBusinessWrites:revisionIsolation?1:0,newProviderWrites:0,priorCasePassLabelConsumed:false,remainingCasesNotCredited:true,...(revisionIsolation?{revisionIsolation:revisionIsolation.summary}:{})};
}

const ownerObject=x=>x&&typeof x==='object'&&!Array.isArray(x);
function ownerExact(value,fields){assert(ownerObject(value));assert.deepEqual(Object.keys(value).sort(),[...fields].sort());}
function ownerPinned(pin){
 ownerExact(pin,['ref','sha256']);assert.equal(path.resolve(pin.ref),pin.ref);assert.equal(fs.realpathSync(pin.ref),pin.ref);const s=fs.lstatSync(pin.ref);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o077)===0&&s.size<=1048576);
 const bytes=fs.readFileSync(pin.ref);assert.equal(sha(bytes),pin.sha256);return JSON.parse(bytes);
}
export function assertExtensionDenialReasons(reasons,required,{caseInstanceId,stageId}){
 assert(Array.isArray(reasons)&&reasons.length>0&&new Set(reasons).size===reasons.length);
 assert(Array.isArray(required)&&required.length>0);for(const reason of required)assert(reasons.includes(reason));
 const releaseOnly=caseInstanceId==='E04.EX07'&&stageId==='publication'&&required.length===1&&required[0]==='EXACT_RELEASE_AUTHORITY_REQUIRED';
 for(const reason of reasons){
  assert(typeof reason==='string');
  assert(!['AUTHORITY_REQUIRED','AUTHORITY_STALE','BINDINGS_NOT_CURRENT','HISTORICAL_BASE_READ_ONLY'].includes(reason),'Execution authority/currentness cannot replace graph evidence');
  assert(!reason.includes('EXHAUSTED')&&!reason.startsWith('PREDECESSOR_EVIDENCE_STALE:'),'Original execution budget and predecessor evidence must remain current');
  if(reason==='EXACT_RELEASE_AUTHORITY_REQUIRED')assert(releaseOnly,'Only the fixed EX07 publication probe expects absent release authority');
  else assert(reason.startsWith('PREDECESSOR_NOT_PASSED:'),'Unexpected native refusal cannot satisfy this exact graph probe');
 }
 return reasons;
}

const yaml=value=>stringify(value,{lineWidth:0});
// EX11 consumes already executed owner checks; it never prepares owner assets,
// starts a new Target, or substitutes source tests for native report evidence.
export async function ownerObligations(run,c,browser){
 const fixture=ownerPinned(run.selection.extensionExecution),plan=fixture.casePlans[c.caseInstanceId];assert.equal(fixture.syntheticAssets,true);assert.equal(fixture.syntheticDecisions,true);
 ownerExact(plan,['baseline','extended','ownerConnection','passed','failed','stageId','successorId']);
 assert.equal(fixture.candidateDigest,run.candidateDigest);assert.equal(fixture.workspaceId,run.selection.workspaceId);assert.equal(fixture.projectId,run.selection.projectId);
 const pinnedText=pin=>{ownerExact(pin,['ref','sha256']);assert.equal(path.resolve(pin.ref),pin.ref);assert.equal(fs.realpathSync(pin.ref),pin.ref);const s=fs.lstatSync(pin.ref);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o077)===0&&s.size<=1048576);const b=fs.readFileSync(pin.ref);assert.equal(sha(b),pin.sha256);return b.toString('utf8');};
 const baseline=pinnedText(plan.baseline),extended=pinnedText(plan.extended),beforeData=parse(baseline),data=parse(extended),added=data.extensions.filter(e=>e.id===plan.stageId);
 assert.equal(added.length,1);assert.equal(added[0].type,'check');assert.equal(added[0].actionRef,'runtime.check.harness');assert(!beforeData.extensions?.some(e=>e.id===plan.stageId));
 const removed=structuredClone(data);removed.extensions=removed.extensions.filter(e=>e.id!==plan.stageId);if(!removed.extensions.length&&!Object.hasOwn(beforeData,'extensions'))delete removed.extensions;assert.deepEqual(removed,beforeData,'The selected append may only add its fixed Harness requirement/mapping extension');
 const load=p=>import(pathToFileURL(path.join(run.selection.installedRoot,'package',p)).href),{evidenceValueDigest:vd}=await load('dist/server/errors.js'),{nativeSha256}=await load('vendor/compatibility/v1/native.mjs'),{openPublishedOwner,ownerRequestDigest}=await load('dist/adapters/published-owners.js'),{inspectInstance}=await load('dist/lifecycle/instance.js');
 const {verifyNativeStageResult}=await load('dist/adapters/stages.js');
 const {compileLifecycle}=await load('dist/lifecycle/compiler.js'),compiled=compileLifecycle(extended,run.selection.projectId);assert.equal(compiled.valid,true);assert(compiled.effective);
 const connection=ownerPinned(plan.ownerConnection);ownerExact(connection,['owner','packageRoot','workspaceRoot','workspaceId','projects']);assert.equal(connection.owner,'harness');assert.equal(connection.workspaceId,run.selection.workspaceId);assert(connection.projects.includes(run.selection.projectId));
 // Use the installed service's actual read principal, not a fabricated permit.
 const {currentPrincipal,authorize}=await load('dist/server/security.js');
 const actor=()=>{const principal=currentPrincipal(path.join(run.selection.installedRoot,'data'),run.selection.workspaceId,run.principal().principalId);assert(principal,'The selected native reader must still exist');authorize(principal,run.selection.projectId,'read');return principal;};
 const owner=await openPublishedOwner(connection);assert.equal(owner.capabilities().authoring,false);assert.equal(owner.capabilities().assetPublication,false);let ui;
 const inspect=async id=>{const value=await run.read('lifecycle.instance.inspect',{instanceId:id});inspectInstance(value.instance);return value.instance;};
 const evidence=async(selected,wanted)=>{
  ownerExact(selected,['instanceId','targetRef','definitionRevisionId']);const i=await inspect(selected.instanceId);assert.equal(i.pins.targetRef,selected.targetRef);assert.equal(i.pins.definitionRevisionId,selected.definitionRevisionId);assert.equal(await run.source(selected.definitionRevisionId),extended);assert.equal(i.pins.projectId,run.selection.projectId);assert.deepEqual(i.definition,compiled.effective);
  const node=i.definition.nodes.find(n=>n.id===plan.stageId),successor=i.definition.nodes.find(n=>n.id===plan.successorId);assert(node&&successor?.dependsOn.includes(node.id));assert.deepEqual(node.action,added[0]);assert.equal(i.stages[node.id].status,wanted==='PASS'?'PASSED':'FAILED');
  const r=await run.read('lifecycle.stage.request.inspect',{stageRequestId:i.stages[node.id].requestId}),view=await run.read('lifecycle.extension.evidence.read',{stageRequestId:r.request.id}),p=r.request.plan.parameters;
  assert.deepEqual(view.request,r.request);const {digest:requestDigest,...requestBody}=r.request;assert.equal(requestDigest,vd(requestBody));assert.equal(r.request.instanceId,i.id);assert.equal(r.request.pinsDigest,i.pinsDigest);assert.equal(r.request.stageId,node.id);assert.equal(r.request.plan.adapterId,'runtime-native-extension-stage-v1');assert.equal(r.progress.phase,wanted==='PASS'?'COMPLETE':'FAILED');assert.equal(r.progress.terminal,true);assert.equal(p.kind,'harness');assert.equal(p.preparationRef,i.pins.targetRef);assert.deepEqual(p.node,node);assert.equal(p.owner.registrationDigest,vd(connection));assert.equal(p.resourceDigest,vd(p.resources));assert.equal(r.request.planDigest,vd(r.request.plan));
  const mapping=p.resources.find(x=>x.ref===node.action.evidenceMappingRef);assert(mapping&&mapping.role==='extension.mapping');assert.deepEqual(mapping.definition.harness,p.owner.reference);for(const ref of node.action.requirementRefs){const requirement=p.resources.find(x=>x.ref===ref);assert(requirement&&requirement.role==='extension.requirement');const d=requirement.definition;assert.equal(d.owner,'harness');assert(mapping.definition.rows.some(row=>row.stage===node.id&&row.checkId===ref&&row.owner==='harness'&&row.criterionId===d.criterionId&&JSON.stringify(row.variantIds)===JSON.stringify(d.variantIds)));}
  const receipt=view.receipt,report=receipt.result,{reportDigest,...reportBody}=report,{digest,...actionBody}=view.action;assert.equal(digest,vd(actionBody));assert.equal(view.action.requestDigest,ownerRequestDigest('harness',view.action.request));assert.equal(view.action.request.operation,'native.package.validate');assert.equal(receipt.status,'SUCCEEDED');assert.equal(receipt.requestId,view.action.request.requestId);assert.equal(receipt.requestDigest,nativeSha256({operation:view.action.request.operation,scope:view.action.request.scope,input:view.action.request.input}));assert.deepEqual(report.context,view.action.context);assert.deepEqual(report.context,view.action.request.input.context);assert.equal(report.observationDigest,nativeSha256(view.action.request.input.observation));assert.deepEqual(report.reference,p.owner.reference);assert.equal(reportDigest,nativeSha256(reportBody));assert.equal(report.executionStatus,'SUCCEEDED');assert.equal(report.qualityStatus,wanted);assert(report.commands.length>0&&report.commands.every(command=>command.exitCode!==null&&!command.timedOut&&!command.outputLimit&&!command.signal));assert(report.criteria.length>0);if(wanted==='FAIL')assert(report.criteria.some(row=>row.status==='FAIL'&&row.variantId==='actual-observation'));
  assert.equal(view.evidenceRef,vd(view.evidence));assert.equal(view.evidence.receiptRef,vd(receipt));assert.equal(view.evidence.actionDigest,view.action.digest);assert.equal(view.evidence.requestDigest,r.request.digest);assert.equal(view.evidence.planDigest,r.request.planDigest);assert.equal(view.evidence.result.status,wanted);assert.deepEqual(verifyNativeStageResult(receipt,'harness',p.owner,view.action,p.toolchainLockDigest,p.effectiveConfigDigest),view.evidence.result);assert.equal(view.evidence.receiptTerminal,true);assert.equal(view.executionAuthorized,false);assert.equal(view.releaseAuthorized,false);assert.equal(view.automaticRedispatch,false);
  const readback=await owner.readPackage(actor(),run.selection.projectId,view.action.request.scope,p.owner.reference),coverage=JSON.parse(readback.package.files[readback.package.manifest.entrypoints.coverage]),attributed=[];
  // Native reports use coverage requirement IDs, while extension mappings use
  // rule IDs. Resolve that published relation before crediting any verdict.
  for(const ref of node.action.requirementRefs){const d=p.resources.find(x=>x.ref===ref).definition;for(const variantId of d.variantIds){const requirements=coverage.requirements.filter(row=>row.ruleIds.includes(d.criterionId)&&row.caseIds.includes(variantId));assert(requirements.length>0,'Declared rule/variant must exist in the exact published coverage');for(const requirement of requirements){for(const variant of [variantId,'actual-observation']){const rows=report.criteria.filter(row=>row.criterionId===requirement.id&&row.variantId===variant);assert.equal(rows.length,1,'Every declared criterion/variant needs one real result');assert(['PASS','FAIL'].includes(rows[0].status));if(wanted==='PASS')assert.equal(rows[0].status,'PASS');attributed.push({ruleId:d.criterionId,criterionId:requirement.id,variantId:variant,status:rows[0].status});}}}}
  if(wanted==='FAIL')assert(attributed.some(row=>row.variantId==='actual-observation'&&row.status==='FAIL'),'An unrelated owner failure cannot satisfy the added obligation');
  run.artifact('ex11-prepared-original-native-evidence.json',{origin:'PREPARED_ACTUAL_NATIVE_EXECUTION',instance:i,request:r,view,readback,declaredCriterionResults:attributed});return{i,r,view,readback};
 };
 try{
  const ownerBefore=await owner.read(actor(),run.selection.projectId,{operation:'workspace.inspect',scope:{visibility:'private',projectId:run.selection.projectId},input:{}}),passed=await evidence(plan.passed,'PASS'),failed=await evidence(plan.failed,'FAIL');assert.deepEqual(passed.view.request.plan.parameters.resources,failed.view.request.plan.parameters.resources);assert.deepEqual(passed.readback,failed.readback);
  ui=await openBrowser(run,browser);await ui.source.fill(baseline);const append=await ui.validateEdit('yaml',extended,()=>ui.source.fill(extended));assert.equal(append.result.ready,true);await ui.activate();await ui.screenshot();const activated=await run.read('lifecycle.definition.inspect');assert.equal(await run.source(activated.active.id),extended);
  const attacks=[['latest',d=>{d.assets.harness.version='latest';}],['forged-pass-reference',d=>{d.extensions.find(e=>e.id===plan.stageId).requirementRefs=['PASS'];}]];
  for(const [name,change]of attacks){const value=structuredClone(data);change(value);const source=yaml(value),v=await run.read('lifecycle.definition.validate',{yaml:source});assert.equal(v.ready,false);assert.equal(v.validationDigest,null);assert(v.issues.length>0&&v.issues.every(i=>i.path&&i.rule&&i.remedy));const state=await run.read('runtime.status'),response=await run.request('lifecycle.definition.save-and-activate',{yaml:source,validationDigest:null},{requestId:run.requestId(c.caseInstanceId,name),expectedRevision:state.revision});assert.equal(response.status,200);assert.equal(response.body.result.result.status,'BLOCKED');const current=await run.read('lifecycle.definition.inspect');assert.equal(current.active.id,activated.active.id);run.artifact('ex11-rejected-owner-attack.json',{name,validation:v,response});}
  const status=await run.read('runtime.status'),forged=await run.request('lifecycle.stage.request',{instanceId:failed.i.id,stageId:plan.successorId,outcome:{status:'PASS',checks:[]}},{requestId:run.requestId(c.caseInstanceId,'forged-result'),expectedRevision:status.revision});assert.equal(forged.status,400);assert.equal(forged.body.error.code,'INVALID_FIELDS');
  // Delete only the draft obligation. The current Target's frozen graph and
  // original native failure must continue to govern its successor admission.
  await ui.flush();await ui.login();const deletion=await ui.validateEdit('yaml',baseline,()=>ui.source.fill(baseline));await ui.save();await ui.screenshot();const draft=await run.read('lifecycle.definition.inspect');assert.equal(await run.source(draft.draft.id),baseline);assert.equal(draft.active.id,activated.active.id);
  const retained=await inspect(failed.i.id);assert.deepEqual(retained,failed.i);const admission=await run.read('lifecycle.stage.admission',{instanceId:failed.i.id,stageId:plan.successorId});assert.equal(admission.allowed,false);assertExtensionDenialReasons(admission.reasons,['PREDECESSOR_NOT_PASSED:'+plan.stageId],{caseInstanceId:c.caseInstanceId,stageId:plan.successorId});assert(Date.now()<Math.min(Date.parse(failed.i.createdAt)+failed.i.pins.budget.timeoutSeconds*1000,Date.parse(failed.i.pins.authorityExpiresAt)));const s=await run.read('runtime.status'),denied=await run.request('lifecycle.stage.request',{instanceId:failed.i.id,stageId:plan.successorId},{requestId:run.requestId(c.caseInstanceId,'same-target-continuation'),expectedRevision:s.revision});assert.equal(denied.status,409);assert.equal(denied.body.error.code,'STAGE_BLOCKED');assert.deepEqual(denied.body.error.message.split('; ').sort(),[...admission.reasons].sort());assert.deepEqual(await inspect(failed.i.id),failed.i);const {projectRevision:previousProjectRevision,...originalInspection}=failed.r,{projectRevision:currentProjectRevision,...currentInspection}=await run.read('lifecycle.stage.request.inspect',{stageRequestId:failed.r.request.id});assert(currentProjectRevision>=previousProjectRevision);assert.deepEqual(currentInspection,originalInspection);
  assert.deepEqual(await owner.readPackage(actor(),run.selection.projectId,failed.view.action.request.scope,failed.view.request.plan.parameters.owner.reference),failed.readback);assert.deepEqual(await owner.read(actor(),run.selection.projectId,{operation:'workspace.inspect',scope:{visibility:'private',projectId:run.selection.projectId},input:{}}),ownerBefore);assert.deepEqual(ownerPinned(run.selection.extensionExecution),fixture);assert.equal(pinnedText(plan.extended),extended);assert.equal(pinnedText(plan.baseline),baseline);assert.deepEqual(ownerPinned(plan.ownerConnection),connection);
  const trace=await ui.close();run.artifact('ex11-current-target-obligation.json',{append,deletedDraft:{source:baseline,validation:deletion.result},forgedResultResponse:forged,admission,denied,originalTargetRef:failed.i.pins.targetRef,originalInstanceId:failed.i.id,ownerAssetAndRevisionUnchanged:true,trace});return{preparedNativeInstances:[passed.i.id,failed.i.id],actualActions:['append-fixed-extension','reject-latest','reject-forged-PASS','delete-draft-check','deny-original-target-continuation'],originalFailurePreserved:true,ownerAssetUnchanged:true,trace};
 }finally{await ui?.close();owner.close();}
}

// Original Host evidence verifier copied from E01 at 2fc17ad; preserve its full
// call/output, stdout, edit, validation, ordering and immutable-record checks.
const hostPause=ms=>new Promise(r=>setTimeout(r,ms));
function hostPinned(ref,digest,max=262144){
 assert.equal(fs.realpathSync(ref),ref);const st=fs.lstatSync(ref);
 assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.uid===process.getuid()&&(st.mode&0o077)===0&&st.size<=max);
 const bytes=fs.readFileSync(ref);assert.equal(sha(bytes),digest);return bytes;
}
function hostExact(value,keys){assert(value&&typeof value==='object'&&!Array.isArray(value));assert.deepEqual(Object.keys(value).sort(),[...keys].sort());}
function hostPrivateBytes(ref,max=1048576){assert.equal(fs.realpathSync(ref),ref);const s=fs.lstatSync(ref);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o077)===0&&s.size<=max);return fs.readFileSync(ref);}
export function parseOriginalCodingHostStdout(stdout,phase){
 assert.equal(typeof stdout,'string');assert(Buffer.byteLength(stdout)>0&&Buffer.byteLength(stdout)<=1048576);assert(['inspect','claim','propose','submit'].includes(phase));
 // Preserve stdout verbatim in the original Host evidence. This is a separate
 // interpretation of exactly one Node 24.14 SQLite notice, not a log filter.
 const pattern=/\(node:([1-9][0-9]{0,9})\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/g;
 const matches=[...stdout.matchAll(pattern)];assert(matches.length<=1,'Multiple notices are not the selected single-import output');let json=stdout,notice=null;
 if(matches.length){
  assert.equal(phase,'propose','Only the pinned propose phase imports the SQLite-backed configuration module');const m=matches[0],pid=Number(m[1]);assert(Number.isSafeInteger(pid)&&pid<=2147483647);
  const before=m.index===0,after=m.index+m[0].length===stdout.length;assert(before||after,'The notice must be a separate prefix or suffix, never inside the JSON value');if(after&&!before)assert.equal(stdout[m.index-1],'\n');json=stdout.slice(0,m.index)+stdout.slice(m.index+m[0].length);
  notice={kind:'NODE_SQLITE_EXPERIMENTAL_WARNING',nodeVersion:'v24.14.0',pid,position:before?'before-json':'after-json',bytes:Buffer.byteLength(m[0]),sha256:sha(m[0])};
 }
 assert(/^\{[^\r\n]*\}\n?$/.test(json),'Exactly one original JSON line and no other output is required');const value=JSON.parse(json);assert(value&&typeof value==='object'&&!Array.isArray(value));
 return{value,interpretation:{rawStdoutBytes:Buffer.byteLength(stdout),rawStdoutSha256:sha(stdout),jsonBytes:Buffer.byteLength(json),jsonSha256:sha(json),notice,originalToolOutputRetained:true,unknownOutputIgnored:false}};
}

const hostQuote=value=>"'"+value.replaceAll("'","'\\''")+"'";

export async function proveOriginalCodingHost(run,selected,handoff,reported,claim,nodeExecutable,valueDigest){
 const ref=path.join(run.selection.lifecycleExecution.exchangeRoot,'CODING-HOST-EVIDENCE.json');
 // The current Host writes this only after its SUBMITTED call has really
 // completed and both raw call/output records have reached the original log.
 const limit=Date.now()+60000;while(!fs.existsSync(ref)&&Date.now()<limit)await hostPause(250);
 assert(fs.existsSync(ref),'CODING_HOST_EVIDENCE_REQUIRED: original Host records must bind coding to this native request before the journey can pass');
 const proofBytes=hostPrivateBytes(ref),proof=JSON.parse(proofBytes);
 hostExact(proof,['schema','candidateDigest','stageRequestId','handoffDigest','claimDigest','reportDigest','turnContexts','inspect','claim','edits','validation','propose','submit']);assert.equal(proof.schema,'runtime-v090-coding-host-evidence/v1');assert.equal(proof.candidateDigest,run.candidateDigest);
 assert.equal(proof.stageRequestId,handoff.stageRequestId);assert.equal(proof.handoffDigest,handoff.digest);assert.equal(proof.claimDigest,claim.digest);assert.equal(proof.reportDigest,reported.digest);assert.equal(claim.host.sessionId,selected.metadata.sessionId);assert.equal(claim.host.version,selected.metadata.hostVersion);assert.equal(handoff.agent.version,selected.metadata.hostVersion);assert.equal(claim.handoffDigest,handoff.digest);assert.equal(reported.claimDigest,claim.digest);
 hostExact(selected.selection,['schema','rolloutRef','sessionId','preparationRoot','driverRef','driverSha256']);assert.equal(selected.selection.schema,'runtime-v090-coding-host-selection/v1');assert.equal(selected.selectionRef,path.join(run.selection.lifecycleExecution.exchangeRoot,'CODING-HOST-SELECTION.json'));assert.equal(selected.selection.preparationRoot,path.dirname(run.selection.lifecycleExecution.exchangeRoot));assert.equal(selected.selection.driverRef,path.join(selected.selection.preparationRoot,'current-codex.mjs'));
 const sessions=fs.realpathSync(path.join(process.env.HOME,'.codex/sessions'));assert.equal(fs.realpathSync(selected.selection.rolloutRef),selected.selection.rolloutRef);assert(selected.selection.rolloutRef.startsWith(sessions+path.sep)&&selected.selection.rolloutRef.endsWith('.jsonl'));
 const current=fs.lstatSync(selected.selection.rolloutRef);assert(current.isFile()&&!current.isSymbolicLink()&&current.nlink===1&&current.uid===process.getuid()&&(current.mode&0o022)===0);assert.equal(current.ino,selected.inode);assert.equal(current.dev,selected.device);assert(current.size>=selected.startOffset);assert.equal(sha(hostPrivateBytes(selected.selectionRef)),selected.selectionSha256);hostPinned(selected.selection.driverRef,selected.selection.driverSha256,1048576);
 const fd=fs.openSync(selected.selection.rolloutRef,'r'),records=[],used=new Set(),turns=new Map();let total=0;
 function record(pin,kind,history=false){
  hostExact(pin,['offset','bytes','sha256']);assert(Number.isSafeInteger(pin.offset)&&pin.offset>=0&&Number.isSafeInteger(pin.bytes)&&pin.bytes>0&&pin.bytes<=1048576&&/^[a-f0-9]{64}$/.test(pin.sha256));assert(history||pin.offset>=selected.startOffset,'Historical Host events cannot qualify a new coding run');assert(pin.offset+pin.bytes<=current.size);assert(!used.has(pin.offset),'A source record cannot be reused as another action');used.add(pin.offset);total+=pin.bytes;assert(total<=16777216);
  const raw=Buffer.alloc(pin.bytes);assert.equal(fs.readSync(fd,raw,0,raw.length,pin.offset),raw.length);assert.equal(sha(raw),pin.sha256);assert.equal(raw.at(-1),10);assert.equal(raw.subarray(0,-1).indexOf(10),-1);if(pin.offset){const prior=Buffer.alloc(1);assert.equal(fs.readSync(fd,prior,0,1,pin.offset-1),1);assert.equal(prior[0],10);}
  const row=JSON.parse(raw);assert(Number.isFinite(Date.parse(row.timestamp)));assert(Number.isSafeInteger(row.ordinal));assert.equal(row.type,kind);records.push({pin,raw,row});return row;
 }
 function turn(row){const id=row.payload.internal_chat_message_metadata_passthrough?.turn_id,context=turns.get(id);assert(context,'Original tool record needs its exact original turn context');assert(context.ordinal<row.ordinal&&Date.parse(context.timestamp)<=Date.parse(row.timestamp));return id;}
 function pair(value){
  hostExact(value,['call','output']);const call=record(value.call,'response_item'),output=record(value.output,'response_item');assert.equal(call.payload.type,'custom_tool_call');assert.equal(call.payload.name,'exec');assert.equal(call.payload.status,'completed');assert.equal(output.payload.type,'custom_tool_call_output');assert.equal(call.payload.call_id,output.payload.call_id);assert.equal(turn(call),turn(output));assert(call.ordinal<output.ordinal&&Date.parse(call.timestamp)<=Date.parse(output.timestamp));
  assert.equal(typeof call.payload.input,'string');assert(Array.isArray(output.payload.output));return{call,output};
 }
 function parsedOutput(row){const values=[];for(const block of row.payload.output){assert.equal(block.type,'input_text');assert.equal(typeof block.text,'string');if(block.text.startsWith('{'))values.push(JSON.parse(block.text));else assert(block.text.startsWith('Script completed\n'),'Failed or unresolved tool execution is not a completed Host action');}return values;}
 function argumentsFor(call,method){const text=call.payload.input.trim(),prefix='text(await tools.'+method+'(';assert(text.startsWith(prefix)&&text.endsWith('));'),'Use one original tool invocation per provenance record');const args=JSON.parse(text.slice(prefix.length,-3));return args;}
 function execution(value,command,cwd){
  hostExact(value,['call','output','polls']);assert(Array.isArray(value.polls)&&value.polls.length<=32);const first=pair({call:value.call,output:value.output}),args=argumentsFor(first.call,'exec_command');
  hostExact(args,['cmd','workdir','login','yield_time_ms','max_output_tokens']);assert.equal(args.cmd,command);assert.equal(args.workdir,cwd);assert.equal(args.login,false);assert(Number.isInteger(args.yield_time_ms)&&args.yield_time_ms>=250&&args.yield_time_ms<=30000);assert(Number.isInteger(args.max_output_tokens)&&args.max_output_tokens>=2000&&args.max_output_tokens<=16000);
  const chunks=[];let observed=parsedOutput(first.output);assert.equal(observed.length,1);let result=observed[0],last=first.output;assert.equal(typeof result.output,'string');chunks.push(result.output);const sessionId=result.session_id;
  if(sessionId!==undefined)assert(Number.isSafeInteger(sessionId));
  for(const pin of value.polls){assert(result.exit_code===undefined&&result.session_id===sessionId,'Do not replay or poll a completed Host command');const next=pair(pin),poll=argumentsFor(next.call,'write_stdin');hostExact(poll,['session_id','chars','yield_time_ms','max_output_tokens']);assert.equal(poll.session_id,sessionId);assert.equal(poll.chars,'');assert(Number.isInteger(poll.yield_time_ms)&&poll.yield_time_ms>=1&&poll.yield_time_ms<=60000);assert(Number.isInteger(poll.max_output_tokens)&&poll.max_output_tokens>=2000&&poll.max_output_tokens<=16000);assert(next.call.ordinal>last.ordinal);observed=parsedOutput(next.output);assert.equal(observed.length,1);result=observed[0];assert.equal(typeof result.output,'string');chunks.push(result.output);last=next.output;}
  assert.equal(result.exit_code,0,'Only the original completed command establishes successful execution');assert.equal(result.session_id,undefined);const stdout=chunks.join('');assert(Buffer.byteLength(stdout)<=1048576);return{start:first.call.ordinal,end:last.ordinal,startedAt:first.call.timestamp,completedAt:last.timestamp,stdout,turnId:turn(first.call),callId:first.call.payload.call_id};
 }
 function phase(name){const cmd=hostQuote(nodeExecutable)+' '+hostQuote(selected.selection.driverRef)+' '+name,r=execution(proof[name],cmd,selected.selection.preparationRoot),parsed=parseOriginalCodingHostStdout(r.stdout,name),output=parsed.value;hostExact(output,['phase','stageRequestId','handoffDigest',...(name==='inspect'?['taskDigest']:['claimDigest']),...(['propose','submit'].includes(name)?['commit','change']:[]),...(name==='propose'?['artifacts']:[]),...(name==='submit'?['reportDigest']:[])]);assert.equal(output.phase,name);assert.equal(output.stageRequestId,handoff.stageRequestId);assert.equal(output.handoffDigest,handoff.digest);run.artifact('coding-host-stdout-interpretation.json',{phase:name,callId:r.callId,...parsed.interpretation});return{...r,value:output};}
 try{
  const meta=Buffer.alloc(selected.metaBytes);assert.equal(fs.readSync(fd,meta,0,meta.length,0),meta.length);assert.equal(sha(meta),selected.metaSha256);assertOriginalCodingHostIdentity(selected,meta);
  assert(Array.isArray(proof.turnContexts)&&proof.turnContexts.length>0&&proof.turnContexts.length<=16);for(const pin of proof.turnContexts){const r=record(pin,'turn_context',true),p=r.payload;assert.equal(typeof p.turn_id,'string');assert.equal(typeof p.model,'string');assert(p.model.length>0);if(turns.has(p.turn_id))assert.equal(turns.get(p.turn_id).model,p.model);else turns.set(p.turn_id,{model:p.model,provider:selected.metadata.provider,timestamp:r.timestamp,ordinal:r.ordinal});}
  const inspected=phase('inspect'),claimed=phase('claim');assert(inspected.end<claimed.start);assert.equal(inspected.value.taskDigest,valueDigest(handoff.preparation));assert.equal(claimed.value.claimDigest,claim.digest);
  assert(Date.parse(claimed.startedAt)<=Date.parse(claim.claimedAt)&&Date.parse(claim.claimedAt)<=Date.parse(claimed.completedAt),'Native claim must have occurred inside the original Host command');
  assert(Array.isArray(proof.edits)&&proof.edits.length>0&&proof.edits.length<=32);const changed=new Set(),allowed=new Set(reported.result.artifacts.map(a=>path.join(handoff.workspaceRoot,a.path)));let lastEdit=claimed.end;
  for(const evidence of proof.edits){const p=pair(evidence);assert(p.call.ordinal>lastEdit);const text=p.call.payload.input.trim(),prefix='text(await tools.apply_patch(';assert(text.startsWith(prefix)&&text.endsWith('));'));const patch=JSON.parse(text.slice(prefix.length,-3));assert.equal(typeof patch,'string');assert(patch.startsWith('*** Begin Patch\n')&&patch.trimEnd().endsWith('*** End Patch'));const paths=[...patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)].map(m=>m[1]);assert(paths.length>0);assert(!/^\*\*\* (?:Delete File|Move to):/m.test(patch));for(const file of paths){assert(allowed.has(file));assert(file.startsWith(handoff.workspaceRoot+path.sep));changed.add(file);}assert.deepEqual(parsedOutput(p.output),[{}]);lastEdit=p.output.ordinal;}
  for(const name of ['runtime-chain-probe/summary.sh','runtime-chain-probe/summary.test.sh'])assert(changed.has(path.join(handoff.workspaceRoot,name)),'Actual Host edits to both the implementation and its checks are required');
  const testCommand='/bin/bash '+hostQuote(path.join(handoff.workspaceRoot,'runtime-chain-probe/summary.test.sh'))+' '+hostQuote(path.join(handoff.workspaceRoot,'runtime-chain-probe/summary.sh')),validated=execution(proof.validation,testCommand,handoff.workspaceRoot);assert(validated.start>lastEdit);assert(validated.stdout.includes('checks=7 passed=7 failed=0'));
  const proposed=phase('propose'),submitted=phase('submit');assert(proposed.start>validated.end);assert(submitted.start>proposed.end);for(const r of [proposed,submitted]){assert.equal(r.value.claimDigest,claim.digest);assert.equal(r.value.commit,reported.result.commit);assert.deepEqual(r.value.change,reported.result.change);}assert.deepEqual(proposed.value.artifacts,reported.result.artifacts);assert.equal(submitted.value.reportDigest,reported.digest);
  assert(Date.parse(submitted.startedAt)<=Date.parse(reported.receivedAt)&&Date.parse(reported.receivedAt)<=Date.parse(submitted.completedAt),'Native report must have occurred inside the original Host command');
  await run.assertNoCredentialExposure([{name:'selected-original-coding-host-tool-records',text:records.filter(r=>r.row.type==='response_item').map(r=>r.raw.toString()).join('')}],{logs:false});
  for(const item of records){assert(Date.parse(item.row.timestamp)<=Date.parse(handoff.deadlineAt)+60000);const raw=Buffer.alloc(item.pin.bytes);assert.equal(fs.readSync(fd,raw,0,raw.length,item.pin.offset),raw.length);assert.equal(sha(raw),item.pin.sha256);if(item.row.type==='turn_context')run.artifact('coding-host-turn-context.json',{source: selected.selection.rolloutRef,pin:item.pin,turnId:item.row.payload.turn_id,model:item.row.payload.model,provider:selected.metadata.provider,recording:'Original turn metadata projection; instructions and reasoning omitted'});else run.artifact('coding-host-original-record.json',{source:selected.selection.rolloutRef,pin:item.pin,rawJsonl:item.raw.toString(),recording:'Original Codex tool call/output bytes; no reasoning or session instructions'});}
  assert.equal(sha(hostPrivateBytes(ref)),sha(proofBytes));assert.equal(sha(hostPrivateBytes(selected.selectionRef)),selected.selectionSha256);hostPinned(selected.selection.driverRef,selected.selection.driverSha256,1048576);
  const result={session:selected.metadata,source:selected.selection.rolloutRef,startOffset:selected.startOffset,proofSha256:sha(proofBytes),stageRequestId:handoff.stageRequestId,handoffDigest:handoff.digest,claimDigest:claim.digest,reportDigest:reported.digest,commit:reported.result.commit,change:reported.result.change,turns:[...turns].map(([turnId,value])=>({turnId,...value})),recordCount:records.length,originalToolChain:'VERIFIED_LOCAL_RECORD_BINDING',independentHostAttestation:false,cryptographicSignature:false};run.artifact('coding-host-original-proof-map.json',proof);run.artifact('coding-host-provenance.json',result);
  return{summary:result,revalidate(){
   assert.equal(fs.realpathSync(selected.selection.rolloutRef),selected.selection.rolloutRef);const st=fs.lstatSync(selected.selection.rolloutRef);assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.uid===process.getuid()&&(st.mode&0o022)===0);assert.equal(st.ino,selected.inode);assert.equal(st.dev,selected.device);
   assert.equal(sha(hostPrivateBytes(ref)),sha(proofBytes));assert.equal(sha(hostPrivateBytes(selected.selectionRef)),selected.selectionSha256);hostPinned(selected.selection.driverRef,selected.selection.driverSha256,1048576);
   const source=fs.openSync(selected.selection.rolloutRef,'r');try{const header=Buffer.alloc(selected.metaBytes);assert.equal(fs.readSync(source,header,0,header.length,0),header.length);assert.equal(sha(header),selected.metaSha256);for(const item of records){const raw=Buffer.alloc(item.pin.bytes);assert.equal(fs.readSync(source,raw,0,raw.length,item.pin.offset),raw.length);assert.equal(sha(raw),item.pin.sha256);}}finally{fs.closeSync(source);}
   return{recordCount:records.length,sourceSelectionSha256:selected.selectionSha256,proofSha256:sha(proofBytes),driverSha256:selected.selection.driverSha256,unchanged:true};
  }};
 }finally{fs.closeSync(fd);}
}

export function assertOriginalCodingHostIdentity(selected,header){
 const meta=JSON.parse(header);assert.equal(meta.type,'session_meta');const p=meta.payload;
 assert.equal(p.id,selected.selection.sessionId);assert.equal(p.session_id,selected.selection.sessionId);assert.equal(p.originator,'Codex Desktop');assert.equal(p.source,'vscode');
 assert.equal(typeof p.cli_version,'string');assert.equal(typeof p.model_provider,'string');
 assert.deepEqual(selected.metadata,{sessionId:p.id,hostVersion:p.cli_version,originator:p.originator,source:p.source,provider:p.model_provider});
 assert(Number.isSafeInteger(selected.startOffset)&&selected.startOffset>=header.length);assert.equal(selected.metaBytes,header.length);assert.equal(selected.metaSha256,sha(header));
}
export function assertHistoricalInspection(original,current){
 const {projectRevision:before,...old}=original,{projectRevision:after,...now}=current;
 assert(Number.isSafeInteger(before)&&Number.isSafeInteger(after)&&after>=before,'Current project revision may advance; historical evidence cannot regress');assert.deepEqual(now,old);
}


export async function collectE05Journey(run,c){
 assert.equal(c.caseInstanceId,'E05.journey');const {value}=readbackPrivate(run.selection.lifecycleVariants);
 return collectLifecycleReadback(run,c,value.provider,proveOriginalCodingHost);
}
async function collectRevisionIsolation(run,c,before,after,driver,events,revision,deadline){
 const time=()=>assert(Date.now()<deadline,'Definition isolation shares the original candidate-readback deadline');time();
 const {compileLifecycle}=await import(pathToFileURL(path.join(run.selection.installedRoot,'package/dist/lifecycle/compiler.js')).href),old=before.instance,next=after.instance;
 for(const node of old.definition.nodes){const retained=next.definition.nodes.find(n=>n.id===node.id);assert(retained&&retained.required===true&&node.checks.every(id=>retained.checks.includes(id)),'Changing definitions cannot remove any original required stage or check');}
 assert.notEqual(old.pins.definitionRevisionId,next.pins.definitionRevisionId,'The changed candidate must have a distinct actual project definition revision');assert.notEqual(old.pins.semanticDigest,next.pins.semanticDigest,'Comments alone cannot prove definition evolution');
 const sources={},compiled={};for(const [name,i]of [['before',old],['after',next]]){time();const source=await run.source(i.pins.definitionRevisionId),result=compileLifecycle(source,run.selection.projectId);assert.equal(result.valid,true);assert.deepEqual(result.effective,i.definition);assert.equal(result.effective.semanticDigest,i.pins.semanticDigest);sources[name]=source;compiled[name]=result;}
 const creation=i=>{const matches=events.filter(e=>e.type==='lifecycle-instance-created'&&e.data.instanceId===i.id);assert.equal(matches.length,1);assert.equal(matches[0].data.definitionRevisionId,i.pins.definitionRevisionId);assert.equal(matches[0].data.pinsDigest,i.pinsDigest);assert.equal(matches[0].data.executionDispatched,false);return matches[0];};
 const first=creation(old),second=creation(next),activation=events.filter(e=>e.type==='definition-activated'&&e.data.revisionId===next.pins.definitionRevisionId&&e.seq>first.seq&&e.seq<second.seq);assert(activation.length>0,'Require original new-definition activation between the actual old/new instance creations');for(const e of activation){assert.equal(e.data.sourceDigest,compiled.after.sourceDigest);assert.equal(e.data.executionAuthorized,false);assert.equal(e.data.releaseAuthorized,false);}
 const definitionBefore=await run.read('lifecycle.definition.inspect'),preview=await run.read('lifecycle.definition.validate',{yaml:sources.after});time();assert.equal(preview.ready,true);assert.deepEqual(preview.compilation.effective,next.definition);assert.equal(preview.compilation.effective.semanticDigest,next.pins.semanticDigest);
 // One actual draft write, with its own deterministic request and exact CAS.
 // No new Target, execution grant, stage action or owner mutation is requested.
 const requestId=run.requestId(c.caseInstanceId,'changed-definition-draft'),saved=await run.request('lifecycle.draft.save',{yaml:sources.after},{requestId,expectedRevision:revision});time();assert.equal(saved.status,200);assert.equal(saved.body.result.result.status,'DRAFT');assert.equal(saved.body.result.result.revisionId,next.pins.definitionRevisionId);
 const definitionAfter=await run.read('lifecycle.definition.inspect');assert.equal(definitionAfter.revision,revision+1);assert.deepEqual(definitionAfter.active,definitionBefore.active);assert.equal(await run.source(definitionAfter.draft.id),sources.after);assert.equal(await run.source(old.pins.definitionRevisionId),sources.before);
 for(const record of [before,after]){assert.deepEqual((await run.read('lifecycle.instance.inspect',{instanceId:record.instance.id})).instance,record.instance);for(const [id,original]of Object.entries(record.snapshots))assertHistoricalInspection(original,await run.read('lifecycle.stage.request.inspect',{stageRequestId:record.originals[id].id}));assert.deepEqual(await run.read('lifecycle.verification.feedback.read',{stageRequestId:record.originals.verification.id}),record.feedback);time();}
 const currentEvents=await driver.events();assert.deepEqual(currentEvents.slice(0,events.length),events);const appended=currentEvents.slice(events.length);assert.equal(appended.length,1);assert.equal(appended[0].type,'definition-draft-saved');assert.equal(appended[0].data.revisionId,next.pins.definitionRevisionId);assert.equal(appended[0].data.executionAuthorized,false);assert.equal(appended[0].data.releaseAuthorized,false);
 const summary={oldDefinitionRevisionId:old.pins.definitionRevisionId,newDefinitionRevisionId:next.pins.definitionRevisionId,oldSemanticDigest:old.pins.semanticDigest,newSemanticDigest:next.pins.semanticDigest,oldAssets:old.definition.semantic.assets,newAssets:next.definition.semantic.assets,originalCreationSequences:[first.seq,second.seq],originalActivationSequences:activation.map(e=>e.seq),draftRequestId:requestId,newRevision:definitionAfter.revision,originalInstancesAndRequestsUnchanged:true,newInstanceExactRevalidatedDefinition:true,originalActivationRecordedNoExecutionAuthority:true,draftWriteCount:1,newTargets:0,newGrants:0,newStageRequests:0};
 run.artifact('e05-definition-instance-isolation.json',{summary,definitionBefore,definitionAfter,sources,compiled,preview,saved,originalCreations:[first,second],originalActivations:activation,appended});return{summary,events:currentEvents,revision:definitionAfter.revision};
}

export function requireMissingRcLifecycle(instance,plan){
 assert.equal(instance.id,plan.instanceId);assert(/(?:^|[.+_-])rc(?:\d|[.+_-]|$)/i.test(plan.expectedVersion),'An actual RC-named version is required');
 const preceding=['scope','plan','implementation'],selected=[...preceding,'candidate'];assert.deepEqual(Object.keys(instance.stages).sort(),[...selected,'verification','release-decision','publication','closure'].sort());
 for(const id of selected){const stage=instance.stages[id];assert.equal(stage.status,id==='candidate'?'UNKNOWN':'PASSED');assert(Number.isSafeInteger(stage.attempts)&&stage.attempts>0);assert.equal(typeof stage.requestId,'string');assert(stage.requestId.length>0);for(const key of ['inputDigest','outcomeDigest'])assert(/^sha256:[a-f0-9]{64}$/.test(stage[key]));}
 for(const id of ['verification','release-decision','publication','closure']){assert.equal(instance.stages[id].status,'PENDING');assert.equal(instance.stages[id].attempts,0);assert.equal(instance.stages[id].requestId,null);}
 assert.equal(instance.candidate,null);assert.equal(instance.candidateDigest,null);return selected;
}
export function assertMissingRcPayload(result,entries,expectedVersion,request,archive,expectedChecks,digestCandidate,artifactApi){
 exactKeys(result,['schema','requestId','inputDigest','provider','repositoryId','runId','sourceCommit','workflowDigest','stageId','candidateDigest','checks','candidate']);assert.equal(result.schema,'runtime-ci/v1');assert.equal(result.stageId,'candidate');assert.equal(request.stageId,'candidate');assert.equal(result.candidateDigest,null);assert.equal(request.candidateDigest,null);
 for(const [key,value]of Object.entries({requestId:request.requestId,inputDigest:request.inputDigest,provider:archive.provider,repositoryId:archive.repositoryId,runId:archive.runId,sourceCommit:request.commit,workflowDigest:request.workflowDigest}))assert.equal(result[key],value);
 assert.equal(result.candidate.version,expectedVersion);assert(/(?:^|[.+_-])rc(?:\d|[.+_-]|$)/i.test(expectedVersion));digestCandidate(result.candidate);assert.equal(result.candidate.sourceDigest,artifactApi.ciSourceDigest(request,archive.provider,archive.repositoryId));assert.equal(result.candidate.buildDigest,artifactApi.ciBuildDigest(request,archive.runId));
 const verify=(ref,bytes)=>{assert(bytes,'Missing prerequisite/check evidence cannot substitute for a missing candidate payload');assert.equal(ref.bytes,bytes.length);assert.equal(ref.digest,'sha256:'+sha(bytes));};
 assert(Array.isArray(result.checks));assert.deepEqual(result.checks.map(c=>c.id).sort(),[...expectedChecks].sort());
 for(const check of result.checks){exactKeys(check,['id','status','evidence']);assert.equal(check.status,'PASS');assert(Array.isArray(check.evidence)&&check.evidence.length>0);for(const item of check.evidence){exactKeys(item,['path','digest','bytes']);verify(item,entries.get(item.path));}}
 const missing=[];for(const artifact of result.candidate.artifacts){const file='artifacts/'+artifact.name,bytes=entries.get(file);if(bytes)verify(artifact,bytes);else missing.push(file);}
 assert(missing.length>0,'A complete RC payload cannot qualify the missing-artifact case');return missing;
}
export async function collectE05MissingCandidate(run,c){
 assert.equal(c.caseInstanceId,'E05.variant.02');const {value}=readbackPrivate(run.selection.lifecycleVariants);return collectLifecycleReadback(run,c,value.provider,proveOriginalCodingHost);
}

// CV07 is a pre-E20 inventory observation, not the aggregate release audit.
// Only the existing support.mjs original-execution emit format is accepted.
// Original sibling executions remain inputs; this callback executes its own
// inventory guards and independently rereads real Host/provider/owner records.
const COVERAGE_SCENARIOS=Object.freeze({E01:['github'],E02:['gitlab'],E18:['github','gitlab']});
const ORIGINAL_REPORT_KEYS=['scenario','candidate','candidateDigest','selectionDigest','qualification','scenarioDenominator','fullDenominator','selected','executed','passed','failed','unexecutedCaseIds','scenarioStatus','productAcceptance','releaseAuthorized','dailyInstallationChanged','setupEvidence','results'];
const ORIGINAL_RESULT_KEYS=['caseInstanceId','status','candidateDigest','qualification','assertions','evidence'];
export function validateCoverageInventoryRecords(records,context){
 const {scenario,expectedIds,qualification,candidate,matrixDigest,collectorPins}=context;
 assert(Object.hasOwn(COVERAGE_SCENARIOS,scenario));assert(expectedIds.includes(scenario+'.CV07'));
 const required=expectedIds.filter(id=>id!==scenario+'.CV07');assert(required.length>0);
 assert(Array.isArray(records)&&records.length>0,'CV07_EMPTY_INVENTORY');
 assert.equal(new Set(records.map(r=>r.caseInstanceId)).size,records.length,'CV07_DUPLICATE_CASE');
 assert.deepEqual(records.map(r=>r.caseInstanceId),required,'CV07_MISSING_OR_UNEXPECTED_CASE');
 for(const item of records){
  exactKeys(item,['caseInstanceId','report','selection','caseRecord']);const {report,selection,caseRecord}=item;
  try{exactKeys(report,ORIGINAL_REPORT_KEYS);assert(Array.isArray(report.results)&&report.results.length===1);exactKeys(report.results[0],ORIGINAL_RESULT_KEYS);}catch{throw Error('CV07_ORIGINAL_EXECUTION_SCHEMA_REQUIRED');}
  assert.equal(report.dailyInstallationChanged,false);assert.equal(report.results[0].status,'PASS','CV07_SKIP_XFAIL_OR_NONPASS');
  assert.equal(report.candidateDigest,'sha256:'+candidate.manifestDigest,'CV07_WRONG_CANDIDATE');
  assert.equal(report.results[0].candidateDigest,report.candidateDigest,'CV07_WRONG_CANDIDATE');
  assert(!selection.caseCampaign,'CV07_REQUIRES_ORIGINAL_SINGLETON_NOT_CAMPAIGN_PROXY');
  for(const value of [selection,report.results[0].assertions]){assert(value&&typeof value==='object'&&!Array.isArray(value));for(const key of ['mode','executionMode','qualificationMode'])if(Object.hasOwn(value,key))assert.equal(value[key],'EXECUTED','CV07_QUALIFIED_ONLY_OR_REUSED_RECORD');if(Object.hasOwn(value,'status'))assert(!['PASS_REUSED','QUALIFIED','SKIP','SKIPPED','XFAIL'].includes(value.status),'CV07_QUALIFIED_ONLY_OR_REUSED_RECORD');}
  assert.equal(selection.sourceQualification,'SEPARATE_E20_OBLIGATION');assert.equal(selection.matrixDigest,matrixDigest,'CV07_WRONG_MATRIX');
  assert.deepEqual(selection.collectorPins,collectorPins,'CV07_WRONG_COLLECTOR_SOURCE');
  const result=assertLiveChildReport(report,selection,item.caseInstanceId,expectedIds,qualification,candidate);
  assert.deepEqual(caseRecord,result,'CV07_ORIGINAL_CASE_BYTES_MISMATCH');
 }
 return{originalCaseIds:required,originalExecutions:records.length,qualification,sourceQualification:'SEPARATE_E20_OBLIGATION',siblingExecutionsReexecuted:false};
}
function coverageSource(commit,qualification){
 assert(/^[a-f0-9]{40}$/.test(commit));const options={encoding:'utf8',timeout:15000,maxBuffer:1048576,env:{PATH:'/usr/bin:/bin',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'}};
 assert.equal(execFileSync('/usr/bin/git',['-c','core.fsmonitor=false','-C',repository,'rev-parse','HEAD'],options).trim(),commit,'CV07_SOURCE_COMMIT_CHANGED');
 if(qualification==='FINAL_CANDIDATE')assert.equal(execFileSync('/usr/bin/git',['-c','core.fsmonitor=false','-C',repository,'status','--porcelain'],options),'','Final inventory requires clean exact source');
}
export function validateCoverageProviderBindings(providers,scenario,records){
 assert(Object.hasOwn(COVERAGE_SCENARIOS,scenario));assert(Array.isArray(providers));
 assert.deepEqual(providers.map(p=>p.provider),COVERAGE_SCENARIOS[scenario],'CV07_EXACT_REAL_PROVIDER_BINDINGS_REQUIRED');
 for(const p of providers){exactKeys(p,['provider','reportCaseId','selection','allowServiceRestart','record']);assert.equal(p.allowServiceRestart,true,'Owner inbox readback needs explicit isolated service restart authority');assert.equal(p.record.codingSourceSelection.kind,'ORIGINAL_RECORD');assert(records.some(r=>r.caseInstanceId===p.reportCaseId),'CV07_PROVIDER_REQUIRES_ORIGINAL_SIBLING');}
 return providers;
}
// HTTP, JSON-only MCP and CLI retain different original wire shapes. The
// existing CLI envelope lacks the wrapper's caseInstanceId; never invent it.
export function coverageOriginalInstance(request,response,item,caseId,candidate){
 assert.equal(response.caseInstanceId,caseId);
 if(Object.hasOwn(request,'caseInstanceId'))assert.equal(request.caseInstanceId,caseId);
 if(Object.hasOwn(item,'responseDigest')){assert.equal(typeof response.rawBody,'string');assert.equal(sha(response.rawBody),item.responseDigest);}
 if(Object.hasOwn(response,'body'))assert.deepEqual(JSON.parse(response.rawBody),response.body);
 if(request.envelope?.operation!=='lifecycle.instance.inspect'||response.status!==200)return null;
 assert.equal(request.caseInstanceId,caseId);assert.equal(request.envelope.projectId,candidate.projectId);
 const instance=response.body.result.instance;assert.equal(instance.id,request.envelope.input.instanceId);assert.equal(instance.pins.projectId,candidate.projectId);return instance.id;
}
async function coverageTarget(run,p,original,deadline,recheck){
 const {value:input}=readbackPrivate(p.selection);assert.equal(input.schema,'runtime-v090-acceptance-selection/v1');assert.equal(input.expectedManifestDigest,run.candidate.manifestDigest);assert.equal(input.qualification,run.selection.qualification);assert.deepEqual(input.caseIds,[p.reportCaseId]);assert(!input.caseCampaign);
 assert.equal(input.connectionRef,path.join(input.installedRoot,'connection.json'));assert.equal(input.outputRoot,path.dirname(original.reportRef));
 const load=relative=>import(pathToFileURL(path.join(input.installedRoot,'package/dist',relative)).href),control=await load('installation/service-control.js'),security=await load('server/security.js');
 const selected=control.inspectInstalledServiceSelection(input.installedRoot),manifestPin={ref:path.join(input.installedRoot,'distribution-manifest.json'),sha256:input.expectedManifestDigest},manifest=readbackPrivate(manifestPin).value;
 assert.equal(selected.distributionManifestDigest,input.expectedManifestDigest);assert.equal(manifest.archiveDigest,run.candidate.archiveDigest);assert.equal(manifest.version,run.candidate.version);
 const connectionBytes=fs.readFileSync(input.connectionRef),connectionPin=sha(connectionBytes),connection=security.readHostConnection(input.connectionRef),url=new URL(connection.origin);assert.equal(url.protocol,'http:');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/');assert.equal(url.search,'');assert.equal(url.username,'');assert.equal(url.password,'');
 const candidate={manifestDigest:input.expectedManifestDigest,archiveDigest:manifest.archiveDigest,version:manifest.version,serviceId:connection.serviceId,workspaceId:input.workspaceId,projectId:input.projectId};assert.deepEqual(candidate,original.report.candidate);assert.equal(connection.serviceId,selected.serviceId);for(const k of ['workspaceId','projectId'])assert.equal(connection[k],input[k]);assert.equal(connection.version,manifest.version);
 const planPin={ref:path.join(input.installedRoot,'installation-plan.json'),sha256:sha(fs.readFileSync(path.join(input.installedRoot,'installation-plan.json')))},plan=readbackPrivate(planPin).value;assert.equal(plan.codex,null,'CV07 readback cannot stop a daily/Host-registered installation');
 const specPin={ref:path.join(input.installedRoot,'service-specification.json'),sha256:sha(fs.readFileSync(path.join(input.installedRoot,'service-specification.json')))},spec=readbackPrivate(specPin).value;assert(spec.integrationsRef);const configPin={ref:spec.integrationsRef,sha256:sha(fs.readFileSync(spec.integrationsRef))};readbackPrivate(configPin);
 const token=security.hostHeaders(connection).Authorization.slice(7),safe=value=>{assert(!Buffer.from(typeof value==='string'?value:JSON.stringify(value)).includes(Buffer.from(token)),'CV07 credential exposure');};
 let calls=0;const operations=new Set(['runtime.status','runtime.events.read','lifecycle.instance.inspect','lifecycle.stage.request.inspect','lifecycle.stage.observation.read','lifecycle.agent.handoff.read','lifecycle.agent.report.read','lifecycle.scope.evidence.read','lifecycle.implementation.evidence.read','lifecycle.preparation.read','lifecycle.release.evidence.read','lifecycle.plan.evidence.read','lifecycle.verification.feedback.read','lifecycle.publication.evidence.read','lifecycle.closure.evidence.read','lifecycle.extension.evidence.read','lifecycle.authority.inspect']);
 async function read(operation,inputBody={}){
  assert(operations.has(operation),'CV07 readback operation is outside its fixed read-only allowlist');assert(Date.now()<deadline);assert(++calls<=1200,'CV07 native read count exceeded');
  const envelope={operation,projectId:input.projectId,input:inputBody};run.artifact('cv07-original-service-request.json',{provider:p.provider,serviceId:connection.serviceId,envelope,readOnly:true});
  const response=await fetch(new URL('/api/v1/request',connection.origin),{method:'POST',redirect:'error',headers:{...security.hostHeaders(connection),'content-type':'application/json'},body:JSON.stringify(envelope),signal:AbortSignal.timeout(Math.min(30000,deadline-Date.now()))});
  const chunks=[];let total=0;for await(const chunk of response.body){total+=chunk.length;assert(total<=1048576,'CV07 native response exceeds 1MiB');chunks.push(chunk);}const raw=Buffer.concat(chunks).toString('utf8');safe(raw);const body=JSON.parse(raw);run.artifact('cv07-original-service-response.json',{provider:p.provider,serviceId:connection.serviceId,status:response.status,rawBody:raw,body});assert.equal(response.status,200,'CV07 actual native read denied: '+(body.error?.code??'UNKNOWN'));return body.result;
 }
 function intact(){recheck();readbackPrivate(p.selection);readbackPrivate(manifestPin);readbackPrivate(planPin);readbackPrivate(specPin);readbackPrivate(configPin);assert.equal(sha(fs.readFileSync(input.connectionRef)),connectionPin);assert.deepEqual(control.inspectInstalledServiceSelection(input.installedRoot),selected);}
 const status=await read('runtime.status');assert.equal(status.serviceId,connection.serviceId);assert.equal(status.workspaceId,input.workspaceId);assert.equal(status.version,manifest.version);assert.equal(status.independentLlm,false);
 const target={...run,selection:{...input,browserConfiguration:{allowServiceRestart:true}},candidate,serviceOrigin:connection.origin,read,request:()=>{throw Error('CV07 never submits an authority or execution request');},source:()=>{throw Error('CV07 requires original Host source records');},assertNoCredentialExposure:async(surfaces,options)=>{for(const item of surfaces)safe(item.text);return run.assertNoCredentialExposure(surfaces,options);}};
 intact();run.artifact('cv07-provider-installed-binding.json',{provider:p.provider,reportCaseId:p.reportCaseId,originalInputSelection:p.selection,candidate,installationSelection:selected,manifest:manifestPin,installationPlan:planPin,serviceSpecification:specPin,integrationConfiguration:configPin,connectionSha256:connectionPin,allowServiceRestart:true,dailyInstallationChanged:false});return{target,intact};
}
export async function collectCoverageInventory(run,c){
 const scenario=c.caseInstanceId.split('.')[0];assert.equal(c.caseInstanceId,scenario+'.CV07');assert(Object.hasOwn(COVERAGE_SCENARIOS,scenario));assert(run.selection.coverageInventory,'CV07_NOT_READY: select protected original reports and real provider bindings');
 const pin=run.selection.coverageInventory,{value:fixture}=readbackPrivate(pin);exactKeys(fixture,['schema','scenario','candidateDigest','sourceCommit','reports','providers']);assert.equal(fixture.schema,'runtime-v090-coverage-inventory/v1');assert.equal(fixture.scenario,scenario);assert.equal(fixture.candidateDigest,run.candidateDigest);
 const deadline=Date.now()+600000,observed=JSON.parse(fs.readFileSync(path.join(run.selection.outputRoot,'selection.json'))),context={scenario,expectedIds:run.all.map(row=>row.caseInstanceId),qualification:run.selection.qualification,candidate:run.candidate,matrixDigest:observed.matrixDigest,collectorPins:observed.collectorPins};
 const rechecks=[],records=[],originals=new Map();let total=0,leaves=0;
 const sourceCheck=()=>{assert(Date.now()<deadline,'CV07 inventory exceeded its absolute 600-second window');coverageSource(fixture.sourceCommit,run.selection.qualification);readbackPrivate(pin);for(const[name,digest]of Object.entries(context.collectorPins))assert.equal(sha(fs.readFileSync(new URL(name,import.meta.url))),digest);};sourceCheck();
 const retain=(label,ref,bytes)=>{total+=bytes.length;assert(total<=1073741824,'CV07 original input bytes exceed 1GiB');const digest=sha(bytes);rechecks.push({ref,sha256:digest,max:Math.max(bytes.length,1)});const chunks=Math.ceil(bytes.length/1048576)||1;for(let index=0;index<chunks;index++)run.artifact('cv07-original-input-bytes.json',{label,ref,sha256:digest,totalBytes:bytes.length,index,chunks,encoding:'base64',bytes:bytes.subarray(index*1048576,(index+1)*1048576).toString('base64')});};
 assert(Array.isArray(fixture.reports)&&fixture.reports.length===context.expectedIds.length-1,'CV07_MISSING_OR_UNEXPECTED_CASE');assert.equal(new Set(fixture.reports.map(v=>v.caseInstanceId)).size,fixture.reports.length,'CV07_DUPLICATE_CASE');
 for(const entry of fixture.reports){
  sourceCheck();exactKeys(entry,['caseInstanceId','report']);assert(context.expectedIds.includes(entry.caseInstanceId)&&entry.caseInstanceId!==c.caseInstanceId);assert.equal(path.basename(entry.report.ref),'REPORT.json');
  const report=readbackPrivate(entry.report,33554432),root=path.dirname(entry.report.ref),selectionRef=path.join(root,'selection.json'),selection=readbackPrivate({ref:selectionRef,sha256:report.value.selectionDigest}),caseRef=path.join(root,entry.caseInstanceId+'.json'),caseBytes=hostPrivateBytes(caseRef,16777216),caseRecord=readbackPrivate({ref:caseRef,sha256:sha(caseBytes)},16777216);
  const record={caseInstanceId:entry.caseInstanceId,report:report.value,selection:selection.value,caseRecord:caseRecord.value};records.push(record);
  retain('original-singleton-report',entry.report.ref,report.bytes);retain('original-singleton-selection',selectionRef,selection.bytes);retain('original-singleton-case',caseRef,caseRecord.bytes);
  const seen=new Map(),instanceIds=new Set();let childBytes=0;
  const leaf=(name,digest)=>{assert(typeof name==='string'&&/^[A-Za-z0-9_.-]+$/.test(name)&&!['.','..','REPORT.json','selection.json',entry.caseInstanceId+'.json'].includes(name));assert(/^[a-f0-9]{64}$/.test(digest));if(seen.has(name)){assert.equal(seen.get(name).digest,digest);return seen.get(name).bytes;}const ref=path.join(root,name),st=fs.lstatSync(ref);assert.equal(fs.realpathSync(ref),ref);assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.uid===process.getuid()&&(st.mode&0o077)===0&&st.size<=16777216);const bytes=fs.readFileSync(ref);assert.equal(sha(bytes),digest);childBytes+=bytes.length;assert(childBytes<=268435456&&++leaves<=30000,'CV07 original raw evidence exceeds fixed bounds');seen.set(name,{digest,bytes});retain('original-raw-evidence',ref,bytes);return bytes;};
  const evidence=(item,id)=>{assert.equal(item.caseInstanceId,id);if(Object.hasOwn(item,'artifact')){assert(!Object.hasOwn(item,'request')&&!Object.hasOwn(item,'response'));leaf(item.artifact,item.fileDigest);}else{const request=JSON.parse(leaf(item.request,item.requestDigest)),response=JSON.parse(leaf(item.response,item.fileDigest));const instanceId=coverageOriginalInstance(request,response,item,id,report.value.candidate);if(instanceId)instanceIds.add(instanceId);}};
  assert(Array.isArray(report.value.setupEvidence)&&report.value.results.length===1);for(const item of report.value.setupEvidence)evidence(item,null);for(const item of caseRecord.value.evidence)evidence(item,entry.caseInstanceId);
  originals.set(entry.caseInstanceId,{...record,reportRef:entry.report.ref,instanceIds});
 }
 const inventory=validateCoverageInventoryRecords(records,context);validateCoverageProviderBindings(fixture.providers,scenario,records);
 // Each fault is explicitly a copied validator input. No faulted bytes are
 // submitted as a protected service record or claimed as a provider response.
 const guards=[['missing',v=>v.pop(),/CV07_MISSING_OR_UNEXPECTED_CASE/],['empty',v=>v.splice(0),/CV07_EMPTY_INVENTORY/],['duplicate',v=>v.push(structuredClone(v[0])),/CV07_DUPLICATE_CASE/],['empty-report',v=>v[0].report.results=[],/CV07_ORIGINAL_EXECUTION_SCHEMA_REQUIRED/],['skip',v=>v[0].report.results[0].status='SKIP',/CV07_SKIP_XFAIL_OR_NONPASS/],['xfail',v=>v[0].report.results[0].status='XFAIL',/CV07_SKIP_XFAIL_OR_NONPASS/],['wrong-candidate',v=>v[0].report.candidateDigest='sha256:'+'0'.repeat(64),/CV07_WRONG_CANDIDATE/]];
 for(const[name,mutate,reason]of guards){const fault=structuredClone(records);mutate(fault);let rejected;assert.throws(()=>validateCoverageInventoryRecords(fault,context),error=>{rejected=error.message;return reason.test(error.message);});run.artifact('cv07-explicit-inventory-fault-guard.json',{name,faultInjected:true,inputKind:'COPIED_VALIDATOR_INPUT_ONLY',originalInputAltered:false,faultedInputDigest:sha(JSON.stringify(fault)),expectedReason:reason.source,actualRejection:rejected,submittedToProtectedSource:false});}
 const providers=[];for(const p of fixture.providers){sourceCheck();lifecycleRecordPlan(p.record);const original=originals.get(p.reportCaseId);assert(original.instanceIds.has(p.record.instanceId),'CV07 provider instance must occur in its original raw singleton native response');const {target,intact}=await coverageTarget(run,p,original,deadline,sourceCheck);providers.push((await lifecycleRecordEvidence(target,c,p.provider,proveOriginalCodingHost,p.record,null,deadline,false,false,intact)).summary);intact();}
 for(const item of rechecks){const st=fs.lstatSync(item.ref);assert.equal(fs.realpathSync(item.ref),item.ref);assert(st.isFile()&&st.nlink===1&&st.uid===process.getuid()&&(st.mode&0o077)===0&&st.size<=item.max);assert.equal(sha(fs.readFileSync(item.ref)),item.sha256,'CV07 original evidence changed during independent readback');}sourceCheck();validateCoverageInventoryRecords(records,context);
 return{...inventory,sourceCommit:fixture.sourceCommit,candidateDigest:run.candidateDigest,providers,independentNegativeGuards:guards.map(g=>g[0]),originalRawFiles:leaves,originalInputBytes:total,actualProviderFactsReread:true,finalE20AggregateExecuted:false,finalE20StillRequired:true,releaseAuthorized:false,originalSiblingExecutionsAreInputsOnly:true};
}
