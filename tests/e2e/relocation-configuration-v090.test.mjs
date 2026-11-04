// SYNTHETIC configuration assembly; the whole operator/Host cutover is separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {workspaceMaintenanceFixture} from '../fixtures/workspace-maintenance-v090.mjs';
import {prepareRelocationConfiguration} from '../../dist/installation/workspace/configuration.js';
import {inspectMaintenanceTree,hashMaintenanceFile} from '../../dist/installation/workspace/stream.js';
import {acquireManagedLegacyContext} from '../../dist/compat/managed-store.js';
import {inspectWorkspaceSnapshot,relocateWorkspaceSnapshot} from '../../dist/workspace-migration.js';
import {keyDirectory} from '../../dist/location-lineage.js';
import {runtimePluginMaterial} from '../../dist/host/plugin.js';
import {userServicePlist} from '../../dist/installation/service.js';
import {canonical,digest} from '../../dist/server/errors.js';
import {initializeCredentials,tokenDigest} from '../../dist/server/security.js';
import {readLegacyProviderConfiguration} from '../../dist/compat/registered-providers.js';
import {readLegacyOwnerHostConfiguration} from '../../dist/host/legacy-owners.js';
import {readIntegrationConfiguration} from '../../dist/adapters/config.js';

import {relocationConfigurationFixture as fixture} from '../fixtures/relocation-configuration-v090.mjs';
const put=(file,v)=>{fs.mkdirSync(dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,Buffer.isBuffer(v)?v:typeof v==='string'?v:canonical(v)+'\n',{mode:0o600});};
const node=fs.realpathSync(process.execPath);
const read=file=>JSON.parse(fs.readFileSync(file));
function prepare(f){return prepareRelocationConfiguration(f.source,f.destination,f.ownerHost);}
function apply(f,material){for(const p of material.patches)put(join(f.destination.serviceRoot,p.path),p.bytes);}

test('read-only relocation material preserves scope, expiry, credentials and original histories while rebinding exact operational paths',t=>{
 const f=fixture(t),before=Object.fromEntries(['source','destination'].map(k=>[k,['projectRoot','workspaceRoot','serviceRoot'].map(p=>inspectMaintenanceTree(f[k][p]))]));
 const material=prepare(f);assert.equal(material.filesWritten,false);assert.equal(material.serviceStarted,false);assert.equal(material.hostRegistered,false);assert.equal(material.authority,false);
 for(const k of ['source','destination'])assert.deepEqual(['projectRoot','workspaceRoot','serviceRoot'].map(p=>inspectMaintenanceTree(f[k][p])),before[k]);
 assert(!material.patches.some(p=>['data/auth.json','client.json','installation-plan.json','legacy-adoption.json'].includes(p.path)));
 assert(!material.patches.some(p=>p.bytes.includes('synthetic_client_credential_')));assert(!material.patches.some(p=>p.bytes.includes('synthetic-platform-not-a-real-secret')));
 apply(f,material);const spec=read(join(f.destination.serviceRoot,'service-specification.json'));
 assert.equal(spec.root,f.destination.serviceRoot);assert.equal(spec.port,f.spec.port);assert.equal(spec.principalId,f.spec.principalId);assert.equal(spec.nodeSha256,f.spec.nodeSha256);
 const providers=readLegacyProviderConfiguration(spec.legacyProviders.ref);assert.deepEqual({...providers,legacyBindingRef:f.providers.legacyBindingRef,projectRoot:f.providers.projectRoot},f.providers);
 const host=readLegacyOwnerHostConfiguration(material.ownerHost.ownerConfigRef);assert.equal(host.expiresAt,f.providers.expiresAt);assert.deepEqual(host.project.calls,['native:inspect']);assert.equal(host.project.root,f.destination.projectRoot);
 const integration=readIntegrationConfiguration(spec.integrationsRef,f.source.workspaceId);assert.deepEqual(integration.resources,f.integrations.resources);assert.equal(integration.revision,3);assert.equal(integration.credentials[0].revision,2);assert.equal(integration.credentials[0].tokenFile,join(f.destination.serviceRoot,'synthetic-platform.token'));assert(integration.owners.every(o=>o.workspaceRoot===f.destination.workspaceRoot));
 assert.equal(fs.readFileSync(join(f.destination.serviceRoot,'service.plist'),'utf8'),userServicePlist(spec));
 const plugin=runtimePluginMaterial(spec.packageRoot,join(f.destination.serviceRoot,'connection.json'),node,material.ownerHost);for(const [name,bytes] of plugin.files)assert.deepEqual(fs.readFileSync(join(f.destination.serviceRoot,'plugin',name)),bytes);
 for(const file of ['data/auth.json','client.json','installation-plan.json','legacy-adoption.json'])assert.deepEqual(fs.readFileSync(join(f.source.serviceRoot,file)),fs.readFileSync(join(f.destination.serviceRoot,file)));
 assert.equal(prepare(f).materialDigest,material.materialDigest,'completed material is deterministic, not a second installation');
});

