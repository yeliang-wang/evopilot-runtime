// SYNTHETIC material tests; real dependency validation and stopped publication
// are separate. Rendering never claims that the supplied dependencies are ready.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {join,dirname} from 'node:path';import {createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
import {relocationConfigurationFixture} from '../fixtures/relocation-configuration-v090.mjs';
import {prepareRelocationConfiguration} from '../../dist/installation/workspace/configuration.js';
import {inspectMaintenanceTree} from '../../dist/installation/workspace/stream.js';
import {canonical,canonicalEvidence,digest} from '../../dist/server/errors.js';
import {runtimePluginMaterial} from '../../dist/host/plugin.js';
import {readRegisteredNativeToolchain,readIntegrationConfiguration} from '../../dist/adapters/config.js';
import {renderInstalledToolchainRegistration,prepareInstalledToolchainRegistration} from '../../dist/installation/toolchain/registration.js';
const read=p=>JSON.parse(fs.readFileSync(p)),sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex'),write=(p,v)=>{fs.mkdirSync(dirname(p),{recursive:true,mode:0o700});fs.writeFileSync(p,typeof v==='string'?v:canonical(v)+'\n',{mode:0o600});};
function fixture(t,move=false){
 const f=relocationConfigurationFixture(t,true,move,true),root=f.source.serviceRoot;
 const sealCopy=join(f.root,'seal-copy.sqlite');fs.copyFileSync(join(f.source.workspaceRoot,'state/runtime/runtime.db'),sealCopy);const db=new DatabaseSync(sealCopy,{readOnly:true});let seal;try{seal=JSON.parse(db.prepare('SELECT data FROM runtime_service_migration').get().data);}finally{db.close();for(const suffix of ['', '-wal','-shm'])fs.rmSync(sealCopy+suffix,{force:true});}
 const files=Object.fromEntries(inspectMaintenanceTree(join(root,'package')).filter(x=>x.kind!=='directory').map(x=>[x.path,{type:'file',sha256:x.sha256,bytes:x.bytes,mode:x.mode}]));
 const manifest={schema:'runtime-standalone-distribution/v1',version:f.spec.version,archiveDigest:'c'.repeat(64),files},manifestBytes=canonical(manifest)+'\n';
 const plan={schema:'runtime-install-plan/v1',root,distribution:{packageRoot:join(f.root,'missing-unpacked'),manifestRef:join(f.root,'missing-download-manifest'),manifestDigest:createHash('sha256').update(manifestBytes).digest('hex'),archiveRef:join(f.root,'missing-download.tgz'),archiveDigest:manifest.archiveDigest},nodeExecutable:f.spec.nodeExecutable,nodeSha256:f.spec.nodeSha256,workspaceId:f.source.workspaceId,projectId:f.spec.projectId,principalId:f.spec.principalId,role:'reader',credentialExpiresAt:f.operatorConfig.expiresAt,port:f.spec.port,integrationsRef:f.spec.integrationsRef,codex:null,legacyProviders:f.spec.legacyProviders,legacyOwnerHost:{ref:f.ownerHost.ownerConfigRef,digest:f.ownerHost.ownerConfigDigest},legacyMigration:{workspaceRoot:f.source.workspaceRoot,expectedSnapshotDigest:seal.sourceSnapshotDigest,backupRoot:seal.backupRoot,expectedBackupDigest:seal.backupDigest}};
 for(const target of [root,...(move?[f.destination.serviceRoot]:[])]){write(join(target,'installation-plan.json'),plan);write(join(target,'distribution-manifest.json'),manifestBytes);write(join(target,'legacy-adoption.json'),{binding:f.binding,seal,authority:false});write(join(target,'installer-lock.sqlite'),'');}
 if(move){const material=prepareRelocationConfiguration(f.source,f.destination,f.ownerHost);for(const p of material.patches)write(join(f.destination.serviceRoot,p.path),p.bytes.toString());}
 return{...f,plan,selectedRoot:move?f.destination.serviceRoot:root};
}


const described=f=>{const environmentRoot=join(f.source.workspaceRoot,'native-toolchain','synthetic-fixed-environment'),file=join(environmentRoot,'python');return{schema:'evopilot-native-toolchain/v1',lockDigest:'sha256:'+'a'.repeat(64),platform:process.platform,arch:process.arch,tools:Object.fromEntries(['python','pyshacl','opa','conftest'].map(name=>[name,{executable:file,sha256:'b'.repeat(64),version:'synthetic'}])),dependencyLockDigest:'sha256:'+'c'.repeat(64),environmentRoot,dependencyFiles:[{path:file,sha256:'b'.repeat(64)}],timeoutMs:60000,maxInputBytes:1048576,maxPackageBytes:1048576};};
const rendered=f=>renderInstalledToolchainRegistration(f.selectedRoot,described(f));
const patch=(m,ref)=>JSON.parse(m.patches.find(p=>join(m.selection.serviceRoot,p.path)===ref).content);

