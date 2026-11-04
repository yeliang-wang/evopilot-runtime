import test from 'node:test';
import assert from 'node:assert/strict';
import {openScenario} from './support.mjs';
import {exactKeys,interruptionFixture,openExecution} from './execution.mjs';

// The three implemented branches consume an explicitly prepared isolated
// service. 01/02 require a genuinely admitted instance with real native scope
// and plan completion, and implementation still PENDING. They create only its
// original external-Agent handoff, never a Host claim/report, CI or Release.
// 05 remains unimplemented until real Host availability evidence is correlated
// with the exact original report and Target version. A null field alone proves
// omission, not unavailability; an actual unsupported or unavailable source can
// qualify without manufacturing a collection failure.
// 06 rejects an unsupported exact token cap through the native preview schema;
// it does not add token-budget semantics to Runtime's reporting addendum.
//
// interruptionFixture: {ref,sha256} -> runtime-v090-interruption-fixture/v1:
// {schema,candidateDigest,workspaceId,projectId,syntheticAssets:true,
//  syntheticDecisions:true,casePlans:{[fixedCaseId]:plan}}.
// 01/02 plan={instanceId,allowServiceRestart:true}; use distinct instances.
// 06 plan={instanceId,targetVersion}.
// A fixture is selection, never a supplied expected outcome or new authority.
const unsupported={
 'E13.journey':'Full original Host, provider-channel interruption, cancellation and managed-action budget journey is not yet implemented.',
 'E13.variant.03':'Requires original native owner one-sided success and recovery without redispatch.',
 'E13.variant.04':'Requires actual test-channel response loss and independent original provider readback.',
 'E13.variant.05':'Requires original real Host availability evidence correlated with the exact report, task and Target version; measurement:null alone does not prove that metrics were unavailable.',
 'E13.variant.07':'Requires a new actual two-client MC04 closure; another scenario result is not an alias.',
 'E13.MC04':'Requires a new actual two-client MC04 closure and postcommit response loss.',
 'E13.CV03':'Requires the full original eight-stage admission and supported measured-budget matrix; one fixed loop is not a fabricated exhausted-loop result.',
 'E13.CV04':'No reproducible installed-service transaction-middle fault point is selected; a socket abort is not transaction interruption.',
 'E13.CV05':'Requires actual Host exit/reentry and exact authority recovery conversation.'
};
const slug=value=>assert(typeof value==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(value));
async function noReceipt(run,id){const result=await run.request('runtime.receipt.read',{requestId:id});assert.equal(result.status,404);assert.equal(result.body.error?.code,'NOT_FOUND');}
async function usage(run,targetVersion,instanceId){
 assert(typeof targetVersion==='string'&&targetVersion.length>0&&targetVersion.length<=256);
 const result=await run.read('usage.report.read',{targetVersion,instanceId,stageId:'implementation',format:'markdown'}),report=result.report;
 assert.equal(report.projectId,run.selection.projectId);assert.equal(report.instanceId,instanceId);assert.equal(report.stageId,'implementation');assert.equal(report.coverage,'REGISTERED_SOURCES_ONLY');assert.equal(report.completeVersionTotal,false);
 if(report.records===0){for(const count of Object.values(report.counts))assert.equal(count.recorded,null);assert.match(result.markdown,/未知/);}
 assert.match(result.markdown,/不代表整个版本的完整总量/);return result;
}
async function interruption(run,driver,c,plan){
 exactKeys(plan,['instanceId','allowServiceRestart']);slug(plan.instanceId);assert.equal(plan.allowServiceRestart,true);
 const before=await driver.instance(plan.instanceId),saved=before.instance;
 for(const stage of ['scope','plan'])assert.equal(saved.stages[stage].status,'PASSED','Use actual native prerequisite completion; no synthetic stage outcomes');
 const originalPreparations={};for(const stage of ['scope','plan'])originalPreparations[stage]=await run.read('lifecycle.'+stage+'.evidence.read',{stageRequestId:saved.stages[stage].requestId});
 assert.equal(saved.stages.implementation.status,'PENDING');assert.equal(saved.stages.implementation.attempts,0);assert.equal(saved.stages.implementation.requestId,null);
 const admission=await run.read('lifecycle.stage.admission',{instanceId:saved.id,stageId:'implementation'});assert.equal(admission.allowed,true);assert.equal(admission.executionDispatched,false);
 const baselineEvents=await driver.events(),view=await run.read('lifecycle.definition.inspect'),status=await run.read('runtime.status');
 const requestId=run.requestId(c.caseInstanceId,'original-implementation'),input={instanceId:saved.id,stageId:'implementation'},envelope={operation:'lifecycle.stage.request',projectId:run.selection.projectId,input,requestId,expectedRevision:status.revision};
 await noReceipt(run,requestId);
 const point=c.caseInstanceId.endsWith('.01')?'BEFORE_COMPLETE_REQUEST_BODY':'AFTER_RESPONSE_HEADERS_BEFORE_BODY';
 const fault=await driver.interrupt(envelope,point);
 let receipt;
 if(point==='BEFORE_COMPLETE_REQUEST_BODY'){
  await noReceipt(run,requestId);assert.deepEqual((await driver.instance(saved.id)).instance,saved);assert.equal((await run.read('runtime.status')).revision,status.revision);
  const committed=await run.request(envelope.operation,input,{requestId,expectedRevision:envelope.expectedRevision});assert.equal(committed.status,200);receipt=committed.body.result;
 }else receipt=await run.read('runtime.receipt.read',{requestId});
 assert.equal(receipt.operation,envelope.operation);assert.equal(receipt.requestId,requestId);assert.equal(receipt.result.status,'REQUEST_RETAINED');assert.equal(receipt.result.automaticRedispatch,false);
 const stageRequestId=receipt.result.stageRequestId,waiting=await driver.until(stageRequestId,value=>value.progress.phase==='WAITING_AGENT','original external Host handoff');
 assert.equal(waiting.request.stageId,'implementation');assert.equal(waiting.request.instanceId,saved.id);assert.equal(waiting.instance.pinsDigest,saved.pinsDigest);assert.equal(waiting.instance.stages.implementation.attempts,1);
 const handoff=await run.read('lifecycle.agent.handoff.read',{stageRequestId});assert.equal(handoff.handoff.runtimeStartsAgent,false);assert.equal(handoff.handoff.releaseAuthorized,false);assert.equal(handoff.claim,null);assert.equal(handoff.latestReport,null);driver.intact(handoff.handoff);
 const replay=await run.request(envelope.operation,input,{requestId,expectedRevision:envelope.expectedRevision});assert.equal(replay.status,200);assert.deepEqual(replay.body.result,receipt);
 const conflict=await run.request(envelope.operation,{...input,stageId:'candidate'},{requestId,expectedRevision:envelope.expectedRevision});assert.equal(conflict.status,409);assert.equal(conflict.body.error?.code,'REQUEST_CONFLICT');
 const duplicateId=run.requestId(c.caseInstanceId,'duplicate-stage'),duplicateStatus=await run.read('runtime.status');
 const duplicate=await run.request(envelope.operation,input,{requestId:duplicateId,expectedRevision:duplicateStatus.revision});assert.equal(duplicate.status,409);assert.equal(duplicate.body.error?.code,'STAGE_BLOCKED');assert.match(duplicate.body.error.message,/RECONCILE_ORIGINAL_REQUEST/);await noReceipt(run,duplicateId);
 // The exact original grant pins one instance and one loopRef. Prove it cannot
 // create a second instance; do not invent a loop counter or exhaustion reason.
 const authority=await run.read('lifecycle.authority.inspect',{authorityRef:waiting.request.authorityRef});assert.equal(authority.usable,true);assert.equal(authority.decision.subject.instanceId,saved.id);assert.equal(authority.decision.subject.loopRef,saved.pins.loopRef);
 const otherId=run.requestId(c.caseInstanceId,'other-instance'),otherRequest=run.requestId(c.caseInstanceId,'reuse-grant'),prior=await run.read('runtime.status');
 const rejected=await run.request('lifecycle.instance.create',{instanceId:otherId,definitionRevisionId:saved.pins.definitionRevisionId,authorityRef:waiting.request.authorityRef},{requestId:otherRequest,expectedRevision:prior.revision});
 assert.equal(rejected.status,400);assert.equal(rejected.body.error?.code,'AUTHORITY_MISMATCH');await noReceipt(run,otherRequest);
 const absent=await run.request('lifecycle.instance.inspect',{instanceId:otherId});assert.equal(absent.status,404);assert.equal(absent.body.error?.code,'NOT_FOUND');
 await driver.restart();
 const recovered=await driver.until(stageRequestId,value=>value.progress.phase==='WAITING_AGENT','original handoff after native service restart');
 assert.deepEqual(recovered.request,waiting.request);assert.equal(recovered.instance.pinsDigest,saved.pinsDigest);assert.equal(recovered.instance.pins.loopRef,saved.pins.loopRef);assert.equal(recovered.instance.stages.implementation.attempts,1);
 assert.deepEqual(await run.read('runtime.receipt.read',{requestId}),receipt);assert.deepEqual(await run.read('lifecycle.agent.handoff.read',{stageRequestId}),handoff);
 for(const stage of ['scope','plan'])assert.deepEqual(await run.read('lifecycle.'+stage+'.evidence.read',{stageRequestId:saved.stages[stage].requestId}),originalPreparations[stage]);
 const finalView=await run.read('lifecycle.definition.inspect');assert.deepEqual(finalView.active,view.active);assert.deepEqual(finalView.draft,view.draft);
 const afterEvents=await driver.events();assert.deepEqual(afterEvents.slice(0,baselineEvents.length),baselineEvents);
 const added=afterEvents.slice(baselineEvents.length),requested=added.filter(e=>e.type==='stage-requested'),retained=added.filter(e=>e.type==='agent-handoff-retained');
 assert.equal(requested.length,1);assert.equal(requested[0].data.stageRequestId,stageRequestId);assert.equal(retained.length,1);assert.equal(retained[0].data.stageRequestId,stageRequestId);assert.equal(retained[0].data.startsAgent,false);
 assert(!added.some(e=>['lifecycle-instance-created','agent-claimed','agent-reported','stage-advance-requested'].includes(e.type)),'Recovery cannot create an extra instance, Host result or continuation');
 run.artifact('interruption-original-summary.json',{fault,requestId,receipt,stageRequestId,pinsDigest:saved.pinsDigest,loopRef:saved.pins.loopRef,addedEvents:added,originalPreparationEvidenceUnchanged:true,hostReportSubmitted:false,providerCallsMeasured:false,actualBusinessRunCountClaim:null});
 return{faultPoint:point,originalRequestId:requestId,stageRequestId,originalReceiptRecovered:true,sameKeySameResult:true,sameKeyChangedContentRejected:true,differentKeyDuplicateStageRejected:true,nativeServiceRestart:true,originalHandoffRecovered:true,stageAdmissionEvents:requested.length,handoffEvents:retained.length,implementationAttempts:1,grantCannotCreateSecondInstance:true,pinnedMaxLoops:saved.pins.budget.maxLoops,loopBudgetSemantics:'EXACT_SINGLE_LOOP_PIN_AND_NO_DUPLICATE_ADMISSION',runtimeStartedAgent:false,hostReportSubmitted:false,fullJourneyNotCredited:true};
}
async function unsupportedLimit(run,driver,c,plan){
 exactKeys(plan,['instanceId','targetVersion']);slug(plan.instanceId);
 const before=await driver.instance(plan.instanceId),view=await run.read('lifecycle.definition.inspect');assert.equal(view.active.id,before.instance.pins.definitionRevisionId);
 const report=await usage(run,plan.targetVersion,plan.instanceId),status=await run.read('runtime.status'),pins=before.instance.pins;
 assert.equal(report.report.counts.total.recorded,null,'This branch requires genuinely unavailable exact usage, not a fabricated zero or a known metered total');
 const subject={instanceId:run.requestId(c.caseInstanceId,'unsupported-token-limit'),definitionRevisionId:pins.definitionRevisionId,goalRef:pins.goalRef,targetRef:pins.targetRef,loopRef:pins.loopRef,budget:{...pins.budget,maxTokens:1},expiresAt:new Date(Date.now()+30000).toISOString()};
 const rejected=await run.request('lifecycle.authority.preview',{kind:'execution',subject});assert.equal(rejected.status,400);assert.equal(rejected.body.error?.code,'INVALID_FIELDS','An unsupported exact usage limit must not silently become an unenforced authority');
 const after=await run.read('runtime.status');assert.equal(after.revision,status.revision);assert.deepEqual((await driver.instance(plan.instanceId)).instance,before.instance);
 const absent=await run.request('lifecycle.instance.inspect',{instanceId:subject.instanceId});assert.equal(absent.status,404);assert.equal(absent.body.error?.code,'NOT_FOUND');
 await usage(run,plan.targetVersion,plan.instanceId);
 return{unsupportedConstraint:'budget.maxTokens',requestedLimit:1,nativeRejection:rejected.body.error.code,authorityGranted:false,executionDispatched:false,existingInstanceUnchanged:true,normalReadbackStillAvailable:true,usageCoverage:report.report.coverage,newBudgetEngine:false,unknownUsageTreatedAsZero:false};
}

