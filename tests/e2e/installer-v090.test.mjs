import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtempSync,realpathSync,readFileSync,writeFileSync,existsSync,rmSync,chmodSync,mkdirSync,readdirSync,symlinkSync,lstatSync,cpSync,readlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import childProcess,{spawn} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {initializeCredentials,tokenDigest} from '../../dist/server/security.js';
import {createRuntimeHttpClient} from '../../dist/host/client.js';
import {RuntimeStore} from '../../dist/server/store.js';
import {userServiceLabel,userServicePlist,inspectUserService,observeUserService,startUserService,stopUserService} from '../../dist/installation/service.js';
import {lifecycle,yaml} from '../fixtures/lifecycle-v090.mjs';
import {runInstaller,installerMain} from '../../dist/installation/installer.js';
import {createRuntimeService as historicalFixture} from '../fixtures/historical-runtime-v020.mjs';
import {createRuntimeService} from '../../dist/service.js';
import {inspectLegacyWorkspace,createLegacyBackup,verifyLegacyBackup,rollbackLegacyWorkspace} from '../../dist/installation/migration.js';
import {createManagedLegacyService} from '../../dist/compat/managed-service.js';
import {workspaceMaintenanceFixture} from '../fixtures/workspace-maintenance-v090.mjs';
import {inspectManagedWorkspace} from '../../dist/installation/workspace/snapshot.js';
import {createManagedWorkspaceBackup,verifyManagedWorkspaceBackup} from '../../dist/installation/workspace/backup.js';
import {forwardLegacyRuntime} from '../../dist/host/legacy-tools.js';
import {digest} from '../../dist/server/errors.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const repo=realpathSync(fileURLToPath(new URL('../../',import.meta.url))),node=realpathSync(process.execPath),nodeHash=createHash('sha256').update(readFileSync(node)).digest('hex');
async function fixture(){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'runtime-installer-')),workspaceId='installer-test',projectId='alpha',token=randomBytes(32).toString('base64url'),tokenRef=join(root,'client.json');
 initializeCredentials(join(root,'data'),workspaceId,[{id:'host',projects:[projectId],permissions:['read','draft.write'],revision:1,expiresAt:'2030-01-01T00:00:00Z',tokenDigest:tokenDigest(token)}]);
 writeFileSync(tokenRef,JSON.stringify({schema:'runtime-client-credential/v1',workspaceId,projectId,principalId:'host',token}),{mode:0o600});
 const occupied=createServer((_req,res)=>res.end('foreign port owner'));occupied.listen(0,'127.0.0.1');await once(occupied,'listening');const port=occupied.address().port;
 const spec={schema:'runtime-user-service/v1',root,packageRoot:repo,version:JSON.parse(readFileSync(join(repo,'package.json'))).version,nodeExecutable:node,nodeSha256:nodeHash,workspaceId,projectId,principalId:'host',tokenRef,port,integrationsRef:null};
 return{root,spec,occupied,async freePort(){if(occupied.listening)await new Promise(r=>occupied.close(r));},async cleanup(){if(process.platform==='darwin')await stopUserService(spec);if(occupied.listening)await new Promise(r=>occupied.close(r));rmSync(root,{recursive:true,force:true});}};
}
test('operator user-service specification fixes executable, scope, own label and protected files',async()=>{
 const f=await fixture();try{
  if(process.platform!=='darwin'){assert.throws(()=>userServicePlist(f.spec),{code:'SERVICE_PLATFORM'});return;}
  const plist=userServicePlist(f.spec);assert(plist.includes('<key>KeepAlive</key><false/>'));assert(plist.includes('<key>Umask</key><integer>63</integer>'));assert(plist.includes(userServiceLabel(f.spec)));assert(!plist.includes(JSON.parse(readFileSync(f.spec.tokenRef)).token));
  for(const change of [{port:80},{port:65536},{port:1.5}])assert.throws(()=>userServicePlist({...f.spec,...change}),{code:'SERVICE_PLATFORM'});
  assert.throws(()=>userServicePlist({...f.spec,nodeSha256:'0'.repeat(64)}),{code:'SERVICE_EXECUTABLE_CHANGED'});
  assert.throws(()=>userServicePlist({...f.spec,version:'999.0.0'}),{code:'SERVICE_VERSION'});
  assert.throws(()=>userServicePlist({...f.spec,projectId:'other'}),{code:'CREDENTIAL_SCOPE'});
  chmodSync(f.spec.tokenRef,0o644);assert.throws(()=>userServicePlist(f.spec),{code:'UNSAFE_STATE'});chmodSync(f.spec.tokenRef,0o600);
  assert.notEqual(userServiceLabel(f.spec),userServiceLabel({...f.spec,root:f.root+'-other'}));
 }finally{await f.cleanup();}
});
test('actual own launchd service survives transport exit, rejects duplicate writer and preserves receipts across stop/restart', {timeout:120000},async()=>{
 const f=await fixture();try{
  if(process.platform!=='darwin'){await assert.rejects(()=>startUserService(f.spec),{code:'SERVICE_PLATFORM'});return;}
  await f.freePort();const first=await startUserService(f.spec);assert.equal(first.running,true);assert(first.pid);assert.equal(first.identity.workspaceId,f.spec.workspaceId);
  const ref=join(f.root,'connection.json');writeFileSync(ref,JSON.stringify({schema:'runtime-host-connection/v1',origin:first.url,workspaceId:f.spec.workspaceId,projectId:'alpha',principalId:'host',serviceId:first.identity.serviceId,version:f.spec.version,tokenRef:f.spec.tokenRef}),{mode:0o600});
  const client=createRuntimeHttpClient(ref),draft={operation:'lifecycle.draft.save',projectId:'alpha',input:{yaml:yaml(lifecycle())},requestId:'retained-draft',expectedRevision:0};const original=await client.request(draft);assert.equal(original.result.revision,1);
  const repeated=await startUserService(f.spec);assert.equal(repeated.pid,first.pid);assert.equal(repeated.identity.serviceId,first.identity.serviceId);assert.equal((await observeUserService(f.spec)).identity.revision,1);
  assert.throws(()=>new RuntimeStore(join(f.root,'data'),f.spec.workspaceId),{code:'WRITER_ACTIVE'});
  await assert.rejects(()=>startUserService({...f.spec,port:f.spec.port===65535?65534:f.spec.port+1}),{code:'INSTALLATION_CHANGED'});
  assert.equal((await stopUserService(f.spec)).registered,false);assert.equal((await stopUserService(f.spec)).registered,false);assert(existsSync(join(f.root,'data/service.sqlite')));assert(existsSync(join(f.root,'service-specification.json')));
  const restarted=await startUserService(f.spec);assert.equal(restarted.identity.serviceId,first.identity.serviceId);assert.equal(restarted.identity.revision,1);const replay=await client.request(draft);assert.deepEqual(replay.result,original.result);assert.equal((await inspectUserService(f.spec)).pid,restarted.pid);
 }finally{await f.cleanup();}
});
test('port conflict preserves foreign listener and retained failure, then recovers only the owned launchd item', {timeout:120000},async()=>{
 const f=await fixture();try{
  if(process.platform!=='darwin'){await assert.rejects(()=>startUserService(f.spec),{code:'SERVICE_PLATFORM'});return;}
  await assert.rejects(()=>startUserService(f.spec),e=>['SERVICE_NOT_READY','SERVICE_IDENTITY_CONFLICT'].includes(e.code));assert.equal(await(await fetch('http://127.0.0.1:'+f.spec.port)).text(),'foreign port owner');
  const log=readFileSync(join(f.root,'service.stdout.log'),'utf8');assert(log.includes('PORT_IN_USE'));assert(existsSync(join(f.root,'data/service.sqlite')));
  await f.freePort();const recovered=await startUserService(f.spec);assert.equal(recovered.running,true);assert.equal(recovered.identity.workspaceId,f.spec.workspaceId);assert(readFileSync(join(f.root,'service.stdout.log'),'utf8').startsWith(log));
 }finally{await f.cleanup();}
});

