import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {stringify,parse,parseDocument} from 'yaml';
import {chromium,expect} from '@playwright/test';
import {openScenario,repository,sha} from './support.mjs';

function extensionInputs(run){
 const selected=run.selection.extensionConfiguration;assert(selected,'EX12 needs one protected registered extension YAML shared with E04');
 assert.equal(path.resolve(selected.yamlRef),selected.yamlRef);assert.equal(fs.realpathSync(selected.yamlRef),selected.yamlRef);const stat=fs.lstatSync(selected.yamlRef);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=262144&&stat.uid===process.getuid()&&(stat.mode&0o077)===0);
 const bytes=fs.readFileSync(selected.yamlRef);assert.equal(sha(bytes),selected.yamlSha256);const legal=bytes.toString('utf8'),value=parse(legal);assert.equal(value.projectId,run.selection.projectId);assert(value.extensions?.length);assert.equal(value.extensions[0].scopeRef,'scope:'+run.selection.projectId);assert(legal.endsWith('\n')&&!legal.endsWith('\n\n'));
 const replace=entry=>{const doc=parseDocument(legal,{version:'1.2',strict:true,uniqueKeys:true,stringKeys:true,keepSourceTokens:true,prettyErrors:false});assert.deepEqual(doc.errors,[]);assert.deepEqual(doc.warnings,[]);doc.setIn(['extensions',0],entry);return doc.toString({lineWidth:0});};
 assert.equal(replace(value.extensions[0]),legal,'The shared input must retain exact bytes when its extension properties are applied in the actual graph editor');
 const illegal=replace({...value.extensions[0],scopeRef:'scope:foreign'}),{extensions:good,...rest}=value,{extensions:bad,...other}=parse(illegal);assert.notDeepEqual(good,bad);assert.deepEqual(rest,other);
 return{legal,illegal,reference:selected,legalSha256:sha(legal),illegalSha256:sha(illegal)};
}
function extensionResult(result,valid){
 assert.equal(result.compilation.valid,valid);assert.equal(result.ready,valid);
 if(!valid){assert.equal(result.validationDigest,null);const issues=result.compilation.issues.filter(i=>i.code==='EXTENSION_SCOPE'&&i.path==='extensions.0.scopeRef');assert.equal(issues.length,1);assert(issues[0].rule&&issues[0].remedy);assert(result.issues.some(i=>i.code===issues[0].code&&i.path===issues[0].path&&i.rule===issues[0].rule));}
 return result.issues.map(i=>({code:i.code,path:i.path,rule:i.rule}));
}
async function extensionEntries(run,c,expert){
 const inputs=extensionInputs(run),before=await run.read('lifecycle.definition.inspect'),observations=[];let rejection;
 run.artifact('extension-exact-inputs.json',{...inputs,purpose:'Same exact original legal/illegal extension YAML for all six entry producers; no source-test substitute'});
 for(const entry of ['http-api','http-mcp','cli'])for(const [kind,source]of [['valid',inputs.legal],['invalid',inputs.illegal]]){
  const response=await run.configurationEntry(entry,'lifecycle.definition.validate',{yaml:source}),issues=extensionResult(response.result,kind==='valid');
  if(kind==='invalid'){if(rejection)assert.deepEqual(issues,rejection);else rejection=issues;}
  observations.push({entry,kind,requestId:response.requestId,yamlSha256:sha(source),issues,originalEvidence:'Original case-owned native request/response pair'});
 }
 const prompt='Validate these two exact lifecycle YAML inputs, in order, using runtime_read lifecycle.definition.validate with input containing only yaml. They are deliberately paired extension test inputs. Do not save, activate, repair, change references or dispatch work. Preserve every YAML byte, including one final LF. Report each actual server result and extension diagnostic. Runtime tools are selected; no resource discovery is needed.\n\nLEGAL YAML:\n```yaml\n'+inputs.legal+'```\n\nILLEGAL YAML:\n```yaml\n'+inputs.illegal+'```';
 const observed=await expert.configurationTurn(prompt);assert(!observed.calls.some(call=>call.tool==='runtime_write'));
 const validations=observed.calls.filter(call=>call.tool==='runtime_read'&&call.arguments.operation==='lifecycle.definition.validate');assert(validations.every(call=>[inputs.legal,inputs.illegal].includes(call.arguments.input?.yaml)),'The Expert must not repair or replace either exact input');
 for(const [kind,source]of [['valid',inputs.legal],['invalid',inputs.illegal]]){
  const calls=validations.filter(call=>call.arguments.input.yaml===source);assert(calls.length,'Both inputs require actual completed Expert tool calls');const call=calls.at(-1);assert.deepEqual(Object.keys(call.arguments.input),['yaml']);assert.equal(call.arguments.projectId,run.selection.projectId);assert.equal(call.status,'completed');assert(!call.result.isError);const response=JSON.parse(call.result.content[0].text),issues=extensionResult(response.result,kind==='valid');if(kind==='invalid')assert.deepEqual(issues,rejection);
  observations.push({entry:'expert',kind,itemId:call.id,threadId:observed.threadId,turnId:observed.turnId,requestId:response.requestId,yamlSha256:sha(source),issues,originalEvidence:'Original actual-model Expert configuration transcript'});
 }
 assert.deepEqual(await run.read('lifecycle.definition.inspect'),before,'Read-only extension probes must not mutate any definition');assert.deepEqual(extensionInputs(run),inputs);
 run.artifact('extension-entry-observations.json',{observations,actualModelTurn:true,legalSha256:inputs.legalSha256,illegalSha256:inputs.illegalSha256,remainingEntries:['graph','yaml'],fullTwelveContractQualification:'SEPARATE_E20_EX12_REQUIREMENT'});
 return{entries:['http-api','http-mcp','cli','expert'],observations,exactSameInputs:true,onlyExtensionChanged:true,actualNativeRefusal:'EXTENSION_SCOPE',definitionUnchanged:true,executionDispatched:false,remainingBrowserProducer:'E04.EX12',allTwelveContractsRemainRequired:true};
}

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
function at(value,field){for(const key of field.split('.'))value=value?.[key];return value;}

