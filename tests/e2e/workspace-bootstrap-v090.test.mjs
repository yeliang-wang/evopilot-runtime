// Real original Runtime state/files/locks; synthetic owner factories for fault
// injection. The separate actual published-owner probe is required as well.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {DatabaseSync} from 'node:sqlite';
import {prepareWorkspaceSetup,prepareWorkspaceSetupWithOwners} from '../../dist/installation/workspace/bootstrap.js';
import {createRuntimeService} from '../../dist/service.js';
import {inspectWorkspaceSnapshot} from '../../dist/workspace-migration.js';
import {inspectProjectTemplate} from '../../dist/compat/project/templates.js';
import {digest} from '../../dist/server/errors.js';
const put=(p,v)=>fs.writeFileSync(p,typeof v==='string'?v:JSON.stringify(v),{mode:0o600}),read=p=>JSON.parse(fs.readFileSync(p));
function fixture(t){
 const root=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'runtime-workspace-setup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const owners=Object.fromEntries(['ontology','harness'].map(o=>{const p=join(root,o+'-package');fs.mkdirSync(p,{mode:0o700});return[o,p];}));
 const request={requestId:'setup-one',mode:'initialize',projectRoot:join(root,'project'),workspaceRoot:join(root,'state'),workspaceId:'synthetic-setup',serviceRoot:join(root,'service'),owners};
 const control={calls:[],failOwner:null},factories={async initialize(owner,location){control.calls.push(owner);if(control.failOwner===owner){control.failOwner=null;throw Object.assign(Error('synthetic owner interruption'),{code:'OWNER_INTERRUPTED'});}if(owner==='runtime'){const s=createRuntimeService(location);try{s.initialize();}finally{s.close();}}else{const dir=join(location.workspaceRoot,'state',owner);fs.mkdirSync(dir,{recursive:true,mode:0o700});const p=join(dir,owner+'.db');if(!fs.existsSync(p))put(p,'SYNTHETIC '+owner);}},inspect(owner,location){if(owner==='runtime')return inspectWorkspaceSnapshot(location);const bytes=fs.readFileSync(join(location.workspaceRoot,'state',owner,owner+'.db'));return{product:owner,identity:read(join(location.workspaceRoot,'workspace.json')),snapshotDigest:digest(bytes.toString()),requiredKeyIds:[],unresolved:[]};}};
 return{root,request,control,factories,run:(r=request)=>prepareWorkspaceSetupWithOwners(r,factories)};
}

test('fresh preparation initializes all owners and frozen project files without starting, installing or activating Runtime',async t=>{
 const f=fixture(t),r=await f.run();assert.equal(r.status,'PREPARED');assert.equal(r.serviceBindingRequired,true);assert.equal(r.existingManagedBinding,null);assert.equal(r.serviceStarted,false);assert.equal(r.hostRegistered,false);assert.equal(r.sessionActivated,false);assert.equal(r.businessWorkDispatched,false);assert.equal(r.authority,false);assert(!fs.existsSync(f.request.serviceRoot));
 assert.deepEqual(f.control.calls,['runtime','ontology','harness']);assert.deepEqual(Object.keys(r.ownerSnapshots),['runtime','ontology','harness']);
 assert.equal(read(join(f.request.projectRoot,'workspace-project.json')).templateVersion,'0.2.0');for(const file of inspectProjectTemplate().files)assert.deepEqual(fs.readFileSync(join(f.request.projectRoot,file.relative)),file.bytes);
 for(const dir of ['public/ontology','public/harness','private/projects','private/governance'])assert(fs.statSync(join(f.request.projectRoot,dir)).isDirectory());
 const replay=await f.run();assert.deepEqual(replay,{...r,reused:true,currentEnvironmentVerified:false});assert.equal(f.control.calls.length,3);
 put(join(f.request.projectRoot,'README.md'),'later custom content');const attached=await f.run({...f.request,requestId:'another-request',mode:'attach'});assert.equal(attached.requestId,'setup-one');assert.equal(attached.currentEnvironmentVerified,false);assert.equal(fs.readFileSync(join(f.request.projectRoot,'README.md'),'utf8'),'later custom content');assert.equal(f.control.calls.length,3);
});

