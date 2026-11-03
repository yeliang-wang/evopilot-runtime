// SYNTHETIC managed Runtime relocation, not whole-service cutover acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {workspaceMaintenanceFixture as fixture} from '../fixtures/workspace-maintenance-v090.mjs';
import {inspectWorkspaceSnapshot,relocateWorkspaceSnapshot} from '../../dist/workspace-migration.js';
import {acquireManagedLegacyContext,migrationSeal,resolvedManagedBinding} from '../../dist/compat/managed-store.js';
import {inspectAllTables} from '../../dist/compat/table-inventory.js';
import {inspectRecords,keyDirectory,readIdentity} from '../../dist/location-lineage.js';
import {createRuntimeService} from '../../dist/service.js';
import {createRuntimeService as historicalFixture} from '../fixtures/historical-runtime-v020.mjs';
import {createManagedLegacyService} from '../../dist/compat/managed-service.js';
import {validateState} from '../../dist/state.js';
import {inspectLegacyWorkspace,createLegacyBackup,adoptLegacyWorkspace} from '../../dist/installation/migration.js';

const options=binding=>({workspaceRoot:binding.workspaceRoot,workspaceId:binding.workspaceId});
const database=root=>join(root,'state/runtime/runtime.db');
function query(root,fn){const db=new DatabaseSync(database(root));try{return fn(db);}finally{db.close();}}
function managed(binding,fn){const context=acquireManagedLegacyContext(binding);try{return context.run(fn);}finally{context.close();}}
function snapshot(binding){return managed(binding,()=>inspectWorkspaceSnapshot(options(binding)));}
function privateCopy(source,destination){
  fs.cpSync(source,destination,{recursive:true,preserveTimestamps:true});
  const visit=path=>{const stat=fs.lstatSync(path);assert(!stat.isSymbolicLink());fs.chmodSync(path,stat.isDirectory()?0o700:0o600);if(stat.isDirectory())for(const name of fs.readdirSync(path))visit(join(path,name));};visit(destination);
}
function tracked(t,report){t.after(()=>{for(const id of report.requiredKeyIds)fs.rmSync(join(keyDirectory(),id+'.key'),{force:true});});return report;}
function relocate(t,binding,destinationRoot){
  const original=snapshot(binding);privateCopy(binding.workspaceRoot,destinationRoot);
  const request={sourceRoot:binding.workspaceRoot,destinationRoot,workspaceId:binding.workspaceId,expectedSnapshotDigest:original.snapshotDigest};
  return{original,request,result:tracked(t,managed(binding,()=>relocateWorkspaceSnapshot(request)))};
}
function extra(root){query(root,db=>{db.exec('CREATE TABLE synthetic_later_domain(id INTEGER PRIMARY KEY, payload BLOB, metadata TEXT)');db.prepare('INSERT INTO synthetic_later_domain VALUES(?,?,?)').run(9007199254740993n,Buffer.from([0,255,1]),'{"pending":"RECONCILE_OR_CANCEL"}');});}

test('schema9 snapshot requires a live exact managed context and covers later tables without changing adoption',t=>{
  const f=fixture(t);extra(f.binding.workspaceRoot);const seal=query(f.binding.workspaceRoot,migrationSeal),before=query(f.binding.workspaceRoot,inspectAllTables);
  assert.throws(()=>inspectWorkspaceSnapshot(options(f.binding)),{code:'MANAGED_SERVICE_REQUIRED'});
  query(f.binding.workspaceRoot,db=>assert.throws(()=>inspectRecords(db,validateState),{code:'MANAGED_SERVICE_REQUIRED'}));
  const saved=snapshot(f.binding);assert.equal(saved.managed.adoptionDigest,f.binding.migrationDigest);assert.equal(saved.managed.serviceId,f.binding.serviceId);assert.deepEqual(saved.managed.businessTables,before);
  assert(saved.managed.businessTables.tables.some(t=>t.name==='synthetic_later_domain'&&t.rows===1));assert.deepEqual(query(f.binding.workspaceRoot,migrationSeal),seal);
});

test('managed relocation preserves every business table and adoption seal while returning a signed new-location binding',t=>{
  const f=fixture(t);extra(f.binding.workspaceRoot);const originalBytes=fs.readFileSync(database(f.binding.workspaceRoot)),seal=query(f.binding.workspaceRoot,migrationSeal),destination=join(f.root,'moved');
  const {original,request,result}=relocate(t,f.binding,destination);
  assert.equal(result.authority,false);assert.equal(result.managedBinding.serviceId,f.binding.serviceId);assert.equal(result.managedBinding.workspaceRoot,destination);assert.notEqual(result.managedBinding.migrationDigest,f.binding.migrationDigest);
  assert.deepEqual(result.snapshot.managed,original.managed);assert.deepEqual(query(destination,migrationSeal),seal);assert.deepEqual(fs.readFileSync(database(f.binding.workspaceRoot)),originalBytes);
  assert.deepEqual(query(destination,db=>inspectAllTables(db,['workspace_relocations'])),original.managed.businessTables);
  assert.deepEqual(managed(f.binding,()=>relocateWorkspaceSnapshot(request)),result);
  assert.deepEqual(snapshot(result.managedBinding),result.snapshot);
  assert.throws(()=>acquireManagedLegacyContext({...f.binding,workspaceRoot:destination}),{code:'MIGRATION_BINDING_CHANGED'});
  managed(result.managedBinding,()=>{
    const service=createRuntimeService(options(result.managedBinding));service.initialize();
    try{const scope={visibility:'private',projectId:'synthetic'};assert.equal(service.execute({operation:'project.list',scope,input:{}}).length,1);assert(service.execute({operation:'receipt.inspect',scope,input:{requestId:'original-project'}}).result);}
    finally{service.close();}
  });
});