async function browserCase(run,browser,c,fields,control,initial,activeSource){
 const graph=c.parameters.entry==='dashboard-graph';
 // A reference is a declared Base field type. Graph inputs serialize strings,
 // so exercise its missing/invalid reference representations through the actual
 // form, rather than injecting a null-valued HTTP request and calling it a UI test.
 const spec=fields.find(f=>f.stage===c.parameters.stage&&f.providers.includes(c.parameters.provider)&&f.required&&(graph?f.type==='bindingRef'&&f.policy!=='LOCKED':true));assert(spec);
 const before=await run.read('lifecycle.definition.inspect'),oldDraft=before.draft?await run.source(before.draft.id):null;
 const setup=await run.configurationEntry('http-api','lifecycle.draft.save',{yaml:stringify(control,{lineWidth:0})},{requestId:run.requestId(c.caseInstanceId,'browser-control'),expectedRevision:before.revision});assert.equal(setup.result.result.status,'DRAFT');
 const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage(),actions=[],network=[],pending=new Set(),errors=[];
 const step=async(action,fn)=>{const row={action,startedAt:new Date().toISOString(),status:'STARTED'};actions.push(row);try{const result=await fn();row.status='COMPLETED';return result;}catch(error){row.status='FAILED';row.error=error.message;throw error;}finally{row.finishedAt=new Date().toISOString();}};
 const responseListener=response=>{
  const url=new URL(response.url());if(url.origin!==run.serviceOrigin||url.pathname!=='/api/v1/dashboard/request')return;
  const task=(async()=>{const request=response.request(),raw=await response.text();assert(Buffer.byteLength(raw)<=262144);network.push({at:new Date().toISOString(),method:request.method(),path:url.pathname,request:request.postDataJSON(),status:response.status(),rawBody:raw});})();pending.add(task);task.then(()=>pending.delete(task),error=>{errors.push(error.message);pending.delete(task);});
 };
 try{
  await step('Open the installed lifecycle page and authenticate with a one-use code',async()=>{
   await page.goto(run.serviceOrigin+'/lifecycle');await page.getByLabel('一次性连接码').fill(await run.browserCode());await page.getByRole('button',{name:'连接项目',exact:true}).click();await expect(page.getByRole('heading',{name:'生命周期定义',exact:true})).toBeVisible();
   const response=await context.request.get(run.serviceOrigin+'/api/v1/dashboard/session');assert.equal(response.status(),200);const session=(await response.json()).result;assert.equal(session.serviceId,run.candidate.serviceId);assert.equal(session.projectId,run.selection.projectId);assert.equal(session.workspaceId,run.selection.workspaceId);
  });
  page.on('response',responseListener);page.on('pageerror',error=>errors.push(error.message));
  const source=page.getByLabel('Project Lifecycle YAML');await expect(page.getByText('图形已与当前源码结构核对',{exact:false})).toBeVisible();
  const missing=c.parameters.failure==='missing-required';assert(missing||c.parameters.failure==='invalid-type');
  let expectedValue;
  if(graph){
   expectedValue=missing?'':'not-a-binding-reference';
   await step('Select the SeeCode stage and submit the missing/invalid typed reference in its property field',async()=>{
    await page.locator('[data-sc-node="'+c.parameters.stage+'"]').click();const input=page.locator('#field-'+spec.id);await expect(input).toBeEditable();await input.fill(expectedValue);await input.press('Enter');await expect.poll(async()=>at(parse(await source.inputValue()),spec.path)).toBe(expectedValue);
   });
  }else{
   expectedValue=missing?undefined:null;const invalid=structuredClone(control);set(invalid,spec.path,expectedValue);
   await step('Edit the YAML source through the actual editor',()=>source.fill(stringify(invalid,{lineWidth:0})));
  }
  const submitted=await source.inputValue();assert.equal(at(parse(submitted),spec.path),expectedValue);
  await step('Save the incomplete draft from the same page',async()=>{await page.getByRole('button',{name:'保存草稿',exact:true}).click();await expect(page.getByText('草稿已保存。',{exact:true})).toBeVisible();await expect(source).toBeEditable();});
  await step('Preview validation and verify same-page activation is disabled',async()=>{
   await page.getByRole('button',{name:'校验与差异预览',exact:true}).click();await expect(page.getByRole('heading',{name:'与当前生效版本的准确差异'})).toBeVisible();await expect(page.locator('.issues li').filter({has:page.locator('code').filter({hasText:spec.path})}).first()).toBeVisible();await expect(page.getByRole('button',{name:'保存并启用',exact:true})).toBeDisabled();
  });
  const after=await run.read('lifecycle.definition.inspect');assert.deepEqual(after.active,initial.active);assert.equal(await run.source(after.draft.id),submitted);assert.equal(await run.source(initial.active.id),activeSource);
  if(before.draft)assert.equal(await run.source(before.draft.id),oldDraft);
  await Promise.all([...pending]);assert.deepEqual(errors,[]);
  const saved=network.filter(r=>r.request.operation==='lifecycle.draft.save');assert.equal(saved.length,1);assert.equal(JSON.parse(saved[0].rawBody).result.result.status,'DRAFT');assert.equal(saved[0].request.input.yaml,submitted);
  const previews=network.filter(r=>r.request.operation==='lifecycle.definition.validate'&&r.request.input.yaml===submitted&&r.status===200);assert(previews.length);const preview=JSON.parse(previews.at(-1).rawBody).result;assert.equal(preview.ready,false);assert.equal(preview.compilation.valid,false);issue(preview.compilation.issues,spec.path);
  assert(!network.some(r=>['lifecycle.definition.activate','lifecycle.definition.save-and-activate','lifecycle.instance.create','lifecycle.stage.request'].includes(r.request.operation)),'The disabled UI must not dispatch activation or execution');
  const screenshot=run.imageArtifact(await page.screenshot({fullPage:true}));
  return{entry:c.parameters.entry,stage:c.parameters.stage,field:spec.path,declaredType:spec.type,inputRepresentation:graph?missing?'empty-reference':'invalid-reference-string':missing?'missing-yaml-key':'yaml-null',specificFieldRuleAndRemedy:true,invalidDraftRetained:true,activationBlockedAtActualUi:true,existingActiveAndHistoryUnchanged:true,externalExecutionRequested:false,screenshot,browserVersion:browser.version(),inputKind:'SYNTHETIC_NEGATIVE_CONFIGURATION',service:'ACTUAL_INSTALLED_HTTP',ui:'ACTUAL_INSTALLED_BROWSER'};
 }finally{
  page.off('response',responseListener);await Promise.allSettled([...pending]);
  run.artifact('browser-trace.json',{entry:c.parameters.entry,browserVersion:browser.version(),viewport:{width:1440,height:1000},actions,network,errors,recording:'Actual Playwright actions and browser network responses; authentication headers, cookies, session values and one-use code omitted'});
  await context.close();
 }
}

