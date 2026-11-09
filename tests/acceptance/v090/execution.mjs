// Native installed execution collectors retain original records and bounded
// lifecycle configuration probes. They never prepare owner assets or decisions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {sha} from './support.mjs';
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
export const LIFECYCLE_READBACK_CASES=Object.freeze({'E01.variant.01':'non-rc','E01.variant.02':'candidate-drift','E01.variant.03':'candidate-drift','E01.variant.05':'feedback-publication','E02.variant.01':'non-rc','E02.variant.02':'candidate-drift','E02.variant.04':'feedback-publication'});
function readbackPrivate(pin,max=1048576){
 exactKeys(pin,['ref','sha256']);assert(/^[a-f0-9]{64}$/.test(pin.sha256));assert.equal(fs.realpathSync(pin.ref),pin.ref);const s=fs.lstatSync(pin.ref);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o077)===0&&s.size>0&&s.size<=max);
 const bytes=fs.readFileSync(pin.ref);assert.equal(sha(bytes),pin.sha256);return{bytes,value:JSON.parse(bytes)};
}
function lifecycleRecordPlan(p){
 exactKeys(p,['instanceId','expectedVersion','preparation','ownerFixture','codingSourceSelection','exchangeRoot']);assert(/^[a-z0-9][a-z0-9._-]{0,127}$/.test(p.instanceId));assert(typeof p.expectedVersion==='string'&&p.expectedVersion.length>0&&p.expectedVersion.length<=128);assert.equal(fs.realpathSync(p.exchangeRoot),p.exchangeRoot);assert.equal(fs.lstatSync(p.exchangeRoot).mode&0o777,0o700);
 for(const key of ['preparation','ownerFixture'])readbackPrivate(p[key]);if(p.codingSourceSelection.kind==='CURRENT_JOURNEY')exactKeys(p.codingSourceSelection,['kind']);else{exactKeys(p.codingSourceSelection,['kind','ref','sha256']);assert.equal(p.codingSourceSelection.kind,'ORIGINAL_RECORD');readbackPrivate({ref:p.codingSourceSelection.ref,sha256:p.codingSourceSelection.sha256});}return p;
}
export function lifecycleReadbackPlan(run,c,provider){
 assert(['github','gitlab'].includes(provider));assert(c.caseInstanceId.startsWith(provider==='github'?'E01.':'E02.'));assert(Object.hasOwn(LIFECYCLE_READBACK_CASES,c.caseInstanceId));
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
 if(LIFECYCLE_READBACK_CASES[c.caseInstanceId]==='candidate-drift')return collectCandidateDrift(run,c,provider,proveCodingHost,plan,currentSource,deadline);
 return(await lifecycleRecordEvidence(run,c,provider,proveCodingHost,plan,currentSource,deadline)).summary;
}
async function lifecycleRecordEvidence(run,c,provider,proveCodingHost,plan,currentSource,deadline,throughVerification=false){
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
 const initial=await read('lifecycle.instance.inspect',{instanceId:plan.instanceId}),instance=instanceApi.inspectInstance(initial.instance),stages=throughVerification?requireVerifiedLifecycle(instance,plan):requireClosedLifecycle(instance,plan,c.caseInstanceId);assert.equal(instance.pins.projectId,run.selection.projectId);assert.equal(base.isCurrentBase(instance.pins.base),true);
 const originals={},snapshots={};
 for(const id of stages){
  const value=await read('lifecycle.stage.request.inspect',{stageRequestId:instance.stages[id].requestId}),r=value.request,{digest,...body}=r;assert.equal(base.valueDigest(body),digest);assert.equal(base.valueDigest(r.plan),r.planDigest);assert.equal(r.id,instance.stages[id].requestId);assert.equal(r.stageId,id);assert.equal(r.instanceId,instance.id);assert.equal(r.workspaceId,run.selection.workspaceId);assert.equal(r.projectId,run.selection.projectId);assert.equal(r.pinsDigest,instance.pinsDigest);assert.equal(r.inputDigest,instance.stages[id].inputDigest);assert.equal(value.automaticRedispatch,false);assert.equal(value.workerError,null);assert.equal(value.progress.phase,'COMPLETE');assert.equal(value.progress.terminal,true);
  const observation=await read('lifecycle.stage.observation.read',{stageRequestId:r.id,observationRef:value.progress.observationRef});assert.equal(base.valueDigest(observation.evidence),observation.observationRef);assert.equal(observation.evidence.requestId,r.id);assert.deepEqual(observation.evidence.observation,value.progress.observation);assert.equal(base.valueDigest(value.progress.observation.outcome),instance.stages[id].outcomeDigest);originals[id]=r;snapshots[id]=value;
 }
 const scope=await read('lifecycle.scope.evidence.read',{stageRequestId:originals.scope.id}),planning=await read('lifecycle.plan.evidence.read',{stageRequestId:originals.plan.id}),implementation=await read('lifecycle.implementation.evidence.read',{stageRequestId:originals.implementation.id}),handoff=await read('lifecycle.agent.handoff.read',{stageRequestId:originals.implementation.id}),reported=await read('lifecycle.agent.report.read',{stageRequestId:originals.implementation.id});
 assert(handoff.claim&&reported.report?.state==='SUBMITTED');assert.equal(handoff.latestReport.digest,reported.report.digest);assert.equal(reported.report.result.change.kind,provider==='github'?'pull-request':'merge-request');assert.equal(handoff.handoff.runtimeStartsAgent,false);assert.equal(handoff.handoff.stageRequestId,originals.implementation.id);
 const hostRun={...run,selection:{...run.selection,lifecycleExecution:{exchangeRoot:plan.exchangeRoot}}},hostProof=await proveCodingHost(hostRun,selectedHost,handoff.handoff,reported.report,handoff.claim,spec.nodeExecutable,base.valueDigest);time();
 const commit=reported.report.result.commit,feedback=await read('lifecycle.verification.feedback.read',{stageRequestId:originals.verification.id}),publication=throughVerification?null:await read('lifecycle.publication.evidence.read',{stageRequestId:originals.publication.id}),closure=throughVerification?null:await read('lifecycle.closure.evidence.read',{stageRequestId:originals.closure.id}),release=throughVerification?null:await read('lifecycle.release.evidence.read',{stageRequestId:originals['release-decision'].id});
 assert.equal(feedback.event.stage,'SUCCEEDED');assert.equal(feedback.event.projectCandidateDigest,instance.candidateDigest);assert.equal(feedback.event.runId,'verification:'+originals.verification.id);assert.equal(feedback.event.inputDigest,originals.verification.inputDigest);assert.equal(feedback.event.source.revision,commit);assert.equal(feedback.releaseAuthorized,false);if(!throughVerification){assert.equal(closure.evidence.archive.status,'COMPLETE');assert.equal(publication.evidence.harness.status,'PASS');assert.equal(publication.evidence.distribution.candidateDigest,instance.candidateDigest);assert.equal(closure.evidence.smoke.status,'PASSED');assert.equal(closure.evidence.distribution.candidateDigest,instance.candidateDigest);}
 for(const owner of ['ontology','harness']){assert.deepEqual(feedback.event.pins[owner],fixture.references[owner]);if(!throughVerification)assert.equal(closure.evidence.feedback[owner].status,'REUSE_APPROVED');assert.equal(feedback.event.results[owner].result.context.projectCandidateDigest,instance.candidateDigest);assert.equal(feedback.event.results[owner].result.context.inputDigest,originals.verification.inputDigest);assert.equal(feedback.event.results[owner].result.context.requirementSetDigest,instance.pins.requirementsDigest);}
 run.artifact(throughVerification?'independent-native-verification-chain.json':'independent-native-complete-chain.json',{caseInstanceId:c.caseInstanceId,verifiedStages:stages,instance,originals,scope,planning,implementation,feedback,publication,closure,release,originalCodingHost:hostProof.summary,historicalReadOnly:true,currentExecutionAuthorized:false,softwareReleaseAuthorized:false});
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
  return{request:ci,observation:observed,verified,client,transport,archive};
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
  return{request:ci,observation:observed,verified,client,transport,archive};
 }
 const ciEvidence=provider==='github'?githubEvidence:gitlabEvidence;
 const ciProofs={};
 ciProofs.implementation=await ciEvidence('implementation',implementation.derivation.request,originalCi(implementation.derivation.request),implementation.derivation.request.plan.parameters.expectedChecks,implementation.ci.artifact);
 for(const id of ['candidate','verification'])ciProofs[id]=await ciEvidence(id,originals[id],originalCi(originals[id]),originals[id].plan.parameters.expectedChecks);
 if(!throughVerification){ciProofs.publication=await ciEvidence('publication',originals.publication,publication.ciRequest,originals.publication.plan.parameters.expectedChecks,publication.evidence.artifact);
 ciProofs.closure=await ciEvidence('closure',originals.closure,closure.ciRequest.ci,['base.closure.delivery-acceptance'],closure.evidence.smoke.ci);}
 assert.equal(new Set(Object.values(ciProofs).map(x=>x.observation.runId)).size,throughVerification?3:5);assert.equal(ciProofs.candidate.verified.candidateDigest,instance.candidateDigest);assert.deepEqual(ciProofs.candidate.verified.candidate,instance.candidate);assert.equal(ciProofs.verification.request.candidateDigest,instance.candidateDigest);assert.deepEqual(ciProofs.verification.request.candidateInput.manifest,instance.candidate);assert.deepEqual(ciProofs.verification.request.candidateInput.archive,ciProofs.candidate.verified.sourceArchive);
 for(const proof of Object.values(ciProofs)){assert.equal(proof.request.commit,commit);assert.equal(proof.observation.provider,provider);assert.equal(proof.observation.repositoryId,preparation.source.repositoryId);}
 const change=reported.report.result.change,source=await ciProofs.implementation.client.source(actor(),{baselineCommit:preparation.source.commit,commit,change,artifacts:reported.report.result.artifacts},boundedSignal(60000));run.artifact('independent-original-source-review.json',source);assert.equal(source.provider,provider);assert.equal(source.commit,commit);assert.equal(source.repositoryId,preparation.source.repositoryId);assert.deepEqual(source.change,change);assert.deepEqual(source.artifacts,reported.report.result.artifacts);assert.equal(source.sourceReviewApproved,false);assert.equal(source.releaseAuthorized,false);
 if(throughVerification){
  time();assert.deepEqual((await read('lifecycle.instance.inspect',{instanceId:instance.id})).instance,instance);assert.deepEqual(await read('lifecycle.verification.feedback.read',{stageRequestId:originals.verification.id}),feedback);
  for(const id of stages)assert.deepEqual(await read('lifecycle.stage.request.inspect',{stageRequestId:originals[id].id}),snapshots[id]);assert.equal((await read('runtime.status')).revision,initialRevision);run.artifact('independent-candidate-host-source-recheck.json',hostProof.revalidate());
  for(const key of ['preparation','ownerFixture'])readbackPrivate(plan[key]);if(plan.codingSourceSelection.kind==='ORIGINAL_RECORD')readbackPrivate({ref:plan.codingSourceSelection.ref,sha256:plan.codingSourceSelection.sha256});lifecycleReadbackPlan(run,c,provider);
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
 run.artifact('independent-coding-source-recheck.json',hostProof.revalidate());for(const key of ['preparation','ownerFixture'])readbackPrivate(plan[key]);if(plan.codingSourceSelection.kind==='ORIGINAL_RECORD')readbackPrivate({ref:plan.codingSourceSelection.ref,sha256:plan.codingSourceSelection.sha256});lifecycleReadbackPlan(run,c,provider);assert.equal((await read('runtime.status')).independentLlm,false);
 const identities=Object.fromEntries(Object.entries(ciProofs).map(([id,v])=>[id,{requestId:v.request.requestId,runId:v.observation.runId,jobs:v.observation.jobs.map(j=>({jobId:j.jobId,runnerId:j.runnerId})),archive:v.verified.sourceArchive,resultDigest:v.verified.resultDigest}]));
 const summary={caseInstanceId:c.caseInstanceId,purpose:LIFECYCLE_READBACK_CASES[c.caseInstanceId],provider,instanceId:instance.id,version:instance.candidate.version,candidateDigest:instance.candidateDigest,allEightOriginalStagesPassed:true,originalHostRecordsVerified:true,originalSourceChange:change,originalCi:identities,independentDistributionDownload:true,independentOwnerInboxes:owners,priorCasePassLabelConsumed:false,nativeMutations:0,providerWrites:0,authorityCreatedOrExtended:false,assetGradeMeaning:'CONTENT_ONLY_NOT_SOFTWARE_ACCEPTANCE_OR_AUTHORITY',currentSoftwareReleaseAuthorized:false,remainingCasesNotCredited:true};
 return{summary,instance,originals,snapshots,ciProofs,handoff,reported,feedback,closure,hostProof,events:beforeEvents};
}