function distributionFixture(){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'runtime-distribution-')),source=join(root,'source');mkdirSync(source,{mode:0o700});
 const content={'package.json':JSON.stringify({name:'@evopilot-next/runtime',version:'0.8.3'}),'dist/server/cli.js':'#!/usr/bin/env node\n// synthetic staged inventory; never executed\n','dist/host/header-helper.js':'// synthetic staged helper; never executed\n','plugins/codex/.codex-plugin/plugin.json':'{}\n','plugins/codex/mcp.template.json':'{}\n'},files={};
 for(const [name,body] of Object.entries(content)){mkdirSync(dirname(join(source,name)),{recursive:true,mode:0o700});writeFileSync(join(source,name),body,{mode:0o644});files[name]={type:'file',sha256:createHash('sha256').update(body).digest('hex'),bytes:Buffer.byteLength(body),mode:0o644};}
 const archiveRef=join(root,'synthetic-archive'),archive=Buffer.from('Explicit synthetic package inventory test, not a published release');writeFileSync(archiveRef,archive,{mode:0o600});
 const manifest={schema:'runtime-standalone-distribution/v1',version:'0.8.3',archiveDigest:createHash('sha256').update(archive).digest('hex'),files},manifestRef=join(root,'manifest.json');
 const putManifest=()=>{const bytes=JSON.stringify(manifest);writeFileSync(manifestRef,bytes,{mode:0o600});return createHash('sha256').update(bytes).digest('hex');};
 const plan={schema:'runtime-install-plan/v1',root:join(root,'installed'),distribution:{packageRoot:source,manifestRef,manifestDigest:putManifest(),archiveRef,archiveDigest:manifest.archiveDigest},nodeExecutable:node,nodeSha256:nodeHash,workspaceId:'installer-test',projectId:'alpha',principalId:'reader',role:'reader',credentialExpiresAt:new Date(Date.now()+86400000).toISOString(),port:33331,integrationsRef:null,codex:null};
 return{root,source,plan,manifest,putManifest,content,cleanup(){rmSync(root,{recursive:true,force:true});}};
}
test('operator stages exact distribution and least-authority credential without starting service or enabling a Host',async()=>{
 const f=distributionFixture();try{
  const first=await runInstaller(f.plan,'stage');assert.equal(first.phase,'STAGED');assert.equal(first.serviceStarted,false);assert.equal(first.hostRegistered,false);assert.equal(first.productAcceptance,'NOT_EVALUATED');
  const auth=readFileSync(join(f.plan.root,'data/auth.json')),credential=readFileSync(join(f.plan.root,'client.json'));assert.deepEqual(JSON.parse(auth).principals[0].permissions,['read']);assert.equal(lstatSync(join(f.plan.root,'client.json')).mode&0o777,0o600);assert(!existsSync(join(f.plan.root,'service.plist')));assert(!existsSync(join(f.plan.root,'plugin')));
  const second=await runInstaller(f.plan,'stage');assert.equal(second.phase,'STAGED');assert.notEqual(first.operation,second.operation);assert.deepEqual(readFileSync(join(f.plan.root,'data/auth.json')),auth);assert.deepEqual(readFileSync(join(f.plan.root,'client.json')),credential);
  const logs=readdirSync(join(f.plan.root,'installation-audit')).map(n=>readFileSync(join(f.plan.root,'installation-audit',n),'utf8')).join('');assert(!logs.includes(JSON.parse(credential).token));
  if(process.platform==='darwin'){const removed=await runInstaller(f.plan,'uninstall');assert.equal(removed.phase,'UNINSTALLED');assert.equal(removed.dataRetained,true);assert.deepEqual(readFileSync(join(f.plan.root,'data/auth.json')),auth);}
 }finally{f.cleanup();}
});
test('explicit operator staging provisions existing scoped permissions without changing retained installations',async()=>{
 const f=distributionFixture();try{
  const plan={...f.plan,role:'operator'};await runInstaller(plan,'stage');
  const auth=readFileSync(join(plan.root,'data/auth.json')),principal=JSON.parse(auth).principals[0];
  assert.deepEqual(principal.projects,['alpha']);assert.deepEqual(principal.permissions,['read','draft.write','definition.activate','execution.request','decision.record','release.request']);
  assert(!existsSync(join(plan.root,'data/service.sqlite')),'Provisioning must not create lifecycle instances or authority records');
  await runInstaller(plan,'stage');assert.deepEqual(readFileSync(join(plan.root,'data/auth.json')),auth);
  await assert.rejects(()=>runInstaller({...plan,role:'activator'},'stage'),{code:'INSTALLATION_CHANGED'});assert.deepEqual(readFileSync(join(plan.root,'data/auth.json')),auth);
 }finally{f.cleanup();}
});
test('failed archive or source digest never installs unchecked bytes; recovery retains original failure',async()=>{
 const f=distributionFixture();try{
  writeFileSync(join(f.source,'dist/server/cli.js'),'changed');await assert.rejects(()=>runInstaller(f.plan,'stage'),{code:'INSTALLATION_DISTRIBUTION'});assert(!existsSync(join(f.plan.root,'data/auth.json')));
  const failures=readdirSync(join(f.plan.root,'installation-audit')).filter(n=>n.endsWith('-failure.json'));assert.equal(failures.length,1);
  writeFileSync(join(f.source,'dist/server/cli.js'),f.content['dist/server/cli.js']);await runInstaller(f.plan,'stage');assert(existsSync(join(f.plan.root,'installation-audit',failures[0])));
  writeFileSync(f.plan.distribution.archiveRef,'changed archive');await assert.rejects(()=>runInstaller(f.plan,'stage'),{code:'INSTALLATION_DIGEST'});
 }finally{f.cleanup();}
});
test('installer preserves foreign directories, conflicting plans and changed installed files',async()=>{
 const f=distributionFixture();try{
  mkdirSync(f.plan.root,{mode:0o700});writeFileSync(join(f.plan.root,'foreign-record'),'retain',{mode:0o600});await assert.rejects(()=>runInstaller(f.plan,'stage'),{code:'INSTALLATION_NOT_OWNED'});assert.equal(readFileSync(join(f.plan.root,'foreign-record'),'utf8'),'retain');rmSync(join(f.plan.root,'foreign-record'));
  await runInstaller(f.plan,'stage');const auth=readFileSync(join(f.plan.root,'data/auth.json'));
  await assert.rejects(()=>runInstaller({...f.plan,role:'activator'},'stage'),{code:'INSTALLATION_CHANGED'});assert.deepEqual(readFileSync(join(f.plan.root,'data/auth.json')),auth);
  writeFileSync(join(f.plan.root,'package/dist/server/cli.js'),'changed installed file');await assert.rejects(()=>runInstaller(f.plan,'stage'),{code:'INSTALLATION_DISTRIBUTION'});assert.equal(readFileSync(join(f.plan.root,'package/dist/server/cli.js'),'utf8'),'changed installed file');
 }finally{f.cleanup();}
});
test('partial package recovery preserves credentials and serializes local installers',async()=>{
 const f=distributionFixture();let lock;try{
  await runInstaller(f.plan,'stage');const auth=readFileSync(join(f.plan.root,'data/auth.json'));rmSync(join(f.plan.root,'package/dist/host/header-helper.js'));await runInstaller(f.plan,'stage');assert.equal(readFileSync(join(f.plan.root,'package/dist/host/header-helper.js'),'utf8'),f.content['dist/host/header-helper.js']);assert.deepEqual(readFileSync(join(f.plan.root,'data/auth.json')),auth);
  lock=new DatabaseSync(join(f.plan.root,'installer-lock.sqlite'));lock.exec('BEGIN EXCLUSIVE');await assert.rejects(()=>runInstaller(f.plan,'stage'),{code:'INSTALLER_ACTIVE'});lock.close();lock=null;
  rmSync(join(f.plan.root,'client.json'));await assert.rejects(()=>runInstaller(f.plan,'stage'),{code:'INSTALLATION_CREDENTIAL'});assert.deepEqual(readFileSync(join(f.plan.root,'data/auth.json')),auth);
 }finally{lock?.close();f.cleanup();}
});
test('distribution links cannot escape the selected package and symlink ancestors cannot redirect installation',async()=>{
 const f=distributionFixture();try{
  symlinkSync('../synthetic-archive',join(f.source,'outside'));f.manifest.files.outside={type:'symlink',target:'../synthetic-archive'};f.plan.distribution.manifestDigest=f.putManifest();await assert.rejects(()=>runInstaller(f.plan,'stage'),{code:'INSTALLATION_DISTRIBUTION'});
  const alias=join(f.root,'alias');symlinkSync(f.source,alias);const other={...f.plan,root:join(f.root,'other'),distribution:{...f.plan.distribution,packageRoot:alias}};await assert.rejects(()=>runInstaller(other,'stage'),{code:'INSTALLATION_PATH'});
 }finally{f.cleanup();}
});
test('operator installer CLI never accepts raw credentials or a shell command',async()=>{
 let output='';assert.equal(await installerMain(['install','--token','raw-secret'],{write:v=>output+=v}),1);assert.equal(JSON.parse(output).error.code,'INSTALLER_ARGUMENT');assert(!output.includes('raw-secret'));
 output='';assert.equal(await installerMain(['shell','--plan-ref','/invalid'],{write:v=>output+=v}),1);assert.equal(JSON.parse(output).error.code,'INSTALLER_ARGUMENT');
});

