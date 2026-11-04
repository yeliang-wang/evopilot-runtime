// SYNTHETIC material tests; real dependency validation and stopped publication
// are separate. Rendering never claims that the supplied dependencies are ready.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {join,dirname} from 'node:path';import {createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
import {relocationConfigurationFixture} from '../fixtures/relocation-configuration-v090.mjs';
import {prepareRelocationConfiguration} from '../../dist/installation/workspace/configuration.js';
import {inspectMaintenanceTree} from '../../dist/installation/workspace/stream.js';
import {canonical,digest} from '../../dist/server/errors.js';
import {runtimePluginMaterial} from '../../dist/host/plugin.js';
import {readRegisteredNativeToolchain,readIntegrationConfiguration} from '../../dist/adapters/config.js';
import {renderInstalledToolchainRegistration,prepareInstalledToolchainRegistration} from '../../dist/installation/toolchain/registration.js';
const read=p=>JSON.parse(fs.readFileSync(p)),sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex'),write=(p,v)=>{fs.mkdirSync(dirname(p),{recursive:true,mode:0o700});fs.writeFileSync(p,typeof v==='string'?v:canonical(v)+'\n',{mode:0o600});};
function fixture(t,move=false){
 const f=relocationConfigurationFixture(t,true,move,true),root=f.source.serviceRoot;
 const db=new DatabaseSync(join(f.source.workspaceRoot,'state/runtime/runtime.db'),{readOnly:true});let seal;try{seal=JSON.parse(db.prepare('SELECT data FROM runtime_service_migration').get().data);}finally{db.close();}
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

test('passive material preserves every scope and permission while pinning one shared manifest',t=>{
 const f=fixture(t),snapshot=inspectMaintenanceTree(f.root),m=rendered(f);
 assert.equal(m.dependenciesVerified,false);assert.equal(m.filesWritten,false);assert.equal(m.authority,false);assert.equal(m.serviceStarted,false);assert.equal(m.hostReconnectRequired,true);assert.deepEqual(inspectMaintenanceTree(f.root),snapshot);assert.deepEqual(rendered(f),m);
 const owner=patch(m,m.hostAfter.ownerConfigRef),oldOwner=read(f.ownerHost.ownerConfigRef);assert.deepEqual({...owner,nativeToolchain:undefined},{...oldOwner,nativeToolchain:undefined});assert.deepEqual(owner.nativeToolchain,m.registration);
 const provider=patch(m,m.specification.legacyProviders.ref),oldProvider=read(f.spec.legacyProviders.ref);assert.deepEqual({...provider,nativeToolchain:oldProvider.nativeToolchain},oldProvider);assert.deepEqual(provider.nativeToolchain,m.registration);
 const integration=patch(m,m.specification.integrationsRef);assert.equal(integration.revision,f.integrations.revision+1);assert.deepEqual({...integration,revision:f.integrations.revision,nativeToolchain:undefined},{...f.integrations,nativeToolchain:undefined});
 const operator=patch(m,m.hostAfter.workspaceConfigRef);assert.deepEqual(operator.calls,f.operatorConfig.calls);assert.equal(operator.expiresAt,f.operatorConfig.expiresAt);assert.deepEqual(operator.selection,f.operatorConfig.selection);assert.equal(operator.specificationDigest,digest(m.specification));
 assert.deepEqual(m.patches.slice(-3).map(p=>p.path),['plugin/.mcp.json','service.plist','service-specification.json']);
 assert(!m.patches.some(p=>['installation-plan.json','legacy-adoption.json','client.json','data/auth.json'].includes(p.path)));
});

test('generated references agree with the ordinary owner reader and exact plugin generator',t=>{
 const f=fixture(t),m=rendered(f),originals=Object.fromEntries(Object.keys(m.sourcePins).map(p=>[p,sha(p)]));
 for(const p of m.patches)write(join(f.selectedRoot,p.path),p.content);
 const config=readIntegrationConfiguration(m.specification.integrationsRef,f.source.workspaceId);assert.deepEqual(readRegisteredNativeToolchain(config),described(f));
 const plugin=runtimePluginMaterial(m.specification.packageRoot,join(f.selectedRoot,'connection.json'),m.specification.nodeExecutable,m.hostAfter);
 assert.deepEqual(plugin.files.get('.mcp.json'),fs.readFileSync(join(f.selectedRoot,'plugin/.mcp.json')));
 const changed=new Set(m.patches.filter(p=>p.before!==null).map(p=>join(f.selectedRoot,p.path)));
 for(const [p,h] of Object.entries(originals))if(!changed.has(p))assert.equal(sha(p),h,p);
});

test('fixed production selector rejects a missing cache without downloads or writes',t=>{
 const f=fixture(t),before=inspectMaintenanceTree(f.root);assert.throws(()=>prepareInstalledToolchainRegistration(f.selectedRoot),{code:'TOOLCHAIN_NOT_READY'});assert.deepEqual(inspectMaintenanceTree(f.root),before);
});

test('foreign dependency descriptions and changed installed plugin commands are refused',t=>{
 const f=fixture(t),value=described(f);assert.throws(()=>renderInstalledToolchainRegistration(f.selectedRoot,{...value,environmentRoot:join(f.root,'foreign')}),{code:'TOOLCHAIN_BINDING_CHANGED'});
 const file=join(f.selectedRoot,'plugin/.mcp.json'),original=fs.readFileSync(file),plugin=read(file);plugin.mcpServers.evopilot_runtime_legacy.args.push('--unreviewed-call','grant');write(file,plugin);assert.throws(()=>rendered(f),{code:'TOOLCHAIN_BINDING_CHANGED'});fs.writeFileSync(file,original);
 const other=read(file);other.mcpServers.evopilot_runtime.url='http://127.0.0.1:65530/mcp';write(file,other);assert.throws(()=>rendered(f),{code:'TOOLCHAIN_BINDING_CHANGED'});
});

function setup(f){
 const ref=join(f.selectedRoot,'workspace-setup.json'),op=f.operatorConfig,c={schema:'runtime-workspace-setup-operator/v1',projectRoot:f.source.projectRoot,workspaceRoot:f.source.workspaceRoot,owners:op.owners,ownerHost:{ref:f.ownerHost.ownerConfigRef,digest:f.ownerHost.ownerConfigDigest},workspaceOperator:{projectRoot:op.selection.projectRoot,referenceFiles:op.selection.referenceFiles,owners:op.owners,calls:op.calls,expiresAt:op.expiresAt},serviceAfterSetup:'running',expiresAt:op.expiresAt,serviceRoot:f.selectedRoot,workspaceId:f.source.workspaceId,serviceId:f.source.serviceId,connectionRef:op.connectionRef,installationPlanDigest:digest(f.plan),specificationDigest:digest(f.spec),connectionDigest:digest(read(op.connectionRef))};write(ref,c);
 const entry=join(f.spec.packageRoot,'dist/installation/setup-host.js');write(entry,'// synthetic bootstrap, never executed\n');
 const manifestRef=join(f.selectedRoot,'distribution-manifest.json'),manifest=read(manifestRef);manifest.files['dist/installation/setup-host.js']={type:'file',sha256:sha(entry),bytes:fs.statSync(entry).size,mode:0o600};write(manifestRef,manifest);f.plan.distribution.manifestDigest=sha(manifestRef);write(join(f.selectedRoot,'installation-plan.json'),f.plan);c.installationPlanDigest=digest(f.plan);write(ref,c);
 const selection={...f.ownerHost,setupConfigRef:ref,setupConfigDigest:digest(c)},material=runtimePluginMaterial(f.spec.packageRoot,op.connectionRef,f.spec.nodeExecutable,selection);write(join(f.selectedRoot,'plugin/.mcp.json'),material.files.get('.mcp.json').toString());return{ref,c,selection};
}

test('completed first-use binding renders a normal bound Host and retains setup history',t=>{
 const f=fixture(t),s=setup(f),before=sha(s.ref),m=rendered(f);assert(m.hostBefore.setupConfigRef);assert.equal(m.hostAfter.setupConfigRef,undefined);assert.equal(sha(s.ref),before);assert.equal(m.sourcePins[s.ref],before);
 const plugin=JSON.parse(m.patches.find(p=>p.path==='plugin/.mcp.json').content);assert.equal(plugin.mcpServers.evopilot_runtime_legacy.args[0],join(f.spec.packageRoot,'dist/installation/workspace-host.js'));
 assert.deepEqual(patch(m,m.hostAfter.workspaceConfigRef).calls,f.operatorConfig.calls);
});

test('setup and bound operator grants must match before material is proposed',t=>{
 const f=fixture(t),s=setup(f);s.c.workspaceOperator.calls=['workspace_inspect'];write(s.ref,s.c);const material=runtimePluginMaterial(f.spec.packageRoot,f.operatorConfig.connectionRef,f.spec.nodeExecutable,{...s.selection,setupConfigDigest:digest(s.c)});write(join(f.selectedRoot,'plugin/.mcp.json'),material.files.get('.mcp.json').toString());assert.throws(()=>rendered(f),{code:'TOOLCHAIN_BINDING_CHANGED'});
});

test('full dependency inventory uses the bounded local manifest profile without widening public requests',t=>{
 const f=fixture(t),value=described(f);value.dependencyFiles=Array.from({length:2500},(_,i)=>({path:join(value.environmentRoot,'lib','dependency-'+i+'-'.repeat(48)),sha256:'b'.repeat(64)}));
 assert.throws(()=>canonical(value),{code:'INPUT_LIMIT'});
 const m=renderInstalledToolchainRegistration(f.selectedRoot,value),manifest=m.patches.find(p=>join(f.selectedRoot,p.path)===m.registration.path);
 assert(Buffer.byteLength(manifest.content)>262144);assert(Buffer.byteLength(manifest.content)<2097152);assert.equal(JSON.parse(manifest.content).dependencyFiles.length,2500);
 assert.equal(m.registration.digest,'sha256:'+createHash('sha256').update(manifest.content).digest('hex'));
 value.dependencyFiles=Array.from({length:5000},(_,i)=>({path:join(value.environmentRoot,'lib','dependency-'+i+'-'.repeat(500)),sha256:'b'.repeat(64)}));
 assert.throws(()=>renderInstalledToolchainRegistration(f.selectedRoot,value),{code:'TOOLCHAIN_BINDING_LIMIT'});
});
