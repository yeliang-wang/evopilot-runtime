import {pathToFileURL as collectorPathToFileURL} from 'node:url';
import {resolve as collectorResolve} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {stringify,parse,parseDocument} from 'yaml';
import {chromium,expect} from '@playwright/test';
import {openScenario} from './support.mjs';
import {openBrowser} from './browser.mjs';
import {ownerObligations,assertExtensionDenialReasons} from './execution.mjs';
export {assertExtensionDenialReasons} from './execution.mjs';

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
function extensionInputs(run){
 assert(run.selection.extensionConfiguration,'EX12 needs the protected registered extension YAML shared with E03');const legal=controlSource(run),value=parse(legal);assert.equal(value.projectId,run.selection.projectId);assert(value.extensions?.length);assert.equal(value.extensions[0].scopeRef,'scope:'+run.selection.projectId);assert(legal.endsWith('\n')&&!legal.endsWith('\n\n'));
 const replace=entry=>{const doc=parseDocument(legal,{version:'1.2',strict:true,uniqueKeys:true,stringKeys:true,keepSourceTokens:true,prettyErrors:false});assert.deepEqual(doc.errors,[]);assert.deepEqual(doc.warnings,[]);doc.setIn(['extensions',0],entry);return doc.toString({lineWidth:0});};
 assert.equal(replace(value.extensions[0]),legal,'The shared input must retain exact bytes through the actual graph property editor');const invalid={...value.extensions[0],scopeRef:'scope:foreign'},illegal=replace(invalid),{extensions:good,...rest}=value,{extensions:bad,...other}=parse(illegal);assert.notDeepEqual(good,bad);assert.deepEqual(rest,other);
 return{legal,illegal,good:value.extensions[0],bad:invalid,legalSha256:sha(legal),illegalSha256:sha(illegal)};
}
async function extensionBrowserEntries(run,c,browser){
 const inputs=extensionInputs(run),before=await run.read('lifecycle.definition.inspect'),oldDraft=before.draft?await run.source(before.draft.id):null;
 run.artifact('extension-exact-inputs.json',{reference:run.selection.extensionConfiguration,...inputs,purpose:'Exact same legal/illegal source bytes used by E03.EX12; real graph and YAML actions below'});
 // Start from the illegal source so the first graph action truly changes the
 // selected extension. This native setup is not counted as browser evidence.
 const setup=await run.configurationEntry('http-api','lifecycle.draft.save',{yaml:inputs.illegal},{requestId:run.requestId(c.caseInstanceId,'initial-illegal-draft'),expectedRevision:before.revision});assert.equal(setup.result.result.status,'DRAFT');
 const ui=await openBrowser(run,browser),entries=[];let diagnostic;
 try{
  await expect(ui.source).toHaveValue(inputs.illegal);
  for(const entry of ['graph','yaml']){
   const selected={entry};
   for(const [kind,source,properties]of [['valid',inputs.legal,inputs.good],['invalid',inputs.illegal,inputs.bad]]){
    const observation=await ui.validateEdit(entry,source,async()=>{
     if(entry==='graph'){
      await expect(ui.node(inputs.good.id)).toBeVisible();await ui.node(inputs.good.id).click();await ui.page.getByLabel('扩展属性（JSON）').fill(JSON.stringify(properties,null,2));await ui.page.getByRole('button',{name:'应用扩展属性',exact:true}).click();
     }else await ui.source.fill(source);
    });
    const valid=kind==='valid',result=observation.result;assert.equal(result.compilation.valid,valid);assert.equal(result.ready,valid);
    if(valid)await expect(ui.page.getByRole('button',{name:'保存并启用',exact:true})).toBeEnabled();
    else{
     assert.equal(result.validationDigest,null);const issues=result.compilation.issues.filter(i=>i.code==='EXTENSION_SCOPE'&&i.path==='extensions.0.scopeRef');assert.equal(issues.length,1);assert(issues[0].rule&&issues[0].remedy);assert(result.issues.some(i=>i.code===issues[0].code&&i.path===issues[0].path&&i.rule===issues[0].rule));const exact=result.issues.map(i=>({code:i.code,path:i.path,rule:i.rule}));if(diagnostic)assert.deepEqual(exact,diagnostic);else diagnostic=exact;await expect(ui.page.getByRole('button',{name:'保存并启用',exact:true})).toBeDisabled();
    }
    await ui.screenshot();selected[kind]={actionIndex:observation.actionIndex,networkIndex:observation.networkIndex};
   }
   entries.push(selected);
  }
  await ui.flush();assert(!ui.network.some(row=>row.request&&['lifecycle.draft.save','lifecycle.definition.activate','lifecycle.definition.save-and-activate','lifecycle.instance.create','lifecycle.stage.request'].includes(row.request.operation)),'UI probes only edit and validate; no write or execution may be inferred from them');
  const after=await run.read('lifecycle.definition.inspect');assert.equal(after.revision,before.revision+1);assert.deepEqual(after.active,before.active);assert.equal(await run.source(after.draft.id),inputs.illegal);if(before.draft)assert.equal(await run.source(before.draft.id),oldDraft);assert.deepEqual(extensionInputs(run),inputs);
  const trace=await ui.close(),proofs=entries.map(item=>({entry:item.entry,...Object.fromEntries(['valid','invalid'].map(kind=>[kind,{caseInstanceId:c.caseInstanceId,artifact:trace.artifact,...item[kind]}]))}));
  run.artifact('extension-entry-observations.json',{entries:proofs,legalSha256:inputs.legalSha256,illegalSha256:inputs.illegalSha256,issues:diagnostic,remainingEntries:['expert','http-mcp','http-api','cli'],fullTwelveContractQualification:'SEPARATE_E20_EX12_REQUIREMENT'});
  return{entries:proofs,exactSameInputs:true,onlyExtensionChanged:true,actualGraphAndYaml:true,causalValidationEvidence:true,actualNativeRefusal:'EXTENSION_SCOPE',activeUnchanged:true,executionDispatched:false,remainingProducer:'E03.EX12',allTwelveContractsRemainRequired:true};
 }finally{await ui.close();}
}
async function eventInventory(run){
 const events=[];let cursor;
 for(let page=0;page<400;page++){const result=await run.read('runtime.events.read',cursor?{cursor}:{});assert(result.events.length<=50);events.push(...result.events);cursor=result.cursor;if(!result.events.length)return{events,cursor};}
 throw Error('EX03_EVENT_BOUND: select a bounded isolated fixture');
}
async function parameterBoundaries(run,base){
 const observations=[],selected=base.fields.filter(f=>f.type==='integer'||f.type==='enum'||f.rules.fixed!==undefined||f.rules.minItems!==undefined||Array.isArray(f.rules.values));
 const probe=async(field,provider,name,value,expected,ruleClass)=>{
  let actualProvider=provider;if(expected&&field.path==='config.implementation.provider')actualProvider=value;if(expected&&field.path==='config.publication.channel')actualProvider=value==='github-release'?'github':'gitlab';
  const input=structural(base,actualProvider,run.selection.projectId);set(input,field.path,value);const source=yaml(input),response=await run.configurationEntry('http-api','lifecycle.definition.validate',{yaml:source}),result=response.result;
  assert.equal(result.compilation.valid,expected,field.path+' '+name+' '+JSON.stringify(result.compilation.issues));
  if(!expected){assert.equal(result.ready,false);assert.equal(result.validationDigest,null);const providerSelection=field.path==='config.implementation.provider',code=providerSelection?'INACTIVE_PROVIDER_FIELD':'INVALID_VALUE',rule=providerSelection?'provider.exclusive':'field.'+field.policy.toLowerCase();assert(result.compilation.issues.some(i=>i.code===code&&i.path===field.path&&i.rule===rule&&i.remedy),'The refusal must identify the tested field/rule, not unrelated missing bindings');}
  observations.push({fieldId:field.id,path:field.path,ruleClass,case:name,declaredRules:field.rules,requestedProvider:provider,templateProvider:actualProvider,actualProvider:input.config.implementation.provider,value,expectedCompilation:expected,observedCompilation:result.compilation.valid,requestId:response.requestId,sourceSha256:sha(source),bindingReadiness:result.ready,bindingReadinessNotUsedAsParameterVerdict:true});
 };
 for(const field of selected)for(const provider of field.providers){
  const r=field.rules;
  if(r.fixed!==undefined){await probe(field,provider,'only-allowed-value',r.fixed,true,'fixed');await probe(field,provider,'different-value',String(r.fixed)+'-changed',false,'fixed');continue;}
  if(field.type==='integer'){
   assert(Number.isSafeInteger(r.minimum)&&Number.isSafeInteger(r.maximum)&&r.maximum-r.minimum>=2);
   for(const [name,value,ok]of [['below-minimum',r.minimum-1,false],['minimum',r.minimum,true],['strict-interior',r.minimum+1,true],['maximum',r.maximum,true],['above-maximum',r.maximum+1,false]])await probe(field,provider,name,value,ok,'min/max');continue;
  }
  if(field.type==='enum'){
   assert(Array.isArray(r.values)&&r.values.length);for(const value of r.values)await probe(field,provider,'allowed-member',value,true,'enum');await probe(field,provider,'outside-enumeration','not-an-allowed-member',false,'enum');continue;
  }
  const allowed=r.values,required=r.contains??[];
  if(allowed){
   for(const value of allowed)await probe(field,provider,'allowed-list-member',[...new Set([...required,value])],true,'enum-list');
   await probe(field,provider,'all-allowed-members',[...allowed],true,'enum-list');await probe(field,provider,'outside-list-enumeration',[...required,'not-an-allowed-member'],false,'enum-list');
   await probe(field,provider,'below-required-list-minimum',[],false,'min/list');
   if(required.length)await probe(field,provider,'missing-required-member',required.slice(1),false,'fixed/list-contains');
  }else{
   const minimum=r.minItems??1,values=n=>Array.from({length:n},(_,i)=>field.type==='bindingList'?'binding:acceptance/boundary-'+i:'boundary-'+i+'.md');
   for(const [name,count,ok]of [['below-minimum',minimum-1,false],['minimum',minimum,true],['strict-interior',minimum+1,true],['maximum-supported-items',64,true],['above-supported-items',65,false]])await probe(field,provider,name,values(count),ok,'min/max-list');
  }
 }
 assert(selected.every(f=>observations.some(o=>o.fieldId===f.id)));run.artifact('parameter-boundary-observations.json',{fields:selected.map(f=>({id:f.id,path:f.path,type:f.type,rules:f.rules})),observations,entry:'ACTUAL_INSTALLED_HTTP_API',structuralParametersOnly:true,actualRunBudgetProofStillRequired:true});return observations;
}
async function frozenRunBudget(run,c,base,activeSource){
 const baseline=await eventInventory(run),created=baseline.events.filter(e=>e.type==='lifecycle-instance-created'),candidates=[];
 for(const event of created){
  const instance=(await run.read('lifecycle.instance.inspect',{instanceId:event.data.instanceId})).instance;
  if(instance.requestIds.length&&instance.stages.scope?.status==='PASSED'&&instance.stages.plan?.status==='PASSED'&&instance.stages.implementation?.requestId)candidates.push({instance,authorityRef:event.data.authorityRef});
 }
 assert(candidates.length,'EX03 needs an existing actual admitted Run and original execution request; an inert PENDING fixture cannot replace it');candidates.sort((a,b)=>a.instance.id.localeCompare(b.instance.id));const chosen=candidates[0],original=chosen.instance,stageRequestId=original.stages.implementation.requestId;
 const request=await run.read('lifecycle.stage.request.inspect',{stageRequestId}),handoff=await run.read('lifecycle.agent.handoff.read',{stageRequestId}),authority=await run.read('lifecycle.authority.inspect',{authorityRef:chosen.authorityRef});assert.equal(request.progress.phase,'WAITING_AGENT');assert.equal(request.request.instanceId,original.id);assert.equal(request.request.pinsDigest,original.pinsDigest);assert.equal(request.request.authorityRef,chosen.authorityRef);assert.equal(handoff.handoff.runtimeStartsAgent,false);assert.equal(handoff.claim,null);assert.equal(handoff.latestReport,null);assert.equal(authority.decision.subject.instanceId,original.id);assert.deepEqual(authority.decision.subject.budget,original.pins.budget);
 const before=await run.read('lifecycle.definition.inspect'),oldDraft=before.draft?await run.source(before.draft.id):null;assert.equal(await run.source(before.active.id),activeSource);const enlarged=parse(activeSource);
 for(const phase of ['plan','verification'])for(const key of ['timeoutSeconds','maxAttempts','maxConcurrency','maxLoops']){const field=base.fields.find(f=>f.path==='config.'+phase+'.budget.'+key);assert(field&&Number.isSafeInteger(field.rules.maximum));assert(original.pins.budget[key]<field.rules.maximum,'Select an original Run with a real remaining enlargement attempt');enlarged.config[phase].budget[key]=field.rules.maximum;}
 let nextSource=yaml(enlarged);assert.notEqual(nextSource,activeSource);let preview=(await run.configurationEntry('http-api','lifecycle.definition.validate',{yaml:nextSource})).result;
 if(!preview.ready){
  // The publisher permits a wider budget than this project's real environment.
  // Preserve that refusal and keep its configured concurrency limit; the plan
  // still attempts to enlarge every original Run budget dimension.
  assert.equal(preview.compilation.valid,true);assert.deepEqual(preview.issues.map(i=>({code:i.code,path:i.path,rule:i.rule})),[{code:'BINDING_NOT_READY',path:'config.verification.environmentRef',rule:'binding.current-scoped-evidence'}]);
  run.artifact('environment-budget-refusal.json',{sourceSha256:sha(nextSource),preview,environmentConfigurationUnchanged:true,requestedVerificationConcurrency:enlarged.config.verification.budget.maxConcurrency});
  enlarged.config.verification.budget.maxConcurrency=parse(activeSource).config.verification.budget.maxConcurrency;nextSource=yaml(enlarged);preview=(await run.configurationEntry('http-api','lifecycle.definition.validate',{yaml:nextSource})).result;
 }
 assert.equal(preview.ready,true,'Use genuine current registered bindings for the actual definition transition');
 for(const key of ['timeoutSeconds','maxAttempts','maxConcurrency','maxLoops'])assert(enlarged.config.plan.budget[key]>original.pins.budget[key],'The actual activated definition must attempt enlargement in every original Run budget dimension');
 run.artifact('frozen-run-budget-original.json',{selectionReason:'Deterministic first existing actual admitted Run with native scope/plan completion and original WAITING_AGENT request; no new grant or execution',candidateIds:candidates.map(c=>c.instance.id),instance:original,request:request.request,originalPhase:request.progress.phase,handoff,decision:authority.decision,authorityCurrentlyUsable:authority.usable,authorityCurrentReason:authority.reason,enlargedDefinitionBudgets:{plan:enlarged.config.plan.budget,verification:enlarged.config.verification.budget},expiryDoesNotSubstituteForBudgetEvidence:true});
 const unchanged=async phase=>{const instance=(await run.read('lifecycle.instance.inspect',{instanceId:original.id})).instance;assert.deepEqual(instance,original);const current=await run.read('lifecycle.stage.request.inspect',{stageRequestId});assert.deepEqual(current.request,request.request);assert.equal(current.progress.phase,'WAITING_AGENT');assert.deepEqual(await run.read('lifecycle.agent.handoff.read',{stageRequestId}),handoff);const decision=await run.read('lifecycle.authority.inspect',{authorityRef:chosen.authorityRef});assert.deepEqual(decision.decision,authority.decision);assert.deepEqual(decision.revocation,authority.revocation);run.artifact('frozen-run-budget-readback.json',{phase,instanceId:original.id,pinsDigest:instance.pinsDigest,budget:instance.pins.budget,originalDefinitionRevisionId:instance.pins.definitionRevisionId,stageRequestId,originalDeadlineAt:current.request.deadlineAt,originalDecisionUnchanged:true,originalRequestAndHandoffUnchanged:true,actualAuthorityUsable:decision.usable,actualAuthorityReason:decision.reason});};
 let activated=false,restored=false;
 try{
  const draft=await run.configurationEntry('http-api','lifecycle.draft.save',{yaml:nextSource},{requestId:run.requestId(c.caseInstanceId,'enlarged-draft'),expectedRevision:before.revision});assert.equal(draft.result.result.status,'DRAFT');await unchanged('AFTER_ENLARGED_DRAFT');
  const exact=(await run.configurationEntry('http-api','lifecycle.definition.validate',{yaml:nextSource})).result;assert.equal(exact.ready,true);const current=await run.read('lifecycle.definition.inspect');const enabled=await run.configurationEntry('http-api','lifecycle.definition.save-and-activate',{yaml:nextSource,validationDigest:exact.validationDigest},{requestId:run.requestId(c.caseInstanceId,'enlarged-definition'),expectedRevision:current.revision});assert.equal(enabled.result.result.status,'ACTIVE');activated=true;assert.equal(enabled.result.result.executionAuthorized,false);assert.notEqual(enabled.result.result.activeRevisionId,original.pins.definitionRevisionId);await unchanged('AFTER_ENLARGED_ACTIVE_DEFINITION');
 }finally{
  // Reversible fixture restoration uses a fresh exact native preview. A missing
  // or uncertain activation receipt is never interpreted as permission to retry.
  if(activated){const preview=(await run.configurationEntry('http-api','lifecycle.definition.validate',{yaml:activeSource})).result;assert.equal(preview.ready,true);const view=await run.read('lifecycle.definition.inspect'),result=await run.configurationEntry('http-api','lifecycle.definition.save-and-activate',{yaml:activeSource,validationDigest:preview.validationDigest},{requestId:run.requestId(c.caseInstanceId,'restore-active'),expectedRevision:view.revision});assert.equal(result.result.result.status,'ACTIVE');assert.equal(result.result.result.activeRevisionId,before.active.id);if(oldDraft!==null&&oldDraft!==activeSource){const view=await run.read('lifecycle.definition.inspect'),saved=await run.configurationEntry('http-api','lifecycle.draft.save',{yaml:oldDraft},{requestId:run.requestId(c.caseInstanceId,'restore-draft'),expectedRevision:view.revision});assert.equal(saved.result.result.revisionId,before.draft.id);}restored=true;}
 }
 assert(activated&&restored);await unchanged('AFTER_ORIGINAL_DEFINITION_RESTORED');const final=await run.read('lifecycle.definition.inspect');assert.deepEqual(final.active,before.active);assert.deepEqual(final.draft,before.draft);const added=await run.read('runtime.events.read',{cursor:baseline.cursor});assert.deepEqual(added.events.map(e=>e.type),['definition-draft-saved','definition-activated','definition-activated',...(oldDraft!==null&&oldDraft!==activeSource?['definition-draft-saved']:[])]);
 return{instanceId:original.id,stageRequestId,pinsDigest:original.pinsDigest,originalBudget:original.pins.budget,originalRequestDeadline:request.request.deadlineAt,realNativePrerequisites:['scope','plan'],realOriginalHandoff:true,enlargedDraftCannotReplenishRun:true,enlargedActiveDefinitionCannotReplenishRun:true,originalDefinitionRestored:true,newGrants:0,newInstances:0,newStageRequests:0,expiryNotUsedAsBudgetProof:true};
}
async function budgetBoundaries(run,c,base,activeSource){const parameters=await parameterBoundaries(run,base),frozenRun=await frozenRunBudget(run,c,base,activeSource);return{parameterProbes:parameters.length,allExplicitRuleFields:[...new Set(parameters.map(p=>p.fieldId))],ruleFamilies:['min','max','enum','fixed'],actualNativeParameterResults:true,frozenRun,compilerOnlyEvidenceNotSubstituted:true};}
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
// Fixed E04.EX01 installed acceptance. No new public product API.
async function exactSingleBaseProjects(run,c,browser,base){
 assert.equal(c.caseInstanceId,'E04.EX01');assert(browser);
 const aliases=['default','beta'],principals=aliases.map(alias=>run.principal(alias));
 assert.notEqual(principals[0].projectId,principals[1].projectId);assert.notEqual(principals[0].principalId,principals[1].principalId);
 for(const p of principals)for(const permission of ['read','draft.write','definition.activate'])assert(p.expectedPermissions.includes(permission));
 const read=async(alias,operation,input={})=>{const response=await run.principalRequest(alias,operation,input);assert.equal(response.status,200,JSON.stringify(response.body));assert(!response.body.error);return response.body.result;};
 const source=async(alias,revisionId)=>{let offset=0,digest,total;const chunks=[];for(let i=0;i<9;i++){const p=await read(alias,'lifecycle.definition.source.read',{revisionId,offset});assert.equal(p.revisionId,revisionId);assert.equal(p.encoding,'base64');digest??=p.sourceDigest;total??=p.totalBytes;assert.equal(p.sourceDigest,digest);assert.equal(p.totalBytes,total);chunks.push(Buffer.from(p.data,'base64'));if(p.nextOffset===null){const bytes=Buffer.concat(chunks);assert.equal(bytes.length,total);assert.equal('sha256:'+sha(bytes),digest);return bytes.toString('utf8');}assert(p.nextOffset>offset);offset=p.nextOffset;}assert.fail('EX01 bounded definition source exceeded 256 KiB');};
 const events=async alias=>{let cursor,last=0;const rows=[];for(let i=0;i<21;i++){const p=await read(alias,'runtime.events.read',cursor?{cursor}:{});assert(Array.isArray(p.events)&&p.events.length<=50);for(const row of p.events){assert(row.seq>last);last=row.seq;rows.push(row);}if(!p.events.length)return rows;assert.notEqual(p.cursor,cursor);cursor=p.cursor;}assert.fail('EX01 requires a fresh isolated project with at most 1000 events');};
 const inventory=async alias=>{
  const view=await read(alias,'lifecycle.definition.inspect');assert.equal(view.projectId,run.principal(alias).projectId);assert(view.active&&view.draft);
  const rows=await events(alias),created=rows.filter(row=>row.type==='lifecycle-instance-created'),instances=[];assert(created.length>0,'Each project independently needs an actual natively admitted current instance');
  assert.equal(new Set(created.map(row=>row.data.instanceId)).size,created.length);
  for(const row of created){const observed=await read(alias,'lifecycle.instance.inspect',{instanceId:row.data.instanceId}),instance=observed.instance;assert.equal(instance.pins.projectId,view.projectId);assert.deepEqual(instance.pins.base,base.pin);assert.deepEqual(instance.requestIds,[]);for(const stage of Object.values(instance.stages)){assert.equal(stage.status,'PENDING');assert.equal(stage.attempts,0);assert.equal(stage.requestId,null);}const authority=await read(alias,'lifecycle.authority.inspect',{authorityRef:row.data.authorityRef});assert.equal(authority.decision.subject.instanceId,instance.id);instances.push({instance,authorityRef:row.data.authorityRef,decision:authority.decision,revocation:authority.revocation});}
  return{view,activeSource:await source(alias,view.active.id),draftSource:await source(alias,view.draft.id),events:rows,instances};
 };
 const manifestRef=path.join(run.selection.installedRoot,'distribution-manifest.json'),manifestBytes=fs.readFileSync(manifestRef);assert.equal(sha(manifestBytes),run.selection.expectedManifestDigest);const manifest=JSON.parse(manifestBytes),packageRoot=path.join(run.selection.installedRoot,'package');
 const baseFiles=['lifecycle/base/manifest.json','lifecycle/base/software-release-0.9.0.json'];
 const captureBase=()=>Object.fromEntries(baseFiles.map(relative=>{const ref=path.join(packageRoot,relative),s=fs.lstatSync(ref),pin=manifest.files[relative];assert(pin?.type==='file');assert.equal(fs.realpathSync(ref),ref);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid());assert.equal(s.mode&0o777,pin.mode);const bytes=fs.readFileSync(ref);assert.equal(bytes.length,pin.bytes);assert.equal(sha(bytes),pin.sha256);return[relative,{sha256:sha(bytes),bytes:bytes.length,text:bytes.toString('utf8')}];}));
 const originalBase=captureBase(),publisherManifest=JSON.parse(originalBase[baseFiles[0]].text);assert.equal(publisherManifest.bases.length,1);const{file,...publisherPin}=publisherManifest.bases[0];assert.equal(file,'software-release-0.9.0.json');assert.deepEqual(publisherPin,base.pin);assert.equal('sha256:'+originalBase[baseFiles[1]].sha256,base.pin.digest);
 const baselines={};for(const alias of aliases){assert.deepEqual(await read(alias,'lifecycle.base.inspect'),base);baselines[alias]=await inventory(alias);assert.deepEqual(parse(baselines[alias].activeSource).extends,base.pin);}
 run.artifact('exact-single-base-original.json',{candidate:run.candidate,principals,base:originalBase,projects:baselines,qualification:'Two real native synthetic project configurations and inert instances; not actual CI or business execution'});
 const proofs=[];
 for(const [index,alias]of aliases.entries()){
  const other=aliases[1-index],projectId=run.principal(alias).projectId,initial=await inventory(alias),otherBefore=await inventory(other),data=parse(initial.activeSource),field=base.fields.find(f=>f.path==='config.plan.budget.timeoutSeconds');assert(field?.type==='integer');
  const oldTimeout=data.config.plan.budget.timeoutSeconds,nextTimeout=oldTimeout+index+1<=field.rules.maximum?oldTimeout+index+1:oldTimeout-index-1;assert(nextTimeout>=field.rules.minimum&&nextTimeout<=field.rules.maximum&&nextTimeout!==oldTimeout);data.config.plan.budget.timeoutSeconds=nextTimeout;const legal=yaml(data);
  const stable=async label=>{assert.deepEqual(captureBase(),originalBase,'Publisher Base bytes must remain unchanged');assert.deepEqual(await read(alias,'lifecycle.base.inspect'),base);assert.deepEqual(await read(other,'lifecycle.base.inspect'),base);assert.deepEqual(await inventory(other),otherBefore,'The other project definition, event history and every original instance must remain unchanged');const own=await inventory(alias);assert.deepEqual(own.instances,initial.instances,'New definition configuration cannot mutate existing instance pins or original authority');for(const row of own.events.slice(initial.events.length))assert(['definition-draft-saved','definition-activation-blocked','definition-activated'].includes(row.type));assert.deepEqual(own.events.slice(0,initial.events.length),initial.events);assert.equal(await source(alias,initial.view.active.id),initial.activeSource);run.artifact('project-isolation-readback.json',{label,projectId,otherProjectId:otherBefore.view.projectId,ownRevision:own.view.revision,otherRevision:otherBefore.view.revision,ownInstanceIds:own.instances.map(v=>v.instance.id),otherInstanceIds:otherBefore.instances.map(v=>v.instance.id),basePin:base.pin,originalInstancesUnchanged:true,otherProjectUnchanged:true});return own;};
  const ui=await openBrowser(run,browser,{principalAlias:alias}),proof={projectId,principalId:run.principal(alias).principalId,originalActive:initial.view.active.id,originalInstanceIds:initial.instances.map(x=>x.instance.id),positive:null,negative:[],repair:null};
  try{
   await expect(ui.source).toHaveValue(initial.draftSource);
   const positive=await ui.validateEdit('yaml',legal,()=>ui.source.fill(legal));assert.equal(positive.result.ready,true);assert.equal(positive.result.compilation.valid,true);fixedGraph(base,positive.result);await ui.activate();
   const activated=await stable('AFTER_INDEPENDENT_LEGAL_CONFIGURATION');assert.equal(activated.activeSource,legal);assert.notEqual(activated.view.active.id,initial.view.active.id);assert.notEqual(activated.view.active.semanticDigest,initial.view.active.semanticDigest);proof.positive={sourceSha256:sha(legal),oldTimeout,nextTimeout,revisionId:activated.view.active.id,actionIndex:positive.actionIndex,networkIndex:positive.networkIndex,requestId:positive.requestId};
   const attacks=[['latest',{...base.pin,version:'latest'}],['multiple-bases',[{...base.pin},{...base.pin}]],['project-inherits-project',{projectId:otherBefore.view.projectId,definitionRevisionId:otherBefore.view.active.id}],['alternative-path',{...base.pin,file:'../projects/'+otherBefore.view.projectId+'/lifecycle.yaml'}]];
   for(const[name,inheritance]of attacks){
    const changed=structuredClone(data);changed.extends=inheritance;const invalid=yaml(changed);const{extends:ignored,...rest}=changed,{extends:unused,...legalRest}=data;assert.deepEqual(rest,legalRest);
    await ui.flush();await ui.login();const observation=await ui.validateEdit('yaml',invalid,()=>ui.source.fill(invalid)),preview=observation.result;diagnostic(preview,'BASE_PIN','extends');assert.equal(preview.validationDigest,null);assert(preview.compilation.issues.some(i=>i.code==='BASE_PIN'&&i.path==='extends'&&i.rule==='base.exact-single-pin'&&i.remedy));await expect(ui.page.getByRole('button',{name:'保存并启用',exact:true})).toBeDisabled();
    const view=await read(alias,'lifecycle.definition.inspect'),requestId=run.requestId(c.caseInstanceId,projectId+'-'+name),attempt=await ui.sessionRequest('lifecycle.definition.save-and-activate',{yaml:invalid,validationDigest:null},{requestId,expectedRevision:view.revision});assert.equal(attempt.status,200,JSON.stringify(attempt.body));assert.equal(attempt.body.result.requestId,requestId);const result=attempt.body.result.result;assert.equal(result.status,'BLOCKED');assert.equal(result.executionAuthorized,false);assert.equal(result.releaseAuthorized,false);assert.equal(result.activeRevisionId,activated.view.active.id);assert(result.issues.some(i=>i.code==='BASE_PIN'&&i.path==='extends'&&i.rule==='base.exact-single-pin'));
    const after=await stable('AFTER_'+name.toUpperCase());assert.equal(after.activeSource,legal);assert.equal(after.draftSource,invalid);await ui.screenshot();proof.negative.push({name,input:inheritance,sourceSha256:sha(invalid),actionIndex:observation.actionIndex,networkIndex:observation.networkIndex,previewRequestId:observation.requestId,activationRequestId:requestId,diagnostic:{code:'BASE_PIN',path:'extends',rule:'base.exact-single-pin'},status:result.status,entry:'ACTUAL_BROWSER_EDIT_AND_PREVIEW_PLUS_EXPLICIT_AUTHENTICATED_SESSION_NEGATIVE_PROBE'});
   }
   // Restore a legitimate draft on the same project page, keeping the actual
   // blocked revisions and all their original receipts as immutable history.
   await ui.flush();await ui.login();const repair=await ui.validateEdit('yaml',legal,()=>ui.source.fill(legal));assert.equal(repair.result.ready,true);await ui.activate();const repaired=await stable('AFTER_LEGITIMATE_DRAFT_REPAIR');assert.equal(repaired.activeSource,legal);assert.equal(repaired.draftSource,legal);assert.equal(repaired.view.active.id,activated.view.active.id);proof.repair={actionIndex:repair.actionIndex,networkIndex:repair.networkIndex,requestId:repair.requestId,activeRevisionId:repaired.view.active.id};
   await ui.flush();assert(!ui.network.some(row=>['lifecycle.instance.create','lifecycle.stage.request','lifecycle.authority.record'].includes(row.request?.operation)));proof.trace=await ui.close();proofs.push(proof);
  }finally{await ui.close();}
 }
 const final={};for(const alias of aliases){final[alias]=await inventory(alias);assert.deepEqual(final[alias].instances,baselines[alias].instances);assert.deepEqual(await read(alias,'lifecycle.base.inspect'),base);}assert.deepEqual(captureBase(),originalBase);
 run.artifact('exact-single-base-project-results.json',{candidate:run.candidate,basePin:base.pin,proofs,final,counts:{projects:2,legalIndependentConfigurations:2,invalidInheritanceAttempts:8,repairedDrafts:2},actualBrowsers:true,publisherBaseBytesUnchanged:true,currentInstancePinsUnchanged:true,stageDispatches:0,formalCaseCredit:0});
 return{projects:proofs.map(p=>({projectId:p.projectId,originalActive:p.originalActive,newActive:p.positive.revisionId,originalInstanceIds:p.originalInstanceIds,negativeFamilies:p.negative.map(n=>n.name),trace:p.trace})),basePin:base.pin,independentLegalConfigurations:2,actualInheritanceRefusals:8,baseBytesUnchanged:true,otherProjectUnchangedDuringEachWrite:true,originalInstancePinsUnchanged:true,executionDispatched:false};
}

