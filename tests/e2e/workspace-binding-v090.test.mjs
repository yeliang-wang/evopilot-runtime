// Actual Runtime databases/adoption/configuration; deliberately synthetic
// distribution and owner payloads. These checks do not certify a Release.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {join,dirname} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath,pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';import {spawn} from 'node:child_process';
import {bindPreparedWorkspace} from '../../dist/installation/workspace/binding.js';
import {prepareWorkspaceSetupWithOwners} from '../../dist/installation/workspace/bootstrap.js';
import {runInstaller} from '../../dist/installation/installer.js';
import {createLegacyBackup,inspectLegacyWorkspace} from '../../dist/installation/migration.js';
import {RuntimeStore} from '../../dist/server/store.js';
import {createRuntimeService} from '../../dist/service.js';
import {createManagedLegacyService} from '../../dist/compat/managed-service.js';
import {inspectWorkspaceSnapshot} from '../../dist/workspace-migration.js';
import {runtimePluginMaterial,PLUGIN_STATIC_FILES} from '../../dist/host/plugin.js';
import {canonical,digest} from '../../dist/server/errors.js';
const repo=fileURLToPath(new URL('../../',import.meta.url)),sha=v=>createHash('sha256').update(v).digest('hex'),read=p=>JSON.parse(fs.readFileSync(p)),put=(p,v)=>{fs.mkdirSync(dirname(p),{recursive:true,mode:0o700});fs.writeFileSync(p,typeof v==='string'?v:canonical(v)+'\n',{mode:0o600});},pin=p=>sha(fs.readFileSync(p));
async function fixture(t){
 const root=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'runtime-bind-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const source=join(root,'source');fs.mkdirSync(source,{mode:0o700});
 const paths=['package.json','plugins/codex/mcp.template.json',...PLUGIN_STATIC_FILES.map(p=>'plugins/codex/'+p)],files={};
 const content=Object.fromEntries(paths.map(p=>[p,fs.readFileSync(join(repo,p))]));Object.assign(content,{'dist/server/cli.js':Buffer.from('#!/usr/bin/env node\n// Synthetic distribution; never started.\n'),'dist/host/header-helper.js':Buffer.from('// Synthetic helper; never executed.\n'),'dist/host/bridge.js':Buffer.from('// Synthetic bridge; never executed.\n'),'dist/installation/workspace-host.js':Buffer.from('// Synthetic operator; never executed.\n')});
 for(const [p,b] of Object.entries(content)){const name=join(source,p);fs.mkdirSync(dirname(name),{recursive:true,mode:0o700});fs.writeFileSync(name,b,{mode:0o644});files[p]={type:'file',sha256:sha(b),bytes:b.length,mode:0o644};}
 const archive=join(root,'synthetic.tgz');put(archive,'SYNTHETIC archive inventory, never unpacked');const manifest={schema:'runtime-standalone-distribution/v1',version:read(join(repo,'package.json')).version,archiveDigest:pin(archive),files},manifestRef=join(root,'manifest.json');put(manifestRef,manifest);
 const plan={schema:'runtime-install-plan/v1',root:join(root,'service'),distribution:{packageRoot:source,manifestRef,manifestDigest:pin(manifestRef),archiveRef:archive,archiveDigest:pin(archive)},nodeExecutable:fs.realpathSync(process.execPath),nodeSha256:pin(fs.realpathSync(process.execPath)),workspaceId:'binding-test',projectId:'alpha',principalId:'host',role:'activator',credentialExpiresAt:new Date(Date.now()+86400000).toISOString(),port:33331,integrationsRef:null,codex:null};
 await runInstaller(plan,'stage');const store=new RuntimeStore(join(plan.root,'data'),plan.workspaceId),serviceId=store.serviceId;store.close();
 const connection={schema:'runtime-host-connection/v1',origin:'http://127.0.0.1:'+plan.port,workspaceId:plan.workspaceId,projectId:plan.projectId,principalId:plan.principalId,serviceId,version:manifest.version,tokenRef:join(plan.root,'client.json')};put(join(plan.root,'connection.json'),connection);
 const material=runtimePluginMaterial(join(plan.root,'package'),join(plan.root,'connection.json'),plan.nodeExecutable);for(const [name,b] of material.files)put(join(plan.root,'plugin',name),b.toString());
 const owners=Object.fromEntries(['ontology','harness'].map(o=>{const p=join(root,o+'-package');fs.mkdirSync(p,{mode:0o700});return[o,p];}));
 const setup={requestId:'setup',mode:'initialize',projectRoot:join(root,'project'),workspaceRoot:join(root,'workspace'),workspaceId:plan.workspaceId,serviceRoot:plan.root,owners};
 const factories={async initialize(owner,location){if(owner==='runtime'){const s=createRuntimeService(location);try{s.initialize();}finally{s.close();}}else put(join(location.workspaceRoot,'state',owner,owner+'.db'),'SYNTHETIC '+owner);},inspect(owner,location){if(owner==='runtime')return inspectWorkspaceSnapshot(location);return{product:owner,identity:read(join(location.workspaceRoot,'workspace.json')),snapshotDigest:digest(owner),requiredKeyIds:[],unresolved:[]};}};
 const prepared=await prepareWorkspaceSetupWithOwners(setup,factories),original=createRuntimeService({workspaceRoot:setup.workspaceRoot,workspaceId:plan.workspaceId}),scope={visibility:'private',projectId:'alpha'};
 let expected;try{original.initialize();original.execute({operation:'project.create',scope,input:{name:'Keep original project'},requestId:'original-project',expectedRevision:0});expected=original.execute({operation:'project.list',scope,input:{}});}finally{original.close();}
 const snapshot=inspectLegacyWorkspace(setup.workspaceRoot,plan.workspaceId),backupRoot=join(root,'backup'),backup=createLegacyBackup(setup.workspaceRoot,plan.workspaceId,snapshot.snapshotDigest,backupRoot);
 const request={schema:'runtime-workspace-binding/v1',requestId:'bind-original',serviceRoot:plan.root,setupRequestId:'setup',setupResultDigest:prepared.resultDigest,installationPlanDigest:digest(plan),specificationDigest:digest(read(join(plan.root,'service-specification.json'))),connectionDigest:digest(connection),backupRoot,backupDigest:backup.backupDigest,ownerHost:null,workspaceOperator:{projectRoot:setup.projectRoot,referenceFiles:[],owners,calls:['workspace_inspect','workspace_backup','workspace_restore'],expiresAt:new Date(Date.now()+3600000).toISOString()}};
 return{root,plan,setup,request,scope,expected,serviceId,run:()=>bindPreparedWorkspace(request),db:join(setup.workspaceRoot,'state/runtime/runtime.db')};
}
test('prepared Workspace binds the same installed service, preserving original history and credentials without starting or registering it',async t=>{
 const f=await fixture(t),protectedNames=['installation-plan.json','distribution-manifest.json','data/auth.json','client.json','connection.json','data/service.sqlite'],pins=Object.fromEntries(protectedNames.map(n=>[n,pin(join(f.plan.root,n))])),ownerPins=Object.fromEntries(['ontology','harness'].map(o=>[o,pin(join(f.setup.workspaceRoot,'state',o,o+'.db'))]));
 const result=await f.run();assert.equal(result.status,'BOUND');assert.equal(result.binding.serviceId,f.serviceId);for(const k of ['serviceStarted','hostRegistered','sessionActivated','businessWorkDispatched','authority'])assert.equal(result[k],false);
 for(const [name,p] of Object.entries(pins))assert.equal(pin(join(f.plan.root,name)),p,name);for(const [o,p] of Object.entries(ownerPins))assert.equal(pin(join(f.setup.workspaceRoot,'state',o,o+'.db')),p);
 const managed=createManagedLegacyService(result.binding);try{assert.deepEqual(managed.execute({operation:'project.list',scope:f.scope,input:{}}),f.expected);}finally{managed.close();}
 const servers=read(join(f.plan.root,'plugin/.mcp.json')).mcpServers;assert.equal(servers.evopilot_runtime.type,'http');assert.equal(servers.evopilot_runtime.url,'http://127.0.0.1:'+f.plan.port+'/mcp');assert.equal(servers.evopilot_runtime_legacy.type,'stdio');assert(servers.evopilot_runtime_legacy.args.includes('--operator-config-ref'));
 assert.equal(read(join(f.plan.root,'service-specification.json')).legacyRef,join(f.plan.root,'legacy-binding.json'));assert.equal(read(join(f.plan.root,'workspace-operator.json')).specificationDigest,result.specificationDigest);
 put(join(f.plan.root,'plugin/.mcp.json'),'later operator configuration');assert.deepEqual(await f.run(),{...result,reused:true,currentEnvironmentVerified:false});assert.equal(fs.readFileSync(join(f.plan.root,'plugin/.mcp.json'),'utf8'),'later operator configuration');
 await assert.rejects(bindPreparedWorkspace({...f.request,requestId:'replacement'}),{code:'WORKSPACE_BINDING_PENDING'});
});
test('wrong preparation, backup, installation identity or maintenance grant cannot adopt the original database',async t=>{
 const f=await fixture(t),before=pin(f.db);for(const change of [{setupResultDigest:'a'.repeat(64)},{backupDigest:'a'.repeat(64)},{installationPlanDigest:'a'.repeat(64)},{specificationDigest:'a'.repeat(64)},{connectionDigest:'a'.repeat(64)},{workspaceOperator:{...f.request.workspaceOperator,projectRoot:join(f.root,'foreign')}}]){
  await assert.rejects(bindPreparedWorkspace({...f.request,...change}));assert.equal(pin(f.db),before);assert(!fs.existsSync(join(f.plan.root,'legacy-binding.json')));
 }
 const abort=new AbortController();abort.abort();await assert.rejects(bindPreparedWorkspace(f.request,abort.signal));await assert.rejects(bindPreparedWorkspace(f.request,undefined,()=>{throw Object.assign(Error('revoked'),{code:'GRANT_REVOKED'});}),{code:'GRANT_REVOKED'});assert.equal(pin(f.db),before);
});
test('active installation and independent writers prevent adoption without stopping unrelated work',async t=>{
 const f=await fixture(t),before=pin(f.db);for(const name of ['installer-lock.sqlite','data/writer-lock.sqlite']){const lock=new DatabaseSync(join(f.plan.root,name));lock.exec('BEGIN EXCLUSIVE');try{await assert.rejects(f.run(),e=>['INSTALLER_ACTIVE','WRITER_ACTIVE'].includes(e.code));}finally{lock.close();}assert.equal(pin(f.db),before);}
});
test('installed binding verifies retained package bytes without depending on removed download and unpack locations',async t=>{
 const f=await fixture(t);for(const p of [f.plan.distribution.packageRoot,f.plan.distribution.archiveRef,f.plan.distribution.manifestRef])fs.rmSync(p,{recursive:true});
 assert.equal((await f.run()).status,'BOUND');assert.equal(read(join(f.plan.root,'installation-plan.json')).distribution.archiveRef,f.plan.distribution.archiveRef);
});
test('interruption after committed adoption and a two-link publication resumes the same seal and preserves the failure',async t=>{
 const f=await fixture(t),link=fs.linkSync;let injected=false;fs.linkSync=(from,to,...args)=>{const v=link(from,to,...args);if(!injected&&to===join(f.plan.root,'legacy-binding.json')){injected=true;throw Object.assign(Error('simulated loss after link'),{code:'EIO'});}return v;};
 try{await assert.rejects(f.run(),{code:'EIO'});}finally{fs.linkSync=link;}
 assert(injected);assert.equal(fs.statSync(join(f.plan.root,'legacy-binding.json')).nlink,2);const receipt=read(join(f.plan.root,'legacy-adoption.json')),root=f.plan.root+'.evopilot-binding/bind-original';assert(fs.readdirSync(root).some(n=>n.startsWith('failure-')));
 const result=await f.run();assert.deepEqual(result.binding,receipt.binding);assert.equal(fs.statSync(join(f.plan.root,'legacy-binding.json')).nlink,1);const managed=createManagedLegacyService(result.binding);try{assert.deepEqual(managed.execute({operation:'project.list',scope:f.scope,input:{}}),f.expected);}finally{managed.close();}
});
test('configuration interruption leaves only whole files and recovery never overwrites foreign edits',async t=>{
 const f=await fixture(t),rename=fs.renameSync;let injected=false;fs.renameSync=(from,to)=>{if(!injected&&to===join(f.plan.root,'service-specification.json')){injected=true;throw Object.assign(Error('before final switch'),{code:'EIO'});}return rename(from,to);};
 try{await assert.rejects(f.run(),{code:'EIO'});}finally{fs.renameSync=rename;}
 assert(injected);assert.equal(read(join(f.plan.root,'service-specification.json')).legacyRef,undefined);assert(fs.existsSync(join(f.plan.root,'legacy-binding.json')));
 const original=fs.readFileSync(join(f.plan.root,'plugin/.mcp.json'));put(join(f.plan.root,'plugin/.mcp.json'),'foreign edit');await assert.rejects(f.run(),{code:'WORKSPACE_BINDING_CHANGED'});assert.equal(fs.readFileSync(join(f.plan.root,'plugin/.mcp.json'),'utf8'),'foreign edit');put(join(f.plan.root,'plugin/.mcp.json'),original.toString());
 assert.equal((await f.run()).status,'BOUND');
});
test('real process death after final configuration switch reconciles the same adoption without replacing the original plan',async t=>{
 const f=await fixture(t),requestRef=join(f.root,'binding-request.json');put(requestRef,f.request);const originalPlan=pin(join(f.plan.root,'installation-plan.json'));
 const script=`import fs from 'node:fs';import {bindPreparedWorkspace} from ${JSON.stringify(pathToFileURL(join(repo,'dist/installation/workspace/binding.js')).href)};const request=JSON.parse(fs.readFileSync(process.argv[1]));const rename=fs.renameSync;fs.renameSync=(from,to)=>{rename(from,to);if(to===request.serviceRoot+'/service-specification.json')process.kill(process.pid,'SIGKILL');};await bindPreparedWorkspace(request);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,requestRef],{stdio:['ignore','pipe','pipe']});let error='';child.stderr.on('data',b=>error+=b);const outcome=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));});assert.equal(outcome.signal,'SIGKILL',error);
 const binding=read(join(f.plan.root,'legacy-binding.json')),result=await f.run();assert.deepEqual(result.binding,binding);assert.equal(pin(join(f.plan.root,'installation-plan.json')),originalPlan);assert.equal(result.serviceStarted,false);
});
