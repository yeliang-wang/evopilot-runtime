// SYNTHETIC preservation fixtures. These do not establish owner semantics,
// actual Codex acceptance, release authority or current daily-data backup.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {createRuntimeService} from '../../dist/service.js';
import {RuntimeStore} from '../../dist/server/store.js';
import {acquireManagedLegacyContext} from '../../dist/compat/managed-store.js';
import {withWorkspaceLease} from '../../dist/compat/workspace-lease.js';
import {inspectManagedWorkspace,withQuiescentWorkspace} from '../../dist/installation/workspace/snapshot.js';
import {createManagedWorkspaceBackup,verifyManagedWorkspaceBackup} from '../../dist/installation/workspace/backup.js';
import {inspectMaintenanceTree,hashMaintenanceFile,copyMaintenanceFile,maintenanceJSONDigest,maintenanceJSONChunks} from '../../dist/installation/workspace/stream.js';

import {workspaceMaintenanceFixture as fixture} from '../fixtures/workspace-maintenance-v090.mjs';
const write=(file,value)=>fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});
const mkdir=root=>fs.mkdirSync(root,{mode:0o700});
const inventory=f=>[f.selection.projectRoot,f.selection.workspaceRoot,f.selection.serviceRoot].map(root=>inspectMaintenanceTree(root));

test('managed whole snapshot retains all owner/service tables and files without source SQLite side effects',async t=>{
  const f=fixture(t),before=inventory(f),snapshot=await inspectManagedWorkspace(f.selection,'inspect');
  assert.deepEqual(inventory(f),before);assert.equal(snapshot.authority,false);assert.equal(snapshot.coverage,'SELECTED_ROOTS_AND_REFERENCE_FILES');
  assert.equal(snapshot.databases.find(d=>d.owner==='runtime').schemaVersion,9);
  for(const owner of ['ontology','harness'])assert.deepEqual(snapshot.databases.find(d=>d.owner===owner).tables.map(v=>[v.name,v.rows]),[['synthetic_all_records',1],['synthetic_later_domain',1]]);
  const service=snapshot.databases.find(d=>d.owner==='service');for(const name of ['receipts','audit','events','objects'])assert.equal(service.tables.find(v=>v.name===name).rows,1);
  assert.equal(snapshot.references[0].path,f.reference);assert.equal(snapshot.roots.project.find(e=>e.path==='assets').mode,0o755);
  assert.deepEqual(snapshot.transientExclusions,{workspace:['state/runtime-service/writer-lock.sqlite-journal'],service:['data/writer-lock.sqlite-journal']});
  assert(snapshot.roots.service.some(e=>e.path==='data/writer-lock.sqlite'&&e.bytes===0));assert(!snapshot.roots.service.some(e=>e.path.endsWith('-journal')));
  assert.equal((await inspectManagedWorkspace(f.selection,'inspect-again')).snapshotDigest,snapshot.snapshotDigest);
});

test('backup preserves all three trees, external configuration and internal links; verified retry keeps the original manifest',async t=>{
  const f=fixture(t),snapshot=await inspectManagedWorkspace(f.selection,'inspect'),before=inventory(f);
  const saved=await createManagedWorkspaceBackup(f.selection,'backup',snapshot.snapshotDigest,f.backupRoot);
  assert.deepEqual(verifyManagedWorkspaceBackup(f.backupRoot,saved.backupDigest),saved);assert.deepEqual(inventory(f),before);
  assert.equal(fs.readlinkSync(join(f.backupRoot,'project','current.json')),'assets/asset.json');assert.equal(fs.statSync(join(f.backupRoot,'project','assets')).mode&0o777,0o755);
  write(join(f.selection.projectRoot,'new-evidence.txt'),'later legitimate evidence');
  assert.deepEqual(await createManagedWorkspaceBackup(f.selection,'backup',snapshot.snapshotDigest,f.backupRoot),saved);
  assert.equal(fs.readdirSync(f.selection.workspaceRoot+'.evopilot-maintenance/known-backups').length,1);
  await assert.rejects(createManagedWorkspaceBackup(f.selection,'backup','a'.repeat(64),f.backupRoot),{code:'MAINTENANCE_CONFLICT'});
});

