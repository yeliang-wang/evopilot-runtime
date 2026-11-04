// Exact installed scope refusals, original feedback continuation, and asset
// version evolution. Only variant.04 creates one explicit synthetic execution
// decision and runs scope/plan for its new binding. No branch publishes assets,
// invokes a coding Agent/CI, fabricates provider results, or seeds a database.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseDocument} from 'yaml';
import {collectCaseCampaign,caseCampaignTestOptions,openScenario,sha} from './support.mjs';
import {chromium,expect} from '@playwright/test';
import {openBrowser} from './browser.mjs';

const owners=['ontology','harness'];
const unsupported={
 'E16.journey':'Actual native owner validation failures, one-owner recovery, independent feedback readback and complete original execution evidence remain required.',
 'E16.variant.01':'An actual unknown owner response and original-request recovery without redispatch are required.',
 'E16.CV06':'Actual published-owner REUSE and DELIVER decisions, exact references and valid/invalid evidence reuse are required.',
};
const changed=(source,keys,value,label)=>{const doc=parseDocument(source);assert.equal(doc.errors.length,0);doc.setIn(keys,value);return doc.toString({lineWidth:0})+'# E16 isolated scope refusal '+label+'\n';};
function issue(result,code,field){
 assert.equal(result.ready,false);assert.equal(result.validationDigest,null);
 assert(Array.isArray(result.issues));
 const exact=result.issues.filter(x=>x.code===code&&x.path===field);
 assert(exact.length,'Expected the native scoped diagnostic at '+field+', not a timeout or unrelated dependency failure');
 assert(exact.every(x=>typeof x.rule==='string'&&x.rule&&typeof x.remedy==='string'&&x.remedy));
 assert(!result.issues.some(x=>['BINDINGS_UNKNOWN','BINDINGS_UNAVAILABLE','BINDINGS_INCOMPLETE','BINDINGS_INVALID'].includes(x.code)),'An unavailable dependency cannot stand in for a scope refusal');
 return exact;
}
function forbidden(response){
 assert.equal(response.status,403);assert.equal(response.body?.error?.code,'FORBIDDEN');
 assert(!Object.hasOwn(response.body,'result'),'An unauthorized scope must not return successful project state');
 return{status:response.status,code:response.body.error.code};
}

// Discover original instances through the public immutable event inventory.
// This avoids accepting an unpinned private fixture result or reading SQLite.
// The existing performance fixture has >10000 events, so pagination is explicit.
async function events(run,startCursor){
 const rows=[];let cursor=startCursor,last=0;
 for(let page=0;page<501;page++){
  const value=await run.read('runtime.events.read',cursor?{cursor}:{});
  assert(Array.isArray(value.events)&&value.events.length<=50);assert.equal(typeof value.cursor,'string');
  for(const event of value.events){assert(Number.isSafeInteger(event.seq)&&event.seq>last);last=event.seq;rows.push(event);assert(rows.length<=25000,'Select a bounded isolated scope fixture');}
  if(value.events.length===0)return{rows,cursor:value.cursor};
  assert.notEqual(value.cursor,cursor);cursor=value.cursor;
 }
 assert.fail('E16_EVENT_INVENTORY_LIMIT: preserve the attempt; do not assume a truncated inventory is complete');
}

