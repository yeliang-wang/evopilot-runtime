import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {stringify} from 'yaml';
import {openScenario,repository} from './support.mjs';

function set(object,field,value){const parts=field.split('.');let at=object;for(const key of parts.slice(0,-1))at=at[key]??={};if(value===undefined)delete at[parts.at(-1)];else at[parts.at(-1)]=value;}
function structuralInput(base,provider,projectId){
 const data={};
 for(const field of base.fields){
  if(!field.providers.includes(provider))continue;
  const rules=field.rules;let value=rules.fixed;
  if(value===undefined)switch(field.type){
   case 'string':case 'slug':value='acceptance-fixture';break;
   case 'version':value='1.0.0';break;
   case 'digest':value='sha256:'+'a'.repeat(64);break;
   case 'bindingRef':value='binding:acceptance/'+field.id.toLowerCase();break;
   case 'credentialRef':value='credential:acceptance/'+field.id.toLowerCase();break;
   case 'repositoryPath':value=provider==='github'?'.github/workflows/test.yml':'.gitlab-ci.yml';break;
   case 'httpsOrigin':value=provider==='github'?'https://github.com':'https://gitlab.example.invalid';break;
   case 'enum':value=rules.values[0];break;
   case 'integer':value=rules.minimum;break;
   case 'stringList':value=[...(rules.contains??rules.values.slice(0,1))];break;
   case 'bindingList':value=['binding:acceptance/'+field.id.toLowerCase()];break;
   case 'pathList':value=['README.md'];break;
   default:throw Error('Unimplemented frozen field type: '+field.type);
  }
  set(data,field.path,value);
 }
 data.extends={...base.pin};data.projectId=projectId;data.config.implementation.provider=provider;data.config.publication.channel=provider+'-release';
 for(const owner of ['ontology','harness'])data.assets[owner].projectId=projectId;
 return data;
}
const issue=(issues,field)=>assert(issues.some(i=>i.path===field&&typeof i.rule==='string'&&i.rule.length&&typeof i.remedy==='string'&&i.remedy.length),'Missing exact field/rule/remedy: '+field);

test('E03 fixed candidate service admission cases',async()=>{
 const run=await openScenario('E03');
 try{
  const fields=JSON.parse(fs.readFileSync(path.join(repository,'governance/lifecycle-contract-v090.json'))).fields;
  const base=await run.read('lifecycle.base.inspect');assert.deepEqual(base.fields,fields);
  const initial=await run.read('lifecycle.definition.inspect');assert(initial.active,'Use a real previously activated isolated baseline; do not seed its database');
  const activeSource=await run.source(initial.active.revisionId??initial.active.id);
  const variants=new Map();
  for(const provider of new Set(run.cases.filter(c=>c.kind==='REAL_SERVICE_PARAMETER').map(c=>c.parameters.provider))){
   const data=structuralInput(base,provider,run.selection.projectId),control=await run.read('lifecycle.definition.validate',{yaml:stringify(data,{lineWidth:0})});
   assert.equal(control.compilation.valid,true,'The negative-case control must be structurally valid');variants.set(provider,data);
  }
  for(const c of run.cases)await run.collect(c,async()=>{
   assert.equal(c.kind,'REAL_SERVICE_PARAMETER','This frozen journey/entry still requires its actual collector; it may not be skipped or replaced by a field test');
   const {provider,field,fault,entry}=c.parameters;assert.equal(entry,'http-api');assert(['missing','invalid-value'].includes(fault));
   const spec=fields.find(f=>f.path===field);assert(spec?.providers.includes(provider));
   const data=structuredClone(variants.get(provider));set(data,spec.path,fault==='missing'?undefined:null);const yaml=stringify(data,{lineWidth:0});
   const before=await run.read('lifecycle.definition.inspect');assert.deepEqual(before.active,initial.active);
   const oldDraft=before.draft?await run.source(before.draft.revisionId??before.draft.id):null;
   const saved=await run.request('lifecycle.draft.save',{yaml},{requestId:run.requestId(c.caseInstanceId,'draft'),expectedRevision:before.revision});assert.equal(saved.status,200);assert.equal(saved.body.result.result.status,'DRAFT');
   const preview=await run.read('lifecycle.definition.validate',{yaml});assert.equal(preview.ready,false);assert.equal(preview.compilation.valid,false);issue(preview.compilation.issues,spec.path);
   const draft=await run.read('lifecycle.definition.inspect');assert.equal(await run.source(draft.draft.revisionId??draft.draft.id),yaml);
   const activated=await run.request('lifecycle.definition.save-and-activate',{yaml,validationDigest:preview.validationDigest},{requestId:run.requestId(c.caseInstanceId,'activate'),expectedRevision:draft.revision});assert.equal(activated.status,200);assert.equal(activated.body.result.result.status,'BLOCKED');issue(activated.body.result.result.issues,spec.path);
   const after=await run.read('lifecycle.definition.inspect');assert.deepEqual(after.active,initial.active);assert.equal(await run.source(after.draft.revisionId??after.draft.id),yaml);assert.equal(await run.source(initial.active.revisionId??initial.active.id),activeSource);
   if(before.draft)assert.equal(await run.source(before.draft.revisionId??before.draft.id),oldDraft);
   return{specificFieldRuleAndRemedy:true,invalidDraftRetained:true,activationBlocked:true,existingActiveAndHistoryUnchanged:true,externalExecutionRequested:false,inputKind:'SYNTHETIC_NEGATIVE_CONFIGURATION',service:'ACTUAL_INSTALLED_HTTP'};
  });
 }finally{run.finish();}
});
