// Exact installed scope refusals, original feedback continuation, and asset
// version evolution. Only variant.04 creates one explicit synthetic execution
// decision and runs scope/plan for its new binding. No branch publishes assets,
// invokes a coding Agent/CI, fabricates provider results, or seeds a database.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {parseDocument} from 'yaml';
import {collectCaseCampaign,caseCampaignTestOptions,openScenario,sha} from './support.mjs';
import {chromium,expect} from '@playwright/test';
import {openBrowser} from './browser.mjs';
import {proveOriginalCodingHost} from './execution.mjs';

const owners=['ontology','harness'];
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
 return{actualInstalledHttp:true,candidateDigest:run.candidateDigest,syntheticAssets:true,validOriginalOwnerBindings:owners,crossProjectRefusals:cross,scopeRefusals:refusals,blockedDraftsRetained:true,repairedDraftRevisionId:final.draft.id,originalActiveAndDraftRecordsUnchanged:true,originalInstanceCount:originalInstances.length,originalInstancePinsAndStagesUnchanged:true,newEvents:tail.rows.map(e=>({seq:e.seq,type:e.type,revision:e.revision})),nativeDefinitionMutations:cases.length+1,ownerMutationsRequested:0,businessStagesDispatched:0,authorityCreatedOrExtended:false,expiredAuthorityUsedForAdmission:false,softwareAcceptanceClaimed:false,l3GradeClaimed:false,feedbackRecoveryClaimed:false,unexecutedCasesNotCredited:true};
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
 return{actualInstalledHttp:true,candidateDigest:run.candidateDigest,oldAssetReferences:oldRefs,newAssetReferences:newRefs,oldInstanceId:old.id,newInstanceId:newId,oldDefinitionRevisionId:before.active.id,newDefinitionRevisionId:final.active.id,versionWithoutMappingRejected:true,realNewBindingActivated:true,newNativeOwnerReports:Object.fromEntries(owners.map(o=>[o,{reportDigest:nextChain.planEvidence.owners[o].receipt.result.reportDigest,context:nextChain.planEvidence.owners[o].action.context}])),originalInstancePinsRequestsAndReportsUnchanged:true,newNativeStageCalls:2,oldRunRedispatches:0,newSyntheticExecutionDecisions:1,ownerAssetPublications:0,newCI:0,newAgentCalls:0,softwareAcceptanceClaimed:false,l3BusinessGradeClaimed:false,unexecutedCasesNotCredited:true};
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

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))test('E16 installed owner boundaries and original feedback replay',caseCampaignTestOptions('E16',{timeout:240000}),async()=>{
 const run=await openScenario('E16');
 try{
  if(run.selection.caseCampaign){await collectCaseCampaign(run,'E16');return;}
  assert.equal(run.all.length,7,'The frozen E16 denominator must remain unchanged');
  for(const c of run.cases)await run.collect(c,async()=>{
   if(['E16.journey','E16.variant.01','E16.CV06'].includes(c.caseInstanceId))return ownerFeedbackCase(run,c);
   if(c.caseInstanceId==='E16.CV02'){const browser=await chromium.launch({headless:true});try{return await permissionTiming(run,browser,c);}finally{await browser.close();}}
   if(c.caseInstanceId==='E16.variant.02')return duplicateFeedback(run,c);
   if(c.caseInstanceId==='E16.variant.03')return scopeMismatch(run,c);
   if(c.caseInstanceId==='E16.variant.04')return assetVersionEvolution(run,c);
   assert.fail('Unknown fixed E16 case '+c.caseInstanceId);
  });
 }finally{run.finish();}
});