test('E13 installed interruption and truthful unavailable measurement branches',{timeout:240000},async t=>{
 const captured=await openScenario('E13'),run={...captured};
 // A bounded request already in flight retains its original response through
 // support. If the test was aborted meanwhile, stop before issuing any next
 // read/write; never interpret cancellation as permission to replay.
 for(const method of ['request','read'])run[method]=async(...args)=>{t.signal.throwIfAborted();const value=await captured[method](...args);t.signal.throwIfAborted();return value;};
 try{
  const fixture=interruptionFixture(run),driver=await openExecution(run,t.signal),used=new Set();
  for(const c of run.cases)await run.collect(c,async()=>{
   if(unsupported[c.caseInstanceId])throw Error('UNIMPLEMENTED_ORIGINAL_CASE: '+unsupported[c.caseInstanceId]);
   const plan=fixture.casePlans[c.caseInstanceId];assert(plan,'A fixed case requires its exact native fixture selection');
   if(['E13.variant.01','E13.variant.02'].includes(c.caseInstanceId)){assert(!used.has(plan.instanceId),'Interruption cases require independent original instances');used.add(plan.instanceId);return interruption(run,driver,c,plan);}
   if(c.caseInstanceId==='E13.variant.06')return unsupportedLimit(run,driver,c,plan);
   throw Error('UNIMPLEMENTED_ORIGINAL_CASE: '+c.caseInstanceId);
  });
 }finally{run.finish();}
});
