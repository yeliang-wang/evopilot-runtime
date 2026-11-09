// SYNTHETIC orchestration tests. Runtime's location API is real; the two
// asset-owner callbacks model location preservation, not published semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {relocationConfigurationFixture} from '../fixtures/relocation-configuration-v090.mjs';
import {inspectManagedWorkspace,withRelocatingWorkspaces} from '../../dist/installation/workspace/snapshot.js';
import {createManagedWorkspaceBackup,restoreManagedWorkspaceBackup} from '../../dist/installation/workspace/backup.js';
import {relocateManagedWorkspace,relocateWithOwners} from '../../dist/installation/workspace/relocation.js';
import {inspectWorkspaceSnapshot,relocateWorkspaceSnapshot} from '../../dist/workspace-migration.js';
import {inspectMaintenanceTree,maintenanceJSONDigest} from '../../dist/installation/workspace/stream.js';
import {readIdentity,keyDirectory} from '../../dist/location-lineage.js';
import {RuntimeStore} from '../../dist/server/store.js';

async function fixture(t){
 const f=relocationConfigurationFixture(t,true,false),keys=new Set();
 fs.writeFileSync(join(f.source.serviceRoot,'installer-lock.sqlite'),'',{mode:0o600});
 const snapshot=await inspectManagedWorkspace(f.source,'source-inspect');
 const backup=await createManagedWorkspaceBackup(f.source,'source-backup',snapshot.snapshotDigest,f.backupRoot);
 const request={source:f.source,destination:Object.fromEntries(['projectRoot','workspaceRoot','serviceRoot'].map(k=>[k,f.destination[k]])),requestId:'relocation',backupRoot:f.backupRoot,backupDigest:backup.backupDigest,owners:Object.fromEntries(['ontology','harness'].map(o=>[o,join(f.root,o+'-package')])),ownerHost:f.ownerHost};
 const owners={runtime:{inspectWorkspaceSnapshot,relocateWorkspaceSnapshot(r){const result=relocateWorkspaceSnapshot(r);result.requiredKeyIds.forEach(k=>keys.add(k));return result;}}};
 for(const owner of ['ontology','harness'])owners[owner]={
  inspectWorkspaceSnapshot(r){const identity=readIdentity(r.workspaceRoot,r.workspaceId);return{product:owner,identity,unresolved:[],requiredKeyIds:[],snapshotDigest:'sha256:'+maintenanceJSONDigest({owner,identity,synthetic:true})};},
  relocateWorkspaceSnapshot(r){const snapshot=this.inspectWorkspaceSnapshot({workspaceRoot:r.destinationRoot,workspaceId:r.workspaceId});return{product:owner,sourceSnapshotDigest:r.expectedSnapshotDigest,relocationDigest:'sha256:'+maintenanceJSONDigest(r),snapshot};}
 };
 t.after(()=>{for(const id of keys)fs.rmSync(join(keyDirectory(),id+'.key'),{force:true});});
 return{...f,request,owners,snapshot,backup};
}
const run=f=>relocateWithOwners(f.request,f.owners);
const journal=f=>JSON.parse(fs.readFileSync(join(f.source.workspaceRoot+'.evopilot-maintenance','requests',f.request.requestId+'.json')));
const absent=f=>Object.values(f.request.destination).every(p=>!fs.existsSync(p));

