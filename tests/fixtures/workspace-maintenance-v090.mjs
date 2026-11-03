// SYNTHETIC preservation fixture, not owner semantics or business approval.
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createRuntimeService} from '../../dist/service.js';
import {RuntimeStore} from '../../dist/server/store.js';
import {inspectLegacyWorkspace,createLegacyBackup,adoptLegacyWorkspace} from '../../dist/installation/migration.js';
const write=(file,value)=>fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});
const mkdir=root=>fs.mkdirSync(root,{mode:0o700});
export function workspaceMaintenanceFixture(t){
  const root=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'runtime-workspace-backup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const workspaceRoot=join(root,'workspace'),workspaceId='synthetic',serviceRoot=join(root,'service'),projectRoot=join(root,'project');
  const original=createRuntimeService({workspaceRoot,workspaceId});original.initialize();
  original.execute({operation:'project.create',scope:{visibility:'private',projectId:'synthetic'},input:{name:'Synthetic preserved project'},expectedRevision:0,requestId:'original-project'});original.close();
  mkdir(serviceRoot);const store=new RuntimeStore(join(serviceRoot,'data'),workspaceId),serviceId=store.serviceId;
  const actor={id:'synthetic',projects:['synthetic'],permissions:['read','draft.write'],revision:1,expiresAt:'2030-01-01T00:00:00Z'};
  store.mutate(actor,{projectId:'synthetic',operation:'synthetic.record',requestId:'pending-evidence',expectedRevision:0,input:{synthetic:true},permission:'draft.write'},()=>({value:{pending:'RECONCILE_OR_CANCEL'},objects:[{kind:'pending-fixture',id:'original',value:{pending:true}}],event:{type:'synthetic-recorded',data:{pending:true}}}));store.close();
  const old=inspectLegacyWorkspace(workspaceRoot,workspaceId),legacyBackup=join(root,'pre-adoption'),saved=createLegacyBackup(workspaceRoot,workspaceId,old.snapshotDigest,legacyBackup);
  const {binding}=adoptLegacyWorkspace({workspaceRoot,workspaceId,serviceId,expectedSnapshotDigest:old.snapshotDigest,backupRoot:legacyBackup,expectedBackupDigest:saved.backupDigest});
  mkdir(projectRoot);write(join(projectRoot,'workspace-project.json'),{schema:'evopilot-workspace-project/v1',id:workspaceId,templateVersion:'0.2.0'});
  mkdir(join(projectRoot,'assets'));fs.chmodSync(join(projectRoot,'assets'),0o755);write(join(projectRoot,'assets','asset.json'),{synthetic:true,immutable:'asset'});fs.symlinkSync('assets/asset.json',join(projectRoot,'current.json'));
  for(const owner of ['ontology','harness']){
    const directory=join(workspaceRoot,'state',owner);mkdir(directory);const file=join(directory,owner+'.db');write(file,'');const db=new DatabaseSync(file);
    db.exec('PRAGMA user_version=8; CREATE TABLE synthetic_all_records(id INTEGER PRIMARY KEY, data BLOB); CREATE TABLE synthetic_later_domain(id TEXT PRIMARY KEY, data TEXT);');
    db.prepare('INSERT INTO synthetic_all_records VALUES(?,?)').run(9007199254740993n,Buffer.from('opaque '+owner));db.prepare('INSERT INTO synthetic_later_domain VALUES(?,?)').run('pending','Do not redispatch');db.close();
  }
  mkdir(join(workspaceRoot,'opaque-evidence'));write(join(workspaceRoot,'opaque-evidence','receipt.txt'),'original evidence');
  const reference=join(root,'external-configuration.json');write(reference,{synthetic:true,route:'fixture'});
  write(join(serviceRoot,'legacy-binding.json'),binding);write(join(serviceRoot,'client.json'),{synthetic:true});
  write(join(serviceRoot,'service-specification.json'),{schema:'runtime-user-service/v1',root:serviceRoot,workspaceId,tokenRef:join(serviceRoot,'client.json'),legacyRef:join(serviceRoot,'legacy-binding.json'),integrationsRef:reference});
  return{root,selection:{...binding,projectRoot,serviceRoot,referenceFiles:[]},binding,reference,backupRoot:join(root,'whole-backup')};
}
