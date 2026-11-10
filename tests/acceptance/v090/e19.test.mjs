import {pathToFileURL as collectorPathToFileURL} from 'node:url';
import {resolve as collectorResolve} from 'node:path';
// Real installed-service/browser qualification on explicitly marked synthetic
// inventory. This collector never seeds SQLite, invents instance authority,
// fulfills fake API responses, changes clocks or relaxes the fixed thresholds.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import {performance} from 'node:perf_hooks';
import {chromium,expect} from '@playwright/test';
import {parseDocument} from 'yaml';
import {readHostConnection,hostHeaders} from '../../../dist/server/security.js';
import {openScenario,sha} from './support.mjs';
import {openBrowser} from './browser.mjs';

const fixed=Object.freeze({definitionRevisions:1000,nativeEvents:10000,samples:20,pageItems:50,pageBytes:262144,summaryP95Ms:2000,eventP95Ms:5000,disconnectMs:15000,viewports:[{width:1440,height:1000},{width:390,height:844}]});
const p95=values=>{assert.equal(values.length,fixed.samples);assert(values.every(n=>Number.isFinite(n)&&n>=0));return [...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];};
const stamp=()=>({wall:Date.now(),monotonic:performance.now()});
const stableClock=(before,after)=>assert(Math.abs((after.wall-before.wall)-(after.monotonic-before.monotonic))<100,'Clock changed during measurement; retain this attempt without qualifying its timing');

// A bounded archive of original native requests/responses avoids exhausting
// the unchanged all-scenario evidence-file bound with 20000 individual files.
// Every request is serial, uses the selected protected connection and has its
// own identity/revision. An uncertain response is retained before stopping.
function nativeDraftWriter(run,c,signal){
 const connection=readHostConnection(run.selection.connectionRef);assert.equal(connection.origin,run.serviceOrigin);assert.equal(connection.projectId,run.selection.projectId);assert.equal(connection.workspaceId,run.selection.workspaceId);assert.equal(connection.serviceId,run.candidate.serviceId);assert.equal(connection.principalId,run.principal().principalId);
 let rows=[],bytes=0,failed=false,batch=0;
 const flush=()=>{if(rows.length){run.artifact('native-draft-batch.json',{batch:++batch,entry:'ACTUAL_SELECTED_INSTALLED_HTTP_API',synthetic:true,automaticRetry:false,rows});rows=[];bytes=0;}};
 async function save(yaml,suffix,expectedRevision){
  assert(!failed,'An uncertain original write cannot be retried by this collector');signal.throwIfAborted();
  const envelope={operation:'lifecycle.draft.save',projectId:run.selection.projectId,input:{yaml},requestId:run.requestId(c.caseInstanceId,suffix),expectedRevision};
  const wire=JSON.stringify(envelope);assert(Buffer.byteLength(wire)<=262144);const started=stamp(),chunks=[];let response,rawBody,originalBytes,transport='UNKNOWN',status=null,headers={};
  try{
   response=await fetch(connection.origin+'/api/v1/request',{method:'POST',headers:{...hostHeaders(connection),'content-type':'application/json'},body:wire,signal:AbortSignal.any([signal,AbortSignal.timeout(30000)]),redirect:'error'});
   status=response.status;headers=Object.fromEntries(['content-type','x-request-id'].map(k=>[k,response.headers.get(k)]).filter(([,v])=>v!==null));
   const reader=response.body.getReader();let size=0;
   try{for(;;){const part=await reader.read();if(part.done)break;const room=262144-size;chunks.push(part.value.subarray(0,room));assert(part.value.length<=room);size+=part.value.length;}}finally{reader.releaseLock();}
   originalBytes=Buffer.concat(chunks);rawBody=new TextDecoder('utf-8',{fatal:true}).decode(originalBytes);transport='RESPONSE_RETAINED';
  }catch{
   failed=true;const retained=Buffer.concat(chunks);rows.push({envelope,requestBytes:Buffer.byteLength(wire),requestSha256:sha(wire),status,headers,rawBody:rawBody??null,retainedResponsePrefixBase64:retained.toString('base64'),retainedResponsePrefixSha256:sha(retained),transport:'UNKNOWN',started,finished:stamp(),automaticRetry:false});flush();throw Error('E19_NATIVE_DRAFT_OUTCOME_UNKNOWN: inspect the original retained request before any further write');
  }
  const finished=stamp(),row={envelope,requestBytes:Buffer.byteLength(wire),requestSha256:sha(wire),status,headers,rawBody,responseBytes:originalBytes.length,responseSha256:sha(originalBytes),transport,started,finished};
  const size=Buffer.byteLength(JSON.stringify(row));assert(size<8388608);if(bytes+size>8388608)flush();rows.push(row);bytes+=size;if(rows.length===50)flush();
  // Retain even malformed or rejected original responses before failing.
  try{assert(headers['content-type']?.startsWith('application/json'));assert.equal(status,200);const body=JSON.parse(rawBody),receipt=body.result;assert.equal(receipt.requestId,envelope.requestId);assert.equal(receipt.operation,envelope.operation);assert.equal(receipt.projectId,envelope.projectId);assert.equal(receipt.revision,expectedRevision+1);assert.equal(receipt.result.status,'DRAFT');assert.equal(receipt.result.executionAuthorized,false);assert.equal(receipt.result.releaseAuthorized,false);assert(Number.isFinite(Date.parse(receipt.at)));return receipt;}
  catch(error){failed=true;flush();throw error;}
 }
 return{save,flush};
}