test('a source without optional providers retains the same empty compatibility selection',t=>{
 const f=fixture(t,false),m=prepare(f);assert.equal(m.specification.legacyProviders,undefined);assert.deepEqual(m.ownerHost,{});assert(!m.patches.some(p=>p.path==='relocated-owner-host.json'||p.path==='relocated-providers.json'));
});

test('partial configuration application can be inspected without changing its original exact material',t=>{
 const f=fixture(t),m=prepare(f);apply(f,{patches:m.patches.slice(0,3)});const before=inspectMaintenanceTree(f.destination.serviceRoot);assert.equal(prepare(f).materialDigest,m.materialDigest);assert.deepEqual(inspectMaintenanceTree(f.destination.serviceRoot),before);
});

test('destination credentials, service ledger, package and copied configuration cannot be replaced during relocation assembly',t=>{
 for(const file of ['client.json','data/auth.json','synthetic-platform.token','data/service.sqlite','package/dist/host/bridge.js','connection.json']){
  const f=fixture(t),target=join(f.destination.serviceRoot,file),bytes=fs.readFileSync(target);fs.writeFileSync(target,Buffer.concat([bytes,Buffer.from('\n')]));
  assert.throws(()=>prepare(f),{code:'RELOCATION_CONFIGURATION_CHANGED'});assert.deepEqual(fs.readFileSync(target),Buffer.concat([bytes,Buffer.from('\n')]));
 }
});

test('owner permissions, provider selection and exact source binding cannot be widened by supplying a new digest',t=>{
 const f=fixture(t),file=f.ownerHost.ownerConfigRef,original=fs.readFileSync(file),changed=read(file);changed.owners.ontology.calls.push('request:asset.publish');put(file,changed);
 assert.throws(()=>prepareRelocationConfiguration(f.source,f.destination,{...f.ownerHost,ownerConfigDigest:digest(changed)}),{code:'RELOCATION_CONFIGURATION_CHANGED'});fs.writeFileSync(file,original);
 const provider=read(f.spec.legacyProviders.ref);provider.projects.push('other');put(f.spec.legacyProviders.ref,provider);assert.throws(()=>prepare(f),{code:'RELOCATION_CONFIGURATION_CHANGED'});
});

test('unsigned destination bindings, overlapping roots and changed project identity are rejected',t=>{
 const f=fixture(t);assert.throws(()=>prepareRelocationConfiguration(f.source,{...f.destination,migrationDigest:f.source.migrationDigest},f.ownerHost),{code:'RELOCATION_CONFIGURATION_CHANGED'});
 assert.throws(()=>prepareRelocationConfiguration(f.source,{...f.destination,serviceRoot:f.source.serviceRoot},f.ownerHost),{code:'MAINTENANCE_LOCATION'});
 put(join(f.destination.projectRoot,'workspace-project.json'),{schema:'evopilot-workspace-project/v1',id:'other'});assert.throws(()=>prepare(f),{code:'MAINTENANCE_IDENTITY'});
});