// This variant deliberately needs no unprotected fixture JSON. The selection
// must name this one case and the real service must have exactly one eligible
// closure. All identifiers are discovered, pinned and retained before effects.
async function duplicateFeedback(run,c){
 assert.deepEqual(run.selection.caseIds,['E16.variant.02'],'Select the active-closure duplicate case independently of inert scope probes');
 assert.equal(run.cases.length,1);
 assert(run.principal().expectedPermissions.includes('execution.request'));
 const started=Date.now(),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));let deadline=started+600000;
 const time=()=>assert(Date.now()<deadline,'E16 duplicate feedback observation deadline exhausted; preserve the original request');
 const installed=path.join(run.selection.installedRoot,'package');
 const [configApi,control,ownerApi,feedbackApi]=await Promise.all([
  import(pathToFileURL(path.join(installed,'dist/adapters/config.js')).href),
  import(pathToFileURL(path.join(installed,'dist/installation/service-control.js')).href),
  import(pathToFileURL(path.join(installed,'dist/adapters/published-owners.js')).href),
  import(pathToFileURL(path.join(installed,'dist/adapters/feedback.js')).href),
 ]);
 const selection=control.inspectInstalledServiceSelection(run.selection.installedRoot);
 assert.equal(selection.workspaceId,run.selection.workspaceId);assert.equal(selection.distributionManifestDigest,run.selection.expectedManifestDigest);
 const service=async operation=>{time();try{const result=await control.operateInstalledService(selection,operation);run.artifact('duplicate-feedback-service.json',{operation,result});return result;}catch(error){run.artifact('duplicate-feedback-service-error.json',{operation,code:error.code??null,message:error.message,retry:false});throw error;}};
 const initialService=await service('inspect');assert.equal(initialService.service.running,true);assert.equal(initialService.service.identity.serviceId,selection.serviceId);
 const spec=JSON.parse(fs.readFileSync(path.join(run.selection.installedRoot,'service-specification.json')));assert(spec.integrationsRef);
 const configBytes=fs.readFileSync(spec.integrationsRef),config=configApi.readIntegrationConfiguration(spec.integrationsRef,run.selection.workspaceId);
 const originalDefinition=await run.read('lifecycle.definition.inspect');assert(originalDefinition.active);
 const originalSource=await run.source(originalDefinition.active.id),originalRevision=await run.read('lifecycle.definition.read',{revisionId:originalDefinition.active.id});
 const inventory=await events(run),ids=[...new Set(inventory.rows.filter(e=>e.type==='lifecycle-instance-created').map(e=>e.data.instanceId))];
 assert(ids.length>0&&ids.length<=128,'Use a bounded isolated native instance inventory');
 const originals=[];for(const instanceId of ids){time();originals.push((await run.read('lifecycle.instance.inspect',{instanceId})).instance);}
 const eligible=[];
 for(const instance of originals){
  if(instance.stages.closure?.status!=='RUNNING'||!instance.stages.closure.requestId)continue;
  const stage=await run.read('lifecycle.stage.request.inspect',{stageRequestId:instance.stages.closure.requestId});
  const closure=await run.read('lifecycle.closure.evidence.read',{stageRequestId:stage.request.id}),facts=closure.evidence;
  if(!stage.progress.terminal&&stage.progress.phase==='RUNNING'&&facts?.smoke?.status==='PASSED'&&facts.distribution?.status==='PASSED'&&facts.harness?.status==='PASS'&&owners.every(o=>facts.feedback?.[o]?.status==='REVIEW_REQUIRED'))eligible.push({instance,stage,closure});
 }
 assert.equal(eligible.length,1,'Exactly one native active closure with real delivery/Harness PASS and both owners REVIEW_REQUIRED is required; zero/multiple/terminal states cannot substitute');
 const {instance,stage,closure}=eligible[0],stageId=stage.request.id;
 assert.equal(stage.request.plan.action,'base.closure');assert.equal(stage.request.initiatedBy.id,run.principal().principalId);
 assert.equal(stage.workerError,null);assert.equal(instance.pins.definitionRevisionId,originalDefinition.active.id);
 assert.equal(stage.request.projectId,run.selection.projectId);assert.equal(stage.request.workspaceId,run.selection.workspaceId);
 const originalAuthority=await run.read('lifecycle.authority.inspect',{authorityRef:stage.request.authorityRef});
 assert.equal(originalAuthority.usable,true);assert.equal(originalAuthority.reason,null);assert.equal(originalAuthority.revocation,null);
 assert.equal(originalAuthority.decision.kind,'execution');assert.equal(originalAuthority.decision.choice,'APPROVE');assert.equal(originalAuthority.decision.subject.instanceId,instance.id);
 const originalLimits=[Date.parse(stage.request.deadlineAt),Date.parse(instance.pins.authorityExpiresAt),Date.parse(originalAuthority.decision.subject.expiresAt),Date.parse(instance.createdAt)+instance.pins.budget.timeoutSeconds*1000];assert(originalLimits.every(Number.isFinite));deadline=Math.min(deadline,...originalLimits);
 assert(deadline-Date.now()>120000,'Select the original still-current authority with enough time for two owner snapshots; never extend it here');
 for(const saved of originals){assert.equal(saved.pins.projectId,run.selection.projectId);if(saved.id!==instance.id)assert(Object.values(saved.stages).every(s=>['PENDING','PASSED','FAILED'].includes(s.status)),'Stopping this dedicated service must not interrupt another active instance');}
 for(const [id,state] of Object.entries(instance.stages))if(id!=='closure')assert.equal(state.status,'PASSED','Only a genuine completed predecessor chain can qualify');
 const feedback=await run.read('lifecycle.verification.feedback.read',{stageRequestId:instance.stages.verification.requestId}),event=feedback.event;
 assert.equal(event.origin,'registered-runtime-run');assert.equal(event.stage,'SUCCEEDED');assert.equal(event.projectCandidateDigest,instance.candidateDigest);
 assert.deepEqual(event.scope,{visibility:'private',projectId:run.selection.projectId});assert.equal(event.workspaceId,run.selection.workspaceId);
 assert.equal(stage.request.plan.parameters.feedbackEventId,event.id);assert.equal(stage.request.plan.parameters.feedbackEventDigest,event.digest);
 assert.equal(stage.request.plan.parameters.verificationRequestId,instance.stages.verification.requestId);
 const registrations={};
 for(const owner of owners){
  const selected=instance.definition.semantic.assets[owner],mapping=config.resources.find(r=>r.ref===selected.mappingRef&&r.projectId===run.selection.projectId&&r.role==='assets.'+owner+'.mappingRef');
  assert(mapping&&mapping.definition.evidenceOrigin==='SYNTHETIC','Use already-published isolated synthetic assets, never daily project assets');
  assert.equal(mapping.definition.reference.product,owner);assert.equal(mapping.definition.reference.digest,selected.digest);
  assert.deepEqual(event.pins[owner],mapping.definition.reference);
  const matches=config.owners.filter(o=>o.ref===selected.adapterRef&&o.owner===owner&&o.workspaceId===run.selection.workspaceId&&o.projects.includes(run.selection.projectId));assert.equal(matches.length,1);
  registrations[owner]=matches[0];ownerApi.verifyOwnerDistribution(owner,matches[0].packageRoot);
  for(const suffix of ['workspace.json',path.join('state',owner,owner+'.db')]){const stat=fs.lstatSync(path.join(matches[0].workspaceRoot,suffix));assert(stat.isFile()&&!stat.isSymbolicLink(),'Only existing initialized published-owner workspaces may be opened');}
  for(const kind of ['owner-feedback-delivery','owner-feedback-inbox','owner-feedback-observation']){
   const rows=inventory.rows.filter(e=>e.type==='owner-feedback-observed'&&e.data.kind===kind&&e.data.id===event.id+':'+owner);
   if(kind==='owner-feedback-delivery')assert.equal(rows.length,1,'Retain one original '+owner+' delivery request');
   else assert(rows.length>0,'Retain the actual '+owner+' inbox/observation history, including initial PENDING observations');
  }
 }
 const checkClosure=value=>{
  assert.equal(value.evidence.requestDigest,stage.request.digest);assert.equal(value.evidence.candidateDigest,instance.candidateDigest);
  assert.equal(value.evidence.smoke.status,'PASSED');assert.equal(value.evidence.distribution.status,'PASSED');assert.equal(value.evidence.harness.status,'PASS');assert.deepEqual(value.evidence.reasons,[]);
  assert.equal(value.archiveAction,null);assert.equal(value.evidence.archive,null);assert.equal(value.followup,null);assert(value.ciRequest&&value.harness.action&&value.harness.receipt);
  for(const owner of owners){assert.equal(value.evidence.feedback[owner].status,'REVIEW_REQUIRED');assert.equal(value.evidence.feedback[owner].dispositionDigest,null);assert.equal(value.evidence.feedback[owner].softwareRelease,false);}
 };
 checkClosure(closure);
 const readChain=async()=>{
  const requests={};for(const [id,state] of Object.entries(instance.stages)){const current=await run.read('lifecycle.stage.request.inspect',{stageRequestId:state.requestId});assert.equal(current.workerError,null);requests[id]=id==='closure'?current.request:{request:current.request,progress:current.progress};}
  return{requests,agent:await run.read('lifecycle.agent.handoff.read',{stageRequestId:instance.stages.implementation.requestId}),implementation:await run.read('lifecycle.implementation.evidence.read',{stageRequestId:instance.stages.implementation.requestId}),verification:await run.read('lifecycle.verification.feedback.read',{stageRequestId:instance.stages.verification.requestId}),publication:await run.read('lifecycle.publication.evidence.read',{stageRequestId:instance.stages.publication.requestId}),closure:await run.read('lifecycle.closure.evidence.read',{stageRequestId:stageId})};
 };
 const chain=await readChain();assert(chain.agent.claim&&chain.agent.latestReport);assert(chain.implementation.ci?.run&&chain.implementation.ci.artifact);assert(chain.publication.run&&chain.publication.ciRequest);
 assert.deepEqual(chain.closure,closure);
 run.artifact('duplicate-feedback-frozen-precondition.json',{selection,instance,originalAuthority,effectiveDeadlineAt:new Date(deadline).toISOString(),originalInstances:originals,definition:originalDefinition,sourceDigest:sha(originalSource),configurationDigest:sha(configBytes),registrations,event,chain,originalEvents:inventory.rows,singleExistingClosure:true,syntheticAssets:true,newAuthorities:false,ownerDecisions:false});
 let failure,cleanupFailure,completed=false,afterOwners,advanceReceipt;
 const waitIdle=async()=>{
  const until=Math.min(deadline,Date.now()+60000);
  while(Date.now()<until){time();const status=await run.read('runtime.status'),current=await run.read('lifecycle.stage.request.inspect',{stageRequestId:stageId});assert.equal(current.workerError,null);
   if(status.observationWorker.state==='READY'&&status.observationWorker.inFlight===0&&current.progress.phase==='RUNNING'&&!current.progress.terminal)return current;
   assert(!['COMPLETE','FAILED'].includes(current.progress.phase),'Duplicate feedback must neither finish nor fail the original Run');await pause(250);
  }assert.fail('E16_ORIGINAL_CLOSURE_NOT_IDLE: retain the real original stage without redispatch');
 };
 const ownerSnapshot=async label=>{
  await waitIdle();
  const stopped=await service('stop');assert.equal(stopped.service.running,false);assert.equal(stopped.service.registered,false);
  const out={};
  for(const owner of owners){
   time();const registration=registrations[owner],identity=ownerApi.verifyOwnerDistribution(owner,registration.packageRoot);
   const api=await import(pathToFileURL(path.join(registration.packageRoot,'dist/service.js')).href),native=api[owner==='ontology'?'createOntologyService':'createHarnessService']({workspaceRoot:registration.workspaceRoot,workspaceId:registration.workspaceId},{});
   try{
    native.initialize();
    const call=async operation=>{const request={operation,scope:event.scope,input:operation==='feedback.read'?{id:event.id}:{}};const response=await native.feedback(request);run.artifact('duplicate-feedback-owner-native.json',{label,owner,identity,request,response});return response;};
    const state=await call('feedback.inspect'),inbox=await call('feedback.read'),list=await call('feedback.list');
    assert(Number.isSafeInteger(state.revision)&&state.revision>0);assert.equal(state.owner,owner);assert.equal(state.workspaceId,run.selection.workspaceId);assert.deepEqual(state.scope,event.scope);
    assert.equal(feedbackApi.verifyOwnerFeedbackInbox(inbox,event,owner).status,'REVIEW_REQUIRED');assert.equal(inbox.review,null);assert.equal(inbox.disposition,null);
    assert.equal(inbox.receipt.digest,closure.evidence.feedback[owner].receiptDigest);assert.equal(inbox.candidate.status,'REVIEW_REQUIRED');assert.equal(list.filter(x=>x.event.id===event.id).length,1);
    out[owner]={identity,state,inbox,list};
   }finally{native.close();}
  }
  const startedService=await service('start');assert.equal(startedService.service.running,true);await waitIdle();return out;
 };
 try{
  const beforeOwners=await ownerSnapshot('before-duplicate');
  assert.deepEqual(await readChain(),chain,'Native service recovery is observation only; it must preserve original CI, claims, feedback and receipts');
  const beforeAdvance=await events(run);
  const requestId=run.requestId(c.caseInstanceId,'repeat-original-closure');
  for(let attempt=0;attempt<20;attempt++){
   time();await waitIdle();
   const authority=await run.read('lifecycle.authority.inspect',{authorityRef:stage.request.authorityRef});time();assert.equal(authority.usable,true,'Original authority must still be usable immediately before every continuation attempt');assert.equal(authority.reason,null);assert.equal(authority.revocation,null);assert.deepEqual(authority.decision,originalAuthority.decision,'Do not replace or extend the original authority');
   const current=await run.read('runtime.status');time();
   const result=await run.request('lifecycle.stage.advance',{stageRequestId:stageId},{requestId,expectedRevision:current.revision});
   if(result.status===200){advanceReceipt=result.body.result;break;}
   // These are definite pre-effect refusals. Keep the exact original key/input;
   // an unknown transport outcome, new authority or other refusal ends the case.
   assert(['EXECUTOR_BUSY','REVISION_CONFLICT'].includes(result.body.error?.code),JSON.stringify(result.body));await pause(250);
  }
  assert(advanceReceipt,'Original duplicate continuation never acquired the bounded worker');
  assert.equal(advanceReceipt.requestId,requestId);assert.equal(advanceReceipt.result.stageRequestId,stageId);assert.equal(advanceReceipt.result.status,'ADVANCE_REQUESTED');assert.equal(advanceReceipt.result.newAttempt,false);
  assert.deepEqual(await run.read('runtime.receipt.read',{requestId}),advanceReceipt);await waitIdle();
  const repeated=await readChain();checkClosure(repeated.closure);assert.deepEqual(repeated,chain,'No original CI request/result, Agent claim/report, candidate, feedback or Harness action/receipt may change');
  const duplicateTail=await events(run,beforeAdvance.cursor);assert.equal(duplicateTail.rows.length,1,'Duplicate delivery must retain exactly the continuation receipt/event; changed facts or an unknown observation cannot be hidden');
  assert.equal(duplicateTail.rows[0].type,'stage-advance-requested');assert.equal(duplicateTail.rows[0].data.stageRequestId,stageId);assert.equal(duplicateTail.rows[0].data.newAttempt,false);
  afterOwners=await ownerSnapshot('after-duplicate');assert.deepEqual(afterOwners,beforeOwners,'Both published owners must retain the same complete inbox/event/receipt/candidate/list and feedback revision');
  assert.deepEqual(await readChain(),chain);
  for(const original of originals)assert.deepEqual((await run.read('lifecycle.instance.inspect',{instanceId:original.id})).instance,original,'Original instance pins, attempts, request IDs and complete outcomes must remain identical');
  assert.deepEqual(await run.read('lifecycle.definition.read',{revisionId:originalRevision.id??originalDefinition.active.id}),originalRevision);assert.equal(await run.source(originalDefinition.active.id),originalSource);
  const latestDefinition=await run.read('lifecycle.definition.inspect');assert.deepEqual(latestDefinition.active,originalDefinition.active);assert.deepEqual(latestDefinition.draft,originalDefinition.draft);
  assert.deepEqual(fs.readFileSync(spec.integrationsRef),configBytes);assert.deepEqual(control.inspectInstalledServiceSelection(run.selection.installedRoot),selection);
  const finalEvents=await events(run);assert.deepEqual(finalEvents.rows.slice(0,inventory.rows.length),inventory.rows,'Original audit events cannot be rewritten');
  const added=finalEvents.rows.slice(inventory.rows.length);
  for(const item of added){assert(['stage-observed','stage-advance-requested'].includes(item.type),'No new owner dispatch, CI, Agent, authority, candidate or business stage event is allowed');assert.equal(item.data.stageRequestId,stageId);if(item.type==='stage-observed')assert(item.data.phase==='RUNNING'&&item.data.reason===null||item.data.phase==='UNKNOWN'&&item.data.reason==='SERVICE_RESTART_RECONCILE','Only explicit native restart recovery observations are allowed');}
  assert.equal(added.filter(x=>x.type==='stage-advance-requested').length,1);
  run.artifact('duplicate-feedback-independent-comparison.json',{beforeOwners,afterOwners,advanceReceipt,addedEvents:added,originalInstanceCount:originals.length,chain,elapsedMs:Date.now()-started,softwareAcceptanceClaimed:false,l3GradeClaimed:false,ownerDecisionRecorded:false});completed=true;
 }catch(error){failure=error;}
 finally{
  // Preserve the caller's actual running state even when a read/assertion fails.
  // Do not rerun installer plans or infer that a failed stop has succeeded.
  try{let observed=await control.operateInstalledService(selection,'inspect');run.artifact('duplicate-feedback-final-service-observation.json',observed);if(!observed.service.running){const restored=await control.operateInstalledService(selection,'start');run.artifact('duplicate-feedback-final-service-restore.json',restored);observed=await control.operateInstalledService(selection,'inspect');run.artifact('duplicate-feedback-restored-service-observation.json',observed);}assert.equal(observed.service.running,true);assert.equal(observed.service.identity.serviceId,selection.serviceId);}
  catch(error){cleanupFailure=error;run.artifact('duplicate-feedback-cleanup-failure.json',{code:error.code??null,message:error.message,automaticRetry:false});}
 }
 if(failure&&cleanupFailure)throw new AggregateError([failure,cleanupFailure],'Duplicate feedback failed and original service-state restoration also failed');if(failure)throw failure;if(cleanupFailure)throw cleanupFailure;assert(completed);
 return{actualInstalledHttp:true,candidateDigest:run.candidateDigest,existingInstanceId:instance.id,originalClosureRequestId:stageId,originalFeedbackEventId:event.id,duplicateNativeAdvance:advanceReceipt.requestId,originalCIAndAgentEvidenceUnchanged:true,originalStageAttemptsAndRequestIdsUnchanged:true,ownerSnapshotsIndependent:true,ownerFeedbackRevisions:Object.fromEntries(owners.map(o=>[o,afterOwners[o].state.revision])),exactOwnerReceiptDigests:Object.fromEntries(owners.map(o=>[o,afterOwners[o].inbox.receipt.digest])),newBusinessStages:0,newOwnerWrites:0,newCiDispatches:0,newAgentClaims:0,newAuthorityOrDecisions:0,originalRunningServiceRestored:true,softwareAcceptanceClaimed:false,l3GradeClaimed:false};
}