// Private proposal for insertion into the already-bound e04.test.mjs. No code
// here is active product/collector code until the parent reviews and lands it.
// The external producer may execute only Base stages; this collector owns the
// exact extension requests and denied successor probes below. It never grants
// authority, writes owner state, dispatches CI or fabricates an observation.

const slots=['after-plan','before-candidate','candidate-checks','before-release-decision'];
const boundaries={'after-plan':['plan','implementation'],'before-candidate':['implementation','candidate'],'candidate-checks':['candidate','verification'],'before-release-decision':['verification','release-decision']};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
function exact(value,fields){assert(object(value));assert.deepEqual(Object.keys(value).sort(),[...fields].sort());}
function readPinned(pin){
 exact(pin,['ref','sha256']);assert.equal(path.resolve(pin.ref),pin.ref);assert.equal(fs.realpathSync(pin.ref),pin.ref);const s=fs.lstatSync(pin.ref);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o077)===0&&s.size<=1048576);
 const bytes=fs.readFileSync(pin.ref);assert.equal(sha(bytes),pin.sha256);return JSON.parse(bytes);
}

export async function extensionExecution(run,c,browser,openBrowser){
 const pin=run.selection.extensionExecution;assert(pin,'Select exact native extension fixture; absent evidence is never a PASS');const fixture=readPinned(pin);
 exact(fixture,['schema','candidateDigest','workspaceId','projectId','syntheticAssets','syntheticDecisions','exchangeRoot','casePlans']);assert.equal(fixture.schema,'runtime-v090-extension-execution-fixture/v1');assert.equal(fixture.candidateDigest,run.candidateDigest);assert.equal(fixture.workspaceId,run.selection.workspaceId);assert.equal(fixture.projectId,run.selection.projectId);assert.equal(fixture.syntheticAssets,true);assert.equal(fixture.syntheticDecisions,true);
 assert.equal(fs.realpathSync(fixture.exchangeRoot),fixture.exchangeRoot);const ds=fs.lstatSync(fixture.exchangeRoot);assert(ds.isDirectory()&&ds.uid===process.getuid()&&(ds.mode&0o077)===0);
 const plan=fixture.casePlans[c.caseInstanceId];assert(plan,'Fixed case has no prepared native inputs');
 const load=relative=>import(pathToFileURL(path.join(run.selection.installedRoot,'package/dist',relative)).href),base=await load('lifecycle/base.js'),instances=await load('lifecycle/instance.js');
 const vd=base.valueDigest,created=[];let serial=0,ui;
 const marker=(name,content)=>{assert(/^[a-z0-9-]+$/.test(name));const ref=path.join(fixture.exchangeRoot,c.caseInstanceId+'-'+name+'.json');fs.writeFileSync(ref,JSON.stringify({schema:'runtime-extension-producer-checkpoint/v1',caseInstanceId:c.caseInstanceId,candidateDigest:run.candidateDigest,projectId:run.selection.projectId,at:new Date().toISOString(),...content},null,2)+'\n',{flag:'wx',mode:0o600});run.artifact('extension-producer-checkpoint.json',{ref,...content});return ref;};
 const inspect=async id=>{const r=await run.read('lifecycle.instance.inspect',{instanceId:id});instances.inspectInstance(r.instance);assert.equal(r.instance.id,id);assert.equal(r.instance.pins.projectId,run.selection.projectId);assert.equal(base.isCurrentBase(r.instance.pins.base),true);return r;};
 const deadline=i=>Math.min(Date.parse(i.createdAt)+i.pins.budget.timeoutSeconds*1000,Date.parse(i.pins.authorityExpiresAt));
 const beforeWrite=async id=>{const r=await inspect(id);assert(Date.now()<deadline(r.instance),'Original instance deadline elapsed; never extend or reset the grant');return r;};
 const original=async(i,stageId)=>{
  const stage=i.stages[stageId];assert(stage?.requestId);const r=await run.read('lifecycle.stage.request.inspect',{stageRequestId:stage.requestId}),{digest,...body}=r.request;
  assert.equal(digest,vd(body));assert.equal(r.request.planDigest,vd(r.request.plan));assert.equal(r.request.workspaceId,run.selection.workspaceId);assert.equal(r.request.projectId,run.selection.projectId);assert.equal(r.request.instanceId,i.id);assert.equal(r.request.pinsDigest,i.pinsDigest);assert.equal(r.request.stageId,stageId);assert.equal(r.request.inputDigest,stage.inputDigest);assert.equal(r.automaticRedispatch,false);
  if(r.progress.observationRef){const o=await run.read('lifecycle.stage.observation.read',{stageRequestId:r.request.id,observationRef:r.progress.observationRef});assert.equal(vd(o.evidence),r.progress.observationRef);assert.equal(o.evidence.requestId,r.request.id);assert.deepEqual(o.evidence.observation,r.progress.observation);assert.equal(vd(o.evidence.observation.outcome),stage.outcomeDigest);}
  return r;
 };
 const finished=async(id,stageId,wanted)=>{
  const {instance:i}=await inspect(id),r=await original(i,stageId);assert.equal(i.stages[stageId].status,wanted==='COMPLETE'?'PASSED':wanted);assert.equal(r.progress.phase,wanted);assert.equal(r.progress.observation.outcome.status,wanted);assert.equal(r.progress.terminal,wanted==='COMPLETE'||wanted==='FAILED');return{i,r};
 };
 const nativeCheck=async(id,stageId,wanted)=>{
  const {i,r}=await finished(id,stageId,wanted),node=i.definition.nodes.find(n=>n.id===stageId);assert.equal(node.source,'project');assert.equal(node.action.type,'check');assert.equal(r.request.plan.adapterId,'runtime-native-extension-stage-v1');
  const view=await run.read('lifecycle.extension.evidence.read',{stageRequestId:r.request.id});assert.deepEqual(view.request,r.request);assert.equal(view.historical,true);assert.equal(view.executionAuthorized,false);assert.equal(view.releaseAuthorized,false);assert.equal(view.automaticRedispatch,false);assert(view.action,'A stage UNKNOWN before owner invocation is not this fixture');assert.equal(view.action.request.operation,'native.package.validate');assert.equal(view.action.request.requestId,'extension-native-'+vd({requestDigest:r.request.digest}).slice(7,51));
  const {digest,...action}=view.action;assert.equal(digest,vd(action));assert(view.evidence&&view.receipt,'Original native owner receipt/observation is required');assert.equal(vd(view.evidence),view.evidenceRef);assert.equal(view.evidence.receiptRef,vd(view.receipt));assert.equal(view.evidence.requestDigest,r.request.digest);assert.equal(view.evidence.planDigest,r.request.planDigest);assert.equal(view.evidence.actionDigest,view.action.digest);assert.equal(view.receipt.requestId,view.action.request.requestId);assert.deepEqual(view.receipt.scope,view.action.request.scope);
  const desired=wanted==='COMPLETE'?'PASS':wanted==='FAILED'?'FAIL':'UNKNOWN';assert.equal(view.evidence.result.status,desired);
  if(wanted==='UNKNOWN'){assert.equal(view.receipt.status,'RUNNING');assert.equal(view.evidence.receiptTerminal,false);assert.equal(view.evidence.result.receiptDigest,null);}
  else{assert.equal(view.receipt.status,'SUCCEEDED');if(wanted==='FAILED'){assert.equal(r.request.plan.parameters.kind,'harness');assert.equal(view.receipt.result.qualityStatus,'FAIL');assert(view.receipt.result.criteria.some(v=>v.criterionId==='H001'&&v.variantId==='actual-observation'&&v.status==='FAIL'));assert(view.action.request.input.observation.values.runtimeExtension.preparation.target.scope.includes('EX04_EXPECT_EXTENSION_DENIAL'));}assert.equal(view.evidence.receiptTerminal,true);assert.equal(view.evidence.result.receiptDigest,vd(view.receipt));assert.equal(r.progress.observation.outcome.checks.length,node.checks.length);assert(r.progress.observation.outcome.checks.every(x=>x.status===(wanted==='COMPLETE'?'PASS':'FAIL')));}
  for(const previous of r.request.plan.parameters.predecessors){const s=i.stages[previous.stageId],p=await original(i,previous.stageId);assert.equal(s.status,'PASSED');assert.equal(p.progress.phase,'COMPLETE');assert.equal(previous.requestDigest,p.request.digest);assert.equal(previous.outcomeDigest,s.outcomeDigest);}
  if(['candidate-checks','before-release-decision'].includes(node.stage)){assert(i.candidate&&i.candidateDigest);assert.equal(r.request.plan.parameters.candidateDigest,i.candidateDigest);assert.equal(instances.candidateDigest(r.request.plan.parameters.candidateInput.manifest),i.candidateDigest);}
  run.artifact('extension-native-action-observation.json',{instance:i,request:r,view});return{i,r,view};
 };
 const graph=async id=>{
  const {instance:i}=await inspect(id),extensions=i.definition.nodes.filter(n=>n.source==='project');assert.equal(extensions.length,8);assert.equal(i.pins.budget.maxConcurrency,2);
  for(const slot of slots){const pair=extensions.filter(n=>n.stage===slot);assert.equal(pair.length,2);assert.deepEqual(pair.map(n=>n.action.actionRef).sort(),['runtime.check.harness','runtime.check.ontology']);for(const n of pair){assert.deepEqual(n.dependsOn,[boundaries[slot][0]]);assert.equal(n.action.budget.maxAttempts,1);assert.equal(n.action.budget.maxConcurrency,2);}const successor=i.definition.nodes.find(n=>n.id===boundaries[slot][1]);for(const n of pair)assert(successor.dependsOn.includes(n.id));assert(successor.dependsOn.includes(boundaries[slot][0]));}
  return i;
 };
 const deny=async(id,stageId,required)=>{
  const before=await beforeWrite(id),admission=await run.read('lifecycle.stage.admission',{instanceId:id,stageId});assert.equal(admission.allowed,false);assertExtensionDenialReasons(admission.reasons,required,{caseInstanceId:c.caseInstanceId,stageId});
  const status=await run.read('runtime.status');await beforeWrite(id);const result=await run.request('lifecycle.stage.request',{instanceId:id,stageId},{requestId:run.requestId(c.caseInstanceId,'extension-blocked-'+(++serial)),expectedRevision:status.revision});assert.equal(result.status,409);assert.equal(result.body.error.code,'STAGE_BLOCKED');assert.deepEqual(result.body.error.message.split('; ').sort(),[...admission.reasons].sort(),'Native STAGE_BLOCKED must report the complete original admission reasons');
  const after=await inspect(id);assert.deepEqual(after.instance,before.instance);assert.equal(after.projectRevision??after.revision,before.projectRevision??before.revision);run.artifact('extension-native-blocked-request.json',{instanceId:id,stageId,before,admission,response:result,after,executionDispatched:false});return admission;
 };
 const request=async(id,stageId)=>{
  const current=await beforeWrite(id);assert.equal(current.instance.stages[stageId].status,'PENDING');assert.equal(current.instance.stages[stageId].attempts,0);const admission=await run.read('lifecycle.stage.admission',{instanceId:id,stageId});assert.equal(admission.allowed,true,JSON.stringify(admission.reasons));
  const status=await run.read('runtime.status');await beforeWrite(id);const r=await run.request('lifecycle.stage.request',{instanceId:id,stageId},{requestId:run.requestId(c.caseInstanceId,'extension-run-'+(++serial)),expectedRevision:status.revision});assert.equal(r.status,200,JSON.stringify(r.body));const requestId=r.body.result.result.stageRequestId;created.push(requestId);return requestId;
 };
 const wait=async(id,stageId,wanted,ms=90000)=>{
  const i=(await inspect(id)).instance,end=Math.min(Date.now()+ms,deadline(i));
  while(Date.now()<end){const state=(await inspect(id)).instance,stage=state.stages[stageId];assert(Date.now()<end);if(stage.status===wanted)return state;if(['PASSED','FAILED'].includes(stage.status))assert.equal(stage.status,wanted,'Unexpected terminal original outcome');await pause(300);}throw Error('EXACT_EXTENSION_CHECKPOINT_TIMEOUT: '+stageId+' '+wanted);
 };
 const monitor=async(id,label)=>{if(!ui)ui=await openBrowser(run,browser,{route:'/monitor',monitorEvidence:true});await ui.page.getByLabel('生命周期实例',{exact:true}).selectOption(id);const current=(await inspect(id)).instance,expected=current.definition.nodes.filter(n=>n.source==='project').map(n=>({id:n.id,status:current.stages[n.id].status,requestId:current.stages[n.id].requestId}));await ui.page.waitForFunction(({id,projectId,expected})=>document.querySelector('#instance')?.value===id&&document.querySelector('.monitor-strip')?.getAttribute('data-project-id')===projectId&&expected.every(e=>{const row=[...document.querySelectorAll('tbody tr')].find(r=>r.querySelector('button')?.textContent===e.id);return row?.querySelector('.status')?.classList.contains(e.status)&&row.querySelector('code')?.textContent===(e.requestId??'尚无请求');}),{id,projectId:run.selection.projectId,expected});await ui.screenshot();await ui.flush();const trace=await ui.close();ui=null;run.artifact('extension-browser-checkpoint.json',{label,instanceId:id,monitorOnly:true,originalRequestIds:current.requestIds,renderedExtensions:expected,trace});};
 const pair=async(id,slot)=>{const i=await graph(id);return i.definition.nodes.filter(n=>n.source==='project'&&n.stage===slot).sort((a,b)=>b.action.actionRef.localeCompare(a.action.actionRef));};
 try{
  if(['E04.EX04','E06.EX04'].includes(c.caseInstanceId)){
   exact(plan,['failed','unknown','passing']);for(const p of [plan.failed,plan.passing])exact(p,['instanceId']);exact(plan.unknown,['instanceId','faultPlan']);assert.equal(new Set(Object.values(plan).map(p=>p.instanceId)).size,3);
   // Negative instances retain their original failed/unknown actions forever.
   for(const [mode,p]of [['FAILED',plan.failed],['UNKNOWN',plan.unknown]]){
    const nodes=await pair(p.instanceId,'after-plan'),harness=nodes.find(n=>n.action.actionRef==='runtime.check.harness'),ontology=nodes.find(n=>n.action.actionRef==='runtime.check.ontology');await finished(p.instanceId,'plan','COMPLETE');
    const initial=await inspect(p.instanceId);for(const n of nodes)assert.equal(initial.instance.stages[n.id].status,'PENDING');
    await deny(p.instanceId,'implementation',nodes.map(n=>'PREDECESSOR_NOT_PASSED:'+n.id));
    await request(p.instanceId,ontology.id);await wait(p.instanceId,ontology.id,'PASSED');await nativeCheck(p.instanceId,ontology.id,'COMPLETE');
    const notRun=(await inspect(p.instanceId)).instance.stages[harness.id];assert.deepEqual({status:notRun.status,attempts:notRun.attempts,requestId:notRun.requestId},{status:'PENDING',attempts:0,requestId:null});await deny(p.instanceId,'implementation',['PREDECESSOR_NOT_PASSED:'+harness.id]);
    if(mode==='UNKNOWN'){
     const fault=readPinned(p.faultPlan);exact(fault,['schema','installedRoot','serviceSelection','candidateDigest','workspaceId','projectId','instanceId','stageId','faultRoot','driver','maxWallSeconds']);assert.equal(fault.schema,'runtime-e04-owned-native-claim-fault-plan/v1');assert.equal(fault.installedRoot,run.selection.installedRoot);assert.equal(fault.candidateDigest,run.candidateDigest);assert.equal(fault.workspaceId,run.selection.workspaceId);assert.equal(fault.projectId,run.selection.projectId);assert.equal(fault.instanceId,p.instanceId);assert.equal(fault.stageId,harness.id);assert.equal(fault.maxWallSeconds,60);assert(fault.faultRoot.startsWith(fixture.exchangeRoot+'/'));assert(!fs.existsSync(fault.faultRoot));
     const protectedJson=ref=>{assert.equal(fs.realpathSync(ref),ref);const st=fs.lstatSync(ref);assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.uid===process.getuid()&&(st.mode&0o077)===0&&st.size<=1048576);const bytes=fs.readFileSync(ref);return{value:JSON.parse(bytes),pin:{ref,sha256:sha(bytes)}};};
     const waitFile=async name=>{const ref=path.join(fault.faultRoot,name),end=Math.min(Date.now()+65000,deadline(initial.instance));while(!fs.existsSync(ref)){assert(Date.now()<end,'Exact fault operator did not finish within the existing instance budget');await pause(200);}assert(Date.now()<end);return protectedJson(ref);};
     marker('arm-owner-interruption',{instanceId:p.instanceId,stageId:harness.id,faultPlan:p.faultPlan,originalInstanceDeadlineAt:new Date(deadline(initial.instance)).toISOString(),requiredBoundary:'Harness native_receipts INSERT then same-owner SQLite COMMIT return 0; exact owned Runtime SIGKILL only',prohibitReceiptInjection:true});
     const armed=await waitFile('ARMED.json'),input=protectedJson(path.join(fault.faultRoot,'INPUT.json')),identity=protectedJson(path.join(fault.faultRoot,'IDENTITY.json'));assert.equal(armed.value.inputSha256,input.pin.sha256);assert.equal(input.value.identitySha256,identity.pin.sha256);assert.equal(armed.value.pid,identity.value.pid);assert.equal(identity.value.candidateDigest,run.candidateDigest);assert.equal(identity.value.serviceId,run.candidate.serviceId);assert.equal(identity.value.instanceId,p.instanceId);assert.equal(identity.value.stageId,harness.id);assert.equal(identity.value.onlyOriginalExtensionInFlight,false);const quiet=readPinned(identity.value.quietInventory);assert.equal(quiet.pending.length,0);assert.equal(quiet.status.observationWorker.inFlight,0);assert.equal(identity.value.ownedSyntheticService,true);
     const originalRequestId=await request(p.instanceId,harness.id),restored=await waitFile('RESTORED.json');for(const k of ['candidateDigest','serviceId','instanceId','stageId'])assert.equal(restored.value[k],identity.value[k]);const debug=readPinned(restored.value.debugger);assert.equal(debug.status,'FAULT_INJECTED_NOT_ACCEPTANCE');assert.equal(debug.killed,true);assert.equal(debug.pid,identity.value.pid);const witness=readPinned(debug.exclusiveWitness);assert.equal(witness.serviceId,run.candidate.serviceId);assert.equal(witness.pid,identity.value.pid);assert.equal(witness.processIdentity,identity.value.processIdentity);assert.equal(witness.status.observationWorker.inFlight,1);assert.equal(witness.pending.length,1);assert.equal(witness.pending[0].instanceId,p.instanceId);assert.equal(witness.pending[0].stageId,harness.id);assert.equal(witness.original.request.id,originalRequestId);assert.equal(witness.original.automaticRedispatch,false);const ev=debug.events;assert.deepEqual(ev.map(e=>e.kind),['PROCESS_IDENTITY_VERIFIED','ATTACHED_AND_ARMED','NATIVE_CLAIM_INSERT_PREPARE','NATIVE_CLAIM_COMMIT_ENTRY','NATIVE_CLAIM_COMMIT_RETURN','PROCESS_IDENTITY_VERIFIED','OWNED_SIGKILL']);assert.equal(ev[2].sqliteHandle,ev[3].sqliteHandle);assert.equal(ev[3].sqliteHandle,ev[4].sqliteHandle);assert.equal(ev[4].returnCode,0);assert.equal(ev[0].processIdentity,ev[5].processIdentity);assert.equal(ev[0].processIdentity,identity.value.processIdentity);const stop=readPinned(restored.value.stop),start=readPinned(restored.value.start);assert.equal(stop.operation,'stop');assert.equal(start.operation,'start');assert.equal(stop.service.running,false);assert.equal(start.service.running,true);assert.equal(start.service.identity.serviceId,run.candidate.serviceId);
     const end=Math.min(Date.now()+30000,deadline(initial.instance));let evidence;
     do{assert(Date.now()<end);evidence=await run.read('lifecycle.extension.evidence.read',{stageRequestId:originalRequestId});if(evidence.evidence?.result?.status==='UNKNOWN'&&evidence.receipt?.status==='RUNNING')break;await pause(300);}while(Date.now()<end);
     assert.equal(evidence?.receipt?.status,'RUNNING');await wait(p.instanceId,harness.id,'UNKNOWN',5000);const unknown=await nativeCheck(p.instanceId,harness.id,'UNKNOWN');assert.equal(unknown.r.request.id,originalRequestId);await deny(p.instanceId,'implementation',['PREDECESSOR_NOT_PASSED:'+harness.id]);await monitor(p.instanceId,'UNKNOWN-ORIGINAL-OWNER-RUNNING');
     const status=await run.read('runtime.status');await beforeWrite(p.instanceId);const reconciled=await run.request('lifecycle.stage.reconcile',{stageRequestId:originalRequestId},{requestId:run.requestId(c.caseInstanceId,'original-owner-inspection'),expectedRevision:status.revision});assert.equal(reconciled.status,200);assert.equal(reconciled.body.result.result.automaticRedispatch,false);await pause(2200);const after=await nativeCheck(p.instanceId,harness.id,'UNKNOWN');assert.deepEqual(after.view.action,unknown.view.action);assert.deepEqual(after.view.receipt,unknown.view.receipt);assert.equal(after.i.stages[harness.id].attempts,1);assert.equal(after.r.request.id,originalRequestId);assert.deepEqual(readPinned(p.faultPlan),fault);run.artifact('extension-original-owner-fault-and-inspection.json',{armed,identity,input,restored,debug,stop,start,originalRequestId,reconciled,ownerClaimStillUnknown:true,ownerRedispatched:false,allPassingRunMustBeIndependent:true});continue;
    }
    await request(p.instanceId,harness.id);await wait(p.instanceId,harness.id,mode);await nativeCheck(p.instanceId,harness.id,mode);await deny(p.instanceId,'implementation',['PREDECESSOR_NOT_PASSED:'+harness.id]);await monitor(p.instanceId,mode);
   }
   marker('prepare-positive-instance',{instanceId:plan.passing.instanceId,permitted:'Fresh exact native preparation/execution decision and instance; scope may pass, plan and all extensions must remain PENDING',originalFailuresPreserved:true});
   const readyEnd=Date.now()+60000;while(true){const response=await run.request('lifecycle.instance.inspect',{instanceId:plan.passing.instanceId});if(response.status===200)break;assert.equal(response.status,404);assert(Date.now()<readyEnd);await pause(300);}
   const id=plan.passing.instanceId,original=await graph(id);assert.equal(original.stages.plan.status,'PENDING');
   for(const slot of slots)for(const node of await pair(id,slot))await deny(id,node.id,['PREDECESSOR_NOT_PASSED:'+boundaries[slot][0]]);
   marker('predecessor-denials-complete',{instanceId:id,allowedBaseSuccessor:'plan',allEightActualExtensionRequestsRefused:true});
   for(const slot of slots){
    const [predecessor,successor]=boundaries[slot],nodes=await pair(id,slot);marker('await-'+slot,{instanceId:id,onlyBaseProducerMayComplete:predecessor,extensionNodes:nodes.map(n=>n.id),successorMayNotRun:true});await wait(id,predecessor,'PASSED',240000);await finished(id,predecessor,'COMPLETE');
    await deny(id,successor,nodes.map(n=>'PREDECESSOR_NOT_PASSED:'+n.id));
    for(const n of nodes){const allowed=await run.read('lifecycle.stage.admission',{instanceId:id,stageId:n.id});assert.equal(allowed.allowed,true);}
    // Serialize HTTP CAS admissions while both owner actions remain genuine;
    // graph independence is checked above and both requests must overlap.
    const first=await request(id,nodes[0].id),second=await request(id,nodes[1].id);
    for(const n of nodes){await wait(id,n.id,'PASSED');await nativeCheck(id,n.id,'COMPLETE');}
    const i=(await inspect(id)).instance,a=await originalRequest(i,first),b=await originalRequest(i,second);
    assert(Date.parse(a.request.requestedAt)<=Date.parse(b.request.requestedAt));assert(Date.parse(b.request.requestedAt)<Date.parse(a.progress.observedAt),'Two checks must actually overlap; a sequential run cannot be labelled parallel');
    const admitted=await run.read('lifecycle.stage.admission',{instanceId:id,stageId:successor});assert.equal(admitted.allowed,true,JSON.stringify(admitted.reasons));await monitor(id,slot+'-ALL-PASS');marker('passed-'+slot,{instanceId:id,allowedBaseSuccessor:successor,extensionRequestIds:[first,second],candidateDigest:i.candidateDigest});
   }
   const final=(await inspect(id)).instance;assert.equal(final.pinsDigest,original.pinsDigest);assert(final.candidateDigest);return{fourRealSlots:true,parallelChecksPerSlot:2,negativeStates:['PENDING','FAILED','UNKNOWN'],originalFailuresPreserved:true,allPassedInstanceId:id,releaseAuthorized:false};
  }
  assert.equal(c.caseInstanceId,'E04.EX07');exact(plan,['baseFailedExtensionPassed','basePassedExtensionFailed','allPassedNoReleaseAuthority']);for(const p of Object.values(plan))exact(p,['instanceId']);
  const a=plan.baseFailedExtensionPassed.instanceId;await graph(a);await finished(a,'implementation','FAILED');for(const n of await pair(a,'after-plan'))await nativeCheck(a,n.id,'COMPLETE');await deny(a,'candidate',['PREDECESSOR_NOT_PASSED:implementation']);await monitor(a,'BASE-FAILED-EXTENSIONS-PASSED');
  const b=plan.basePassedExtensionFailed.instanceId;await graph(b);await finished(b,'plan','COMPLETE');const nodes=await pair(b,'after-plan'),failed=nodes.find(n=>n.action.actionRef==='runtime.check.harness');await nativeCheck(b,failed.id,'FAILED');await nativeCheck(b,nodes.find(n=>n.id!==failed.id).id,'COMPLETE');await deny(b,'implementation',['PREDECESSOR_NOT_PASSED:'+failed.id]);await monitor(b,'BASE-PASSED-EXTENSION-FAILED');
  const d=plan.allPassedNoReleaseAuthority.instanceId,i=await graph(d);for(const name of ['scope','plan','implementation','candidate','verification'])await finished(d,name,'COMPLETE');for(const node of i.definition.nodes.filter(n=>n.source==='project'))await nativeCheck(d,node.id,'COMPLETE');
  const before=(await inspect(d)).instance;assert.equal(before.stages['release-decision'].status,'RUNNING');const pending=await original(before,'release-decision');assert.equal(pending.progress.phase,'RUNNING');assert.equal(pending.progress.terminal,false);assert.equal(before.stages.publication.status,'PENDING');assert.equal(before.stages.publication.attempts,0);assert.equal(before.stages.publication.requestId,null);await deny(d,'publication',['EXACT_RELEASE_AUTHORITY_REQUIRED']);const release=await run.read('lifecycle.release.evidence.read',{stageRequestId:before.stages['release-decision'].requestId});assert.equal(release.releaseAuthorized,false);assert.equal(release.material.releaseAuthorized,false);assert.equal(release.material.candidateDigest,before.candidateDigest);assert.equal(release.material.pinsDigest,before.pinsDigest);const {digest:materialDigest,...materialBody}=release.material;assert.equal(materialDigest,vd(materialBody));await monitor(d,'ALL-TECHNICAL-PASS-NO-RELEASE-AUTHORITY');
  return{baseAndExtensionAreConjunctive:true,independentNativeFailures:[a,b],allTechnicalPassWithoutReleaseAuthority:d,publicationDispatched:false,newReleaseDecisions:0};
 }finally{await ui?.close();assert.deepEqual(readPinned(pin),fixture);run.artifact('extension-case-execution-limits.json',{caseInstanceId:c.caseInstanceId,createdExtensionRequests:created,newBaseStages:0,newAuthorities:0,newReleaseDecisions:0,newOwnerDecisions:0,qualification:'DEVELOPMENT',formalCaseCredit:0});}
 async function originalRequest(i,requestId){const name=Object.keys(i.stages).find(name=>i.stages[name].requestId===requestId);assert(name);return original(i,name);}
}