test('relocation keeps schema3 Loop counters and original immutable receipt identities',async t=>{
 const f=await fixture(t),actor={id:'synthetic',projects:['synthetic'],permissions:['read'],revision:1,expiresAt:'2030-01-01T00:00:00Z'},store=new RuntimeStore(join(f.source.serviceRoot,'data'),f.source.workspaceId),value={synthetic:true,windowRef:'original-window',entries:[{loopRef:'original-loop',ordinal:1,firstRequestId:'original-request'}]};let receipt;
 try{receipt=store.mutate(actor,{projectId:'synthetic',operation:'synthetic.loop-preservation',requestId:'loop-preservation',expectedRevision:store.revision('synthetic'),input:{synthetic:true},permission:'read'},()=>({objects:[{kind:'lifecycle-loop-budget',id:'synthetic-original',value}],value:{retained:true},event:{type:'synthetic-loop-evidence',data:{}}}));}finally{store.close();}
 const snapshot=await inspectManagedWorkspace(f.source,'schema3-source'),saved=await createManagedWorkspaceBackup(f.source,'schema3-backup',snapshot.snapshotDigest,join(f.root,'schema3-backup'));assert.equal(snapshot.databases.find(d=>d.owner==='service').schemaVersion,3);f.request.backupRoot=saved.backupRoot;f.request.backupDigest=saved.backupDigest;
 const result=await run(f);assert.equal(result.status,'VERIFIED');const relocated=new RuntimeStore(join(f.destination.serviceRoot,'data'),f.source.workspaceId);try{assert.deepEqual(relocated.object('synthetic','lifecycle-loop-budget','synthetic-original'),value);assert.deepEqual(relocated.receipt(actor,'synthetic','loop-preservation'),receipt);}finally{relocated.close();}
 assert.equal((await inspectManagedWorkspace(f.source,'schema3-source-after')).snapshotDigest,snapshot.snapshotDigest);
});

test('one durable relocation preserves selected roots, all opaque tables, credentials and adoption; completed replay preserves newer destination work',async t=>{
 const f=await fixture(t),result=await run(f);
 assert.equal(result.status,'VERIFIED');for(const name of ['serviceStarted','hostRegistered','businessWorkDispatched','authority'])assert.equal(result[name],false);
 assert.notEqual(result.destination.migrationDigest,f.source.migrationDigest);
 assert.equal((await inspectManagedWorkspace(f.source,'source-unchanged')).snapshotDigest,f.snapshot.snapshotDigest);
 assert.equal((await inspectManagedWorkspace(result.destination,'target-verified')).snapshotDigest,result.destinationSnapshotDigest);
 for(const name of ['installation-plan.json','legacy-adoption.json','client.json','data/auth.json','data/service.sqlite'])assert.deepEqual(fs.readFileSync(join(f.source.serviceRoot,name)),fs.readFileSync(join(f.destination.serviceRoot,name)));
 fs.writeFileSync(join(f.destination.projectRoot,'new-work'),'preserve later work',{mode:0o600});
 assert.deepEqual(await run(f),result);assert.equal(fs.readFileSync(join(f.destination.projectRoot,'new-work'),'utf8'),'preserve later work');
 assert.equal(journal(f).status,'VERIFIED');
});

test('interruption after signed Runtime relocation but before its journal write resumes the same attestation without recopying',async t=>{
 const f=await fixture(t),original=f.owners.runtime.relocateWorkspaceSnapshot;let first=true;
 f.owners.runtime.relocateWorkspaceSnapshot=r=>{const result=original(r);if(first){first=false;throw Object.assign(new Error('synthetic crash boundary'),{code:'SYNTHETIC_INTERRUPTION'});}return result;};
 await assert.rejects(run(f),{code:'SYNTHETIC_INTERRUPTION'});assert.equal(journal(f).copied,true);assert.equal(journal(f).relocations.runtime,undefined);
 const dbFile=join(f.destination.workspaceRoot,'state/runtime/runtime.db'),inode=fs.statSync(dbFile).ino;
 const result=await run(f);assert.equal(result.status,'VERIFIED');assert.equal(fs.statSync(dbFile).ino,inode);
 const copy=join(f.root,'lineage-copy.db');fs.copyFileSync(dbFile,copy);const db=new DatabaseSync(copy,{readOnly:true});
 try{assert.equal(db.prepare('SELECT count(*) n FROM workspace_relocations').get().n,1);}finally{db.close();}
});