function legacyFixture(f){
 const options={workspaceRoot:join(f.root,'original'),workspaceId:f.plan.workspaceId},scope={visibility:'private',projectId:f.plan.projectId};
 const old=historicalFixture(options);old.initialize();
 const original=old.execute({operation:'project.create',scope,input:{name:'Retained original'},requestId:'original-project',expectedRevision:0});old.close();
 const snapshot=inspectLegacyWorkspace(options.workspaceRoot,options.workspaceId),backupRoot=join(f.root,'legacy-backup'),backup=createLegacyBackup(options.workspaceRoot,options.workspaceId,snapshot.snapshotDigest,backupRoot);
 f.plan.legacyMigration={workspaceRoot:options.workspaceRoot,expectedSnapshotDigest:snapshot.snapshotDigest,backupRoot,expectedBackupDigest:backup.backupDigest};
 // A read-only SQLite open can itself leave WAL sidecars. Inspect the closed
 // header without opening a connection, as the migration protocol requires.
 return{options,scope,original,backup,db:join(options.workspaceRoot,'state/runtime/runtime.db'),schema(){return readFileSync(this.db).readUInt32BE(60);}};
}

// SYNTHETIC bounded source guards. The published old-package E17 journey is
// collected separately; these tests confer no acceptance/release authority.
async function rollbackFixture(t){
 const f=workspaceMaintenanceFixture(t),{workspaceRoot,workspaceId}=f.selection,scope={visibility:'private',projectId:'synthetic'};
 const original=JSON.parse(readFileSync(join(f.root,'pre-adoption/manifest.json'))),service=createManagedLegacyService(f.binding);
 let newer;try{newer=service.execute({operation:'goal.create',scope,input:{id:'after-adoption',description:'Retain this pending new evidence'},requestId:'after-adoption',expectedRevision:1});}finally{service.close();}
 const blob=Buffer.from('Synthetic additive evidence retained across old-format rollback'),sha=createHash('sha256').update(blob).digest('hex');
 mkdirSync(join(workspaceRoot,'public/runtime'),{recursive:true,mode:0o700});const blobRef=join(workspaceRoot,'public/runtime',sha+'.raw');writeFileSync(blobRef,blob,{mode:0o600});
 const snapshot=await inspectManagedWorkspace(f.selection,'rollback-inspect'),saved=await createManagedWorkspaceBackup(f.selection,'rollback-preserve',snapshot.snapshotDigest,f.backupRoot);
 const request={schema:'runtime-legacy-rollback-plan/v1',requestId:'rollback',selection:f.selection,backupRoot:join(f.root,'pre-adoption'),expectedBackupDigest:original.backupDigest,expectedSourceSnapshotDigest:original.snapshot.snapshotDigest,preservationRoot:f.backupRoot,expectedPreservationBackupDigest:saved.backupDigest,expectedManagedSnapshotDigest:snapshot.snapshotDigest};
 return{...f,request,original,saved,newer,blobRef,blob,db:join(workspaceRoot,'state/runtime/runtime.db'),oldBytes:readFileSync(join(request.backupRoot,'payload/state/runtime/runtime.db')),newBytes:readFileSync(join(workspaceRoot,'state/runtime/runtime.db')),serviceBytes:readFileSync(join(f.selection.serviceRoot,'data/service.sqlite')),scope,workspaceId};
}
test('synthetic legacy rollback restores exact old DB and preserves new evidence, service ledger and historical replay',async t=>{
 const f=await rollbackFixture(t),result=await rollbackLegacyWorkspace(f.request);
 assert.equal(result.status,'OLD_FORMAT_RESTORED');assert.equal(result.sourceSchemaVersion,f.original.snapshot.schemaVersion);assert.equal(result.managedSchemaVersion,9);
 assert.deepEqual(readFileSync(f.db),f.oldBytes);assert.deepEqual(readFileSync(result.preservedDatabase),f.newBytes);assert.equal(lstatSync(result.preservedDatabase).nlink,1);assert.equal(lstatSync(f.db).nlink,1);
 assert.deepEqual(readFileSync(join(f.request.preservationRoot,'workspace/state/runtime/runtime.db')),f.newBytes);assert.deepEqual(readFileSync(f.blobRef),f.blob);
 assert.deepEqual(readFileSync(join(f.selection.serviceRoot,'data/service.sqlite')),f.serviceBytes);assert.deepEqual(result.restoredSnapshot.database,f.original.snapshot.database);assert.equal(result.restoredSnapshot.recordsDigest,f.original.snapshot.recordsDigest);
 assert.notEqual(result.restoredSnapshot.snapshotDigest,f.original.snapshot.snapshotDigest,'Additive evidence must not be described as full historical snapshot equality');assert(result.additiveEntries.some(e=>e.path.endsWith('.raw')));
 for(const flag of ['currentStateAttestation','serviceStarted','hostRegistered','businessWorkDispatched','authority'])assert.equal(result[flag],false);
 assert.throws(()=>createManagedLegacyService(f.binding),{code:'MIGRATION_REQUIRED'});
 const old=createRuntimeService({workspaceRoot:f.selection.workspaceRoot,workspaceId:f.workspaceId});old.initialize();
 try{const original=old.execute({operation:'receipt.inspect',scope:f.scope,input:{requestId:'original-project'}});assert.equal(original.revision,1);assert.throws(()=>old.execute({operation:'receipt.inspect',scope:f.scope,input:{requestId:'after-adoption'}}));old.execute({operation:'goal.create',scope:f.scope,input:{id:'after-rollback',description:'Later independently requested synthetic write'},requestId:'after-rollback',expectedRevision:1});}finally{old.close();}
 const later=readFileSync(f.db);assert.deepEqual(await rollbackLegacyWorkspace(f.request),result);assert.deepEqual(readFileSync(f.db),later,'Completed replay does not roll back subsequent work');assert.deepEqual(verifyManagedWorkspaceBackup(f.request.preservationRoot,f.saved.backupDigest),f.saved);
});
test('synthetic legacy rollback recovers injected interruptions immediately before and after link and rename',async t=>{
 for(const operation of ['linkSync','renameSync'])for(const when of ['before','after'])await t.test(operation+' '+when,async t=>{
  const f=await rollbackFixture(t),original=fs[operation];let injected=false;
  fs[operation]=function(from,to,...args){const target=operation==='linkSync'?from===f.db:String(from).endsWith('/old.sqlite');if(target&&!injected){injected=true;if(when==='before')throw Object.assign(new Error('Synthetic interruption'),{code:'INJECTED_ROLLBACK'});const result=original.call(this,from,to,...args);throw Object.assign(new Error('Synthetic interruption after syscall'),{code:'INJECTED_ROLLBACK',result});}return original.call(this,from,to,...args);};syncBuiltinESMExports();
  try{await assert.rejects(rollbackLegacyWorkspace(f.request),{code:'INJECTED_ROLLBACK'});}finally{fs[operation]=original;syncBuiltinESMExports();}
  assert(injected);const control=f.selection.workspaceRoot+'.evopilot-legacy-rollback/rollback',preserved=join(control,'managed.sqlite');
  assert.deepEqual(readFileSync(join(f.request.preservationRoot,'workspace/state/runtime/runtime.db')),f.newBytes);assert.deepEqual(readFileSync(join(f.selection.serviceRoot,'data/service.sqlite')),f.serviceBytes);
  if(operation==='renameSync'&&when==='after'){assert.deepEqual(readFileSync(f.db),f.oldBytes);assert.deepEqual(readFileSync(preserved),f.newBytes);}
  else{assert.deepEqual(readFileSync(f.db),f.newBytes);if(existsSync(preserved)){assert.equal(lstatSync(f.db).nlink,2);assert.equal(lstatSync(f.db).ino,lstatSync(preserved).ino);assert.throws(()=>createManagedLegacyService(f.binding),'Existing nlink guard remains strict');}}
  const result=await rollbackLegacyWorkspace(f.request);assert.deepEqual(readFileSync(f.db),f.oldBytes);assert.deepEqual(readFileSync(result.preservedDatabase),f.newBytes);assert.equal(JSON.parse(readFileSync(join(control,'journal.json'))).phase,'VERIFIED');
 });
});
test('synthetic legacy rollback rejects stale snapshots, foreign partials, active writers and corrupt anchors without publication',async t=>{
 for(const change of ['snapshot','seal','backup','evidence','partial','writer','sidecar'])await t.test(change,async t=>{
  const f=await rollbackFixture(t);let writer;
  if(change==='snapshot')f.request.expectedManagedSnapshotDigest='0'.repeat(64);
  if(change==='seal')f.request.selection.migrationDigest='0'.repeat(64);
  if(change==='backup')writeFileSync(join(f.request.backupRoot,'payload/state/runtime/runtime.db'),'Synthetic corruption');
  if(change==='evidence')writeFileSync(join(f.selection.projectRoot,'assets/asset.json'),'Changed current owner asset');
  if(change==='partial'){const control=f.selection.workspaceRoot+'.evopilot-legacy-rollback/rollback';mkdirSync(control,{recursive:true,mode:0o700});writeFileSync(join(control,'unknown.txt'),'Do not erase',{mode:0o600});}
  if(change==='writer')writer=createManagedLegacyService(f.binding);
  if(change==='sidecar')writeFileSync(f.db+'-journal','Unknown sidecar',{mode:0o600});
  try{await assert.rejects(rollbackLegacyWorkspace(f.request));assert.deepEqual(readFileSync(f.db),f.newBytes);assert.deepEqual(readFileSync(join(f.selection.serviceRoot,'data/service.sqlite')),f.serviceBytes);if(change==='partial')assert.equal(readFileSync(f.selection.workspaceRoot+'.evopilot-legacy-rollback/rollback/unknown.txt','utf8'),'Do not erase');}finally{writer?.close();}
 });
});
test('synthetic legacy rollback refuses extra hard links and changed staged bytes while preserving the interrupted pair',async t=>{
 for(const change of ['extra-link','stage','new-evidence'])await t.test(change,async t=>{
  const f=await rollbackFixture(t),original=fs.linkSync;
  fs.linkSync=function(from,to){const result=original(from,to);if(from===f.db)throw Object.assign(new Error('Synthetic interrupted pair'),{code:'INJECTED_ROLLBACK'});return result;};syncBuiltinESMExports();
  try{await assert.rejects(rollbackLegacyWorkspace(f.request),{code:'INJECTED_ROLLBACK'});}finally{fs.linkSync=original;syncBuiltinESMExports();}
  const control=f.selection.workspaceRoot+'.evopilot-legacy-rollback/rollback';
  if(change==='extra-link')fs.linkSync(f.db,join(f.root,'foreign-link'));
  if(change==='stage')writeFileSync(join(control,'old.sqlite'),'Unknown staged bytes');
  if(change==='new-evidence')writeFileSync(join(f.selection.projectRoot,'new-evidence'),'New owner evidence',{mode:0o600});
  await assert.rejects(rollbackLegacyWorkspace(f.request),{code:'LEGACY_ROLLBACK_CONFLICT'});assert.deepEqual(readFileSync(f.db),f.newBytes);assert.deepEqual(readFileSync(join(control,'managed.sqlite')),f.newBytes);assert.equal(lstatSync(f.db).nlink,change==='extra-link'?3:2);
 });
});
test('migration is explicit: staging verifies selected backup but does not adopt or change original records',async()=>{
 const f=distributionFixture();try{
  const legacy=legacyFixture(f),bytes=readFileSync(legacy.db),result=await runInstaller(f.plan,'stage');assert.equal(result.phase,'STAGED');assert.deepEqual(readFileSync(legacy.db),bytes);assert.equal(legacy.schema(),1);
  const spec=JSON.parse(readFileSync(join(f.plan.root,'service-specification.json')));assert.equal(spec.legacyRef,join(f.plan.root,'legacy-binding.json'));assert(!existsSync(spec.legacyRef));assert(!existsSync(join(f.plan.root,'legacy-adoption.json')));assert(!existsSync(join(f.plan.root,'data/service.sqlite')));
  if(process.platform==='darwin'){await runInstaller(f.plan,'uninstall');assert.deepEqual(readFileSync(legacy.db),bytes);}
  const payload=join(f.plan.legacyMigration.backupRoot,'payload/state/runtime/runtime.db');writeFileSync(payload,'corrupted backup');await assert.rejects(()=>runInstaller(f.plan,'stage'),{code:'MIGRATION_BACKUP_CHANGED'});assert.deepEqual(readFileSync(legacy.db),bytes);
 }finally{f.cleanup();}
});
test('migration rejects different scope, anchors and overlapping original/backup/installation paths',async()=>{
 for(const mutation of ['scope','snapshot','backup','overlap']){
  const f=distributionFixture();try{
   const legacy=legacyFixture(f),bytes=readFileSync(legacy.db);
   if(mutation==='scope')f.plan.workspaceId='other';
   if(mutation==='snapshot')f.plan.legacyMigration.expectedSnapshotDigest='1'.repeat(64);
   if(mutation==='backup')f.plan.legacyMigration.expectedBackupDigest='2'.repeat(64);
   if(mutation==='overlap')f.plan.root=join(f.plan.legacyMigration.workspaceRoot,'installation');
   await assert.rejects(()=>runInstaller(f.plan,'stage'),{code:mutation==='overlap'?'MIGRATION_BACKUP_PATH':'MIGRATION_BACKUP_CHANGED'});assert.deepEqual(readFileSync(legacy.db),bytes);assert(!existsSync(join(f.plan.root,'data/auth.json')));
  }finally{f.cleanup();}
 }
});
test('changed source or an active new writer cannot be adopted by installer startup',async()=>{
 const f=distributionFixture();let store;try{
  const legacy=legacyFixture(f);await runInstaller(f.plan,'stage');
  if(process.platform!=='darwin'){await assert.rejects(()=>runInstaller(f.plan,'start'),{code:'SERVICE_PLATFORM'});return;}
  store=new RuntimeStore(join(f.plan.root,'data'),f.plan.workspaceId);await assert.rejects(()=>runInstaller(f.plan,'start'),{code:'WRITER_ACTIVE'});assert.equal(legacy.schema(),1);store.close();store=null;
  const old=historicalFixture(legacy.options);old.initialize();old.execute({operation:'goal.create',scope:legacy.scope,input:{id:'changed',description:'Preserve this newer data'},requestId:'later',expectedRevision:1});old.close();
  const bytes=readFileSync(legacy.db);await assert.rejects(()=>runInstaller(f.plan,'start'),{code:'SNAPSHOT_DRIFT'});assert.deepEqual(readFileSync(legacy.db),bytes);assert.equal(legacy.schema(),1);assert(!existsSync(join(f.plan.root,'service.plist')));
 }finally{store?.close();f.cleanup();}
});
test('owner Host selection requires migration and its exact scope/digest before old state adoption',async()=>{
 const f=distributionFixture();try{
  const legacy=legacyFixture(f),ref=join(f.root,'owners.json'),config={schema:'runtime-legacy-owner-host/v1',workspaceId:f.plan.workspaceId,projectId:f.plan.projectId,legacyBindingRef:join(f.plan.root,'legacy-binding.json'),expiresAt:'2030-01-01T00:00:00Z',owners:Object.fromEntries(['ontology','harness'].map(owner=>[owner,{packageRoot:join(f.root,owner),calls:['request:workspace.inspect']}]))};writeFileSync(ref,JSON.stringify(config),{mode:0o600});f.plan.legacyOwnerHost={ref,digest:digest(config)};
  const noMigration={...f.plan};delete noMigration.legacyMigration;await assert.rejects(()=>runInstaller(noMigration,'stage'),{code:'MIGRATION_REQUIRED'});
  await runInstaller(f.plan,'stage');assert.equal(legacy.schema(),1);assert(!existsSync(config.legacyBindingRef));
  writeFileSync(ref,JSON.stringify({...config,expiresAt:'2031-01-01T00:00:00Z'}));await assert.rejects(()=>runInstaller(f.plan,'stage'),{code:'OWNER_HOST_CHANGED'});assert.equal(legacy.schema(),1);
  if(process.platform==='darwin')await runInstaller(f.plan,'stop');
 }finally{f.cleanup();}
});

