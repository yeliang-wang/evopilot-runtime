import {registerFixedScenario} from './preflight.mjs';
import {pathToFileURL as collectorPathToFileURL} from 'node:url';
import {resolve as collectorResolve} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parse,parseDocument,stringify} from 'yaml';
import {chromium,expect} from '@playwright/test';
import {openScenario,sha} from './support.mjs';
import {openBrowser} from './browser.mjs';

import * as permissionCollectors from './e12.test.mjs';
import {extensionExecution} from './e04.test.mjs';
import {activationAtomicity} from './e13.test.mjs';
import {interruptionFixture,openExecution} from './execution.mjs';

const changed=(source,path,value)=>{const doc=parseDocument(source);doc.setIn(path,value);return doc.toString({lineWidth:0});};
const semantic=source=>{const v=parse(source);delete v.presentation;return v;};
const variant=c=>c.parameters.variantId??c.caseInstanceId;
function extension(base,projectId,id,slot='after-plan',dependsOn=[]){
 const action=base.actions.find(a=>a.type==='check'&&base.slots[slot]?.types.includes(a.type));assert(action);
 return{id:'project.'+id,slot,type:action.type,actionRef:action.id,actionVersion:action.version,actionDigest:action.digest,parameters:Object.fromEntries(Object.keys(action.parameterSchema).map(k=>[k,'binding:browser-negative/'+k.toLowerCase()])),requirementRefs:['binding:browser-negative/'+id],evidenceMappingRef:'binding:browser-negative/mapping',scopeRef:'scope:'+projectId,budget:{timeoutSeconds:1,maxAttempts:1,maxConcurrency:1,maxLoops:1},dependsOn};
}
async function setup(run,c){
 const view=await run.read('lifecycle.definition.inspect');assert(view.active,'E06 requires an existing actual active project definition');
 const source=await run.source(view.active.id),preview=await run.read('lifecycle.definition.validate',{yaml:source});assert.equal(preview.ready,true,'The selected active definition must have current real bindings');
 const saved=await run.configurationEntry('http-api','lifecycle.draft.save',{yaml:source},{requestId:run.requestId(c.caseInstanceId,'restore-active-draft'),expectedRevision:view.revision});assert.equal(saved.result.result.status,'DRAFT');
 return{view,source,base:await run.read('lifecycle.base.inspect')};
}
async function noExecution(ui,before){
 assert.deepEqual((await ui.monitor()).instances,before.instances);
 await ui.flush();assert(!ui.network.some(n=>['lifecycle.instance.create','lifecycle.stage.request','lifecycle.authority.decision'].includes(n.request.operation)));
}
async function roundtrip(run,ui,initial,c){
 const before=await ui.monitor(),comment='# Installed browser '+c.caseInstanceId+' '+run.selection.runId;
 await ui.source.fill(initial.source+'\n'+comment+'\n');await ui.valid();await expect(ui.page.locator('svg .n-box').first()).toBeVisible();
 const previous=parse(await ui.source.inputValue()).presentation?.layout?.scope??{x:0,y:0};await ui.node('scope').focus();await ui.page.keyboard.press('ArrowDown');
 await expect.poll(async()=>parse(await ui.source.inputValue()).presentation?.layout?.scope?.y).toBe(previous.y+90);
 const box=await ui.node('scope').boundingBox();assert(box);await ui.page.mouse.move(box.x+box.width/2,box.y+box.height/2);await ui.page.mouse.down();await ui.page.mouse.move(box.x+box.width/2+55,box.y+box.height/2);await ui.page.mouse.up();
 await expect.poll(async()=>parse(await ui.source.inputValue()).presentation?.layout?.scope?.x).toBe(previous.x+200);
 const source=await ui.source.inputValue();assert(source.includes(comment));assert.deepEqual(semantic(source),semantic(initial.source));
 await ui.save();assert.equal(await run.source((await run.read('lifecycle.definition.inspect')).draft.id),source);await ui.preview();await ui.activate();
 const after=await run.read('lifecycle.definition.inspect');assert.notEqual(after.active.id,initial.view.active.id);assert.equal(after.active.semanticDigest,initial.view.active.semanticDigest);assert.equal(await run.source(after.active.id),source);
 const activation=ui.network.filter(n=>n.request.operation==='lifecycle.definition.save-and-activate');assert.equal(activation.length,1);const receipt=JSON.parse(activation[0].rawBody).result;assert.equal(receipt.result.status,'ACTIVE');assert.equal(receipt.result.executionAuthorized,false);assert.equal(receipt.result.releaseAuthorized,false);
 await ui.restart();await expect(ui.source).toHaveValue(source);assert.equal((await run.read('lifecycle.definition.inspect')).active.id,after.active.id);await noExecution(ui,before);await ui.screenshot();
 await ui.login('/monitor');await expect(ui.source).toHaveCount(0);await expect(ui.page.getByRole('button',{name:'保存并启用'})).toHaveCount(0);await expect(ui.page.getByRole('button',{name:'保存草稿'})).toHaveCount(0);
 return{actualSeeCode:true,graphAndYamlRoundtrip:true,commentsAndSupportedFieldsPreserved:true,samePageActivation:true,presentationOnlySemanticDigestUnchanged:true,exactInstalledRestartReadback:true,monitorReadOnly:true,actualModelTurn:false,executionDispatched:false,releaseAuthorized:false};
}
async function negative(run,ui,initial,inputs){
 const findings=[];
 for(const [name,source] of inputs){
  await ui.step('Edit and reject '+name,async()=>{
   await expect(ui.source).toBeEditable();await ui.source.fill(source);await ui.save();await ui.preview();await expect(ui.page.getByRole('button',{name:'保存并启用',exact:true})).toBeDisabled();
   const report=await run.read('lifecycle.definition.validate',{yaml:source});assert.equal(report.ready,false);assert.equal(report.compilation.valid,false);assert(report.issues.length);for(const issue of report.issues){assert(issue.path);assert(issue.rule);assert(issue.remedy);}
   const retained=await run.read('lifecycle.definition.inspect');assert.equal(retained.active.id,initial.view.active.id);assert.equal(await run.source(retained.draft.id),source);await expect(ui.source).toHaveValue(source);
   findings.push({name,issues:report.issues,retainedDraft:retained.draft.id});
  });
 }
 await ui.flush();assert(!ui.network.some(n=>n.request.operation==='lifecycle.definition.save-and-activate'));
 return{actualInstalledBrowser:true,originalInputsRetained:true,serverAndUiRejection:true,activeUnchanged:true,findings};
}
async function locked(run,ui,initial){
 const fields=initial.base.fields.filter(f=>f.policy==='LOCKED'&&f.providers.includes(parse(initial.source).config.implementation.provider));assert(fields.length);
 for(const field of fields){await ui.node(field.stage).click();await expect(ui.page.locator('#field-'+field.id)).toBeDisabled();}
 const field=fields[0],value=field.rules.fixed,replacement=typeof value==='boolean'?!value:typeof value==='number'?value+1:Array.isArray(value)?[]:'attempted-override';
 const result=await negative(run,ui,initial,[['publisher-locked-field',changed(initial.source,field.path.split('.'),replacement)]]);
 return{...result,lockedFieldControls:fields.map(f=>f.path),publisherBase:initial.base.pin};
}
async function injections(run,ui,initial){
 const payload='<img src=x onerror="window.e06Injected=true"><script>window.e06Injected=true</script>',source=changed(changed(initial.source,['presentation','notes'],payload),['presentation','label'],'<svg onload="window.e06Injected=true">');
 await ui.source.fill(source);await ui.save();await ui.preview();assert.equal(await ui.page.evaluate(()=>globalThis.e06Injected??null),null);
 await expect(ui.page.locator('img[src="x"]')).toHaveCount(0);await expect(ui.page.locator('svg script,svg foreignObject,svg [onload],svg [onerror]')).toHaveCount(0);await expect(ui.source).toHaveValue(source);
 assert.equal(await run.source((await run.read('lifecycle.definition.inspect')).draft.id),source);
 const invalid=changed(initial.source,['extensions'],[{...extension(initial.base,run.selection.projectId,'safe'),id:'project.<script>window.e06Injected=true</script>'}]);await negative(run,ui,initial,[['HTML-in-node-id',invalid]]);
 assert.equal(await ui.page.evaluate(()=>globalThis.e06Injected??null),null);return{actualBrowser:true,scriptNotExecuted:true,noInjectedDomOrRequests:true,rawSourceRetained:true};
}
async function keyboard(ui){
 await ui.page.setViewportSize({width:390,height:844});await ui.valid();assert.equal(await ui.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await ui.node('scope').focus();await expect(ui.node('scope')).toBeFocused();await ui.page.keyboard.press('Enter');await expect(ui.page.locator('.properties h2')).toHaveText('范围定义');
 const before=parse(await ui.source.inputValue()).presentation?.layout?.scope??{x:0,y:0};await ui.page.keyboard.press('ArrowRight');await expect.poll(async()=>parse(await ui.source.inputValue()).presentation?.layout?.scope?.x).toBe(before.x+200);
 await ui.page.getByRole('button',{name:'放大流程图',exact:true}).focus();await ui.page.keyboard.press('Enter');await expect(ui.page.getByLabel('流程图缩放')).toHaveText('125%');
 const invalid='projectId: '+parse(await ui.source.inputValue()).projectId+'\na: [';await ui.source.fill(invalid);await expect(ui.page.getByRole('alert').filter({hasText:'YAML 语法错误'})).toBeVisible();await expect(ui.source).toHaveValue(invalid);await expect(ui.page.getByRole('button',{name:'保存并启用',exact:true})).toBeDisabled();
 await ui.flush();return{keyboardSelectionAndLayout:true,narrowViewportReadable:true,syntaxErrorKeepsSource:true};
}
async function extensionsRoundtrip(run,ui,initial){
 const note='# Graph and YAML extension roundtrip';await ui.source.fill(initial.source+'\n'+note+'\n');await ui.valid();
 await ui.page.getByText('添加项目扩展',{exact:true}).click();await ui.page.getByLabel('扩展标识',{exact:true}).fill('project.browser-one');await ui.page.getByRole('button',{name:'加入草稿'}).click();await expect(ui.node('project.browser-one')).toBeVisible();await ui.node('project.browser-one').click();await expect(ui.page.locator('.properties .badge')).toHaveText('项目扩展');
 const one=extension(initial.base,run.selection.projectId,'browser-one');await ui.page.getByLabel('扩展属性（JSON）').fill(JSON.stringify(one));await ui.page.getByRole('button',{name:'应用扩展属性'}).click();await ui.valid();
 const doc=parseDocument(await ui.source.inputValue()),two=extension(initial.base,run.selection.projectId,'browser-two');doc.addIn(['extensions'],two);await ui.source.fill(doc.toString({lineWidth:0}));await ui.valid();
 await ui.node(two.id).click();await ui.page.getByLabel('同槽位前置节点').selectOption(one.id);await ui.page.getByRole('button',{name:'添加依赖',exact:true}).click();await ui.valid();
 assert.deepEqual(parse(await ui.source.inputValue()).extensions.find(e=>e.id===two.id).dependsOn,[one.id]);
 await ui.node(one.id).click();await ui.page.getByLabel('同槽位前置节点').selectOption(two.id);await ui.page.getByRole('button',{name:'添加依赖',exact:true}).click();await expect(ui.page.getByText('该连线会产生循环。',{exact:true})).toBeVisible();
 await ui.node(two.id).click();await ui.page.getByLabel('同槽位前置节点').selectOption(one.id);await ui.page.getByRole('button',{name:'移除依赖',exact:true}).click();await ui.page.getByRole('button',{name:'删除项目扩展',exact:true}).click();await expect(ui.node(two.id)).toHaveCount(0);
 const changedDoc=parseDocument(await ui.source.inputValue()),oneIndex=changedDoc.toJS().extensions.findIndex(e=>e.id===one.id);assert(oneIndex>=0);changedDoc.deleteIn(['extensions',oneIndex]);changedDoc.addIn(['extensions'],{...two,requirementRefs:['binding:browser-negative/edited-in-yaml']});await ui.source.fill(changedDoc.toString({lineWidth:0}));await ui.valid();
 const retained=await ui.source.inputValue();assert(retained.includes(note));assert.deepEqual(parse(retained).extensions,[...(parse(initial.source).extensions??[]),{...two,requirementRefs:['binding:browser-negative/edited-in-yaml']}]);
 await ui.node('scope').click();await expect(ui.page.locator('.properties .badge')).toHaveText('Base 阶段');await ui.save();await ui.restart();await expect(ui.source).toHaveValue(retained);await expect(ui.node(two.id)).toBeVisible();
 const read=await run.read('lifecycle.definition.read',{revisionId:(await run.read('lifecycle.definition.inspect')).draft.id});assert.equal(read.compilation.valid,true);assert(read.compilation.effective.nodes.some(n=>n.id===two.id&&n.source==='project'));assert(read.compilation.effective.nodes.filter(n=>n.source==='base').length===8);assert(Object.keys(read.compilation.effective.fieldSources).length>0);
 await negative(run,ui,initial,[['unknown-extension-field',changed(retained,['extensions',0,'unrecognized'],true)]]);
 await ui.screenshot();await ui.login('/monitor');await expect(ui.source).toHaveCount(0);return{graphAndYamlAddEditDelete:true,commentPreserved:true,sourceKindsFromNativeCompiler:true,unknownFieldLocalized:true,exactInstalledRestart:true,extensionBindings:'SYNTHETIC_UNRESOLVED_REFERENCES_NO_EXECUTION',monitorReadOnly:true};
}
async function conflicts(run,browser,ui,initial){
 const before=await ui.monitor(),other=await openBrowser(run,browser);try{
  const local=initial.source+'\n# retained stale client\n';await ui.source.fill(local);await ui.preview();await expect(ui.page.getByRole('button',{name:'保存并启用',exact:true})).toBeEnabled();
  const concurrent=initial.source+'\n# concurrent actual browser\n';await other.source.fill(concurrent);await other.save();await ui.page.getByRole('button',{name:'保存并启用',exact:true}).click();await expect(ui.page.getByRole('button',{name:'重新读取',exact:true})).toBeVisible();await expect(ui.source).toHaveValue(local);assert.equal((await run.read('lifecycle.definition.inspect')).active.id,initial.view.active.id);assert.equal(await run.source((await run.read('lifecycle.definition.inspect')).draft.id),concurrent);
  await other.preview();await other.source.fill(concurrent+'# edited after validation\n');await expect(other.page.getByRole('button',{name:'保存并启用',exact:true})).toBeDisabled();await other.save();
 }finally{await other.close();}
 await ui.close();const loss=await openBrowser(run,browser);try{
  const source=await loss.source.inputValue()+'\n# one activation with lost response\n';await loss.source.fill(source);await loss.preview();let writes=0,original,receipt;
  await loss.page.route('**/api/v1/dashboard/request',async route=>{const envelope=route.request().postDataJSON();if(envelope.operation!=='lifecycle.definition.save-and-activate')return route.continue();writes++;original=envelope.requestId;const response=await route.fetch();assert.equal(response.status(),200);receipt=await response.json();run.artifact('original-committed-activation.json',{fault:'EXPLICIT_BROWSER_RESPONSE_LOSS_AFTER_ACTUAL_SERVICE_COMMIT',request:envelope,status:response.status(),body:receipt});await route.abort('connectionreset');});
  await loss.page.getByRole('button',{name:'保存并启用',exact:true}).click();await expect(loss.page.getByRole('button',{name:'核对原请求',exact:true})).toBeEnabled();await expect(loss.page.getByRole('button',{name:'保存并启用',exact:true})).toBeDisabled();await loss.page.getByRole('button',{name:'核对原请求',exact:true}).click();await expect(loss.page.getByRole('button',{name:'重新读取',exact:true})).toBeVisible();assert.equal(writes,1);
  const retained=await run.read('runtime.receipt.read',{requestId:original});assert.equal(retained.result.status,'ACTIVE');assert.equal(retained.result.releaseAuthorized,false);assert.deepEqual(retained,receipt.result);assert.equal((await run.read('lifecycle.definition.inspect')).active.id,retained.result.revisionId);assert.equal(await run.source(retained.result.revisionId),source);await noExecution(loss,before);
  return{twoActualBrowserClients:true,staleRevisionRejected:true,editedPreviewDisabled:true,actualCommitResponseLoss:true,originalRequestInspected:true,activationSubmissions:writes,automaticRedispatch:false,executionDispatched:false};
 }finally{await loss.close();}
}

// Configuration evolution uses an existing native instance and only explicitly
// selected synthetic test decisions; it never manufactures an execution result.
export function assertDashboardInFlight(instance,projectId){
 assert.equal(instance.pins.projectId,projectId);assert.notEqual(instance.stages.closure.status,'PASSED');
 assert(Object.values(instance.stages).some(s=>s.status==='PASSED'));
 assert(Object.values(instance.stages).every(s=>!['RUNNING','UNKNOWN'].includes(s.status)));
}
async function revisionBrowser(run,browser,ui,initial,c,editChecks){
 const cfg=run.selection.revisionEvolution;assert(cfg?.allowSyntheticDecisions===true);
 const old=(await run.read('lifecycle.instance.inspect',{instanceId:cfg.instanceId})).instance;assertDashboardInFlight(old,run.selection.projectId);
 const unchanged=async()=>assert.deepEqual((await run.read('lifecycle.instance.inspect',{instanceId:cfg.instanceId})).instance,old);
 const driver=await openExecution(run),before=await driver.events();let source=initial.source;
 if(editChecks){
  const keys=['config','verification','requiredChecks'],checks=parse(source).config.verification.requiredChecks,extra='binding:synthetic/e06-'+sha(run.selection.runId+'|'+c.caseInstanceId).slice(0,20);
  assert(!checks.includes(extra));const added=changed(source,keys,[...checks,extra]);await ui.source.fill(added);await ui.save();await ui.preview();
  const a=await run.read('lifecycle.definition.validate',{yaml:added});assert.equal(a.compilation.valid,true);assert(a.compilation.effective.nodes.find(n=>n.id==='verification').checks.includes(extra));const addedId=(await run.read('lifecycle.definition.inspect')).draft.id;await unchanged();
  await ui.source.fill(source);await ui.save();await ui.preview();const removed=await run.read('lifecycle.definition.validate',{yaml:source});assert.notEqual(a.compilation.effective.semanticDigest,removed.compilation.effective.semanticDigest);
  source=changed(source,['presentation','layout','scope'],{x:35,y:65})+'\n# retained E06 EX09 comment\n';await ui.source.fill(source);await ui.preview();const presentation=await run.read('lifecycle.definition.validate',{yaml:source});assert.equal(presentation.compilation.effective.semanticDigest,removed.compilation.effective.semanticDigest);
  await unchanged();assert.equal(await run.source(addedId),added);await conflicts(run,browser,ui,{...initial,source});await unchanged();
 }else{
  const keys=['config','plan','budget','timeoutSeconds'],rule=initial.base.fields.find(f=>f.path===keys.join('.'));assert(rule);const oldValue=parse(source).config.plan.budget.timeoutSeconds;
  source=changed(source,keys,oldValue>rule.rules.minimum?oldValue-1:oldValue+1)+'\n# exact E06 new definition\n';
  await ui.source.fill(source);await ui.preview();await ui.activate();await unchanged();
 }
 const events=await driver.events(),addedEvents=events.slice(before.length);assert.deepEqual(events.slice(0,before.length),before);assert(!addedEvents.some(e=>e.type.startsWith('stage-')||e.type==='lifecycle-instance-created'||e.data?.kind==='release'));
 if(editChecks)return{actualBrowserCheckAddRemove:true,semanticPresentationSeparation:true,concurrentConflictAndOriginalReceiptRecovery:true,oldInstanceUnchanged:true,newExecutionDispatched:false};
 const active=await run.read('lifecycle.definition.inspect'),preview=await run.read('lifecycle.definition.validate',{yaml:source});assert.notEqual(active.active.id,initial.view.active.id);assert.notEqual(active.active.semanticDigest,initial.view.active.semanticDigest);assert.equal(await run.source(active.active.id),source);
 const id='e06-'+sha(run.selection.runId+'|'+c.caseInstanceId).slice(0,32),subject={instanceId:id,definitionRevisionId:active.active.id,goalRef:'synthetic:e06/'+run.selection.runId+'/goal',targetRef:'synthetic:e06/'+run.selection.runId+'/target',loopRef:'synthetic:e06/'+run.selection.runId+'/loop',budget:preview.compilation.effective.semantic.config.plan.budget,expiresAt:new Date(Date.now()+300000).toISOString()},review=await run.read('lifecycle.authority.preview',{kind:'execution',subject});
 const decisionSubject={owner:'runtime',operation:'lifecycle.authority.execution',workspaceId:run.selection.workspaceId,scope:{visibility:'private',projectId:run.selection.projectId},reviewDigest:review.reviewDigest,decision:'APPROVE'},sourceBytes=JSON.stringify({synthetic:true,description:'Explicit isolated E06 technical test attestation; never human business authority',subject:decisionSubject})+'\n',sourceRef=path.join(run.selection.outputRoot,id+'-source.json');fs.writeFileSync(sourceRef,sourceBytes,{mode:0o600,flag:'wx'});
 const evidence={schema:'evopilot-decision-evidence/v1',subject:decisionSubject,source:{reference:pathToFileURL(sourceRef).href+'#sha256='+sha(sourceBytes),description:'Synthetic isolated revision acceptance only'}},bytes=JSON.stringify(evidence)+'\n',ref=path.join(run.selection.outputRoot,id+'-decision.json');fs.writeFileSync(ref,bytes,{mode:0o600,flag:'wx'});
 const write=async(operation,input,suffix)=>{const result=await run.request(operation,input,{requestId:run.requestId(c.caseInstanceId,suffix),expectedRevision:(await run.read('runtime.status')).revision});assert.equal(result.status,200);return result.body.result;};
 const grant=await write('lifecycle.authority.record',{kind:'execution',subject,reviewDigest:review.reviewDigest,decision:'APPROVE',evidenceRef:pathToFileURL(ref).href+'#sha256='+sha(bytes)},'test-authority'),created=await write('lifecycle.instance.create',{instanceId:id,definitionRevisionId:active.active.id,authorityRef:grant.result.authorityRef},'create-pending');assert.equal(created.result.executionDispatched,false);assert.equal(created.result.releaseAuthorized,false);
 const current=(await run.read('lifecycle.instance.inspect',{instanceId:id})).instance;assert.equal(current.pins.definitionRevisionId,active.active.id);assert.equal(current.pins.semanticDigest,active.active.semanticDigest);assert.deepEqual(current.requestIds,[]);assert.equal(current.candidate,null);assert(Object.values(current.stages).every(s=>s.status==='PENDING'&&s.attempts===0&&s.requestId===null));await unchanged();
 const finalEvents=(await driver.events()).slice(before.length);assert.equal(finalEvents.filter(e=>e.type==='lifecycle-instance-created').length,1);assert(!finalEvents.some(e=>e.type.startsWith('stage-')||e.data?.kind==='release'));
 run.artifact('browser-revision-native-pins.json',{old,current,events:finalEvents,syntheticDecision:true,businessApproval:false});return{oldInstanceUnchanged:true,newInstance:id,newRevision:active.active.id,explicitNativeTestAuthority:true,activationCreatedNoRun:true,newInstancePendingOnly:true,releaseAuthorized:false};
}

export async function executeE06(callableContext) {
 const run=await openScenario('E06',undefined,callableContext);let browser;
 try{
  browser=await chromium.launch({headless:true});
  for(const c of run.cases)await run.collect(c,async()=>{
   const id=variant(c);
   if(['E06.variant.07','MC03'].includes(id))return permissionCollectors.samePageRepairs(run,browser,c);
   if(id==='CV02')return permissionCollectors.permissionTiming(run,browser,c);
   if(id==='EX04')return extensionExecution(run,c,browser,openBrowser);
   if(id==='CV04'){const fixture=interruptionFixture(run);return activationAtomicity(run,await openExecution(run),c,fixture.casePlans[c.caseInstanceId]);}
   const initial=await setup(run,c),ui=await openBrowser(run,browser);
   try{
    if(['E06.variant.09','MC05','EX09'].includes(id))return await revisionBrowser(run,browser,ui,initial,c,id==='EX09');
    if(['E06.journey','E06.variant.06','MC02'].includes(id))return await roundtrip(run,ui,initial,c);
    if(id==='E06.variant.01')return await locked(run,ui,initial);
    if(id==='E06.variant.04')return await injections(run,ui,initial);
    if(id==='E06.variant.05')return await keyboard(ui);
    if(id==='EX08')return await extensionsRoundtrip(run,ui,initial);
    if(['E06.variant.08','MC04'].includes(id))return await conflicts(run,browser,ui,initial);
    const one=extension(initial.base,run.selection.projectId,'one'),two=extension(initial.base,run.selection.projectId,'two'),input=(entries)=>changed(initial.source,['extensions'],entries);
    if(id==='E06.variant.02')return await negative(run,ui,initial,[['cycle',input([{...one,dependsOn:[two.id]},{...two,dependsOn:[one.id]}])],['duplicate-ID',input([one,{...two,id:one.id}])]]);
    if(id==='E06.variant.03')return await negative(run,ui,initial,[['unknown-root-field',changed(initial.source,['unrecognized'],true)],['unknown-extension-field',input([{...one,unrecognized:true}])],['unknown-action',input([{...one,actionRef:'runtime:unpublished-action'}])]]);
    assert.equal(id,'EX05','Unknown frozen E06 case');
    const alternate=Object.keys(initial.base.slots).find(s=>s!==one.slot&&initial.base.slots[s].types.includes('check'));assert(alternate);
    return await negative(run,ui,initial,[['remove-base-stage',changed(initial.source,['stages'],initial.base.stages.filter(s=>s.id!=='verification'))],['cross-slot',input([one,{...extension(initial.base,run.selection.projectId,'two',alternate),dependsOn:[one.id]}])],['skip-to-publication',input([{...one,dependsOn:['publication']}])],['cycle',input([{...one,dependsOn:[two.id]},{...two,dependsOn:[one.id]}])],['isolated-dependency',input([{...one,dependsOn:['project.missing']}])],['duplicate-base-ID',input([{...one,id:'verification'}])],['OR-join',input([{...one,join:'OR'}])],['not-required',input([{...one,required:false}])],['continue-on-error',input([{...one,continueOnError:true}])]]);
   }finally{await ui.close();}
  });
 }finally{await browser?.close();run.finish();}
}
if(process.argv[1]&&collectorPathToFileURL(collectorResolve(process.argv[1])).href===import.meta.url)test('E06 exact installed graph and YAML lifecycle browser cases',executeE06);

// Fixed source-audited branches; no fixture or provider action runs at registration.
const E06_CALLABLE_ROUTES=Object.freeze({"E06.journey":{"handler":"roundtrip"},"E06.variant.01":{"handler":"locked"},"E06.variant.02":{"handler":"negative/cycle-duplicate"},"E06.variant.03":{"handler":"negative/unknown"},"E06.variant.04":{"handler":"injections"},"E06.variant.05":{"handler":"keyboard"},"E06.variant.06":{"handler":"roundtrip"},"E06.variant.07":{"handler":"samePageRepairs"},"E06.variant.08":{"handler":"conflicts"},"E06.variant.09":{"handler":"revisionBrowser"},"E06.EX04":{"handler":"extensionExecution"},"E06.EX05":{"handler":"negative/graph-attacks"},"E06.EX08":{"handler":"extensionsRoundtrip"},"E06.EX09":{"handler":"revisionBrowser"},"E06.MC02":{"handler":"roundtrip"},"E06.MC03":{"handler":"samePageRepairs"},"E06.MC04":{"handler":"conflicts"},"E06.MC05":{"handler":"revisionBrowser"},"E06.CV02":{"handler":"permissionTiming"},"E06.CV04":{"handler":"activationAtomicity"}});
export function registerE06CallableCases(catalog){
 const routes=E06_CALLABLE_ROUTES;
 return registerFixedScenario({scenario:'E06',phase:'PRE_RELEASE',catalog,routes,execute:executeE06});
}