async function expertCase(run,expert,c,fields,control,initial,activeSource){
 const spec=fields.find(f=>f.stage===c.parameters.stage&&f.providers.includes(c.parameters.provider)&&f.required);assert(spec);
 const missing=c.parameters.failure==='missing-required';assert(missing||c.parameters.failure==='invalid-type');
 const data=structuredClone(control);set(data,spec.path,missing?undefined:null);const yaml=stringify(data,{lineWidth:0});
 const before=await run.read('lifecycle.definition.inspect');assert.deepEqual(before.active,initial.active);
 const oldDraft=before.draft?await run.source(before.draft.id):null,requestId=run.requestId(c.caseInstanceId,'expert-draft');
 const observed=await expert.draft({yaml,requestId,expectedRevision:before.revision});
 const receipt=await run.read('runtime.receipt.read',{requestId});assert.equal(receipt.result.status,'DRAFT');
 const after=await run.read('lifecycle.definition.inspect');assert.deepEqual(after.active,initial.active);assert.equal(after.draft.id,receipt.result.revisionId);assert.equal(await run.source(after.draft.id),yaml);
 assert.equal(await run.source(initial.active.id),activeSource);if(before.draft)assert.equal(await run.source(before.draft.id),oldDraft);
 const call=observed.calls.filter(c=>c.tool==='runtime_read'&&c.arguments.operation==='lifecycle.definition.validate'&&c.arguments.input.yaml===yaml).at(-1);
 const preview=JSON.parse(call.result.content[0].text).result;assert.equal(preview.compilation.valid,false);assert.equal(preview.ready,false);issue(preview.compilation.issues,spec.path);
 assert(!observed.calls.some(c=>['lifecycle.definition.activate','lifecycle.definition.save-and-activate','lifecycle.instance.create','lifecycle.stage.request'].includes(c.arguments.operation)));
 return{entry:'expert',stage:c.parameters.stage,field:spec.path,inputRepresentation:missing?'missing-yaml-key':'yaml-null',actualModelTurn:true,actualInstalledExpert:true,actualInstalledHttpMcp:true,model:observed.model,provider:observed.provider,threadId:observed.threadId,turnId:observed.turnId,originalDraftRequestId:requestId,exactDraftApprovalResponses:observed.approvalResponses,specificFieldRuleAndRemedy:true,invalidDraftRetained:true,activationNotAdmitted:true,existingActiveAndHistoryUnchanged:true,externalExecutionRequested:false,inputKind:'SYNTHETIC_NEGATIVE_CONFIGURATION'};
}