async function eventPages(run,after,visit,signal){
 let cursor=after,count=0,lastSequence=-1;
 for(let page=0;page<1000;page++){
  signal?.throwIfAborted();const response=await run.request('runtime.events.read',cursor?{cursor}:{});assert.equal(response.status,200);assert(Buffer.byteLength(JSON.stringify(response.body))<=fixed.pageBytes);const value=response.body.result;
  assert(value.events.length<=fixed.pageItems);for(const event of value.events){assert(event.seq>lastSequence);lastSequence=event.seq;await visit?.(event);count++;}
  const old=cursor;cursor=value.cursor;assert.equal(typeof cursor,'string');if(value.events.length===0)return{cursor,count};assert.notEqual(cursor,old);
 }
 throw Error('E19_EVENT_SCAN_LIMIT: unexpected inventory or concurrent activity');
}

function shape(page,projectId){
 assert.equal(page.projectId,projectId);assert.equal(page.readOnly,true);assert(Number.isSafeInteger(page.revision));assert(page.instances.length<=fixed.pageItems);
 for(const item of page.instances){assert.deepEqual(Object.keys(item).sort(),['id','createdAt','definitionRevisionId','base','goalRef','targetRef','loopRef','candidateDigest','graph','stages'].sort());for(const node of item.graph)assert.deepEqual(Object.keys(node).sort(),['id','source','stage','dependsOn','checks'].sort());}
}
async function allInstances(run,ui,label){
 const first=await ui.monitor(),instances=[],pages=[];let page=first;
 for(let n=0;n<20;n++){
  shape(page,run.selection.projectId);assert.equal(page.revision,first.revision);instances.push(...page.instances);const original=ui.monitorReadbacks.at(-1);assert(original.bytes<=fixed.pageBytes);pages.push({items:page.instances.length,bytes:original.bytes,sha256:sha(original.rawBody),revision:page.revision,nextAfter:page.nextAfter});
  if(!page.nextAfter){assert.equal(new Set(instances.map(i=>i.id)).size,instances.length);run.artifact('monitor-pagination-measurement.json',{label,pages,instances:instances.length,originalBodiesRetained:true});return{revision:first.revision,instances,pages};}
  assert(page.instances.length);page=await ui.monitor({after:page.nextAfter,revision:first.revision});
 }
 throw Error('E19_MONITOR_PAGE_LIMIT: fixed fixture must have at most 1000 instances');
}
async function fitted(ui){assert.equal(await ui.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'The page must remain usable without whole-page horizontal overflow');}
async function snapshots(ui){await ui.flush();const observed=await ui.performanceReadback();assert.deepEqual(observed.faults,[]);return observed.samples;}
function exactPaint(row){assert.deepEqual(row.renderedSnapshot,{projectId:row.projectId,revision:String(row.revision),observedAt:row.observedAt},'The original response must match the actual rendered project/revision/ISO timestamp');}
async function firstPaint(ui){
 await expect.poll(async()=>{const all=await snapshots(ui);return all.some(row=>row.paintAt!==null);},{timeout:15000,message:'An exact original summary must reach the actual DOM and a paint'}).toBe(true);
 const rows=await snapshots(ui),first=rows[0],row=rows.filter(r=>r.paintAt!==null).sort((a,b)=>a.paintAt-b.paintAt)[0];assert.equal(first.status,200);assert.equal(first.transport,'RESPONSE_OBSERVED');assert.equal(row.status,200);assert.equal(row.transport,'RESPONSE_OBSERVED');exactPaint(row);assert.equal(row.projectId,ui.monitorNetwork.map(n=>{try{return JSON.parse(n.rawBody).result.projectId;}catch{return null;}}).find(Boolean));assert(row.bytes<=fixed.pageBytes&&row.instanceIds.length<=fixed.pageItems);
 // A queued snapshot may supersede an earlier response before the browser
 // paints it. Measure the first actual paint from the FIRST request start,
 // retaining both identities; never discard a slow first request/sample.
 return{...row,firstRequestStartedAt:first.startedAt,firstRequestIndex:first.index,firstRequestRevision:first.revision};
}