const ownerCaseIds=['E16.journey','E16.variant.01','E16.CV06'];
function ownerExact(v,fields){assert(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Object.keys(v).sort(),[...fields].sort());}
function ownerPin(pin){ownerExact(pin,['ref','sha256']);assert(/^[a-f0-9]{64}$/.test(pin.sha256));assert.equal(fs.realpathSync(pin.ref),pin.ref);const st=fs.lstatSync(pin.ref);assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.uid===process.getuid()&&(st.mode&0o077)===0&&st.size>0&&st.size<=1048576);const bytes=fs.readFileSync(pin.ref);assert.equal(sha(bytes),pin.sha256);return JSON.parse(bytes);}
export function validateOwnerCaseFixture(f,selection,caseId){
 ownerExact(f,['schema','candidateDigest','workspaceId','projectId','syntheticAssets','syntheticDecisions','casePlans']);assert.equal(f.schema,'runtime-v090-owner-feedback-fixture/v1');assert.equal(f.candidateDigest,'sha256:'+selection.expectedManifestDigest);assert.equal(f.workspaceId,selection.workspaceId);assert.equal(f.projectId,selection.projectId);assert.equal(f.syntheticAssets,true);assert.equal(f.syntheticDecisions,true);assert(ownerCaseIds.includes(caseId));assert(f.casePlans&&typeof f.casePlans==='object'&&!Array.isArray(f.casePlans));assert(Object.keys(f.casePlans).every(id=>ownerCaseIds.includes(id)));assert(f.casePlans[caseId],'NOT_READY: exact original owner feedback case records required');return f.casePlans[caseId];
}
export function assertOwnerHistorySnapshot(snapshot,inventory,kind,id,vd){
 ownerExact(snapshot,['sequence','value']);assert(Number.isSafeInteger(snapshot.sequence));const event=inventory.find(e=>e.seq===snapshot.sequence);assert(event,'NOT_READY: original retained event missing');assert.equal(event.type,kind==='qualification-native-action'?'qualification-native-action':'owner-feedback-observed');assert.equal(event.data.id,id);if(kind!=='qualification-native-action')assert.equal(event.data.kind,kind);assert.equal(event.data.digest,vd(snapshot.value),'A fixture claim is not an original Runtime observation');return snapshot.value;
}
export function assertPartialOwnerRecovery(history,failedOwner){
 assert(owners.includes(failedOwner));const other=owners.find(o=>o!==failedOwner),bad=history[failedOwner],good=history[other];assert(bad.length>=2&&good.length>=1);assert(bad.some(s=>s.value.status==='UNKNOWN'),'NOT_READY: actual unknown owner observation required');const firstUnknown=bad.find(s=>s.value.status==='UNKNOWN');assert(good.some(s=>s.sequence<firstUnknown.sequence&&s.value.receiptDigest),'Another owner must already have succeeded before the selected uncertainty');const last=bad.at(-1);assert(last.sequence>firstUnknown.sequence);assert(['REVIEW_REQUIRED','REUSE_APPROVED','REBIND_REQUIRED','REJECTED'].includes(last.value.status));assert(last.value.receiptDigest);const receipt=good[0].value.receiptDigest;assert(receipt&&good.every(s=>['REVIEW_REQUIRED','REUSE_APPROVED','REBIND_REQUIRED'].includes(s.value.status)&&s.value.receiptDigest===receipt),'Recovery must preserve the other owner receipt');for(const steps of [bad,good])for(let i=1;i<steps.length;i++)assert(steps[i].sequence>steps[i-1].sequence);return{firstUnknownSequence:firstUnknown.sequence,recoveredSequence:last.sequence,preservedOwner:other,preservedReceiptDigest:receipt};
}
async function ownerFeedbackCase(run,c){
 assert(run.selection.ownerFeedback,'NOT_READY: exact actual ownerFeedback selection required');const fixture=ownerPin(run.selection.ownerFeedback),plan=validateOwnerCaseFixture(fixture,run.selection,c.caseInstanceId),started=Date.now(),deadline=started+600000,time=()=>assert(Date.now()<deadline,'Original bounded owner readback window exhausted');
 const load=p=>import(pathToFileURL(path.join(run.selection.installedRoot,'package',p)).href),[{evidenceValueDigest:vd},{nativeSha256},{verifyNativeStageResult},{validateFeedbackEvent},configApi,ownerApi,control,security,feedbackApi]=await Promise.all([load('dist/server/errors.js'),load('vendor/compatibility/v1/native.mjs'),load('dist/adapters/stages.js'),load('vendor/compatibility/feedback/v1/feedback.mjs'),load('dist/adapters/config.js'),load('dist/adapters/published-owners.js'),load('dist/installation/service-control.js'),load('dist/server/security.js'),load('dist/adapters/feedback.js')]);
 const spec=JSON.parse(fs.readFileSync(path.join(run.selection.installedRoot,'service-specification.json')));assert(spec.integrationsRef);assert.equal(JSON.parse(fs.readFileSync(path.join(run.selection.installedRoot,'installation-plan.json'))).codex,null);const configBytes=fs.readFileSync(spec.integrationsRef),config=configApi.readIntegrationConfiguration(spec.integrationsRef,run.selection.workspaceId),inventory=(await events(run)).rows,initialDefinition=await run.read('lifecycle.definition.inspect'),originals=new Map(),registrations={};
 const actor=()=>{const a=security.currentPrincipal(path.join(run.selection.installedRoot,'data'),run.selection.workspaceId,run.principal().principalId);assert(a);security.authorize(a,run.selection.projectId,'read');return a;};
 for(const owner of owners){const matches=config.owners.filter(o=>o.owner===owner&&o.workspaceId===run.selection.workspaceId&&o.projects.includes(run.selection.projectId));assert.equal(matches.length,1);assert.deepEqual(matches[0].projects,[run.selection.projectId]);registrations[owner]=matches[0];assert.equal(ownerApi.verifyOwnerDistribution(owner,matches[0].packageRoot).version,'0.8.3');for(const leaf of ['workspace.json',path.join('state',owner,owner+'.db')])assert(fs.lstatSync(path.join(matches[0].workspaceRoot,leaf)).isFile());}
 async function record(ref,expected){
  ownerExact(ref,['instanceId','verificationRequestId','codingSourceSelection','exchangeRoot']);time();const inspected=await run.read('lifecycle.instance.inspect',{instanceId:ref.instanceId}),i=inspected.instance;assert.equal(i.pins.projectId,run.selection.projectId);assert.equal(i.stages.verification.requestId,ref.verificationRequestId);assert.equal(i.stages.verification.status,expected==='FAILED'?'FAILED':'PASSED');
  const r=await run.read('lifecycle.stage.request.inspect',{stageRequestId:ref.verificationRequestId}),{digest,...body}=r.request;assert.equal(digest,vd(body));assert.equal(r.request.planDigest,vd(r.request.plan));assert.equal(r.request.pinsDigest,i.pinsDigest);assert.equal(r.request.instanceId,i.id);assert.equal(r.request.stageId,'verification');assert.equal(r.request.plan.adapterId,'runtime-ci-owner-stage-v2');assert.equal(r.progress.phase,expected==='FAILED'?'FAILED':'COMPLETE');assert.equal(r.progress.terminal,true);assert.equal(r.automaticRedispatch,false);assert.equal(r.workerError,null);
  const readback=await run.read('lifecycle.verification.feedback.read',{stageRequestId:r.request.id}),event=readback.event;validateFeedbackEvent(event);assert.equal(event.origin,'registered-runtime-run');assert.equal(event.stage,expected);assert.equal(event.id,nativeSha256({workspaceId:run.selection.workspaceId,scope:event.scope,claimId:vd({stageRequestDigest:r.request.digest})}));assert.equal(event.inputDigest,r.request.inputDigest);assert.equal(event.runId,'verification:'+r.request.id);assert.equal(event.projectCandidateDigest,i.candidateDigest);assert.equal(event.runReviewDigest,r.request.planDigest);assert.equal(event.source.revision,r.request.plan.parameters.commit);assert.equal(readback.releaseAuthorized,false);
  const predecessorRequests={};for(const id of ['scope','plan','implementation','candidate']){assert.equal(i.stages[id].status,'PASSED');assert(i.stages[id].requestId);const retained=await run.read('lifecycle.stage.request.inspect',{stageRequestId:i.stages[id].requestId});assert.equal(retained.request.instanceId,i.id);assert.equal(retained.request.pinsDigest,i.pinsDigest);assert.equal(retained.progress.phase,'COMPLETE');assert.equal(retained.progress.terminal,true);assert.equal(retained.automaticRedispatch,false);assert.equal(retained.workerError,null);const raw=await run.read('lifecycle.stage.observation.read',{stageRequestId:retained.request.id,observationRef:retained.progress.observationRef});assert.equal(raw.observationRef,vd(raw.evidence));assert.deepEqual(raw.evidence.observation,retained.progress.observation);assert.equal(vd(raw.evidence.observation.outcome),i.stages[id].outcomeDigest);predecessorRequests[id]=retained;}
  const p=r.request.plan.parameters,verdicts={};for(const owner of owners){const pin=p.owners[owner];assert.deepEqual(event.pins[owner],pin.reference);const mapping=config.resources.find(x=>x.ref===i.definition.semantic.assets[owner].mappingRef);assert(mapping&&mapping.definition.evidenceOrigin==='SYNTHETIC');assert.deepEqual(mapping.definition.reference,pin.reference);const context={workspaceId:r.request.workspaceId,scope:event.scope,projectCandidateDigest:i.candidateDigest,claimId:event.claimId,inputDigest:r.request.inputDigest,effectiveConfigDigest:p.effectiveConfigDigest,sourceScopeDigest:nativeSha256(p.sourceScope),requirementSetDigest:i.pins.requirementsDigest},request={operation:'native.package.validate',scope:pin.scope,input:{id:pin.reference.id,version:pin.reference.version,context,...(owner==='harness'?{observation:event.observation}:{})},requestId:'stage-native-'+vd({requestId:r.request.id,projectId:r.request.projectId,owner}).slice(7,55)};
   // Derive the expected original request from the native Runtime event and its
   // retained stage plan; no action or receipt is submitted or dispatched.
   const expectedAction={request,context,observationDigest:owner==='harness'?nativeSha256(event.observation):null};verdicts[owner]=verifyNativeStageResult(event.results[owner],owner,pin,expectedAction,p.toolchainLockDigest,p.effectiveConfigDigest);assert(['PASS','FAIL'].includes(verdicts[owner].status));}
  const platformApi=await load('dist/adapters/platforms.js'),artifactApi=await load('dist/adapters/artifacts.js'),provider=p.binding.provider;assert(['github','gitlab'].includes(provider));assert.deepEqual(configApi.configuredPlatform(config,actor(),run.selection.projectId,p.binding.ref),p.binding);
  const module=await load('dist/adapters/'+provider+'.js'),client=module[provider==='github'?'githubClient':'gitlabClient'](p.binding,async(binding,principal)=>configApi.readPlatformToken(spec.integrationsRef,binding,principal)),ci=platformApi.validateRunRequest({schema:'runtime-ci-request/v1',requestId:'stage-'+vd({workspaceId:r.request.workspaceId,projectId:r.request.projectId,requestId:r.request.id}).slice(7,55),projectId:r.request.projectId,bindingDigest:vd(p.binding),commit:p.commit,workflowDigest:p.workflowDigest,inputDigest:r.request.inputDigest,stageId:'verification',candidateDigest:p.candidateDigest,candidateInput:p.candidateInput,requestedAt:r.request.requestedAt,deadlineAt:r.request.deadlineAt},p.binding),observedCI=await client.run(actor(),ci,null,AbortSignal.timeout(30000));assert.equal(observedCI.status,'PASSED');assert.equal(observedCI.requestId,ci.requestId);assert.equal(observedCI.commit,event.source.revision);assert.equal(observedCI.inputDigest,event.inputDigest);assert(observedCI.jobs.length>0&&observedCI.jobs.every(j=>j.status==='PASSED'));
  const transport=platformApi.platformReader(p.binding,async(binding,principal)=>configApi.readPlatformToken(spec.integrationsRef,binding,principal)),rawRun=await transport.get(actor(),provider==='github'?'/actions/runs/'+observedCI.runId:'/pipelines/'+observedCI.runId,AbortSignal.timeout(15000));if(provider==='github'){assert.equal(rawRun.run_attempt,1);assert.equal(rawRun.head_sha,p.commit);}else{const jobs=await transport.get(actor(),'/pipelines/'+observedCI.runId+'/jobs?include_retried=true&per_page=100&page=1',AbortSignal.timeout(15000));assert(jobs.length<100);assert.equal(new Set(jobs.map(j=>j.stage+'\0'+j.name)).size,jobs.length);assert.deepEqual(jobs.map(j=>String(j.id)).sort(),observedCI.jobs.map(j=>j.jobId).sort());run.artifact('owner-ci-original-attempts.json',{instanceId:i.id,jobs});}
  const archive=await client.artifact(actor(),ci,observedCI.runId,AbortSignal.timeout(60000));assert(archive.bytes.length<=8388608);const verified=await artifactApi.verifyCiArtifact(archive,ci,p.expectedChecks,AbortSignal.timeout(30000));assert.equal(verified.status,'PASSED');assert.equal(verified.candidateDigest,i.candidateDigest);assert.deepEqual(event.collectionRefs,[{id:'ci-stage:'+r.request.id,digest:verified.resultDigest}]);run.artifact('owner-independent-original-ci.json',{instanceId:i.id,request:ci,observed:observedCI,rawRun,verified,ownerOutcomeNotInferredFromCI:true});for(let offset=0;offset<archive.bytes.length;offset+=262144){const bytes=archive.bytes.subarray(offset,offset+262144);run.artifact('owner-original-ci-archive-part.json',{instanceId:i.id,archiveDigest:archive.archiveDigest,archiveBytes:archive.bytes.length,offset,sha256:sha(bytes),base64:bytes.toString('base64')});}
  const observed=await run.read('lifecycle.stage.observation.read',{stageRequestId:r.request.id,observationRef:r.progress.observationRef});assert.equal(observed.observationRef,vd(observed.evidence));assert.deepEqual(observed.evidence.observation,r.progress.observation);assert.equal(vd(r.progress.observation.outcome),i.stages.verification.outcomeDigest);
  const handoff=await run.read('lifecycle.agent.handoff.read',{stageRequestId:i.stages.implementation.requestId}),reported=await run.read('lifecycle.agent.report.read',{stageRequestId:i.stages.implementation.requestId});assert(handoff.claim&&reported.report?.state==='SUBMITTED');assert.equal(reported.report.result.commit,p.commit);const selectedHost=ownerPin(ref.codingSourceSelection),hostRun={...run,selection:{...run.selection,lifecycleExecution:{exchangeRoot:ref.exchangeRoot}}},hostProof=await proveOriginalCodingHost(hostRun,selectedHost,handoff.handoff,reported.report,handoff.claim,spec.nodeExecutable,vd);
  const saved={i,r,event,readback,verdicts,hostProof,predecessorRequests};originals.set(i.id,saved);run.artifact('owner-original-native-run.json',{ref,expected,instance:i,request:r,feedback:readback,observation:observed,verdicts});return saved;
 }
 function recovery(runRecord,selection){
  ownerExact(selection,['run','failedOwner','deliveries','observations']);assert(owners.includes(selection.failedOwner));const history={};for(const owner of owners){const delivery=ownerPin(selection.deliveries[owner]),d=assertOwnerHistorySnapshot(delivery,inventory,'owner-feedback-delivery',runRecord.event.id+':'+owner,vd),{digest,...body}=d;assert.equal(digest,vd(body));assert.equal(d.eventId,runRecord.event.id);assert.equal(d.eventDigest,runRecord.event.digest);assert.equal(d.owner,owner);assert.equal(d.request.operation,'feedback.ingest');assert.deepEqual(d.request.input,{id:runRecord.event.id,digest:runRecord.event.digest});assert.equal(d.requestDigest,ownerApi.ownerRequestDigest(owner,d.request));assert.equal(d.request.requestId,'runtime-feedback-'+nativeSha256({workspaceId:run.selection.workspaceId,projectId:run.selection.projectId,eventId:runRecord.event.id,owner}).slice(7));assert.equal(inventory.filter(e=>e.type==='owner-feedback-observed'&&e.data.kind==='owner-feedback-delivery'&&e.data.id===runRecord.event.id+':'+owner).length,1,'Original unknown owner delivery must not be redispatched');history[owner]=selection.observations[owner].map(pin=>ownerPin(pin));for(const step of history[owner])assertOwnerHistorySnapshot(step,inventory,'owner-feedback-observation',runRecord.event.id+':'+owner,vd);}
  const proof=assertPartialOwnerRecovery(history,selection.failedOwner);run.artifact('owner-original-partial-recovery.json',{eventId:runRecord.event.id,history,deliveries:selection.deliveries,proof,redispatches:0});return{record:runRecord,history,proof};
 }
 const inboxes=[];
 if(c.caseInstanceId==='E16.journey'){
  ownerExact(plan,['harnessFailure','ontologyFailure','recovery']);const harness=await record(plan.harnessFailure,'FAILED'),ontology=await record(plan.ontologyFailure,'FAILED');assert.notEqual(harness.i.id,ontology.i.id);assert.equal(harness.verdicts.harness.status,'FAIL');assert.equal(harness.verdicts.ontology.status,'PASS');assert.equal(ontology.verdicts.ontology.status,'FAIL');assert.equal(ontology.verdicts.harness.status,'PASS');
  for(const failed of [harness,ontology]){const admission=await run.read('lifecycle.stage.admission',{instanceId:failed.i.id,stageId:'release-decision'});assert.equal(admission.allowed,false);assert(admission.reasons.includes('PREDECESSOR_NOT_PASSED:verification'));run.artifact('owner-failure-native-admission.json',{instanceId:failed.i.id,verdicts:failed.verdicts,admission});}
  const recovered=await record(plan.recovery.run,'SUCCEEDED');inboxes.push(recovery(recovered,plan.recovery));
 }else if(c.caseInstanceId==='E16.variant.01'){ownerExact(plan,['recovery']);inboxes.push(recovery(await record(plan.recovery.run,'SUCCEEDED'),plan.recovery));}
 else{ownerExact(plan,['reuse','deliver','rebound','qualification']);for(const mode of ['reuse','deliver']){const item=await record(plan[mode],'SUCCEEDED');inboxes.push({record:item,expectedMode:mode==='reuse'?'REUSE':'DELIVER'});}const rebound=await record(plan.rebound,'SUCCEEDED');for(const old of inboxes){assert.notEqual(rebound.i.id,old.record.i.id);}await qualificationReuse(run,plan.qualification,inventory,ownerPin,vd);}
 // Independent native owner readback needs the original single-writer service
 // quiescent. No unknown/live business action is interrupted by this collector.
 const ids=[...new Set(inventory.filter(e=>e.type==='lifecycle-instance-created').map(e=>e.data.instanceId))];for(const id of ids){const i=(await run.read('lifecycle.instance.inspect',{instanceId:id})).instance;assert(Object.values(i.stages).every(s=>!['RUNNING','UNKNOWN'].includes(s.status)),'NOT_READY: inspect original unknown business actions before independent owner readback');}
 assert.equal((await run.read('runtime.status')).observationWorker.inFlight,0,'NOT_READY: dedicated service must be idle before owner snapshot');const selected=control.inspectInstalledServiceSelection(run.selection.installedRoot),serviceBefore=await control.operateInstalledService(selected,'inspect');assert.equal(serviceBefore.service.running,true);assert.equal(serviceBefore.service.identity.serviceId,selected.serviceId);run.artifact('owner-independent-initial-service.json',serviceBefore);let stopped=false,failure,cleanup;
 try{
  time();const stoppedView=await control.operateInstalledService(selected,'stop');assert.equal(stoppedView.service.running,false);stopped=true;run.artifact('owner-independent-service-stop.json',stoppedView);
  for(const owner of owners){const registration=registrations[owner],api=await import(pathToFileURL(path.join(registration.packageRoot,'dist/service.js')).href),native=api[owner==='ontology'?'createOntologyService':'createHarnessService']({workspaceRoot:registration.workspaceRoot,workspaceId:registration.workspaceId},{});try{native.initialize();const before=await native.feedback({operation:'feedback.inspect',scope:{visibility:'private',projectId:run.selection.projectId},input:{}});
   for(const saved of originals.values()){const receipt=await native.native({operation:'native.receipt.inspect',scope:saved.event.scope,input:{requestId:saved.event.results[owner].requestId}});assert.deepEqual(receipt,saved.event.results[owner]);run.artifact('owner-independent-original-receipt.json',{owner,instanceId:saved.i.id,receipt});}
   for(const entry of inboxes){const inbox=await native.feedback({operation:'feedback.read',scope:entry.record.event.scope,input:{id:entry.record.event.id}}),checked=feedbackApi.verifyOwnerFeedbackInbox(inbox,entry.record.event,owner);if(entry.history)assert.deepEqual(checked,entry.history[owner].at(-1).value);if(entry.expectedMode){assert.equal(inbox.review.mode,entry.expectedMode);assert.equal(inbox.disposition.decision,'APPROVE');assert.equal(checked.status,entry.expectedMode==='REUSE'?'REUSE_APPROVED':'REBIND_REQUIRED');if(entry.expectedMode==='DELIVER'){const rebound=originals.get(plan.rebound.instanceId);assert.deepEqual(rebound.event.pins[owner],inbox.review.reference);assert.notDeepEqual(rebound.event.pins[owner],entry.record.event.pins[owner]);for(const oldNode of entry.record.i.definition.nodes){const nextNode=rebound.i.definition.nodes.find(n=>n.id===oldNode.id);assert(nextNode&&oldNode.checks.every(id=>nextNode.checks.includes(id)),'DELIVER cannot remove original required checks');}}}
    run.artifact('owner-independent-feedback-inbox.json',{owner,eventId:entry.record.event.id,inbox,checked,expectedMode:entry.expectedMode??null});}
   assert.deepEqual(await native.feedback({operation:'feedback.inspect',scope:{visibility:'private',projectId:run.selection.projectId},input:{}}),before);
  }finally{native.close();}}
 }catch(error){failure=error;}finally{if(stopped)try{const restored=await control.operateInstalledService(selected,'start');assert.equal(restored.service.running,true);assert.equal(restored.service.identity.serviceId,selected.serviceId);run.artifact('owner-independent-service-restored.json',restored);}catch(error){cleanup=error;run.artifact('owner-service-cleanup-failure.json',{message:error.message,stack:error.stack});}}
 if(failure&&cleanup)throw new AggregateError([failure,cleanup],'Original owner readback and service cleanup failed');if(failure)throw failure;if(cleanup)throw cleanup;
 for(const saved of originals.values()){assert.deepEqual((await run.read('lifecycle.instance.inspect',{instanceId:saved.i.id})).instance,saved.i);assert.deepEqual(await run.read('lifecycle.stage.request.inspect',{stageRequestId:saved.r.request.id}),saved.r);assert.deepEqual(await run.read('lifecycle.verification.feedback.read',{stageRequestId:saved.r.request.id}),saved.readback);for(const retained of Object.values(saved.predecessorRequests))assert.deepEqual(await run.read('lifecycle.stage.request.inspect',{stageRequestId:retained.request.id}),retained);run.artifact('owner-original-host-recheck.json',saved.hostProof.revalidate());}
 assert.deepEqual((await events(run)).rows,inventory);assert.deepEqual(await run.read('lifecycle.definition.inspect'),initialDefinition);assert.deepEqual(fs.readFileSync(spec.integrationsRef),configBytes);assert.deepEqual(ownerPin(run.selection.ownerFeedback),fixture);time();return{actualOriginalNativeRuns:[...originals.keys()],independentPublishedOwnerReadback:true,originalInstancesRequestsAndEventsUnchanged:true,originalFeedbackDeliveryRequestsRetained:true,newNativeEvaluations:0,newOwnerDecisions:0,newBusinessRuns:0,newCIOrAgentCalls:0,softwareAcceptanceNotInferredFromAssetGrades:true,elapsedMs:Date.now()-started};
}