test('changes in a later domain, schema or adoption cannot be hidden by the historical core snapshot',t=>{
  const f=fixture(t);extra(f.binding.workspaceRoot);const original=snapshot(f.binding),source=fs.readFileSync(database(f.binding.workspaceRoot));
  for(const [name,change] of [['record',db=>db.exec("UPDATE synthetic_later_domain SET metadata='changed'")],['schema',db=>db.exec('CREATE TABLE foreign_table(value TEXT)')],['seal',db=>db.exec("UPDATE runtime_service_migration SET data='{}'")]]){
    const destination=join(f.root,name);privateCopy(f.binding.workspaceRoot,destination);query(destination,change);
    assert.throws(()=>managed(f.binding,()=>relocateWorkspaceSnapshot({sourceRoot:f.binding.workspaceRoot,destinationRoot:destination,workspaceId:f.binding.workspaceId,expectedSnapshotDigest:original.snapshotDigest})),{code:name==='seal'?'INVALID_FIELDS':'SNAPSHOT_DRIFT'});
    assert.equal(query(destination,db=>db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='workspace_relocations'").get().n),0);
    assert.equal(readIdentity(destination,f.binding.workspaceId).canonicalRoot,f.binding.workspaceRoot);assert.deepEqual(fs.readFileSync(database(f.binding.workspaceRoot)),source);
  }
});

test('multi-hop managed locations retain the first adoption and reject stale bindings or tampered signed lineage',t=>{
  const f=fixture(t),first=relocate(t,f.binding,join(f.root,'second')),second=relocate(t,first.result.managedBinding,join(f.root,'third'));
  assert.deepEqual(second.result.snapshot.managed,first.original.managed);assert.equal(query(second.result.to.canonicalRoot,migrationSeal).workspaceRoot,f.binding.workspaceRoot);
  assert.notEqual(second.result.managedBinding.migrationDigest,first.result.managedBinding.migrationDigest);
  assert.throws(()=>acquireManagedLegacyContext({...first.result.managedBinding,workspaceRoot:second.result.to.canonicalRoot}),{code:'MIGRATION_BINDING_CHANGED'});
  query(second.result.to.canonicalRoot,db=>{const row=db.prepare('SELECT sequence,record FROM workspace_relocations ORDER BY sequence DESC LIMIT 1').get(),value=JSON.parse(row.record);value.signature='0'.repeat(64);db.prepare('UPDATE workspace_relocations SET record=? WHERE sequence=?').run(JSON.stringify(value),row.sequence);});
  assert.throws(()=>acquireManagedLegacyContext(second.result.managedBinding),{code:'INVALID_LINEAGE'});
});

test('an un-attested directory copy, missing local key and new destination writes cannot reuse old relocation evidence',t=>{
  const f=fixture(t),copy=join(f.root,'plain-copy');privateCopy(f.binding.workspaceRoot,copy);const marker=join(copy,'workspace.json');fs.writeFileSync(marker,JSON.stringify({...JSON.parse(fs.readFileSync(marker)),canonicalRoot:copy}));
  assert.throws(()=>acquireManagedLegacyContext({...f.binding,workspaceRoot:copy}),{code:'MIGRATION_BINDING_CHANGED'});
  const moved=relocate(t,f.binding,join(f.root,'moved')),key=join(keyDirectory(),moved.result.requiredKeyIds[0]+'.key');fs.renameSync(key,key+'.held');
  try{assert.throws(()=>acquireManagedLegacyContext(moved.result.managedBinding),{code:'MISSING_RELOCATION_KEY'});}finally{fs.renameSync(key+'.held',key);}
  managed(moved.result.managedBinding,()=>{const service=createRuntimeService(options(moved.result.managedBinding));service.initialize();try{service.execute({operation:'goal.create',scope:{visibility:'private',projectId:'synthetic'},input:{id:'later',description:'New independent work'},requestId:'later',expectedRevision:1});}finally{service.close();}});
  const bytes=fs.readFileSync(database(moved.result.to.canonicalRoot));assert.throws(()=>managed(f.binding,()=>relocateWorkspaceSnapshot(moved.request)),{code:'SNAPSHOT_DRIFT'});assert.deepEqual(fs.readFileSync(database(moved.result.to.canonicalRoot)),bytes);
});

test('pre-adoption relocation history remains compatible and cannot itself create a managed location grant',t=>{
  const root=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'runtime-prior-relocation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const sourceRoot=join(root,'first'),workspaceId='synthetic',source=createRuntimeService({workspaceRoot:sourceRoot,workspaceId});source.initialize();source.execute({operation:'project.create',scope:{visibility:'private',projectId:'synthetic'},input:{name:'Original'},requestId:'original',expectedRevision:0});source.close();
  const before=inspectWorkspaceSnapshot({workspaceRoot:sourceRoot,workspaceId}),middle=join(root,'second');privateCopy(sourceRoot,middle);const prior=tracked(t,relocateWorkspaceSnapshot({sourceRoot,destinationRoot:middle,workspaceId,expectedSnapshotDigest:before.snapshotDigest}));assert.equal(prior.managedBinding,undefined);
  const old=inspectLegacyWorkspace(middle,workspaceId),backupRoot=join(root,'original-backup'),saved=createLegacyBackup(middle,workspaceId,old.snapshotDigest,backupRoot);
  const adopted=adoptLegacyWorkspace({workspaceRoot:middle,workspaceId,serviceId:'synthetic-service',expectedSnapshotDigest:old.snapshotDigest,backupRoot,expectedBackupDigest:saved.backupDigest});
  assert.deepEqual(query(middle,db=>resolvedManagedBinding(db,readIdentity(middle,workspaceId))),adopted.binding);
  const moved=relocate(t,adopted.binding,join(root,'third'));assert.equal(moved.result.managedBinding.workspaceRoot,join(root,'third'));assert.deepEqual(snapshot(moved.result.managedBinding).managed,moved.original.managed);
});

test('an original UNKNOWN claim and dispatch receipt survive managed relocation without replay or invented success',async t=>{
  const root=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'runtime-pending-relocation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const sourceOptions={workspaceRoot:join(root,'original'),workspaceId:'synthetic'},scope={visibility:'private',projectId:'synthetic'};let executions=0;
  const d='sha256:'+'a'.repeat(64),resolve=({reference,workspace})=>({reference,workspace,scope,published:true,materialDigest:d,descriptor:{kind:reference.product+'-composition/v1',digest:d}});
  const read=(service,operation,input={})=>service.execute({operation,scope,input}),write=(service,operation,input,requestId)=>service.execute({operation,scope,input,requestId,expectedRevision:read(service,'workspace.inspect').revision});
  const old=historicalFixture(sourceOptions,{resolveOntology:resolve,resolveHarness:resolve,execute:()=>{executions++;return undefined;}});old.initialize();
  let retained,receipt;
  try{
    write(old,'project.create',{name:'Synthetic pending relocation'},'project');write(old,'goal.create',{id:'goal',description:'Preserve UNKNOWN'},'goal');
    const ref=product=>({product,id:product,version:'1.0.0',specVersion:'v1',visibility:'private',digest:d});
    const prepared=write(old,'run.prepare',{id:'original-run',goalId:'goal',ontology:ref('ontology'),harness:ref('harness'),input:{schema:'runtime-composition/v1',ontologyInstance:{entities:[],relations:[]},harness:{mode:'composed',evidence:{},configuration:{}}}},'prepare').result;
    write(old,'run.decide',{id:prepared.id,reviewDigest:prepared.reviewDigest,decision:'APPROVE',humanEvidenceRef:'synthetic:historical-test-only'},'decision');
    await old.dispatch({scope,id:prepared.id,requestId:'original-dispatch',expectedRevision:read(old,'workspace.inspect').revision});
    retained=read(old,'run.inspect',{id:prepared.id});receipt=read(old,'receipt.inspect',{requestId:'original-dispatch'});
  }finally{old.close();}
  assert.equal(retained.stage,'UNKNOWN');assert.equal(executions,1);
  const inspected=inspectLegacyWorkspace(sourceOptions.workspaceRoot,sourceOptions.workspaceId),backupRoot=join(root,'backup'),backup=createLegacyBackup(sourceOptions.workspaceRoot,sourceOptions.workspaceId,inspected.snapshotDigest,backupRoot);
  const {binding}=adoptLegacyWorkspace({...sourceOptions,serviceId:'synthetic-pending-service',expectedSnapshotDigest:inspected.snapshotDigest,backupRoot,expectedBackupDigest:backup.backupDigest});
  const moved=relocate(t,binding,join(root,'relocated'));assert(moved.result.snapshot.unresolved.some(v=>v.id==='original-run'&&v.status==='UNKNOWN'&&v.nextAction==='RECONCILE_OR_CANCEL'));
  const service=createManagedLegacyService(moved.result.managedBinding,{execute:()=>{executions++;throw new Error('Relocation cannot execute work');}});
  try{assert.deepEqual(read(service,'run.inspect',{id:'original-run'}),retained);assert.deepEqual(read(service,'receipt.inspect',{requestId:'original-dispatch'}),receipt);assert.equal(executions,1);}finally{service.close();}
});