async function permissionChange(run,browser){
 const p=run.principal('permission-loss');assert.equal(p.projectId,run.selection.projectId);assert.deepEqual(p.expectedPermissions,['read']);
 const before=await run.principalRequest('permission-loss','runtime.status');assert.equal(before.status,200,'The selected permission-loss identity must first be genuinely valid');
 const ui=await openBrowser(run,browser,{route:'/monitor',principalAlias:'permission-loss',monitorEvidence:true});
 try{
  await expect(ui.page.locator('.connection.online')).toBeVisible();run.artifact('permission-change-ready.json',{principal:p,at:new Date().toISOString(),fixture:'External isolated operator revocation or natural principal expiry; no collector auth mutation',timeoutMs:run.selection.performanceConfiguration.permissionLossTimeoutMs});
  await expect(ui.page.getByLabel('一次性连接码')).toBeVisible({timeout:run.selection.performanceConfiguration.permissionLossTimeoutMs});await expect(ui.page.getByRole('heading',{name:'生命周期监控',exact:true})).not.toBeVisible();await expect(ui.page.getByRole('alert')).toContainText('连接已过期或权限已变化');
  const denied=await run.principalRequest('permission-loss','runtime.status');assert([401,403].includes(denied.status));await ui.flush();
  assert(ui.sseFrames.some(f=>f.eventName==='error'&&['UNAUTHENTICATED','FORBIDDEN','BROWSER_SESSION_REVOKED','BROWSER_SESSION_EXPIRED'].includes(JSON.parse(f.data).code))||ui.monitorNetwork.some(n=>[401,403].includes(n.status)),'Retain original native auth loss, not only a browser label');await ui.screenshot();
  return{actualInitiallyAuthorizedPrincipal:true,actualSubsequentDenial:true,hiddenMonitorAfterLoss:true};
 }finally{await ui.close();}
}

