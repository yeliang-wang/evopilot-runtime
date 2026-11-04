// SYNTHETIC package/old-domain fixtures, native stopped installer + SQLite
// preservation paths. No services, provider jobs, Codex or models are started.
// These regressions do not substitute for the installed EX10 acceptance run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {canonical} from '../../dist/server/errors.js';
import {RuntimeStore} from '../../dist/server/store.js';
import {runInstaller,prepareStagedHostMaterial,installerMain} from '../../dist/installation/installer.js';
import {inspectInstalledServiceSelection} from '../../dist/installation/service-control.js';
import {inspectServiceUpgradeSource,migrateStoppedService,rollbackStoppedService,acquireUpgradeSourceLease,serviceUpgradeCommand} from '../../dist/installation/service-upgrade.js';
import {inspectMaintenanceTree} from '../../dist/installation/workspace/stream.js';
import {byteDigest,loadPublisherBase} from '../../dist/lifecycle/base.js';
import {loadServiceUpgradeContext,verifyHistoricalRecord} from '../../dist/lifecycle/base-upgrade.js';
import {PLUGIN_STATIC_FILES} from '../../dist/host/plugin.js';
import {historicalSource} from '../fixtures/base-upgrade-v090.mjs';

const repo=fs.realpathSync(fileURLToPath(new URL('../../',import.meta.url))),node=fs.realpathSync(process.execPath);
const hash=v=>createHash('sha256').update(v).digest('hex'),read=p=>JSON.parse(fs.readFileSync(p));
const write=(p,v,mode=0o600)=>{fs.mkdirSync(dirname(p),{mode:0o700,recursive:true});fs.writeFileSync(p,typeof v==='string'||Buffer.isBuffer(v)?v:canonical(v)+'\n',{mode});};
const originalTree=root=>inspectMaintenanceTree(root).filter(e=>!['installer-lock.sqlite','data/writer-lock.sqlite'].some(n=>[n,n+'-wal',n+'-shm',n+'-journal'].includes(e.path)));
function distribution(root,name,base){
  const packageRoot=join(root,name+'-package'),version=name==='a'?'0.9.0-ex10-a':read(join(repo,'package.json')).version;
  const content={'package.json':JSON.stringify({name:'@evopilot-next/runtime',version}),'dist/server/cli.js':'#!/usr/bin/env node\n// SYNTHETIC inventory only: never executed\n','dist/host/header-helper.js':'// SYNTHETIC helper only: never executed\n','plugins/codex/mcp.template.json':fs.readFileSync(join(repo,'plugins/codex/mcp.template.json')),'lifecycle/base/manifest.json':base.manifest};
  content['lifecycle/base/'+JSON.parse(base.manifest).bases[0].file]=base.bytes;
  for(const relative of PLUGIN_STATIC_FILES){let bytes=fs.readFileSync(join(repo,'plugins/codex',relative));if(relative==='.codex-plugin/plugin.json')bytes=Buffer.from(JSON.stringify({...JSON.parse(bytes),version}));content['plugins/codex/'+relative]=bytes;}
  const files={};for(const [relative,value] of Object.entries(content)){const bytes=Buffer.from(value);write(join(packageRoot,relative),bytes,0o644);files[relative]={type:'file',bytes:bytes.length,sha256:hash(bytes),mode:0o644};}
  const archiveRef=join(root,name+'-synthetic-archive'),archive=Buffer.from('SYNTHETIC exact package inventory '+name+'; not a published release');write(archiveRef,archive);
  const manifestRef=join(root,name+'-distribution.json'),manifest={schema:'runtime-standalone-distribution/v1',version,archiveDigest:hash(archive),files};write(manifestRef,manifest);
  return{packageRoot,manifestRef,manifestDigest:hash(fs.readFileSync(manifestRef)),archiveRef,archiveDigest:manifest.archiveDigest};
}
async function fixture(t){
  const root=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'runtime-service-upgrade-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const original=historicalSource(),old=original.old,current={manifest:fs.readFileSync(join(repo,'lifecycle/base/manifest.json')),bytes:fs.readFileSync(join(repo,'lifecycle/base/software-release-0.9.0.json'))};
  const common={schema:'runtime-install-plan/v1',nodeExecutable:node,nodeSha256:hash(fs.readFileSync(node)),workspaceId:'service-upgrade-test',projectId:'alpha',principalId:'fixture-owner',role:'operator',credentialExpiresAt:new Date(Date.now()+86400000).toISOString(),integrationsRef:null,codex:null};
  const a={...common,root:join(root,'a'),distribution:distribution(root,'a',old),port:33541},b={...common,root:join(root,'b'),distribution:distribution(root,'b',current),port:33542};
  await runInstaller(a,'stage');const store=new RuntimeStore(join(a.root,'data'),a.workspaceId),serviceId=store.serviceId;
  const actor={id:a.principalId,projects:['alpha'],permissions:['read','draft.write','definition.activate','execution.request','decision.record','release.request'],revision:1,expiresAt:a.credentialExpiresAt};
  const objects=[{kind:'definition-revision',id:original.revision.id,value:original.revision},{kind:'lifecycle-instance',id:original.instance.id,value:original.instance},{kind:'definition-pointer',id:'active',value:{revisionId:original.revision.id}}];
  const receipt=store.mutate(actor,{projectId:'alpha',operation:'synthetic.fixture-history',requestId:'original-history',input:{synthetic:true},expectedRevision:0,permission:'draft.write'},()=>({objects,value:{synthetic:true},event:{type:'synthetic-fixture-history',data:{installedAcceptance:false}}}),()=>actor);store.close();
  prepareStagedHostMaterial(a,serviceId);const selected=inspectInstalledServiceSelection(a.root),destinationInstallPlanRef=join(root,'b-plan.json');write(destinationInstallPlanRef,b);
  const base={schema:'runtime-service-upgrade-plan/v1',requestId:'upgrade-fixture',source:selected,backupRoot:join(root,'backup'),destinationInstallPlanRef,destinationInstallPlanSha256:byteDigest(fs.readFileSync(destinationInstallPlanRef))};
  async function plan(){const view=await inspectServiceUpgradeSource(selected);return{...base,expectedSourceSnapshotDigest:view.sourceSnapshotDigest};}
  function change(objects,id='later-fixture') {const s=new RuntimeStore(join(a.root,'data'),a.workspaceId);try{s.mutate(actor,{projectId:'alpha',operation:'synthetic.fixture-change',requestId:id,input:{synthetic:true},expectedRevision:s.revision('alpha'),permission:'draft.write'},()=>({objects,value:{synthetic:true},event:{type:'synthetic-fixture-change',data:{installedAcceptance:false}}}),()=>actor);}finally{s.close();}}
  return{root,a,b,original,actor,serviceId,receipt,selected,base,plan,change};
}
async function platformOrInspect(f){if(process.platform==='darwin')return true;await assert.rejects(inspectServiceUpgradeSource(f.selected),{code:'SERVICE_PLATFORM'});return false;}