async function scopeMismatch(run,c){
 const status=await run.read('runtime.status');assert.equal(status.observationWorker.inFlight,0);assert.equal(status.observationWorker.state,'READY');
 assert(run.principal().expectedPermissions.includes('definition.activate'),'Use the isolated activator/operator, not a permission failure as an asset-scope refusal');
 const before=await run.read('lifecycle.definition.inspect');assert(before.active,'Select an existing natively activated isolated project');
 const source=await run.source(before.active.id),originalRevision=await run.read('lifecycle.definition.read',{revisionId:before.active.id});
 const originalDraft=before.draft?await run.read('lifecycle.definition.read',{revisionId:before.draft.id}):null;
 const originalDraftSource=before.draft?await run.source(before.draft.id):null;
 const baseline=await run.read('lifecycle.definition.validate',{yaml:source});assert.equal(baseline.ready,true,JSON.stringify(baseline.issues));assert.equal(baseline.compilation.valid,true);assert.equal(baseline.bindings.ready,true);
 const effective=baseline.compilation.effective;assert.equal(effective.projectId,run.selection.projectId);
 for(const owner of owners){
  const asset=effective.semantic.assets[owner];assert.equal(asset.visibility,'private');assert.equal(asset.projectId,run.selection.projectId);
  assert(baseline.bindings.checks.some(x=>x.path==='assets.'+owner&&x.status==='VALID'),'Both exact owner assets must first pass the actual registered readback');
 }
 // Read only the selected installation's operator configuration. Checking its
 // explicit synthetic origin prevents these draft probes targeting daily assets.
 const installed=path.join(run.selection.installedRoot,'package'),configApi=await import(pathToFileURL(path.join(installed,'dist/adapters/config.js')).href);
 const spec=JSON.parse(fs.readFileSync(path.join(run.selection.installedRoot,'service-specification.json')));assert(spec.integrationsRef);
 const configBytes=fs.readFileSync(spec.integrationsRef),config=configApi.readIntegrationConfiguration(spec.integrationsRef,run.selection.workspaceId);
 for(const owner of owners){
  const selected=effective.semantic.assets[owner],mapping=config.resources.find(r=>r.ref===selected.mappingRef&&r.projectId===run.selection.projectId&&r.role==='assets.'+owner+'.mappingRef');
  assert(mapping&&mapping.definition.evidenceOrigin==='SYNTHETIC','Only existing explicitly synthetic owner assets are allowed');
  assert.equal(mapping.definition.reference.product,owner);assert.equal(mapping.definition.reference.digest,selected.digest);
  assert(config.owners.some(o=>o.ref===selected.adapterRef&&o.owner===owner&&o.projects.includes(run.selection.projectId)));
 }
 const inventory=await events(run),created=inventory.rows.filter(e=>e.type==='lifecycle-instance-created');
 const ids=[...new Set(created.map(e=>e.data.instanceId))];assert(ids.length>0&&ids.length<=128,'A bounded existing native PENDING inventory is required');
 const originalInstances=[];
 for(const id of ids){
  const value=(await run.read('lifecycle.instance.inspect',{instanceId:id})).instance;assert.equal(value.id,id);assert.equal(value.pins.projectId,run.selection.projectId);
  assert.deepEqual(value.requestIds,[]);assert(Object.values(value.stages).every(s=>s.status==='PENDING'&&s.attempts===0&&s.requestId===null),'Use inert instances; no concurrent or prior business execution is part of this variant');
  originalInstances.push(value);
 }
 assert.deepEqual(await run.read('lifecycle.definition.inspect'),before,'The scope fixture must be quiescent before collection');
 run.artifact('scope-existing-state.json',{activeRevisionId:before.active.id,draftRevisionId:before.draft?.id??null,revision:before.revision,instancePins:originalInstances.map(i=>({id:i.id,pinsDigest:i.pinsDigest,definitionRevisionId:i.pins.definitionRevisionId,authorityExpiresAt:i.pins.authorityExpiresAt})),originalEventCount:inventory.rows.length,originalEventDigest:sha(JSON.stringify(inventory.rows)),ownerAssets:effective.semantic.assets,configurationDigest:sha(configBytes),syntheticAssets:true,existingAuthorityUsedForExecution:false,expiredGrantsNotExtended:true});

 const foreign='e16-foreign-'+sha(run.selection.runId).slice(0,16);assert.notEqual(foreign,run.selection.projectId);
 const crossRequests=[
  ['lifecycle.definition.inspect',{},false],
  ['runtime.events.read',{cursor:inventory.cursor},false],
  ['lifecycle.instance.inspect',{instanceId:ids[0]},false],
  ['lifecycle.draft.save',{yaml:source},true],
  ['lifecycle.stage.request',{instanceId:ids[0],stageId:'scope'},true],
 ];
 const cross=[];
 for(let index=0;index<crossRequests.length;index++){
  const [operation,input,write]=crossRequests[index],meta={projectId:foreign,...(write?{requestId:run.requestId(c.caseInstanceId,'foreign-'+index),expectedRevision:before.revision}:{})};
  const response=await run.request(operation,input,meta);cross.push({operation,...forbidden(response)});
  assert.deepEqual(await run.read('lifecycle.definition.inspect'),before,'An HTTP scope refusal cannot write a draft or event');
 }
 const cases=[{name:'yaml-project',field:'projectId',keys:['projectId'],value:foreign,structural:false,code:'PROJECT_SCOPE'}];
 for(const owner of owners){const other=owner==='ontology'?'harness':'ontology';cases.push(
  {name:owner+'-private-project',field:'assets.'+owner+'.projectId',keys:['assets',owner,'projectId'],value:foreign,structural:false,code:'ASSET_SCOPE'},
  {name:owner+'-visibility',field:'assets.'+owner,keys:['assets',owner,'visibility'],value:'public',structural:true,code:'BINDING_NOT_READY'},
  {name:owner+'-adapter-owner',field:'assets.'+owner,keys:['assets',owner,'adapterRef'],value:effective.semantic.assets[other].adapterRef,structural:true,code:'BINDING_NOT_READY'},
 );}
 const refusals=[];let revision=before.revision;
 for(const selected of cases){
  const yaml=changed(source,selected.keys,selected.value,run.selection.runId+' '+selected.name),preview=await run.read('lifecycle.definition.validate',{yaml});
  assert.equal(preview.compilation.valid,selected.structural);const diagnostics=issue(preview,selected.code,selected.field);
  const requestId=run.requestId(c.caseInstanceId,selected.name),response=await run.request('lifecycle.definition.save-and-activate',{yaml,validationDigest:preview.validationDigest},{requestId,expectedRevision:revision});
  assert.equal(response.status,200);const receipt=response.body.result;assert.equal(receipt.requestId,requestId);assert.equal(receipt.revision,++revision);
  assert.equal(receipt.result.status,'BLOCKED');assert.equal(receipt.result.activeRevisionId,before.active.id);assert.equal(receipt.result.executionAuthorized,false);assert.equal(receipt.result.releaseAuthorized,false);
  assert(receipt.result.issues.some(x=>x.code===selected.code&&x.path===selected.field),'The original native commit must retain the same actual scope refusal');
  assert.deepEqual(await run.read('runtime.receipt.read',{requestId}),receipt);
  const after=await run.read('lifecycle.definition.inspect');assert.equal(after.revision,revision);assert.deepEqual(after.active,before.active);assert.equal(await run.source(after.draft.id),yaml);
  refusals.push({name:selected.name,field:selected.field,diagnostics,requestId,revision:receipt.revision,draftRevisionId:after.draft.id,nativeStatus:'BLOCKED',activeRevisionId:after.active.id});
 }
 // Repair the test draft with a distinct source revision so no original
 // immutable definition record is rewritten. Validation does not activate it
 // or re-authorize the existing instance's expired execution grant.
 const repair=source+'\n# E16 repaired scope draft '+run.selection.runId+'\n',repairPreview=await run.read('lifecycle.definition.validate',{yaml:repair});
 assert.equal(repairPreview.ready,true,JSON.stringify(repairPreview.issues));assert.equal(repairPreview.compilation.effective.semanticDigest,effective.semanticDigest);
 const repairId=run.requestId(c.caseInstanceId,'repair-draft'),repaired=await run.request('lifecycle.draft.save',{yaml:repair},{requestId:repairId,expectedRevision:revision});
 assert.equal(repaired.status,200);assert.equal(repaired.body.result.requestId,repairId);assert.equal(repaired.body.result.revision,++revision);assert.equal(repaired.body.result.result.status,'DRAFT');assert.equal(repaired.body.result.result.executionAuthorized,false);assert.equal(repaired.body.result.result.releaseAuthorized,false);
 assert.deepEqual(await run.read('runtime.receipt.read',{requestId:repairId}),repaired.body.result);
 const final=await run.read('lifecycle.definition.inspect');assert.equal(final.revision,revision);assert.deepEqual(final.active,before.active);assert.equal(await run.source(final.draft.id),repair);
 assert.equal((await run.read('lifecycle.definition.validate',{yaml:repair})).ready,true);
 assert.deepEqual(await run.read('lifecycle.definition.read',{revisionId:before.active.id}),originalRevision);assert.equal(await run.source(before.active.id),source);
 if(originalDraft){assert.deepEqual(await run.read('lifecycle.definition.read',{revisionId:before.draft.id}),originalDraft);assert.equal(await run.source(before.draft.id),originalDraftSource);}
 for(const original of originalInstances)assert.deepEqual((await run.read('lifecycle.instance.inspect',{instanceId:original.id})).instance,original,'Scope probes cannot change original instance pins, authority or stage state');
 const tail=await events(run,inventory.cursor);assert.equal(tail.rows.length,cases.length+1);assert(tail.rows.every(e=>['definition-activation-blocked','definition-draft-saved'].includes(e.type)));assert.equal(tail.rows.filter(e=>e.type==='definition-activation-blocked').length,cases.length);assert.equal(tail.rows.filter(e=>e.type==='definition-draft-saved').length,1);
 assert.deepEqual(fs.readFileSync(spec.integrationsRef),configBytes,'Scope probes may not repair or replace owner/operator configuration');
 const finalStatus=await run.read('runtime.status');assert.equal(finalStatus.observationWorker.inFlight,0);assert.equal(finalStatus.observationWorker.state,'READY');assert.equal(finalStatus.revision,revision);
 return{actualInstalledHttp:true,candidateDigest:run.candidateDigest,syntheticAssets:true,validOriginalOwnerBindings:owners,crossProjectRefusals:cross,scopeRefusals:refusals,blockedDraftsRetained:true,repairedDraftRevisionId:final.draft.id,originalActiveAndDraftRecordsUnchanged:true,originalInstanceCount:originalInstances.length,originalInstancePinsAndStagesUnchanged:true,newEvents:tail.rows.map(e=>({seq:e.seq,type:e.type,revision:e.revision})),nativeDefinitionMutations:cases.length+1,ownerMutationsRequested:0,businessStagesDispatched:0,authorityCreatedOrExtended:false,expiredAuthorityUsedForAdmission:false,softwareAcceptanceClaimed:false,l3GradeClaimed:false,feedbackRecoveryClaimed:false,remainingIndependentCases:Object.keys(unsupported)};
}