// Each fixed candidate-change case independently re-reads both real original
// chains and makes its own native refusal. A shared A/B pair is permitted;
// another case's status is never an input and no stage/decision is rewritten.
function candidateEvolution(before,after){
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
  for(const id of Object.keys(record.originals)){assert.deepEqual(await run.read('lifecycle.stage.request.inspect',{stageRequestId:record.originals[id].id}),record.snapshots[id]);time();}
  run.artifact('candidate-drift-host-source-recheck.json',record.hostProof.revalidate());
 }
 for(const item of originalAuthorities){const current=await run.read('lifecycle.authority.inspect',{authorityRef:item.ref});assert.deepEqual(current.decision,item.value.decision);assert.deepEqual(current.revocation,item.value.revocation);time();}
 assert.deepEqual(await driver.events(),events);assert.equal((await run.read('runtime.status')).revision,revision);assert.deepEqual(lifecycleReadbackPlan(run,c,provider),plan);time();
 run.artifact('candidate-drift-full-revalidation.json',{caseInstanceId:c.caseInstanceId,provider,before:before.summary,after:after.summary,...evolution,verificationPolicy:'ALL_NEW_CANDIDATE_REQUIRED_CHECKS_REEXECUTED',newOriginalVerificationRequest:b.request,newOriginalVerificationRun:b.observation,newOriginalVerificationArtifact:b.verified,nativeRefusalRequestId:refusal.body.requestId,adapterErrors:{archive:archiveError,input:inputError},oldHistoryUnchanged:true,originalAuthorityUnchanged:true,priorCasePassLabelConsumed:false,newNativeBusinessWrites:0,newProviderWrites:0});
 return{caseInstanceId:c.caseInstanceId,provider,beforeInstance:before.instance.id,afterInstance:after.instance.id,beforeCandidate:before.instance.candidateDigest,afterCandidate:after.instance.candidateDigest,...evolution,bothOriginalFiveStageVerificationChainsVerified:true,bothOriginalHostRecordsVerified:true,newVerificationRequestId:b.request.requestId,newVerificationRunId:b.observation.runId,oldCandidateNativeRefused:true,unmodifiedOldArchiveRefusedByInstalledAdapter:true,newRequiredChecksAllPassed:true,oldHistoryUnchanged:true,newNativeBusinessWrites:0,newProviderWrites:0,priorCasePassLabelConsumed:false,remainingCasesNotCredited:true};
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