test('changed copied private data is refused on retry without erasing the new bytes',async t=>{
 const f=await fixture(t),original=f.owners.runtime.relocateWorkspaceSnapshot;
 f.owners.runtime.relocateWorkspaceSnapshot=r=>{const result=original(r);throw Object.assign(new Error('stop'),{code:'SYNTHETIC_STOP'});};
 await assert.rejects(run(f),{code:'SYNTHETIC_STOP'});
 const file=join(f.destination.projectRoot,'assets/asset.json');fs.writeFileSync(file,'new data');f.owners.runtime.relocateWorkspaceSnapshot=original;
 await assert.rejects(run(f),{code:'MAINTENANCE_PARTIAL_CONFLICT'});assert.equal(fs.readFileSync(file,'utf8'),'new data');
});

test('opaque owner-table and schema-version mutations omitted by a synthetic snapshot are detected physically',async t=>{
 for(const sql of ["UPDATE synthetic_later_domain SET data='changed business record'",'PRAGMA user_version=999']){
 const f=await fixture(t),original=f.owners.harness.relocateWorkspaceSnapshot;
 f.owners.harness.relocateWorkspaceSnapshot=r=>{const result=original.call(f.owners.harness,r),db=new DatabaseSync(join(r.destinationRoot,'state/harness/harness.db'));try{db.exec(sql);}finally{db.close();}return result;};
 await assert.rejects(run(f),{code:'MAINTENANCE_RELOCATION_DIFFERENT'});
 assert.equal(journal(f).status,'INTERRUPTED');assert.equal((await inspectManagedWorkspace(f.source,'source-preserved')).snapshotDigest,f.snapshot.snapshotDigest);
 }
});

test('a changed source, changed request identity, foreign destination or untrusted owner package cannot be treated as a resumable copy',async t=>{
 const f=await fixture(t);await assert.rejects(relocateManagedWorkspace(f.request),{code:'OWNER_DISTRIBUTION_CHANGED'});assert(absent(f));
 fs.mkdirSync(f.destination.projectRoot,{mode:0o700});fs.writeFileSync(join(f.destination.projectRoot,'foreign'),'retain',{mode:0o600});
 await assert.rejects(run(f),{code:'MAINTENANCE_DESTINATION_NOT_EMPTY'});fs.rmSync(f.destination.projectRoot,{recursive:true});
 const original=f.owners.runtime.relocateWorkspaceSnapshot;f.owners.runtime.relocateWorkspaceSnapshot=()=>{throw Object.assign(new Error('stop'),{code:'SYNTHETIC_STOP'});};await assert.rejects(run(f),{code:'SYNTHETIC_STOP'});f.owners.runtime.relocateWorkspaceSnapshot=original;
 await assert.rejects(relocateWithOwners({...f.request,ownerHost:{}},f.owners),{code:'MAINTENANCE_CONFLICT'});
 fs.writeFileSync(join(f.source.projectRoot,'changed'),'changed original',{mode:0o600});await assert.rejects(run(f),{code:'MAINTENANCE_DRIFT'});
});

test('both live service writers and source installer exclude relocation before any destination content is created',async t=>{
 const f=await fixture(t);
 for(const name of ['data/writer-lock.sqlite','installer-lock.sqlite']){
  const db=new DatabaseSync(join(f.source.serviceRoot,name));db.exec('BEGIN EXCLUSIVE');
  try{await assert.rejects(run(f),{code:name.startsWith('data/')?'WRITER_ACTIVE':'INSTALLER_ACTIVE'});assert(absent(f));}finally{db.close();}
 }
 await run(f);
});