// Two already-published versions and their exact registered mappings are
// fixture inputs. Their labels do not establish acceptance: this branch changes
// the active binding and obtains new, original native owner validation receipts.
async function assetVersionEvolution(run,c){
 assert.deepEqual(run.selection.caseIds,['E16.variant.04'],'Select this bounded synthetic version-evolution case independently');
 for(const permission of ['read','draft.write','definition.activate','decision.record','execution.request'])assert(run.principal().expectedPermissions.includes(permission));
 const deadline=Date.now()+600000,time=()=>assert(Date.now()<deadline,'E16 asset-version observation exceeded 600 seconds; preserve original requests'),pause=ms=>new Promise(r=>setTimeout(r,ms));
 const installed=path.join(run.selection.installedRoot,'package'),load=relative=>import(pathToFileURL(path.join(installed,'dist',relative)).href);
 const [configApi,ownerApi,security,base,instanceApi,native,stagesApi]=await Promise.all([load('adapters/config.js'),load('adapters/published-owners.js'),load('server/security.js'),load('lifecycle/base.js'),load('lifecycle/instance.js'),import(pathToFileURL(path.join(installed,'vendor/compatibility/v1/native.mjs')).href),load('adapters/stages.js')]);
 const spec=JSON.parse(fs.readFileSync(path.join(run.selection.installedRoot,'service-specification.json')));assert(spec.integrationsRef);
 const configBytes=fs.readFileSync(spec.integrationsRef),config=configApi.readIntegrationConfiguration(spec.integrationsRef,run.selection.workspaceId),scope={visibility:'private',projectId:run.selection.projectId};
 const actor=()=>{const p=security.currentPrincipal(path.join(run.selection.installedRoot,'data'),run.selection.workspaceId,run.principal().principalId);assert(p);security.authorize(p,run.selection.projectId,'read');return p;};
 const status=await run.read('runtime.status');assert.equal(status.observationWorker.inFlight,0);assert.equal(status.observationWorker.state,'READY');
 const before=await run.read('lifecycle.definition.inspect');assert(before.active);const originalSource=await run.source(before.active.id),originalDefinition=await run.read('lifecycle.definition.read',{revisionId:before.active.id}),baseline=await run.read('lifecycle.definition.validate',{yaml:originalSource});assert.equal(baseline.ready,true,JSON.stringify(baseline.issues));
 const inventory=await events(run),created=inventory.rows.filter(e=>e.type==='lifecycle-instance-created');assert.equal(created.length,1,'Use exactly one original native Run, not an ambiguous or inert inventory');
 const old=(await run.read('lifecycle.instance.inspect',{instanceId:created[0].data.instanceId})).instance;assert.equal(old.pins.definitionRevisionId,before.active.id);assert.equal(base.isCurrentBase(old.pins.base),true);assert.deepEqual(old.pins.budget,{timeoutSeconds:600,maxAttempts:1,maxConcurrency:1,maxLoops:1});
 for(const [id,state]of Object.entries(old.stages)){if(['scope','plan'].includes(id)){assert.equal(state.status,'PASSED');assert.equal(state.attempts,1);assert(state.requestId);}else{assert.equal(state.status,'PENDING');assert.equal(state.attempts,0);assert.equal(state.requestId,null);}}assert.equal(old.requestIds.length,2);
 const originalPreparation=await run.read('lifecycle.preparation.read',{preparationRef:old.pins.targetRef});assert.equal(originalPreparation.current,true);const oldAuthority=await run.read('lifecycle.authority.inspect',{authorityRef:created[0].data.authorityRef});assert.equal(oldAuthority.decision.subject.instanceId,old.id);assert.deepEqual(oldAuthority.decision.subject.budget,old.pins.budget);
 const oldRefs={},newRefs={},oldMappings={},newMappings={},registrations={};
 const exact=(a,b)=>native.nativeStableSerialize(a)===native.nativeStableSerialize(b);
 const version=v=>{assert(/^\d+\.\d+\.\d+$/.test(v),'Use two explicit numeric fixture versions, never latest or a range');return v.split('.').map(Number);};
 const newer=(a,b)=>{const x=version(a),y=version(b);for(let i=0;i<3;i++){if(x[i]!==y[i])return x[i]>y[i];}return false;};
 for(const owner of owners){
  const selected=old.definition.semantic.assets[owner];assert.equal(selected.visibility,'private');assert.equal(selected.projectId,run.selection.projectId);assert.equal(selected.targetLevel,'L3');
  const matches=config.resources.filter(r=>r.workspaceId===run.selection.workspaceId&&r.projectId===run.selection.projectId&&r.role==='assets.'+owner+'.mappingRef'&&r.definition.kind==='asset-map'&&r.definition.owner===owner&&r.definition.reference.id===selected.id);
  assert.equal(matches.length,2,'Exactly two explicitly configured published fixture versions are required');for(const mapping of matches){assert.equal(mapping.definition.evidenceOrigin,'SYNTHETIC');assert(Date.parse(mapping.expiresAt)>Date.now());native.validateNativeReference(mapping.definition.reference,{product:owner});assert.equal(mapping.definition.reference.visibility,'private');}
  const original=matches.find(r=>r.ref===selected.mappingRef),next=matches.find(r=>r.ref!==selected.mappingRef);assert(original&&next);assert.equal(original.definition.reference.version,selected.version);assert.equal(original.definition.reference.digest,selected.digest);assert(newer(next.definition.reference.version,selected.version));assert.notEqual(next.definition.reference.digest,selected.digest);
  for(const key of ['standardDigest','standardLockDigest','contractDigest'])assert.equal(next.definition.reference[key],original.definition.reference[key]);
  const connections=config.owners.filter(o=>o.ref===selected.adapterRef&&o.owner===owner&&o.workspaceId===run.selection.workspaceId&&o.projects.includes(run.selection.projectId));assert.equal(connections.length,1);registrations[owner]=connections[0];ownerApi.verifyOwnerDistribution(owner,connections[0].packageRoot);
  oldRefs[owner]=original.definition.reference;newRefs[owner]=next.definition.reference;oldMappings[owner]=original;newMappings[owner]=next;
 }
 assert.notEqual(newMappings.ontology.definition.assessmentId,oldMappings.ontology.definition.assessmentId,'Each exact Ontology projection needs its own retained content assessment');
 const nextResource=(role,kind)=>{const rows=config.resources.filter(r=>r.projectId===run.selection.projectId&&r.workspaceId===run.selection.workspaceId&&r.role===role&&r.definition.kind===kind&&exact(r.definition.ontology,newRefs.ontology)&&exact(r.definition.harness,newRefs.harness));assert.equal(rows.length,1,'Select one exact registered version-specific '+role);assert(Date.parse(rows[0].expiresAt)>Date.now());return rows[0];};
 const requirementMap=nextResource('config.scope.requirementsMappingRef','requirements-map'),evidenceMap=nextResource('config.verification.evidenceMappingRef','evidence-map');
 const material={},ownerConfiguration=owner=>{const{ref,...configuration}=registrations[owner];assert(ref);return configuration;};
 const packages=async label=>{
  time();const ontology=await ownerApi.openPublishedOwner(ownerConfiguration('ontology')),out={};let harness;
  try{harness=await ownerApi.openPublishedOwner(ownerConfiguration('harness'),undefined,ontology);for(const owner of owners){const adapter=owner==='ontology'?ontology:harness;out[owner]={};for(const [generation,references]of [['old',oldRefs],['next',newRefs]]){const reference=references[owner],value=await adapter.readPackage(actor(),run.selection.projectId,scope,reference);assert.deepEqual(native.referenceForPackage(value.package),reference);assert.deepEqual(value.scope,scope);out[owner][generation]={reference:value.reference,package:value.package,validation:value.validation??null};run.artifact('asset-version-published-readback.json',{label,owner,generation,identity:adapter.capabilities(),request:{operation:'native.package.readback',scope,input:{id:reference.id,version:reference.version}},response:value});}}}
  finally{harness?.close();ontology.close();}
  for(const generation of ['old','next'])assert(out.harness[generation].package.manifest.dependencies.some(d=>exact(d,out.ontology[generation].reference)),'The Harness must publish the exact same-generation Ontology dependency');
  for(const owner of owners){assert.notDeepEqual(out[owner].old.package.files,out[owner].next.package.files,'A version label alone cannot replace actual separately published fixture material');if(label==='before')material[owner]=out[owner];else for(const generation of ['old','next']){assert.deepEqual(out[owner][generation].package,material[owner][generation].package);assert.deepEqual(out[owner][generation].reference,material[owner][generation].reference);}}
  return out;
 };
 await packages('before');
 const originalStage=async stageRequestId=>{const value=await run.read('lifecycle.stage.request.inspect',{stageRequestId});assert.equal(value.workerError,null);assert(Number.isSafeInteger(value.projectRevision));const{projectRevision,...original}=value;return original;};
 const chain=async instance=>({scope:await originalStage(instance.stages.scope.requestId),scopeEvidence:await run.read('lifecycle.scope.evidence.read',{stageRequestId:instance.stages.scope.requestId}),plan:await originalStage(instance.stages.plan.requestId),planEvidence:await run.read('lifecycle.plan.evidence.read',{stageRequestId:instance.stages.plan.requestId})});
 const originalChain=await chain(old);
 function ownerProof(instance,proof,references){
  for(const stage of ['scope','plan']){const value=proof[stage],{digest,...requestBody}=value.request;assert.equal(digest,base.valueDigest(requestBody));assert.equal(value.request.instanceId,instance.id);assert.equal(value.request.pinsDigest,instance.pinsDigest);assert.equal(value.progress.phase,'COMPLETE');assert.equal(value.progress.terminal,true);assert.equal(value.automaticRedispatch,false);assert.equal(value.progress.observation.outcome.status,'COMPLETE');assert.deepEqual(value.progress.observation.outcome.checks.map(c=>c.id).sort(),instance.definition.nodes.find(n=>n.id===stage).checks.slice().sort());assert(value.progress.observation.outcome.checks.every(c=>c.status==='PASS'&&c.evidenceRef));}
  const request=proof.plan.request,packetDigest=proof.planEvidence.evidence.preparationDigest;assert.equal(instance.pins.targetRef,'preparation:'+packetDigest);assert.equal(proof.planEvidence.evidence.requestDigest,request.digest);
  for(const owner of owners){const selected=request.plan.parameters.owners[owner],value=proof.planEvidence.owners[owner];assert.deepEqual(selected.reference,references[owner]);assert(value.action&&value.receipt);assert.equal(value.action.request.operation,'native.package.validate');assert.equal(value.action.request.input.id,references[owner].id);assert.equal(value.action.request.input.version,references[owner].version);assert.equal(value.receipt.requestId,value.action.request.requestId);assert.equal(value.receipt.operation,value.action.request.operation);assert.deepEqual(value.receipt.scope,value.action.request.scope);assert.equal(value.receipt.requestDigest,native.nativeSha256({operation:value.action.request.operation,scope:value.action.request.scope,input:value.action.request.input}));assert.equal(value.action.requestDigest,ownerApi.ownerRequestDigest(owner,value.action.request));const{digest:actionDigest,...actionBody}=value.action;assert.equal(actionDigest,base.valueDigest(actionBody));const verified=stagesApi.verifyNativeStageResult(value.receipt,owner,selected,value.action,request.plan.parameters.toolchainLockDigest,request.plan.parameters.effectiveConfigDigest);assert.equal(verified.status,'PASS');assert.deepEqual(value.action.request.input.context,value.action.context);assert.deepEqual(value.receipt.result.context,value.action.context);assert.equal(value.action.context.workspaceId,run.selection.workspaceId);assert.deepEqual(value.action.context.scope,scope);assert.equal(value.action.context.projectCandidateDigest,packetDigest);assert.equal(value.action.context.inputDigest,request.inputDigest);assert.equal(value.action.context.requirementSetDigest,instance.pins.requirementsDigest);const{reportDigest,...reportBody}=value.receipt.result;assert.equal(reportDigest,native.nativeSha256(reportBody));if(owner==='ontology'){assert.equal(value.receipt.result.status,'CONFORMS');assert.equal(value.receipt.result.packageDigest,references[owner].digest);}else{assert.equal(value.receipt.result.qualityStatus,'PASS');assert.deepEqual(value.receipt.result.reference,references[owner]);assert.equal(value.action.request.input.observation.origin,'execution-result');assert.equal(value.action.request.input.observation.values.runtimePlan.preparationDigest,packetDigest);}}
 }
 ownerProof(old,originalChain,oldRefs);
 const unchanged=async label=>{time();assert.deepEqual((await run.read('lifecycle.instance.inspect',{instanceId:old.id})).instance,old);assert.deepEqual(await chain(old),originalChain);const authority=await run.read('lifecycle.authority.inspect',{authorityRef:created[0].data.authorityRef});assert.deepEqual(authority.decision,oldAuthority.decision);assert.deepEqual(authority.revocation,oldAuthority.revocation);assert.deepEqual((await run.read('lifecycle.preparation.read',{preparationRef:old.pins.targetRef})).packet,originalPreparation.packet);assert.deepEqual(await run.read('lifecycle.definition.read',{revisionId:before.active.id}),originalDefinition);assert.equal(await run.source(before.active.id),originalSource);assert.deepEqual(fs.readFileSync(spec.integrationsRef),configBytes);run.artifact('asset-version-original-run-readback.json',{label,instanceId:old.id,pinsDigest:old.pinsDigest,requestIds:old.requestIds,originalOwnerReportDigests:Object.fromEntries(owners.map(o=>[o,originalChain.planEvidence.owners[o].receipt.result.reportDigest])),originalAuthorityUnchanged:true,authorityUsable:authority.usable,authorityReason:authority.reason,oldExecutionNotRequested:true});};
 run.artifact('asset-version-frozen-inputs.json',{candidateDigest:run.candidateDigest,configDigest:sha(configBytes),old,originalChain,oldAuthority,oldRefs,newRefs,oldMappings,newMappings,requirementMap,evidenceMap,registrations,originalEventCount:inventory.rows.length,originalEventDigest:sha(JSON.stringify(inventory.rows)),syntheticAssets:true,syntheticDecisions:true,packageVersionsAreInputsNotAcceptance:true});
 const doc=parseDocument(originalSource);assert.equal(doc.errors.length,0);for(const owner of owners){doc.setIn(['assets',owner,'version'],newRefs[owner].version);doc.setIn(['assets',owner,'digest'],newRefs[owner].digest);}
 const incomplete=doc.toString({lineWidth:0}),rejected=await run.read('lifecycle.definition.validate',{yaml:incomplete});assert.equal(rejected.compilation.valid,true);issue(rejected,'BINDING_NOT_READY','assets.ontology');assert.deepEqual(await run.read('lifecycle.definition.inspect'),before);await unchanged('AFTER_VERSION_ONLY_REFUSAL');
 for(const owner of owners)doc.setIn(['assets',owner,'mappingRef'],newMappings[owner].ref);doc.setIn(['config','scope','requirementsMappingRef'],requirementMap.ref);doc.setIn(['config','verification','evidenceMappingRef'],evidenceMap.ref);
 const nextSource=doc.toString({lineWidth:0}),preview=await run.read('lifecycle.definition.validate',{yaml:nextSource});assert.equal(preview.ready,true,JSON.stringify(preview.issues));for(const owner of owners)assert(preview.bindings.checks.some(x=>x.path==='assets.'+owner&&x.status==='VALID'));
 const nextEffective=preview.compilation.effective;assert.equal(base.isCurrentBase(nextEffective.base),true);assert.deepEqual(nextEffective.nodes,old.definition.nodes);assert.equal(instanceApi.requiredChecksDigest(nextEffective),old.pins.requirementsDigest);assert.notEqual(nextEffective.semanticDigest,old.pins.semanticDigest);
 let unknownWrite=false,stageWrites=0;const mutations=[];
 const write=async(operation,input,label)=>{time();assert(!unknownWrite,'Inspect the original uncertain mutation before any further write');assert(['lifecycle.definition.save-and-activate','lifecycle.preparation.save','lifecycle.authority.record','lifecycle.instance.create','lifecycle.stage.request'].includes(operation));if(operation==='lifecycle.stage.request'){assert(['scope','plan'].includes(input.stageId));assert(++stageWrites<=2);}if(operation==='lifecycle.authority.record')assert.equal(input.kind,'execution');const requestId=run.requestId(c.caseInstanceId,label),status=await run.read('runtime.status');let response;try{response=await run.request(operation,input,{requestId,expectedRevision:status.revision});}catch{unknownWrite=true;run.artifact('asset-version-uncertain-write.json',{operation,requestId,outcome:'UNKNOWN',automaticRetry:false});throw Error('E16_ASSET_VERSION_UNKNOWN_WRITE');}if(response.status>=500){unknownWrite=true;throw Error('E16_ASSET_VERSION_UNKNOWN_WRITE');}assert.equal(response.status,200,JSON.stringify(response.body));const receipt=response.body.result;assert.equal(receipt.requestId,requestId);assert.equal(receipt.operation,operation);assert.deepEqual(await run.read('runtime.receipt.read',{requestId}),receipt);mutations.push({operation,requestId,receipt});return receipt;};
 const activated=await write('lifecycle.definition.save-and-activate',{yaml:nextSource,validationDigest:preview.validationDigest},'activate-v2');assert.equal(activated.result.status,'ACTIVE');assert.equal(activated.result.executionAuthorized,false);assert.equal(activated.result.releaseAuthorized,false);assert.notEqual(activated.result.activeRevisionId,before.active.id);assert.equal(await run.source(activated.result.activeRevisionId),nextSource);await unchanged('AFTER_REAL_NEW_BINDING_ACTIVATION');
 const newId='e16-assets-'+sha(run.selection.runId).slice(0,32),goalRef='synthetic:goal/'+newId,loopRef='synthetic:loop/'+newId,newInput=structuredClone(originalPreparation.packet.input);newInput.definitionRevisionId=activated.result.activeRevisionId;newInput.goalRef=goalRef;newInput.loopRef=loopRef;newInput.target={...newInput.target,id:newId,version:'0.9.0-test.e16.assets',title:'Synthetic exact published asset version revalidation',scope:['Rebind the two exact prepublished synthetic owner versions','Run native scope and plan only; preserve the original instance and owner receipts'],exclusions:['New owner asset authoring/publication during this collector','Coding Agent, CI, source mutation, business execution, feedback disposition or software release']};newInput.verification.requirementsDigest=instanceApi.requiredChecksDigest(nextEffective);
 const prepared=await write('lifecycle.preparation.save',newInput,'prepare-v2');assert.equal(prepared.result.executionAuthorized,false);const subject={instanceId:newId,definitionRevisionId:activated.result.activeRevisionId,goalRef,targetRef:prepared.result.preparationRef,loopRef,budget:{timeoutSeconds:600,maxAttempts:1,maxConcurrency:1,maxLoops:1},expiresAt:new Date(Date.now()+600000).toISOString()},review=await run.read('lifecycle.authority.preview',{kind:'execution',subject});assert.equal(review.authorityGranted,false);assert.equal(review.executionDispatched,false);
 const decisionSubject={owner:'runtime',operation:'lifecycle.authority.execution',workspaceId:run.selection.workspaceId,scope,reviewDigest:review.reviewDigest,decision:'APPROVE'},synthetic=run.artifact('asset-version-synthetic-decision-source.json',{synthetic:true,subject:decisionSubject,description:'Explicit isolated technical fixture only; no human, domain, business, product or release approval'}),sourceRef=path.join(run.selection.outputRoot,synthetic.artifact);assert.equal(sha(fs.readFileSync(sourceRef)),synthetic.fileDigest);
 const decisionEvidence={schema:'evopilot-decision-evidence/v1',subject:decisionSubject,source:{reference:pathToFileURL(sourceRef).href+'#sha256='+synthetic.fileDigest,description:'Synthetic E16 exact execution preview only'}},decisionBytes=JSON.stringify(decisionEvidence,null,2)+'\n',decisionPath=path.join(run.selection.outputRoot,'native-decision-'+sha(newId).slice(0,32)+'.json');
 fs.writeFileSync(decisionPath,decisionBytes,{mode:0o600,flag:'wx'});assert.equal(fs.realpathSync(decisionPath),decisionPath);const evidenceRef=pathToFileURL(decisionPath).href+'#sha256='+sha(decisionBytes);run.artifact('asset-version-synthetic-decision.json',{nativeEvidence:{ref:decisionPath,sha256:sha(decisionBytes),bytes:Buffer.byteLength(decisionBytes)},rawBody:decisionBytes,synthetic:true});
 const decision=await write('lifecycle.authority.record',{kind:'execution',subject,reviewDigest:review.reviewDigest,decision:'APPROVE',evidenceRef},'authority-v2');await write('lifecycle.instance.create',{instanceId:newId,definitionRevisionId:activated.result.activeRevisionId,authorityRef:decision.result.authorityRef},'instance-v2');
 for(const stageId of ['scope','plan']){time();const admission=await run.read('lifecycle.stage.admission',{instanceId:newId,stageId});assert.equal(admission.allowed,true);assert.equal(admission.executionDispatched,false);const receipt=await write('lifecycle.stage.request',{instanceId:newId,stageId},stageId+'-v2'),stageRequestId=receipt.result.stageRequestId,until=Math.min(deadline,Date.now()+120000);for(;;){time();const state=await run.read('lifecycle.stage.request.inspect',{stageRequestId});assert.equal(state.automaticRedispatch,false);if(state.progress.phase==='COMPLETE')break;assert(!['FAILED','UNKNOWN'].includes(state.progress.phase),'Preserve actual native failure or uncertainty; never replace it with a synthetic PASS');assert(Date.now()<until,'Preserve original stage on bounded observation timeout');await pause(500);}}
 const next=(await run.read('lifecycle.instance.inspect',{instanceId:newId})).instance;assert.equal(next.pins.definitionRevisionId,activated.result.activeRevisionId);assert.equal(next.pins.targetRef,prepared.result.preparationRef);assert.equal(next.pins.semanticDigest,nextEffective.semanticDigest);assert.notEqual(next.pinsDigest,old.pinsDigest);assert.deepEqual(next.pins.budget,subject.budget);assert.equal(next.requestIds.length,2);for(const [id,state]of Object.entries(next.stages))if(['scope','plan'].includes(id)){assert.equal(state.status,'PASSED');assert.equal(state.attempts,1);assert(state.requestId);}else{assert.equal(state.status,'PENDING');assert.equal(state.attempts,0);assert.equal(state.requestId,null);}
 const nextChain=await chain(next);ownerProof(next,nextChain,newRefs);for(const owner of owners){const prior=originalChain.planEvidence.owners[owner],current=nextChain.planEvidence.owners[owner];assert.notEqual(current.action.request.requestId,prior.action.request.requestId);assert.notEqual(current.receipt.result.reportDigest,prior.receipt.result.reportDigest);assert.notEqual(current.action.context.inputDigest,prior.action.context.inputDigest);assert.notEqual(current.action.context.projectCandidateDigest,prior.action.context.projectCandidateDigest);assert.notEqual(current.action.context.claimId,prior.action.context.claimId);}
 await unchanged('AFTER_ACTUAL_NEW_VERSION_NATIVE_REVALIDATION');await packages('after');const final=await run.read('lifecycle.definition.inspect');assert.equal(final.active.id,activated.result.activeRevisionId);assert.equal(await run.source(final.active.id),nextSource);assert.equal((await run.read('lifecycle.definition.validate',{yaml:nextSource})).ready,true);await unchanged('FINAL');
 const tail=await events(run,inventory.cursor);assert.equal(tail.rows.filter(e=>e.type==='lifecycle-instance-created').length,1);const authorityEvents=tail.rows.filter(e=>e.type==='authority-recorded');assert.equal(authorityEvents.length,1);assert.equal(authorityEvents[0].data.instanceId,newId);assert.equal(authorityEvents[0].data.authorityRef,decision.result.authorityRef);assert.equal(authorityEvents[0].data.kind,'execution');assert.equal(authorityEvents[0].data.choice,'APPROVE');const started=tail.rows.filter(e=>e.type==='stage-requested');assert.equal(started.length,2);assert(started.every(e=>e.data.instanceId===newId&&['scope','plan'].includes(e.data.stageId)));assert(!tail.rows.some(e=>e.type==='owner-feedback-observed'||e.type==='stage-advance-requested'));assert.equal(stageWrites,2);
 run.artifact('asset-version-final-proof.json',{oldRefs,newRefs,originalInstance:old,newInstance:next,originalChain,nextChain,definitionBefore:before,definitionAfter:final,mutations,events:tail.rows,originalRunRedispatches:0,newNativeStageCalls:2,syntheticExecutionDecision:true,ownerPublicationByCollector:false,softwareAcceptanceClaimed:false,l3BusinessGradeClaimed:false,CV06NotSatisfied:true});
 return{actualInstalledHttp:true,candidateDigest:run.candidateDigest,oldAssetReferences:oldRefs,newAssetReferences:newRefs,oldInstanceId:old.id,newInstanceId:newId,oldDefinitionRevisionId:before.active.id,newDefinitionRevisionId:final.active.id,versionWithoutMappingRejected:true,realNewBindingActivated:true,newNativeOwnerReports:Object.fromEntries(owners.map(o=>[o,{reportDigest:nextChain.planEvidence.owners[o].receipt.result.reportDigest,context:nextChain.planEvidence.owners[o].action.context}])),originalInstancePinsRequestsAndReportsUnchanged:true,newNativeStageCalls:2,oldRunRedispatches:0,newSyntheticExecutionDecisions:1,ownerAssetPublications:0,newCI:0,newAgentCalls:0,softwareAcceptanceClaimed:false,l3BusinessGradeClaimed:false,remainingIndependentCases:Object.keys(unsupported)};
}