export async function executeE04() {
 let run,browser,base,initial,activeSource,activeData,positiveSource;
 // Register only implemented callbacks before installation reads or browser
 // startup. Prepared native evidence remains mandatory for owner obligations.
 const collectors={
  'E04.journey':c=>entryCase(run,c,base,positiveSource,'http-api'),
  'E04.variant.01':c=>browserEntry(run,c,base,positiveSource,browser,true),
  'E04.variant.02':c=>browserEntry(run,c,base,positiveSource,browser,false),
  'E04.variant.03':c=>entryCase(run,c,base,positiveSource,'http-api'),
  'E04.variant.04':c=>entryCase(run,c,base,positiveSource,'cli'),
  'E04.variant.05':c=>entryCase(run,c,base,positiveSource,'http-mcp'),
  'E04.EX01':c=>exactSingleBaseProjects(run,c,browser,base),
  'E04.EX02':c=>schemaCase(run,c,base),
  'E04.EX03':c=>budgetBoundaries(run,c,base,activeSource),
  'E04.EX04':c=>extensionExecution(run,c,browser,openBrowser),
  'E04.EX05':c=>graphAttacks(run,c,base,activeData),
  'E04.EX06':c=>actionAttacks(run,c,base,activeData),
  'E04.EX07':c=>extensionExecution(run,c,browser,openBrowser),
  'E04.EX11':c=>ownerObligations(run,c,browser),
  'E04.EX12':c=>extensionBrowserEntries(run,c,browser)
 };
 run=await openScenario('E04',{phase:'PRE_RELEASE',register:catalog=>new Map(catalog.filter(c=>Object.hasOwn(collectors,c.caseInstanceId)).map(c=>[c.caseInstanceId,()=>collectors[c.caseInstanceId](c)]))});
 run.artifact('collector-callable-preflight.json',run.callablePreflight);
 try{
  base=await run.read('lifecycle.base.inspect');assert.equal(base.projectMutationAllowed,false);
  initial=await run.read('lifecycle.definition.inspect');assert(initial.active,'Use a real natively activated isolated baseline, never seeded database state');
  activeSource=await run.source(initial.active.id);activeData=parse(activeSource);positiveSource=controlSource(run,activeSource);
  assert.equal(activeData.projectId,run.selection.projectId);assert.deepEqual(activeData.extends,base.pin);
  if(run.cases.some(c=>['E04.variant.01','E04.variant.02','E04.EX01','E04.EX11','E04.EX12','E04.EX04','E04.EX07'].includes(c.caseInstanceId)))browser=await chromium.launch({headless:true});
  for(const c of run.cases)await run.collectRegistered(c);
 }finally{await browser?.close();run.finish();}
}
if(process.argv[1]&&collectorPathToFileURL(collectorResolve(process.argv[1])).href===import.meta.url)test('E04 exact installed Base inheritance and constrained extension cases',executeE04);
