import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {readOnlineConfiguration,openPublishedOnlineAdapters} from '../../dist/host/online.js';
import {readLegacyOwnerHostConfiguration} from '../../dist/host/legacy-owners.js';
import {createLegacyOwnerProviders} from '../../dist/host/legacy-owner-providers.js';
import {digest,ServiceError} from '../../dist/server/errors.js';
import {nativeSha256} from '../../vendor/compatibility/v1/native.mjs';

const scope={projectId:'synthetic',visibility:'private'},hash=v=>'sha256:'+createHash('sha256').update(v).digest('hex');
function fixture(){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'runtime-online-')),ref=path.join(root,'online.json');
 const subject={schema:'evopilot-online-configuration/v1',workspaceId:'fixture',settings:{scopes:[scope],prometheus:[{id:'metrics',origin:'http://127.0.0.1:19090',bearerTokenFile:null,freshnessSeconds:60}],alertmanager:[{id:'alerts',bearerTokenFile:path.join(root,'not-read-by-discovery')}],receiverPort:19093,tickSeconds:1}};
 const save=value=>{const config={...value,digest:nativeSha256(value)};fs.writeFileSync(ref,JSON.stringify(config),{mode:0o600});return{ref,digest:digest(config)};};
 const selection=save(subject);return{root,ref,subject,selection,save,close:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('online configuration discovery is passive, exact and preserves old schema without requiring credentials',()=>{
 const f=fixture();try{
  const value=readOnlineConfiguration(f.selection,'fixture');assert.equal(value.schema,'evopilot-online-configuration/v1');assert.equal(value.digest,nativeSha256(f.subject));assert.deepEqual(value.settings.scopes,[scope]);assert(!fs.existsSync(value.settings.alertmanager[0].bearerTokenFile));assert(Object.isFrozen(value));
  assert.throws(()=>readOnlineConfiguration(f.selection,'other'),{code:'ONLINE_CONFIGURATION_IDENTITY'});
  f.save({...f.subject,settings:{...f.subject.settings,tickSeconds:2}});assert.throws(()=>readOnlineConfiguration(f.selection,'fixture'),{code:'ONLINE_CONFIGURATION_CHANGED'});
 }finally{f.close();}
});
test('online reader rejects unknown/raw credentials, unsafe paths, duplicate connections and unbounded scheduling',()=>{
 const f=fixture();try{
  const cases=[
   [s=>s.settings.prometheus[0].token='secret','INVALID_FIELDS'],
   [s=>s.settings.alertmanager[0].bearerTokenFile='relative','ONLINE_CREDENTIAL_PATH'],
   [s=>s.settings.scopes.push({...scope}),'ONLINE_CONFIGURATION_SCOPE'],
   [s=>s.settings.prometheus.push({...s.settings.prometheus[0]}),'ONLINE_CONFIGURATION_DUPLICATE'],
   [s=>s.settings.alertmanager.push({...s.settings.alertmanager[0]}),'ONLINE_CONFIGURATION_DUPLICATE'],
   [s=>s.settings.scopes=[],'ONLINE_CONFIGURATION_LIMIT'],
   [s=>s.settings.tickSeconds=0,'ONLINE_CONFIGURATION_LIMIT'],
   [s=>s.settings.tickSeconds=301,'ONLINE_CONFIGURATION_LIMIT'],
   [s=>s.settings.receiverPort=80,'ONLINE_CONFIGURATION_LIMIT'],
   [s=>s.settings.prometheus[0].freshnessSeconds=999,'ONLINE_CONFIGURATION_LIMIT'],
  ];
  for(const [change,code] of cases){const subject=structuredClone(f.subject);change(subject);assert.throws(()=>readOnlineConfiguration(f.save(subject),'fixture'),{code});}
  f.save(f.subject);fs.chmodSync(f.ref,0o644);assert.throws(()=>readOnlineConfiguration(f.selection,'fixture'));fs.chmodSync(f.ref,0o600);
  const alias=path.join(f.root,'alias');fs.symlinkSync(f.ref,alias);assert.throws(()=>readOnlineConfiguration({...f.selection,ref:alias},'fixture'));
 }finally{f.close();}
});
test('online content checksum cannot be replaced by only updating the protected selection hash',()=>{
 const f=fixture();try{const value=JSON.parse(fs.readFileSync(f.ref));value.settings.tickSeconds=2;fs.writeFileSync(f.ref,JSON.stringify(value));assert.throws(()=>readOnlineConfiguration({ref:f.ref,digest:digest(value)},'fixture'),{code:'ONLINE_CONFIGURATION_IDENTITY'});}finally{f.close();}
});
test('online adapter rejects a fake owner distribution before import or network access',async()=>{
 const f=fixture();try{const pkg=path.join(f.root,'package');fs.mkdirSync(pkg);fs.mkdirSync(path.join(pkg,'dist'));const marker=path.join(f.root,'imported');fs.writeFileSync(path.join(pkg,'dist/online.js'),'throw new Error("not trusted");');let checks=0;
  await assert.rejects(()=>openPublishedOnlineAdapters(pkg,f.selection,'fixture',()=>checks++),{code:'OWNER_DISTRIBUTION_CHANGED'});assert.equal(checks,1);assert(!fs.existsSync(marker));
  await assert.rejects(()=>openPublishedOnlineAdapters(pkg,f.selection,'fixture',()=>{throw new ServiceError('REVOKED','revoked');}),{code:'REVOKED'});
 }finally{f.close();}
});
test('owner Host online registration is optional and restricted to its own configured project',()=>{
 const f=fixture();try{
  const ref=path.join(f.root,'owner.json'),owner={schema:'runtime-legacy-owner-host/v1',workspaceId:'fixture',projectId:'synthetic',legacyBindingRef:path.join(f.root,'binding.json'),expiresAt:'2030-01-01T00:00:00Z',owners:Object.fromEntries(['ontology','harness'].map(k=>[k,{packageRoot:f.root,calls:['native:standard.inspect']}]))};
  const read=()=>readLegacyOwnerHostConfiguration(ref),save=()=>fs.writeFileSync(ref,JSON.stringify(owner),{mode:0o600});save();assert.equal(read().online,undefined);
  owner.online=f.selection;save();assert.deepEqual(read().online,f.selection);
  owner.projectId='other';save();assert.throws(read,{code:'ONLINE_SCOPE'});
 }finally{f.close();}
});
function finding(){
 const body={schema:'evopilot-online-finding/v1',id:hash('finding'),workspaceId:'fixture',scope,bindingId:'binding',bindingDigest:hash('binding'),serviceId:'service',environment:'test',deploymentRevision:'r1',policy:{id:'policy',version:'1.0.0',digest:hash('policy'),visibility:'private',product:'harness',specVersion:'v1',producer:{product:'harness',version:'0.3.0'},contractDigest:hash('contract'),standardDigest:hash('standard'),standardLockDigest:hash('lock')},incidentId:hash('incident'),source:'evaluation',state:'FIRING',at:1767355200,evidenceDigest:hash('evidence'),causeId:hash('cause'),candidate:{kind:'regression',status:'REVIEW_REQUIRED'}};
 return{...body,digest:nativeSha256(body)};
}
test('online finding delivery uses exact authenticated Runtime HTTP identity without approval or redispatch',async()=>{
 const f=finding(),requests=[];let fail=false;
 const client={connection:{workspaceId:'fixture',projectId:'synthetic'},async request(request){requests.push(request);if(request.operation==='runtime.legacy.read')return{result:{revision:7}};if(fail)throw new ServiceError('OUTCOME_UNKNOWN','read original');return{result:{result:{id:f.incidentId,digest:hash('repair')}}};}};
 const context={workspaceId:'fixture',projectId:'synthetic',client,guard:()=>({scope}),readOwner:async()=>{throw Error('unused');}},providers=createLegacyOwnerProviders(context,'harness');
 assert.deepEqual(await providers.deliverOnlineFinding(f),{id:f.incidentId,digest:hash('repair')});assert.equal(requests.length,2);
 const request=requests[1];assert.equal(request.operation,'runtime.legacy.write');assert.equal(request.requestId,'online-finding-'+f.id.slice(7));assert.equal(request.expectedRevision,7);assert.deepEqual(request.input,{family:'online',envelope:{operation:'online.repair.ingest',scope,input:{id:f.id}}});
 assert(!Object.hasOwn(createLegacyOwnerProviders(context,'ontology'),'deliverOnlineFinding'));
 fail=true;await assert.rejects(()=>providers.deliverOnlineFinding(f),{code:'OUTCOME_UNKNOWN'});assert.equal(requests.length,4,'one attempted write, no retry');
});
test('online delivery rechecks scope after reads and rejects mismatched Runtime repair references',async()=>{
 const f=finding(),requests=[];let revoked=false,mismatch=false;
 const client={connection:{projectId:'synthetic'},async request(request){requests.push(request);if(request.operation==='runtime.legacy.read'){if(!mismatch)revoked=true;return{result:{revision:7}};}return{result:{result:{id:hash('other'),digest:hash('repair')}}};}};
 const providers=createLegacyOwnerProviders({workspaceId:'fixture',projectId:'synthetic',client,guard:()=>{if(revoked)throw new ServiceError('REVOKED','revoked');return{scope};},readOwner:async()=>null},'harness');
 await assert.rejects(()=>providers.deliverOnlineFinding(f),{code:'REVOKED'});assert.equal(requests.length,1);
 revoked=false;mismatch=true;await assert.rejects(()=>providers.deliverOnlineFinding(f),{code:'OWNER_REFERENCE_CHANGED'});
 const changed={...f,workspaceId:'other'};changed.digest=nativeSha256(Object.fromEntries(Object.entries(changed).filter(([k])=>k!=='digest')));await assert.rejects(()=>providers.deliverOnlineFinding(changed),{code:'OWNER_HOST_SCOPE'});assert.equal(requests.length,3);
});