async function emptyStates(run,browser){
 const p=run.principal('empty');assert.notEqual(p.projectId,run.selection.projectId);assert.deepEqual(p.expectedPermissions,['read']);const ui=await openBrowser(run,browser,{route:'/monitor',principalAlias:'empty',monitorEvidence:true});
 try{const page=await ui.monitor();shape(page,p.projectId);assert.deepEqual(page.instances,[]);await expect(ui.page.getByRole('heading',{name:'暂无生命周期实例'})).toBeVisible();await ui.screenshot();await ui.login('/lifecycle');await expect(ui.source).toHaveValue('');await expect(ui.page.getByText('尚未启用',{exact:true})).toBeVisible();await expect(ui.page.getByRole('button',{name:'保存草稿',exact:true})).toBeDisabled();await ui.screenshot();return{actualEmptyProject:true,emptyEditorAndMonitor:true};}finally{await ui.close();}
}

async function loadingState(run,ui,route){
 let release,observeHeld,released=false,failure;const barrier=new Promise(resolve=>{release=resolve;}),firstHeld=new Promise(resolve=>{observeHeld=resolve;}),pattern=route==='/monitor'?'**/api/v1/dashboard/monitor*':'**/api/v1/dashboard/request',requests=[],handlerErrors=[];
 const bounded=async(promise,label)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('E19_LOADING_ROUTE_TIMEOUT: '+label)),10000);})]);}finally{clearTimeout(timer);}};
 const hold=async request=>{
  const operation=route==='/monitor'?'monitor.read':request.request().postDataJSON()?.operation,blocked=route==='/monitor'||operation==='lifecycle.base.inspect'||operation==='lifecycle.definition.inspect',row={operation,blocked,continued:false,completed:false};requests.push(row);
  // The initial loading DOM can render before its request reaches routing.
  // Observe the actual intercepted request before asserting that UI state.
  try{if(blocked){observeHeld();await barrier;}await request.continue();row.continued=true;}
  catch(error){handlerErrors.push(error);}
  finally{row.completed=true;}
 };
 await ui.flush();await ui.page.route(pattern,hold);
 try{await ui.page.goto(run.serviceOrigin+route);await bounded(firstHeld,'native request interception');assert(requests.some(r=>r.blocked&&!r.completed));await expect(ui.page.getByText(route==='/monitor'?'正在读取生命周期实例…':'正在读取项目定义…',{exact:true})).toBeVisible();await ui.screenshot();}
 catch(error){failure=error;}
 finally{
  assert.equal(released,false);released=true;release();
  // This page has only this temporary route. Wait for its in-flight handlers
  // before any later navigation or close can handle the same request again.
  try{await bounded(ui.page.unrouteAll({behavior:'wait'}),'released handler completion');}catch(error){handlerErrors.push(error);}
 }
 run.artifact('explicit-ui-loading-fault.json',{route,method:'Observe and hold the actual native request, then continue unchanged exactly once and await all handlers',syntheticResponse:false,excludedFromPerformanceSamples:true,releasedOnce:released,requests,errors:handlerErrors.map(error=>error.message),observationError:failure?.message??null});
 if(failure&&handlerErrors.length)throw new AggregateError([failure,...handlerErrors],'E19 loading observation and route cleanup failed; inspect retained request outcomes');
 if(failure)throw failure;if(handlerErrors.length)throw new AggregateError(handlerErrors,'E19 loading route cleanup failed; inspect retained request outcomes');assert(requests.every(r=>r.completed&&r.continued));
 await expect(ui.page.getByRole('heading',{name:route==='/monitor'?'生命周期监控':'生命周期定义',exact:true})).toBeVisible();if(route==='/monitor')await expect(ui.page.getByLabel('生命周期实例',{exact:true})).toBeVisible();else await ui.valid();await ui.flush();
}

