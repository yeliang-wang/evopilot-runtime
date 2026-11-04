import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {openScenario,sha} from './support.mjs';

// This file consumes original records from the selected installed service. It
// never seeds a database, changes an instance outcome, dispatches CI, approves a
// release, fabricates provider responses, or treats a source test as installed
// acceptance. Write requests are limited to two explicitly denied instance
// entry probes and optional reconciliation of an already dispatched publication
// request, explicitly selected by allowReconciliation. Denied entry probes must
// leave both the instance and project revision unchanged.
//
// ciAuthority pins a private runtime-v090-ci-authority-fixture/v1 document:
// {schema,candidateDigest,workspaceId,projectId,syntheticAssets:true,
//  syntheticDecisions:true,casePlans:{[fixedCaseId]:plan}}.
// Stage plan: {instanceId,predecessorId}; predecessorId is null only for scope.
// Scope negative plans preserve the fixed outcome IDs but inspect actual entry
// prerequisites, as required by accepted CV03 (not a fictitious graph node):
// not-run: {scopePrerequisite:'authority-not-recorded',subject,authorityRef};
// failed: {scopePrerequisite:'authority-rejected',instanceId,
//          definitionRevisionId,authorityRef};
// unknown: {scopePrerequisite:'binding-observation-unknown',instanceId,authorityRef};
// missing-evidence: {scopePrerequisite:'required-preparation-document-missing',
//                   instanceId,authorityRef,documentRole}.
// Fault conditions and any explicitly synthetic REJECT are prepared outside
// this collector through native APIs / isolated owned inputs. It creates no
// decision and does not damage a dependency to manufacture the precondition.
// Provider plan: {provider,passing:{stageRequestId,runId},
//  oldCandidate:{stageRequestId,runId},rerun:{stageRequestId,runId},
//  skipped:{stageRequestId,runId},
//  release:{instanceId,authorityRef},
//  publication:{stageRequestId,unknownObservationRef,allowReconciliation:true}}.
// E18.journey selects {providers:[<github plan>,<gitlab plan>]}. No free-form
// operations, remote commands, authority evidence or supplied PASS are accepted.
// Fork credential loss and CV03/CV07 remain explicit obligations below until
// their original real fixtures can establish the exact frozen predicates.
const stages=['scope','plan','implementation','candidate','verification','release-decision','publication','closure'];
const outcomes=['not-run','failed','unknown','missing-evidence','passed'];
const hash=/^sha256:[a-f0-9]{64}$/;
const read=ref=>JSON.parse(fs.readFileSync(ref));
const missingEvidenceReasons=['CI_RESULT_MISSING','CI_CANDIDATE_MISSING','OWNER_OBSERVATION_MISSING'];
function keys(value,required){
 assert(value&&typeof value==='object'&&!Array.isArray(value));
 assert.deepEqual(Object.keys(value).sort(),[...required].sort(),'Fixture contains missing or unsupported fields');
}
function pinned(pin){
 keys(pin,['ref','sha256']);assert.equal(fs.realpathSync(pin.ref),pin.ref);
 const st=fs.lstatSync(pin.ref);assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.uid===process.getuid()&&(st.mode&0o077)===0&&st.size<=1048576);
 const bytes=fs.readFileSync(pin.ref);assert.equal(sha(bytes),pin.sha256);return JSON.parse(bytes);
}
function differentDigest(value){assert(hash.test(value));return 'sha256:'+(value[7]==='0'?'1':'0')+value.slice(8);}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('E18 installed CI evidence and exact release-authority mismatch',async()=>{
 const run=await openScenario('E18');
 try{
  assert(run.selection.ciAuthority,'Select the protected original CI/authority fixture; a historical source-test report is not a fixture');
  const fixture=pinned(run.selection.ciAuthority);
  keys(fixture,['schema','candidateDigest','workspaceId','projectId','syntheticAssets','syntheticDecisions','casePlans']);
  assert.equal(fixture.schema,'runtime-v090-ci-authority-fixture/v1');assert.equal(fixture.candidateDigest,run.candidateDigest);
  assert.equal(fixture.workspaceId,run.selection.workspaceId);assert.equal(fixture.projectId,run.selection.projectId);
  assert.equal(fixture.syntheticAssets,true);assert.equal(fixture.syntheticDecisions,true);
  assert(fixture.casePlans&&typeof fixture.casePlans==='object'&&!Array.isArray(fixture.casePlans));
  for(const id of Object.keys(fixture.casePlans))assert(run.all.some(c=>c.caseInstanceId===id),'Fixture cannot introduce a new acceptance case');
  const installed=path.join(run.selection.installedRoot,'package');
  const load=relative=>import(pathToFileURL(path.join(installed,'dist',relative)).href);
  const base=await load('lifecycle/base.js'),instanceApi=await load('lifecycle/instance.js'),platformApi=await load('adapters/platforms.js');
  const configApi=await load('adapters/config.js'),artifactApi=await load('adapters/artifacts.js'),security=await load('server/security.js');
  const spec=read(path.join(run.selection.installedRoot,'service-specification.json'));
  const actor=()=>{const value=security.currentPrincipal(path.join(run.selection.installedRoot,'data'),run.selection.workspaceId,spec.principalId);assert(value,'The selected native principal no longer exists');return value;};
  const configuration=()=>{assert(spec.integrationsRef,'Real registered provider and owner connections are required');return configApi.readIntegrationConfiguration(spec.integrationsRef,run.selection.workspaceId);};
  let archiveSequence=0;
  async function installedInstance(id){
   const result=await run.read('lifecycle.instance.inspect',{instanceId:id});
   const value=instanceApi.inspectInstance(result.instance);assert.equal(value.id,id);assert.equal(value.pins.projectId,run.selection.projectId);
   assert.equal(base.isCurrentBase(value.pins.base),true,'Historical migrated instances cannot establish current stage admission');
   return value;
  }
  async function original(id){
   assert.equal(typeof id,'string');const result=await run.read('lifecycle.stage.request.inspect',{stageRequestId:id});
   const r=result.request,{digest,...body}=r;assert.equal(digest,base.valueDigest(body));assert.equal(r.planDigest,base.valueDigest(r.plan));
   assert.equal(r.id,id);assert.equal(r.workspaceId,run.selection.workspaceId);assert.equal(r.projectId,run.selection.projectId);
   assert.equal(result.automaticRedispatch,false);assert.equal(result.progress.requestId,id);
   const instance=await installedInstance(r.instanceId);assert.equal(instance.pinsDigest,r.pinsDigest);
   assert.equal(instance.stages[r.stageId].requestId,id);assert.equal(instance.stages[r.stageId].inputDigest,r.inputDigest);
   if(result.progress.observationRef){
    const value=await run.read('lifecycle.stage.observation.read',{stageRequestId:id,observationRef:result.progress.observationRef});
    assert.equal(base.valueDigest(value.evidence),value.observationRef);assert.deepEqual(value.evidence.observation,result.progress.observation);
    assert.equal(value.evidence.reason,result.progress.reason);assert.equal(value.evidence.observedAt,result.progress.observedAt);
   }
   return{...result,instance};
  }
  async function rejection(label,work,codes){
   let error;
   try{await work();}catch(e){error={code:e.code??null,message:e.message};}
   run.artifact('installed-negative-input.json',{label,error,expectedCodes:codes,negativeInputOnly:true,originalProviderResponseModified:false});
   assert(error,'Installed product accepted '+label);assert(codes.includes(error.code),'Unexpected rejection for '+label+': '+JSON.stringify(error));
   return error;
  }
  async function absentInstance(id){
   const result=await run.request('lifecycle.instance.inspect',{instanceId:id});
   assert.equal(result.status,404);assert.equal(result.body.error?.code,'NOT_FOUND');
  }
  async function activeDefinition(id,provider){
   const active=await run.read('lifecycle.definition.inspect');assert.equal(active.active?.id,id);
   const definition=await run.read('lifecycle.definition.read',{revisionId:id});
   assert.equal(definition.compilation.valid,true);assert.equal(definition.compilation.effective.semantic.config.implementation.provider,provider);
   assert.equal(base.isCurrentBase(definition.compilation.effective.base),true);
   assert.deepEqual(definition.compilation.effective.nodes.find(n=>n.id==='scope').dependsOn,[]);
   return{definition,yaml:await run.source(id)};
  }
  async function scopePrerequisite(c,plan){
   const {provider,predecessorOutcome}=c.parameters;assert.equal(c.parameters.stage,'scope');
   assert(['github','gitlab'].includes(provider));assert.notEqual(predecessorOutcome,'passed');
   if(predecessorOutcome==='not-run'||predecessorOutcome==='failed'){
    const missing=predecessorOutcome==='not-run';
    keys(plan,missing?['scopePrerequisite','subject','authorityRef']:['scopePrerequisite','instanceId','definitionRevisionId','authorityRef']);
    assert.equal(plan.scopePrerequisite,missing?'authority-not-recorded':'authority-rejected');
    assert(/^authority:sha256:[a-f0-9]{64}$/.test(plan.authorityRef));
    if(missing)keys(plan.subject,['instanceId','definitionRevisionId','goalRef','targetRef','loopRef','budget','expiresAt']);
    const instanceId=missing?plan.subject.instanceId:plan.instanceId,definitionRevisionId=missing?plan.subject.definitionRevisionId:plan.definitionRevisionId;
    await absentInstance(instanceId);const selected=await activeDefinition(definitionRevisionId,provider);
    const valid=await run.read('lifecycle.definition.validate',{yaml:selected.yaml});assert.equal(valid.ready,true,'A different missing configuration cannot replace the selected authority failure');
    const retained=await run.request('lifecycle.authority.inspect',{authorityRef:plan.authorityRef});
    if(missing){
     assert.equal(retained.status,404);assert.equal(retained.body.error?.code,'NOT_FOUND');
     const preview=await run.read('lifecycle.authority.preview',{kind:'execution',subject:plan.subject});
     assert.equal(preview.authorityGranted,false);assert.equal(preview.executionDispatched,false);assert.equal(preview.subject.instanceId,instanceId);
     assert(preview.preparation,'Use the current native preparation; a fake ref or unprepared subject cannot establish not-run');
     assert.equal(preview.preparation.input.definitionRevisionId,definitionRevisionId);
    }else{
     assert.equal(retained.status,200,JSON.stringify(retained.body));const authority=retained.body.result;
     assert.equal(authority.decision.kind,'execution');assert.equal(authority.decision.choice,'REJECT');
     assert.equal(authority.decision.subject.instanceId,instanceId);assert.equal(authority.decision.subject.definitionRevisionId,definitionRevisionId);
     assert.equal(authority.usable,false);assert.equal(authority.reason,'AUTHORITY_REVOKED');
     assert(authority.decision.subject.targetRef.startsWith('preparation:sha256:'));
     const preparation=await run.read('lifecycle.preparation.read',{preparationRef:authority.decision.subject.targetRef});assert.equal(preparation.current,true);
     assert.equal(preparation.packet.input.definitionRevisionId,definitionRevisionId);
    }
    const before=await run.read('runtime.status');
    const rejected=await run.request('lifecycle.instance.create',{instanceId,definitionRevisionId,authorityRef:plan.authorityRef},{requestId:run.requestId(c.caseInstanceId,'scope-entry-denial'),expectedRevision:before.revision});
    assert.equal(rejected.status,missing?404:403);assert.equal(rejected.body.error?.code,missing?'NOT_FOUND':'AUTHORITY_REVOKED');
    await absentInstance(instanceId);assert.equal((await run.read('runtime.status')).revision,before.revision,'Denied entry must not create an instance, decision or request');
    return{provider,stage:'scope',predecessorOutcome,scopePrerequisite:plan.scopePrerequisite,boundary:'lifecycle.instance.create',actualNativeRejection:rejected.body.error.code,decisionCreated:false,instanceCreated:false,executionDispatched:false};
   }
   const missing=predecessorOutcome==='missing-evidence';assert(missing||predecessorOutcome==='unknown');
   keys(plan,missing?['scopePrerequisite','instanceId','authorityRef','documentRole']:['scopePrerequisite','instanceId','authorityRef']);
   assert.equal(plan.scopePrerequisite,missing?'required-preparation-document-missing':'binding-observation-unknown');
   const before=await installedInstance(plan.instanceId),stage=before.stages.scope;
   assert.deepEqual(before.definition.nodes.find(n=>n.id==='scope').dependsOn,[]);assert.equal(before.definition.semantic.config.implementation.provider,provider);
   assert.equal(stage.status,'PENDING');assert.equal(stage.attempts,0);assert.equal(stage.requestId,null);
   const authority=await run.read('lifecycle.authority.inspect',{authorityRef:plan.authorityRef});
   assert.equal(authority.decision.kind,'execution');assert.equal(authority.decision.choice,'APPROVE');assert.equal(authority.decision.subject.instanceId,before.id);
   assert.equal(authority.decision.subject.definitionRevisionId,before.pins.definitionRevisionId);assert.equal(authority.decision.subject.targetRef,before.pins.targetRef);
   const preparation=await run.read('lifecycle.preparation.read',{preparationRef:before.pins.targetRef});
   assert.equal(preparation.packet.input.definitionRevisionId,before.pins.definitionRevisionId);assert.equal(preparation.packet.input.source.provider,provider);
   if(missing){
    assert(['plan','impact','verification','rollback'].includes(plan.documentRole),'Select a required prepared document, never an optional future-stage output');
    const document=preparation.packet.input.documents[plan.documentRole];assert(document&&hash.test(document.digest));assert(path.isAbsolute(document.path));
    let observedError;try{fs.lstatSync(document.path);}catch(error){observedError=error.code;}
    assert.equal(observedError,'ENOENT','The exact native preparation document must actually be missing');
    assert.equal(preparation.current,false);assert.equal(preparation.reason,'PREPARATION_UNAVAILABLE');assert.equal(authority.usable,false);assert.equal(authority.reason,'ENOENT');
    run.artifact('scope-missing-native-evidence.json',{instanceId:before.id,preparationRef:before.pins.targetRef,documentRole:plan.documentRole,document,observedError,originalPacketRetained:true,fileChangedByCollector:false});
   }else{
    assert.equal(preparation.current,true);assert.equal(authority.usable,true);
    const yaml=await run.source(before.pins.definitionRevisionId),validation=await run.read('lifecycle.definition.validate',{yaml});
    assert.equal(validation.compilation.valid,true);assert.equal(validation.ready,false);
    assert(validation.bindings?.issues.some(issue=>issue.code==='BINDINGS_UNKNOWN'),'A real unresolved dependency observation is required; invalid fields, explicit 403 or known missing evidence are separate conditions');
   }
   const denied=await run.request('lifecycle.stage.admission',{instanceId:before.id,stageId:'scope'});
   if(missing){assert.equal(denied.status,409);assert.equal(denied.body.error?.code,'AUTHORITY_UNKNOWN');}
   else{assert.equal(denied.status,200,JSON.stringify(denied.body));assert.equal(denied.body.result.allowed,false);assert.deepEqual(denied.body.result.reasons,['BINDINGS_NOT_CURRENT']);assert.equal(denied.body.result.executionDispatched,false);}
   const after=await installedInstance(before.id);assert.deepEqual(after,before);
   assert.deepEqual((await run.read('lifecycle.preparation.read',{preparationRef:before.pins.targetRef})).packet,preparation.packet);
   return{provider,stage:'scope',predecessorOutcome,scopePrerequisite:plan.scopePrerequisite,boundary:'lifecycle.stage.admission',actualNativeRejection:missing?denied.body.error.code:denied.body.result.reasons[0],instancePinsUnchanged:true,originalPreparationUnchanged:true,executionDispatched:false};
  }
  async function stageAdmission(c,plan){
   keys(plan,['instanceId','predecessorId']);const {provider,stage,predecessorOutcome}=c.parameters;
   assert(['github','gitlab'].includes(provider)&&stages.includes(stage)&&outcomes.includes(predecessorOutcome));
   const before=await installedInstance(plan.instanceId),node=before.definition.nodes.find(n=>n.id===stage);
   assert(node);assert.equal(before.definition.semantic.config.implementation.provider,provider);
   assert.equal(before.stages[stage].status,'PENDING','Use the actual pre-admission state, not a completed-stage denial');
   assert.equal(before.stages[stage].attempts,0,'A retry budget failure cannot stand in for a predecessor failure');
   if(stage==='scope'){
    assert.equal(plan.predecessorId,null);assert.deepEqual(node.dependsOn,[]);
    assert.equal(predecessorOutcome,'passed','Scope negative outcomes use their distinct native entry prerequisites');
    assert(before.pins.targetRef.startsWith('preparation:sha256:'),'Scope needs its exact native preparation');
    const preparation=await run.read('lifecycle.preparation.read',{preparationRef:before.pins.targetRef});
    assert.equal(preparation.current,true);assert.equal(preparation.packet.input.definitionRevisionId,before.pins.definitionRevisionId);
    assert.equal(preparation.packet.input.source.provider,provider);assert.equal(preparation.executionAuthorized,false);
    run.artifact('scope-native-preparation.json',preparation);
   }else{
    assert(node.dependsOn.includes(plan.predecessorId),'Select an actual graph predecessor, not a convenient other stage');
    const prior=before.stages[plan.predecessorId];assert(prior);
    if(predecessorOutcome==='not-run'){
     assert.equal(prior.status,'PENDING');assert.equal(prior.attempts,0);assert.equal(prior.requestId,null);assert.equal(prior.receiptRef,null);
    }else{
     assert(prior.requestId);const retained=await original(prior.requestId),observation=retained.progress.observation;
     assert(observation,'A state label alone is insufficient; retain the actual provider/adapter outcome');
     assert.equal(observation.outcome.requestId,prior.requestId);assert.equal(observation.outcome.inputDigest,prior.inputDigest);
     assert.equal(prior.outcomeDigest,base.valueDigest(observation.outcome));
     const expected=before.definition.nodes.find(n=>n.id===plan.predecessorId).checks;
     if(predecessorOutcome==='failed'){
      assert.equal(prior.status,'FAILED');assert.equal(observation.outcome.status,'FAILED');
      assert.equal(observation.phase,'FAILED');assert.equal(retained.progress.terminal,true);
     }else if(predecessorOutcome==='unknown'){
      assert.equal(prior.status,'UNKNOWN');assert.equal(observation.outcome.status,'UNKNOWN');
      assert(!missingEvidenceReasons.includes(retained.progress.reason),'A specific missing-evidence rejection has its own fixed case');
      assert(retained.progress.reason||observation.handle||observation.outcome.checks.some(check=>check.status==='UNKNOWN'),'Retain an actual uncertain request/handle/check or native reason');
     }else if(predecessorOutcome==='missing-evidence'){
      assert.equal(prior.status,'UNKNOWN');assert.equal(observation.outcome.status,'UNKNOWN');
      assert(missingEvidenceReasons.includes(retained.progress.reason),'An empty observation alone does not prove missing evidence; retain the precise native missing-evidence rejection');
      const found=new Set(observation.outcome.checks.map(check=>check.id));assert(expected.some(id=>!found.has(id)),'The original observation must actually omit a required evidence item');
      assert(!observation.outcome.checks.some(check=>check.status==='FAIL'||check.status==='UNKNOWN'),'Do not relabel an explicit failed/unknown check as missing evidence');
     }else{
      assert.equal(prior.status,'PASSED');assert.equal(observation.outcome.status,'COMPLETE');
      assert.deepEqual(observation.outcome.checks.map(check=>check.id).sort(),[...expected].sort());
      assert(observation.outcome.checks.every(check=>check.status==='PASS'&&check.evidenceRef));
      assert(Date.parse(prior.expiresAt)>Date.now(),'Historical successful evidence is not current admission');
     }
    }
   }
   const response=await run.request('lifecycle.stage.admission',{instanceId:before.id,stageId:stage});
   assert.equal(response.status,200,'Authority/provider failure must not masquerade as a predecessor admission result: '+JSON.stringify(response.body));
   const admission=response.body.result;assert.equal(admission.executionDispatched,false);
   assert.equal(admission.allowed,predecessorOutcome==='passed');
   if(predecessorOutcome==='passed')assert.deepEqual(admission.reasons,[]);
   else assert(admission.reasons.includes('PREDECESSOR_NOT_PASSED:'+plan.predecessorId));
   const after=await installedInstance(before.id);assert.deepEqual(after,before,'Read-only admission changed the original instance');
   return{provider,stage,predecessorOutcome,instanceId:before.id,predecessorId:plan.predecessorId,admission,actualNativeObservation:true,executionDispatched:false};
  }
  function ciRequest(r){
   const p=r.plan.parameters;
   assert(['candidate','verification'].includes(r.stageId),'Select an original native candidate/verification CI stage');
   assert.equal(r.plan.adapterId,'runtime-ci-owner-stage-v2');assert.equal(p.stageId,r.stageId);
   assert.equal(p.commit,p.source.commit);
   return platformApi.validateRunRequest({schema:'runtime-ci-request/v1',requestId:'stage-'+base.valueDigest({workspaceId:r.workspaceId,projectId:r.projectId,requestId:r.id}).slice(7,55),projectId:r.projectId,bindingDigest:base.valueDigest(p.binding),commit:p.commit,workflowDigest:p.workflowDigest,inputDigest:r.inputDigest,stageId:r.stageId,candidateDigest:p.candidateDigest,...(p.candidateInput?{candidateInput:p.candidateInput}:{}),requestedAt:r.requestedAt,deadlineAt:r.deadlineAt},p.binding);
  }
  async function providerOriginal(provider,selected){
   keys(selected,['stageRequestId','runId']);assert(/^[1-9][0-9]{0,19}$/.test(selected.runId));
   const retained=await original(selected.stageRequestId),r=retained.request,p=r.plan.parameters;
   assert.equal(p.binding.provider,provider);assert.equal(retained.instance.definition.semantic.config.implementation.provider,provider);
   assert.deepEqual(p.expectedChecks,retained.instance.definition.nodes.find(n=>n.id===r.stageId).checks);
   const binding=configApi.configuredPlatform(configuration(),actor(),run.selection.projectId,p.binding.ref);assert.deepEqual(binding,p.binding);
   const credentials=async(value,principal,signal)=>{signal.throwIfAborted();return configApi.readPlatformToken(spec.integrationsRef,value,principal);};
   const api=await load('adapters/'+provider+'.js'),client=api[provider+'Client'](binding,credentials),transport=platformApi.platformReader(binding,credentials);
   const request=ciRequest(r);
   const raw=await transport.get(actor(),provider==='github'?'/actions/runs/'+selected.runId:'/pipelines/'+selected.runId,AbortSignal.timeout(15000));
   run.artifact('actual-platform-run.json',{provider,selected,raw,installation:run.candidateDigest});
   assert.equal(String(raw.id),selected.runId);
   return{retained,request,binding,client,transport,raw,runId:selected.runId};
  }
  async function actualRun(source){
   const value=await source.client.run(actor(),source.request,source.runId,AbortSignal.timeout(30000));
   run.artifact('actual-platform-observation.json',value);assert.equal(value.runId,source.runId);assert.equal(value.requestId,source.request.requestId);
   assert.equal(value.commit,source.request.commit);assert.equal(value.artifactsVerified,false);assert.equal(value.lifecycleAcceptance,false);
   return value;
  }
  async function releaseMismatch(plan,provider){
   keys(plan,['instanceId','authorityRef']);const before=await installedInstance(plan.instanceId);
   assert.equal(before.definition.semantic.config.implementation.provider,provider);assert(before.candidateDigest);
   assert.equal(before.stages.publication.status,'PENDING');assert.equal(before.stages.publication.attempts,0);
   if(plan.authorityRef!==null){
    const originalAuthority=await run.read('lifecycle.authority.inspect',{authorityRef:plan.authorityRef});
    assert.equal(originalAuthority.decision.kind,'release');assert.equal(originalAuthority.decision.subject.instanceId,before.id);assert.equal(originalAuthority.usable,false);
    assert(['AUTHORITY_REVOKED','AUTHORITY_SUPERSEDED','AUTHORITY_EXPIRED','AUTHORITY_POLICY_CHANGED','AUTHORITY_BINDINGS_CHANGED','AUTHORITY_PRINCIPAL_CHANGED','AUTHORITY_MISMATCH','RELEASE_MATERIAL_CHANGED'].includes(originalAuthority.reason));
   }
   const preview=await run.request('lifecycle.authority.preview',{kind:'release',subject:{instanceId:before.id,candidateDigest:differentDigest(before.candidateDigest),expiresAt:new Date(Date.now()+60000).toISOString()}});
   assert.equal(preview.status,409);assert.equal(preview.body.error?.code,'CANDIDATE_REQUIRED');
   const admission=await run.request('lifecycle.stage.admission',{instanceId:before.id,stageId:'publication'});
   if(admission.status===200){assert.equal(admission.body.result.allowed,false);assert(admission.body.result.reasons.includes('EXACT_RELEASE_AUTHORITY_REQUIRED'));}
   else assert(['AUTHORITY_REVOKED','AUTHORITY_SUPERSEDED','AUTHORITY_EXPIRED','AUTHORITY_POLICY_CHANGED','AUTHORITY_BINDINGS_CHANGED','AUTHORITY_PRINCIPAL_CHANGED','AUTHORITY_MISMATCH','RELEASE_MATERIAL_CHANGED'].includes(admission.body.error?.code),'Unrelated failure cannot establish missing release authority');
   assert.deepEqual(await installedInstance(before.id),before);return{wrongCandidatePreviewRejected:true,exactReleaseAdmissionRejected:true,authorityCreated:false,publicationDispatched:false};
  }
  async function publicationInspection(plan,provider,c){
   keys(plan,['stageRequestId','unknownObservationRef','allowReconciliation']);assert.equal(plan.allowReconciliation,true);assert(hash.test(plan.unknownObservationRef));
   const before=await original(plan.stageRequestId);assert.equal(before.request.stageId,'publication');assert.equal(before.request.plan.parameters.binding.provider,provider);
   assert.equal(before.progress.phase,'UNKNOWN');assert.equal(before.progress.terminal,false,'Select the unresolved original publication, not a completed happy path');
   const old=await run.read('lifecycle.stage.observation.read',{stageRequestId:plan.stageRequestId,observationRef:plan.unknownObservationRef});
   assert.equal(base.valueDigest(old.evidence),plan.unknownObservationRef);assert.equal(old.evidence.observation.phase,'UNKNOWN');assert.equal(old.evidence.observation.outcome.status,'UNKNOWN');
   const facts=await run.read('lifecycle.publication.evidence.read',{stageRequestId:plan.stageRequestId});
   assert(facts.ciRequest,'Require an actual retained original dispatch, not a pre-dispatch error');assert.equal(facts.automaticRedispatch,false);
   assert.equal(facts.ciRequest.inputDigest,before.request.inputDigest);assert.equal(facts.ciRequest.candidateDigest,before.instance.candidateDigest);
   const binding=configApi.configuredPlatform(configuration(),actor(),run.selection.projectId,before.request.plan.parameters.binding.ref);assert.deepEqual(binding,before.request.plan.parameters.binding);
   const api=await load('adapters/'+provider+'.js'),client=api[provider+'Client'](binding,async(value,principal,signal)=>{signal.throwIfAborted();return configApi.readPlatformToken(spec.integrationsRef,value,principal);});
   const initialRun=await client.run(actor(),facts.ciRequest,null,AbortSignal.timeout(30000));
   run.artifact('publication-original-provider-lookup.json',initialRun);
   const status=await run.read('runtime.status'),requested=await run.request('lifecycle.stage.reconcile',{stageRequestId:plan.stageRequestId},{requestId:run.requestId(c.caseInstanceId,provider+'-publication-reconcile'),expectedRevision:status.revision});
   assert.equal(requested.status,200,JSON.stringify(requested.body));assert.equal(requested.body.result.result.automaticRedispatch,false);
   const deadline=Date.now()+30000;let worker;
   do{worker=(await run.read('runtime.status')).observationWorker;if(worker.inFlight===0)break;await pause(250);}while(Date.now()<deadline);
   assert.equal(worker.inFlight,0,'Original reconciliation did not settle within the selected observation bound');
   const after=await original(plan.stageRequestId);
   const next=await run.read('lifecycle.publication.evidence.read',{stageRequestId:plan.stageRequestId});
   assert.deepEqual(next.ciRequest,facts.ciRequest);assert.deepEqual(after.instance.requestIds,before.instance.requestIds);assert.equal(after.instance.stages.publication.attempts,before.instance.stages.publication.attempts);
   assert.equal(next.automaticRedispatch,false);
   const finalRun=await client.run(actor(),facts.ciRequest,null,AbortSignal.timeout(30000));
   if(initialRun.runId!==null)assert.equal(finalRun.runId,initialRun.runId);
   const releaseStage=before.instance.stages['release-decision'];assert(releaseStage.requestId);
   const material=(await run.read('lifecycle.release.evidence.read',{stageRequestId:releaseStage.requestId})).material;
   const distributionApi=await load('adapters/distribution.js'),publication=facts.ciRequest.publicationInput;
   const description=distributionApi.publicationDescription(material.documents.documents.filter(d=>d.role==='release-notes').map(d=>d.text),facts.ciRequest);
   const distribution=await client.distribution(actor(),{commit:facts.ciRequest.commit,candidate:before.instance.candidate,tag:publication.tag,prerelease:publication.target.prerelease,packageName:publication.target.packageName,descriptionDigest:'sha256:'+sha(description)},AbortSignal.timeout(60000));
   run.artifact('publication-independent-readback.json',{initialRun,finalRun,distribution,retainedEvidence:next,worker,originalInspectionRequested:true,remoteWritesByCollector:0});
   assert(['ABSENT','PARTIAL','MISMATCH','PASSED'].includes(distribution.status));assert.equal(distribution.releaseAuthorized,false);
   if(distribution.status!=='PASSED')assert.notEqual(after.progress.phase,'COMPLETE');
   return{originalUnknown:plan.unknownObservationRef,originalRequestUnchanged:true,newAttempt:false,observedDistribution:distribution.status,phase:after.progress.phase,independentProviderLookupUnique:true};
  }
  async function providerMismatches(c,plan){
   keys(plan,['provider','passing','oldCandidate','rerun','skipped','release','publication']);const provider=plan.provider;assert(['github','gitlab'].includes(provider));
   if(c.caseInstanceId==='E18.variant.01')assert.equal(provider,'github');if(c.caseInstanceId==='E18.variant.02')assert.equal(provider,'gitlab');
   const source=await providerOriginal(provider,plan.passing),observed=await actualRun(source);assert.equal(observed.status,'PASSED');assert(observed.jobs.length>0);
   const archive=await source.client.artifact(actor(),source.request,source.runId,AbortSignal.timeout(60000));
   const verified=await artifactApi.verifyCiArtifact(archive,source.request,source.retained.request.plan.parameters.expectedChecks,AbortSignal.timeout(30000));
   assert.equal(verified.status,'PASSED');assert.equal(verified.lifecycleAcceptance,false);assert.equal(verified.ownerEvaluationsVerified,false);
   const filename='actual-ci-archive-'+(++archiveSequence)+'.zip';fs.writeFileSync(path.join(run.selection.outputRoot,filename),archive.bytes,{mode:0o600,flag:'wx'});
   const entries=await artifactApi.readArtifactArchive(archive.bytes,AbortSignal.timeout(30000));
   run.artifact('actual-ci-archive.json',{file:filename,archiveDigest:archive.archiveDigest,archiveBytes:archive.archiveBytes,verified,result:JSON.parse(entries.get('runtime-result.json').toString()),provider,runId:source.runId});
   const wrongCommit=(source.request.commit[0]==='0'?'1':'0')+source.request.commit.slice(1);
   await rejection('same original successful job with wrong commit',()=>source.client.job(actor(),source.runId,observed.jobs[0].jobId,wrongCommit,AbortSignal.timeout(15000),platformApi.ciSourceRef(source.request)),['PLATFORM_RECEIPT_MISMATCH']);
   await rejection('original bytes with forged archive digest',()=>artifactApi.verifyCiArtifact({...archive,archiveDigest:differentDigest(archive.archiveDigest)},source.request,verified.checks.map(v=>v.id),AbortSignal.timeout(15000)),['CI_ARTIFACT_MISMATCH']);
   await rejection('successful report from a different workflow pin',()=>artifactApi.verifyCiArtifact(archive,{...source.request,workflowDigest:differentDigest(source.request.workflowDigest)},verified.checks.map(v=>v.id),AbortSignal.timeout(15000)),['CI_RESULT_MISMATCH']);
   await rejection('old successful report reused for a different exact input',()=>artifactApi.verifyCiArtifact(archive,{...source.request,inputDigest:differentDigest(source.request.inputDigest)},verified.checks.map(v=>v.id),AbortSignal.timeout(15000)),['CI_ARTIFACT_MISMATCH']);
   const old=await providerOriginal(provider,plan.oldCandidate);assert.equal(old.request.stageId,'candidate');assert.notEqual(old.request.requestId,source.request.requestId);
   const oldRun=await actualRun(old);assert.equal(oldRun.status,'PASSED');
   const oldArchive=await old.client.artifact(actor(),old.request,old.runId,AbortSignal.timeout(60000));
   const oldVerified=await artifactApi.verifyCiArtifact(oldArchive,old.request,old.retained.request.plan.parameters.expectedChecks,AbortSignal.timeout(30000));
   const currentCandidate=source.request.candidateInput?.manifest??verified.candidate;assert(currentCandidate);assert.equal(oldVerified.status,'PASSED');assert(oldVerified.candidate);
   assert.notEqual(instanceApi.candidateDigest(oldVerified.candidate),instanceApi.candidateDigest(currentCandidate),'Two request labels for the same manifest do not establish an old-candidate mismatch');
   const oldName='actual-ci-archive-'+(++archiveSequence)+'.zip';fs.writeFileSync(path.join(run.selection.outputRoot,oldName),oldArchive.bytes,{mode:0o600,flag:'wx'});
   run.artifact('actual-old-candidate.json',{file:oldName,archiveDigest:oldArchive.archiveDigest,archiveBytes:oldArchive.archiveBytes,verified:oldVerified,currentCandidate});
   await rejection('distinct authentic old-candidate artifact reused for current request',()=>artifactApi.verifyCiArtifact(oldArchive,source.request,verified.checks.map(v=>v.id),AbortSignal.timeout(15000)),['CI_ARTIFACT_MISMATCH']);
   const rerun=await providerOriginal(provider,plan.rerun);assert.notEqual(rerun.request.requestId,source.request.requestId,'Use a separately retained real rerun fixture');
   if(provider==='github')assert(rerun.raw.run_attempt>1,'A caller-supplied attempt label is not a real rerun');
   else{
    const jobs=await rerun.transport.get(actor(),'/pipelines/'+rerun.runId+'/jobs?include_retried=true&per_page=100',AbortSignal.timeout(15000));
    run.artifact('actual-gitlab-retried-jobs.json',{runId:rerun.runId,jobs});assert(Array.isArray(jobs)&&jobs.length<100);
    assert(new Set(jobs.map(j=>JSON.stringify([j.stage,j.name]))).size<jobs.length,'GitLab must contain actual retained retried jobs');
   }
   await rejection('real provider rerun cannot reuse the original attempt',()=>actualRun(rerun),['CI_RUN_MISMATCH']);
   const skipped=await providerOriginal(provider,plan.skipped),skippedRun=await actualRun(skipped);
   assert.equal(skippedRun.status,'FAILED');assert(skippedRun.jobs.some(j=>j.providerStatus==='skipped'||j.providerStatus==='completed:skipped'));
   assert.notEqual(skipped.retained.instance.stages[skipped.retained.request.stageId].status,'PASSED','Runtime must not have accepted a skipped mandatory job');
   const release=await releaseMismatch(plan.release,provider),publication=await publicationInspection(plan.publication,provider,c);
   const covered={provider,realPlatformReads:true,archiveVerified:true,wrongCommit:true,wrongAttempt:true,skippedJob:true,reportProvenance:true,reportDigest:true,distinctOldCandidate:true,release,publication,remaining:['fork credentials unavailable during actual CI']};
   run.artifact('provider-mismatch-covered-branches.json',covered);
   // An API 403 is not proof that a fork pipeline lacked its protected secrets;
   // retain the frozen provider case as failed until that fact is executable.
   return covered;
  }
  function requireCompleteProvider(covered){
   assert.deepEqual(covered.remaining,[],'E18_PROVIDER_PRECONDITION_REQUIRED: retain a real fork-CI credential-loss result; covered negative branches are not the whole fixed provider journey');
   return covered;
  }
  const predicateClaims=new Set();
  for(const c of run.cases)await run.collect(c,async()=>{
   const plan=fixture.casePlans[c.caseInstanceId];
   if(c.kind==='STAGE_ADMISSION'){
    assert(plan,'Missing original native precondition for '+c.caseInstanceId);
    if(c.parameters.stage==='scope'&&c.parameters.predecessorOutcome!=='passed')return scopePrerequisite(c,plan);
    const claim=JSON.stringify([plan.instanceId,plan.predecessorId,c.parameters.predecessorOutcome]);
    assert(!predicateClaims.has(claim),'Do not count one native precondition repeatedly under different fixed provider/stage labels');predicateClaims.add(claim);
    return stageAdmission(c,plan);
   }
   if(c.caseInstanceId==='E18.journey'){
    assert(plan);keys(plan,['providers']);assert.deepEqual(plan.providers.map(p=>p.provider).sort(),['github','gitlab']);
    const observed=[];for(const provider of plan.providers)observed.push(await providerMismatches(c,provider));
    return{providers:observed.map(requireCompleteProvider)};
   }
   if(['E18.variant.01','E18.variant.02'].includes(c.caseInstanceId)){assert(plan);return requireCompleteProvider(await providerMismatches(c,plan));}
   const requirements=c.parameters.variantContract;assert(requirements);
   run.artifact('unfulfilled-fixed-contract.json',{caseInstanceId:c.caseInstanceId,contract:requirements,denominatorRetained:true,sourceTestsCredited:false,releaseAuthorized:false});
   if(c.caseInstanceId==='E18.CV03')assert.fail('CV03 requires original managed-action timing/resource/attempt boundary observations and external call counts; stage-state reads alone do not satisfy it');
   if(c.caseInstanceId==='E18.CV07')assert.fail('CV07 requires both actual provider campaigns, GitLab MR/job/artifact/feedback evidence and E20 inventory rejection evidence; fixed IDs alone are not acceptance');
   assert.fail('Unimplemented fixed E18 case '+c.caseInstanceId);
  });
 }finally{run.finish();}
});
