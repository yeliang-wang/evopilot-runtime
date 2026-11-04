// Actual installed-browser evidence; no synthetic service/store, auth headers,
// cookies, CSRF values, session bodies or one-use codes enter retained traces.
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {expect} from '@playwright/test';

const dashboardReads=new Set(['runtime.status','runtime.receipt.read','lifecycle.base.inspect','lifecycle.definition.inspect','lifecycle.definition.read','lifecycle.definition.source.read','lifecycle.definition.validate']);

export async function openBrowser(run,browser,{route='/lifecycle',viewport={width:1440,height:1000},principalAlias='default',monitorEvidence=false}={}){
 const selected=run.principal(principalAlias),context=await browser.newContext({viewport,reducedMotion:'reduce'}),page=await context.newPage(),network=[],monitorNetwork=[],sseFrames=[],errors=[],actions=[],pending=new Set(),external=[];
 let bytes=0,closed=false,session,cdp;
 // APIRequestContext failures can include request headers (Cookie/CSRF).
 // Discard the original exception, including its message/cause, at this edge.
 const safeHttp=async(operation,route,action)=>{try{return await action();}catch{throw Error('BROWSER_HTTP_FAILURE: '+operation+' '+route);}};
 context.setDefaultTimeout(10000);context.setDefaultNavigationTimeout(15000);
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
 const monitor=async(input={})=>{assert(Object.keys(input).every(k=>['after','revision'].includes(k)));const query=new URLSearchParams(Object.entries(input).map(([k,v])=>[k,String(v)])),observed=await safeHttp('monitor.read','/api/v1/dashboard/monitor',async()=>{const response=await context.request.get(run.serviceOrigin+'/api/v1/dashboard/monitor'+(query.size?'?'+query:''),{timeout:10000});return{status:response.status(),body:await response.json()};});assert.equal(observed.status,200);run.artifact('browser-monitor-readback.json',observed);return observed.body.result;};
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
  run.artifact('installed-browser-trace.json',{browserVersion:browser.version(),viewport,principal:selected,actions,network,monitorNetwork,sseFrames,errors,external,pending:unfinished(),recording:'Actual browser responses and CDP EventSource frames; no authorization, cookies, session bodies or one-use codes'});
  try{if(cdp)await bounded(cdp.detach(),3000,'detach-cdp');}catch(error){failure??=error;}
  try{await bounded(context.close(),5000,'close-browser-context');}catch(error){failure??=error;}
  if(failure)throw failure;
 };
 try{await login(route);}catch(error){await close();throw error;}
 return{page,context,network,monitorNetwork,sseFrames,errors,source,node:id=>page.locator('[data-sc-node="'+id+'"]'),step,login,valid,save,preview,activate,screenshot,monitor,sessionRequest,restart,flush,close};
}
