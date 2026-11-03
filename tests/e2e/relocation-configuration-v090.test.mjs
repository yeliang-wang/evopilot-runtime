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

const repo=new URL('../../',import.meta.url).pathname,node=fs.realpathSync(process.execPath),sha=b=>createHash('sha256').update(b).digest('hex'),nodeSha256=sha(fs.readFileSync(node));
const put=(file,v)=>{fs.mkdirSync(dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,Buffer.isBuffer(v)?v:typeof v==='string'?v:canonical(v)+'\n',{mode:0o600});};
const read=file=>JSON.parse(fs.readFileSync(file));
const scoped=(binding,fn)=>{const c=acquireManagedLegacyContext(binding);try{return c.run(fn);}finally{c.close();}};
function copy(source,target){fs.cpSync(source,target,{recursive:true,verbatimSymlinks:true});const visit=(a,b)=>{const s=fs.lstatSync(a);if(s.isSymbolicLink())return;fs.chmodSync(b,s.mode&0o777);if(s.isDirectory())for(const name of fs.readdirSync(a))visit(join(a,name),join(b,name));};visit(source,target);}
function fixture(t,withOwners=true){
 const f=workspaceMaintenanceFixture(t),s=f.selection,packageRoot=join(s.serviceRoot,'package'),expiresAt=new Date(Date.now()+7*86400000).toISOString();
 fs.mkdirSync(packageRoot,{mode:0o700});put(join(packageRoot,'package.json'),{name:'@evopilot-next/runtime',version:'0.8.3'});
 copy(join(repo,'plugins'),join(packageRoot,'plugins'));
 for(const name of ['server/cli.js','host/bridge.js','host/header-helper.js'])put(join(packageRoot,'dist',name),'#!/usr/bin/env node\n// Synthetic material fixture; never executed.\n');
 const token='synthetic_client_credential_1234567890abcdef';
 put(join(s.serviceRoot,'client.json'),{schema:'runtime-client-credential/v1',workspaceId:s.workspaceId,projectId:'synthetic',principalId:'synthetic',token});
 initializeCredentials(join(s.serviceRoot,'data'),s.workspaceId,[{id:'synthetic',projects:['synthetic'],permissions:['read'],revision:1,expiresAt,tokenDigest:tokenDigest(token)}]);
 const owners=Object.fromEntries(['ontology','harness'].map(o=>[o,{packageRoot:join(f.root,o+'-package')}]));for(const o of Object.values(owners))fs.mkdirSync(o.packageRoot,{mode:0o700});
 const nativeToolchain={path:f.reference,digest:'sha256:'+'a'.repeat(64),lockDigest:'sha256:'+'b'.repeat(64)};
 const integrations={schema:'runtime-integrations/v1',workspaceId:s.workspaceId,revision:3,platforms:[],credentials:[{ref:'credential:synthetic',workspaceId:s.workspaceId,projectId:'synthetic',provider:'github',host:'https://github.com',tokenFile:join(s.serviceRoot,'synthetic-platform.token'),revision:2,expiresAt}],owners:['ontology','harness'].map(o=>({ref:'binding:'+o,owner:o,...owners[o],workspaceRoot:s.workspaceRoot,workspaceId:s.workspaceId,projects:['synthetic']})),resources:[{ref:'binding:source',workspaceId:s.workspaceId,projectId:'synthetic',role:'source',revision:4,expiresAt,definition:{path:join(s.projectRoot,'immutable-reference.txt')}}]};
 put(join(s.serviceRoot,'synthetic-platform.token'),'synthetic-platform-not-a-real-secret');put(join(f.root,'integrations.json'),integrations);
 let ownerHost={},providers;
 if(withOwners){
  providers={schema:'runtime-legacy-providers/v1',workspaceId:s.workspaceId,projects:['synthetic'],legacyBindingRef:join(s.serviceRoot,'legacy-binding.json'),projectRoot:s.projectRoot,expiresAt,owners,nativeToolchain,collection:{kind:'node',executable:node,sha256:nodeSha256}};
  put(join(f.root,'providers.json'),providers);
  const host={schema:'runtime-legacy-owner-host/v1',workspaceId:s.workspaceId,projectId:'synthetic',legacyBindingRef:providers.legacyBindingRef,expiresAt,owners:Object.fromEntries(Object.entries(owners).map(([o,v])=>[o,{...v,calls:['request:workspace.inspect']}])) ,project:{root:s.projectRoot,calls:['native:inspect']}};
  put(join(f.root,'owner-host.json'),host);ownerHost={ownerConfigRef:join(f.root,'owner-host.json'),ownerConfigDigest:digest(host)};
 }
 const spec={schema:'runtime-user-service/v1',root:s.serviceRoot,packageRoot,version:'0.8.3',nodeExecutable:node,nodeSha256,workspaceId:s.workspaceId,projectId:'synthetic',principalId:'synthetic',tokenRef:join(s.serviceRoot,'client.json'),port:32198,integrationsRef:join(f.root,'integrations.json'),legacyRef:join(s.serviceRoot,'legacy-binding.json'),...(providers?{legacyProviders:{ref:join(f.root,'providers.json'),digest:digest(providers)}}:{})};
 put(join(s.serviceRoot,'service-specification.json'),spec);put(join(s.serviceRoot,'service.plist'),userServicePlist(spec));
 put(join(s.serviceRoot,'connection.json'),{schema:'runtime-host-connection/v1',origin:'http://127.0.0.1:'+spec.port,workspaceId:s.workspaceId,projectId:'synthetic',principalId:'synthetic',serviceId:s.serviceId,version:spec.version,tokenRef:spec.tokenRef});
 const material=runtimePluginMaterial(packageRoot,join(s.serviceRoot,'connection.json'),node,ownerHost);for(const [name,bytes] of material.files)put(join(s.serviceRoot,'plugin',name),bytes);
 put(join(s.serviceRoot,'.agents/plugins/marketplace.json'),{name:'evopilot-runtime-'+sha(s.serviceRoot).slice(0,16),plugins:[{name:'evopilot-runtime',source:{source:'local',path:'./plugin'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'}}]});
 put(join(s.serviceRoot,'installation-plan.json'),{synthetic:'Retain original installation history',root:s.serviceRoot});put(join(s.serviceRoot,'legacy-adoption.json'),{synthetic:'Retain original immutable adoption receipt'});
 const destination={...s,projectRoot:join(f.root,'moved-project'),workspaceRoot:join(f.root,'moved-workspace'),serviceRoot:join(f.root,'moved-service')};
 for(const k of ['projectRoot','workspaceRoot','serviceRoot'])copy(s[k],destination[k]);
 const snap=scoped(f.binding,()=>inspectWorkspaceSnapshot({workspaceRoot:s.workspaceRoot,workspaceId:s.workspaceId}));
 const moved=scoped(f.binding,()=>relocateWorkspaceSnapshot({sourceRoot:s.workspaceRoot,destinationRoot:destination.workspaceRoot,workspaceId:s.workspaceId,expectedSnapshotDigest:snap.snapshotDigest}));Object.assign(destination,moved.managedBinding);
 t.after(()=>{for(const id of moved.requiredKeyIds)fs.rmSync(join(keyDirectory(),id+'.key'),{force:true});});
 return{...f,source:s,destination,ownerHost,spec,integrations,providers};
}
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
