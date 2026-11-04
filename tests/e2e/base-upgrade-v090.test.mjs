// Source service/ledger regression. Installed A -> B migration and real browser
// EX10 acceptance are independently collected from qualification packages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical } from '../../dist/server/errors.js';
import { loadPublisherBase, valueDigest } from '../../dist/lifecycle/base.js';
import { compileHistoricalRevision, compileLifecycle } from '../../dist/lifecycle/compiler.js';
import { validateBindings } from '../../dist/lifecycle/bindings.js';
import { baseTransition, loadServiceUpgradeContext, validateServiceUpgradeContext, verifyHistoricalRecord } from '../../dist/lifecycle/base-upgrade.js';
import { createDefinitionService } from '../../dist/lifecycle/service.js';
import { inspectInstance, pinInstance, stageAdmission, requestStage, recordStageOutcome } from '../../dist/lifecycle/instance.js';
import { baseUpgradeFixture } from '../fixtures/base-upgrade-v090.mjs';
import { yaml } from '../fixtures/lifecycle-v090.mjs';

function service(f,history=f.history){return createDefinitionService(f.store,f.bindings.provider,async()=>{throw Error('Historical instance must never resolve authority');},undefined,undefined,history);}
const read=(s,f,operation,input={})=>s.read(f.actor,'alpha',operation,input);
const write=(s,f,operation,input,id)=>s.write(f.actor,'alpha',operation,input,id,f.store.revision('alpha'),()=>f.actor);
test('sealed A original source reads against exact A bytes; ordinary compiler and current Base inspection remain B only',async()=>{
  const f=baseUpgradeFixture();try{
    const actual=compileHistoricalRevision(f.history,'alpha',f.original.revision.id,f.original.revision);assert.deepEqual(actual,f.original.revision.compilation);
    assert.equal(compileLifecycle(f.original.source,'alpha').valid,false);
    const s=service(f),base=await read(s,f,'lifecycle.base.inspect');assert.deepEqual(base.pin,loadPublisherBase().pin);assert.equal(base.fields.length,84);
    const source=await read(s,f,'lifecycle.definition.source.read',{revisionId:f.original.revision.id});assert.equal(Buffer.from(source.data,'base64').toString(),f.original.source);
    const historical=await read(s,f,'lifecycle.definition.read',{revisionId:f.original.revision.id});assert.deepEqual(historical.compilation,f.original.revision.compilation);
    await assert.rejects(read(service(f,null),f,'lifecycle.definition.read',{revisionId:f.original.revision.id}),{code:'UNVERIFIED_HISTORICAL_BASE'});
    assert.throws(()=>compileHistoricalRevision({...f.history},'alpha',f.original.revision.id,f.original.revision),{code:'INVALID_SERVICE_UPGRADE'});
    assert.throws(()=>compileHistoricalRevision(f.history,'alpha','sha256:'+'0'.repeat(64),f.original.revision),{code:'HISTORICAL_RECORD_REQUIRED'});
  }finally{f.cleanup();}
});
test('transition reports added mandatory field, removed slot, tighter limit, schema and retained extension without rewriting source',async()=>{
  const f=baseUpgradeFixture();try{
    const originalData=()=>({revision:f.original.revision,source:f.original.source,instance:f.original.instance,basePin:f.original.old.pin});
    const before=canonical(originalData()),baseBytes=Buffer.from(f.original.old.bytes),s=service(f),preview=await read(s,f,'lifecycle.definition.validate',{yaml:f.original.source});
    assert.equal(preview.ready,false);assert.equal(preview.validationDigest,null);const d=preview.baseTransition;
    assert.deepEqual(d.from,f.original.old.pin);assert.deepEqual(d.to,loadPublisherBase().pin);assert.equal(d.sourceRevisionId,f.original.revision.id);
    assert.deepEqual(d.addedRequiredFields,['config.scope.deliveryTargetRef']);assert.deepEqual(d.removedSlots,['legacy-after-plan']);assert.equal(d.schemaChanged,true);assert.deepEqual(d.retainedExtensionIds,['project.legacy']);assert.equal(d.sourceRewritten,false);
    const limit=d.tightenedConstraints.find(r=>r.path==='config.plan.budget.timeoutSeconds');assert.equal(limit.before.rules.maximum,7200);assert.equal(limit.after.rules.maximum,3600);
    for(const path of ['schema','extends','config.scope.deliveryTargetRef','extensions.0.slot'])assert.ok(d.issues.some(i=>i.path===path),path);
    assert.match(d.previewDigest,/^sha256:[a-f0-9]{64}$/);assert.equal(canonical(originalData()),before);assert.deepEqual(f.original.old.bytes,baseBytes);
    const same=baseTransition(f.history,'alpha',f.original.revision.id,f.original.revision,preview.compilation);assert.deepEqual(same,d);
  }finally{f.cleanup();}
});
test('unrepaired old activation is blocked; explicit repaired revision activates B, preserves original source and instance pins',async()=>{
  const f=baseUpgradeFixture();try{
    const s=service(f),originalBytes=f.originalBytes(),oldPins=canonical(f.original.instance);
    const blocked=await write(s,f,'lifecycle.definition.activate',{revisionId:f.original.revision.id,validationDigest:null},'blocked-old');assert.equal(blocked.result.status,'BLOCKED');assert.equal(blocked.result.activeRevisionId,f.original.revision.id);
    const repaired=yaml(f.original.current),preview=await read(s,f,'lifecycle.definition.validate',{yaml:repaired});assert.equal(preview.ready,true);assert.equal(preview.baseTransition.sourceRevisionId,f.original.revision.id);
    const enabled=await write(s,f,'lifecycle.definition.save-and-activate',{yaml:repaired,validationDigest:preview.validationDigest},'activate-new');assert.equal(enabled.result.status,'ACTIVE');assert.notEqual(enabled.result.revisionId,f.original.revision.id);
    const state=await read(s,f,'lifecycle.definition.inspect');assert.equal(state.active.id,enabled.result.revisionId);
    assert.equal(f.store.object('alpha','definition-revision',f.original.revision.id).yaml,f.original.source);assert.equal(canonical(f.store.object('alpha','lifecycle-instance','old-instance')),oldPins);assert.deepEqual(f.originalBytes(),originalBytes);
    assert.deepEqual((await read(s,f,'lifecycle.instance.inspect',{instanceId:'old-instance'})).instance,f.original.instance);
    // The original source, receipt, ledger and exact Base remain available.
    assert.deepEqual(f.store.receipt(f.actor,'alpha','synthetic-import'),f.receipt);assert.equal(f.reload().context.backupDigest,f.context.backupDigest);
  }finally{f.cleanup();}
});
test('preview binds current revision pointers and transition; stale preview cannot activate after a draft change',async()=>{
  const f=baseUpgradeFixture();try{
    const s=service(f),repaired=yaml(f.original.current),preview=await read(s,f,'lifecycle.definition.validate',{yaml:repaired});assert.equal(preview.ready,true);
    await write(s,f,'lifecycle.draft.save',{yaml:'# changed source review\n'+repaired},'change-draft');
    const stale=await write(s,f,'lifecycle.definition.save-and-activate',{yaml:repaired,validationDigest:preview.validationDigest},'stale');assert.equal(stale.result.status,'BLOCKED');assert.ok(stale.result.issues.some(i=>i.code==='VALIDATION_STALE'));
    const current=await read(s,f,'lifecycle.definition.validate',{yaml:repaired});assert.notEqual(current.validationDigest,preview.validationDigest);
    const enabled=await write(s,f,'lifecycle.definition.save-and-activate',{yaml:repaired,validationDigest:current.validationDigest},'fresh');assert.equal(enabled.result.status,'ACTIVE');
  }finally{f.cleanup();}
});
test('a pointer change during binding verification cannot activate even with a caller anticipating the next project revision',async()=>{
  const f=baseUpgradeFixture();try{
    const s=service(f),repaired=yaml(f.original.current),preview=await read(s,f,'lifecycle.definition.validate',{yaml:repaired});assert.equal(preview.ready,true);
    const futureRevision=f.store.revision('alpha')+1;
    f.bindings.state.during=async()=>{f.bindings.state.during=null;await write(s,f,'lifecycle.draft.save',{yaml:'# concurrent source review\n'+repaired},'concurrent-draft');};
    const result=await s.write(f.actor,'alpha','lifecycle.definition.save-and-activate',{yaml:repaired,validationDigest:preview.validationDigest},'race-activation',futureRevision,()=>f.actor);
    assert.equal(result.result.status,'BLOCKED');assert.ok(result.result.issues.some(i=>i.code==='VALIDATION_STALE'));assert.equal(result.result.activeRevisionId,f.original.revision.id);
  }finally{f.cleanup();}
});
test('historical instance is read-only at service, binding and reducer boundaries without provider dispatch',async()=>{
  const f=baseUpgradeFixture();try{
    const s=service(f),before=canonical(f.original.instance),count=f.bindings.state.calls;
    await assert.rejects(read(s,f,'lifecycle.stage.admission',{instanceId:'old-instance',stageId:'scope'}),{code:'HISTORICAL_BASE_READ_ONLY'});
    await assert.rejects(write(s,f,'lifecycle.instance.create',{instanceId:'another',definitionRevisionId:f.original.revision.id,authorityRef:'synthetic:authority'},'create-old'),{code:'HISTORICAL_BASE_READ_ONLY'});
    const checked=await validateBindings(f.original.instance.definition,f.actor,f.bindings.provider);assert.equal(checked.ready,false);assert.ok(checked.issues.some(i=>i.code==='HISTORICAL_BASE_READ_ONLY'));assert.equal(f.bindings.state.calls,count);
    assert.deepEqual(inspectInstance(f.original.instance),f.original.instance);
    assert.throws(()=>pinInstance('new',f.original.revision.id,f.original.instance.definition,f.original.authority),{code:'HISTORICAL_BASE_READ_ONLY'});
    const admission=stageAdmission(f.original.instance,'scope',{authority:f.original.authority,bindingsCurrent:true});assert.equal(admission.allowed,false);assert.ok(admission.reasons.includes('HISTORICAL_BASE_READ_ONLY'));
    assert.throws(()=>requestStage(f.original.instance,'scope','old-request',{authority:f.original.authority,bindingsCurrent:true}),{code:'STAGE_BLOCKED'});
    assert.throws(()=>recordStageOutcome(f.original.instance,'scope',{}),{code:'HISTORICAL_BASE_READ_ONLY'});assert.equal(canonical(f.original.instance),before);
  }finally{f.cleanup();}
});
test('unknown schema, removed extension slot and excessive limits fail B independently and do not silently drop extensions',async()=>{
  const f=baseUpgradeFixture();try{
    for(const change of [d=>d.schema='runtime-project-lifecycle/unknown',d=>d.extensions[0].slot='legacy-after-plan',d=>d.config.plan.budget.timeoutSeconds=5000,d=>delete d.config.scope.deliveryTargetRef]){
      const changed=structuredClone(f.original.current);change(changed);const preview=await read(service(f),f,'lifecycle.definition.validate',{yaml:yaml(changed)});assert.equal(preview.ready,false);assert.equal(preview.validationDigest,null);assert.deepEqual(preview.baseTransition.retainedExtensionIds,['project.legacy']);assert.ok(preview.baseTransition.issues.length);
    }
  }finally{f.cleanup();}
});
test('migration context rejects altered bytes, wrong service, unknown fields and rewritten historical records',()=>{
  const f=baseUpgradeFixture();try{
    assert.throws(()=>validateServiceUpgradeContext({...f.context,allowHistoricalAdmission:true}),{code:'INVALID_FIELDS'});
    assert.throws(()=>loadServiceUpgradeContext(f.stateRoot,'other',f.store.serviceId),{code:'INVALID_SERVICE_UPGRADE'});
    assert.throws(()=>verifyHistoricalRecord(f.history,'alpha','definition-revision',f.original.revision.id,{...f.original.revision,createdBy:'different'}),{code:'CORRUPT_HISTORICAL_RECORD'});
    assert.equal(verifyHistoricalRecord(f.history,'beta','definition-revision',f.original.revision.id,f.original.revision),false);
    for(const file of ['base.json','base-manifest.json','snapshot.json']){const path=join(f.backupRoot,file),original=readFileSync(path);writeFileSync(path,Buffer.concat([original,Buffer.from(' ')]));assert.throws(()=>f.reload(),{code:'INVALID_SERVICE_UPGRADE'});writeFileSync(path,original);}
    assert.equal(f.reload().context.sourceBasePin.digest,f.original.old.pin.digest);
  }finally{f.cleanup();}
});