test('nonterminal independent stage requests and unresolved legacy work cannot migrate or dispatch',async t=>{
 const f=await fixture(t),store=new RuntimeStore(join(f.source.serviceRoot,'data'),f.source.workspaceId);
 try{store.mutate({id:'synthetic',projects:['synthetic'],permissions:['read'],revision:1,expiresAt:'2030-01-01T00:00:00Z'},{projectId:'synthetic',operation:'synthetic.pending',requestId:'pending-stage',expectedRevision:1,input:{synthetic:true},permission:'read'},()=>({value:{synthetic:true},objects:[{kind:'stage-progress',id:'original',value:{terminal:false,phase:'UNKNOWN'}}],event:{type:'synthetic-pending',data:{}}}));}finally{store.close();}
 const snapshot=await inspectManagedWorkspace(f.source,'new-snapshot');const saved=await createManagedWorkspaceBackup(f.source,'new-backup',snapshot.snapshotDigest,join(f.root,'new-backup'));f.request.backupRoot=saved.backupRoot;f.request.backupDigest=saved.backupDigest;
 await assert.rejects(run(f),{code:'MAINTENANCE_UNRESOLVED'});assert.equal(journal(f).copied,false);
 const other=await fixture(t);other.owners.harness.inspectWorkspaceSnapshot=r=>({product:'harness',identity:readIdentity(r.workspaceRoot,r.workspaceId),snapshotDigest:'sha256:'+'a'.repeat(64),requiredKeyIds:[],unresolved:[{nextAction:'RECONCILE_OR_CANCEL'}]});
 await assert.rejects(run(other),{code:'MAINTENANCE_UNRESOLVED'});assert.equal(journal(other).copied,false);
});

test('abort before acquiring a lease does not create destinations',async t=>{
 const f=await fixture(t),controller=new AbortController();controller.abort();await assert.rejects(relocateWithOwners(f.request,f.owners,controller.signal),{name:'AbortError'});assert(absent(f));
});

test('interrupted bounded file copy retains its original request and resumes only matching partial files',async t=>{
 const f=await fixture(t),rename=fs.renameSync;let interrupted=false;
 fs.renameSync=(from,to)=>{rename(from,to);if(!interrupted&&to===join(f.destination.projectRoot,'assets/asset.json')){interrupted=true;throw Object.assign(new Error('synthetic copy interruption'),{code:'SYNTHETIC_COPY_STOP'});}};
 try{await assert.rejects(run(f),{code:'SYNTHETIC_COPY_STOP'});}finally{fs.renameSync=rename;}
 assert.equal(journal(f).copied,false);assert.equal(journal(f).status,'INTERRUPTED');
 const result=await run(f);assert.equal(result.status,'VERIFIED');assert.equal((await inspectManagedWorkspace(f.source,'after-copy-resume')).snapshotDigest,f.snapshot.snapshotDigest);
});

test('real process death during configuration switching releases all leases and resumes the exact prepared bytes',async t=>{
 const f=await fixture(t),ref=join(f.root,'relocation-request.json');fs.writeFileSync(ref,JSON.stringify(f.request),{mode:0o600});
 const root=new URL('../../',import.meta.url).pathname;
 const script=`import fs from 'node:fs';import {readIdentity} from ${JSON.stringify(new URL('../../dist/location-lineage.js',import.meta.url).href)};
 import {maintenanceJSONDigest} from ${JSON.stringify(new URL('../../dist/installation/workspace/stream.js',import.meta.url).href)};
 import * as runtime from ${JSON.stringify(new URL('../../dist/workspace-migration.js',import.meta.url).href)};
 import {relocateWithOwners} from ${JSON.stringify(new URL('../../dist/installation/workspace/relocation.js',import.meta.url).href)};
 const r=JSON.parse(fs.readFileSync(${JSON.stringify(ref)})),owners={runtime};
 for(const owner of ['harness','ontology'])owners[owner]={inspectWorkspaceSnapshot(r){const identity=readIdentity(r.workspaceRoot,r.workspaceId);return{product:owner,identity,unresolved:[],requiredKeyIds:[],snapshotDigest:'sha256:'+maintenanceJSONDigest({owner,identity,synthetic:true})};},relocateWorkspaceSnapshot(r){return{product:owner,sourceSnapshotDigest:r.expectedSnapshotDigest,relocationDigest:'sha256:'+maintenanceJSONDigest(r),snapshot:this.inspectWorkspaceSnapshot({workspaceRoot:r.destinationRoot,workspaceId:r.workspaceId})};}};
 const rename=fs.renameSync;fs.renameSync=(from,to)=>{rename(from,to);if(from.includes('/.evopilot-relocation-')&&to===r.destination.serviceRoot+'/connection.json')process.kill(process.pid,'SIGKILL');};
 await relocateWithOwners(r,owners);`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:root,encoding:'utf8',timeout:30000});
 assert.equal(child.signal,'SIGKILL',child.stderr);assert.equal(journal(f).status,'CONFIGURING');const before=journal(f).configurationDigest;
 const result=await run(f);assert.equal(result.configurationDigest,before);assert.equal(result.status,'VERIFIED');
 assert(!fs.readdirSync(f.destination.serviceRoot).some(n=>n.startsWith('.evopilot-relocation-')));
 assert.equal((await inspectManagedWorkspace(f.source,'after-real-death')).snapshotDigest,f.snapshot.snapshotDigest);
});