test('stopped native snapshot retains all business tables, original record pins, auth and exact package bytes without opening the original ledger',async t=>{
  const f=await fixture(t);if(!await platformOrInspect(f))return;const before=originalTree(f.a.root),ledger=fs.readFileSync(join(f.a.root,'data/service.sqlite'));
  const first=await inspectServiceUpgradeSource(f.selected),second=await inspectServiceUpgradeSource(f.selected);assert.deepEqual(second,first);assert.deepEqual(originalTree(f.a.root),before);assert.deepEqual(fs.readFileSync(join(f.a.root,'data/service.sqlite')),ledger);
  assert.equal(first.snapshot.serviceId,f.serviceId);assert.equal(first.snapshot.historicalRecords.length,2);assert.equal(first.snapshot.sourceBasePin.digest,f.original.old.pin.digest);
  for(const name of ['service_meta','project_revisions','objects','receipts','events','audit'])assert(first.snapshot.database.tables.some(t=>t.name===name));
  assert.equal(first.snapshot.database.tables.find(t=>t.name==='receipts').rows,1);assert.equal(first.snapshot.database.tables.find(t=>t.name==='audit').rows,1);
  const encoded=JSON.stringify(first),token=read(join(f.a.root,'client.json')).token;assert(!encoded.includes(token));assert(!fs.existsSync(f.base.backupRoot));
});

