import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,readFileSync,writeFileSync,readdirSync,lstatSync,chmodSync,symlinkSync,mkdirSync,cpSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createRuntimeService} from '../../dist/service.js';
import {createRuntimeService as historicalFixture} from '../fixtures/historical-runtime-v020.mjs';
import {createManagedLegacyService} from '../../dist/compat/managed-service.js';
import {inspectLegacyWorkspace,createLegacyBackup,verifyLegacyBackup,adoptLegacyWorkspace} from '../../dist/installation/migration.js';
import {syntheticReadinessMaterial} from '../fixtures/adapters-v090.mjs';
import {syntheticDecisionEvidence} from '../fixtures/native/decision-evidence.mjs';
import {nativeSha256} from '../../vendor/compatibility/v1/native.mjs';

const scope={visibility:'private',projectId:'synthetic'};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t){
  const parent=mkdtempSync(join(realpathSync(tmpdir()),'runtime-managed-test-'));
  t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const options={workspaceRoot:join(parent,'original'),workspaceId:'legacy-fixture'};
  return{parent,options,dbPath:join(options.workspaceRoot,'state/runtime/runtime.db'),backupRoot:join(parent,'backup')};
}
function inventory(root){
  const values=[];function visit(path){const stat=lstatSync(path);values.push([path.slice(root.length),stat.mode&0o777,stat.isFile()?hash(readFileSync(path)):null]);if(stat.isDirectory())for(const name of readdirSync(path).sort())visit(join(path,name));}visit(root);return values;
}
function read(service,operation,input={}){return service.execute({operation,scope,input});}
function write(service,operation,input,requestId){return service.execute({operation,scope,input,requestId,expectedRevision:read(service,'workspace.inspect').revision});}
function query(f,fn){const db=new DatabaseSync(f.dbPath);try{return fn(db);}finally{db.close();}}
function originalTables(f){return query(f,db=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='runtime_service_migration' ORDER BY name").all().map(({name})=>[name,db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'" ORDER BY 1,2').all()]));}
async function readiness(service,f,id='synthetic-content'){
  const definition={...syntheticReadinessMaterial(f.options.workspaceId,scope.projectId).definition,id};
  const input={standardVersion:'v2',definition,previousDigest:null};
  const review=await service.readiness({operation:'readiness.intent.review',scope,input});
  input.humanEvidenceRef=syntheticDecisionEvidence(f.parent,{owner:'runtime',operation:'readiness.intent.record',workspaceId:f.options.workspaceId,scope,reviewDigest:review.reviewDigest,decision:'ACCEPT'});
  const request={operation:'readiness.intent.record',scope,input,requestId:'intent-'+id,expectedRevision:(await service.readiness({operation:'readiness.inspect',scope,input:{standardVersion:'v2'}})).revision};
  return{request,receipt:await service.readiness(request)};
}
async function populate(f,rich=true){
  const old=historicalFixture(f.options);old.initialize();
  const project=write(old,'project.create',{name:'Synthetic original project'},'original-project');
  const goal=write(old,'goal.create',{id:'goal',description:'Retain original identifiers'},'original-goal');old.close();
  if(!rich)return{project,goal};
  const requirements=[{criterionId:'fixture',variantIds:['fixture.01'],origin:'execution-result'}];
  const sourceScope={direction:'reverse',locator:'synthetic:legacy-migration',revision:'1',treeDigest:nativeSha256('source'),inventoryDigest:nativeSha256(['fixture.ts']),requirementsDigest:nativeSha256(requirements)};
  const pins=Object.fromEntries(['ontology','harness'].map(p=>[p,{standardDigest:nativeSha256({p,spec:1}),standardLockDigest:nativeSha256({p,lock:1})}]));
  const providers={nativeStandards:pins,inspectSource:()=>sourceScope,resolveRequirements:()=>requirements};
  const service=createRuntimeService(f.options,providers);service.initialize();
  try{
    const nativeRequest={operation:'project.prepare',scope,input:{id:'native-project',goalId:'goal',sourceScope,standardPins:pins,requirements},requestId:'original-native-project',expectedRevision:0};
    const native=await service.native(nativeRequest),intent=await readiness(service,f);
    return{project,goal,native,nativeRequest,intent,providers};
  }finally{service.close();}
}
function backup(f){const snapshot=inspectLegacyWorkspace(f.options.workspaceRoot,f.options.workspaceId);const saved=createLegacyBackup(f.options.workspaceRoot,f.options.workspaceId,snapshot.snapshotDigest,f.backupRoot);return{snapshot,saved,request:{...f.options,serviceId:'synthetic-independent-service',expectedSnapshotDigest:snapshot.snapshotDigest,backupRoot:f.backupRoot,expectedBackupDigest:saved.backupDigest}};}

test('legacy inspection is byte-preserving and backup retains every original Runtime record without copying owner data',async t=>{
  const f=fixture(t);await populate(f);
  mkdirSync(join(f.options.workspaceRoot,'private'),{mode:0o700});mkdirSync(join(f.options.workspaceRoot,'private','projects'),{mode:0o700});mkdirSync(join(f.options.workspaceRoot,'private','projects','synthetic'),{mode:0o700});mkdirSync(join(f.options.workspaceRoot,'private','projects','synthetic','ontology'),{mode:0o700});
  writeFileSync(join(f.options.workspaceRoot,'private','projects','synthetic','ontology','do-not-copy.txt'),'owner-private',{mode:0o600});
  const before=inventory(f.options.workspaceRoot),b=backup(f);
  assert.deepEqual(inventory(f.options.workspaceRoot),before);assert.equal(b.snapshot.schemaVersion,8);
  assert.equal(b.snapshot.database.tables.some(table=>table.name==='feedback_records'),true);
  assert.equal(b.snapshot.entries.some(entry=>entry.path.includes('ontology')),false);
  assert.deepEqual(verifyLegacyBackup(f.backupRoot,b.saved.backupDigest),b.saved);
});
test('exact adoption preserves independent revision namespaces and original receipts; new writes retain schema 9',async t=>{
  const f=fixture(t),original=await populate(f),b=backup(f),before=originalTables(f);
  const adopted=adoptLegacyWorkspace(b.request);assert.equal(adopted.authority,false);
  assert.deepEqual(originalTables(f),before);assert.equal(query(f,db=>db.prepare('PRAGMA user_version').get().user_version),9);
  const legacy=createRuntimeService(f.options);assert.throws(()=>legacy.initialize(),{code:'MANAGED_SERVICE_REQUIRED'});legacy.close();
  const service=createManagedLegacyService(adopted.binding,original.providers);
  try{
    assert.deepEqual(read(service,'receipt.inspect',{requestId:'original-project'}),original.project);
    assert.deepEqual(service.execute({operation:'project.create',scope,input:{name:'Synthetic original project'},requestId:'original-project',expectedRevision:0}),original.project);
    assert.deepEqual(await service.native(original.nativeRequest),original.native);
    assert.deepEqual(await service.readiness(original.intent.request),original.intent.receipt);
    assert.deepEqual(await service.native({operation:'project.inspect',scope,input:{id:'native-project'}}),original.native.result);
    assert.throws(()=>service.execute({operation:'goal.create',scope,input:{id:'next',description:'Do not bypass CAS'},requestId:'next-goal',expectedRevision:0}),{code:'REVISION_CONFLICT'});
    await readiness(service,f,'new-content');
    assert.equal(query(f,db=>db.prepare('PRAGMA user_version').get().user_version),9);
  }finally{service.close();}
  assert.deepEqual(adoptLegacyWorkspace(b.request),adopted,'exact adoption retry must not reapply the old snapshot over new writes');
  const reopened=createManagedLegacyService(adopted.binding,original.providers);
  assert.equal((await reopened.readiness({operation:'readiness.intent.list',scope,input:{standardVersion:'v2'}})).items.length,2);reopened.close();
  assert.deepEqual(verifyLegacyBackup(f.backupRoot,b.saved.backupDigest),b.saved);
});
test('schema 1 can be adopted and later initialize native structures without downgrading the migration seal',async t=>{
  const f=fixture(t);await populate(f,false);const b=backup(f),adopted=adoptLegacyWorkspace(b.request);
  assert.equal(b.snapshot.schemaVersion,1);
  const service=createManagedLegacyService(adopted.binding);
  try{assert.equal(read(service,'workspace.inspect').revision,2);await service.native({operation:'workspace.inspect',scope,input:{}});await readiness(service,f);assert.equal(query(f,db=>db.prepare('PRAGMA user_version').get().user_version),9);}finally{service.close();}
  const again=createManagedLegacyService(adopted.binding);again.close();
});
test('migration fails closed on changed original and does not apply the old backup',async t=>{
  const f=fixture(t);await populate(f,false);const b=backup(f);
  const writer=createRuntimeService(f.options);writer.initialize();write(writer,'goal.create',{id:'later',description:'Must be preserved'},'later');writer.close();
  const before=originalTables(f);assert.throws(()=>adoptLegacyWorkspace(b.request),{code:'SNAPSHOT_DRIFT'});assert.deepEqual(originalTables(f),before);
  assert.equal(query(f,db=>db.prepare('PRAGMA user_version').get().user_version),1);
});
test('missing, tampered and incorrectly anchored backups cannot authorize adoption',async t=>{
  const f=fixture(t);await populate(f,false);const b=backup(f),before=readFileSync(f.dbPath);
  assert.throws(()=>adoptLegacyWorkspace({...b.request,expectedBackupDigest:'f'.repeat(64)}),{code:'MIGRATION_BACKUP_CHANGED'});
  const path=join(f.backupRoot,'payload',databasePath());const saved=readFileSync(path);writeFileSync(path,'corrupt',{mode:0o600});
  assert.throws(()=>adoptLegacyWorkspace(b.request),{code:'MIGRATION_BACKUP_CHANGED'});writeFileSync(path,saved);
  rmSync(join(f.backupRoot,'manifest.json'));assert.throws(()=>adoptLegacyWorkspace(b.request),{code:'MIGRATION_BACKUP_CHANGED'});
  assert.deepEqual(readFileSync(f.dbPath),before);
});
function databasePath(){return'state/runtime/runtime.db';}
function privateCopy(source,destination){cpSync(source,destination,{recursive:true});const protect=path=>{const stat=lstatSync(path);chmodSync(path,stat.isDirectory()?0o700:0o600);if(stat.isDirectory())for(const name of readdirSync(path))protect(join(path,name));};protect(destination);}
test('a managed database is pinned to its workspace, service and migration digest; duplicate writer is rejected',async t=>{
  const f=fixture(t);await populate(f,false);const b=backup(f),{binding}=adoptLegacyWorkspace(b.request);
  for(const field of ['serviceId','migrationDigest'])assert.throws(()=>createManagedLegacyService({...binding,[field]:'wrong'}),{code:'MIGRATION_BINDING_CHANGED'});
  assert.throws(()=>createManagedLegacyService({...binding,workspaceId:'another'}),{code:'IDENTITY_MISMATCH'});
  const service=createManagedLegacyService(binding);
  try{assert.throws(()=>createManagedLegacyService(binding),{code:'LEGACY_WRITER_ACTIVE'});assert.throws(()=>adoptLegacyWorkspace(b.request),{code:'LEGACY_WRITER_ACTIVE'});}finally{service.close();}
  assert.throws(()=>adoptLegacyWorkspace({...b.request,serviceId:'another'}),{code:'MIGRATION_BINDING_CHANGED'});
  const second=createManagedLegacyService(binding);second.close();assert.throws(()=>read(second,'workspace.inspect'),{code:'CLOSED'});
});
test('an OS crash releases the managed writer lease and original committed receipts remain readable',async t=>{
  const f=fixture(t),original=await populate(f,false),b=backup(f),{binding}=adoptLegacyWorkspace(b.request);
  const module=new URL('../../dist/compat/managed-service.js',import.meta.url).href;
  const script=`import {createManagedLegacyService} from ${JSON.stringify(module)};globalThis.managed=createManagedLegacyService(JSON.parse(process.argv[1]));process.stdout.write('READY\\n');setInterval(()=>globalThis.managed.capabilities(),1000);`;
  const child=spawn(process.execPath,['--input-type=module','-e',script,JSON.stringify(binding)],{stdio:['ignore','pipe','pipe']});t.after(()=>child.kill('SIGKILL'));
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('child startup: '+stderr)),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('exit',code=>{clearTimeout(timer);reject(new Error('child exited '+code+': '+stderr));});});
  assert.throws(()=>createManagedLegacyService(binding),{code:'LEGACY_WRITER_ACTIVE'});const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  const service=createManagedLegacyService(binding);try{assert.deepEqual(read(service,'receipt.inspect',{requestId:'original-project'}),original.project);}finally{service.close();}
});
test('downgraded, deleted or changed adoption records are rejected even by a previously opened service',async t=>{
  const f=fixture(t);await populate(f,false);const b=backup(f),{binding}=adoptLegacyWorkspace(b.request);
  const service=createManagedLegacyService(binding);
  query(f,db=>db.exec('PRAGMA user_version=1'));
  try{assert.throws(()=>read(service,'workspace.inspect'),{code:'MIGRATION_DOWNGRADE'});}finally{service.close();}
  assert.throws(()=>createManagedLegacyService(binding),{code:'MIGRATION_DOWNGRADE'});
  query(f,db=>db.exec('PRAGMA user_version=9; DELETE FROM runtime_service_migration'));
  assert.throws(()=>createManagedLegacyService(binding),{code:'MIGRATION_CORRUPT'});
});
test('a nonquiescent original is refused without deleting WAL or checkpointing the live database',async t=>{
  const f=fixture(t);await populate(f,false);const writer=createRuntimeService(f.options);writer.initialize();
  try{write(writer,'goal.create',{id:'live',description:'Active writer'},'live');const before=inventory(f.options.workspaceRoot);assert.throws(()=>inspectLegacyWorkspace(f.options.workspaceRoot,f.options.workspaceId),{code:'LEGACY_NOT_QUIESCENT'});assert.deepEqual(inventory(f.options.workspaceRoot),before);}finally{writer.close();}
});
test('foreign schemas, unsafe file permissions, links and overlapping backup roots fail without data mutation',async t=>{
  const f=fixture(t);await populate(f,false);const b=backup(f);
  assert.throws(()=>createLegacyBackup(f.options.workspaceRoot,f.options.workspaceId,b.snapshot.snapshotDigest,join(f.options.workspaceRoot,'backup')),{code:'MIGRATION_BACKUP_PATH'});
  chmodSync(f.dbPath,0o644);assert.throws(()=>inspectLegacyWorkspace(f.options.workspaceRoot,f.options.workspaceId),{code:'UNSAFE_WORKSPACE'});chmodSync(f.dbPath,0o600);
  const link=join(f.parent,'linked');symlinkSync(f.options.workspaceRoot,link);assert.throws(()=>inspectLegacyWorkspace(link,f.options.workspaceId),{code:'UNSAFE_WORKSPACE'});
  query(f,db=>db.exec('PRAGMA user_version=42'));const before=readFileSync(f.dbPath);
  assert.throws(()=>inspectLegacyWorkspace(f.options.workspaceRoot,f.options.workspaceId),{code:'MIGRATION_SCHEMA'});assert.deepEqual(readFileSync(f.dbPath),before);
});
test('backup remains a protected archive and cannot silently be opened as a relocated workspace',async t=>{
  const f=fixture(t);await populate(f,false);const b=backup(f);
  const copied=join(f.parent,'copy');privateCopy(join(f.backupRoot,'payload'),copied);
  assert.throws(()=>inspectLegacyWorkspace(copied,f.options.workspaceId),{code:'IDENTITY_MISMATCH'});
  assert.deepEqual(verifyLegacyBackup(f.backupRoot,b.saved.backupDigest),b.saved);
});
test('original unresolved Run and its original dispatch receipt survive adoption without redispatch or fabricated success',async t=>{
  const f=fixture(t);let executions=0;
  const d='sha256:'+'a'.repeat(64),resolve=({reference,workspace})=>({reference,workspace,scope,published:true,materialDigest:d,descriptor:{kind:reference.product+'-composition/v1',digest:d}});
  const old=historicalFixture(f.options,{resolveOntology:resolve,resolveHarness:resolve,execute:()=>{executions++;return undefined;}});old.initialize();
  write(old,'project.create',{name:'Historical synthetic Run'},'project');write(old,'goal.create',{id:'goal',description:'Original unresolved claim'},'goal');
  const ref=product=>({product,id:product,version:'1.0.0',specVersion:'v1',visibility:'private',digest:d});
  const prepared=write(old,'run.prepare',{id:'original-run',goalId:'goal',ontology:ref('ontology'),harness:ref('harness'),input:{schema:'runtime-composition/v1',ontologyInstance:{entities:[],relations:[]},harness:{mode:'composed',evidence:{},configuration:{}}}},'prepare').result;
  write(old,'run.decide',{id:prepared.id,reviewDigest:prepared.reviewDigest,decision:'APPROVE',humanEvidenceRef:'synthetic:historical-test-only'},'decision');
  await old.dispatch({scope,id:prepared.id,requestId:'original-dispatch',expectedRevision:read(old,'workspace.inspect').revision});
  const retained=read(old,'run.inspect',{id:prepared.id}),receipt=read(old,'receipt.inspect',{requestId:'original-dispatch'});old.close();
  assert.equal(retained.stage,'UNKNOWN');assert.equal(executions,1);
  const b=backup(f),{binding}=adoptLegacyWorkspace(b.request),service=createManagedLegacyService(binding);
  try{assert.deepEqual(read(service,'run.inspect',{id:prepared.id}),retained);assert.deepEqual(read(service,'receipt.inspect',{requestId:'original-dispatch'}),receipt);assert.equal(executions,1);}finally{service.close();}
});
test('managed async context survives awaits and cannot release its writer while the original request is pending',async t=>{
  const f=fixture(t),original=await populate(f),b=backup(f),{binding}=adoptLegacyWorkspace(b.request);
  let proceed,entered;const waiting=new Promise(resolve=>proceed=resolve),started=new Promise(resolve=>entered=resolve);
  const service=createManagedLegacyService(binding,{...original.providers,inspectSource:async()=>{entered();await waiting;return original.providers.inspectSource();}});
  const pending=service.native({...original.nativeRequest,input:{...original.nativeRequest.input,id:'later'},requestId:'later-native',expectedRevision:original.native.revision});
  await started;assert.throws(()=>service.close(),{code:'BUSY'});assert.throws(()=>createManagedLegacyService(binding),{code:'LEGACY_WRITER_ACTIVE'});
  const other=createRuntimeService(f.options);assert.throws(()=>other.initialize(),{code:'MANAGED_SERVICE_REQUIRED'});other.close();
  proceed();const receipt=await pending;assert.equal(receipt.result.id,'later');service.close();
  const reopened=createManagedLegacyService(binding,original.providers);try{assert.deepEqual(await reopened.native({operation:'receipt.inspect',scope,input:{requestId:'later-native'}}),receipt);}finally{reopened.close();}
});
test('isolated rollback restores the verified old backup at its original identity while retaining all newer managed evidence separately',async t=>{
  const f=fixture(t),original=await populate(f,false),b=backup(f),{binding}=adoptLegacyWorkspace(b.request);
  const service=createManagedLegacyService(binding);const newer=write(service,'goal.create',{id:'newer',description:'Must never be lost on rollback'},'newer');service.close();
  const retained=join(f.parent,'retained-managed');renameSync(f.options.workspaceRoot,retained);
  privateCopy(join(f.backupRoot,'payload'),f.options.workspaceRoot);
  assert.equal(inspectLegacyWorkspace(f.options.workspaceRoot,f.options.workspaceId).snapshotDigest,b.snapshot.snapshotDigest);
  const rollback=createRuntimeService(f.options);rollback.initialize();assert.deepEqual(read(rollback,'receipt.inspect',{requestId:'original-project'}),original.project);rollback.close();
  renameSync(f.options.workspaceRoot,join(f.parent,'retained-old'));renameSync(retained,f.options.workspaceRoot);
  const resumed=createManagedLegacyService(binding);try{assert.deepEqual(read(resumed,'receipt.inspect',{requestId:'newer'}),newer);}finally{resumed.close();}
});
