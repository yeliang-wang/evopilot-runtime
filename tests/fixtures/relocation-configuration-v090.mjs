// SYNTHETIC installation material; no service or business execution.
import fs from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {workspaceMaintenanceFixture} from './workspace-maintenance-v090.mjs';
import {acquireManagedLegacyContext} from '../../dist/compat/managed-store.js';
import {inspectWorkspaceSnapshot,relocateWorkspaceSnapshot} from '../../dist/workspace-migration.js';
import {keyDirectory} from '../../dist/location-lineage.js';
import {runtimePluginMaterial} from '../../dist/host/plugin.js';
import {userServicePlist} from '../../dist/installation/service.js';
import {canonical,digest} from '../../dist/server/errors.js';
import {initializeCredentials,tokenDigest} from '../../dist/server/security.js';
const repo=new URL('../../',import.meta.url).pathname,node=fs.realpathSync(process.execPath),sha=b=>createHash('sha256').update(b).digest('hex'),nodeSha256=sha(fs.readFileSync(node));
const put=(file,v)=>{fs.mkdirSync(dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,Buffer.isBuffer(v)?v:typeof v==='string'?v:canonical(v)+'\n',{mode:0o600});};
const read=file=>JSON.parse(fs.readFileSync(file));
const scoped=(binding,fn)=>{const c=acquireManagedLegacyContext(binding);try{return c.run(fn);}finally{c.close();}};
function copy(source,target){fs.cpSync(source,target,{recursive:true,verbatimSymlinks:true});const visit=(a,b)=>{const s=fs.lstatSync(a);if(s.isSymbolicLink())return;fs.chmodSync(b,s.mode&0o777);if(s.isDirectory())for(const name of fs.readdirSync(a))visit(join(a,name),join(b,name));};visit(source,target);}
export function relocationConfigurationFixture(t,withOwners=true,move=true){
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
 if(move){
 for(const k of ['projectRoot','workspaceRoot','serviceRoot'])copy(s[k],destination[k]);
 const snap=scoped(f.binding,()=>inspectWorkspaceSnapshot({workspaceRoot:s.workspaceRoot,workspaceId:s.workspaceId}));
 const moved=scoped(f.binding,()=>relocateWorkspaceSnapshot({sourceRoot:s.workspaceRoot,destinationRoot:destination.workspaceRoot,workspaceId:s.workspaceId,expectedSnapshotDigest:snap.snapshotDigest}));Object.assign(destination,moved.managedBinding);
 t.after(()=>{for(const id of moved.requiredKeyIds)fs.rmSync(join(keyDirectory(),id+'.key'),{force:true});});
 }
 return{...f,source:s,destination,ownerHost,spec,integrations,providers};
}
