import {registerFixedScenario} from './preflight.mjs';
import {pathToFileURL as collectorPathToFileURL} from 'node:url';
import {resolve as collectorResolve} from 'node:path';
// Installed monitor qualification. Original UNKNOWN, revocation and cursor gaps
// need actual retained evidence; no direct store seeding or synthetic outcomes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {openScenario,repository} from './support.mjs';
import {openBrowser} from './browser.mjs';
import * as permissionCollectors from './e12.test.mjs';

function monitorShape(value,projectId){
 assert.equal(value.projectId,projectId);assert.equal(value.readOnly,true);assert(Number.isSafeInteger(value.revision));assert(Array.isArray(value.instances));
 for(const i of value.instances){
  assert.deepEqual(Object.keys(i).sort(),['id','createdAt','definitionRevisionId','base','goalRef','targetRef','loopRef','candidateDigest','graph','stages'].sort());
  for(const n of i.graph)assert.deepEqual(Object.keys(n).sort(),['id','source','stage','dependsOn','checks'].sort());
 }
}
async function streamEvidence(ui,projectId){
 await expect.poll(()=>ui.sseFrames.filter(f=>['snapshot','events','heartbeat'].includes(f.eventName)).length,{timeout:10000}).toBeGreaterThan(0);
 for(const frame of ui.sseFrames){
  if(frame.eventName==='error')continue;
  const data=JSON.parse(frame.data);assert.equal(data.projectId,projectId);assert.equal(typeof data.cursor,'string');assert(Array.isArray(data.events));assert(Number.isSafeInteger(data.watermark.sequence));assert(Number.isSafeInteger(data.watermark.revision));
  for(const event of data.events)assert.deepEqual(Object.keys(event).sort(),['seq','revision','type','at'].sort());
 }
}
async function readonly(run,ui,c){
 const principal=run.principal('monitor');assert.deepEqual(principal.expectedPermissions,['read']);
 await expect(ui.source).toHaveCount(0);for(const name of ['保存草稿','保存并启用','校验与差异预览'])await expect(ui.page.getByRole('button',{name,exact:true})).toHaveCount(0);
 const before=await ui.monitor();monitorShape(before,principal.projectId);
 for(const operation of ['lifecycle.draft.save','lifecycle.definition.save-and-activate','lifecycle.instance.create','lifecycle.stage.request']){
  const input=operation==='lifecycle.draft.save'?{yaml:'{}\n'}:operation==='lifecycle.definition.save-and-activate'?{yaml:'{}\n',validationDigest:null}:operation==='lifecycle.instance.create'?{instanceId:'e07-not-created',definitionRevisionId:'sha256:'+'0'.repeat(64),authorityRef:'synthetic:ungranted'}:{instanceId:'e07-not-created',stageId:'scope'};
  const response=await run.principalRequest('monitor',operation,input,{requestId:run.requestId(c.caseInstanceId,operation.replaceAll('.','-')),expectedRevision:before.revision});assert.equal(response.status,403);assert.equal(response.body.error.code,'FORBIDDEN');
 }
 const browserDenied=await ui.sessionRequest('lifecycle.stage.request',{instanceId:'e07-not-created',stageId:'scope'},{requestId:run.requestId(c.caseInstanceId,'browser-stage-denied'),expectedRevision:before.revision});assert.equal(browserDenied.status,403);assert.equal(browserDenied.body.error.code,'DASHBOARD_OPERATION');
 const after=await ui.monitor();assert.equal(after.revision,before.revision);assert.deepEqual(after.instances,before.instances);await streamEvidence(ui,principal.projectId);
 await ui.flush();assert.equal(ui.network.filter(n=>n.request?.operation==='lifecycle.definition.source.read').length,0);await run.assertNoCredentialExposure([{name:'monitor DOM',text:await ui.page.content()},{name:'monitor URL',text:ui.page.url()},{name:'monitor network',text:JSON.stringify([...ui.monitorNetwork,...ui.sseFrames])}]);
 return{actualInstalledBrowser:true,actualReadOnlyPrincipal:true,httpAndBrowserExecutionDenied:true,monitorPayloadContainsNoEditorConfiguration:true,unchangedRevisionAndInstances:true,originalSseFrames:true,postIndependentRemaining:['E22','P04']};
}

