import {pathToFileURL as collectorPathToFileURL} from 'node:url';
import {resolve as collectorResolve} from 'node:path';
// Real installed HTTP/browser boundary observations. Synthetic negative input is
// labeled; unavailable revocation timing is never inferred from a different test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {parse,parseDocument} from 'yaml';
import {chromium,expect} from '@playwright/test';
import {openScenario,repository,sha} from './support.mjs';
import {openBrowser} from './browser.mjs';

const withValue=(source,keys,value)=>{const document=parseDocument(source);assert.equal(document.errors.length,0);if(value===undefined)document.deleteIn(keys);else document.setIn(keys,value);return document.toString({lineWidth:0});};
const permissions={monitor:['read'],editor:['read','draft.write'],activator:['read','draft.write','definition.activate']};
function identity(run,alias){const value=run.principal(alias);assert.deepEqual([...value.expectedPermissions].sort(),[...permissions[alias]].sort());assert.equal(value.projectId,run.selection.projectId);return value;}
function denied(response,codes){assert([400,401,403,413].includes(response.status),'Security probe must receive a definite client rejection');assert(response.body?.error&&codes.includes(response.body.error.code),JSON.stringify({status:response.status,error:response.body?.error}));assert(!Object.hasOwn(response.body,'result'),'An error cannot disclose a successful result');return{status:response.status,code:response.body.error.code};}
async function selectedActive(run){const view=await run.read('lifecycle.definition.inspect');assert(view.active,'Use an existing natively activated isolated project');const source=await run.source(view.active.id);return{view,source};}
async function noChanges(run,before){assert.deepEqual(await run.read('lifecycle.definition.inspect'),before,'A denied request cannot create a draft or alter active/revision');}
async function noCredentialExposure(run,ui,extra=[]){
 const surfaces=[{name:'page-url',text:ui.page.url()},{name:'page-html',text:await ui.page.content()},{name:'page-visible-text',text:await ui.page.locator('body').innerText()},{name:'browser-request-responses',text:JSON.stringify(ui.network)},...extra];
 if(await ui.source.count())surfaces.push({name:'yaml-editor',text:await ui.source.inputValue()});
 return run.assertNoCredentialExposure(surfaces,{logs:true});
}

async function monitorCase(run,browser,c){
 const principal=identity(run,'monitor'),initial=await selectedActive(run),ui=await openBrowser(run,browser,{principalAlias:'monitor',route:'/monitor',monitorEvidence:true});
 try{
  const before=await ui.monitor();assert.equal(before.readOnly,true);
  await expect(ui.source).toHaveCount(0);
  for(const name of ['保存草稿','保存并启用','执行','暂停','重试','取消','发布'])await expect(ui.page.getByRole('button',{name,exact:true})).toHaveCount(0);
  assert(!Object.hasOwn(before,'yaml')&&!Object.hasOwn(before,'semantic'));for(const instance of before.instances){assert(!Object.hasOwn(instance,'definition'));assert(!Object.hasOwn(instance,'yaml'));}
  const previews=await run.principalRequest('monitor','lifecycle.definition.validate',{yaml:initial.source});assert.equal(previews.status,200);
  const probes=[
   ['lifecycle.draft.save',{yaml:initial.source+'\n# denied monitor draft\n'}],
   ['lifecycle.definition.save-and-activate',{yaml:initial.source,validationDigest:previews.body.result.validationDigest}],
   ['lifecycle.instance.create',{instanceId:'e12-denied-instance',definitionRevisionId:initial.view.active.id,authorityRef:'synthetic:never-authorized'}],
   ['lifecycle.stage.request',{instanceId:'e12-denied-instance',stageId:'scope'}],
   ['lifecycle.stage.advance',{stageRequestId:'e12-denied-request'}],
  ];
  const findings=[];
  for(let i=0;i<probes.length;i++){
   const [operation,input]=probes[i],meta={requestId:run.requestId(c.caseInstanceId,'monitor-native-'+i),expectedRevision:initial.view.revision};
   const api=await run.principalRequest('monitor',operation,input,meta);findings.push({entry:'native-http',operation,...denied(api,['FORBIDDEN'])});
   const browserResponse=await ui.sessionRequest(operation,input,{...meta,requestId:run.requestId(c.caseInstanceId,'monitor-browser-'+i)});
   findings.push({entry:'browser-session',operation,...denied(browserResponse,i<2?['FORBIDDEN']:['DASHBOARD_OPERATION'])});
  }
  await noChanges(run,initial.view);assert.deepEqual((await ui.monitor()).instances,before.instances);
  await ui.screenshot();await ui.login('/lifecycle');await expect(ui.source).toHaveAttribute('readonly','');
  for(const name of ['保存草稿','保存并启用'])await expect(ui.page.getByRole('button',{name,exact:true})).toBeDisabled();
  const leakCheck=await noCredentialExposure(run,ui,[{name:'monitor-snapshot',text:JSON.stringify(before)}]);await ui.flush();
  return{phase:'PRE_RELEASE',requirements:['D04','D07'],candidate:run.candidate,actualMonitorPrincipal:principal,actualBrowserAndNativeRequests:true,monitorHasNoEditorOrRunControls:true,monitorPayloadOmitsEditorConfiguration:true,readOnlyDefinitionView:true,findings,activeDraftRevisionAndInstancesUnchanged:true,credentialExposure:leakCheck,postIndependentRemaining:['E22','P04'],postReleaseAcceptance:false};
 }finally{await ui.close();}
}