const permissions={monitor:['read'],editor:['read','draft.write'],activator:['read','draft.write','definition.activate']};
function identity(run,alias){const value=run.principal(alias);assert.deepEqual([...value.expectedPermissions].sort(),[...permissions[alias]].sort());assert.equal(value.projectId,run.selection.projectId);return value;}
function denied(response,codes){assert([400,401,403,413].includes(response.status),'Security probe must receive a definite client rejection');assert(response.body?.error&&codes.includes(response.body.error.code),JSON.stringify({status:response.status,error:response.body?.error}));assert(!Object.hasOwn(response.body,'result'),'An error cannot disclose a successful result');return{status:response.status,code:response.body.error.code};}
async function selectedActive(run){const view=await run.read('lifecycle.definition.inspect');assert(view.active,'Use an existing natively activated isolated project');const source=await run.source(view.active.id);return{view,source};}
async function noChanges(run,before){assert.deepEqual(await run.read('lifecycle.definition.inspect'),before,'A denied request cannot create a draft or alter active/revision');}
async function noCredentialExposure(run,ui,extra=[]){
 const surfaces=[{name:'page-url',text:ui.page.url()},{name:'page-html',text:await ui.page.content()},{name:'page-visible-text',text:await ui.page.locator('body').innerText()},{name:'browser-request-responses',text:JSON.stringify(ui.network)},...extra];
 if(await ui.source.count())surfaces.push({name:'yaml-editor',text:await ui.source.inputValue()});
 return run.assertNoCredentialExposure(surfaces,{logs:true});
}