test('upgrade stages only a distinct current Base package while preserving service identity, exact original DB, credentials, history and request replay',async t=>{
  const f=await fixture(t);if(!await platformOrInspect(f))return;const plan=await f.plan(),before=originalTree(f.a.root),ledger=fs.readFileSync(join(f.a.root,'data/service.sqlite')),auth=fs.readFileSync(join(f.a.root,'data/auth.json')),client=fs.readFileSync(join(f.a.root,'client.json'));
  const result=await migrateStoppedService(plan);assert.equal(result.status,'STAGED');assert.equal(result.serviceStarted,false);assert.equal(result.hostRegistered,false);assert.equal(result.businessWorkDispatched,false);assert.equal(result.authority,false);
  assert.deepEqual(result.destinationBasePin,loadPublisherBase().pin);assert.deepEqual(result.sourceBasePin,f.original.old.pin);assert.equal(result.serviceId,f.serviceId);assert.deepEqual(originalTree(f.a.root),before);
  assert.deepEqual(fs.readFileSync(join(f.b.root,'data/service.sqlite')),ledger);assert.deepEqual(fs.readFileSync(join(f.b.root,'data/auth.json')),auth);assert.deepEqual(fs.readFileSync(join(f.b.root,'client.json')),client);
  assert(!fs.existsSync(join(f.b.root,'service.plist')));assert(fs.existsSync(join(f.b.root,'plugin/.mcp.json')));
  const context=loadServiceUpgradeContext(join(f.b.root,'data'),f.a.workspaceId,f.serviceId);assert(context);assert(verifyHistoricalRecord(context,'alpha','definition-revision',f.original.revision.id,f.original.revision));
  const b=new RuntimeStore(join(f.b.root,'data'),f.b.workspaceId);try{assert.deepEqual(b.receipt(f.actor,'alpha','original-history'),f.receipt);assert.equal(b.revision('alpha'),1);}finally{b.close();}
  assert.deepEqual(await migrateStoppedService(plan),result,'exact replay returns original staged receipt, not a new migration');
  await assert.rejects(migrateStoppedService({...plan,requestId:'different'}),{code:'SERVICE_UPGRADE_REQUEST_CONFLICT'});
  assert(!JSON.stringify(result).includes(read(join(f.a.root,'client.json')).token));
});

test('missing original index is rejected without silently repairing or changing the original schema and database bytes',async t=>{
  const f=await fixture(t);if(!await platformOrInspect(f))return;
  const ref=join(f.a.root,'data/service.sqlite'),db=new DatabaseSync(ref);try{db.exec('DROP INDEX events_project_seq');}finally{db.close();}
  const bytes=fs.readFileSync(ref),before=originalTree(f.a.root);
  await assert.rejects(inspectServiceUpgradeSource(f.selected),{code:'SERVICE_UPGRADE_DATABASE_CHANGED'});
  assert.deepEqual(fs.readFileSync(ref),bytes);assert.deepEqual(originalTree(f.a.root),before);assert(!fs.existsSync(f.b.root));assert(!fs.existsSync(f.base.backupRoot));
});

