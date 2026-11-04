// Negative boundary tests with synthetic descriptors. Successful installed
// publication, original request recovery and current owner calls are separate.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {canonical,canonicalEvidence,digest} from '../../dist/server/errors.js';
import {nativeSha256} from '../../vendor/compatibility/v1/native.mjs';
import {validateOnlineConfigurationInput,prepareOnlineConfiguration,onlineConfigurationControl,onlineOutputPath} from '../../dist/installation/online/configuration.js';
import {inspectOnlineApplication,applyOnlineConfiguration,onlineConfigurationCommand} from '../../dist/installation/online/application.js';
import {installerMain} from '../../dist/installation/installer.js';
const pin='a'.repeat(64),sha=v=>createHash('sha256').update(v).digest('hex'),write=(p,v)=>{fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});fs.writeFileSync(p,typeof v==='string'?v:canonicalEvidence(v)+'\n',{mode:0o600});};
function fixture(t){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'runtime-online-config-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const serviceRoot=path.join(root,'service');fs.mkdirSync(serviceRoot,{mode:0o700});
 const input={serviceRoot,settings:{scopes:[{projectId:'synthetic',visibility:'private'}],prometheus:[{id:'metrics',origin:'http://127.0.0.1:19090',bearerTokenFile:null,freshnessSeconds:60}],alertmanager:[{id:'alerts',bearerTokenFile:path.join(root,'secret')}],receiverPort:19093,tickSeconds:2},expectedDigest:null,requestId:'configure',hosts:[{connectionRef:path.join(serviceRoot,'connection.json'),ownerConfigRef:path.join(root,'owner.json'),ownerConfigDigest:pin}]};return{root,input};
}
function material(input){
 const binding={workspaceRoot:path.join(path.dirname(input.serviceRoot),'workspace'),workspaceId:'synthetic',serviceId:'synthetic-service',migrationDigest:pin},installed={schema:'runtime-installed-service-selection/v1',serviceRoot:input.serviceRoot,serviceId:binding.serviceId,workspaceId:binding.workspaceId,installationPlanDigest:pin,distributionManifestDigest:pin,specificationDigest:pin,connectionDigest:pin,configurationPins:{},binding,authority:false},selection={...installed,selectionDigest:digest(installed)};
 const subject={schema:'evopilot-online-configuration/v1',workspaceId:binding.workspaceId,settings:input.settings},configuration={...subject,digest:nativeSha256(subject)},registration={ref:path.join(binding.workspaceRoot,'online/configuration.json'),digest:digest(configuration)};
 const hostAfter={ownerConfigRef:path.join(input.serviceRoot,'online-owner-host-'+pin+'.json'),ownerConfigDigest:pin};
 const patches=[[registration.ref,configuration],[hostAfter.ownerConfigRef,{expiresAt:'2030-01-01T00:00:00Z'}],[path.join(input.serviceRoot,'plugin/.mcp.json'),{}]].map(([ref,v])=>{const content=canonical(v)+'\n';return{ref,before:null,after:sha(content),content};});
 const body={schema:'runtime-online-configuration-material/v1',input,selection,configuration,registration,sourcePins:{},hostsAfter:[{...input.hosts[0],...hostAfter}],hostBefore:{},hostAfter,patches,authority:false,filesWritten:false,serviceStarted:false,workerStarted:false,hostReconnectRequired:true};return{...body,materialDigest:sha(canonicalEvidence(body))};
}
const resign=m=>{delete m.materialDigest;return{...m,materialDigest:sha(canonicalEvidence(m))};};