import {applyInstalledToolchainRegistration,inspectToolchainApplication,toolchainApplicationCommand} from '../../dist/installation/toolchain/application.js';
import {acquireManagedLegacyContext} from '../../dist/compat/managed-store.js';
import {RuntimeStore} from '../../dist/server/store.js';
const claimed=f=>{const m={...rendered(f),dependenciesVerified:true};const {materialDigest,...body}=m;return{...body,materialDigest:createHash('sha256').update(canonicalEvidence(body)).digest('hex')};};
const rehash=m=>{const {materialDigest,...body}=m;return{...body,materialDigest:createHash('sha256').update(canonicalEvidence(body)).digest('hex')};};

test('rendered descriptions cannot apply and a caller true flag cannot bypass fixed dependency inspection',async t=>{
 const f=fixture(t),before=inspectMaintenanceTree(f.root);
 await assert.rejects(applyInstalledToolchainRegistration(rendered(f)),{code:'TOOLCHAIN_APPLICATION_INVALID'});assert.deepEqual(inspectMaintenanceTree(f.root),before);
 await assert.rejects(applyInstalledToolchainRegistration(claimed(f)),{code:'TOOLCHAIN_NOT_READY'});
 assert(!fs.existsSync(join(f.selectedRoot,'toolchain-bindings')));assert.deepEqual(read(join(f.selectedRoot,'service-specification.json')),f.spec);
});

test('mutated plans, foreign destinations, credential patches and changed candidate content are rejected',async t=>{
 const f=fixture(t),m=claimed(f),before=inspectMaintenanceTree(f.root);
 for(const path of ['../escape.json','client.json','data/auth.json','package/dist/server/cli.js']){
  const changed=structuredClone(m);changed.patches[0].path=path;await assert.rejects(applyInstalledToolchainRegistration(rehash(changed)),{code:'TOOLCHAIN_APPLICATION_CHANGED'});
 }
 const content=structuredClone(m);content.patches[0].content+=' ';await assert.rejects(applyInstalledToolchainRegistration(rehash(content)),{code:'TOOLCHAIN_APPLICATION_CHANGED'});
 await assert.rejects(applyInstalledToolchainRegistration({...m,materialDigest:'a'.repeat(64)}),{code:'TOOLCHAIN_APPLICATION_INVALID'});assert.deepEqual(inspectMaintenanceTree(f.root),before);
});

test('inspection is passive and does not reinterpret an unstarted material as approval or readiness',t=>{
 const f=fixture(t),m=claimed(f),before=inspectMaintenanceTree(f.root),view=inspectToolchainApplication(m);assert.equal(view.status,'NOT_STARTED');assert.equal(view.authority,false);assert.equal(view.serviceStarted,false);assert.deepEqual(inspectMaintenanceTree(f.root),before);
});

test('installer and service writer exclusion prevent initial admission',async t=>{
 const f=fixture(t),m=claimed(f),installer=new DatabaseSync(join(f.selectedRoot,'installer-lock.sqlite'));installer.exec('BEGIN EXCLUSIVE');
 try{await assert.rejects(applyInstalledToolchainRegistration(m),{code:'INSTALLER_ACTIVE'});}finally{installer.close();}
 const writer=new RuntimeStore(join(f.selectedRoot,'data'),f.source.workspaceId);
 try{await assert.rejects(applyInstalledToolchainRegistration(m),{code:'WRITER_ACTIVE'});}finally{writer.close();}
 assert(!fs.existsSync(join(f.selectedRoot,'toolchain-bindings')));
});

test('another managed writer prevents changing native bindings',async t=>{
 const f=fixture(t),m=claimed(f),lease=acquireManagedLegacyContext(f.binding);
 try{await assert.rejects(applyInstalledToolchainRegistration(m),{code:'LEGACY_WRITER_ACTIVE'});}finally{lease.close();}
 assert(!fs.existsSync(join(f.selectedRoot,'toolchain-bindings')));
});

test('aborted application and loose or unprotected CLI input do not publish configuration',async t=>{
 const f=fixture(t),m=claimed(f),signal=AbortSignal.abort();await assert.rejects(applyInstalledToolchainRegistration(m,signal));assert(!fs.existsSync(join(f.selectedRoot,'toolchain-bindings')));
 for(const args of [['apply','--root',f.selectedRoot],['inspect','--material-ref',f.root,'extra'],['run','--material-ref',f.root]])await assert.rejects(toolchainApplicationCommand(args),{code:'TOOLCHAIN_APPLICATION_ARGUMENT'});
 const file=join(f.root,'material.json');write(file,m);assert.equal((await toolchainApplicationCommand(['inspect','--material-ref',file])).status,'NOT_STARTED');fs.chmodSync(file,0o644);await assert.rejects(toolchainApplicationCommand(['apply','--material-ref',file]));
});