test('relocation retains exact local maintenance permissions and rebinds only its operator paths and configuration digest',t=>{
 const f=fixture(t,true,true,true),material=prepare(f);assert(material.ownerHost.workspaceConfigRef);apply(f,material);
 const config=read(material.ownerHost.workspaceConfigRef);assert.deepEqual(config.calls,f.operatorConfig.calls);assert.equal(config.expiresAt,f.operatorConfig.expiresAt);assert.deepEqual(config.selection,f.destination);assert.equal(config.specificationDigest,digest(read(join(f.destination.serviceRoot,'service-specification.json'))));assert.equal(config.connectionRef,join(f.destination.serviceRoot,'connection.json'));
 assert.deepEqual(config.ownerHost,{ownerConfigRef:material.ownerHost.ownerConfigRef,ownerConfigDigest:material.ownerHost.ownerConfigDigest});
 const plugin=runtimePluginMaterial(join(f.destination.serviceRoot,'package'),config.connectionRef,node,material.ownerHost);assert.deepEqual(plugin.files.get('.mcp.json'),fs.readFileSync(join(f.destination.serviceRoot,'plugin/.mcp.json')));
 assert.equal(prepare(f).materialDigest,material.materialDigest);
});

function firstUseFixture(t){
 const f=fixture(t,true,true,true),ref=join(f.source.serviceRoot,'workspace-setup.json'),c=f.operatorConfig;
 const config={schema:'runtime-workspace-setup-operator/v1',projectRoot:f.source.projectRoot,workspaceRoot:f.source.workspaceRoot,owners:c.owners,ownerHost:{ref:f.ownerHost.ownerConfigRef,digest:f.ownerHost.ownerConfigDigest},workspaceOperator:{projectRoot:c.selection.projectRoot,referenceFiles:c.selection.referenceFiles,owners:c.owners,calls:c.calls,expiresAt:c.expiresAt},serviceAfterSetup:'running',expiresAt:c.expiresAt,serviceRoot:f.source.serviceRoot,workspaceId:f.source.workspaceId,serviceId:f.source.serviceId,connectionRef:c.connectionRef,installationPlanDigest:'a'.repeat(64),specificationDigest:'b'.repeat(64),connectionDigest:digest(read(c.connectionRef))};
 for(const s of [f.source,f.destination]){put(join(s.serviceRoot,'workspace-setup.json'),config);put(join(s.serviceRoot,'package/dist/installation/setup-host.js'),'// synthetic first-use entry, never executed\n');}
 const material=runtimePluginMaterial(join(f.source.serviceRoot,'package'),c.connectionRef,node,{...f.ownerHost,setupConfigRef:ref,setupConfigDigest:digest(config)});
 for(const [name,bytes] of material.files)for(const s of [f.source,f.destination])put(join(s.serviceRoot,'plugin',name),bytes);
 return{...f,setup:config,setupRef:ref};
}

test('completed first-use Host relocates to its bound maintenance entry without weakening owner or maintenance permissions',t=>{
 const f=firstUseFixture(t),sourcePlugin=fs.readFileSync(join(f.source.serviceRoot,'plugin/.mcp.json')),m=prepare(f);apply(f,m);
 const moved=read(join(f.destination.serviceRoot,'plugin/.mcp.json')).mcpServers.evopilot_runtime_legacy;
 assert.equal(moved.args[0],join(f.destination.serviceRoot,'package/dist/installation/workspace-host.js'));assert(!moved.args.includes('--setup-config-ref'));
 const operator=read(m.ownerHost.workspaceConfigRef);assert.deepEqual(operator.calls,f.operatorConfig.calls);assert.equal(operator.expiresAt,f.operatorConfig.expiresAt);
 assert.equal(read(m.ownerHost.ownerConfigRef).expiresAt,f.setup.expiresAt);assert(m.sourcePins.some(p=>p.path===f.setupRef));
 assert.deepEqual(fs.readFileSync(join(f.source.serviceRoot,'plugin/.mcp.json')),sourcePlugin);assert.equal(prepare(f).materialDigest,m.materialDigest);
});

test('first-use relocation rejects changed setup roots or grants even if plugin material is regenerated',t=>{
 const f=firstUseFixture(t),config={...f.setup,workspaceRoot:join(f.root,'foreign-state')};put(f.setupRef,config);
 const material=runtimePluginMaterial(join(f.source.serviceRoot,'package'),f.operatorConfig.connectionRef,node,{...f.ownerHost,setupConfigRef:f.setupRef,setupConfigDigest:digest(config)});put(join(f.source.serviceRoot,'plugin/.mcp.json'),material.files.get('.mcp.json'));
 assert.throws(()=>prepare(f),{code:'RELOCATION_CONFIGURATION_CHANGED'});
});
