import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,readFileSync,writeFileSync,existsSync,rmSync,chmodSync,mkdirSync,readdirSync,symlinkSync,lstatSync,cpSync,readlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {initializeCredentials,tokenDigest} from '../../dist/server/security.js';
import {createRuntimeHttpClient} from '../../dist/host/client.js';
import {RuntimeStore} from '../../dist/server/store.js';
import {userServiceLabel,userServicePlist,inspectUserService,observeUserService,startUserService,stopUserService} from '../../dist/installation/service.js';
import {lifecycle,yaml} from '../fixtures/lifecycle-v090.mjs';
import {runInstaller,installerMain} from '../../dist/installation/installer.js';
import {createRuntimeService as historicalFixture} from '../fixtures/historical-runtime-v020.mjs';
import {createRuntimeService} from '../../dist/service.js';
import {inspectLegacyWorkspace,createLegacyBackup,verifyLegacyBackup} from '../../dist/installation/migration.js';
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