test('whole workspace backup preserves service schema3 Loop accounting and original receipts exactly',async t=>{
  const f=fixture(t),actor={id:'synthetic',projects:['synthetic'],permissions:['read'],revision:1,expiresAt:'2030-01-01T00:00:00Z'},store=new RuntimeStore(join(f.selection.serviceRoot,'data'),f.selection.workspaceId);
  const retained={synthetic:true,window:'original',entries:[{loopRef:'one',firstRequestId:'original-request',ordinal:1}],historicalAcceptance:false};let receipt;
  try{receipt=store.mutate(actor,{projectId:'synthetic',operation:'synthetic.loop-preservation',requestId:'loop-evidence',expectedRevision:store.revision('synthetic'),input:{synthetic:true},permission:'read'},()=>({objects:[{kind:'lifecycle-loop-budget',id:'synthetic-original',value:retained}],value:{retained:true},event:{type:'synthetic-loop-evidence',data:{}}}));}finally{store.close();}
  const before=inventory(f),snapshot=await inspectManagedWorkspace(f.selection,'schema3-inspect');assert.equal(snapshot.databases.find(d=>d.owner==='service').schemaVersion,3);
  const saved=await createManagedWorkspaceBackup(f.selection,'schema3-backup',snapshot.snapshotDigest,f.backupRoot);assert.deepEqual(verifyManagedWorkspaceBackup(f.backupRoot,saved.backupDigest),saved);assert.deepEqual(inventory(f),before);
  // SQLite can create WAL sidecars even for a read-only connection. Inspect a
  // byte-identical scratch copy without changing the immutable backup tree.
  const inspection=join(f.root,'backup-inspection.sqlite');fs.copyFileSync(join(f.backupRoot,'service','data','service.sqlite'),inspection);
  const copied=new DatabaseSync(inspection,{readOnly:true});try{assert.equal(copied.prepare('PRAGMA user_version').get().user_version,3);assert.deepEqual(JSON.parse(copied.prepare('SELECT data FROM objects WHERE project_id=? AND kind=? AND id=?').get('synthetic','lifecycle-loop-budget','synthetic-original').data),retained);assert.deepEqual(JSON.parse(copied.prepare('SELECT data FROM receipts WHERE project_id=? AND request_id=?').get('synthetic','loop-evidence').data),receipt);}finally{copied.close();}assert.deepEqual(verifyManagedWorkspaceBackup(f.backupRoot,saved.backupDigest),saved);
});

test('all payloads, added files, external pins and the manifest remain bound to the external digest',async t=>{
  const f=fixture(t),snapshot=await inspectManagedWorkspace(f.selection,'inspect'),saved=await createManagedWorkspaceBackup(f.selection,'backup',snapshot.snapshotDigest,f.backupRoot);
  for(const file of [join(f.backupRoot,'project','assets','asset.json'),join(f.backupRoot,'workspace','state/ontology/ontology.db'),join(f.backupRoot,'service','client.json'),join(f.backupRoot,'references',fs.readdirSync(join(f.backupRoot,'references'))[0])]){
    const original=fs.readFileSync(file);write(file,'tamper');assert.throws(()=>verifyManagedWorkspaceBackup(f.backupRoot,saved.backupDigest),{code:'MAINTENANCE_BACKUP_CHANGED'});fs.writeFileSync(file,original);
  }
  const extra=join(f.backupRoot,'project','extra');write(extra,'foreign');assert.throws(()=>verifyManagedWorkspaceBackup(f.backupRoot,saved.backupDigest),{code:'MAINTENANCE_BACKUP_CHANGED'});fs.unlinkSync(extra);
  const manifest=join(f.backupRoot,'manifest.json'),original=fs.readFileSync(manifest);write(manifest,{...saved,createdAt:'different'});assert.throws(()=>verifyManagedWorkspaceBackup(f.backupRoot,saved.backupDigest),{code:'MAINTENANCE_BACKUP_CHANGED'});fs.writeFileSync(manifest,original);
  assert.throws(()=>verifyManagedWorkspaceBackup(f.backupRoot,'b'.repeat(64)),{code:'MAINTENANCE_BACKUP_CHANGED'});
});