test('attachment preserves existing Runtime history, owner files and an older customized project marker',async t=>{
 const f=fixture(t);await f.run();const original=createRuntimeService({workspaceRoot:f.request.workspaceRoot,workspaceId:f.request.workspaceId});let expected;
 try{original.initialize();original.execute({operation:'project.create',scope:{visibility:'private',projectId:'existing'},input:{name:'retained project'},requestId:'create',expectedRevision:0});expected=original.execute({operation:'project.list',scope:{visibility:'private',projectId:'existing'},input:{}});}finally{original.close();}
 const marker=read(join(f.request.projectRoot,'workspace-project.json'));marker.templateVersion='0.1.1';put(join(f.request.projectRoot,'workspace-project.json'),marker);put(join(f.request.projectRoot,'README.md'),'custom documentation');
 const request={...f.request,requestId:'attach-existing',mode:'attach',serviceRoot:join(f.root,'second-service')},r=await f.run(request);assert.equal(r.mode,'attach');assert.equal(r.serviceBindingRequired,true);assert.equal(read(join(f.request.projectRoot,'workspace-project.json')).templateVersion,'0.1.1');assert.equal(fs.readFileSync(join(f.request.projectRoot,'README.md'),'utf8'),'custom documentation');
 const after=createRuntimeService({workspaceRoot:request.workspaceRoot,workspaceId:request.workspaceId});try{after.initialize();assert.deepEqual(after.execute({operation:'project.list',scope:{visibility:'private',projectId:'existing'},input:{}}),expected);}finally{after.close();}
});

test('occupied, foreign, symlinked or overlapping roots cannot be silently adopted or switched',async t=>{
 const f=fixture(t);fs.mkdirSync(f.request.projectRoot,{mode:0o700});put(join(f.request.projectRoot,'user.txt'),'keep');await assert.rejects(f.run(),{code:'PROJECT_OCCUPIED'});assert.equal(f.control.calls.length,0);assert(!fs.existsSync(f.request.workspaceRoot));
 await assert.rejects(f.run({...f.request,projectRoot:f.request.workspaceRoot}),{code:'MAINTENANCE_LOCATION'});
 const alias=join(f.root,'alias');fs.symlinkSync(f.request.projectRoot,alias);await assert.rejects(f.run({...f.request,projectRoot:alias}),{code:'SYMLINK'});
 fs.unlinkSync(join(f.request.projectRoot,'user.txt'));await f.run();await assert.rejects(f.run({...f.request,requestId:'switch',projectRoot:join(f.root,'another-project')}),{code:'WORKSPACE_ALREADY_BOUND'});
});

test('an interrupted owner initialization keeps the exact request, refuses replacement and resumes without losing Runtime records',async t=>{
 const f=fixture(t);f.control.failOwner='ontology';await assert.rejects(f.run(),{code:'OWNER_INTERRUPTED'});const journal=join(f.request.serviceRoot+'.evopilot-setup','requests','setup-one.json');assert.equal(read(journal).status,'INTERRUPTED');
 await assert.rejects(f.run({...f.request,requestId:'replacement'}),{code:'WORKSPACE_SETUP_PENDING'});await assert.rejects(f.run({...f.request,mode:'attach'}),{code:'WORKSPACE_SETUP_CONFLICT'});
 const resumed=await f.run();assert.equal(resumed.status,'PREPARED');assert.equal(read(journal).status,'VERIFIED');assert.equal(resumed.ownerSnapshots.runtime.revision,0);
});

test('an interrupted project publish resumes its owned staging links and preserves custom content',async t=>{
 const f=fixture(t),link=fs.linkSync;let interrupted=false;
 fs.linkSync=(from,to,...rest)=>{const result=link(from,to,...rest);if(!interrupted&&to===join(f.request.projectRoot,'docs/storage.md')){interrupted=true;throw Object.assign(Error('synthetic process loss after link'),{code:'EIO'});}return result;};
 try{await assert.rejects(f.run(),{code:'EIO'});}finally{fs.linkSync=link;}
 assert(interrupted);assert.equal(fs.statSync(join(f.request.projectRoot,'docs/storage.md')).nlink,2);put(join(f.request.projectRoot,'README.md'),'custom during recovery');const result=await f.run();assert.equal(result.status,'PREPARED');assert.equal(fs.statSync(join(f.request.projectRoot,'docs/storage.md')).nlink,1);assert.equal(fs.readFileSync(join(f.request.projectRoot,'README.md'),'utf8'),'custom during recovery');
});