test('online request has exact original requestId, native expectedDigest and bounded explicit scope',t=>{
 const f=fixture(t);validateOnlineConfigurationInput(f.input);assert.deepEqual(fs.readdirSync(f.input.serviceRoot),[]);
 for(const change of [v=>v.requestId='../escape',v=>v.expectedDigest=pin,v=>v.hosts=[],v=>v.hosts=Array(65).fill(v.hosts[0]),v=>v.hosts[0].connectionRef='relative',v=>v.settings.scopes.push({...v.settings.scopes[0]}),v=>v.settings.prometheus[0].token='raw-secret',v=>v.settings.tickSeconds=0]){const input=structuredClone(f.input);change(input);assert.throws(()=>validateOnlineConfigurationInput(input));}
});
test('production selector cannot use a missing installation, create secrets or fabricate owner grants',async t=>{
 const f=fixture(t);await assert.rejects(prepareOnlineConfiguration(f.input));assert.deepEqual(fs.readdirSync(f.input.serviceRoot),[]);assert(!fs.existsSync(f.input.settings.alertmanager[0].bearerTokenFile));
});
test('initial online path can be inspected without creating directories and never follows an existing or dangling symlink',t=>{
 const f=fixture(t),target=path.join(f.root,'not-created','online','configuration.json');onlineOutputPath(target);assert(!fs.existsSync(path.join(f.root,'not-created')));
 const alias=path.join(f.root,'alias');fs.symlinkSync(f.input.serviceRoot,alias);assert.throws(()=>onlineOutputPath(path.join(alias,'online/configuration.json')));fs.unlinkSync(alias);fs.symlinkSync(path.join(f.root,'missing'),alias);assert.throws(()=>onlineOutputPath(path.join(alias,'online/configuration.json')));
});
test('material inspection is not installation or application authority',async t=>{
 const f=fixture(t),m=material(f.input),result=inspectOnlineApplication(m);assert.equal(result.status,'NOT_STARTED');assert.equal(result.authority,false);assert.equal(result.workerStarted,false);
 await assert.rejects(applyOnlineConfiguration(m));assert(!fs.existsSync(m.registration.ref));assert(!fs.existsSync(path.join(onlineConfigurationControl(f.input),'material.json')));assert(!fs.existsSync(m.hostAfter.ownerConfigRef));
});
test('material mutation cannot substitute configuration contents, arbitrary file targets or launch authority',t=>{
 const f=fixture(t),m=material(f.input);
 for(const change of [v=>v.workerStarted=true,v=>v.authority=true,v=>v.configuration.settings.tickSeconds=4,v=>v.registration.ref=path.join(f.root,'different.json'),v=>v.patches[1].ref=path.join(f.root,'unrelated.json'),v=>v.patches[1].content+='changed',v=>v.patches.push({...v.patches[0]}),v=>v.selection.serviceId='foreign']){const changed=structuredClone(m);change(changed);assert.throws(()=>inspectOnlineApplication(resign(changed)));}
 assert.deepEqual(fs.readdirSync(f.input.serviceRoot),[]);
});
test('an original request resumes only its retained exact material and never silently changes intent',async t=>{
 const f=fixture(t),m=material(f.input),root=onlineConfigurationControl(f.input);write(path.join(root,'material.json'),m);
 assert.deepEqual(await prepareOnlineConfiguration(f.input),m);assert.equal(inspectOnlineApplication(m).status,'INCOMPLETE');
 const changed=structuredClone(f.input);changed.settings.tickSeconds=4;await assert.rejects(prepareOnlineConfiguration(changed),{code:'REQUEST_CONFLICT'});
 const other=material(changed);assert.throws(()=>inspectOnlineApplication(other),{code:'REQUEST_CONFLICT'});assert(!fs.existsSync(m.registration.ref));
});
test('historical result replay does not assert current validity, restart or repeat configuration writes',async t=>{
 const f=fixture(t),m=material(f.input),root=onlineConfigurationControl(f.input);write(path.join(root,'material.json'),m);
 const body={schema:'runtime-online-application-result/v1',materialDigest:m.materialDigest,status:'APPLIED',configured:true,workerStarted:false,serviceStarted:false},result={...body,resultDigest:sha(canonicalEvidence(body))};write(path.join(root,'result.json'),result);
 const readback=await applyOnlineConfiguration(m);assert.equal(readback.reused,true);assert.equal(readback.currentEnvironmentVerified,false);assert.equal(readback.workerStarted,false);assert(!fs.existsSync(m.registration.ref));
 fs.appendFileSync(path.join(root,'material.json'),' ');assert.deepEqual(await applyOnlineConfiguration(m),readback,'JSON receipt identity is canonical, not inferred live health');
 write(path.join(root,'result.json'),{...result,configured:false});assert.throws(()=>inspectOnlineApplication(m),{code:'ONLINE_APPLICATION_CHANGED'});
});
test('installer exposes only protected online select/inspect/apply forms',async t=>{
 const f=fixture(t),m=material(f.input),ref=path.join(f.root,'material.json');write(ref,m);
 for(const args of [['apply','--input-ref',ref],['inspect','--material-ref',ref,'extra'],['start','--material-ref',ref]])await assert.rejects(onlineConfigurationCommand(args),{code:'ONLINE_CONFIGURATION_ARGUMENTS'});
 const out=[];assert.equal(await installerMain(['online','inspect','--material-ref',ref],{write:v=>out.push(v)}),0);assert.equal(JSON.parse(out.pop()).status,'NOT_STARTED');
 fs.chmodSync(ref,0o644);await assert.rejects(onlineConfigurationCommand(['apply','--material-ref',ref]));
});