async function interactionStates(run,browser,original){
 const ui=await openBrowser(run,browser,{route:'/lifecycle',monitorEvidence:true});const saved=await ui.source.inputValue();assert.equal(saved,original);
 const editorByKeyboard=async()=>{await ui.flush();const link=ui.page.getByRole('navigation',{name:'项目导航',exact:true}).getByRole('link',{name:'◇ 生命周期定义',exact:true});await link.focus();await ui.page.keyboard.press('Enter');await expect(ui.page.getByRole('heading',{name:'生命周期定义',exact:true})).toBeVisible();await ui.valid();};
 try{
  await loadingState(run,ui,'/lifecycle');await loadingState(run,ui,'/monitor');
  for(const viewport of fixed.viewports){
   await ui.page.setViewportSize(viewport);await editorByKeyboard();await ui.valid();await fitted(ui);await expect(ui.node('scope')).toBeVisible();await ui.node('scope').focus();await ui.page.keyboard.press('ArrowDown');
   const changed=await ui.source.inputValue();assert.notEqual(changed,saved);await expect(ui.source).toBeEditable();await ui.source.fill(saved);await ui.valid();await ui.screenshot();
   const link=ui.page.getByRole('navigation',{name:'项目导航',exact:true}).getByRole('link',{name:'◉ 实时监控',exact:true});await link.focus();await ui.page.keyboard.press('Enter');await expect(ui.page.getByRole('heading',{name:'生命周期监控',exact:true})).toBeVisible();await expect(ui.page.getByLabel('生命周期实例',{exact:true})).toBeVisible();await ui.node('scope').focus();await ui.page.keyboard.press('Enter');await expect(ui.page.getByRole('heading',{name:'范围定义 · 观测详情'})).toBeVisible();await expect(ui.source).toHaveCount(0);await fitted(ui);await ui.screenshot();
   for(let page=0;await ui.page.locator('#instance option').count()<=50&&page<20;page++){
    const count=await ui.page.locator('#instance option').count();await ui.page.getByRole('button',{name:'加载更多实例',exact:true}).click();await expect.poll(()=>ui.page.locator('#instance option').count()).toBeGreaterThan(count);
   }
   assert(await ui.page.locator('#instance option').count()>50);await fitted(ui);await ui.screenshot();
  }
  // Exercise the real monitor's graph-error boundary without changing a graph,
  // instance or service response: an explicit browser DOM parser outage.
  const statuses=await ui.page.locator('tbody').innerText();await ui.page.evaluate(()=>{window.__e19Parse=DOMParser.prototype.parseFromString;DOMParser.prototype.parseFromString=function(){throw Error('E19 controlled browser DOM parser outage');};});
  try{await ui.page.locator('tbody').getByRole('button',{name:'方案设计',exact:true}).click();await expect(ui.page.getByRole('alert').filter({hasText:'图形暂不可用'})).toBeVisible();assert.equal(await ui.page.locator('tbody').innerText(),statuses);await expect(ui.page.getByRole('heading',{name:'方案设计 · 观测详情'})).toBeVisible();await ui.screenshot();run.artifact('explicit-monitor-render-fault.json',{method:'Temporary browser DOMParser.parseFromString failure only; service graph and stage facts unchanged',originalStatusTableRetained:true,syntheticServiceResponse:false});}
  finally{await ui.page.evaluate(()=>{DOMParser.prototype.parseFromString=window.__e19Parse;delete window.__e19Parse;});}
  await editorByKeyboard();await ui.source.fill('projectId: '+run.selection.projectId+'\na: [');await expect(ui.page.getByRole('alert').filter({hasText:'YAML 语法错误'})).toBeVisible();await expect(ui.page.getByRole('button',{name:'保存并启用',exact:true})).toBeDisabled();await ui.screenshot();await ui.source.fill(saved);await ui.valid();
  const doc=parseDocument(saved);assert.equal(doc.errors.length,0);doc.set('extensions',[{id:'project.e19-one',slot:'after-plan',dependsOn:['project.e19-two']},{id:'project.e19-two',slot:'after-plan',dependsOn:['project.e19-one']}]);const invalid=doc.toString({lineWidth:0});await ui.source.fill(invalid);
  await expect(ui.page.getByRole('alert').filter({hasText:'图形暂不可用'})).toBeVisible();await expect(ui.source).toHaveValue(invalid);await expect(ui.page.getByRole('button',{name:'保存并启用',exact:true})).toBeDisabled();await ui.screenshot();await ui.source.fill(saved);await ui.valid();
  // This is a transport fault, not a fulfilled synthetic service response.
  const abort=route=>route.abort('connectionrefused');await ui.page.route('**/api/v1/dashboard/request',abort);await ui.source.fill(saved+'\n# E19 local unsaved transport-failure probe\n');await expect(ui.page.getByText('连接中断。请核对原请求，不要重复提交。',{exact:true})).toBeVisible();await expect(ui.source).toHaveValue(saved+'\n# E19 local unsaved transport-failure probe\n');await ui.screenshot();await ui.page.unroute('**/api/v1/dashboard/request',abort);await ui.source.fill(saved);await ui.valid();
  run.artifact('ui-interaction-states.json',{viewports:fixed.viewports,keyboardGraphAndNavigation:true,actualNativePagination:true,loadingRequestsContinuedUnchanged:true,malformedYamlAndActualSeeCodeFallback:true,unsavedSourceRetained:true,transportFailureNotFabricatedApiResult:true,serverWritesFromUi:ui.network.filter(n=>n.request?.requestId).length});assert.equal(ui.network.filter(n=>n.request?.requestId).length,0);
  return{bothViewportsAndPages:true,keyboardAndPagination:true,loadingErrorAndGraphFallback:true};
 }finally{await ui.close();}
}