test('original writer/installer contention, unresolved stage request and RUNNING/UNKNOWN work are all rejected without migration or redispatch',async t=>{
  const f=await fixture(t);if(!await platformOrInspect(f))return;
  for(const file of ['installer-lock.sqlite','data/writer-lock.sqlite']){const lock=new DatabaseSync(join(f.a.root,file));lock.exec('BEGIN EXCLUSIVE');try{await assert.rejects(inspectServiceUpgradeSource(f.selected),{code:file.startsWith('data')?'WRITER_ACTIVE':'INSTALLER_ACTIVE'});}finally{lock.close();}}
  for(const status of ['RUNNING','UNKNOWN']){const value=structuredClone(f.original.instance);Object.values(value.stages)[0].status=status;f.change([{kind:'lifecycle-instance',id:value.id,value}],'status-'+status.toLowerCase());await assert.rejects(inspectServiceUpgradeSource(f.selected),{code:'SERVICE_UPGRADE_PENDING'});}
  f.change([{kind:'lifecycle-instance',id:f.original.instance.id,value:f.original.instance},{kind:'stage-request',id:'orphan-request',value:{id:'orphan-request'}}],'orphan');await assert.rejects(inspectServiceUpgradeSource(f.selected),{code:'SERVICE_UPGRADE_PENDING'});
  f.change([{kind:'stage-progress',id:'orphan-request',value:{terminal:false}}],'incomplete');await assert.rejects(inspectServiceUpgradeSource(f.selected),{code:'SERVICE_UPGRADE_PENDING'});
  f.change([{kind:'stage-progress',id:'orphan-request',value:{terminal:true}}],'reconciled-fixture');assert((await inspectServiceUpgradeSource(f.selected)).sourceSnapshotDigest);assert(!fs.existsSync(f.b.root));assert(!fs.existsSync(f.base.backupRoot));
});

test('reviewed source drift, archive corruption, destination conflict and authority expansion never overwrite original data',async t=>{
  const f=await fixture(t);if(!await platformOrInspect(f))return;const plan=await f.plan();f.change([{kind:'fixture-evidence',id:'later',value:{retain:true}}]);const old=fs.readFileSync(join(f.a.root,'data/service.sqlite'));
  await assert.rejects(migrateStoppedService(plan),{code:'SERVICE_UPGRADE_SOURCE_CHANGED'});assert(!fs.existsSync(f.b.root));assert(!fs.existsSync(f.base.backupRoot));
  const fresh=await f.plan(),originalPlan=fs.readFileSync(f.base.destinationInstallPlanRef);write(f.base.destinationInstallPlanRef,{...f.b,role:'reader'});
  await assert.rejects(migrateStoppedService({...fresh,destinationInstallPlanSha256:byteDigest(fs.readFileSync(f.base.destinationInstallPlanRef))}),{code:'SERVICE_UPGRADE_AUTHORITY'});fs.writeFileSync(f.base.destinationInstallPlanRef,originalPlan);
  write(join(f.b.root,'foreign.txt'),'must remain');await assert.rejects(migrateStoppedService(fresh),{code:'SERVICE_UPGRADE_DESTINATION'});assert.equal(fs.readFileSync(join(f.b.root,'foreign.txt'),'utf8'),'must remain');assert.deepEqual(fs.readFileSync(join(f.a.root,'data/service.sqlite')),old);
});

test('destination archive rejection keeps the original and retained partial evidence, and does not silently retry or erase it',async t=>{
  const f=await fixture(t);if(!await platformOrInspect(f))return;const plan=await f.plan(),before=originalTree(f.a.root);fs.appendFileSync(f.b.distribution.archiveRef,'changed');
  await assert.rejects(migrateStoppedService(plan),{code:'INSTALLATION_DIGEST'});assert.deepEqual(originalTree(f.a.root),before);assert(fs.existsSync(join(plan.backupRoot,'snapshot.json')));assert(!fs.existsSync(join(plan.backupRoot,'upgrade-receipt.json')));
  const failed=originalTree(f.b.root);await assert.rejects(migrateStoppedService(plan),{code:'SERVICE_UPGRADE_DESTINATION'});assert.deepEqual(originalTree(f.b.root),failed);
});