export async function unknownMonitor(run,ui,c){
     const id=run.selection.monitorConfiguration?.instanceId;assert(id,'Select the actual UNKNOWN instance');const observed=(await run.read('lifecycle.instance.inspect',{instanceId:id})).instance;const unknown=Object.entries(observed.stages).filter(([,s])=>s.status==='UNKNOWN');assert(unknown.length,'A synthetic browser label is not original UNKNOWN evidence');
     for(const [,stage] of unknown){assert(stage.requestId);const original=await run.read('lifecycle.stage.request.inspect',{stageRequestId:stage.requestId});assert.equal(original.progress.phase,'UNKNOWN');}
     const snapshot=await ui.monitor();monitorShape(snapshot,run.selection.projectId);const item=snapshot.instances.find(i=>i.id===id);assert(item,'Select a visible first-page instance or extend native pagination before qualification');assert.equal(item.definitionRevisionId,observed.pins.definitionRevisionId);assert.deepEqual(item.base,observed.pins.base);assert.deepEqual(item.graph,observed.definition.nodes.map(({id,source,stage,dependsOn,checks})=>({id,source,stage,dependsOn,checks})));assert.deepEqual(item.stages,observed.stages);await ui.page.getByLabel('生命周期实例',{exact:true}).selectOption(id);
     for(const [stage] of unknown)await expect(ui.node(stage)).toHaveAttribute('data-status','UNKNOWN');await expect(ui.page.locator('tbody .status.UNKNOWN')).toHaveCount(unknown.length);await streamEvidence(ui,run.selection.projectId);assert.deepEqual((await run.read('lifecycle.instance.inspect',{instanceId:id})).instance,observed);return{originalUnknownRequestReadback:true,unknownNotPassed:true,definitionAndStagePinsExact:true,monitorReadOnly:true};
}

export async function replayMonitor(run,ui,c){
     assert.equal(run.selection.monitorConfiguration?.allowReplayWindowExercise,true,'Select the bounded 1001 native-draft event exercise explicitly');assert.equal(run.principal('monitor').projectId,run.selection.projectId);
     await streamEvidence(ui,run.selection.projectId);const original=JSON.parse(ui.sseFrames.find(f=>f.eventName==='snapshot').data),before=await ui.monitor(),view=await run.read('lifecycle.definition.inspect');assert(view.active);const yaml=await run.source(view.active.id),restore=view.draft?await run.source(view.draft.id):yaml;
     run.artifact('retained-monitor-cursor.json',{cursor:original.cursor,watermark:original.watermark,exercise:'1001 original native draft events; no business or provider dispatch'});
     let revision=view.revision;
     for(let i=0;i<1001;i++){const r=await run.request('lifecycle.draft.save',{yaml:yaml+'\n# Replay-window acceptance '+i+'\n'},{requestId:run.requestId(c.caseInstanceId,'event-'+i),expectedRevision:revision});assert.equal(r.status,200);assert.equal(r.body.result.result.status,'DRAFT');revision=r.body.result.revision;}
     const restored=await run.request('lifecycle.draft.save',{yaml:restore},{requestId:run.requestId(c.caseInstanceId,'restore-draft'),expectedRevision:revision});assert.equal(restored.status,200);
     let requests=0;await ui.page.route('**/api/v1/dashboard/events*',async route=>{if(requests++===0)return route.continue({url:run.serviceOrigin+'/api/v1/dashboard/events?cursor='+encodeURIComponent(original.cursor)});return route.continue();});
     await ui.login('/monitor');await expect.poll(()=>ui.sseFrames.filter(f=>f.eventName==='reset').length,{timeout:10000}).toBeGreaterThan(0);const reset=JSON.parse(ui.sseFrames.find(f=>f.eventName==='reset').data);assert.equal(reset.gap.code,'CURSOR_EXPIRED');assert.equal(reset.gap.windowEvents,1000);assert(reset.gap.resumeRevision>original.watermark.revision);assert.deepEqual(reset.events,[]);
     const recovery=ui.page.getByTestId('monitor-recovery');await expect(recovery).toContainText('未逐条重放');await expect(recovery).toContainText(/已通过修订 \d+ 的当前快照恢复/);const recoveryText=await recovery.innerText(),recoveryRevision=Number(recoveryText.match(/已通过修订 (\d+) 的当前快照恢复/)[1]);assert(Number.isSafeInteger(recoveryRevision));assert(recoveryRevision>=reset.gap.resumeRevision,'The recovered UI snapshot must reach the reset resume revision');const after=await ui.monitor();assert(after.revision>=recoveryRevision);assert.deepEqual(after.instances,before.instances);assert.equal(after.revision,restored.body.result.revision);assert.equal((await run.read('lifecycle.definition.inspect')).active.id,view.active.id);run.artifact('monitor-recovery-readback.json',{recoveryText,recoveryRevision,resetResumeRevision:reset.gap.resumeRevision,observedRevision:after.revision});await ui.flush();return{actualSignedCursorOutsideWindow:true,originalEventWindow:1000,nativeDraftEvents:1001,actualResetAndSnapshot:true,recoveryRevision,originalActiveAndInstancesPreserved:true};
}

