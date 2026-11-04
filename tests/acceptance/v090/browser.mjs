// Actual installed-browser evidence; no synthetic service/store, auth headers,
// cookies, CSRF values, session bodies or one-use codes enter retained traces.
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {expect} from '@playwright/test';

const dashboardReads=new Set(['runtime.status','runtime.receipt.read','lifecycle.base.inspect','lifecycle.definition.inspect','lifecycle.definition.read','lifecycle.definition.source.read','lifecycle.definition.validate']);

export async function openBrowser(run,browser,{route='/lifecycle',viewport={width:1440,height:1000},principalAlias='default',monitorEvidence=false,performanceEvidence=false}={}){
 const selected=run.principal(principalAlias),context=await browser.newContext({viewport,reducedMotion:'reduce'}),page=await context.newPage(),network=[],monitorNetwork=[],monitorReadbacks=[],sseFrames=[],errors=[],actions=[],pending=new Set(),external=[];
 let bytes=0,closed=false,session,cdp;
 // APIRequestContext failures can include request headers (Cookie/CSRF).
 // Discard the original exception, including its message/cause, at this edge.
 const safeHttp=async(operation,route,action)=>{try{return await action();}catch{throw Error('BROWSER_HTTP_FAILURE: '+operation+' '+route);}};
 context.setDefaultTimeout(10000);context.setDefaultNavigationTimeout(15000);
 // CDP may discard a completed fetch body when a superseded browser read is
 // cancelled. Keep a bounded, read-only clone of that SAME response in its
 // renderer. It never fetches, retries, fulfills or changes the returned Promise.
 // Session/code/logout routes and security headers are deliberately excluded.
 await page.addInitScript(()=>{
  const rows=[],faults=[],original=window.fetch.bind(window),clock=()=>performance.timeOrigin+performance.now();let totalBytes=0;
  const allowed=new Set(['runtime.status','runtime.receipt.read','lifecycle.base.inspect','lifecycle.definition.inspect','lifecycle.definition.read','lifecycle.definition.source.read','lifecycle.definition.validate','lifecycle.draft.save','lifecycle.definition.save-and-activate']);
  Object.defineProperty(window,'__runtimeDashboardMirror',{value:{rows,faults},configurable:false});
  window.fetch=function(input,init){
   let row;
   try{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href),method=(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase();
    if(url.origin===location.origin&&url.pathname==='/api/v1/dashboard/request'&&!url.search&&method==='POST'){
     if(rows.length>=256)throw Error();const body=init?.body;if(typeof body!=='string'||new TextEncoder().encode(body).length>262144)throw Error();
     const envelope=JSON.parse(body);if(!envelope||!allowed.has(envelope.operation)||!Object.keys(envelope).every(k=>['operation','projectId','input','requestId','expectedRevision'].includes(k)))throw Error();
     row={url:url.href,method,request:envelope,startedEpochMs:clock(),headersEpochMs:null,completedEpochMs:null,status:null,responseRequestId:null,phase:'REQUEST_OBSERVED',rawBody:null,responseBytes:null,responseSha256:null};rows.push(row);
    }
   }catch{faults.push('DASHBOARD_MIRROR_REQUEST_NOT_CAPTURED');}
   const result=original(input,init);
   if(row)void result.then(async response=>{
    let reader,timer;
    try{
     row.headersEpochMs=clock();row.status=response.status;row.responseRequestId=response.headers.get('x-request-id');row.phase='HEADERS_OBSERVED';
     if(response.url!==row.url||!response.headers.get('content-type')?.startsWith('application/json')||!/^[-a-f0-9]{36}$/.test(row.responseRequestId??''))throw Error();
     reader=response.clone().body?.getReader();if(!reader)throw Error();const chunks=[];let size=0;const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error()),10000);});
     for(;;){const part=await Promise.race([reader.read(),deadline]);if(part.done)break;size+=part.value.length;totalBytes+=part.value.length;if(size>262144||totalBytes>8388608)throw Error();chunks.push(part.value);}
     const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
     const rawBody=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),body=JSON.parse(rawBody);if(body.requestId!==row.responseRequestId)throw Error();
     row.rawBody=rawBody;row.responseBytes=size;row.responseSha256=Array.from(new Uint8Array(await Promise.race([crypto.subtle.digest('SHA-256',bytes),deadline])),b=>b.toString(16).padStart(2,'0')).join('');row.completedEpochMs=clock();row.phase='COMPLETE';
    }catch{if(reader)void reader.cancel().catch(()=>{});row.phase='INCOMPLETE';row.completedEpochMs=clock();faults.push('DASHBOARD_MIRROR_BODY_INCOMPLETE');}
    finally{clearTimeout(timer);reader?.releaseLock();}
   },()=>{row.phase='TRANSPORT_FAILED';row.completedEpochMs=clock();});
   return result;
  };
 });
 if(performanceEvidence){
  assert(monitorEvidence,'Performance observations require original HTTP/SSE evidence');
  // Observe the actual fetch and DOM without changing its response, application
  // state or clock. Match the rendered state's exact project/revision/ISO time
  // through two animation frames; a formatted second is not snapshot identity.
  // Only public monitor metadata is recorded; no session, headers or YAML.
  await page.addInitScript(()=>{
   const samples=[],faults=[],epoch=()=>performance.timeOrigin+performance.now(),original=window.fetch.bind(window);
   Object.defineProperty(window,'__runtimeMonitorPerformance',{value:{samples,faults,timeOrigin:performance.timeOrigin},configurable:false});
   const inspect=()=>{
    for(const row of samples){
     if(row.paintAt!==null||!row.ready||row.checking||row.status!==200)continue;
     const identity=()=>{const strip=document.querySelector('.monitor-strip');return strip&&strip.getClientRects().length?{projectId:strip.getAttribute('data-project-id'),revision:strip.getAttribute('data-snapshot-revision'),observedAt:strip.getAttribute('data-snapshot-observed-at')}:null;};
     const matches=()=>{const rendered=identity(),options=[...document.querySelectorAll('#instance option')].map(n=>n.value);return rendered?.projectId===row.projectId&&rendered.revision===String(row.revision)&&rendered.observedAt===row.observedAt&&row.instanceIds.every(id=>options.includes(id))&&(row.instanceIds.length>0||!!document.querySelector('.panel.empty'));};
     if(!matches())continue;
     row.checking=true;row.domAt=epoch();requestAnimationFrame(()=>{if(!matches()){row.checking=false;return;}requestAnimationFrame(()=>{if(matches()){row.paintAt=epoch();row.renderedSnapshot=identity();}row.checking=false;});});
    }
   };
   new MutationObserver(inspect).observe(document,{subtree:true,childList:true,characterData:true,attributes:true});
   window.fetch=function(input,init){
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
    if(url.origin!==location.origin||url.pathname!=='/api/v1/dashboard/monitor')return original(input,init);
    if(samples.length>=256){faults.push('MONITOR_OBSERVATION_LIMIT');return original(input,init);}
    const row={index:samples.length,path:url.pathname,query:Object.fromEntries(url.searchParams),startedAt:epoch(),status:null,bodyAt:null,bytes:null,projectId:null,revision:null,observedAt:null,instanceIds:[],ready:false,checking:false,domAt:null,paintAt:null,renderedSnapshot:null,transport:'PENDING'};samples.push(row);
    const response=original(input,init);
    void response.then(async value=>{
     row.status=value.status;const reader=value.clone().body?.getReader(),chunks=[];let size=0;
     try{if(!reader)throw Error();for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>262144)throw Error();chunks.push(item.value);}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}row.bytes=size;row.bodyAt=epoch();row.transport='RESPONSE_OBSERVED';
      if(value.status!==200)return;const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)).result;
      if(!data||!Number.isSafeInteger(data.revision)||typeof data.observedAt!=='string'||!Array.isArray(data.instances))throw Error();
      row.projectId=data.projectId;row.revision=data.revision;row.observedAt=data.observedAt;row.instanceIds=data.instances.map(i=>i.id);row.ready=true;inspect();
     }catch{row.transport='OBSERVATION_INCOMPLETE';faults.push('MONITOR_RESPONSE_OBSERVATION_INCOMPLETE');}
     finally{reader?.releaseLock();}
    },()=>{row.transport='TRANSPORT_FAILED';});
    return response;
   };
  });
 }
 const captures=new Map(),terminals=new WeakMap();
 const unfinished=()=>[...captures.values()].map(c=>({...c}));
 const bounded=async(promise,milliseconds,label)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>{run.artifact('browser-evidence-timeout.json',{label,milliseconds,pending:unfinished(),outcome:'INCOMPLETE_EVIDENCE_NOT_PASS'});reject(Error('BROWSER_EVIDENCE_TIMEOUT: '+label));},milliseconds);})]);}finally{clearTimeout(timer);}};
 page.on('requestfailed',request=>terminals.set(request,{phase:'FAILED',failure:request.failure()}));
 page.on('requestfinished',request=>terminals.set(request,{phase:'FINISHED',failure:request.failure()}));
 const terminal=async request=>{
  if(terminals.has(request))return terminals.get(request);
  if(request.failure())return{phase:'FAILED',failure:request.failure()};
  let done,handler;const observed=new Promise(resolve=>{done=resolve;handler=r=>{if(r===request)resolve(terminals.get(r));};page.on('requestfailed',handler);page.on('requestfinished',handler);});
  try{return await bounded(observed,1000,'read-request-terminal');}catch{return{phase:'UNOBSERVED',failure:request.failure()};}
  finally{page.off('requestfailed',handler);page.off('requestfinished',handler);done(null);}
 };
 const account=raw=>{bytes+=Buffer.byteLength(raw);assert(bytes<=8388608,'Per-case browser evidence exceeds 8 MiB bound');};
 const exactMirror=async(response,envelope,url)=>{
  const id=await response.headerValue('x-request-id');if(!/^[-a-f0-9]{36}$/.test(id??''))return null;
  try{await page.waitForFunction(id=>window.__runtimeDashboardMirror?.rows.some(r=>r.responseRequestId===id&&['COMPLETE','INCOMPLETE','TRANSPORT_FAILED'].includes(r.phase)),id,{timeout:2000});}catch{return null;}
  const matches=await bounded(page.evaluate(id=>window.__runtimeDashboardMirror?.rows.filter(r=>r.responseRequestId===id)??[],id),2000,'exact-fetch-mirror');
  assert(matches.length<=1,'A response correlation identity may not match multiple browser fetches');const mirror=matches[0];if(!mirror||mirror.phase!=='COMPLETE')return null;
  assert.equal(mirror.url,url.href);assert.equal(mirror.method,response.request().method());assert.deepEqual(mirror.request,envelope);assert.equal(mirror.status,response.status());assert.equal(JSON.parse(mirror.rawBody).requestId,id);assert.equal(mirror.responseBytes,Buffer.byteLength(mirror.rawBody));assert(mirror.responseBytes<=262144);assert.equal(createHash('sha256').update(mirror.rawBody).digest('hex'),mirror.responseSha256);assert(mirror.startedEpochMs<=mirror.headersEpochMs&&mirror.headersEpochMs<=mirror.completedEpochMs);return mirror;
 };
 page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>{if(new URL(request.url()).origin!==run.serviceOrigin)external.push({url:request.url(),method:request.method()});});
 const listener=response=>{
  const url=new URL(response.url());if(url.origin!==run.serviceOrigin||!['/api/v1/dashboard/request',...(monitorEvidence?['/api/v1/dashboard/monitor']:[])].includes(url.pathname))return;
  const captureId=Symbol('response'),request=response.request(),envelope=request.method()==='POST'?request.postDataJSON():null;
  captures.set(captureId,{operation:envelope?.operation??'monitor.read',requestId:envelope?.requestId??null,path:url.pathname,phase:'BODY_PENDING',startedAt:new Date().toISOString()});
  const task=(async()=>{
   const row={at:new Date().toISOString(),method:request.method(),path:url.pathname,query:Object.fromEntries(url.searchParams),request:envelope,status:response.status()};
   try{const raw=await bounded(response.text(),10000,'response-body:'+String(envelope?.operation??'monitor.read'));account(raw);(url.pathname.endsWith('/monitor')?monitorNetwork:network).push({...row,transportOutcome:'RESPONSE_RETAINED',rawBody:raw});}
   catch(error){
    // A proven cancellation of a known pure Dashboard read is transport
    // evidence only; do not infer why it was cancelled or count it as success.
    captures.get(captureId).phase='TERMINAL_INSPECTION';
    // Playwright's response.finished() only resolves on requestfinished, not
    // requestfailed. Awaiting it after an aborted read deadlocks drain/close.
    const state=await terminal(request),failure=state.failure,cancelled=state.phase==='FAILED'&&/ERR_ABORTED|cancelled|canceled/i.test(failure?.errorText??'');
    const observed={...row,transportOutcome:'BODY_UNAVAILABLE',rawBody:null,terminal:state,failure,bodyError:error.message};
    const mirror=url.pathname==='/api/v1/dashboard/request'?await exactMirror(response,envelope,url):null;
    if(mirror){account(mirror.rawBody);network.push({...observed,transportOutcome:'RESPONSE_RETAINED',rawBody:mirror.rawBody,bodyProvenance:{source:'EXACT_BROWSER_FETCH_RESPONSE_CLONE',responseRequestId:mirror.responseRequestId,responseBytes:mirror.responseBytes,responseSha256:mirror.responseSha256,startedEpochMs:mirror.startedEpochMs,headersEpochMs:mirror.headersEpochMs,completedEpochMs:mirror.completedEpochMs,requestEnvelopeMatched:true,urlMethodStatusMatched:true,additionalNetworkRequests:0},cdpTransportOutcome:cancelled?(dashboardReads.has(envelope?.operation)?'ABORTED_READ':'ABORTED'):'BODY_UNAVAILABLE'});return;}
    if(dashboardReads.has(envelope?.operation)&&!Object.hasOwn(envelope,'requestId')&&cancelled){network.push({...observed,transportOutcome:'ABORTED_READ'});return;}
    network.push(observed);throw error;
   }
  })();pending.add(task);task.then(()=>{pending.delete(task);captures.delete(captureId);},error=>{errors.push(error.message);pending.delete(task);captures.delete(captureId);});
 };
 page.on('response',listener);
 if(monitorEvidence){
  cdp=await context.newCDPSession(page);const streams=new Map();
  cdp.on('Network.requestWillBeSent',event=>{const url=new URL(event.request.url);if(url.origin===run.serviceOrigin&&url.pathname==='/api/v1/dashboard/events')streams.set(event.requestId,{path:url.pathname,cursor:url.searchParams.get('cursor')});});
  cdp.on('Network.eventSourceMessageReceived',event=>{if(!streams.has(event.requestId))return;try{account(event.data);sseFrames.push({requestId:event.requestId,monotonicTime:event.timestamp,eventName:event.eventName,eventId:event.eventId,data:event.data,request:streams.get(event.requestId)});}catch(error){errors.push(error.message);}});
  await cdp.send('Network.enable');
 }
 const drain=()=>bounded((async()=>{while(pending.size)await Promise.all([...pending]);assert.deepEqual(errors,[]);})(),15000,'finite-response-drain');
 const step=async(action,fn)=>{const row={action,startedAt:new Date().toISOString(),status:'STARTED'};actions.push(row);try{const value=await fn();row.status='COMPLETED';return value;}catch(error){row.status='FAILED';row.error=error.message;throw error;}finally{row.finishedAt=new Date().toISOString();}};
 const login=async(route='/lifecycle')=>step('Open installed '+route+' with a one-use project connection',async()=>{
  await drain();await page.goto(run.serviceOrigin+route);
  const code=page.getByLabel('一次性连接码'),heading=page.getByRole('heading',{name:route==='/lifecycle'?'生命周期定义':'生命周期监控',exact:true});
  await expect(code.or(heading).first()).toBeVisible({timeout:10000});
  if(await code.isVisible()){
   const value=await run.browserCode(principalAlias);
   try{await code.fill(value);await page.getByRole('button',{name:'连接项目',exact:true}).click();}
   catch{throw Error('BROWSER_CONNECTION_EXCHANGE_FAILED: /api/v1/dashboard/session');}
  }
  await expect(heading).toBeVisible({timeout:10000});
  const observed=await safeHttp('session.read','/api/v1/dashboard/session',async()=>{const response=await context.request.get(run.serviceOrigin+'/api/v1/dashboard/session',{timeout:10000});return{status:response.status(),body:await response.json()};});assert.equal(observed.status,200);session=observed.body.result;
  assert.equal(session.serviceId,run.candidate.serviceId);assert.equal(session.projectId,selected.projectId);assert.equal(session.workspaceId,run.selection.workspaceId);assert.equal(session.principalId,selected.principalId);
  assert.deepEqual([...session.permissions].sort(),selected.expectedPermissions.filter(p=>['read','draft.write','definition.activate'].includes(p)).sort());
 });
 const source=page.getByLabel('Project Lifecycle YAML');
 const valid=()=>expect(page.getByText('图形已与当前源码结构核对',{exact:false})).toBeVisible();
 const retained=async(operation,since)=>{const yaml=await source.inputValue();await expect.poll(async()=>{await drain();return network.slice(since).some(n=>n.request?.operation===operation&&n.request.input.yaml===yaml&&n.status===200&&n.transportOutcome==='RESPONSE_RETAINED');},{message:'The UI-consumed exact request needs its original complete response: '+operation,timeout:10000}).toBe(true);};
 const save=()=>step('Save exact YAML draft from the current page',async()=>{const since=network.length;await page.getByRole('button',{name:'保存草稿',exact:true}).click();await expect(page.getByText('草稿已保存。',{exact:true})).toBeVisible();await expect(source).toBeEditable();await retained('lifecycle.draft.save',since);});
 const preview=()=>step('Validate exact YAML and display its active-definition diff',async()=>{const since=network.length;await page.getByRole('button',{name:'校验与差异预览',exact:true}).click();await expect(page.getByRole('heading',{name:'与当前生效版本的准确差异'})).toBeVisible();await retained('lifecycle.definition.validate',since);});
 const activate=()=>step('Activate the exact preview in the same browser page',async()=>{const since=network.length;await expect(page.getByRole('button',{name:'保存并启用',exact:true})).toBeEnabled();await page.getByRole('button',{name:'保存并启用',exact:true}).click();await expect(page.getByText('已启用此精确定义。既有实例继续使用原版本。',{exact:true})).toBeVisible();await expect(source).toBeEditable();await retained('lifecycle.definition.save-and-activate',since);});
 const screenshot=async()=>run.imageArtifact(await page.screenshot({fullPage:true,mask:[page.getByLabel('一次性连接码')],timeout:5000}));
 const monitor=async(input={})=>{assert(Object.keys(input).every(k=>['after','revision'].includes(k)));const query=new URLSearchParams(Object.entries(input).map(([k,v])=>[k,String(v)])),observed=await safeHttp('monitor.read','/api/v1/dashboard/monitor',async()=>{const response=await context.request.get(run.serviceOrigin+'/api/v1/dashboard/monitor'+(query.size?'?'+query:''),{timeout:10000});const rawBody=await response.text();assert(Buffer.byteLength(rawBody)<=262144);return{status:response.status(),body:JSON.parse(rawBody),rawBody,bytes:Buffer.byteLength(rawBody),query:Object.fromEntries(query)};});run.artifact('browser-monitor-readback.json',observed);assert.equal(observed.status,200);monitorReadbacks.push(observed);return observed.body.result;};
 const performanceReadback=async()=>{assert(performanceEvidence,'Select explicit read-only performance observation');return page.evaluate(()=>{const observed=window.__runtimeMonitorPerformance;return{timeOrigin:observed.timeOrigin,samples:observed.samples.map(({checking,...row})=>row),faults:[...observed.faults]};});};
 const sessionRequest=async(operation,input={},meta={},options={})=>{
  assert(Object.keys(options).every(k=>['csrf','origin','projectId'].includes(k)));assert(['valid','missing','invalid'].includes(options.csrf??'valid'));assert(['valid','missing','invalid'].includes(options.origin??'valid'));
  const envelope={operation,projectId:options.projectId??session.projectId,input,...meta};assert(Buffer.byteLength(JSON.stringify(envelope))<=524288,'Bound the explicit browser negative probe');
  const headers={'content-type':'application/json'};if(options.origin!=='missing')headers.origin=options.origin==='invalid'?'https://invalid-origin.example':run.serviceOrigin;if(options.csrf!=='missing')headers['x-runtime-csrf']=options.csrf==='invalid'?'synthetic-invalid-csrf':session.csrf;
  const observed=await safeHttp('session.request','/api/v1/dashboard/request',async()=>{const response=await context.request.post(run.serviceOrigin+'/api/v1/dashboard/request',{headers,data:envelope,timeout:30000,maxRedirects:0});const raw=await response.text();return{status:response.status(),raw,body:JSON.parse(raw)};});account(observed.raw);
  run.artifact('browser-explicit-request.json',{principal:selected,request:envelope,proofs:{origin:options.origin??'valid',csrf:options.csrf??'valid'},status:observed.status,rawBody:observed.raw,entry:'ACTUAL_SESSION_REQUEST_WITH_SELECTED_PROOFS_NOT_UI_CLICK'});return{status:observed.status,body:observed.body};
 };
 const restart=async()=>{
  assert.equal(run.selection.browserConfiguration?.allowServiceRestart,true,'This case requires explicit isolated service restart selection');await drain();
  const installed=await import(pathToFileURL(path.join(run.selection.installedRoot,'package/dist/installation/service-control.js')).href),selection=installed.inspectInstalledServiceSelection(run.selection.installedRoot);
  assert.equal(selection.serviceRoot,run.selection.installedRoot);assert.equal(selection.serviceId,run.candidate.serviceId);assert.equal(selection.distributionManifestDigest,run.candidate.manifestDigest);run.artifact('browser-current-service-selection.json',{selection,entry:'EXACT_INSTALLED_CURRENT_SERVICE_SELECTION'});
  for(const command of ['stop','start']){const result=await installed.operateInstalledService(selection,command);run.artifact('browser-installed-restart.json',{command,result,entry:'EXACT_INSTALLED_NATIVE_SERVICE_CONTROL'});}await login('/lifecycle');
 };
 const flush=async()=>{await drain();assert.deepEqual(external,[]);};
 const close=async()=>{
  if(closed)return;closed=true;page.off('response',listener);let failure;
  try{await drain();}catch(error){failure=error;}
  try{await screenshot();}catch(error){failure??=error;errors.push('Final screenshot: '+error.message);}
  let performanceObservation;
  if(performanceEvidence)try{performanceObservation=await bounded(performanceReadback(),3000,'performance-observation');}catch(error){failure??=error;}
  run.artifact('installed-browser-trace.json',{browserVersion:browser.version(),viewport,principal:selected,actions,network,monitorNetwork,sseFrames,...(performanceEvidence?{performanceObservation}:{}),errors,external,pending:unfinished(),recording:'Actual browser responses and CDP EventSource frames; no authorization, cookies, session bodies or one-use codes'});
  try{if(cdp)await bounded(cdp.detach(),3000,'detach-cdp');}catch(error){failure??=error;}
  try{await bounded(context.close(),5000,'close-browser-context');}catch(error){failure??=error;}
  if(failure)throw failure;
 };
 try{await login(route);}catch(error){await close();throw error;}
 return{page,context,network,monitorNetwork,monitorReadbacks,sseFrames,errors,source,node:id=>page.locator('[data-sc-node="'+id+'"]'),step,login,valid,save,preview,activate,screenshot,monitor,performanceReadback,sessionRequest,restart,flush,close};
}