async function activateCurrent(ui,run,source){
 await expect(ui.source).toBeEditable();await ui.source.fill(source);await ui.preview();await expect(ui.page.getByRole('button',{name:'保存并启用',exact:true})).toBeEnabled();await ui.activate();
 const after=await run.read('lifecycle.definition.inspect');assert.equal(await run.source(after.active.id),source);
 await ui.flush();
 const latest=ui.network.filter(r=>r.request?.operation==='lifecycle.definition.save-and-activate').at(-1);assert(latest);
 const receipt=JSON.parse(latest.rawBody).result;assert.equal(receipt.result.status,'ACTIVE');assert.equal(receipt.result.executionAuthorized,false);assert.equal(receipt.result.releaseAuthorized,false);
 return{activeRevisionId:after.active.id,requestId:receipt.requestId,executionAuthorized:false,releaseAuthorized:false};
}
async function invalidDraft(ui,run,c,name,source,expected){
 const before=await run.read('lifecycle.definition.inspect');await ui.source.fill(source);await ui.save();await ui.preview();
 await expect(ui.page.getByRole('button',{name:'保存并启用',exact:true})).toBeDisabled();
 const preview=await run.read('lifecycle.definition.validate',{yaml:source});assert.equal(preview.ready,false);assert.equal(preview.compilation.valid,expected.structural);
 const found=preview.issues.filter(i=>i.path===expected.path||expected.prefix&&i.path.startsWith(expected.path));assert(found.length,'Exact invalid configuration path must be diagnosed');assert(found.every(i=>i.code&&i.rule&&i.remedy));
 const saved=await run.read('lifecycle.definition.inspect');assert.deepEqual(saved.active,before.active);assert.equal(await run.source(saved.draft.id),source);await expect(ui.source).toHaveValue(source);
 const attack=await ui.sessionRequest('lifecycle.definition.save-and-activate',{yaml:source,validationDigest:preview.validationDigest},{requestId:run.requestId(c.caseInstanceId,'direct-invalid-'+name),expectedRevision:saved.revision});
 assert.equal(attack.status,200);assert.equal(attack.body.result.result.status,'BLOCKED');assert.equal(attack.body.result.result.releaseAuthorized,false);
 const after=await run.read('lifecycle.definition.inspect');assert.deepEqual(after.active,before.active);assert.equal(await run.source(after.draft.id),source);
 // Native direct denial increments the shared revision. Keep this same page,
 // explicitly reload its retained draft before performing the repaired action.
 await ui.login('/lifecycle');await expect(ui.source).toHaveValue(source);
 return{name,issues:found,invalidDraftRetained:true,oldActiveUnchanged:true,nativeActivationBlocked:true};
}
export async function samePageRepairs(run,browser,c){
 identity(run,'activator');identity(run,'editor');const initial=await selectedActive(run),preview=await run.principalRequest('activator','lifecycle.definition.validate',{yaml:initial.source});assert.equal(preview.status,200);assert.equal(preview.body.result.ready,true);
 const ui=await openBrowser(run,browser,{principalAlias:'activator',route:'/lifecycle',monitorEvidence:true});
 try{
  const beforeInstances=(await ui.monitor()).instances,base=await run.read('lifecycle.base.inspect'),action=base.actions.find(a=>a.type==='check');assert(action);
  const invalidExtension={id:'project.e12-forbidden',slot:'after-plan',type:'check',actionRef:action.id,actionVersion:action.version,actionDigest:action.digest,parameters:Object.fromEntries(Object.keys(action.parameterSchema).map(key=>[key,'binding:e12/never-registered'])),requirementRefs:['binding:e12/never-registered'],evidenceMappingRef:'binding:e12/never-registered',scopeRef:'scope:'+run.selection.projectId,budget:{timeoutSeconds:1,maxAttempts:1,maxConcurrency:1,maxLoops:1},dependsOn:[],required:false};
  const missingRef='binding:e12/missing-'+sha(run.selection.runId+'|'+c.caseInstanceId).slice(0,20),negativeSources=[
   ['required',withValue(initial.source,['config','scope','targetInputRef'],undefined),{structural:false,path:'config.scope.targetInputRef'}],
   ['extension',withValue(initial.source,['extensions'],[...(parse(initial.source).extensions??[]),invalidExtension]),{structural:false,path:'extensions.',prefix:true}],
   ['reference',withValue(initial.source,['config','scope','targetInputRef'],missingRef),{structural:true,path:'config.scope.targetInputRef'}],
  ],repairs=[];
  for(const [name,source,expected]of negativeSources){const failure=await invalidDraft(ui,run,c,name,source,expected);const repaired=initial.source+'\n# e12 '+name+' repair '+run.selection.runId+'\n';repairs.push({...failure,repairedAtSameBrowser:await activateCurrent(ui,run,repaired)});}
  // Same principal and session, exact same candidate/source; removing Origin or
  // CSRF cannot mutate anything, and a fresh valid request can proceed here.
  const current=await selectedActive(run),csrfSource=current.source+'# csrf recovery\n';await ui.source.fill(csrfSource);await ui.preview();
  const csrfPreview=await ui.sessionRequest('lifecycle.definition.validate',{yaml:csrfSource});assert.equal(csrfPreview.status,200);assert.equal(csrfPreview.body.result.ready,true);
  const csrfFindings=[];
  for(const [name,options,codes]of [['missing-csrf',{csrf:'missing'},['INVALID_INPUT']],['invalid-csrf',{csrf:'invalid'},['CSRF']],['missing-origin',{origin:'missing'},['CSRF']],['invalid-origin',{origin:'invalid'},['INVALID_ORIGIN']]]){
   const result=await ui.sessionRequest('lifecycle.definition.save-and-activate',{yaml:csrfSource,validationDigest:csrfPreview.body.result.validationDigest},{requestId:run.requestId(c.caseInstanceId,name),expectedRevision:current.view.revision},options);
   csrfFindings.push({name,...denied(result,codes)});await noChanges(run,current.view);
  }
  const csrfRepair=await activateCurrent(ui,run,csrfSource);
  await ui.flush();await ui.close();

  // The editor can retain a draft but cannot activate it. A separately selected
  // real activator repairs it in the same Dashboard entry; no fabricated role
  // revocation/restoration or current Codex installation is claimed.
  const editor=await openBrowser(run,browser,{principalAlias:'editor',route:'/lifecycle'});let editorSource;
  try{
   const old=await selectedActive(run);editorSource=old.source+'# editor lacks activation authority\n';await editor.source.fill(editorSource);await editor.save();await editor.preview();
   await expect(editor.page.getByRole('button',{name:'保存并启用',exact:true})).toBeDisabled();const ready=await editor.sessionRequest('lifecycle.definition.validate',{yaml:editorSource});assert.equal(ready.status,200);assert.equal(ready.body.result.ready,true);
   const before=await run.read('lifecycle.definition.inspect'),denial=await editor.sessionRequest('lifecycle.definition.save-and-activate',{yaml:editorSource,validationDigest:ready.body.result.validationDigest},{requestId:run.requestId(c.caseInstanceId,'editor-forbidden'),expectedRevision:before.revision});denied(denial,['FORBIDDEN']);await noChanges(run,before);assert.equal(await run.source(before.draft.id),editorSource);await editor.flush();
  }finally{await editor.close();}
  const resumed=await openBrowser(run,browser,{principalAlias:'activator',route:'/lifecycle',monitorEvidence:true});
  try{
   await expect(resumed.source).toHaveValue(editorSource);const authorizedRepair=await activateCurrent(resumed,run,editorSource);
   assert.deepEqual((await resumed.monitor()).instances,beforeInstances,'Definition-only fixes cannot dispatch or mutate instances');
   const leakCheck=await noCredentialExposure(run,resumed);await resumed.flush();
   return{actualInstalledBrowser:true,repairs,referenceFailureKind:'UNREGISTERED_REFERENCE_CONFIRMED_BY_NATIVE_BINDING_VALIDATOR',csrfFindings,csrfRepair,editorDraftAllowedActivationDenied:true,authorizedRepair,sameEntry:'DASHBOARD_LIFECYCLE',principalChangedOnlyForPermissionRepair:true,revocationTimingClaimed:false,executionDispatched:false,releaseAuthorized:false,credentialExposure:leakCheck};
  }finally{await resumed.close();}
 }finally{await ui.close();}
}

