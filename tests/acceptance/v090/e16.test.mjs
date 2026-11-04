// Exact installed scope refusals and continuation of an existing active closure.
// No new stage, owner asset, decision, provider result or database seed is made.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseDocument} from 'yaml';
import {openScenario,sha} from './support.mjs';

const owners=['ontology','harness'];
const unsupported={
 'E16.journey':'Actual native owner validation failures, one-owner recovery, independent feedback readback and complete original execution evidence remain required.',
 'E16.variant.01':'An actual unknown owner response and original-request recovery without redispatch are required.',
 'E16.variant.04':'Two exact published asset versions, new binding/revalidation and preservation of the old instance are required.',
 'E16.CV02':'Actual permission/dependency loss at every fixed timing boundary and fresh same-entry validation recovery are required.',
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

test('E16 installed owner boundaries and original feedback replay',async()=>{
 const run=await openScenario('E16');
 try{
  assert.equal(run.all.length,7,'The frozen E16 denominator must remain unchanged');
  for(const c of run.cases)await run.collect(c,async()=>{
   if(c.caseInstanceId==='E16.variant.02')return duplicateFeedback(run,c);
   if(c.caseInstanceId==='E16.variant.03')return scopeMismatch(run,c);
   assert(Object.hasOwn(unsupported,c.caseInstanceId),'Unknown fixed E16 case');
   run.artifact('unimplemented-e16-obligation.json',{required:c,missing:unsupported[c.caseInstanceId],scopeRefusalIsNotSubstitute:true});
   assert.fail('UNIMPLEMENTED_REQUIRED_VARIANT: '+unsupported[c.caseInstanceId]);
  });
 }finally{run.finish();}
});