function providerSelection(f){
 const projectRoot=join(f.root,'project'),ownerRoot=join(f.root,'owners');mkdirSync(projectRoot,{mode:0o700});mkdirSync(ownerRoot,{mode:0o700});
 const ref=join(f.root,'providers.json'),config={schema:'runtime-legacy-providers/v1',workspaceId:f.plan.workspaceId,projects:[f.plan.projectId],legacyBindingRef:join(f.plan.root,'legacy-binding.json'),projectRoot,expiresAt:'2030-01-01T00:00:00Z',owners:{ontology:{packageRoot:ownerRoot},harness:{packageRoot:ownerRoot}},nativeToolchain:{path:'/not-loaded-while-staging',digest:'synthetic',lockDigest:'synthetic'}};
 writeFileSync(ref,JSON.stringify(config),{mode:0o600});f.plan.legacyProviders={ref,digest:digest(config)};return{ref,config};
}
test('installer pins provider selection before migration without loading owners or granting execution',async()=>{
 const f=distributionFixture();try{
  const legacy=legacyFixture(f),p=providerSelection(f),original=readFileSync(legacy.db);
  const noMigration={...f.plan};delete noMigration.legacyMigration;await assert.rejects(()=>runInstaller(noMigration,'stage'),{code:'MIGRATION_REQUIRED'});
  await runInstaller(f.plan,'stage');assert.deepEqual(readFileSync(legacy.db),original);assert.equal(legacy.schema(),1);assert(!existsSync(p.config.legacyBindingRef));
  const spec=JSON.parse(readFileSync(join(f.plan.root,'service-specification.json')));assert.deepEqual(spec.legacyProviders,f.plan.legacyProviders);assert.deepEqual(JSON.parse(readFileSync(join(f.plan.root,'data/auth.json'))).principals[0].permissions,['read']);
  if(process.platform==='darwin'){const plist=userServicePlist(spec);assert(plist.includes('<string>--legacy-providers-ref</string><string>'+p.ref+'</string>'));assert(!plist.includes('--eval'));}
  writeFileSync(p.ref,JSON.stringify({...p.config,projects:['other']}));await assert.rejects(()=>runInstaller(f.plan,'start'),{code:'LEGACY_PROVIDER_CHANGED'});assert.deepEqual(readFileSync(legacy.db),original);
  rmSync(p.ref);if(process.platform==='darwin'){assert.equal((await runInstaller(f.plan,'stop')).phase,'STOPPED');assert.equal((await runInstaller(f.plan,'uninstall')).phase,'UNINSTALLED');}assert.deepEqual(readFileSync(legacy.db),original);
 }finally{f.cleanup();}
});
test('installer rejects provider scope and credential-shaped registration drift before source adoption',async()=>{
 for(const mutation of ['workspace','project','binding','digest','unsafe']){
  const f=distributionFixture();try{
   const legacy=legacyFixture(f),p=providerSelection(f),original=readFileSync(legacy.db);
   if(mutation==='workspace')p.config.workspaceId='other';if(mutation==='project')p.config.projects=['other'];if(mutation==='binding')p.config.legacyBindingRef=join(f.root,'foreign-binding.json');
   writeFileSync(p.ref,JSON.stringify(p.config));f.plan.legacyProviders.digest=mutation==='digest'?'0'.repeat(64):digest(p.config);if(mutation==='unsafe')chmodSync(p.ref,0o644);
   await assert.rejects(()=>runInstaller(f.plan,'stage'),{code:mutation==='digest'?'LEGACY_PROVIDER_CHANGED':mutation==='unsafe'?'UNSAFE_STATE':'LEGACY_PROVIDER_SCOPE'});assert.deepEqual(readFileSync(legacy.db),original);assert(!existsSync(join(f.plan.root,'data/auth.json')));
  }finally{f.cleanup();}
 }
});