export function assertMonitorProgress(rows,projectId){
 let revision=-1;
 for(const row of rows){const value=JSON.parse(row.rawBody).result;assert.equal(value.projectId,projectId);assert(Number.isSafeInteger(value.revision));assert(value.revision>=revision,'Monitor revision cannot regress');revision=value.revision;monitorShape(value,projectId);}
 assert(rows.length>0,'Original monitor responses required');return revision;
}
async function monitorJourney(run,browser,c){
 const originalUnknown=(await run.read('lifecycle.instance.inspect',{instanceId:run.selection.monitorConfiguration?.instanceId})).instance;
 const initial=await permissionCollectors.permissionFixture(run,c);assert.notEqual(initial.original.id,originalUnknown.id,'Pending permission fixture and original UNKNOWN must be distinct native instances');const ui=await openBrowser(run,browser,{route:'/monitor',principalAlias:'monitor',monitorEvidence:true});let observations;
 try{
  const readOnly=await readonly(run,ui,c),unknown=await unknownMonitor(run,ui,c),recovery=await replayMonitor(run,ui,c);await ui.flush();
  const revision=assertMonitorProgress(ui.monitorReadbacks,run.selection.projectId);
  const beta=run.principal('beta');assert.notEqual(beta.projectId,run.selection.projectId);assert.deepEqual(beta.expectedPermissions,['read']);
  await ui.page.getByRole('button',{name:'断开项目连接',exact:true}).click();await expect(ui.page.getByLabel('一次性连接码')).toBeVisible();const start=ui.monitorReadbacks.length,frames=ui.sseFrames.length;
  // The one-use connection code is entered into the actual UI; never retained.
  try{await ui.page.getByLabel('一次性连接码').fill(await run.browserCode('beta'));await ui.page.getByRole('button',{name:'连接项目',exact:true}).click();}catch{throw Error('BROWSER_PROJECT_SWITCH_FAILED');}
  await expect(ui.page.locator('.monitor-strip')).toHaveAttribute('data-project-id',beta.projectId);await expect(ui.source).toHaveCount(0);
  await expect.poll(()=>ui.sseFrames.slice(frames).filter(f=>f.eventName==='snapshot'&&JSON.parse(f.data).projectId===beta.projectId).length).toBeGreaterThan(0);await ui.flush();
  const switched=await ui.monitor();monitorShape(switched,beta.projectId);assertMonitorProgress(ui.monitorReadbacks.slice(start),beta.projectId);
  for(const frame of ui.sseFrames.slice(frames).filter(f=>['snapshot','events','heartbeat'].includes(f.eventName)))assert.equal(JSON.parse(frame.data).projectId,beta.projectId);
  assert(!switched.instances.some(i=>i.id===run.selection.monitorConfiguration.instanceId));
  await ui.page.getByRole('button',{name:'断开项目连接',exact:true}).click();await ui.login('/monitor');await expect(ui.page.locator('.monitor-strip')).toHaveAttribute('data-project-id',run.selection.projectId);assert((await ui.monitor()).revision>=revision);
  observations={readOnly,unknown,recovery,actualProjectSwitch:true,returnRevisionNotRegressed:true};
 }finally{await ui.close();}
 const revocation=await permissionCollectors.afterActivationRevocation(run,browser,c,initial,{expire:'journey-expire',restore:'journey-restore'});
 assert.deepEqual((await run.read('lifecycle.instance.inspect',{instanceId:originalUnknown.id})).instance,originalUnknown);
 return{...observations,revocation,originalUnknownPreserved:true,actualInstalledBrowser:true,postReleaseAcceptance:false};
}