test('active old/new writers, WAL sidecars, mismatched adoption and corrupt independent audit reject capture',async t=>{
  const f=fixture(t);let managed=acquireManagedLegacyContext(f.binding),legacy;
  managed.run(()=>{legacy=createRuntimeService({workspaceRoot:f.binding.workspaceRoot,workspaceId:f.binding.workspaceId});legacy.initialize();});
  try{await assert.rejects(inspectManagedWorkspace(f.selection,'old-active'),{code:'LEGACY_WRITER_ACTIVE'});}finally{legacy.close();managed.close();}
  const store=new RuntimeStore(join(f.selection.serviceRoot,'data'),'synthetic');
  try{await assert.rejects(inspectManagedWorkspace(f.selection,'new-active'),{code:'WRITER_ACTIVE'});}finally{store.close();}
  const sidecar=join(f.selection.workspaceRoot,'state/ontology/ontology.db-wal');write(sidecar,'unresolved WAL');
  await assert.rejects(inspectManagedWorkspace(f.selection,'sidecar'),{code:'MAINTENANCE_NOT_QUIESCENT'});assert.equal(fs.readFileSync(sidecar,'utf8'),'unresolved WAL');fs.unlinkSync(sidecar);
  await assert.rejects(inspectManagedWorkspace({...f.selection,migrationDigest:'a'.repeat(64)},'wrong-seal'),{code:'MAINTENANCE_IDENTITY'});
  const file=join(f.selection.serviceRoot,'data/service.sqlite'),original=fs.readFileSync(file),db=new DatabaseSync(file);db.exec('DELETE FROM audit');db.close();
  await assert.rejects(inspectManagedWorkspace(f.selection,'bad-audit'),{code:'CORRUPT_STATE'});fs.writeFileSync(file,original);
});

test('maintenance holds both writer leases and waits for the same workspace Host operation before capture',async t=>{
  const f=fixture(t);let release,entered;const ready=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
  const holder=withWorkspaceLease({workspaceRoot:f.selection.workspaceRoot,workspaceId:'synthetic'},'host',async()=>{entered();await wait;});await ready;
  let done=false;const read=inspectManagedWorkspace(f.selection,'queued').then(v=>{done=true;return v;});await new Promise(r=>setTimeout(r,100));assert.equal(done,false);release();await holder;await read;
  let retained;
  await withQuiescentWorkspace(f.selection,'exclusive',capture=>{
    retained=capture;
    assert.throws(()=>new RuntimeStore(join(f.selection.serviceRoot,'data'),'synthetic'),{code:'WRITER_ACTIVE'});
    assert.throws(()=>acquireManagedLegacyContext(f.binding),{code:'LEGACY_WRITER_ACTIVE'});assert(capture().snapshotDigest);
  });
  assert.throws(()=>retained(),{code:'MAINTENANCE_CLOSED'});
});

test('source drift refuses new or resumed backups and unrelated destination contents are never overwritten',async t=>{
  const f=fixture(t),snapshot=await inspectManagedWorkspace(f.selection,'inspect');
  write(f.reference,{synthetic:true,changed:true});await assert.rejects(createManagedWorkspaceBackup(f.selection,'drift',snapshot.snapshotDigest,f.backupRoot),{code:'MAINTENANCE_DRIFT'});assert.equal(fs.existsSync(f.backupRoot),false);
  mkdir(f.backupRoot);write(join(f.backupRoot,'foreign'),'keep');const current=await inspectManagedWorkspace(f.selection,'current');
  await assert.rejects(createManagedWorkspaceBackup(f.selection,'occupied',current.snapshotDigest,f.backupRoot),{code:'MAINTENANCE_DESTINATION_NOT_EMPTY'});assert.equal(fs.readFileSync(join(f.backupRoot,'foreign'),'utf8'),'keep');
});

test('packaged operator snapshots its exact own service installation while rejecting a source checkout or mismatched specification',async t=>{
  const f=fixture(t),packageRoot=join(f.selection.serviceRoot,'package');mkdir(packageRoot);
  fs.cpSync(new URL('../../dist',import.meta.url),join(packageRoot,'dist'),{recursive:true});fs.cpSync(new URL('../../vendor',import.meta.url),join(packageRoot,'vendor'),{recursive:true});
  const pkg=JSON.parse(fs.readFileSync(new URL('../../package.json',import.meta.url)));write(join(packageRoot,'package.json'),pkg);
  const specPath=join(f.selection.serviceRoot,'service-specification.json'),spec={...JSON.parse(fs.readFileSync(specPath)),packageRoot,version:pkg.version};write(specPath,spec);
  const owned=await import(pathToFileURL(join(packageRoot,'dist/installation/workspace/snapshot.js')));
  const snapshot=await owned.inspectManagedWorkspace(f.selection,'installed');assert(snapshot.roots.service.some(e=>e.path==='package/dist/installation/workspace/snapshot.js'));
  write(specPath,{...spec,packageRoot:f.selection.projectRoot});await assert.rejects(owned.inspectManagedWorkspace(f.selection,'mismatch'),{code:'MAINTENANCE_LOCATION'});write(specPath,spec);
  mkdir(join(packageRoot,'.git'));await assert.rejects(owned.inspectManagedWorkspace(f.selection,'checkout'),{code:'MAINTENANCE_LOCATION'});
});

