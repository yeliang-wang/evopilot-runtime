// SYNTHETIC same-host recovery; no daily workspace or business approvals.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {workspaceMaintenanceFixture as fixture} from '../fixtures/workspace-maintenance-v090.mjs';
import {inspectManagedWorkspace} from '../../dist/installation/workspace/snapshot.js';
import {createManagedWorkspaceBackup,restoreManagedWorkspaceBackup,verifyManagedWorkspaceBackup} from '../../dist/installation/workspace/backup.js';
import {hashMaintenanceFile,maintenanceJSONDigest} from '../../dist/installation/workspace/stream.js';
import {RuntimeStore} from '../../dist/server/store.js';
const sha=v=>createHash('sha256').update(v).digest('hex');
const roots=f=>[f.selection.projectRoot,f.selection.workspaceRoot,f.selection.serviceRoot];
const removeSources=f=>{for(const root of roots(f))fs.renameSync(root,root+'.retained');};
const backup=async f=>{const snapshot=await inspectManagedWorkspace(f.selection,'inspect');return createManagedWorkspaceBackup(f.selection,'backup',snapshot.snapshotDigest,f.backupRoot);};
const request=(f,saved,id='restore')=>restoreManagedWorkspaceBackup(f.backupRoot,saved.backupDigest,id);

test('original missing locations recover all selected data, immutable adoption and pending evidence without dispatch or startup',async t=>{
  const f=fixture(t),saved=await backup(f),referenceInode=fs.statSync(f.reference).ino;removeSources(f);
  const result=await request(f,saved);assert.equal(result.status,'VERIFIED');assert.equal(result.serviceStarted,false);assert.equal(result.businessWorkDispatched,false);assert.equal(result.authority,false);
  assert.equal((await inspectManagedWorkspace(f.selection,'restored')).snapshotDigest,saved.snapshot.snapshotDigest);
  assert.equal(fs.statSync(f.reference).ino,referenceInode);assert.equal(fs.readlinkSync(join(f.selection.projectRoot,'current.json')),'assets/asset.json');
  const store=new RuntimeStore(join(f.selection.serviceRoot,'data'),'synthetic');
  try{assert.deepEqual(store.object('synthetic','pending-fixture','original'),{pending:true});assert.equal(store.revision('synthetic'),1);}finally{store.close();}
  fs.writeFileSync(join(f.selection.projectRoot,'new-work'),'later legitimate work',{mode:0o600});
  assert.deepEqual(await request(f,saved),result);assert.equal(fs.readFileSync(join(f.selection.projectRoot,'new-work'),'utf8'),'later legitimate work');
  assert.deepEqual(verifyManagedWorkspaceBackup(f.backupRoot,saved.backupDigest),saved);
});

test('empty original roots and a missing selected read-only external reference are restored with exact bytes and modes',async t=>{
  const f=fixture(t);fs.chmodSync(f.reference,0o400);const bytes=fs.readFileSync(f.reference),saved=await backup(f);removeSources(f);
  for(const root of roots(f))fs.mkdirSync(root,{mode:0o700});fs.renameSync(f.reference,f.reference+'.retained');
  await request(f,saved);assert.deepEqual(fs.readFileSync(f.reference),bytes);assert.equal(fs.statSync(f.reference).mode&0o777,0o400);assert.equal(fs.statSync(f.reference).nlink,1);
  assert(!fs.readdirSync(f.root).some(name=>name.startsWith('.evopilot-restore-')));
  assert.equal((await inspectManagedWorkspace(f.selection,'verified')).snapshotDigest,saved.snapshot.snapshotDigest);
});

test('occupied roots, changed existing references, wrong anchor and corrupt payload are refused without replacing current data',async t=>{
  const f=fixture(t),saved=await backup(f);await assert.rejects(request(f,saved),{code:'MAINTENANCE_DESTINATION_NOT_EMPTY'});
  removeSources(f);const original=fs.readFileSync(f.reference);fs.writeFileSync(f.reference,'new configuration');
  await assert.rejects(request(f,saved,'conflict'),{code:'MAINTENANCE_REFERENCE_CONFLICT'});assert(roots(f).every(root=>!fs.existsSync(root)));assert.equal(fs.readFileSync(f.reference,'utf8'),'new configuration');fs.writeFileSync(f.reference,original);
  const anchor=join(f.selection.workspaceRoot+'.evopilot-maintenance','known-backups',sha(f.backupRoot)+'.json'),anchorBytes=fs.readFileSync(anchor);fs.writeFileSync(anchor,'{}');
  await assert.rejects(request(f,saved,'anchor'),{code:'MAINTENANCE_BACKUP_UNKNOWN'});assert(roots(f).every(root=>!fs.existsSync(root)));fs.writeFileSync(anchor,anchorBytes);
  const copied=join(f.backupRoot,'workspace/state/runtime/runtime.db');fs.writeFileSync(copied,'tampered backup');await assert.rejects(request(f,saved,'tampered'),{code:'MAINTENANCE_BACKUP_CHANGED'});assert(roots(f).every(root=>!fs.existsSync(root)));
});