export function assertCurrentOwnerReuse(q){
 assert.equal(q.schema,'runtime-evidence-qualification/v2');assert.equal(q.caseId,'LC20');assert.equal(q.formalAcceptanceEligible,true,'NOT_READY: genuine fixed LC20 producer required, never closed/probe records');assert.equal(q.status,'QUALIFIED');assert.equal(q.mode,'PASS_REUSED');assert.equal(q.phase,'PRE_RELEASE');assert.notEqual(q.originalCandidateDigest,q.currentCandidateDigest);assert.equal(q.releaseAuthorized,false);assert.equal(q.executionAuthorized,false);assert.equal(q.establishesEnvironmentState,false);assert(Number.isFinite(Date.parse(q.expiresAt))&&Date.parse(q.expiresAt)>Date.now());assert(q.nativeReceiptDigest&&q.nativeReportDigest&&q.originalReceiptRef&&q.originalRawBytesRef);assert.deepEqual(q.reasons,[]);
}
async function qualificationReuse(run,plan,inventory,pin,vd){
 ownerExact(plan,['valid','expired','knownDefect','candidateOrigin','foreignProjectId','revokedConnection']);const load=p=>import(pathToFileURL(path.join(run.selection.installedRoot,'package',p)).href),{qualifyEvidence}=await load('dist/lifecycle/evidence-qualification.js'),security=await load('dist/server/security.js');
 async function original(item,read=(op,input)=>run.read(op,input),originalEvents=inventory,projectId=run.selection.projectId){
  ownerExact(item,['actionRef','snapshot','origin']);const snapshot=pin(item.snapshot),a=assertOwnerHistorySnapshot(snapshot,originalEvents,'qualification-native-action',item.actionRef,vd);assert.equal(a.schema,'runtime-native-qualification-action/v2');const{digest,...body}=a;assert.equal(digest,vd(body));assert.equal(a.factsDigest,vd(a.facts));assert.equal(a.selection.caseId,'LC20');assert.equal(a.selection.scope.projectId,projectId);assert.equal(a.selection.scope.workspaceId,run.selection.workspaceId);
  const observed=await read('lifecycle.qualification.action.inspect',{actionRef:item.actionRef});assert.equal(observed.actionDigest,a.digest);assert.equal(observed.originalRequestId,a.action.request.requestId);assert.equal(observed.dispatchRetained,true);assert.equal(observed.automaticRedispatch,false);assert(observed.nativeReceiptDigest&&observed.nativeReportDigest,'NOT_READY: actual published-owner assessment receipt required');
  ownerExact(item.origin,['registrationRef','caseId','originRef']);assert.equal(item.origin.caseId,'LC20');const origin=await read('lifecycle.qualification.origin.inspect',item.origin);assert.equal(origin.producer,'REGISTERED_LC20');assert.equal(origin.formalAcceptanceEligible,true);assert.equal(origin.originalExecutionDigest,a.selection.originalExecutionDigest);assert.deepEqual(origin.original,a.facts.input.original);return{a,observed,origin};
 }
 const valid=await original(plan.valid),q=await run.read('lifecycle.qualification.inspect',{actionRef:plan.valid.actionRef});assertCurrentOwnerReuse(q);assert.equal(q.actionDigest,valid.a.digest);assert.equal(valid.observed.observedStatus,'PASS');assert.equal(q.nativeReceiptDigest,valid.observed.nativeReceiptDigest);assert.equal(q.nativeReportDigest,valid.observed.nativeReportDigest);assert.equal(q.originalExecutionDigest,valid.origin.originalExecutionDigest);assert.equal(q.currentCandidateDigest,valid.a.selection.currentCandidateDigest);assert.equal(q.scope.projectId,run.selection.projectId);assert.equal(q.scope.workspaceId,run.selection.workspaceId);
 // Fixed negative adapter probes start with authenticated actual LC20 records.
 // Mutated scope/candidate inputs below are explicitly marked fault inputs;
 // they are never imported as protected facts or submitted as owner outcomes.
 const expired=await original(plan.expired);assert(Date.parse(expired.a.facts.input.original.expiresAt)<=Date.now(),'NOT_READY: genuinely expired original evidence required');
 ownerExact(plan.candidateOrigin,['registrationRef','caseId','originRef']);assert.equal(plan.candidateOrigin.caseId,'LC20');const other=await run.read('lifecycle.qualification.origin.inspect',plan.candidateOrigin);assert.equal(other.producer,'REGISTERED_LC20');assert.equal(other.formalAcceptanceEligible,true);assert.notEqual(other.currentCandidateDigest,q.currentCandidateDigest,'NOT_READY: a real different candidate context is required');
 assert(typeof plan.foreignProjectId==='string'&&plan.foreignProjectId!==run.selection.projectId);const wrongScope=structuredClone(valid.a.facts.input);wrongScope.scope.projectId=plan.foreignProjectId;const wrongCandidate=structuredClone(valid.a.facts.input);wrongCandidate.currentCandidateDigest=other.currentCandidateDigest;
 ownerExact(plan.knownDefect,['good','connection','failureRequestId']);const knownDescriptor=pin(plan.knownDefect.connection);ownerExact(knownDescriptor,['connectionRef','connectionSha256']);const knownFile=fs.lstatSync(knownDescriptor.connectionRef);assert(knownFile.isFile()&&!knownFile.isSymbolicLink()&&knownFile.nlink===1&&knownFile.uid===process.getuid()&&(knownFile.mode&0o077)===0);assert.equal(sha(fs.readFileSync(knownDescriptor.connectionRef)),knownDescriptor.connectionSha256);const knownConnection=security.readHostConnection(knownDescriptor.connectionRef);assert.equal(knownConnection.origin,run.serviceOrigin);assert.equal(knownConnection.serviceId,run.candidate.serviceId);assert.equal(knownConnection.workspaceId,run.selection.workspaceId);assert.notEqual(knownConnection.projectId,run.selection.projectId,'Known-failure history must not invalidate the primary simultaneous positive');
 const knownRead=async(operation,input={})=>{assert(['runtime.status','runtime.events.read','lifecycle.qualification.action.inspect','lifecycle.qualification.origin.inspect','lifecycle.stage.request.inspect','lifecycle.stage.observation.read','lifecycle.instance.inspect'].includes(operation));const request={operation,projectId:knownConnection.projectId,input},response=await fetch(run.serviceOrigin+'/api/v1/request',{method:'POST',headers:{...security.hostHeaders(knownConnection),'content-type':'application/json'},body:JSON.stringify(request),redirect:'error',signal:AbortSignal.timeout(30000)}),raw=await response.text();assert(Buffer.byteLength(raw)<=1048576);const body=JSON.parse(raw);run.artifact('cv06-isolated-known-project-read.json',{request,status:response.status,rawBody:raw,credentialValuesOmitted:true});assert.equal(response.status,200,'NOT_READY: actual isolated known-defect readback required');return body.result;};
 const knownStatus=await knownRead('runtime.status');assert.equal(knownStatus.serviceId,run.candidate.serviceId);assert.equal(knownStatus.workspaceId,run.selection.workspaceId);const knownInventory=(await events({read:knownRead})).rows,known=await original(plan.knownDefect.good,knownRead,knownInventory,knownConnection.projectId),failed=await knownRead('lifecycle.stage.request.inspect',{stageRequestId:plan.knownDefect.failureRequestId}),failedObservation=await knownRead('lifecycle.stage.observation.read',{stageRequestId:failed.request.id,observationRef:failed.progress.observationRef});
 const knownActionSequence=pin(plan.knownDefect.good.snapshot).sequence,failedCreation=knownInventory.filter(e=>e.type==='stage-requested'&&e.data.stageRequestId===failed.request.id),failedEvents=knownInventory.filter(e=>e.type==='stage-observed'&&e.data.stageRequestId===failed.request.id&&e.data.observationRef===failed.progress.observationRef&&e.data.phase==='FAILED');assert.equal(failedCreation.length,1);assert(failedCreation[0].seq>knownActionSequence);assert.equal(failedEvents.length,1);assert(failedEvents[0].seq>failedCreation[0].seq);
 for(const id of new Set(knownInventory.filter(e=>e.type==='lifecycle-instance-created').map(e=>e.data.instanceId))){const peerInstance=(await knownRead('lifecycle.instance.inspect',{instanceId:id})).instance;assert(Object.values(peerInstance.stages).every(s=>!['RUNNING','UNKNOWN'].includes(s.status)),'NOT_READY: known-defect project must be quiescent before service-owner readback');}
 const knownProtocol=await knownRead('lifecycle.qualification.origin.inspect',{...plan.knownDefect.good.origin,originRef:'stage-request:'+failed.request.id,protocol:'runtime-lc20-local-installed/v1'});assert.equal(knownProtocol.schema,'runtime-lc20-protocol-readback/v1');assert.equal(knownProtocol.stageRequestId,failed.request.id);assert.equal(knownProtocol.stageRequestDigest,failed.request.digest);assert.equal(knownProtocol.mode,'EXECUTE');assert.equal(knownProtocol.original.status,'COMPLETE','NOT_READY: original actual LC20 producer input observation required');assert.equal(knownProtocol.contractDigest,failed.request.plan.parameters.qualificationProducer.contractDigest);
 const knownInput=deriveLaterOwnerFailure(known.a,failed,failedObservation,{workspaceId:knownConnection.workspaceId,projectId:knownConnection.projectId},vd);
 const knownDenyRequest={operation:'lifecycle.qualification.inspect',projectId:knownConnection.projectId,input:{actionRef:plan.knownDefect.good.actionRef}},knownDenyResponse=await fetch(run.serviceOrigin+'/api/v1/request',{method:'POST',headers:{...security.hostHeaders(knownConnection),'content-type':'application/json'},body:JSON.stringify(knownDenyRequest),redirect:'error',signal:AbortSignal.timeout(30000)}),knownDenyRaw=await knownDenyResponse.text();assert(Buffer.byteLength(knownDenyRaw)<=262144);const knownDeny=JSON.parse(knownDenyRaw);assert.equal(knownDenyResponse.status,409);assert(['QUALIFICATION_EXECUTION_REQUIRED','QUALIFICATION_FACTS_CHANGED'].includes(knownDeny.error?.code));assert(!Object.hasOwn(knownDeny,'result'));
 run.artifact('cv06-authentic-later-lc20-failure.json',{separateProjectId:knownConnection.projectId,primaryProjectId:run.selection.projectId,originalGoodAction:known.a,originalGoodAssessmentReadback:known.observed,originalGoodSource:known.origin,actualLaterFailure:failed,originalFailureObservation:failedObservation,producerProtocol:knownProtocol,currentNativeDeny:{request:knownDenyRequest,status:knownDenyResponse.status,rawBody:knownDenyRaw},derivedNegativeInput:knownInput,derivation:'APPEND_ACTUAL_LATER_STAGE_FAILURE_FOR_EXPLICIT_INSTALLED_NEGATIVE_PROBE_NOT_PROTECTED_HISTORY_IMPORT',noNewAssessmentAfterFailure:true,noScopeRelabel:true});
 const negative=[['expired',expired.a.facts.input,'ORIGINAL_EVIDENCE_EXPIRED',false],['scope',wrongScope,'ORIGINAL_EVIDENCE_SCOPE_MISMATCH',true],['candidate',wrongCandidate,'INPUT_MANIFEST_BINDING_MISMATCH',true],['known-defect',knownInput,'FAILURE_HISTORY_REQUIRES_EXECUTION',false]],results=[];
 for(const [name,input,reason,faultInjected]of negative){const result=await qualifyEvidence(input,undefined,Date.now(),AbortSignal.timeout(30000));assert.equal(result.status,'EXECUTION_REQUIRED');assert.equal(result.mode,null);assert(result.reasons.includes(reason),'NOT_READY: the specific invalidity must refuse independently of missing owner policy');run.artifact('cv06-original-lc20-negative-adapter.json',{name,provenance:'EXACT_INSTALLED_DETERMINISTIC_ADAPTER_PROBE_NOT_PROTECTED_FACTS_IMPORT',faultInjected,inputDerivation:name==='known-defect'?'ACTUAL_LATER_FAILURE_OBSERVATION_NOT_PROTECTED_HISTORY_IMPORT':faultInjected?'EXPLICIT_FAULT_INPUT':'AUTHENTIC_ORIGINAL_INPUT',input,result,specificReason:reason,missingPolicyNotUsedAsVerdict:true});results.push({name,reason});}
 const revoked=pin(plan.revokedConnection);ownerExact(revoked,['connectionRef','connectionSha256']);const st=fs.lstatSync(revoked.connectionRef);assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.uid===process.getuid()&&(st.mode&0o077)===0);assert.equal(sha(fs.readFileSync(revoked.connectionRef)),revoked.connectionSha256);const connection=security.readHostConnection(revoked.connectionRef);assert.equal(connection.origin,run.serviceOrigin);assert.equal(connection.serviceId,run.candidate.serviceId);assert.equal(connection.workspaceId,run.selection.workspaceId);assert.equal(connection.projectId,run.selection.projectId);assert.notEqual(connection.principalId,run.principal().principalId);
 const principal=security.currentPrincipal(path.join(run.selection.installedRoot,'data'),run.selection.workspaceId,connection.principalId);assert(principal&&!principal.permissions.includes('read'),'NOT_READY: actual current read permission revocation required');const request={operation:'lifecycle.qualification.inspect',projectId:run.selection.projectId,input:{actionRef:plan.valid.actionRef}},response=await fetch(run.serviceOrigin+'/api/v1/request',{method:'POST',headers:{...security.hostHeaders(connection),'content-type':'application/json'},body:JSON.stringify(request),redirect:'error',signal:AbortSignal.timeout(30000)}),raw=await response.text();assert(Buffer.byteLength(raw)<=262144);const body=JSON.parse(raw);assert.equal(response.status,403);assert.equal(body.error?.code,'FORBIDDEN');assert(!Object.hasOwn(body,'result'));run.artifact('cv06-actual-current-permission-refusal.json',{request,status:response.status,rawBody:raw,principalId:connection.principalId,priorCachedQualification:q,credentialValuesOmitted:true});
 assert.deepEqual(await run.read('lifecycle.qualification.inspect',{actionRef:plan.valid.actionRef}),q);assert.deepEqual(pin(plan.valid.snapshot).value,valid.a);assert.deepEqual(pin(plan.expired.snapshot).value,expired.a);assert.deepEqual(pin(plan.knownDefect.good.snapshot).value,known.a);assert.deepEqual(await knownRead('lifecycle.stage.request.inspect',{stageRequestId:failed.request.id}),failed);assert.deepEqual((await events({read:knownRead})).rows,knownInventory);run.artifact('cv06-current-real-owner-reuse.json',{qualification:q,protectedOrigin:valid.origin,originalAction:valid.a,originalOwnerReadback:valid.observed,negativePredicates:results,actualRevokedPrincipal:true,rawExecutionNotRepeated:true,lc20OwnCaseNotCredited:true});
}