test('active independent writers and retired connection claims block setup without starting or stopping a process',async t=>{
 const f=fixture(t);fs.mkdirSync(f.request.serviceRoot,{mode:0o700});fs.mkdirSync(join(f.request.serviceRoot,'data'),{mode:0o700});put(join(f.request.serviceRoot,'service-specification.json'),{schema:'runtime-user-service/v1',root:f.request.serviceRoot,workspaceId:f.request.workspaceId});const file=join(f.request.serviceRoot,'data/writer-lock.sqlite');put(file,'');const db=new DatabaseSync(file);db.exec('BEGIN EXCLUSIVE');
 try{await assert.rejects(f.run(),{code:'WRITER_ACTIVE'});assert.equal(f.control.calls.length,0);assert(!fs.existsSync(f.request.workspaceRoot));}finally{db.close();}
 const old=f.request.workspaceRoot+'.evopilot-control';fs.mkdirSync(old,{mode:0o700});put(join(old,'instance.json'),{retired:'must inspect'});await assert.rejects(f.run(),{code:'CONNECTION_MUST_STOP'});assert(fs.existsSync(join(old,'instance.json')));
});

test('aborted or revoked preparation never manufactures a selection, and unverified owner packages are rejected',async t=>{
 const f=fixture(t),controller=new AbortController();controller.abort();await assert.rejects(prepareWorkspaceSetupWithOwners(f.request,f.factories,controller.signal));assert(!fs.existsSync(f.request.serviceRoot+'.evopilot-setup'));
 await assert.rejects(prepareWorkspaceSetupWithOwners(f.request,f.factories,undefined,()=>{throw Object.assign(Error('revoked'),{code:'GRANT_REVOKED'});}),{code:'GRANT_REVOKED'});assert.equal(f.control.calls.length,0);
 await assert.rejects(prepareWorkspaceSetup(f.request),{code:'OWNER_DISTRIBUTION_CHANGED'});assert(!fs.existsSync(f.request.workspaceRoot));
});

test('request identifiers cannot collide with the selected installation record and lost selection evidence fails closed',async t=>{
 const f=fixture(t),request={...f.request,requestId:'selection'},r=await f.run(request);assert.equal(r.status,'PREPARED');const control=request.serviceRoot+'.evopilot-setup';assert.equal(read(join(control,'selection.json')).schema,'runtime-workspace-setup-selection/v1');assert.equal(read(join(control,'requests/selection.json')).schema,'runtime-workspace-setup-request/v1');
 fs.unlinkSync(join(control,'selection.json'));await assert.rejects(f.run(request),{code:'WORKSPACE_SETUP_CONFLICT'});
});

test('attachment can create the missing editable project while retaining the existing Workspace state',async t=>{
 const f=fixture(t);await f.run();const before=inspectWorkspaceSnapshot({workspaceRoot:f.request.workspaceRoot,workspaceId:f.request.workspaceId});
 const request={...f.request,requestId:'missing-project',mode:'attach',projectRoot:join(f.root,'new-editable-project'),serviceRoot:join(f.root,'new-service')};assert(!fs.existsSync(request.projectRoot));const result=await f.run(request);
 assert.equal(result.mode,'attach');assert.equal(read(join(request.projectRoot,'workspace-project.json')).id,request.workspaceId);assert.equal(inspectWorkspaceSnapshot({workspaceRoot:request.workspaceRoot,workspaceId:request.workspaceId}).snapshotDigest,before.snapshotDigest);assert(fs.existsSync(join(f.request.projectRoot,'workspace-project.json')));
});

test('a stopped service already bound to another owner Workspace cannot be switched by attach',async t=>{
 const f=fixture(t);await f.run();const serviceRoot=join(f.root,'bound-service');fs.mkdirSync(serviceRoot,{mode:0o700});put(join(serviceRoot,'service-specification.json'),{schema:'runtime-user-service/v1',root:serviceRoot,workspaceId:f.request.workspaceId,legacyRef:join(serviceRoot,'legacy-binding.json')});
 put(join(serviceRoot,'legacy-binding.json'),{workspaceRoot:join(f.root,'foreign-state'),workspaceId:f.request.workspaceId,serviceId:'other-service',migrationDigest:'a'.repeat(64)});put(join(serviceRoot,'connection.json'),{workspaceId:f.request.workspaceId,serviceId:'other-service'});
 const calls=f.control.calls.length;await assert.rejects(f.run({...f.request,requestId:'foreign-attach',mode:'attach',serviceRoot}),{code:'WORKSPACE_ALREADY_BOUND'});assert.equal(f.control.calls.length,calls);assert(!fs.existsSync(serviceRoot+'.evopilot-setup'));
});
