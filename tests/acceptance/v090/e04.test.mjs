import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {stringify,parse} from 'yaml';
import {chromium,expect} from '@playwright/test';
import {openScenario} from './support.mjs';
import {openBrowser} from './browser.mjs';

const yaml=value=>stringify(value,{lineWidth:0});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function set(value,field,next){const keys=field.split('.');let at=value;for(const key of keys.slice(0,-1))at=at[key]??={};if(next===undefined)delete at[keys.at(-1)];else at[keys.at(-1)]=next;}
function structural(base,provider,projectId){
 const data={};
 for(const field of base.fields.filter(f=>f.providers.includes(provider))){
  const rules=field.rules;let value=rules.fixed;
  if(value===undefined)switch(field.type){
   case 'string':case 'slug':value='acceptance-extension';break;
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
   default:throw Error('Unsupported publisher field type '+field.type);
  }
  set(data,field.path,value);
 }
 data.extends={...base.pin};data.projectId=projectId;data.config.implementation.provider=provider;data.config.publication.channel=provider+'-release';
 for(const owner of ['ontology','harness'])data.assets[owner].projectId=projectId;
 return data;
}
function extension(base,projectId,id='project.e04-check',slot='after-plan',type='check'){
 const action=base.actions.find(a=>a.type===type);assert(action);
 return{id,slot,type,actionRef:action.id,actionVersion:action.version,actionDigest:action.digest,parameters:Object.fromEntries(Object.keys(action.parameterSchema).map(key=>[key,'binding:acceptance/'+key.toLowerCase()])),requirementRefs:['binding:acceptance/requirement'],evidenceMappingRef:'binding:acceptance/mapping',scopeRef:'scope:'+projectId,budget:{timeoutSeconds:1,maxAttempts:1,maxConcurrency:1,maxLoops:1},dependsOn:[]};
}
function controlSource(run,fallback){
 const selected=run.selection.extensionConfiguration;if(!selected)return fallback;
 assert.equal(path.resolve(selected.yamlRef),selected.yamlRef);assert.equal(fs.realpathSync(selected.yamlRef),selected.yamlRef);
 const stat=fs.lstatSync(selected.yamlRef);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=262144&&stat.uid===process.getuid()&&(stat.mode&0o077)===0);
 const bytes=fs.readFileSync(selected.yamlRef);assert.equal(sha(bytes),selected.yamlSha256);return bytes.toString('utf8');
}
function diagnostic(preview,code,expectedPath){
 assert.equal(preview.compilation.valid,false);assert.equal(preview.ready,false);
 assert(preview.compilation.issues.some(i=>i.code===code&&i.path&&(!expectedPath||i.path===expectedPath)&&i.rule&&i.remedy),'Missing exact server diagnosis '+code+(expectedPath?' at '+expectedPath:''));
}
async function rejected(run,c,entry,source,code,suffix,expectedPath){
 const before=await run.read('lifecycle.definition.inspect');
 const saved=await run.configurationEntry(entry,'lifecycle.draft.save',{yaml:source},{requestId:run.requestId(c.caseInstanceId,'negative-'+suffix),expectedRevision:before.revision});assert.equal(saved.result.result.status,'DRAFT');
 const preview=(await run.configurationEntry(entry,'lifecycle.definition.validate',{yaml:source})).result;diagnostic(preview,code,expectedPath);
 const draft=await run.read('lifecycle.definition.inspect');
 const activated=await run.configurationEntry(entry,'lifecycle.definition.save-and-activate',{yaml:source,validationDigest:preview.validationDigest},{requestId:run.requestId(c.caseInstanceId,'blocked-'+suffix),expectedRevision:draft.revision});
 assert.equal(activated.result.result.status,'BLOCKED');assert.equal(activated.result.result.executionAuthorized,false);assert.equal(activated.result.result.releaseAuthorized,false);
 if(expectedPath)assert(activated.result.result.issues.some(i=>i.code===code&&i.path===expectedPath&&i.rule&&i.remedy),'Activation must retain the same exact scoped rejection');
 const after=await run.read('lifecycle.definition.inspect');assert.deepEqual(after.active,before.active);assert.equal(await run.source(after.draft.id),source);
 if(before.active)assert.equal(after.active.id,before.active.id);
 return{code,...(expectedPath?{path:expectedPath}:{}),entry,blocked:true,activeUnchanged:true};
}
async function effective(run,source){const result=await run.read('lifecycle.definition.validate',{yaml:source});assert.equal(result.compilation.valid,true,JSON.stringify(result.compilation.issues));return result;}
function fixedGraph(base,result){
 const nodes=result.compilation.effective.nodes;
 for(const stage of base.stages){const actual=nodes.find(n=>n.id===stage.id);assert(actual&&actual.source==='base'&&actual.required===true);for(const required of stage.requires)assert(actual.dependsOn.includes(required));for(const check of stage.checks)assert(actual.checks.includes(check));}
 for(const node of nodes.filter(n=>n.source==='project')){const slot=base.slots[node.stage];assert(slot&&node.required===true&&node.dependsOn.includes(slot.predecessor));assert(nodes.find(n=>n.id===slot.successor).dependsOn.includes(node.id));}
 return nodes.filter(n=>n.source==='project').map(n=>({id:n.id,slot:n.stage,dependsOn:n.dependsOn}));
}
async function entryCase(run,c,base,source,entry){
 const data=parse(source);assert.equal(data.projectId,run.selection.projectId);assert(data.extensions?.length,'E04 positive entry acceptance requires an exact registered extension configuration; an extension-free baseline cannot qualify it');
 const control=(await run.configurationEntry(entry,'lifecycle.definition.validate',{yaml:source})).result;assert.equal(control.ready,true,'Real extension owner/action/requirement bindings must be ready');const graph=fixedGraph(base,control);
 const before=await run.read('lifecycle.definition.inspect');
 const activated=await run.configurationEntry(entry,'lifecycle.definition.save-and-activate',{yaml:source,validationDigest:control.validationDigest},{requestId:run.requestId(c.caseInstanceId,'positive-activation'),expectedRevision:before.revision});assert.equal(activated.result.result.status,'ACTIVE');assert.equal(activated.result.result.executionAuthorized,false);assert.equal(activated.result.result.releaseAuthorized,false);
 const active=await run.read('lifecycle.definition.inspect');assert.equal(await run.source(active.active.id),source);
 const mutations=[['base-pin',d=>d.extends.version='latest','BASE_PIN'],['base-delete',d=>d.stages=[],'UNKNOWN_FIELD'],['or',d=>d.extensions[0].condition='OR','EXTENSION_FIELDS'],['optional',d=>d.extensions[0].required=false,'EXTENSION_FIELDS'],['wrong-scope',d=>d.extensions[0].scopeRef='scope:other','EXTENSION_SCOPE']];
 const negatives=[];for(const [name,mutate,code]of mutations){const d=structuredClone(data);mutate(d);negatives.push(await rejected(run,c,entry,yaml(d),code,name));}
 assert.deepEqual(await run.read('lifecycle.base.inspect'),base);
 return{entry,actualInstalledService:true,exactRegisteredExtensionsActivated:true,graph,negatives,baseUnchanged:true,executionDispatched:false,releaseAuthorized:false};
}
async function browserEntry(run,c,base,source,browser,graphMode){
 const data=parse(source);assert(data.extensions?.length,'An exact registered positive extension is required for UI entry acceptance');
 assert.equal((await effective(run,source)).ready,true);
 const before=await run.read('lifecycle.definition.inspect');await run.configurationEntry('http-api','lifecycle.draft.save',{yaml:source},{requestId:run.requestId(c.caseInstanceId,'browser-control'),expectedRevision:before.revision});
 const ui=await openBrowser(run,browser);
 try{
  const first=data.extensions[0],invalid=structuredClone(first);invalid.scopeRef='scope:foreign';
  if(graphMode){
   const locked=base.fields.find(f=>f.policy==='LOCKED'&&f.providers.includes(data.config.implementation.provider));assert(locked);
   await ui.step('Verify a publisher-owned Base property is locked in the actual graph editor',async()=>{await ui.node(locked.stage).click();await expect(ui.page.locator('#field-'+locked.id)).toBeDisabled();});
   await ui.step('Select the actual SeeCode project node and change its extension scope',async()=>{await ui.node(first.id).click();await ui.page.getByLabel('扩展属性（JSON）').fill(JSON.stringify(invalid,null,2));await ui.page.getByRole('button',{name:'应用扩展属性',exact:true}).click();await expect.poll(async()=>parse(await ui.source.inputValue()).extensions[0].scopeRef).toBe('scope:foreign');});
  }else{const bad=structuredClone(data);bad.extends.version='latest';await ui.step('Edit the Base pin in the actual YAML editor',()=>ui.source.fill(yaml(bad)));}
  await ui.preview();await expect(ui.page.getByRole('button',{name:'保存并启用',exact:true})).toBeDisabled();
  const rejectedPreview=await run.read('lifecycle.definition.validate',{yaml:await ui.source.inputValue()});diagnostic(rejectedPreview,graphMode?'EXTENSION_SCOPE':'BASE_PIN');
  await ui.save();assert.deepEqual((await run.read('lifecycle.definition.inspect')).active,before.active);
  if(graphMode){await ui.page.getByLabel('扩展属性（JSON）').fill(JSON.stringify(first,null,2));await ui.page.getByRole('button',{name:'应用扩展属性',exact:true}).click();}
  else await ui.source.fill(source);
  await ui.preview();await expect(ui.page.getByRole('button',{name:'保存并启用',exact:true})).toBeEnabled();const submitted=await ui.source.inputValue();await ui.activate();
  const after=await run.read('lifecycle.definition.inspect');assert.equal(await run.source(after.active.id),submitted);
  fixedGraph(base,await effective(run,submitted));assert.deepEqual(await run.read('lifecycle.base.inspect'),base);
  await ui.flush();
  assert.equal(ui.network.filter(r=>r.request?.operation==='lifecycle.definition.save-and-activate').length,1,'Only the repaired exact preview may dispatch activation');
  assert(!ui.network.some(r=>['lifecycle.instance.create','lifecycle.stage.request'].includes(r.request?.operation)));
  return{entry:graphMode?'dashboard-graph':'dashboard-yaml',actualBrowser:true,serverRejectionObserved:true,invalidDraftRetained:true,repairedExactExtensionActivated:true,baseUnchanged:true,executionDispatched:false};
 }finally{await ui.close();}
}
async function schemaCase(run,c,base){
 const negatives=[];
 for(const provider of ['github','gitlab']){
  const data=structural(base,provider,run.selection.projectId),source=yaml(data),control=await effective(run,source);assert.equal(control.compilation.effective.semantic.config.implementation.provider,provider);
  const opposite=provider==='github'?'pipelinePath':'workflowPath';assert.equal(data.config.implementation[opposite],undefined);
  const fixed=base.fields.find(f=>f.providers.includes(provider)&&f.policy==='LOCKED'&&f.rules.fixed!==undefined);assert(fixed);
  const missing=provider==='github'?'config.implementation.workflowPath':'config.implementation.pipelinePath';
  for(const [name,mutate,code]of [['unknown',d=>d.unknown='forbidden','UNKNOWN_FIELD'],['locked',d=>set(d,fixed.path,typeof fixed.rules.fixed==='boolean'?!fixed.rules.fixed:'forbidden'),'INVALID_VALUE'],['required',d=>set(d,missing,undefined),'REQUIRED_FIELD'],['inactive',d=>d.config.implementation[opposite]='other.yml','INACTIVE_PROVIDER_FIELD']]){const d=structuredClone(data);mutate(d);negatives.push(await rejected(run,c,'http-api',yaml(d),code,provider+'-'+name));}
  negatives.push(await rejected(run,c,'http-api',source+'projectId: duplicate\n','YAML_PARSE',provider+'-duplicate'));
 }
 assert.deepEqual(await run.read('lifecycle.base.inspect'),base);
 return{providers:['github','gitlab'],structuralControl:'SYNTHETIC_CONFIGURATION_REAL_INSTALLED_COMPILER',oppositeProviderFieldsNotRequired:true,negatives,baseUnchanged:true,executionDispatched:false};
}
async function graphAttacks(run,c,base,activeData){
 const data=structuredClone(activeData);data.extensions=[extension(base,run.selection.projectId)];fixedGraph(base,await effective(run,yaml(data)));
 const mutations=[
  ['delete-base',d=>d.stages=[],'UNKNOWN_FIELD'],
  ['cross-slot',d=>{d.extensions.push(extension(base,run.selection.projectId,'project.other','candidate-checks'));d.extensions[0].dependsOn=['project.other'];},'CROSS_SLOT_DEPENDENCY'],
  ['skip-publication',d=>d.extensions[0].dependsOn=['publication'],'EXTENSION_DEPENDENCY'],
  ['cycle',d=>d.extensions[0].dependsOn=[d.extensions[0].id],'GRAPH_CYCLE'],
  ['orphan',d=>d.extensions[0].dependsOn=['project.absent'],'CROSS_SLOT_DEPENDENCY'],
  ['base-id',d=>d.extensions[0].id='verification','EXTENSION_ID'],
  ['duplicate-id',d=>d.extensions.push(structuredClone(d.extensions[0])),'EXTENSION_ID'],
  ['or',d=>d.extensions[0].condition='OR','EXTENSION_FIELDS'],
  ['optional',d=>d.extensions[0].required=false,'EXTENSION_FIELDS'],
  ['continue',d=>d.extensions[0]['continue-on-error']=true,'EXTENSION_FIELDS'],
 ];
 const negatives=[];for(const [name,mutate,code]of mutations){const changed=structuredClone(data);mutate(changed);negatives.push(await rejected(run,c,'http-api',yaml(changed),code,name));}
 assert.deepEqual(await run.read('lifecycle.base.inspect'),base);return{entry:'http-api',actualServiceDefinitionAndActivationRejection:true,negatives,allBaseNodesAndChecksRetained:true,baseUnchanged:true,executionDispatched:false};
}
async function actionAttacks(run,c,base,activeData){
 const data=structuredClone(activeData);data.extensions=[extension(base,run.selection.projectId)];await effective(run,yaml(data));
 const mutations=[['unregistered',d=>d.extensions[0].actionRef='custom.execute','ACTION_PIN','extensions.0.actionRef'],['wrong-scope',d=>d.extensions[0].scopeRef='scope:foreign','EXTENSION_SCOPE','extensions.0.scopeRef'],['shell',d=>d.extensions[0].parameters.shell='echo forbidden','ACTION_PARAMETERS','extensions.0.parameters'],['javascript',d=>d.extensions[0].parameters.javascript='throw 0','ACTION_PARAMETERS','extensions.0.parameters'],['new-provider',d=>d.config.implementation.provider='custom','INACTIVE_PROVIDER_FIELD','config.implementation.provider'],['candidate-mutation',d=>{d.extensions[0]=extension(base,run.selection.projectId,'project.candidate-write','candidate-checks','operation');},'EXTENSION_SLOT','extensions.0.slot'],['candidate-publish',d=>{d.extensions[0].slot='candidate-checks';d.extensions[0].actionRef='runtime.release.publish';},'ACTION_PIN','extensions.0.actionRef']];
 const negatives=[];for(const [name,mutate,code,expectedPath]of mutations){const changed=structuredClone(data);mutate(changed);negatives.push(await rejected(run,c,'http-api',yaml(changed),code,name,expectedPath));}
 negatives.push(await rejected(run,c,'http-api',yaml(data).replace(/^projectId:.*$/m,'projectId: !dynamic '+run.selection.projectId),'YAML_PARSE','yaml-tag'));
 assert.deepEqual(await run.read('lifecycle.base.inspect'),base);return{entry:'http-api',actualServerActionAndScopeGuards:true,negatives,candidateMutationAndPublicationDenied:true,externalExecutionRequested:false};
}
const unavailable={
 'E04.EX01':'Two distinct authenticated project bindings and legitimate configurations, plus exact single-Base inheritance attack receipts, are required; one-project validation cannot replace project isolation.',
 'E04.EX03':'All min/max/enum/fixed boundary values AND an actual existing Run whose frozen execution budget cannot be enlarged are required; compiler bounds alone cannot qualify this variant.',
 'E04.EX04':'Actual registered four-slot execution and two parallel checks with FAILED, UNKNOWN, NOT_RUN then PASS observations are required; an effective graph is insufficient.',
 'E04.EX07':'Actual Base-failed/extension-passed, Base-passed/extension-failed, and all-passed-without-release-authority admissions are required.',
 'E04.EX11':'Actual pinned owner report plus failed current Target, rejected latest/forged PASS, and removing the draft check while preserving current obligations are required.',
 'E04.EX12':'All six actual Expert/MCP/API/CLI/graph/YAML entries and all twelve exact extension subcontracts must have current final-candidate evidence; a narrower entry loop cannot qualify it.',
};
test('E04 exact installed Base inheritance and constrained extension cases',async()=>{
 const run=await openScenario('E04');let browser;
 try{
  const base=await run.read('lifecycle.base.inspect');assert.equal(base.projectMutationAllowed,false);
  const initial=await run.read('lifecycle.definition.inspect');assert(initial.active,'Use a real natively activated isolated baseline, never seeded database state');
  const activeSource=await run.source(initial.active.id),activeData=parse(activeSource),positiveSource=controlSource(run,activeSource);
  assert.equal(activeData.projectId,run.selection.projectId);assert.deepEqual(activeData.extends,base.pin);
  if(run.cases.some(c=>['E04.variant.01','E04.variant.02'].includes(c.caseInstanceId)))browser=await chromium.launch({headless:true});
  for(const c of run.cases)await run.collect(c,async()=>{
   if(unavailable[c.caseInstanceId]){run.artifact('required-uncollected-contract.json',{contract:c.parameters.variantContract,reason:unavailable[c.caseInstanceId],sourceTestsNotSubstituted:true});throw Error('UNIMPLEMENTED_REQUIRED_VARIANT: '+unavailable[c.caseInstanceId]);}
   if(['E04.journey','E04.variant.03','E04.variant.04','E04.variant.05'].includes(c.caseInstanceId))return entryCase(run,c,base,positiveSource,c.caseInstanceId==='E04.variant.04'?'cli':c.caseInstanceId==='E04.variant.05'?'http-mcp':'http-api');
   if(['E04.variant.01','E04.variant.02'].includes(c.caseInstanceId))return browserEntry(run,c,base,positiveSource,browser,c.caseInstanceId==='E04.variant.01');
   if(c.caseInstanceId==='E04.EX02')return schemaCase(run,c,base);
   if(c.caseInstanceId==='E04.EX05')return graphAttacks(run,c,base,activeData);
   if(c.caseInstanceId==='E04.EX06')return actionAttacks(run,c,base,activeData);
   throw Error('UNIMPLEMENTED_REQUIRED_VARIANT: '+c.caseInstanceId);
  });
 }finally{await browser?.close();run.finish();}
});
