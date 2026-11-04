// Actual installed-browser collector support. Never create a synthetic service
// or write its store. Retain sanitized action/network evidence, not auth traces.
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {expect} from '@playwright/test';

export async function openBrowser(run,browser,{route='/lifecycle',viewport={width:1440,height:1000}}={}){
 const context=await browser.newContext({viewport,reducedMotion:'reduce'}),page=await context.newPage(),network=[],errors=[],actions=[],pending=new Set(),external=[];
 let bytes=0,closed=false;
 page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>{if(new URL(request.url()).origin!==run.serviceOrigin)external.push({url:request.url(),method:request.method()});});
 const listener=response=>{
  const url=new URL(response.url());if(url.origin!==run.serviceOrigin||url.pathname!=='/api/v1/dashboard/request')return;
  const task=(async()=>{const request=response.request(),raw=await response.text();bytes+=Buffer.byteLength(raw);assert(bytes<=8388608,'Per-case browser evidence exceeds 8 MiB bound');network.push({at:new Date().toISOString(),method:request.method(),path:url.pathname,request:request.postDataJSON(),status:response.status(),rawBody:raw});})();pending.add(task);task.then(()=>pending.delete(task),error=>{errors.push(error.message);pending.delete(task);});
 };
 page.on('response',listener);
 const step=async(action,fn)=>{const row={action,startedAt:new Date().toISOString(),status:'STARTED'};actions.push(row);try{const value=await fn();row.status='COMPLETED';return value;}catch(error){row.status='FAILED';row.error=error.message;throw error;}finally{row.finishedAt=new Date().toISOString();}};
 const login=async(route='/lifecycle')=>step('Open installed '+route+' with a one-use project connection',async()=>{
  await page.goto(run.serviceOrigin+route);
  const code=page.getByLabel('一次性连接码'),heading=page.getByRole('heading',{name:route==='/lifecycle'?'生命周期定义':'生命周期监控',exact:true});
  // Navigation completing does not mean React has hydrated or restored its
  // browser session. Wait for one actual rendered state before branching.
  await expect(code.or(heading).first()).toBeVisible({timeout:10000});
  if(await code.isVisible()){await code.fill(await run.browserCode());await page.getByRole('button',{name:'连接项目',exact:true}).click();}
  await expect(heading).toBeVisible({timeout:10000});
  const response=await context.request.get(run.serviceOrigin+'/api/v1/dashboard/session');assert.equal(response.status(),200);const session=(await response.json()).result;
  assert.equal(session.serviceId,run.candidate.serviceId);assert.equal(session.projectId,run.selection.projectId);assert.equal(session.workspaceId,run.selection.workspaceId);
 });
 const source=page.getByLabel('Project Lifecycle YAML');
 const valid=()=>expect(page.getByText('图形已与当前源码结构核对',{exact:false})).toBeVisible();
 const save=()=>step('Save exact YAML draft from the current page',async()=>{await page.getByRole('button',{name:'保存草稿',exact:true}).click();await expect(page.getByText('草稿已保存。',{exact:true})).toBeVisible();await expect(source).toBeEditable();});
 const preview=()=>step('Validate exact YAML and display its active-definition diff',async()=>{await page.getByRole('button',{name:'校验与差异预览',exact:true}).click();await expect(page.getByRole('heading',{name:'与当前生效版本的准确差异'})).toBeVisible();});
 const activate=()=>step('Activate the exact preview in the same browser page',async()=>{await expect(page.getByRole('button',{name:'保存并启用',exact:true})).toBeEnabled();await page.getByRole('button',{name:'保存并启用',exact:true}).click();await expect(page.getByText('已启用此精确定义。既有实例继续使用原版本。',{exact:true})).toBeVisible();await expect(source).toBeEditable();});
 const screenshot=async()=>run.imageArtifact(await page.screenshot({fullPage:true,mask:[page.getByLabel('一次性连接码')]}));
 const monitor=async()=>{const r=await context.request.get(run.serviceOrigin+'/api/v1/dashboard/monitor');assert.equal(r.status(),200);const body=await r.json();run.artifact('browser-monitor-readback.json',{status:r.status(),body});return body.result;};
 const restart=async()=>{
  assert.equal(run.selection.browserConfiguration?.allowServiceRestart,true,'This case requires explicit isolated service restart selection');
  const installed=await import(pathToFileURL(path.join(run.selection.installedRoot,'package/dist/installation/service-control.js')).href),selection=installed.inspectInstalledServiceSelection(run.selection.installedRoot);
  assert.equal(selection.serviceRoot,run.selection.installedRoot);assert.equal(selection.serviceId,run.candidate.serviceId);assert.equal(selection.distributionManifestDigest,run.candidate.manifestDigest);
  run.artifact('browser-current-service-selection.json',{selection,entry:'EXACT_INSTALLED_CURRENT_SERVICE_SELECTION'});
  for(const command of ['stop','start']){const result=await installed.operateInstalledService(selection,command);run.artifact('browser-installed-restart.json',{command,result,entry:'EXACT_INSTALLED_NATIVE_SERVICE_CONTROL'});}
  await login('/lifecycle');
 };
 const flush=async()=>{await Promise.all([...pending]);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);};
 const close=async()=>{
  if(closed)return;closed=true;
  try{await Promise.allSettled([...pending]);await screenshot();}
  finally{page.off('response',listener);run.artifact('installed-browser-trace.json',{browserVersion:browser.version(),viewport,actions,network,errors,external,recording:'Actual browser actions and original request/response bodies; excludes authorization, cookies, session response and one-use codes'});await context.close();}
 };
 try{await login(route);}catch(error){await close();throw error;}
 return{page,context,network,errors,source,node:id=>page.locator('[data-sc-node="'+id+'"]'),step,login,valid,save,preview,activate,screenshot,monitor,restart,flush,close};
}