test('bounded copying resumes an exact partial prefix and rejects altered partials, escaping symlinks and hardlinks',t=>{
  const root=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'runtime-stream-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const from=join(root,'from'),partial=join(root,'partial'),bytes=Buffer.alloc(9*1024*1024,123);write(from,bytes.toString('latin1'));
  const entry={path:'from',kind:'file',...hashMaintenanceFile(from)};fs.writeFileSync(partial,bytes.subarray(0,500001),{mode:0o600});copyMaintenanceFile(from,partial,entry);assert.equal(hashMaintenanceFile(partial).sha256,entry.sha256);
  fs.chmodSync(from,0o444);copyMaintenanceFile(from,partial,{...entry,mode:0o444});copyMaintenanceFile(from,partial,{...entry,mode:0o444});assert.equal(fs.statSync(partial).mode&0o777,0o444);fs.chmodSync(partial,0o600);
  fs.writeFileSync(partial,'wrong');assert.throws(()=>copyMaintenanceFile(from,partial,entry),{code:'MAINTENANCE_PARTIAL_CONFLICT'});
  fs.symlinkSync('../external',join(root,'escape'));assert.throws(()=>inspectMaintenanceTree(root),{code:'MAINTENANCE_LINK'});fs.unlinkSync(join(root,'escape'));
  fs.linkSync(from,join(root,'hard'));assert.throws(()=>inspectMaintenanceTree(root),{code:'MAINTENANCE_LIMIT'});
  assert.equal([...maintenanceJSONChunks({'10':'ten','2':'two',z:[1,true,null],a:'字'})].join(''),JSON.stringify({'2':'two','10':'ten',a:'字',z:[1,true,null]}));
});

test('killed backup process resumes the same retained journal and exact staged prefix without reissuing business work',async t=>{
  const f=fixture(t),large=join(f.selection.projectRoot,'large-evidence.bin'),fd=fs.openSync(large,'wx',0o600),chunk=Buffer.alloc(4*1024*1024,91);
  try{for(let i=0;i<32;i++)fs.writeSync(fd,chunk);}finally{fs.closeSync(fd);}
  const snapshot=await inspectManagedWorkspace(f.selection,'inspect'),module=new URL('../../dist/installation/workspace/backup.js',import.meta.url).href;
  const script=`import {createManagedWorkspaceBackup} from ${JSON.stringify(module)}; await createManagedWorkspaceBackup(JSON.parse(process.argv[1]),'resume',process.argv[2],process.argv[3]);`;
  const child=spawn(process.execPath,['--input-type=module','-e',script,JSON.stringify(f.selection),snapshot.snapshotDigest,f.backupRoot],{stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',v=>stderr+=v);t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  const closed=once(child,'close'),stage=join(f.backupRoot,'project','.evopilot-copy-resume'),deadline=Date.now()+30000;let interrupted=false;
  while(Date.now()<deadline&&child.exitCode===null&&child.signalCode===null){
    if(fs.existsSync(stage)&&fs.readdirSync(stage).some(name=>{try{return fs.statSync(join(stage,name)).size>1024*1024;}catch(error){if(error.code==='ENOENT')return false;throw error;}})){child.kill('SIGKILL');interrupted=true;break;}
    await new Promise(r=>setTimeout(r,2));
  }
  if(!interrupted&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  await closed;assert.equal(interrupted,true,stderr);assert(fs.readdirSync(stage).length>0);
  const journal=join(f.selection.workspaceRoot+'.evopilot-maintenance','requests','resume.json'),before=JSON.parse(fs.readFileSync(journal));assert.equal(before.status,'COPYING');
  const originalRef=fs.readFileSync(f.reference);write(f.reference,{changedAfterInterruption:true});
  await assert.rejects(createManagedWorkspaceBackup(f.selection,'resume',snapshot.snapshotDigest,f.backupRoot),{code:'MAINTENANCE_DRIFT'});assert.equal(JSON.parse(fs.readFileSync(journal)).status,'INTERRUPTED');fs.writeFileSync(f.reference,originalRef);
  const saved=await createManagedWorkspaceBackup(f.selection,'resume',snapshot.snapshotDigest,f.backupRoot);
  assert.equal(saved.backupDigest,before.manifest.backupDigest);assert.equal(JSON.parse(fs.readFileSync(journal)).status,'VERIFIED');assert.equal(hashMaintenanceFile(join(f.backupRoot,'project','large-evidence.bin')).sha256,hashMaintenanceFile(large).sha256);
  assert.deepEqual((await inspectManagedWorkspace(f.selection,'unchanged')).databases,snapshot.databases);
});