export function deriveLaterOwnerFailure(good,failed,observed,knownScope,vd){
 const input=good.facts.input;assert.equal(good.selection.caseId,'LC20');assert.equal(input.caseId,'LC20');assert.equal(input.scope.workspaceId,knownScope.workspaceId);assert.equal(input.scope.projectId,knownScope.projectId);assert.equal(good.selection.scope.projectId,knownScope.projectId);assert(input.history.length>0&&input.history.every(h=>h.outcome==='PASS'),'A genuinely prepared reuse assessment cannot already contain failed history');assert.notEqual(input.original.candidateDigest,input.currentCandidateDigest);
 const r=failed.request,{digest,...body}=r;assert.equal(digest,vd(body));assert.equal(r.planDigest,vd(r.plan));assert.equal(r.workspaceId,knownScope.workspaceId);assert.equal(r.projectId,knownScope.projectId);assert.notEqual(r.id,good.action.request.requestId);assert(Date.parse(r.requestedAt)>Date.parse(good.assessedAt),'The failing claim must be created after the original valid assessment');assert(Date.parse(r.requestedAt)<=Date.now());const pin=r.plan.parameters.qualificationProducer;assert(pin&&pin.mode==='EXECUTE');assert.equal(pin.contract.caseId,'LC20');assert.equal(pin.contractDigest,vd(pin.contract));assert.equal(pin.contract.catalogDigest,good.selection.scope.acceptanceScopeDigest);assert.equal(pin.policyReferenceDigest,good.facts.policy.owner.reference.digest);
 assert.equal(failed.progress.phase,'FAILED');assert.equal(failed.progress.terminal,true);assert.equal(failed.workerError,null);assert.equal(failed.automaticRedispatch,false);assert.equal(observed.observationRef,failed.progress.observationRef);assert.equal(observed.observationRef,vd(observed.evidence));assert.equal(observed.evidence.requestId,r.id);assert(Number.isFinite(Date.parse(observed.evidence.observedAt))&&Date.parse(observed.evidence.observedAt)>=Date.parse(r.requestedAt));assert.deepEqual(observed.evidence.observation,failed.progress.observation);const o=observed.evidence.observation;assert.equal(o.requestId,r.id);assert.equal(o.inputDigest,r.inputDigest);assert.equal(o.phase,'FAILED');assert.equal(o.outcome.status,'FAILED');
 const entry={executionDigest:vd({request:r.digest,outcome:'FAIL'}),candidateDigest:r.plan.parameters.candidateDigest??vd({request:r.digest,candidate:'UNKNOWN'}),rawReceiptDigest:observed.observationRef,outcome:'FAIL',executedAt:r.requestedAt};assert(!input.history.some(h=>h.executionDigest===entry.executionDigest));
 // Public stage evidence authenticates a later failure but does not expose the
 // whole managed-history object. This derived row is only a negative adapter
 // probe, never claimed to be an imported/protected CI archive history record.
 const probe=structuredClone(input);probe.history=[...probe.history,entry].sort((a,b)=>Date.parse(a.executedAt)-Date.parse(b.executedAt));return probe;
}
