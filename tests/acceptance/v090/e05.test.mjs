// Installed revision/candidate evidence only. An unimplemented fixed contract
// fails explicitly; compiler fixtures and synthetic stage outcomes earn no credit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseDocument} from 'yaml';
import {chromium,expect} from '@playwright/test';
import {collectCaseCampaign,caseCampaignTestOptions,openScenario,sha} from './support.mjs';
import {collectInstalledBaseUpgrade} from './maintenance.mjs';
import {openBrowser} from './browser.mjs';
import {ownerObligations,collectE05Journey,collectE05MissingCandidate} from './execution.mjs';

const missing={
 'E05.CV06':'Requires actual published-owner REUSE and DELIVER decisions, expiration/scope/known-defect variants and partial feedback recovery.',
};

test('E05 installed revision isolation and actual candidate evidence',caseCampaignTestOptions('E05'),async()=>{
 const run=await openScenario('E05');let serial=0,browser;
 try{
  if(run.selection.caseCampaign){await collectCaseCampaign(run,'E05');return;}
  const cfg=run.selection.revisionEvolution;let baseline;
  if(run.cases.some(c=>!['E05.journey','E05.variant.02','E05.EX10','E05.EX11'].includes(c.caseInstanceId))){
   assert(cfg&&Object.keys(cfg).sort().join(',')==='allowSyntheticDecisions,instanceId');
   assert.equal(cfg.allowSyntheticDecisions,true,'Native synthetic test decisions must be explicitly selected, never inferred as human authority');
   assert(/^[a-z0-9][a-z0-9-]{0,63}$/.test(cfg.instanceId));
   baseline=(await run.read('lifecycle.instance.inspect',{instanceId:cfg.instanceId})).instance;
   assert.equal(baseline.pins.projectId,run.selection.projectId);
  }
  // A quiescent in-flight instance permits exact comparisons without racing an
  // authorized worker. Already closed instances cannot qualify MC05/EX09.
  const inFlight=()=>{
   assert.notEqual(baseline.stages.closure.status,'PASSED','Use a real in-flight instance, not an already closed historical fixture');
   assert(Object.values(baseline.stages).some(s=>s.status==='PASSED'),'At least one real stage must have executed');
   assert(Object.values(baseline.stages).every(s=>!['RUNNING','UNKNOWN'].includes(s.status)),'Finish inspecting pending original actions before this revision campaign');
  };
  const unchanged=async()=>assert.deepEqual((await run.read('lifecycle.instance.inspect',{instanceId:cfg.instanceId})).instance,baseline,'Definition work must preserve every old instance pin, outcome, request and candidate');
  const mutate=async(c,operation,input,suffix,expectedRevision)=>{
   const revision=expectedRevision??(await run.read('runtime.status')).revision;
   const response=await run.request(operation,input,{requestId:run.requestId(c.caseInstanceId,suffix),expectedRevision:revision});
   assert.equal(response.status,200,JSON.stringify(response.body));return response.body.result;
  };
  const cursor=async()=>{let after;for(;;){const page=await run.read('runtime.events.read',after?{cursor:after}:{});after=page.cursor;if(page.events.length<50)return after;}};
  const subsequent=async after=>{const events=[];for(;;){const page=await run.read('runtime.events.read',{cursor:after});events.push(...page.events);after=page.cursor;if(page.events.length<50)return events;assert(events.length<=1000,'Unexpected concurrent activity');}};
  const noExecution=events=>{
   assert(!events.some(e=>e.type.startsWith('stage-')),'Definition changes must not dispatch/complete/retry a stage');
   assert(!events.some(e=>e.data?.kind==='release'),'Definition work must not create release authority');
  };
  const testDecision=subject=>{
   const index=++serial,source={synthetic:true,description:'Explicit isolated E05 test attestation, never human or business authority',subject};
   const sourceBytes=JSON.stringify(source)+'\n',sourcePath=path.join(run.selection.outputRoot,'e05-decision-'+index+'-source.json');
   fs.writeFileSync(sourcePath,sourceBytes,{mode:0o600,flag:'wx'});
   const evidence={schema:'evopilot-decision-evidence/v1',subject,source:{reference:pathToFileURL(sourcePath).href+'#sha256='+sha(sourceBytes),description:'Synthetic isolated revision acceptance only'}};
   const evidenceBytes=JSON.stringify(evidence)+'\n',ref=path.join(run.selection.outputRoot,'e05-decision-'+index+'.json');
   fs.writeFileSync(ref,evidenceBytes,{mode:0o600,flag:'wx'});
   run.artifact('synthetic-test-authority.json',{source,evidence,sourceDigest:sha(sourceBytes),evidenceDigest:sha(evidenceBytes),businessApproval:false});
   return pathToFileURL(ref).href+'#sha256='+sha(evidenceBytes);
  };
  async function reviseAndPin(c){
   inFlight();const start=await cursor(),before=await run.read('lifecycle.definition.inspect');assert(before.active);
   const original=await run.source(before.active.id),document=parseDocument(original);assert.equal(document.errors.length,0);
   const base=await run.read('lifecycle.base.inspect'),rule=base.fields.find(f=>f.path==='config.plan.budget.timeoutSeconds');assert(rule);
   const old=document.getIn(['config','plan','budget','timeoutSeconds']);assert(Number.isSafeInteger(old));
   const next=old>rule.rules.minimum?old-1:old+1;assert(next>=rule.rules.minimum&&next<=rule.rules.maximum);
   document.setIn(['config','plan','budget','timeoutSeconds'],next);document.comment=' E05 isolated revision '+c.caseInstanceId;
   const yaml=document.toString({lineWidth:0}),preview=await run.read('lifecycle.definition.validate',{yaml});
   assert.equal(preview.ready,true,JSON.stringify(preview.issues));assert.notEqual(preview.compilation.effective.semanticDigest,before.active.semanticDigest);
   const activated=await mutate(c,'lifecycle.definition.save-and-activate',{yaml,validationDigest:preview.validationDigest},'activate',before.revision);
   assert.equal(activated.result.status,'ACTIVE');assert.equal(activated.result.executionAuthorized,false);assert.equal(activated.result.releaseAuthorized,false);
   const active=await run.read('lifecycle.definition.inspect');assert.equal(active.active.id,activated.result.revisionId);assert.notEqual(active.active.id,before.active.id);
   assert.equal(await run.source(active.active.id),yaml);assert.equal(await run.source(before.active.id),original);await unchanged();
   const activationEvents=await subsequent(start);noExecution(activationEvents);assert.equal(activationEvents.filter(e=>e.type==='lifecycle-instance-created').length,0);
   const id='e05-'+sha(run.selection.runId+'|'+c.caseInstanceId).slice(0,32);
   const subject={instanceId:id,definitionRevisionId:active.active.id,goalRef:'synthetic:e05/'+run.selection.runId+'/goal',targetRef:'synthetic:e05/'+run.selection.runId+'/target',loopRef:'synthetic:e05/'+run.selection.runId+'/loop',budget:preview.compilation.effective.semantic.config.plan.budget,expiresAt:new Date(Date.now()+300000).toISOString()};
   const reviewed=await run.read('lifecycle.authority.preview',{kind:'execution',subject});
   const evidenceRef=testDecision({owner:'runtime',operation:'lifecycle.authority.execution',workspaceId:run.selection.workspaceId,scope:{visibility:'private',projectId:run.selection.projectId},reviewDigest:reviewed.reviewDigest,decision:'APPROVE'});
   const grant=await mutate(c,'lifecycle.authority.record',{kind:'execution',subject,reviewDigest:reviewed.reviewDigest,decision:'APPROVE',evidenceRef},'isolated-test-decision');
   const created=await mutate(c,'lifecycle.instance.create',{instanceId:id,definitionRevisionId:active.active.id,authorityRef:grant.result.authorityRef},'create-pending');
   assert.equal(created.result.executionDispatched,false);assert.equal(created.result.releaseAuthorized,false);
   const current=(await run.read('lifecycle.instance.inspect',{instanceId:id})).instance;
   assert.equal(current.pins.definitionRevisionId,active.active.id);assert.equal(current.pins.semanticDigest,preview.compilation.effective.semanticDigest);
   assert.notEqual(current.pinsDigest,baseline.pinsDigest);assert.equal(current.candidate,null);assert.equal(current.candidateDigest,null);
   assert(Object.values(current.stages).every(s=>s.status==='PENDING'&&s.attempts===0&&s.requestId===null));assert.deepEqual(current.requestIds,[]);
   await unchanged();const events=await subsequent(start);noExecution(events);assert.equal(events.filter(e=>e.type==='lifecycle-instance-created').length,1);
   run.artifact('definition-revision-events.json',{events,oldInstance:cfg.instanceId,newInstance:id,syntheticDecision:true});
   return{oldInstanceUnchanged:true,newRevision:active.active.id,newInstance:id,exactNewPins:true,definitionActivationCreatedNoRun:true,newInstancePendingOnly:true,syntheticTestDecision:true,businessDecision:false,releaseAuthorized:false};
  }
  async function nonRc(){
   assert.notEqual(run.selection.qualification,'FINAL_CANDIDATE','The preexisting instance needs independently pinned same-candidate execution provenance before non-RC readback can receive final credit');
   assert.equal(baseline.stages.candidate.status,'PASSED');assert.equal(baseline.stages.verification.status,'PASSED');
   assert(baseline.candidate&&baseline.candidate.artifacts.length);assert(!/(?:^|[.-])rc(?:[.-]|$)/i.test(baseline.candidate.version),'This case needs an actual non-RC candidate');
   for(const artifact of baseline.candidate.artifacts){assert(/^sha256:[a-f0-9]{64}$/.test(artifact.digest));assert(artifact.bytes>0);}
   const candidate=await run.read('lifecycle.stage.request.inspect',{stageRequestId:baseline.stages.candidate.requestId});
   const verified=await run.read('lifecycle.stage.request.inspect',{stageRequestId:baseline.stages.verification.requestId});
   assert.equal(candidate.progress.phase,'COMPLETE');assert.equal(verified.progress.phase,'COMPLETE');
   assert.equal(verified.request.plan.parameters.candidateInput.schema,'runtime-ci-candidate-input/v1');
   assert.deepEqual(verified.request.plan.parameters.candidateInput.manifest,baseline.candidate);
   const identity=verified.request.plan.parameters.candidateInput.archive;assert(['github','gitlab'].includes(identity.provider));assert(/^[1-9][0-9]*$/.test(identity.runId));assert(/^sha256:[a-f0-9]{64}$/.test(identity.archiveDigest));
   assert.equal(verified.request.plan.parameters.candidateDigest,baseline.candidateDigest);
   assert(candidate.progress.observationRef&&verified.progress.observationRef,'Original retained observations are required');
   const originalCandidate=await run.read('lifecycle.stage.observation.read',{stageRequestId:candidate.request.id,observationRef:candidate.progress.observationRef});
   const originalVerification=await run.read('lifecycle.stage.observation.read',{stageRequestId:verified.request.id,observationRef:verified.progress.observationRef});
   for(const observed of [originalCandidate,originalVerification]){assert.equal(observed.evidence.observation.phase,'COMPLETE');assert.equal(observed.evidence.observation.outcome.status,'COMPLETE');assert(observed.evidence.observation.outcome.checks.length&&observed.evidence.observation.outcome.checks.every(check=>check.status==='PASS'));}
   assert.deepEqual(originalCandidate.evidence.observation.outcome.candidate,baseline.candidate);
   run.artifact('original-non-rc-observations.json',{candidate:originalCandidate,verification:originalVerification,manifest:baseline.candidate});await unchanged();
   return{actualNonRcVersion:baseline.candidate.version,actualCompletedCandidateAndVerification:true,originalArchiveIdentity:identity,readOnly:true,releaseAuthorityNotInferred:true};
  }
  async function latest(c){
   const before=await run.read('lifecycle.definition.inspect');assert(before.active);const source=await run.source(before.active.id),results=[];
   for(const owner of ['ontology','harness']){
    const document=parseDocument(source);document.setIn(['assets',owner,'version'],'latest');const yaml=document.toString({lineWidth:0});
    const preview=await run.read('lifecycle.definition.validate',{yaml});assert.equal(preview.ready,false);assert.equal(preview.compilation.valid,false);
    assert(preview.issues.some(i=>i.path==='assets.'+owner+'.version'));
    const result=await mutate(c,'lifecycle.definition.save-and-activate',{yaml,validationDigest:preview.validationDigest},'latest-'+owner);
    assert.equal(result.result.status,'BLOCKED');const after=await run.read('lifecycle.definition.inspect');assert.deepEqual(after.active,before.active);assert.equal(await run.source(after.draft.id),yaml);await unchanged();results.push({owner,issues:result.result.issues});
   }
   return{latestOwnerPinsRejected:results,oldActiveAndInstanceUnchanged:true,noOwnerMutation:true};
  }
  async function edits(c){
   inFlight();const before=await run.read('lifecycle.definition.inspect');assert(before.active);const source=await run.source(before.active.id),start=await cursor();
   const document=parseDocument(source),pathKeys=['config','verification','requiredChecks'],existing=document.getIn(pathKeys).toJSON();assert(Array.isArray(existing));
   const additional='binding:synthetic/e05-'+sha(run.selection.runId).slice(0,20);assert(!existing.includes(additional));
   document.setIn(pathKeys,[...existing,additional]);const addition=document.toString({lineWidth:0});
   const addedPreview=await run.read('lifecycle.definition.validate',{yaml:addition});assert.equal(addedPreview.compilation.valid,true);
   const added=await mutate(c,'lifecycle.draft.save',{yaml:addition},'add-required-check');assert.equal(added.result.status,'DRAFT');
   assert(addedPreview.compilation.effective.nodes.find(n=>n.id==='verification').checks.includes(additional));await unchanged();
   document.setIn(pathKeys,existing);const removed=document.toString({lineWidth:0});const removedPreview=await run.read('lifecycle.definition.validate',{yaml:removed});
   assert.equal(removedPreview.compilation.valid,true);assert.notEqual(removedPreview.compilation.effective.semanticDigest,addedPreview.compilation.effective.semanticDigest);
   await mutate(c,'lifecycle.draft.save',{yaml:removed},'remove-draft-check');await unchanged();
   document.comment=' E05 retained comment';const oldPosition=document.getIn(['presentation','layout','scope'])?.toJSON?.();
   document.setIn(['presentation','layout','scope'],{x:oldPosition?.x===35?36:35,y:65});const presentation=document.toString({lineWidth:0});
   const presented=await run.read('lifecycle.definition.validate',{yaml:presentation});assert.equal(presented.compilation.valid,true);
   assert.equal(presented.compilation.effective.semanticDigest,removedPreview.compilation.effective.semanticDigest);assert.notEqual(presented.compilation.presentationDigest,removedPreview.compilation.presentationDigest);
   const revision=(await run.read('runtime.status')).revision;
   const alternatives=[presentation+'\n# client A\n',presentation+'\n# client B\n'];
   const attempts=await Promise.all(alternatives.map((yaml,i)=>run.request('lifecycle.draft.save',{yaml},{requestId:run.requestId(c.caseInstanceId,'concurrent-'+i),expectedRevision:revision})));
   assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);const loser=attempts.find(r=>r.status===409);assert.equal(loser.body.error.code,'REVISION_CONFLICT');
   const winner=attempts.findIndex(r=>r.status===200),after=await run.read('lifecycle.definition.inspect');assert.equal(await run.source(after.draft.id),alternatives[winner]);assert.deepEqual(after.active,before.active);await unchanged();
   assert.equal(await run.source(added.result.revisionId),addition,'Earlier added-check draft must remain immutable');
   const events=await subsequent(start);noExecution(events);assert.equal(events.filter(e=>e.type==='definition-draft-saved').length,3);assert(!events.some(e=>e.type==='definition-activated'||e.type==='lifecycle-instance-created'));
   run.artifact('concurrent-draft-events.json',{events,winningClient:winner,addedDraft:added.result.revisionId,unregisteredAdditionalCheckCannotAuthorizeExecution:true});
   return{addedAndRemovedDraftChecks:true,layoutAndCommentsPreserved:true,semanticAndPresentationDigestsSeparate:true,oneConcurrentWriterRejected:true,oldInstanceAndActiveUnchanged:true,newCheckNotActivated:true};
  }
  for(const c of run.cases)await run.collect(c,async()=>{
   if(c.caseInstanceId==='E05.journey')return collectE05Journey(run,c);
   if(c.caseInstanceId==='E05.variant.02')return collectE05MissingCandidate(run,c);
   if(c.caseInstanceId==='E05.EX11'){browser??=await chromium.launch({headless:true});return ownerObligations(run,c,browser);}
   if(c.caseInstanceId==='E05.EX10')return collectInstalledBaseUpgrade(run,c,{chromium,expect,openBrowser});
   if(missing[c.caseInstanceId])assert.fail('UNIMPLEMENTED_FIXED_CASE: '+missing[c.caseInstanceId]);
   if(c.caseInstanceId==='E05.variant.01')return nonRc();
   if(c.caseInstanceId==='E05.variant.03')return latest(c);
   if(['E05.variant.04','E05.MC05'].includes(c.caseInstanceId))return reviseAndPin(c);
   if(c.caseInstanceId==='E05.EX09')return edits(c);
   assert.fail('Unknown frozen E05 case '+c.caseInstanceId);
  });
 }finally{await browser?.close();run.finish();}
});