test('destination installer locks block a retained retry without changing copied business state',async t=>{
 const f=await fixture(t),original=f.owners.runtime.relocateWorkspaceSnapshot;
 f.owners.runtime.relocateWorkspaceSnapshot=()=>{throw Object.assign(new Error('stop'),{code:'SYNTHETIC_STOP'});};await assert.rejects(run(f),{code:'SYNTHETIC_STOP'});f.owners.runtime.relocateWorkspaceSnapshot=original;
 const before=fs.readFileSync(join(f.destination.workspaceRoot,'state/runtime/runtime.db')),db=new DatabaseSync(join(f.destination.serviceRoot,'installer-lock.sqlite'));db.exec('BEGIN EXCLUSIVE');
 try{await assert.rejects(run(f),{code:'INSTALLER_ACTIVE'});assert.deepEqual(fs.readFileSync(join(f.destination.workspaceRoot,'state/runtime/runtime.db')),before);}finally{db.close();}
 await run(f);
});


test('original-location recovery holds the installer lock while restoring current and earlier v1 manifests',async t=>{
 for(const historical of [false,true]){
  const f=await fixture(t);let retained=f.backup;
  if(historical){
   // Explicit SYNTHETIC earlier v1 representation: identical payload and
   // protected external anchor, before the installer journal was listed.
   const {snapshotDigest,...body}=retained.snapshot;body.transientExclusions={...body.transientExclusions,service:['data/writer-lock.sqlite-journal']};
   const snapshot={...body,snapshotDigest:maintenanceJSONDigest(body)}, {backupDigest,...backupBody}=retained;backupBody.snapshot=snapshot;retained={...backupBody,backupDigest:maintenanceJSONDigest(backupBody)};
   fs.writeFileSync(join(f.backupRoot,'manifest.json'),JSON.stringify(retained));
   const key=createHash('sha256').update(f.backupRoot).digest('hex');fs.writeFileSync(join(f.source.workspaceRoot+'.evopilot-maintenance','known-backups',key+'.json'),JSON.stringify({schema:'runtime-managed-backup-anchor/v1',requestId:retained.requestId,backupRoot:f.backupRoot,backupDigest:retained.backupDigest,snapshotDigest:snapshot.snapshotDigest}));
  }
  for(const role of ['projectRoot','workspaceRoot','serviceRoot'])fs.renameSync(f.source[role],f.source[role]+'.retained');
  const rename=fs.renameSync;let observed=false;
  fs.renameSync=(from,to)=>{rename(from,to);if(to===join(f.source.serviceRoot,'data/service.sqlite')){observed=true;const db=new DatabaseSync(join(f.source.serviceRoot,'installer-lock.sqlite'));try{assert.throws(()=>db.exec('BEGIN EXCLUSIVE'),/locked/);}finally{db.close();}}};
  let result;try{result=await restoreManagedWorkspaceBackup(f.backupRoot,retained.backupDigest,'restore-with-installer');}finally{fs.renameSync=rename;}
  assert(observed);assert.equal(result.snapshotDigest,retained.snapshot.snapshotDigest);assert.equal(result.status,'VERIFIED');
  const current=await inspectManagedWorkspace(f.source,'restored-inspection');assert.deepEqual(current.roots,retained.snapshot.roots);assert.deepEqual(current.databases,retained.snapshot.databases);
 }
});