async function protocolProbes(run,ui){
 const findings=[],probe=async(name,url,options,expectedCode)=>{
  const selected=new URL(url);assert.equal(selected.origin,run.serviceOrigin);let observed;
  if(name==='invalid-host'){
   // Fetch rewrites Host to the URL authority. node:http retains this exact
   // negative header, performs one request, and never follows redirects.
   assert.deepEqual(options,{headers:{host:'attacker.invalid'}});
   observed=await new Promise((resolve,reject)=>{
    const request=httpRequest(selected,{method:'GET',headers:options.headers,agent:false,signal:AbortSignal.timeout(10000)},response=>{
     const chunks=[];let size=0;response.on('data',chunk=>{size+=chunk.length;if(size>8192){response.destroy(Error('HTTP probe response exceeds 8192 bytes'));return;}chunks.push(chunk);});response.on('error',reject);response.on('aborted',()=>reject(Error('HTTP probe response aborted')));
     response.on('end',()=>resolve({transport:'node:http',status:response.statusCode,headers:response.headers,rawBody:Buffer.concat(chunks).toString('utf8'),actualRequest:{method:request.method,path:request.path,headers:request.getHeaders()}}));
    });request.on('error',reject);request.end();
   });
  }else{
   const response=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(10000)}),reader=response.body.getReader(),chunks=[];let size=0;
   try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>8192){await reader.cancel();throw Error('HTTP probe response exceeds 8192 bytes');}chunks.push(item.value);}}finally{reader.releaseLock();}
   observed={transport:'fetch',status:response.status,headers:Object.fromEntries(response.headers),rawBody:Buffer.concat(chunks).toString('utf8')};
  }
  // Preserve the real rejection before parsing or checking the fixed predicate.
  run.artifact('http-boundary-rejection.json',{name,path:selected.pathname,method:options.method??'GET',...observed,inputKind:'SYNTHETIC_NEGATIVE_REQUEST',authorizationOmitted:true});
  const body=JSON.parse(observed.rawBody),result=denied({status:observed.status,body},[expectedCode]);assert.equal(observed.headers['access-control-allow-origin']??null,null);
  if(name==='invalid-host'){assert.equal(observed.status,403);assert.equal(observed.actualRequest.headers.host,'attacker.invalid');}
  findings.push({name,...result});
 };
 await probe('invalid-host',run.serviceOrigin+'/api/v1/status?projectId='+encodeURIComponent(run.selection.projectId),{headers:{host:'attacker.invalid'}},'INVALID_HOST');
 await probe('invalid-origin',run.serviceOrigin+'/api/v1/status?projectId='+encodeURIComponent(run.selection.projectId),{headers:{origin:'https://attacker.invalid'}},'INVALID_ORIGIN');
 await probe('unrecognized-token',run.serviceOrigin+'/api/v1/status?projectId='+encodeURIComponent(run.selection.projectId),{headers:{authorization:'Bearer '+randomBytes(32).toString('base64url')}},'UNAUTHENTICATED');
 await probe('credential-query-key',run.serviceOrigin+'/api/v1/status?token=synthetic-not-a-credential',{},'SECRET_IN_URL');
 const oversized=await ui.sessionRequest('runtime.status',{padding:'x'.repeat(262145)});
 assert.equal(oversized.status,413);findings.push({name:'authenticated-oversize-body',...denied(oversized,['INPUT_LIMIT'])});
 const cross=await ui.sessionRequest('lifecycle.definition.inspect',{}, {},{projectId:'e12-forbidden-'+sha(run.selection.runId).slice(0,12)});findings.push({name:'cross-project-browser',...denied(cross,['FORBIDDEN'])});
 return findings;
}
async function phaseMapping(run,browser,c){
 const monitor=await monitorCase(run,browser,c),acceptanceBytes=fs.readFileSync(path.join(repository,'governance/acceptance-v090.json')),matrixBytes=fs.readFileSync(path.join(repository,'governance/parameter-matrix-v090.json')),targetBytes=fs.readFileSync(path.join(repository,'governance/target-v090.json'));
 const acceptance=JSON.parse(acceptanceBytes),matrix=JSON.parse(matrixBytes),target=JSON.parse(targetBytes);assert.equal(target.acceptanceDigest,sha(acceptanceBytes));assert.equal(matrix.sourceAcceptanceDigest,sha(acceptanceBytes));assert.equal(target.implementationBindings['governance/parameter-matrix-v090.json'],sha(matrixBytes));
 assert.equal(matrix.count,664);assert.equal(matrix.caseInstances.filter(row=>row.phase==='PRE_RELEASE').length,655);assert.equal(matrix.caseInstances.filter(row=>row.phase==='POST_RELEASE').length,9);
 for(const id of ['E07','E12']){const row=acceptance.scenarios.find(row=>row.id===id);assert.equal(row.phase,'PRE_RELEASE');assert(!row.groups.includes('P04'));assert(row.groups.includes('D04')&&row.groups.includes('D07'));}
 const post=acceptance.scenarios.find(row=>row.id==='E22');assert.equal(post.phase,'POST_RELEASE');assert(post.groups.includes('P04'));
 const closure=acceptance.closure.find(row=>row.id==='MC06');assert.deepEqual(closure.phaseObligations.PRE_RELEASE,{cases:['E07','E12'],requirements:['D04','D07']});assert(closure.phaseObligations.POST_RELEASE.cases.includes('E22'));assert(closure.phaseObligations.POST_RELEASE.requirements.includes('P04'));
 assert.deepEqual(acceptance.phasePolicy.POST_RELEASE.scenarios,['E21','E22']);assert.deepEqual(acceptance.phasePolicy.POST_RELEASE.requirements,['P03','P04']);
 const mapping={acceptanceDigest:sha(acceptanceBytes),matrixDigest:sha(matrixBytes),targetDigest:sha(targetBytes),traceability:acceptance.scenarios.filter(row=>['E07','E12','E22'].includes(row.id)).map(row=>({id:row.id,phase:row.phase,groups:row.groups})),phasePolicy:acceptance.phasePolicy,mc06:closure.phaseObligations,postIndependentRemaining:['E22','P04'],postReleaseAcceptance:false};
 run.artifact('phase-traceability.json',mapping);return{phase:'PRE_RELEASE',actualCandidateMonitorAndPermissionEvidence:monitor,...mapping};
}