test('upgrade preserves a selected current integration reference and cannot reset it to the old immutable installation plan',async t=>{
  const f=await fixture(t);if(!await platformOrInspect(f))return;
  // Explicit synthetic representation of an already completed native config
  // transition. The source installation plan itself remains immutable.
  const ref=join(f.root,'current-integrations.json');write(ref,{schema:'synthetic-current-integrations/v1',retain:'selected-current-config'});
  const specRef=join(f.a.root,'service-specification.json'),spec=read(specRef);write(specRef,{...spec,integrationsRef:ref});
  assert.equal(read(join(f.a.root,'installation-plan.json')).integrationsRef,null);
  const source=inspectInstalledServiceSelection(f.a.root),view=await inspectServiceUpgradeSource(source),plan={...f.base,source,expectedSourceSnapshotDigest:view.sourceSnapshotDigest};
  assert(view.snapshot.references.some(r=>r.path===ref));
  await assert.rejects(migrateStoppedService(plan),{code:'SERVICE_UPGRADE_AUTHORITY'});assert(!fs.existsSync(f.b.root));assert(!fs.existsSync(f.base.backupRoot));
  write(f.base.destinationInstallPlanRef,{...f.b,integrationsRef:ref});const fixed={...plan,destinationInstallPlanSha256:byteDigest(fs.readFileSync(f.base.destinationInstallPlanRef))};
  await migrateStoppedService(fixed);assert.equal(read(join(f.b.root,'service-specification.json')).integrationsRef,ref);assert.equal(read(join(f.b.root,'installation-plan.json')).integrationsRef,ref);assert.equal(read(join(f.a.root,'installation-plan.json')).integrationsRef,null);
  assert.equal(fs.readFileSync(ref,'utf8'),fs.readFileSync(join(fixed.backupRoot,'references',hash(JSON.stringify(ref))),'utf8'));
});

test('B startup lease holds A writer and installer locks, checks source bytes, and releases every handle on failure or close',async t=>{
  const f=await fixture(t);if(!await platformOrInspect(f))return;const result=await migrateStoppedService(await f.plan()),sourceDb=fs.readFileSync(join(f.a.root,'data/service.sqlite'));
  assert.equal(await acquireUpgradeSourceLease(join(f.a.root,'data')),null);
  const lease=await acquireUpgradeSourceLease(join(f.b.root,'data'));assert(lease);
  try{assert.throws(()=>new RuntimeStore(join(f.a.root,'data'),f.a.workspaceId),{code:'WRITER_ACTIVE'});await assert.rejects(runInstaller(f.a,'stage'),{code:'INSTALLER_ACTIVE'});await assert.rejects(acquireUpgradeSourceLease(join(f.b.root,'data')),{code:'INSTALLER_ACTIVE'});}finally{lease.close();lease.close();}
  assert.deepEqual(fs.readFileSync(join(f.a.root,'data/service.sqlite')),sourceDb);
  write(join(f.a.root,'new-evidence.json'),{retained:true});await assert.rejects(acquireUpgradeSourceLease(join(f.b.root,'data')),{code:'SERVICE_UPGRADE_SOURCE_CHANGED'});
  const writer=new RuntimeStore(join(f.a.root,'data'),f.a.workspaceId);writer.close();assert.equal(result.serviceStarted,false);
});

test('backup/context tampering is rejected before any source writer lease can remain held',async t=>{
  const f=await fixture(t);if(!await platformOrInspect(f))return;await migrateStoppedService(await f.plan());
  const ref=join(f.base.backupRoot,'base.json'),original=fs.readFileSync(ref);fs.appendFileSync(ref,'\n');await assert.rejects(acquireUpgradeSourceLease(join(f.b.root,'data')),{code:'SERVICE_UPGRADE_BACKUP_CHANGED'});fs.writeFileSync(ref,original);
  const contextRef=join(f.b.root,'data/service-upgrade.json'),context=read(contextRef);write(contextRef,{...context,sourceArchiveDigest:'sha256:'+'0'.repeat(64)});await assert.rejects(acquireUpgradeSourceLease(join(f.b.root,'data')),{code:'SERVICE_UPGRADE_SOURCE_CHANGED'});write(contextRef,context);
  const lease=await acquireUpgradeSourceLease(join(f.b.root,'data'));lease.close();const writer=new RuntimeStore(join(f.a.root,'data'),f.a.workspaceId);writer.close();
});