async function monitorCase(run,browser,c){
 const principal=identity(run,'monitor'),initial=await selectedActive(run),ui=await openBrowser(run,browser,{principalAlias:'monitor',route:'/monitor',monitorEvidence:true});
 try{
  const before=await ui.monitor();assert.equal(before.readOnly,true);
  await expect(ui.source).toHaveCount(0);
  for(const name of ['保存草稿','保存并启用','执行','暂停','重试','取消','发布'])await expect(ui.page.getByRole('button',{name,exact:true})).toHaveCount(0);
  assert(!Object.hasOwn(before,'yaml')&&!Object.hasOwn(before,'semantic'));for(const instance of before.instances){assert(!Object.hasOwn(instance,'definition'));assert(!Object.hasOwn(instance,'yaml'));}
  const previews=await run.principalRequest('monitor','lifecycle.definition.validate',{yaml:initial.source});assert.equal(previews.status,200);
  const probes=[
   ['lifecycle.draft.save',{yaml:initial.source+'\n# denied monitor draft\n'}],
   ['lifecycle.definition.save-and-activate',{yaml:initial.source,validationDigest:previews.body.result.validationDigest}],
   ['lifecycle.instance.create',{instanceId:'e16-denied-instance',definitionRevisionId:initial.view.active.id,authorityRef:'synthetic:never-authorized'}],
   ['lifecycle.stage.request',{instanceId:'e16-denied-instance',stageId:'scope'}],
   ['lifecycle.stage.advance',{stageRequestId:'e16-denied-request'}],
  ];
  const findings=[];
  for(let i=0;i<probes.length;i++){
   const [operation,input]=probes[i],meta={requestId:run.requestId(c.caseInstanceId,'monitor-native-'+i),expectedRevision:initial.view.revision};
   const api=await run.principalRequest('monitor',operation,input,meta);findings.push({entry:'native-http',operation,...denied(api,['FORBIDDEN'])});
   const browserResponse=await ui.sessionRequest(operation,input,{...meta,requestId:run.requestId(c.caseInstanceId,'monitor-browser-'+i)});
   findings.push({entry:'browser-session',operation,...denied(browserResponse,i<2?['FORBIDDEN']:['DASHBOARD_OPERATION'])});
  }
  await noChanges(run,initial.view);assert.deepEqual((await ui.monitor()).instances,before.instances);
  await ui.screenshot();await ui.login('/lifecycle');await expect(ui.source).toHaveAttribute('readonly','');
  for(const name of ['保存草稿','保存并启用'])await expect(ui.page.getByRole('button',{name,exact:true})).toBeDisabled();
  const leakCheck=await noCredentialExposure(run,ui,[{name:'monitor-snapshot',text:JSON.stringify(before)}]);await ui.flush();
  return{phase:'PRE_RELEASE',requirements:['CV02'],candidate:run.candidate,actualMonitorPrincipal:principal,actualBrowserAndNativeRequests:true,monitorHasNoEditorOrRunControls:true,monitorPayloadOmitsEditorConfiguration:true,readOnlyDefinitionView:true,findings,activeDraftRevisionAndInstancesUnchanged:true,credentialExposure:leakCheck,postReleaseAcceptance:false};
 }finally{await ui.close();}
}

