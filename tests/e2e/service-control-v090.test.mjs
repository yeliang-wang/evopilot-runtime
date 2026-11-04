// SYNTHETIC package inventory, real retained state and signed relocation.
// Actual installed launchd startup is verified separately with compiled bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {relocationConfigurationFixture} from '../fixtures/relocation-configuration-v090.mjs';
import {inspectInstalledServiceSelection,operateInstalledService,serviceControlCommand} from '../../dist/installation/service-control.js';
import {installerMain,verifyInstalledRuntimePackage} from '../../dist/installation/installer.js';
import {prepareRelocationConfiguration} from '../../dist/installation/workspace/configuration.js';
import {inspectMaintenanceTree} from '../../dist/installation/workspace/stream.js';
import {RuntimeStore} from '../../dist/server/store.js';
import {canonical,digest} from '../../dist/server/errors.js';
const read=p=>JSON.parse(fs.readFileSync(p)),sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex'),write=(p,v)=>{fs.mkdirSync(dirname(p),{recursive:true,mode:0o700});fs.writeFileSync(p,typeof v==='string'?v:canonical(v)+'\n',{mode:0o600});};
function fixture(t,move=false){
 const f=relocationConfigurationFixture(t,false,move,true),root=f.source.serviceRoot;
 const db=new DatabaseSync(join(f.source.workspaceRoot,'state/runtime/runtime.db'),{readOnly:true});let seal;try{seal=JSON.parse(db.prepare('SELECT data FROM runtime_service_migration').get().data);}finally{db.close();}
 const files=Object.fromEntries(inspectMaintenanceTree(join(root,'package')).filter(x=>x.kind!=='directory').map(x=>[x.path,{type:'file',sha256:x.sha256,bytes:x.bytes,mode:x.mode}]));
 const manifest={schema:'runtime-standalone-distribution/v1',version:f.spec.version,archiveDigest:'c'.repeat(64),files},manifestBytes=canonical(manifest)+'\n';
 const plan={schema:'runtime-install-plan/v1',root,distribution:{packageRoot:join(f.root,'missing-unpacked'),manifestRef:join(f.root,'missing-download-manifest'),manifestDigest:createHash('sha256').update(manifestBytes).digest('hex'),archiveRef:join(f.root,'missing-download.tgz'),archiveDigest:manifest.archiveDigest},nodeExecutable:f.spec.nodeExecutable,nodeSha256:f.spec.nodeSha256,workspaceId:f.source.workspaceId,projectId:f.spec.projectId,principalId:f.spec.principalId,role:'reader',credentialExpiresAt:f.operatorConfig.expiresAt,port:f.spec.port,integrationsRef:f.spec.integrationsRef,codex:null,legacyMigration:{workspaceRoot:f.source.workspaceRoot,expectedSnapshotDigest:seal.sourceSnapshotDigest,backupRoot:seal.backupRoot,expectedBackupDigest:seal.backupDigest}};
 for(const target of [root,...(move?[f.destination.serviceRoot]:[])]){write(join(target,'installation-plan.json'),plan);write(join(target,'distribution-manifest.json'),manifestBytes);write(join(target,'legacy-adoption.json'),{binding:f.binding,seal,authority:false});write(join(target,'installer-lock.sqlite'),'');}
 if(move){const material=prepareRelocationConfiguration(f.source,f.destination,f.ownerHost);for(const p of material.patches)write(join(f.destination.serviceRoot,p.path),p.bytes.toString());}
 return{...f,plan,selectedRoot:move?f.destination.serviceRoot:root};
}

test('current installed selection verifies retained bytes passively without source downloads or creating a new plan',async t=>{
 const f=fixture(t),before=inspectMaintenanceTree(f.root),s=inspectInstalledServiceSelection(f.selectedRoot);
 assert.equal(s.serviceId,f.source.serviceId);assert.equal(s.binding.workspaceRoot,f.source.workspaceRoot);assert.equal(s.authority,false);
 assert.equal(s.installationPlanDigest,digest(f.plan));assert.equal(s.distributionManifestDigest,f.plan.distribution.manifestDigest);
 assert.deepEqual(await serviceControlCommand(['select','--root',f.selectedRoot]),s);assert.deepEqual(inspectMaintenanceTree(f.root),before);
 assert(!JSON.stringify(s).includes('synthetic_client_credential_'));
});

test('same original installation plan remains usable at a verified relocated root after the source disappears',async t=>{
 const f=fixture(t,true),retained=fs.readFileSync(join(f.selectedRoot,'installation-plan.json'));
 for(const root of [f.source.projectRoot,f.source.workspaceRoot,f.source.serviceRoot])fs.rmSync(root,{recursive:true,force:true});fs.rmSync(f.plan.integrationsRef);
 const s=inspectInstalledServiceSelection(f.selectedRoot);assert.equal(s.serviceId,f.source.serviceId);assert.equal(s.binding.workspaceRoot,f.destination.workspaceRoot);
 assert.equal(verifyInstalledRuntimePackage(f.plan,f.selectedRoot).root,f.plan.root,'package proof keeps original plan identity');
 assert.equal((await operateInstalledService(s,'inspect')).service.registered,false);assert.deepEqual(fs.readFileSync(join(f.selectedRoot,'installation-plan.json')),retained);
});

