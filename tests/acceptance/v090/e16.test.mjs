// Exact installed scope refusals only. Owner assets and registrations are read
// through the selected service; this collector neither creates an owner asset
// nor dispatches a stage, records a decision, injects a provider, or seeds state.
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
 'E16.variant.02':'Repeated feedback delivery must retain the same real event and owner receipt without another business execution.',
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

test('E16 installed owner and project scope mismatch',async()=>{
 const run=await openScenario('E16');
 try{
  assert.equal(run.all.length,7,'The frozen E16 denominator must remain unchanged');
  for(const c of run.cases)await run.collect(c,async()=>{
   if(c.caseInstanceId==='E16.variant.03')return scopeMismatch(run,c);
   assert(Object.hasOwn(unsupported,c.caseInstanceId),'Unknown fixed E16 case');
   run.artifact('unimplemented-e16-obligation.json',{required:c,missing:unsupported[c.caseInstanceId],scopeRefusalIsNotSubstitute:true});
   assert.fail('UNIMPLEMENTED_REQUIRED_VARIANT: '+unsupported[c.caseInstanceId]);
  });
 }finally{run.finish();}
});