/** Actual compiled development service and locked production dependencies. The
 * synthetic archive anchor is explicitly not release/distribution acceptance. */
function developmentDistribution(){
 const f=distributionFixture();rmSync(f.source,{recursive:true});mkdirSync(f.source,{mode:0o700});
 for(const name of ['package.json','dist','vendor','lifecycle','plugins'])cpSync(join(repo,name),join(f.source,name),{recursive:true});
 const lock=JSON.parse(readFileSync(join(repo,'package-lock.json')));
 for(const [name,pkg] of Object.entries(lock.packages).sort(([a],[b])=>a.localeCompare(b))){if(!name.startsWith('node_modules/')||pkg.dev||existsSync(join(f.source,name)))continue;mkdirSync(dirname(join(f.source,name)),{recursive:true,mode:0o700});cpSync(join(repo,name),join(f.source,name),{recursive:true});}
 f.manifest.version=JSON.parse(readFileSync(join(repo,'package.json'))).version;f.manifest.files={};
 function inventory(relative=''){for(const name of readdirSync(join(f.source,relative))){const key=relative?relative+'/'+name:name,path=join(f.source,key),stat=lstatSync(path);if(stat.isSymbolicLink())f.manifest.files[key]={type:'symlink',target:readlinkSync(path)};else if(stat.isDirectory()){chmodSync(path,0o700);inventory(key);}else{const bytes=readFileSync(path),mode=(stat.mode&0o111)?0o755:0o644;chmodSync(path,mode);f.manifest.files[key]={type:'file',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,mode};}}}
 inventory();f.plan.distribution.manifestDigest=f.putManifest();return f;
}
test('unbound installed operator controls its own service without treating package ancestors as a Workspace', {timeout:120000},async()=>{
 if(process.platform!=='darwin')return;
 const f=developmentDistribution();let spec;
 try{
  f.plan.role='editor';const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');f.plan.port=socket.address().port;await new Promise(r=>socket.close(r));
  const first=await runInstaller(f.plan,'install');spec=JSON.parse(readFileSync(join(f.plan.root,'service-specification.json')));
  const client=createRuntimeHttpClient(join(f.plan.root,'connection.json')),request={operation:'lifecycle.draft.save',projectId:f.plan.projectId,input:{yaml:yaml(lifecycle())},requestId:'unbound-retained-draft',expectedRevision:0},original=await client.request(request);
  const api=await import(pathToFileURL(join(f.plan.root,'package/dist/installation/service-control.js')).href),selection=api.inspectInstalledServiceSelection(f.plan.root);assert.equal(selection.binding,null);
  const preserved=Object.fromEntries(['installation-plan.json','connection.json','client.json','data/auth.json'].map(p=>[p,readFileSync(join(f.plan.root,p))]));
  const stopped=await api.operateInstalledService(selection,'stop');assert.equal(stopped.service.registered,false);assert.equal(stopped.businessWorkDispatched,false);
  assert(!existsSync(f.plan.root+'.evopilot-coordination'),'An installation/package ancestor is not a legacy Workspace');
  assert(existsSync(f.plan.root+'.evopilot-operations.evopilot-coordination/lease.db'));
  const started=await api.operateInstalledService(selection,'start');assert.equal(started.service.running,true);assert.equal(started.service.identity.serviceId,first.service.identity.serviceId);assert.equal(started.hostRegistered,false);
  assert.deepEqual((await client.request(request)).result,original.result,'Original draft receipt is reconciled, not written again');
  for(const [p,bytes] of Object.entries(preserved))assert.deepEqual(readFileSync(join(f.plan.root,p)),bytes,p);
  await api.operateInstalledService(selection,'stop');
 }finally{if(spec)await stopUserService(spec);f.cleanup();}
});