export async function executeE07(callableContext) {
 const run=await openScenario('E07',undefined,callableContext);let browser;
 try{
  assert(run.selection.principals?.monitor,'Select an actual protected monitor-only connection');browser=await chromium.launch({headless:true});
  for(const c of run.cases)await run.collect(c,async()=>{
   if(c.caseInstanceId==='E07.CV02')return permissionCollectors.permissionTiming(run,browser,c);
   if(c.caseInstanceId==='E07.journey')return monitorJourney(run,browser,c);
   const ui=await openBrowser(run,browser,{route:'/monitor',principalAlias:'monitor',monitorEvidence:true});
   try{
    if(c.caseInstanceId==='E07.variant.01'){
     const initial=await ui.monitor();monitorShape(initial,run.principal('monitor').projectId);assert.deepEqual(initial.instances,[],'Use an actually empty selected project');await expect(ui.page.getByRole('heading',{name:'暂无生命周期实例'})).toBeVisible();await expect(ui.source).toHaveCount(0);await streamEvidence(ui,initial.projectId);await ui.flush();assert.deepEqual((await ui.monitor()).instances,[]);return{actualEmptyProject:true,noImplicitInstanceCreation:true,actualSse:true};
    }
    if(c.caseInstanceId==='E07.variant.02')return await unknownMonitor(run,ui,c);
    if(c.caseInstanceId==='E07.variant.03')return await replayMonitor(run,ui,c);
    assert(['E07.variant.04','E07.MC06','E07.CV08'].includes(c.caseInstanceId));const result=await readonly(run,ui,c);
    if(c.caseInstanceId==='E07.CV08'){
     const catalog=JSON.parse(fs.readFileSync(path.join(repository,'governance/acceptance-v090.json'))),scenario=catalog.scenarios.find(x=>x.id==='E07');assert.equal(scenario.phase,'PRE_RELEASE');assert(!scenario.groups.includes('P04'));assert(c.parameters.variantContract.mainCases.includes('E22'));
     run.artifact('monitor-pre-post-mapping.json',{current:c.caseInstanceId,phase:scenario.phase,groups:scenario.groups,actualPreMonitorResult:result,postIndependentRemaining:['E22','P04'],postAcceptanceNotClaimed:true});
    }
    return result;
   }finally{await ui.close();}
  });
 }finally{await browser?.close();run.finish();}
}
if(process.argv[1]&&collectorPathToFileURL(collectorResolve(process.argv[1])).href===import.meta.url)test('E07 installed monitor state, read-only identity and original event stream',executeE07);

// Fixed source-audited branches; no fixture or provider action runs at registration.
const E07_CALLABLE_ROUTES=Object.freeze({"E07.journey":{"handler":"monitorJourney"},"E07.variant.01":{"handler":"empty-native-monitor"},"E07.variant.02":{"handler":"unknownMonitor"},"E07.variant.03":{"handler":"replayMonitor"},"E07.variant.04":{"handler":"readonly"},"E07.MC06":{"handler":"readonly"},"E07.CV02":{"handler":"permissionTiming"},"E07.CV08":{"handler":"readonly/phase-mapping"}});
export function registerE07CallableCases(catalog){
 const routes=E07_CALLABLE_ROUTES;
 return registerFixedScenario({scenario:'E07',phase:'PRE_RELEASE',catalog,routes,execute:executeE07});
}