test('recovery does not follow a replacement destination symlink or invent a missing known-backup decision',async t=>{
  const f=fixture(t),saved=await backup(f);removeSources(f);
  const foreign=join(f.root,'foreign');fs.mkdirSync(foreign,{mode:0o700});fs.symlinkSync(foreign,f.selection.projectRoot);
  await assert.rejects(request(f,saved),{code:'SYMLINK'});assert.deepEqual(fs.readdirSync(foreign),[]);fs.unlinkSync(f.selection.projectRoot);
  const anchor=join(f.selection.workspaceRoot+'.evopilot-maintenance','known-backups',sha(f.backupRoot)+'.json');fs.renameSync(anchor,anchor+'.retained');
  await assert.rejects(request(f,saved,'unknown'),{code:'ENOENT'});assert(roots(f).every(root=>!fs.existsSync(root)));
});

test('loaded Runtime or online KeepAlive jobs block recovery even while no process is running',async t=>{
  const f=fixture(t),saved=await backup(f);removeSources(f);
  const labels=['io.evopilot.runtime.synthetic.'+sha(f.selection.serviceRoot).slice(0,16),'io.evopilot.online.'+sha(f.selection.workspaceRoot+'\0synthetic').slice(0,24)];
  for(const [i,label] of labels.entries()){
    const plist=join(f.root,'synthetic-job-'+i+'.plist');fs.writeFileSync(plist,`<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/usr/bin/true</string></array><key>RunAtLoad</key><false/><key>KeepAlive</key><false/></dict></plist>`,{mode:0o600});
    execFileSync('/bin/launchctl',['bootstrap','gui/'+process.getuid(),plist]);
    try{await assert.rejects(request(f,saved,'active-'+i),{code:i===0?'SERVICE_ACTIVE':'ONLINE_WORKER_ACTIVE'});assert(roots(f).every(root=>!fs.existsSync(root)));}
    finally{execFileSync('/bin/launchctl',['bootout','gui/'+process.getuid()+'/'+label]);}
  }
  await request(f,saved,'stopped');
});

test('abort before recovery leaves all missing destinations missing',async t=>{
  const f=fixture(t),saved=await backup(f);removeSources(f);const controller=new AbortController();controller.abort();
  await assert.rejects(restoreManagedWorkspaceBackup(f.backupRoot,saved.backupDigest,'aborted',controller.signal),{name:'AbortError'});assert(roots(f).every(root=>!fs.existsSync(root)));
});

test('real process death retains exact restore progress and completes an interrupted exclusive external-reference publish',async t=>{
  const f=fixture(t),large=join(f.selection.projectRoot,'large-evidence'),fd=fs.openSync(large,'wx',0o600),chunk=Buffer.alloc(4*1024*1024,77);
  try{for(let i=0;i<32;i++)fs.writeSync(fd,chunk);}finally{fs.closeSync(fd);}
  const saved=await backup(f);removeSources(f);fs.renameSync(f.reference,f.reference+'.retained');
  const module=new URL('../../dist/installation/workspace/backup.js',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {restoreManagedWorkspaceBackup} from ${JSON.stringify(module)};await restoreManagedWorkspaceBackup(process.argv[1],process.argv[2],'restore-killed');`,f.backupRoot,saved.backupDigest],{stdio:['ignore','ignore','pipe']});
  let stderr='';child.stderr.on('data',b=>stderr+=b);t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});const closed=once(child,'close');
  const stage=join(f.selection.projectRoot,'.evopilot-copy-restore-killed'),deadline=Date.now()+30000;let killed=false;
  while(Date.now()<deadline&&child.exitCode===null&&child.signalCode===null){
    if(fs.existsSync(stage)&&fs.readdirSync(stage).some(name=>{try{return fs.statSync(join(stage,name)).size>1048576;}catch(error){if(error.code==='ENOENT')return false;throw error;}})){child.kill('SIGKILL');killed=true;break;}
    await new Promise(r=>setTimeout(r,2));
  }
  if(!killed&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed;assert(killed,stderr);
  const journal=join(f.selection.workspaceRoot+'.evopilot-maintenance','requests','restore-killed.json');assert.equal(JSON.parse(fs.readFileSync(journal)).status,'COPYING');
  // Exact on-disk state of a crash between exclusive link and staged unlink.
  const refStage=join(f.root,'.evopilot-restore-'+maintenanceJSONDigest({path:f.reference,requestId:'restore-killed',backupDigest:saved.backupDigest}));
  fs.copyFileSync(join(f.backupRoot,'references',sha(f.reference)),refStage,fs.constants.COPYFILE_EXCL);fs.linkSync(refStage,f.reference);assert.equal(fs.statSync(f.reference).nlink,2);
  const result=await request(f,saved,'restore-killed');assert.equal(result.status,'VERIFIED');assert.equal(fs.existsSync(refStage),false);assert.equal(fs.statSync(f.reference).nlink,1);
  assert.equal(hashMaintenanceFile(join(f.selection.projectRoot,'large-evidence')).sha256,hashMaintenanceFile(join(f.selection.projectRoot+'.retained','large-evidence')).sha256);
  assert.equal((await inspectManagedWorkspace(f.selection,'restored-current')).snapshotDigest,saved.snapshot.snapshotDigest);
  assert.equal(JSON.parse(fs.readFileSync(journal)).status,'VERIFIED');
});