test('installed current-selection start recovers real SIGKILL before and after commit and preserves the same service receipts', {timeout:120000},async()=>{
 if(process.platform!=='darwin')return;
 const f=developmentDistribution();let spec,child;
 try{
  f.plan.role='editor';const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');f.plan.port=socket.address().port;await new Promise(r=>socket.close(r));
  const first=await runInstaller(f.plan,'install');spec=JSON.parse(readFileSync(join(f.plan.root,'service-specification.json')));
  const api=await import(pathToFileURL(join(f.plan.root,'package/dist/installation/service-control.js')).href),selection=api.inspectInstalledServiceSelection(f.plan.root),client=createRuntimeHttpClient(join(f.plan.root,'connection.json')),stateRoot=join(f.plan.root,'data');
  const preserved=Object.fromEntries(['installation-plan.json','connection.json','client.json','data/auth.json'].map(p=>[p,readFileSync(join(f.plan.root,p))]));
  await api.operateInstalledService(selection,'stop');
  for(const phase of ['before','after']){
   // Source regression only: an actual installed RuntimeStore owns the writer
   // and transaction; the process dies at the fixed native COMMIT boundary.
   const script=`import {DatabaseSync} from 'node:sqlite';import {RuntimeStore} from ${JSON.stringify(pathToFileURL(join(f.plan.root,'package/dist/server/store.js')).href)};process.umask(0o077);const store=new RuntimeStore(${JSON.stringify(stateRoot)},${JSON.stringify(f.plan.workspaceId)});const actor={id:${JSON.stringify(f.plan.principalId)},projects:[${JSON.stringify(f.plan.projectId)}],permissions:['read','draft.write'],revision:1,expiresAt:'2030-01-01T00:00:00Z'};const original=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){if(sql==='COMMIT;'&&${JSON.stringify(phase)}==='before')process.kill(process.pid,'SIGKILL');const value=original.call(this,sql);if(sql==='COMMIT;'&&${JSON.stringify(phase)}==='after')process.kill(process.pid,'SIGKILL');return value;};store.mutate(actor,{projectId:${JSON.stringify(f.plan.projectId)},operation:'fixture.write',requestId:'crash-owned-write',expectedRevision:0,input:{synthetic:true},permission:'draft.write'},()=>({value:{synthetic:true},event:{type:'fixture-written',data:{synthetic:true}}}));`;
   child=spawn(node,['--input-type=module','-e',script],{stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',bytes=>stderr+=bytes);const [code,signal]=await once(child,'exit',{signal:AbortSignal.timeout(10000)});assert.equal(code,null,stderr);assert.equal(signal,'SIGKILL');assert(existsSync(join(stateRoot,'service.sqlite-wal')));assert(existsSync(join(stateRoot,'service.sqlite-shm')));
   const started=await api.operateInstalledService(selection,'start');assert.equal(started.service.running,true);assert.equal(started.service.identity.serviceId,first.service.identity.serviceId);assert.equal(started.service.identity.revision,phase==='after'?1:0);
   if(phase==='before')await assert.rejects(()=>client.request({operation:'runtime.receipt.read',projectId:f.plan.projectId,input:{requestId:'crash-owned-write'}}),{code:'NOT_FOUND'});
   else{const receipt=await client.request({operation:'runtime.receipt.read',projectId:f.plan.projectId,input:{requestId:'crash-owned-write'}});assert.equal(receipt.result.revision,1);assert.deepEqual(receipt.result.result,{synthetic:true});}
   await api.operateInstalledService(selection,'stop');
  }
  const running=await api.operateInstalledService(selection,'start');const original=await client.request({operation:'lifecycle.draft.save',projectId:f.plan.projectId,input:{yaml:yaml(lifecycle())},requestId:'real-service-before-kill',expectedRevision:1});
  assert(Number.isSafeInteger(running.service.pid)&&running.service.pid>1);process.kill(running.service.pid,'SIGKILL');const end=Date.now()+10000;let observed;do{observed=await inspectUserService(spec);if(!observed.running)break;await new Promise(r=>setTimeout(r,25));}while(Date.now()<end);assert.equal(observed.running,false);assert(existsSync(join(stateRoot,'service.sqlite-wal')));
  const recovered=await api.operateInstalledService(selection,'start');assert.equal(recovered.service.identity.serviceId,first.service.identity.serviceId);assert.equal(recovered.service.identity.revision,2);
  const read=await client.request({operation:'runtime.receipt.read',projectId:f.plan.projectId,input:{requestId:'real-service-before-kill'}});assert.deepEqual(read.result,original.result);
  for(const [p,bytes] of Object.entries(preserved))assert.deepEqual(readFileSync(join(f.plan.root,p)),bytes,p);
  await api.operateInstalledService(selection,'stop');
 }finally{if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}if(spec)await stopUserService(spec);f.cleanup();}
});
test('actual installed service recovers committed adoption, preserves old receipts and restarts with one writer', {timeout:120000},async()=>{
 if(process.platform!=='darwin')return;
 const f=developmentDistribution();let spec,stdio;
 try{
  const legacy=legacyFixture(f);f.plan.role='editor';
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');f.plan.port=socket.address().port;await new Promise(r=>socket.close(r));
  await runInstaller(f.plan,'stage');spec=JSON.parse(readFileSync(join(f.plan.root,'service-specification.json')));
  // Simulate interruption/conflicting local material between SQLite seal commit
  // and binding retention. The original failure and committed seal must remain.
  writeFileSync(spec.legacyRef,'retain conflicting material',{mode:0o600});await assert.rejects(()=>runInstaller(f.plan,'start'),{code:'INSTALLATION_CHANGED'});assert.equal(legacy.schema(),9);assert(!existsSync(join(f.plan.root,'service.plist')));
  const receipt=readFileSync(join(f.plan.root,'legacy-adoption.json')),adopted=JSON.parse(receipt);assert.equal(adopted.authority,false);rmSync(spec.legacyRef);
  const first=await runInstaller(f.plan,'install');assert.equal(first.phase,'AWAITING_HOST_VERIFICATION');assert.equal(first.hostRegistered,null);assert.equal(first.hostVerification,'NOT_EVALUATED');assert.equal(first.service.identity.serviceId,adopted.binding.serviceId);assert.equal(first.service.identity.legacy.migrationDigest,adopted.binding.migrationDigest);assert.deepEqual(readFileSync(join(f.plan.root,'legacy-adoption.json')),receipt);
  assert(existsSync(join(f.plan.root,'plugin/.mcp.json')));assert.equal(verifyLegacyBackup(f.plan.legacyMigration.backupRoot,legacy.backup.backupDigest).backupDigest,legacy.backup.backupDigest);
  const mcp=JSON.parse(readFileSync(join(f.plan.root,'plugin/.mcp.json'))),legacyTransport=mcp.mcpServers.evopilot_runtime_legacy;assert.equal(mcp.mcpServers.evopilot_runtime.type,'http');assert(legacyTransport.args.includes('--legacy-only'));
  stdio=new Client({name:'synthetic-installed-legacy-entry',version:'1'});await stdio.connect(new StdioClientTransport({...legacyTransport,stderr:'pipe'}));const tools=(await stdio.listTools()).tools;assert.equal(tools.length,9);assert(tools.some(tool=>tool.name==='evopilot_v01_guide'));assert(!tools.some(tool=>tool.name==='runtime_read'||tool.name==='runtime_write'));
  await stdio.callTool({name:'evopilot_v01_activate',arguments:{}});const viaInstalled=await stdio.callTool({name:'evopilot_v01_request',arguments:{owner:'runtime',envelope:{operation:'receipt.inspect',scope:legacy.scope,input:{requestId:'original-project'}}}});assert.deepEqual(JSON.parse(viaInstalled.content[0].text).result,legacy.original);await stdio.close();stdio=null;
  const client=createRuntimeHttpClient(join(f.plan.root,'connection.json'));
  const original=await forwardLegacyRuntime(client,'request',{operation:'receipt.inspect',scope:legacy.scope,input:{requestId:'original-project'}});assert.deepEqual(original.result,legacy.original);
  const newer=await forwardLegacyRuntime(client,'request',{operation:'goal.create',scope:legacy.scope,input:{id:'new-goal',description:'Retain post-adoption data'},requestId:'new-goal',expectedRevision:1});assert.equal(newer.result.revision,2);
  const repeat=await runInstaller(f.plan,'start');assert.equal(repeat.service.pid,first.service.pid);
  writeFileSync(join(f.plan.root,'legacy-adoption.json'),JSON.stringify({...adopted,seal:{...adopted.seal,sealedAt:'2000-01-01T00:00:00Z'}}));await assert.rejects(()=>runInstaller(f.plan,'start'),{code:'MIGRATION_BINDING_CHANGED'});writeFileSync(join(f.plan.root,'legacy-adoption.json'),receipt);assert.equal((await inspectUserService(spec)).pid,first.service.pid);
  assert.throws(()=>new RuntimeStore(join(f.plan.root,'data'),f.plan.workspaceId),{code:'WRITER_ACTIVE'});
  const old=createRuntimeService(legacy.options);assert.throws(()=>old.initialize(),{code:'MANAGED_SERVICE_REQUIRED'});old.close();
  await runInstaller(f.plan,'stop');rmSync(spec.legacyRef);rmSync(join(f.plan.root,'legacy-adoption.json'));const restarted=await runInstaller(f.plan,'start');assert.equal(restarted.service.identity.serviceId,first.service.identity.serviceId);assert.deepEqual(readFileSync(join(f.plan.root,'legacy-adoption.json')),receipt);
  const retained=await forwardLegacyRuntime(client,'request',{operation:'receipt.inspect',scope:legacy.scope,input:{requestId:'new-goal'}});assert.deepEqual(retained.result,newer.result);
  const binding=readFileSync(spec.legacyRef);writeFileSync(spec.legacyRef,JSON.stringify({...adopted.binding,migrationDigest:'1'.repeat(64)}));await assert.rejects(()=>observeUserService(spec),{code:'SERVICE_IDENTITY_CONFLICT'});
  // Broken binding must not prevent stopping our exact owned process.
  await runInstaller(f.plan,'stop');writeFileSync(spec.legacyRef,binding);
  const removed=await runInstaller(f.plan,'uninstall');assert.equal(removed.phase,'UNINSTALLED');assert.equal(legacy.schema(),9);assert.deepEqual(readFileSync(join(f.plan.root,'legacy-adoption.json')),receipt);assert.equal(verifyLegacyBackup(f.plan.legacyMigration.backupRoot,legacy.backup.backupDigest).backupDigest,legacy.backup.backupDigest);
  const failures=readdirSync(join(f.plan.root,'installation-audit')).filter(n=>n.endsWith('-failure.json'));assert.equal(failures.length,2);assert.deepEqual(failures.map(n=>JSON.parse(readFileSync(join(f.plan.root,'installation-audit',n))).code).sort(),['INSTALLATION_CHANGED','MIGRATION_BINDING_CHANGED']);
 }finally{await stdio?.close();if(spec)await stopUserService(spec);f.cleanup();}
});

test('Workspace operator grants are explicit managed-installation selections and staging does not enable local maintenance',async()=>{
 const f=distributionFixture();try{
  const grant={projectRoot:join(f.root,'project'),referenceFiles:[],owners:{ontology:join(f.root,'ontology'),harness:join(f.root,'harness')},calls:['workspace_inspect','workspace_backup'],expiresAt:'2030-01-01T00:00:00Z'};
  f.plan.workspaceOperator=grant;await assert.rejects(()=>runInstaller(f.plan,'stage'),{code:'MIGRATION_REQUIRED'});
  legacyFixture(f);mkdirSync(grant.projectRoot,{mode:0o700});writeFileSync(join(grant.projectRoot,'workspace-project.json'),JSON.stringify({schema:'evopilot-workspace-project/v1',id:f.plan.workspaceId}),{mode:0o600});
  await runInstaller(f.plan,'stage');assert(!existsSync(join(f.plan.root,'workspace-operator.json')));assert(!existsSync(join(f.plan.root,'plugin')));
  await assert.rejects(()=>runInstaller({...f.plan,workspaceOperator:{...grant,calls:['arbitrary.execute']}},'stage'),{code:'WORKSPACE_OPERATOR_CONFIGURATION'});
 }finally{f.cleanup();}
});

// Deterministic operator observation regression. Real package/spec/credential
// validation still runs; only launchctl completion/time and kill(pid,0) are
// simulated. These are source fault guards, never actual installed acceptance.
test('one bootout waits for exact launchd removal and original PID exit without redispatch',async t=>{
 if(process.platform!=='darwin')return;
 const variants=[
  ['asynchronous-removal','ok'],['already-absent','ok'],['bootout-rejected','SERVICE_STOP_UNKNOWN'],
  ['replacement-identity','SERVICE_IDENTITY_CONFLICT'],['replacement-pid','SERVICE_STOP_UNKNOWN'],
  ['registration-timeout','SERVICE_STOP_UNKNOWN'],['original-pid-timeout','SERVICE_STOP_UNKNOWN'],
  ['pid-observation-denied','SERVICE_STOP_UNKNOWN'],['print-unknown','SERVICE_OPERATION_UNKNOWN'],
  ['bootout-unknown','SERVICE_OPERATION_UNKNOWN'],
 ];
 for(const [name,expected]of variants)await t.test(name,async sub=>{
  const f=await fixture(),originalPid=987654321,calls=[],probes=[];let clock=1000,prints=0,bootouts=0;
  const spec=f.spec,label=userServiceLabel(spec),target='gui/'+process.getuid()+'/'+label;
  const originalArgs=[spec.nodeExecutable,join(spec.packageRoot,'dist/server/cli.js'),'serve','--state-root',join(spec.root,'data'),'--workspace-id',spec.workspaceId,'--port',String(spec.port)];
  const registered=(pid=originalPid,foreign=false)=>'path = '+join(spec.root,'service.plist')+'\nprogram = '+(foreign?'/foreign/node':spec.nodeExecutable)+'\narguments = {\n'+originalArgs.join('\n')+'\n}\nstate = running\npid = '+pid+'\n';
  const absent=()=>({code:113,stderr:'Could not find service "'+label+'" in domain for user gui: '+process.getuid()});
  sub.mock.method(Date,'now',()=>clock);
  sub.mock.method(childProcess,'execFile',(executable,args,options,callback)=>{
   assert.equal(executable,'/bin/launchctl');assert.deepEqual(args.slice(1),[target]);assert.equal(options.shell,false);assert(options.timeout>0&&options.timeout<=10000);
   calls.push({args:[...args],timeout:options.timeout});let result;
   if(args[0]==='bootout'){
    bootouts++;assert.equal(bootouts,1,'Never repeat a state-changing stop');
    result=name==='bootout-rejected'?{code:5,stderr:'synthetic rejection'}:name==='bootout-unknown'?{code:'ETIMEDOUT',killed:true,stderr:''}:{code:0,stdout:'',stderr:''};
   }else{
    assert.equal(args[0],'print');prints++;
    if(prints===1)result=name==='already-absent'?absent():{code:0,stdout:registered()};
    else if(name==='replacement-identity')result={code:0,stdout:registered(originalPid,true)};
    else if(name==='replacement-pid')result={code:0,stdout:registered(originalPid+1)};
    else if(name==='print-unknown')result={code:'ETIMEDOUT',killed:true};
    else if(name==='registration-timeout'){clock+=2500;result={code:0,stdout:registered()};}
    else if(name==='asynchronous-removal'&&prints<4){clock+=100;result={code:0,stdout:registered()};}
    else result=absent();
   }
   queueMicrotask(()=>callback(result.code?Object.assign(Error('synthetic launchctl observation'),{code:result.code,killed:!!result.killed}):null,result.stdout??'',result.stderr??''));
   return{};
  });syncBuiltinESMExports();
  sub.mock.method(process,'kill',(pid,signal)=>{
   probes.push({pid,signal});assert.equal(pid,originalPid);assert.equal(signal,0,'Observation must not signal or kill a process');
   if(name==='pid-observation-denied')throw Object.assign(Error('synthetic denied observation'),{code:'EPERM'});
   if(name==='original-pid-timeout'){clock+=2500;return true;}
   if(name==='asynchronous-removal'&&probes.length<3){clock+=100;return true;}
   throw Object.assign(Error('synthetic original process exited'),{code:'ESRCH'});
  });
  try{
   if(expected==='ok'){const result=await stopUserService(spec);assert.equal(result.registered,false);assert.equal(result.running,false);assert.equal(result.pid,null);}
   else await assert.rejects(()=>stopUserService(spec),{code:expected});
   assert.equal(bootouts,name==='already-absent'?0:1);
   if(name==='asynchronous-removal'){assert.equal(prints,4);assert.equal(probes.length,3);assert(calls.filter(x=>x.args[0]==='print').slice(2).every(x=>x.timeout<10000),'Each subsequent print must use the remaining original deadline');}
   if(['bootout-rejected','bootout-unknown'].includes(name)){assert.equal(prints,1);assert.equal(probes.length,0);}
   if(['replacement-identity','replacement-pid','print-unknown'].includes(name)){assert.equal(prints,2);assert.equal(probes.length,0);}
   if(name==='registration-timeout'){assert.equal(prints,5);assert.equal(probes.length,0);}
   if(name==='original-pid-timeout')assert.equal(probes.length,4);
   assert(calls.every(x=>['print','bootout'].includes(x.args[0])));
  }finally{
   sub.mock.restoreAll();syncBuiltinESMExports();
   // No real service was registered; never issue a cleanup stop for a mock job.
   if(f.occupied.listening)await new Promise(resolve=>f.occupied.close(resolve));rmSync(f.root,{recursive:true,force:true});
  }
 });
});