test('E03 fixed candidate service admission cases',async()=>{
 let run,browser,expert,fields,initial,activeSource,eventCursor;const variants=new Map();
 async function collectCase(c){
   if(c.caseInstanceId==='E03.EX12')return extensionEntries(run,c,expert);
   assert(['REAL_SERVICE_PARAMETER','ENTRY_ADMISSION'].includes(c.kind),'This frozen journey still requires its actual collector; it may not be skipped or replaced by a field test');
   if(c.parameters.entry==='expert'){
    const result=await expertCase(run,expert,c,fields,variants.get(c.parameters.provider),initial,activeSource);
    const events=await run.read('runtime.events.read',{cursor:eventCursor});eventCursor=events.cursor;
    assert.deepEqual(events.events.map(e=>e.type),['definition-draft-saved'],'An incomplete Expert draft must not activate or dispatch execution');return result;
   }
   if(['dashboard-graph','dashboard-yaml'].includes(c.parameters.entry)){
    const result=await browserCase(run,browser,c,fields,variants.get(c.parameters.provider),initial,activeSource);
    const events=await run.read('runtime.events.read',{cursor:eventCursor});eventCursor=events.cursor;
    assert.deepEqual(events.events.map(e=>e.type),['definition-draft-saved','definition-draft-saved'],'Control setup and UI draft save must not create an instance or activate a definition');return result;
   }
   const {provider,entry}=c.parameters;assert(['http-api','http-mcp','cli'].includes(entry),'Expert and Dashboard cases require their actual UI/Host collectors');
   const field=c.kind==='REAL_SERVICE_PARAMETER'?c.parameters.field:fields.find(f=>f.stage===c.parameters.stage&&f.providers.includes(provider)&&f.required)?.path;
   const fault=c.kind==='REAL_SERVICE_PARAMETER'?c.parameters.fault:c.parameters.failure==='missing-required'?'missing':c.parameters.failure==='invalid-type'?'invalid-value':null;assert(['missing','invalid-value'].includes(fault));
   const spec=fields.find(f=>f.path===field);assert(spec?.providers.includes(provider));
   const data=structuredClone(variants.get(provider));set(data,spec.path,fault==='missing'?undefined:null);const yaml=stringify(data,{lineWidth:0});
   const before=await run.read('lifecycle.definition.inspect');assert.deepEqual(before.active,initial.active);
   const oldDraft=before.draft?await run.source(before.draft.revisionId??before.draft.id):null;
   const saved=await run.configurationEntry(entry,'lifecycle.draft.save',{yaml},{requestId:run.requestId(c.caseInstanceId,'draft'),expectedRevision:before.revision});assert.equal(saved.result.result.status,'DRAFT');
   const preview=(await run.configurationEntry(entry,'lifecycle.definition.validate',{yaml})).result;assert.equal(preview.ready,false);assert.equal(preview.compilation.valid,false);issue(preview.compilation.issues,spec.path);
   const draft=await run.read('lifecycle.definition.inspect');assert.equal(await run.source(draft.draft.revisionId??draft.draft.id),yaml);
   const activated=await run.configurationEntry(entry,'lifecycle.definition.save-and-activate',{yaml,validationDigest:preview.validationDigest},{requestId:run.requestId(c.caseInstanceId,'activate'),expectedRevision:draft.revision});assert.equal(activated.result.result.status,'BLOCKED');issue(activated.result.result.issues,spec.path);
   const after=await run.read('lifecycle.definition.inspect');assert.deepEqual(after.active,initial.active);assert.equal(await run.source(after.draft.revisionId??after.draft.id),yaml);assert.equal(await run.source(initial.active.revisionId??initial.active.id),activeSource);
   const events=await run.read('runtime.events.read',{cursor:eventCursor});eventCursor=events.cursor;
   assert.deepEqual(events.events.map(e=>e.type),['definition-draft-saved','definition-activation-blocked'],'Invalid configuration must not create an instance or dispatch work');
   if(before.draft)assert.equal(await run.source(before.draft.revisionId??before.draft.id),oldDraft);
   return{entry,field:spec.path,fault,specificFieldRuleAndRemedy:true,invalidDraftRetained:true,activationBlocked:true,existingActiveAndHistoryUnchanged:true,externalExecutionRequested:false,inputKind:'SYNTHETIC_NEGATIVE_CONFIGURATION',service:'ACTUAL_INSTALLED_HTTP'};
 }
 run=await openScenario('E03',{phase:'PRE_RELEASE',register:catalog=>new Map(catalog.filter(c=>c.caseInstanceId==='E03.EX12'||['REAL_SERVICE_PARAMETER','ENTRY_ADMISSION'].includes(c.kind)).map(c=>[c.caseInstanceId,()=>collectCase(c)]))});
 run.artifact('collector-callable-preflight.json',run.callablePreflight);

 try{
  fields=JSON.parse(fs.readFileSync(path.join(repository,'governance/lifecycle-contract-v090.json'))).fields;
  const base=await run.read('lifecycle.base.inspect');assert.deepEqual(base.fields,fields);
  initial=await run.read('lifecycle.definition.inspect');assert(initial.active,'Use a real previously activated isolated baseline; do not seed its database');
  activeSource=await run.source(initial.active.revisionId??initial.active.id);
  for(;;){const page=await run.read('runtime.events.read',eventCursor?{cursor:eventCursor}:{});eventCursor=page.cursor;if(page.events.length<50)break;}
  for(const provider of new Set(run.cases.filter(c=>['REAL_SERVICE_PARAMETER','ENTRY_ADMISSION'].includes(c.kind)).map(c=>c.parameters.provider))){
   const data=structuralInput(base,provider,run.selection.projectId),control=await run.read('lifecycle.definition.validate',{yaml:stringify(data,{lineWidth:0})});
   assert.equal(control.compilation.valid,true,'The negative-case control must be structurally valid');variants.set(provider,data);
  }
  if(run.cases.some(c=>['dashboard-graph','dashboard-yaml'].includes(c.parameters.entry)))browser=await chromium.launch({headless:true});
  if(run.cases.some(c=>c.parameters.entry==='expert'||c.caseInstanceId==='E03.EX12'))expert=await run.openExpert();
  for(const c of run.cases)await run.collectRegistered(c);
 }finally{await browser?.close();await expert?.close();run.finish();}
});