async function activateCurrent(ui,run,source){
 await expect(ui.source).toBeEditable();await ui.source.fill(source);await ui.preview();await expect(ui.page.getByRole('button',{name:'保存并启用',exact:true})).toBeEnabled();await ui.activate();
 const after=await run.read('lifecycle.definition.inspect');assert.equal(await run.source(after.active.id),source);
 await ui.flush();
 const latest=ui.network.filter(r=>r.request?.operation==='lifecycle.definition.save-and-activate').at(-1);assert(latest);
 const receipt=JSON.parse(latest.rawBody).result;assert.equal(receipt.result.status,'ACTIVE');assert.equal(receipt.result.executionAuthorized,false);assert.equal(receipt.result.releaseAuthorized,false);
 return{activeRevisionId:after.active.id,requestId:receipt.requestId,executionAuthorized:false,releaseAuthorized:false};
}
async function permissionFixture(run,c){
 assert.equal(c.caseInstanceId,'E16.CV02');assert(run.cases.some(item=>item.caseInstanceId==='E16.CV02'),'Selected campaign must contain the actual permission case');const f=run.permissionFixture;assert(f);assert.deepEqual(f.caseIds,['E16.CV02']);for(const role of ['monitor','editor','activator'])identity(run,role);
 const original=(await run.read('lifecycle.instance.inspect',{instanceId:f.instanceId})).instance;assert.equal(original.id,f.instanceId);assert.equal(original.pins.projectId,run.selection.projectId);assert(Object.values(original.stages).every(s=>s.status==='PENDING'&&s.attempts===0&&s.requestId===null));
 const originalSource=await run.source(original.pins.definitionRevisionId),originalRevision=await run.read('lifecycle.definition.read',{revisionId:original.pins.definitionRevisionId});assert.deepEqual(original.definition.semantic.assets,originalRevision.compilation.effective.semantic.assets);return{fixture:f,original,originalSource,originalRevision};
}
async function intactPermissionHistory(run,initial){
 assert.deepEqual((await run.read('lifecycle.instance.inspect',{instanceId:initial.fixture.instanceId})).instance,initial.original);assert.equal(await run.source(initial.original.pins.definitionRevisionId),initial.originalSource);assert.deepEqual(await run.read('lifecycle.definition.read',{revisionId:initial.original.pins.definitionRevisionId}),initial.originalRevision);
}
async function permissionEvents(run){let cursor,rows=[];for(let i=0;i<80;i++){const r=await run.read('runtime.events.read',cursor?{cursor}:{});assert(Array.isArray(r.events)&&r.events.length<=50);if(!r.events.length)return rows;rows.push(...r.events);assert.notEqual(r.cursor,cursor);cursor=r.cursor;}throw Error('Permission fixture event bound exceeded');}
function actualPreview(ui,source){const row=ui.network.filter(v=>v.request?.operation==='lifecycle.definition.validate'&&v.request.input?.yaml===source&&v.status===200&&v.transportOutcome==='RESPONSE_RETAINED').at(-1);assert(row);const body=JSON.parse(row.rawBody);assert.equal(body.result.ready,true);assert(/^sha256:[a-f0-9]{64}$/.test(body.result.validationDigest));return{digest:body.result.validationDigest,responseRequestId:body.requestId};}
async function previewPermissionSource(ui,source){await expect(ui.source).toBeEditable();await ui.source.fill(source);await ui.preview();return actualPreview(ui,source);}
async function deniedUiActivation(ui,run,source,preview,{holdBeforeSubmit=false,stepId}){
 const start=ui.network.length;let captured=null,release=null,arrived=null,released=false,routeFailure=null;
 const ready=new Promise(resolve=>{arrived=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const handler=async route=>{const request=route.request();let envelope;try{envelope=request.postDataJSON();}catch{}if(envelope?.operation!=='lifecycle.definition.save-and-activate')return route.continue();if(captured){routeFailure='Unexpected duplicate UI activation request';return route.abort('failed');}
  try{assert.equal(envelope.projectId,run.selection.projectId);assert.equal(envelope.input.yaml,source);assert.equal(envelope.input.validationDigest,preview.digest);assert.equal(typeof envelope.requestId,'string');captured={envelope,at:new Date().toISOString(),interception:'ACTUAL_UI_REQUEST_BEFORE_TRANSPORT_NO_PAYLOAD_CHANGE'};arrived();const forward=await gate;if(!forward)return route.abort('failed');await route.continue();}catch{routeFailure='Exact held activation forwarding failed';try{await route.abort('failed');}catch{}}
 };
 try{
  if(holdBeforeSubmit)await ui.page.route('**/api/v1/dashboard/request',handler);
  if(!holdBeforeSubmit)run.permissionFault(stepId);
  const click=ui.page.getByRole('button',{name:'保存并启用',exact:true}).click({timeout:10000});
  if(holdBeforeSubmit){let timer;try{await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Actual submit interception timed out')),10000);})]);}finally{clearTimeout(timer);}run.artifact('permission-submit-boundary.json',captured);run.permissionFault(stepId);released=true;release(true);}
  await click;await expect.poll(()=>ui.network.slice(start).filter(v=>v.request?.operation==='lifecycle.definition.save-and-activate'&&v.transportOutcome==='RESPONSE_RETAINED').length,{timeout:10000}).toBeGreaterThan(0);assert.equal(routeFailure,null);
  const row=ui.network.slice(start).find(v=>v.request?.operation==='lifecycle.definition.save-and-activate'&&v.transportOutcome==='RESPONSE_RETAINED');assert.equal(row.request.input.validationDigest,preview.digest);assert.equal(row.request.input.yaml,source);const result=denied({status:row.status,body:JSON.parse(row.rawBody)},['BROWSER_SESSION_REVOKED','UNAUTHENTICATED']);assert.equal(result.status,401);return{...result,actualUiRequest:row.request,heldBeforeTransport:holdBeforeSubmit,previewResponseRequestId:preview.responseRequestId};
 }finally{if(!released){released=true;release(false);}if(holdBeforeSubmit)await ui.page.unroute('**/api/v1/dashboard/request',handler);}
}
async function restorePreview(run,ui,c,initial,source,preview,restoreId,pendingRequestId=null){
 run.permissionFault(restoreId);const old=await ui.sessionRequest('runtime.status');assert.equal(old.status,401);denied(old,['UNAUTHENTICATED','BROWSER_SESSION_REVOKED']);await ui.login('/lifecycle');
 let originalRequestRecovery=null;
 if(pendingRequestId!==null){
  assert.equal(typeof pendingRequestId,'string');const button=ui.page.getByRole('button',{name:'核对原请求',exact:true});await expect(button).toBeEnabled();await expect(ui.page.getByText('待核对原请求',{exact:false})).toContainText(pendingRequestId);await expect(ui.source).toHaveAttribute('readonly','');
  const since=ui.network.length;await button.click();await expect(ui.source).toBeEditable();await expect(button).toHaveCount(0);await expect.poll(()=>ui.network.slice(since).filter(row=>row.request?.operation==='runtime.receipt.read'&&row.request.input?.requestId===pendingRequestId&&row.transportOutcome==='RESPONSE_RETAINED').length,{timeout:10000}).toBe(1);
  const rows=ui.network.slice(since),row=rows.find(row=>row.request?.operation==='runtime.receipt.read'&&row.request.input?.requestId===pendingRequestId);assert.equal(row.status,404);assert.equal(JSON.parse(row.rawBody).error.code,'NOT_FOUND');assert(!rows.some(row=>['lifecycle.draft.save','lifecycle.definition.save-and-activate'].includes(row.request?.operation)));await expect(ui.page.getByRole('button',{name:'保存并启用',exact:true})).toBeDisabled();
  originalRequestRecovery={originalRequestId:pendingRequestId,entry:'ACTUAL_DASHBOARD_ORIGINAL_REQUEST_BUTTON',receiptRead:row,missingReceiptConfirmed:true,newWrites:0};run.artifact('permission-original-request-recovery.json',originalRequestRecovery);
 }
 const before=await run.read('lifecycle.definition.inspect'),requestId=run.requestId(c.caseInstanceId,restoreId+'-old-preview'),stale=await ui.sessionRequest('lifecycle.definition.save-and-activate',{yaml:source,validationDigest:preview.digest},{requestId,expectedRevision:before.revision});assert.equal(stale.status,200);assert.equal(stale.body.result.result.status,'BLOCKED');assert(stale.body.result.result.issues.some(i=>i.code==='VALIDATION_STALE'));assert.deepEqual((await run.read('lifecycle.definition.inspect')).active,before.active);
 // The real BLOCKED request retains its draft and advances revision. Reconnect
 // this same Dashboard page before obtaining and consuming a genuinely new preview.
 await ui.login('/lifecycle');const fresh=await previewPermissionSource(ui,source);assert.notEqual(fresh.digest,preview.digest);const activated=await activateCurrent(ui,run,source);await intactPermissionHistory(run,initial);return{oldSessionRejected:true,originalRequestRecovery,oldPreviewRequestId:requestId,oldPreviewBlocked:true,freshPreview:fresh,activated};
}
async function afterActivationRevocation(run,browser,c,initial,ids){
 const ui=await openBrowser(run,browser,{principalAlias:'activator',route:'/lifecycle',monitorEvidence:true});
 try{
  const selected=await selectedActive(run),source=selected.source+'\n# exact post-active revocation '+run.selection.runId+'\n',preview=await previewPermissionSource(ui,source),activation=await activateCurrent(ui,run,source),before=await run.read('lifecycle.definition.inspect');
  await ui.login('/monitor');const start=ui.sseFrames.length;await expect.poll(()=>ui.sseFrames.filter(f=>['snapshot','heartbeat'].includes(f.eventName)).length,{timeout:10000}).toBeGreaterThan(0);const connected=ui.sseFrames.find(f=>['snapshot','heartbeat'].includes(f.eventName));assert(connected);const fault=run.permissionFault(ids.expire);
  const native=await run.principalRequest('activator','runtime.status');assert.equal(native.status,401);denied(native,['UNAUTHENTICATED']);
  await expect.poll(()=>ui.sseFrames.slice(start).filter(f=>f.eventName==='error'&&f.requestId===connected.requestId).length,{timeout:10000}).toBeGreaterThan(0);const errorIndex=ui.sseFrames.findIndex((f,i)=>i>=start&&f.eventName==='error'&&f.requestId===connected.requestId),frame=ui.sseFrames[errorIndex];assert.equal(JSON.parse(frame.data).code,'UNAUTHENTICATED');
  await expect(ui.page.getByLabel('一次性连接码')).toBeVisible();const session=await ui.sessionRequest('runtime.status');assert.equal(session.status,401);denied(session,['UNAUTHENTICATED','BROWSER_SESSION_REVOKED']);
  let stream;try{const response=await ui.context.request.get(run.serviceOrigin+'/api/v1/dashboard/events',{timeout:10000,maxRedirects:0});const raw=await response.text();assert(Buffer.byteLength(raw)<=8192);stream={status:response.status(),body:JSON.parse(raw),rawBody:raw};}catch{throw Error('Revoked stream read failed before a bounded safe response');}assert.equal(stream.status,401);denied(stream,['UNAUTHENTICATED','BROWSER_SESSION_REVOKED']);run.artifact('permission-revoked-stream.json',{path:'/api/v1/dashboard/events',...stream,originalFrame:frame,authenticationFieldsOmitted:true});
  assert(!ui.sseFrames.slice(errorIndex+1).some(f=>f.requestId===connected.requestId&&['snapshot','events','heartbeat','reset'].includes(f.eventName)));await noChanges(run,before);await intactPermissionHistory(run,initial);
  const recovery=await restorePreview(run,ui,c,initial,source,preview,ids.restore);await noCredentialExposure(run,ui,[{name:'revoked stream',text:JSON.stringify(stream)}]);await ui.flush();return{activation,fault,nativeRevoked:native.body.error.code,browserRevoked:session.body.error.code,originalSseError:frame,newSseRejected:true,recovery};
 }finally{run.restorePermissionFault();await ui.close();}
}
async function permissionTiming(run,browser,c){
 const initial=await permissionFixture(run,c),events=await permissionEvents(run),roleMonitor=await monitorCase(run,browser,c);let editor;
 try{editor=await openBrowser(run,browser,{principalAlias:'editor',route:'/lifecycle'});const old=await selectedActive(run),source=old.source+'\n# editor retained draft\n';await editor.source.fill(source);await editor.save();await editor.preview();await expect(editor.page.getByRole('button',{name:'保存并启用',exact:true})).toBeDisabled();const preview=actualPreview(editor,source),view=await run.read('lifecycle.definition.inspect'),denial=await editor.sessionRequest('lifecycle.definition.save-and-activate',{yaml:source,validationDigest:preview.digest},{requestId:run.requestId(c.caseInstanceId,'editor-denied'),expectedRevision:view.revision});assert.equal(denial.status,403);denied(denial,['FORBIDDEN']);await noChanges(run,view);}finally{await editor?.close();}
 const timings=[];
 for(const name of ['after-preview','before-submit']){
  const ui=await openBrowser(run,browser,{principalAlias:'activator',route:'/lifecycle',monitorEvidence:true});
  try{const selected=await selectedActive(run),source=selected.source+'\n# '+name+' '+run.selection.runId+'\n',preview=await previewPermissionSource(ui,source),before=await run.read('lifecycle.definition.inspect');const rejected=await deniedUiActivation(ui,run,source,preview,{holdBeforeSubmit:name==='before-submit',stepId:name+'-revoke'});
   const native=await run.principalRequest('activator','lifecycle.definition.save-and-activate',{yaml:source,validationDigest:preview.digest},{requestId:run.requestId(c.caseInstanceId,name+'-native-denied'),expectedRevision:before.revision});assert.equal(native.status,403);denied(native,['FORBIDDEN']);assert.equal((await run.principalRequest('activator','lifecycle.instance.inspect',{instanceId:initial.original.id})).status,200);await noChanges(run,before);await intactPermissionHistory(run,initial);const recovery=await restorePreview(run,ui,c,initial,source,preview,name+'-restore',rejected.actualUiRequest.requestId);await ui.flush();timings.push({boundary:name,rejected,nativeDenied:true,recovery});
  }finally{run.restorePermissionFault();await ui.close();}
 }
 const post=await afterActivationRevocation(run,browser,c,initial,{expire:'after-active-expire',restore:'after-active-restore'});const after=await permissionEvents(run);assert.deepEqual(after.slice(0,events.length),events);const added=after.slice(events.length);assert(added.every(e=>['definition-draft-saved','definition-activation-blocked','definition-activated'].includes(e.type)));
 return{actualInstalledCandidate:true,actualThreeRoles:true,monitor:roleMonitor,timings,postActivation:post,oldInstanceAndPinsUnchanged:true,authFaultInjection:true,productMembershipManagement:false,newInstanceOrStageDispatches:0,newModelCalls:0,newCiRuns:0,originalOwnerReferences:initial.original.definition.semantic.assets,originalRevisionId:initial.original.pins.definitionRevisionId,ownerFeedbackBranchesNotCredited:true,l3SoftwareAcceptanceClaimed:false};
}

test('E16 installed owner boundaries and original feedback replay',caseCampaignTestOptions('E16',{timeout:240000}),async()=>{
 const run=await openScenario('E16');
 try{
  if(run.selection.caseCampaign){await collectCaseCampaign(run,'E16');return;}
  assert.equal(run.all.length,7,'The frozen E16 denominator must remain unchanged');
  for(const c of run.cases)await run.collect(c,async()=>{
   if(c.caseInstanceId==='E16.CV02'){const browser=await chromium.launch({headless:true});try{return await permissionTiming(run,browser,c);}finally{await browser.close();}}
   if(c.caseInstanceId==='E16.variant.02')return duplicateFeedback(run,c);
   if(c.caseInstanceId==='E16.variant.03')return scopeMismatch(run,c);
   if(c.caseInstanceId==='E16.variant.04')return assetVersionEvolution(run,c);
   assert(Object.hasOwn(unsupported,c.caseInstanceId),'Unknown fixed E16 case');
   run.artifact('unimplemented-e16-obligation.json',{required:c,missing:unsupported[c.caseInstanceId],scopeRefusalIsNotSubstitute:true});
   assert.fail('UNIMPLEMENTED_REQUIRED_VARIANT: '+unsupported[c.caseInstanceId]);
  });
 }finally{run.finish();}
});