test('changed configuration, connection, credentials or installed package invalidate the selected operation',async t=>{
 const f=fixture(t),s=inspectInstalledServiceSelection(f.selectedRoot);
 for(const relative of ['connection.json','client.json','data/auth.json','package/dist/host/header-helper.js']){
  const p=join(f.selectedRoot,relative),old=fs.readFileSync(p);fs.appendFileSync(p,'\n');await assert.rejects(operateInstalledService(s,'stop'));assert(!fs.existsSync(join(f.selectedRoot,'service-operations')));fs.writeFileSync(p,old);
 }
 const p=join(f.selectedRoot,'service-specification.json'),original=read(p);write(p,{...original,port:original.port+1});assert.throws(()=>inspectInstalledServiceSelection(f.selectedRoot),{code:'SERVICE_SELECTION_CHANGED'});write(p,original);
 const changed={...s,serviceId:'different'};changed.selectionDigest=digest(Object.fromEntries(Object.entries(changed).filter(([k])=>k!=='selectionDigest')));await assert.rejects(operateInstalledService(changed,'stop'),{code:'SERVICE_SELECTION_CHANGED'});
});

test('explicit stopped-service inspection and stop preserve history and do not stage or start anything',async t=>{
 const f=fixture(t),s=inspectInstalledServiceSelection(f.selectedRoot),old=Object.fromEntries(['installation-plan.json','legacy-adoption.json','connection.json','client.json','data/service.sqlite'].map(p=>[p,sha(join(f.selectedRoot,p))]));
 const view=await operateInstalledService(s,'inspect');assert.equal(view.serviceStarted,false);assert.equal(view.service.registered,false);
 const result=await operateInstalledService(s,'stop');assert.equal(result.operation,'stop');assert.equal(result.service.registered,false);assert.equal(result.hostRegistered,false);assert.equal(result.businessWorkDispatched,false);
 for(const [p,h] of Object.entries(old))assert.equal(sha(join(f.selectedRoot,p)),h,p);
 assert.equal(fs.readdirSync(join(f.selectedRoot,'service-operations')).length,2);
});

test('active installer and foreign ledger writer prevent service control without a replacement startup',async t=>{
 const f=fixture(t),s=inspectInstalledServiceSelection(f.selectedRoot),lock=new DatabaseSync(join(f.selectedRoot,'installer-lock.sqlite'));lock.exec('BEGIN EXCLUSIVE');
 try{await assert.rejects(operateInstalledService(s,'start'),{code:'INSTALLER_ACTIVE'});}finally{lock.close();}
 const writer=new RuntimeStore(join(f.selectedRoot,'data'),f.source.workspaceId);
 try{await assert.rejects(operateInstalledService(s,'start'),{code:'WRITER_ACTIVE'});}finally{writer.close();}
 const audit=fs.readdirSync(join(f.selectedRoot,'service-operations'));assert(audit.some(p=>p.endsWith('-failure.json')));assert(!audit.some(p=>p.endsWith('-result.json')));
});

test('replaced service ledger cannot be initialized or started under a retained service descriptor',async t=>{
 const f=fixture(t),s=inspectInstalledServiceSelection(f.selectedRoot),file=join(f.selectedRoot,'data/service.sqlite'),old=fs.readFileSync(file);
 const scratch=join(f.root,'foreign-ledger');const foreign=new RuntimeStore(scratch,f.source.workspaceId);foreign.close();fs.copyFileSync(join(scratch,'service.sqlite'),file);
 await assert.rejects(operateInstalledService(s,'start'),{code:'SERVICE_SELECTION_CHANGED'});assert.deepEqual(fs.readFileSync(file),fs.readFileSync(join(scratch,'service.sqlite')));fs.writeFileSync(file,old);
});

test('installer CLI exposes explicit current selection without restaging and refuses loose argument forms',async t=>{
 const f=fixture(t),out=[];assert.equal(await installerMain(['service','select','--root',f.selectedRoot],{write:s=>out.push(s)}),0);
 const selected=JSON.parse(out.pop()),ref=join(f.root,'selected-service.json');write(ref,selected);
 assert.equal(await installerMain(['service','inspect','--selection-ref',ref],{write:s=>out.push(s)}),0);assert.equal(JSON.parse(out.pop()).service.registered,false);
 for(const args of [['start','--root',f.selectedRoot],['select','--root',f.selectedRoot,'extra'],['execute','--selection-ref',ref],['stop','--selection-ref',ref,'--shell','evil']])await assert.rejects(serviceControlCommand(args),{code:'SERVICE_OPERATION_INVALID'});
 fs.chmodSync(ref,0o644);await assert.rejects(serviceControlCommand(['stop','--selection-ref',ref]),{code:'UNSAFE_STATE'});
});
