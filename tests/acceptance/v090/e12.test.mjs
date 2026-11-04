// Real installed HTTP/browser boundary observations. Synthetic negative input is
// labeled; unavailable revocation timing is never inferred from a different test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
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
async function samePageRepairs(run,browser,c){
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
  const response=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(10000)}),raw=await response.text();assert(Buffer.byteLength(raw)<=8192);const body=JSON.parse(raw);
  const result=denied({status:response.status,body},[expectedCode]);assert.equal(response.headers.get('access-control-allow-origin'),null);
  run.artifact('http-boundary-rejection.json',{name,path:new URL(url).pathname,method:options.method??'GET',status:response.status,body,inputKind:'SYNTHETIC_NEGATIVE_REQUEST',authorizationOmitted:true});findings.push({name,...result});
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

test('E12 exact installed browser and HTTP permission/security boundaries',async()=>{
 const run=await openScenario('E12');let browser;
 try{
  browser=await chromium.launch({headless:true});
  for(const c of run.cases)await run.collect(c,async()=>{
   if(['E12.variant.02','E12.MC06'].includes(c.caseInstanceId))return monitorCase(run,browser,c);
   if(['E12.variant.01','E12.MC03'].includes(c.caseInstanceId))return samePageRepairs(run,browser,c);
   if(c.caseInstanceId==='E12.CV08')return phaseMapping(run,browser,c);
   if(c.caseInstanceId==='E12.CV02'){
    run.artifact('required-revocation-timing.json',{contract:c.parameters.variantContract,missing:'Actual permission/dependency revocation at all three exact temporal boundaries and same-entry fresh validation recovery',syntheticRoleChangesNotSubstituted:true});
    assert.fail('UNIMPLEMENTED_REQUIRED_VARIANT: exact current-principal/dependency revocation timing remains independently required');
   }
   if(c.caseInstanceId==='E12.journey'){
    identity(run,'monitor');const ui=await openBrowser(run,browser,{principalAlias:'monitor',route:'/monitor',monitorEvidence:true});
    try{const findings=await protocolProbes(run,ui);const leakCheck=await noCredentialExposure(run,ui);run.artifact('partial-security-journey.json',{findings,credentialExposure:leakCheck,unexecuted:['actual revoked credential read','actual revoked stream read'],complete:false});}
    finally{await ui.close();}
    assert.fail('UNIMPLEMENTED_REQUIRED_VARIANT: original E12 journey also requires actual revocation and post-revocation stream evidence');
   }
   assert.fail('Unknown fixed E12 case '+c.caseInstanceId);
  });
 }finally{await browser?.close();run.finish();}
});