export async function permissionFixture(run,c){
 const f=run.permissionFixture;assert(f&&f.caseIds.includes(c.caseInstanceId));for(const role of ['monitor','editor','activator'])identity(run,role);
 const original=(await run.read('lifecycle.instance.inspect',{instanceId:f.instanceId})).instance;assert.equal(original.id,f.instanceId);assert.equal(original.pins.projectId,run.selection.projectId);assert(Object.values(original.stages).every(s=>s.status==='PENDING'&&s.attempts===0&&s.requestId===null));
 const originalSource=await run.source(original.pins.definitionRevisionId);return{fixture:f,original,originalSource};
}
async function intactPermissionHistory(run,initial){
 assert.deepEqual((await run.read('lifecycle.instance.inspect',{instanceId:initial.fixture.instanceId})).instance,initial.original);assert.equal(await run.source(initial.original.pins.definitionRevisionId),initial.originalSource);
}
async function permissionEvents(run){let cursor,rows=[];for(let i=0;i<80;i++){const r=await run.read('runtime.events.read',cursor?{cursor}:{});assert(Array.isArray(r.events)&&r.events.length<=50);if(!r.events.length)return rows;rows.push(...r.events);assert.notEqual(r.cursor,cursor);cursor=r.cursor;}throw Error('Permission fixture event bound exceeded');}
function actualPreview(ui,source){const row=ui.network.filter(v=>v.request?.operation==='lifecycle.definition.validate'&&v.request.input?.yaml===source&&v.status===200&&v.transportOutcome==='RESPONSE_RETAINED').at(-1);assert(row);const body=JSON.parse(row.rawBody);assert.equal(body.result.ready,true);assert(/^sha256:[a-f0-9]{64}$/.test(body.result.validationDigest));return{digest:body.result.validationDigest,responseRequestId:body.requestId};}
async function previewPermissionSource(ui,source){await expect(ui.source).toBeEditable();await ui.source.fill(source);await ui.preview();return actualPreview(ui,source);}
async function deniedUiActivation(ui,run,source,preview,{holdBeforeSubmit=false,stepId}){
 const start=ui.network.length;let captured=null,release=null,arrived=null,released=false,routeFailure=null;
 const ready=new Promise(resolve=>{arrived=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const handler=async route=>{const request=route.request();let envelope;try{envelope=request.postDataJSON();}catch{}if(envelope?.operation!=='lifecycle.definition.save-and-activate')return route.continue();if(captured){routeFailure='Unexpected duplicate UI activation request';return route.abort('failed');}
  try{assert.equal(envelope.projectId,run.selection.projectId);assert.equal(envelope.input.yaml,source);assert.equal(envelope.input.validationDigest,preview.digest);assert.equal(typeof envelope.requestId,'string');captured={envelope,at:new Date().toISOString(),interception:'ACTUAL_UI_REQUEST_BEFORE_TRANSPORT_NO_PAYLOAD_CHANGE'};arrived();const forward=await gate;if(!forward)return route.abort('failed');await route.continue();}catch{routeFailure='Exact held activation forwarding failed';try{await route.abort('failed');}catch{}}
 };
 try{
  if(holdBeforeSubmit)await ui.page.route('**/api/v1/dashboard/request',handler);
  if(!holdBeforeSubmit)run.permissionFault(stepId);
  const click=ui.page.getByRole('button',{name:'保存并启用',exact:true}).click({timeout:10000});
  if(holdBeforeSubmit){let timer;try{await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Actual submit interception timed out')),10000);})]);}finally{clearTimeout(timer);}run.artifact('permission-submit-boundary.json',captured);run.permissionFault(stepId);released=true;release(true);}
  await click;await expect.poll(()=>ui.network.slice(start).filter(v=>v.request?.operation==='lifecycle.definition.save-and-activate'&&v.transportOutcome==='RESPONSE_RETAINED').length,{timeout:10000}).toBeGreaterThan(0);assert.equal(routeFailure,null);
  const row=ui.network.slice(start).find(v=>v.request?.operation==='lifecycle.definition.save-and-activate'&&v.transportOutcome==='RESPONSE_RETAINED');assert.equal(row.request.input.validationDigest,preview.digest);assert.equal(row.request.input.yaml,source);const result=denied({status:row.status,body:JSON.parse(row.rawBody)},['BROWSER_SESSION_REVOKED','UNAUTHENTICATED']);assert.equal(result.status,401);return{...result,actualUiRequest:row.request,heldBeforeTransport:holdBeforeSubmit,previewResponseRequestId:preview.responseRequestId};
 }finally{if(!released){released=true;release(false);}if(holdBeforeSubmit)await ui.page.unroute('**/api/v1/dashboard/request',handler);}
}
async function restorePreview(run,ui,c,initial,source,preview,restoreId,pendingRequestId=null){
 run.permissionFault(restoreId);const old=await ui.sessionRequest('runtime.status');assert.equal(old.status,401);denied(old,['UNAUTHENTICATED','BROWSER_SESSION_REVOKED']);await ui.login('/lifecycle');
 let originalRequestRecovery=null;
 if(pendingRequestId!==null){
  assert.equal(typeof pendingRequestId,'string');const button=ui.page.getByRole('button',{name:'核对原请求',exact:true});await expect(button).toBeEnabled();await expect(ui.page.getByText('待核对原请求',{exact:false})).toContainText(pendingRequestId);await expect(ui.source).toHaveAttribute('readonly','');
  const since=ui.network.length;await button.click();await expect(ui.source).toBeEditable();await expect(button).toHaveCount(0);await expect.poll(()=>ui.network.slice(since).filter(row=>row.request?.operation==='runtime.receipt.read'&&row.request.input?.requestId===pendingRequestId&&row.transportOutcome==='RESPONSE_RETAINED').length,{timeout:10000}).toBe(1);
  const rows=ui.network.slice(since),row=rows.find(row=>row.request?.operation==='runtime.receipt.read'&&row.request.input?.requestId===pendingRequestId);assert.equal(row.status,404);assert.equal(JSON.parse(row.rawBody).error.code,'NOT_FOUND');assert(!rows.some(row=>['lifecycle.draft.save','lifecycle.definition.save-and-activate'].includes(row.request?.operation)));await expect(ui.page.getByRole('button',{name:'保存并启用',exact:true})).toBeDisabled();
  originalRequestRecovery={originalRequestId:pendingRequestId,entry:'ACTUAL_DASHBOARD_ORIGINAL_REQUEST_BUTTON',receiptRead:row,missingReceiptConfirmed:true,newWrites:0};run.artifact('permission-original-request-recovery.json',originalRequestRecovery);
 }
 const before=await run.read('lifecycle.definition.inspect'),requestId=run.requestId(c.caseInstanceId,restoreId+'-old-preview'),stale=await ui.sessionRequest('lifecycle.definition.save-and-activate',{yaml:source,validationDigest:preview.digest},{requestId,expectedRevision:before.revision});assert.equal(stale.status,200);assert.equal(stale.body.result.result.status,'BLOCKED');assert(stale.body.result.result.issues.some(i=>i.code==='VALIDATION_STALE'));assert.deepEqual((await run.read('lifecycle.definition.inspect')).active,before.active);
 // The real BLOCKED request retains its draft and advances revision. Reconnect
 // this same Dashboard page before obtaining and consuming a genuinely new preview.
 await ui.login('/lifecycle');const fresh=await previewPermissionSource(ui,source);assert.notEqual(fresh.digest,preview.digest);const activated=await activateCurrent(ui,run,source);await intactPermissionHistory(run,initial);return{oldSessionRejected:true,originalRequestRecovery,oldPreviewRequestId:requestId,oldPreviewBlocked:true,freshPreview:fresh,activated};
}
export async function afterActivationRevocation(run,browser,c,initial,ids){
 const ui=await openBrowser(run,browser,{principalAlias:'activator',route:'/lifecycle',monitorEvidence:true});
 try{
  const selected=await selectedActive(run),source=selected.source+'\n# exact post-active revocation '+run.selection.runId+'\n',preview=await previewPermissionSource(ui,source),activation=await activateCurrent(ui,run,source),before=await run.read('lifecycle.definition.inspect');
  await ui.login('/monitor');const start=ui.sseFrames.length;await expect.poll(()=>ui.sseFrames.filter(f=>['snapshot','heartbeat'].includes(f.eventName)).length,{timeout:10000}).toBeGreaterThan(0);const connected=ui.sseFrames.find(f=>['snapshot','heartbeat'].includes(f.eventName));assert(connected);const fault=run.permissionFault(ids.expire);
  const native=await run.principalRequest('activator','runtime.status');assert.equal(native.status,401);denied(native,['UNAUTHENTICATED']);
  await expect.poll(()=>ui.sseFrames.slice(start).filter(f=>f.eventName==='error'&&f.requestId===connected.requestId).length,{timeout:10000}).toBeGreaterThan(0);const errorIndex=ui.sseFrames.findIndex((f,i)=>i>=start&&f.eventName==='error'&&f.requestId===connected.requestId),frame=ui.sseFrames[errorIndex];assert.equal(JSON.parse(frame.data).code,'UNAUTHENTICATED');
  await expect(ui.page.getByLabel('一次性连接码')).toBeVisible();const session=await ui.sessionRequest('runtime.status');assert.equal(session.status,401);denied(session,['UNAUTHENTICATED','BROWSER_SESSION_REVOKED']);
  let stream;try{const response=await ui.context.request.get(run.serviceOrigin+'/api/v1/dashboard/events',{timeout:10000,maxRedirects:0});const raw=await response.text();assert(Buffer.byteLength(raw)<=8192);stream={status:response.status(),body:JSON.parse(raw),rawBody:raw};}catch{throw Error('Revoked stream read failed before a bounded safe response');}assert.equal(stream.status,401);denied(stream,['UNAUTHENTICATED','BROWSER_SESSION_REVOKED']);run.artifact('permission-revoked-stream.json',{path:'/api/v1/dashboard/events',...stream,originalFrame:frame,authenticationFieldsOmitted:true});
  assert(!ui.sseFrames.slice(errorIndex+1).some(f=>f.requestId===connected.requestId&&['snapshot','events','heartbeat','reset'].includes(f.eventName)));await noChanges(run,before);await intactPermissionHistory(run,initial);
  const recovery=await restorePreview(run,ui,c,initial,source,preview,ids.restore);await noCredentialExposure(run,ui,[{name:'revoked stream',text:JSON.stringify(stream)}]);await ui.flush();return{activation,fault,nativeRevoked:native.body.error.code,browserRevoked:session.body.error.code,originalSseError:frame,newSseRejected:true,recovery};
 }finally{run.restorePermissionFault();await ui.close();}
}
export async function permissionTiming(run,browser,c){
 const initial=await permissionFixture(run,c),events=await permissionEvents(run),roleMonitor=await monitorCase(run,browser,c);let editor;
 try{editor=await openBrowser(run,browser,{principalAlias:'editor',route:'/lifecycle'});const old=await selectedActive(run),source=old.source+'\n# editor retained draft\n';await editor.source.fill(source);await editor.save();await editor.preview();await expect(editor.page.getByRole('button',{name:'保存并启用',exact:true})).toBeDisabled();const preview=actualPreview(editor,source),view=await run.read('lifecycle.definition.inspect'),denial=await editor.sessionRequest('lifecycle.definition.save-and-activate',{yaml:source,validationDigest:preview.digest},{requestId:run.requestId(c.caseInstanceId,'editor-denied'),expectedRevision:view.revision});assert.equal(denial.status,403);denied(denial,['FORBIDDEN']);await noChanges(run,view);}finally{await editor?.close();}
 const timings=[];
 for(const name of ['after-preview','before-submit']){
  const ui=await openBrowser(run,browser,{principalAlias:'activator',route:'/lifecycle',monitorEvidence:true});
  try{const selected=await selectedActive(run),source=selected.source+'\n# '+name+' '+run.selection.runId+'\n',preview=await previewPermissionSource(ui,source),before=await run.read('lifecycle.definition.inspect');const rejected=await deniedUiActivation(ui,run,source,preview,{holdBeforeSubmit:name==='before-submit',stepId:name+'-revoke'});
   const native=await run.principalRequest('activator','lifecycle.definition.save-and-activate',{yaml:source,validationDigest:preview.digest},{requestId:run.requestId(c.caseInstanceId,name+'-native-denied'),expectedRevision:before.revision});assert.equal(native.status,403);denied(native,['FORBIDDEN']);assert.equal((await run.principalRequest('activator','lifecycle.instance.inspect',{instanceId:initial.original.id})).status,200);await noChanges(run,before);await intactPermissionHistory(run,initial);const recovery=await restorePreview(run,ui,c,initial,source,preview,name+'-restore',rejected.actualUiRequest.requestId);await ui.flush();timings.push({boundary:name,rejected,nativeDenied:true,recovery});
  }finally{run.restorePermissionFault();await ui.close();}
 }
 const post=await afterActivationRevocation(run,browser,c,initial,{expire:'after-active-expire',restore:'after-active-restore'});const after=await permissionEvents(run);assert.deepEqual(after.slice(0,events.length),events);const added=after.slice(events.length);assert(added.every(e=>['definition-draft-saved','definition-activation-blocked','definition-activated'].includes(e.type)));
 return{actualInstalledCandidate:true,actualThreeRoles:true,monitor:roleMonitor,timings,postActivation:post,oldInstanceAndPinsUnchanged:true,authFaultInjection:true,productMembershipManagement:false,newInstanceOrStageDispatches:0,newModelCalls:0,newCiRuns:0};
}
async function permissionJourney(run,browser,c){
 const initial=await permissionFixture(run,c),events=await permissionEvents(run),monitor=await monitorCase(run,browser,c),repairs=await samePageRepairs(run,browser,c),ui=await openBrowser(run,browser,{principalAlias:'monitor',route:'/monitor',monitorEvidence:true});let protocol;
 try{protocol=await protocolProbes(run,ui);await noCredentialExposure(run,ui);await ui.flush();}finally{await ui.close();}
 const revoked=await afterActivationRevocation(run,browser,c,initial,{expire:'journey-expire',restore:'journey-restore'});const after=await permissionEvents(run);assert.deepEqual(after.slice(0,events.length),events);assert(after.slice(events.length).every(e=>['definition-draft-saved','definition-activation-blocked','definition-activated'].includes(e.type)));await intactPermissionHistory(run,initial);
 return{actualInstalledCandidate:true,monitor,repairs,protocol,revoked,originalInstancePreserved:true,newExecutionDispatched:false,cv02Separate:true,postReleaseAcceptance:false};
}


export async function executeE12() {
 const run=await openScenario('E12');let browser;
 try{
  browser=await chromium.launch({headless:true});
  for(const c of run.cases)await run.collect(c,async()=>{
   if(['E12.variant.02','E12.MC06'].includes(c.caseInstanceId))return monitorCase(run,browser,c);
   if(['E12.variant.01','E12.MC03'].includes(c.caseInstanceId))return samePageRepairs(run,browser,c);
   if(c.caseInstanceId==='E12.CV08')return phaseMapping(run,browser,c);
   if(c.caseInstanceId==='E12.CV02')return permissionTiming(run,browser,c);
   if(c.caseInstanceId==='E12.journey')return permissionJourney(run,browser,c);
   assert.fail('Unknown fixed E12 case '+c.caseInstanceId);
  });
 }finally{await browser?.close();run.finish();}
}
if(process.argv[1]&&collectorPathToFileURL(collectorResolve(process.argv[1])).href===import.meta.url)test('E12 exact installed browser and HTTP permission/security boundaries',{timeout:240000},executeE12);