export async function executeE19(t) {
 const run=await openScenario('E19');let browser,writer;
 try{
  for(const c of run.cases)await run.collect(c,async()=>{
   assert.equal(c.caseInstanceId,'E19.journey');const cfg=run.selection.performanceConfiguration;assert.equal(cfg?.allowSyntheticInventory,true);assert.equal(cfg.permissionLossTimeoutMs,60000);assert(run.selection.principals?.empty&&run.selection.principals?.['permission-loss'],'Select real empty-project and initially valid permission-loss identities; absent fixtures cannot pass E19');
   run.artifact('fixed-performance-configuration.json',{fixed,method:{percentile:'Nearest rank: sorted[ceil(0.95*n)-1], no discarded samples',measurementViewport:fixed.viewports[0],usabilityViewports:fixed.viewports,firstSummary:'Actual browser GET start to matching snapshot DOM plus two requestAnimationFrame callbacks',eventLatency:'Native receipt timestamp written immediately before COMMIT to matching original SSE/snapshot and actual DOM paint (conservative commit bound)',timeSource:'One local machine; browser performance.timeOrigin + performance.now and native receipt ISO timestamp',inventory:'Explicitly synthetic; original installed native APIs, never real-user traffic or direct store fixtures',faults:'Deliberate transport stalls/aborts and a DOM parser outage are separate from measured performance samples'},hardware:{platform:os.platform(),arch:os.arch(),osRelease:os.release(),cpus:os.cpus().map(c=>({model:c.model,speed:c.speed})),totalMemory:os.totalmem(),freeMemory:os.freemem(),load:os.loadavg(),node:process.version}});
   assert.equal(os.platform(),'darwin');assert.equal(os.arch(),'arm64');assert.equal(process.version,'v24.14.0');const executablePath=chromium.executablePath();browser=await chromium.launch({headless:true,executablePath});run.artifact('performance-browser-identity.json',{browserVersion:browser.version(),executableSha256:sha(fs.readFileSync(executablePath)),engine:'installed Playwright Chromium; exact explicitly selected executable',headless:true,network:'selected loopback service only',clockOrCpuThrottling:false});
   const permission=await permissionChange(run,browser),empty=await emptyStates(run,browser),view=await run.read('lifecycle.definition.inspect');assert(view.active?.structurallyValid&&view.draft?.structurallyValid,'Use an already active valid project with a restorable valid draft');const yaml=await run.source(view.active.id),restore=await run.source(view.draft.id);
   const pre=await openBrowser(run,browser,{route:'/monitor',monitorEvidence:true});let baseline;
   try{baseline=await allInstances(run,pre,'before synthetic inventory');assert(baseline.instances.length>=51,'At least 51 actual native-authorized PENDING instances must be prepared independently');for(const instance of baseline.instances)assert(Object.values(instance.stages).every(stage=>stage.status==='PENDING'&&stage.attempts===0&&!stage.requestId),'Use a quiescent PENDING performance fixture; do not execute business actions');await pre.screenshot();}finally{await pre.close();}
   const start=await eventPages(run,undefined,undefined,t.signal);writer=nativeDraftWriter(run,c,t.signal);let revision=view.revision;const definitions=new Map(),receipts=[];
   try{
    for(let i=0;i<fixed.nativeEvents;i++){
     const index=i%fixed.definitionRevisions,source=yaml+'\n# E19 marked synthetic performance inventory '+run.selection.runId+' / '+index+'\n',receipt=await writer.save(source,'inventory-'+i,revision);revision=receipt.revision;
     if(definitions.has(index))assert.equal(receipt.result.revisionId,definitions.get(index));else definitions.set(index,receipt.result.revisionId);receipts.push({revision:receipt.revision,at:receipt.at,definitionRevisionId:receipt.result.revisionId});
    }
   }finally{writer.flush();}
   assert.equal(new Set(definitions.values()).size,fixed.definitionRevisions);let eventIndex=0;
   const observed=await eventPages(run,start.cursor,event=>{const receipt=receipts[eventIndex++];assert(receipt,'Unexpected extra native event or concurrent writer');assert.equal(event.type,'definition-draft-saved');assert.equal(event.revision,receipt.revision);assert.equal(event.at,receipt.at);assert.equal(event.data.revisionId,receipt.definitionRevisionId);assert.equal(event.data.executionAuthorized,false);assert.equal(event.data.releaseAuthorized,false);},t.signal);assert.equal(observed.count,fixed.nativeEvents);
   // The second through tenth cycles read the original immutable revisions via
   // the native snapshot path. These explicit reads also retain their summaries.
   for(const index of [0,499,999]){const saved=await run.read('lifecycle.definition.read',{revisionId:definitions.get(index)});assert.equal(saved.id,definitions.get(index));assert(saved.structurallyValid);}
   run.artifact('native-synthetic-inventory.json',{uniqueDefinitionRevisions:definitions.size,originalCommittedEvents:observed.count,firstRevision:receipts[0].revision,lastRevision:revision,definitions:[...definitions],originalReceiptAndEventTimesMatched:true,allRequestsAndResponsesRetained:true,originalActiveId:view.active.id,realUserTraffic:false,executionOrReleaseDispatched:false});
   const restored=await writer.save(restore,'restore-draft-after-inventory',revision);revision=restored.revision;writer.flush();assert.equal((await run.read('lifecycle.definition.inspect')).active.id,view.active.id);
   run.artifact('performance-measurement-start.json',{at:new Date().toISOString(),freeMemory:os.freemem(),load:os.loadavg(),baseInventoryEvents:fixed.nativeEvents,baseInventoryRevisions:definitions.size,additionalMeasurementDraftWrites:fixed.samples,restorationWrites:2,syntheticFixtureInstances:baseline.instances.length});
   const summaries=[];
   for(let i=0;i<fixed.samples;i++){
    t.signal.throwIfAborted();
    const ui=await openBrowser(run,browser,{route:'/monitor',monitorEvidence:true,performanceEvidence:true});
    try{const row=await firstPaint(ui);assert(row.revision>=revision);const sample={sample:i,...row,durationMs:row.paintAt-row.firstRequestStartedAt};summaries.push(sample);run.artifact('first-summary-raw-timing.json',sample);await ui.screenshot();}finally{await ui.close();}
   }
   const live=await openBrowser(run,browser,{route:'/monitor',monitorEvidence:true,performanceEvidence:true}),latencies=[];let disconnect;
   try{
    await firstPaint(live);await expect(live.page.locator('.connection.online')).toBeVisible();
    for(let i=0;i<fixed.samples;i++){
     const before=stamp();
     const receipt=await writer.save(restore+'\n# E19 marked synthetic event-latency sample '+i+'\n','latency-'+i,revision);revision=receipt.revision;writer.flush();
     await expect.poll(()=>live.sseFrames.some(f=>f.eventName==='events'&&JSON.parse(f.data).events.some(e=>e.revision===receipt.revision&&e.at===receipt.at)),{timeout:15000}).toBe(true);
     await expect.poll(async()=>{const rows=await snapshots(live);return rows.some(r=>r.revision===receipt.revision&&r.paintAt!==null&&r.startedAt>=before.wall-100);},{timeout:15000}).toBe(true);
     const row=(await snapshots(live)).find(r=>r.revision===receipt.revision&&r.paintAt!==null&&r.startedAt>=before.wall-100);stableClock(before,stamp());exactPaint(row);const durationMs=row.paintAt-Date.parse(receipt.at);assert(durationMs>=0);const sample={sample:i,receipt,actualBrowserSnapshot:row,durationMs};latencies.push(sample);run.artifact('event-to-page-raw-timing.json',sample);
    }
    await live.flush();const before=stamp();run.artifact('monitor-disconnect-start.json',{...before,method:'Actual browser context offline transport; no fake response or EventSource',thresholdMs:fixed.disconnectMs});await live.context.setOffline(true);
    try{await expect(live.page.locator('.connection.offline')).toBeVisible({timeout:fixed.disconnectMs});await expect(live.page.locator('.monitor-strip')).toContainText('实时连接中断');const after=stamp();stableClock(before,after);disconnect={started:before,observed:after,durationMs:after.monotonic-before.monotonic};assert(disconnect.durationMs<=fixed.disconnectMs);await expect(live.page.getByRole('alert')).toContainText('Runtime 服务暂时无法连接');await live.screenshot();await expect(live.page.getByLabel('生命周期实例',{exact:true})).toBeVisible();await expect(live.source).toHaveCount(0);}
    finally{await live.context.setOffline(false);}
    await expect(live.page.locator('.connection.online')).toBeVisible({timeout:15000});const final=await allInstances(run,live,'after all performance samples');assert.deepEqual(final.instances,baseline.instances);
    for(const row of live.monitorNetwork){if(row.status!==200)continue;assert(Buffer.byteLength(row.rawBody)<=fixed.pageBytes);shape(JSON.parse(row.rawBody).result,run.selection.projectId);}assert.equal(live.network.filter(n=>n.request?.operation==='lifecycle.definition.source.read').length,0);
   }finally{await live.close();}
   const finalRestore=await writer.save(restore,'restore-draft-after-measurement',revision);revision=finalRestore.revision;writer.flush();const interactions=await interactionStates(run,browser,restore);const after=await run.read('lifecycle.definition.inspect');assert.equal(after.revision,revision);assert.equal(after.active.id,view.active.id);assert.equal(await run.source(after.draft.id),restore);
   const result={summaryP95Ms:p95(summaries.map(s=>s.durationMs)),eventP95Ms:p95(latencies.map(s=>s.durationMs)),disconnect,permission,empty,interactions,thresholds:fixed,inventory:{revisions:definitions.size,events:observed.count},originalActiveAndDraftPreserved:true};run.artifact('fixed-performance-result.json',result);
   assert(result.summaryP95Ms<=fixed.summaryP95Ms,'First summary p95 exceeded the fixed 2 second threshold');assert(result.eventP95Ms<=fixed.eventP95Ms,'Committed event to page p95 exceeded the fixed 5 second threshold');assert(disconnect.durationMs<=fixed.disconnectMs);return result;
  });
 }finally{writer?.flush();await browser?.close();run.finish();}
}
if(process.argv[1]&&collectorPathToFileURL(collectorResolve(process.argv[1])).href===import.meta.url)test('E19 installed browser performance and usability with native synthetic inventory',{timeout:1800000},executeE19);
