import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {stringify,parse,parseDocument} from 'yaml';
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
  if(!expected){assert.equal(result.ready,false);assert.equal(result.validationDigest,null);assert(result.compilation.issues.some(i=>i.code==='INVALID_VALUE'&&i.path===field.path&&i.rule==='field.'+field.policy.toLowerCase()&&i.remedy),'The refusal must identify the tested field/rule, not unrelated missing bindings');}
  observations.push({fieldId:field.id,path:field.path,ruleClass,case:name,declaredRules:field.rules,requestedProvider:provider,actualProvider,value,expectedCompilation:expected,observedCompilation:result.compilation.valid,requestId:response.requestId,sourceSha256:sha(source),bindingReadiness:result.ready,bindingReadinessNotUsedAsParameterVerdict:true});
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
 const nextSource=yaml(enlarged);assert.notEqual(nextSource,activeSource);const preview=(await run.configurationEntry('http-api','lifecycle.definition.validate',{yaml:nextSource})).result;assert.equal(preview.ready,true,'Use genuine current registered bindings for the actual definition transition');
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
const unavailable={
 'E04.EX01':'Two distinct authenticated project bindings and legitimate configurations, plus exact single-Base inheritance attack receipts, are required; one-project validation cannot replace project isolation.',
 'E04.EX04':'Actual registered four-slot execution and two parallel checks with FAILED, UNKNOWN, NOT_RUN then PASS observations are required; an effective graph is insufficient.',
 'E04.EX07':'Actual Base-failed/extension-passed, Base-passed/extension-failed, and all-passed-without-release-authority admissions are required.',
 'E04.EX11':'Actual pinned owner report plus failed current Target, rejected latest/forged PASS, and removing the draft check while preserving current obligations are required.',
};
test('E04 exact installed Base inheritance and constrained extension cases',async()=>{
 const run=await openScenario('E04');let browser;
 try{
  const base=await run.read('lifecycle.base.inspect');assert.equal(base.projectMutationAllowed,false);
  const initial=await run.read('lifecycle.definition.inspect');assert(initial.active,'Use a real natively activated isolated baseline, never seeded database state');
  const activeSource=await run.source(initial.active.id),activeData=parse(activeSource),positiveSource=controlSource(run,activeSource);
  assert.equal(activeData.projectId,run.selection.projectId);assert.deepEqual(activeData.extends,base.pin);
  if(run.cases.some(c=>['E04.variant.01','E04.variant.02','E04.EX12'].includes(c.caseInstanceId)))browser=await chromium.launch({headless:true});
  for(const c of run.cases)await run.collect(c,async()=>{
   if(unavailable[c.caseInstanceId]){run.artifact('required-uncollected-contract.json',{contract:c.parameters.variantContract,reason:unavailable[c.caseInstanceId],sourceTestsNotSubstituted:true});throw Error('UNIMPLEMENTED_REQUIRED_VARIANT: '+unavailable[c.caseInstanceId]);}
   if(c.caseInstanceId==='E04.EX12')return extensionBrowserEntries(run,c,browser);
   if(c.caseInstanceId==='E04.EX03')return budgetBoundaries(run,c,base,activeSource);
   if(['E04.journey','E04.variant.03','E04.variant.04','E04.variant.05'].includes(c.caseInstanceId))return entryCase(run,c,base,positiveSource,c.caseInstanceId==='E04.variant.04'?'cli':c.caseInstanceId==='E04.variant.05'?'http-mcp':'http-api');
   if(['E04.variant.01','E04.variant.02'].includes(c.caseInstanceId))return browserEntry(run,c,base,positiveSource,browser,c.caseInstanceId==='E04.variant.01');
   if(c.caseInstanceId==='E04.EX02')return schemaCase(run,c,base);
   if(c.caseInstanceId==='E04.EX05')return graphAttacks(run,c,base,activeData);
   if(c.caseInstanceId==='E04.EX06')return actionAttacks(run,c,base,activeData);
   throw Error('UNIMPLEMENTED_REQUIRED_VARIANT: '+c.caseInstanceId);
  });
 }finally{await browser?.close();run.finish();}
});