async function rollbackPlan(f){const destination=inspectInstalledServiceSelection(f.b.root),view=await inspectServiceUpgradeSource(destination),upgradeReceiptRef=join(f.base.backupRoot,'upgrade-receipt.json');return{schema:'runtime-service-rollback-plan/v1',requestId:'rollback-fixture',upgradeReceiptRef,upgradeReceiptSha256:byteDigest(fs.readFileSync(upgradeReceiptRef)),destination,expectedDestinationSnapshotDigest:view.sourceSnapshotDigest,preservationRoot:join(f.root,'preserved-b')};}
test('rollback preserves every new B receipt before returning intact original A ready, without overwriting or starting either installation',async t=>{
  const f=await fixture(t);if(!await platformOrInspect(f))return;await migrateStoppedService(await f.plan());const original=originalTree(f.a.root);
  const b=new RuntimeStore(join(f.b.root,'data'),f.b.workspaceId);b.mutate(f.actor,{projectId:'alpha',operation:'synthetic.b-evidence',requestId:'b-new-evidence',input:{synthetic:true},expectedRevision:1,permission:'draft.write'},()=>({objects:[{kind:'fixture-evidence',id:'b',value:{preserve:true}}],value:{preserve:true},event:{type:'synthetic-b-evidence',data:{preserve:true}}}),()=>f.actor);b.close();
  const plan=await rollbackPlan(f),before=originalTree(f.b.root),result=await rollbackStoppedService(plan);assert.equal(result.status,'ORIGINAL_READY');assert.equal(result.serviceStarted,false);assert.equal(result.destinationRetained,true);assert.deepEqual(originalTree(f.b.root),before);assert.deepEqual(originalTree(f.a.root),original);
  assert.deepEqual(inspectMaintenanceTree(join(plan.preservationRoot,'service')),before);assert.equal(read(join(plan.preservationRoot,'snapshot.json')).database.tables.find(t=>t.name==='receipts').rows,2);
  assert.deepEqual(await rollbackStoppedService(plan),result);assert(!fs.existsSync(join(f.a.root,'service.plist')));assert(!fs.existsSync(join(f.b.root,'service.plist')));
});

test('rollback restores only the missing original path, retains B, and recreates excluded locks without altering original business bytes',async t=>{
  const f=await fixture(t);if(!await platformOrInspect(f))return;await migrateStoppedService(await f.plan());const original=originalTree(f.a.root),plan=await rollbackPlan(f);fs.rmSync(f.a.root,{recursive:true});
  const result=await rollbackStoppedService(plan);assert.equal(result.originalRoot,f.a.root);assert.deepEqual(originalTree(f.a.root),original);assert(fs.existsSync(join(f.b.root,'data/service.sqlite')));const s=new RuntimeStore(join(f.a.root,'data'),f.a.workspaceId);try{assert.deepEqual(s.receipt(f.actor,'alpha','original-history'),f.receipt);}finally{s.close();}
});

test('rollback will preserve B but refuse to overwrite newer original A records',async t=>{
  const f=await fixture(t);if(!await platformOrInspect(f))return;await migrateStoppedService(await f.plan());const plan=await rollbackPlan(f);f.change([{kind:'fixture-evidence',id:'a-new',value:{preserve:true}}]);const original=originalTree(f.a.root),b=originalTree(f.b.root);
  await assert.rejects(rollbackStoppedService(plan),{code:'SERVICE_UPGRADE_RESTORE_CONFLICT'});assert.deepEqual(originalTree(f.a.root),original);assert.deepEqual(originalTree(f.b.root),b);assert(fs.existsSync(join(plan.preservationRoot,'snapshot.json')));assert(!fs.existsSync(join(plan.preservationRoot,'rollback-receipt.json')));
});

test('CLI exposes only protected exact inspect/migrate/rollback arguments and returns no raw credentials',async t=>{
  const f=await fixture(t);for(const args of [[],['start','--plan-ref',f.base.destinationInstallPlanRef],['inspect','--root',f.a.root],['migrate','--plan-ref',f.base.destinationInstallPlanRef,'--token','raw-secret']])await assert.rejects(serviceUpgradeCommand(args),{code:'SERVICE_UPGRADE_ARGUMENT'});
  const ref=join(f.root,'selected.json');write(ref,f.selected);let output='';const result=await installerMain(['service-upgrade','inspect','--selection-ref',ref],{write:s=>output+=s});assert.equal(result,process.platform==='darwin'?0:1);assert(!output.includes(read(join(f.a.root,'client.json')).token));
  fs.chmodSync(ref,0o644);await assert.rejects(serviceUpgradeCommand(['inspect','--selection-ref',ref]));
});
