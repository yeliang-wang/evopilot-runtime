import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,rmSync,writeFileSync,existsSync,symlinkSync,chmodSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {withWorkspaceLease} from '../../dist/compat/workspace-lease.js';

const moduleUrl=pathToFileURL(realpathSync(fileURLToPath(new URL('../../dist/compat/workspace-lease.js',import.meta.url)))).href;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(t){const root=mkdtempSync(join(realpathSync(tmpdir()),'runtime-workspace-lease-')),workspaceRoot=join(root,'workspace');mkdirSync(workspaceRoot,{mode:0o700});t.after(()=>rmSync(root,{recursive:true,force:true}));return{root,context:{workspaceRoot,workspaceId:'lease-fixture'},control:workspaceRoot+'.evopilot-coordination'};}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}

test('operation and maintenance callbacks exclude each other and preserve original workspace coordination identity',async t=>{
  const f=fixture(t),entered=deferred(),release=deferred(),trace=[];
  const first=withWorkspaceLease(f.context,'host-one',async()=>{trace.push('host-enter');entered.resolve();await release.promise;trace.push('host-close');return'host-result';});await entered.promise;
  let maintenanceEntered=false;const second=withWorkspaceLease(f.context,'maintenance-one',()=>{maintenanceEntered=true;trace.push('maintenance-enter');return'maintenance-result';});
  await wait(80);assert.equal(maintenanceEntered,false);release.resolve();assert.equal(await first,'host-result');assert.equal(await second,'maintenance-result');assert.deepEqual(trace,['host-enter','host-close','maintenance-enter']);
  const db=new DatabaseSync(join(f.control,'lease.db'),{readOnly:true});try{const row=db.prepare('SELECT workspace,owner FROM workspace_lease WHERE id=1').get();assert.deepEqual(JSON.parse(row.workspace),{schema:'evopilot-workspace/v1',id:'lease-fixture',canonicalRoot:f.context.workspaceRoot,ownerUid:process.getuid()});assert.equal(row.owner,'null');}finally{db.close();}
});

test('abort while waiting does not enter the callback or make a new business attempt',async t=>{
  const f=fixture(t),entered=deferred(),release=deferred();const first=withWorkspaceLease(f.context,'hold',async()=>{entered.resolve();await release.promise;});await entered.promise;
  const controller=new AbortController();let calls=0;const blocked=withWorkspaceLease(f.context,'queued',()=>{calls++;},controller.signal);const rejected=assert.rejects(blocked,{name:'AbortError'});controller.abort();await rejected;assert.equal(calls,0);release.resolve();await first;
  await assert.rejects(withWorkspaceLease(f.context,'failed-callback',()=>{throw Object.assign(Error('retained original request'),{code:'SYNTHETIC_CALLBACK_FAILURE'});}),{code:'SYNTHETIC_CALLBACK_FAILURE'});
  assert.equal(await withWorkspaceLease(f.context,'next-explicit',()=>42),42);
});

test('existing identity, foreign files, unsafe modes and linked coordination roots fail before callbacks',async t=>{
  const f=fixture(t);await withWorkspaceLease(f.context,'initialize',()=>null);let calls=0;
  await assert.rejects(withWorkspaceLease({...f.context,workspaceId:'wrong'},'wrong',()=>calls++),{code:'IDENTITY_CONFLICT'});
  const file=join(f.control,'foreign');writeFileSync(file,'retained',{mode:0o600});await assert.rejects(withWorkspaceLease(f.context,'foreign',()=>calls++),{code:'UNSAFE_COORDINATION'});assert.equal(readFileSync(file,'utf8'),'retained');rmSync(file);
  chmodSync(join(f.control,'lease.db'),0o644);await assert.rejects(withWorkspaceLease(f.context,'mode',()=>calls++),{code:'UNSAFE_COORDINATION'});chmodSync(join(f.control,'lease.db'),0o600);
  const other=join(f.root,'other');mkdirSync(other,{mode:0o700});symlinkSync(f.control,other+'.evopilot-coordination');await assert.rejects(withWorkspaceLease({...f.context,workspaceRoot:other},'linked',()=>calls++));
  mkdirSync(join(f.context.workspaceRoot,'.git'),{mode:0o700});await assert.rejects(withWorkspaceLease(f.context,'git',()=>calls++),{code:'WORKSPACE_IN_GIT'});assert.equal(calls,0);
});

test('a real external lease holder blocks work and process death releases only coordination',async t=>{
  const f=fixture(t);await withWorkspaceLease(f.context,'identity',()=>null);
  const worker=spawn(process.execPath,['--input-type=module','-e',`import {withWorkspaceLease} from ${JSON.stringify(moduleUrl)};await withWorkspaceLease(JSON.parse(process.argv[1]),'worker',async()=>{process.send({held:true});await new Promise(resolve=>process.once('message',resolve));});process.disconnect();`,JSON.stringify(f.context)],{stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';worker.stderr.on('data',chunk=>stderr+=chunk);const exited=once(worker,'exit');t.after(async()=>{if(worker.exitCode===null&&worker.signalCode===null)worker.kill('SIGKILL');await exited;});
  const [message]=await once(worker,'message',{signal:AbortSignal.timeout(10000)});assert.equal(message.held,true);
  let started=false;const waiting=withWorkspaceLease(f.context,'explicit-successor',()=>{started=true;return'quiescent';});await wait(80);assert.equal(started,false);worker.kill('SIGKILL');await exited;assert.equal(await waiting,'quiescent');assert.equal(started,true);
  assert(!existsSync(join(f.context.workspaceRoot,'business-request')));assert(!stderr.includes('Error:'));
});

test('original coordination rows stay compatible and malformed requests create no control state',async t=>{
  const f=fixture(t);for(const id of ['', '../escape','x'.repeat(65)])await assert.rejects(withWorkspaceLease(f.context,id,()=>null),{code:'INVALID_REQUEST'});assert.equal(existsSync(f.control),false);
  mkdirSync(f.control,{mode:0o700});const filename=join(f.control,'lease.db');writeFileSync(filename,'',{mode:0o600});const db=new DatabaseSync(filename);
  const subject={canonicalRoot:f.context.workspaceRoot,id:f.context.workspaceId,ownerUid:process.getuid(),schema:'evopilot-workspace/v1'};
  db.exec('CREATE TABLE workspace_lease (id INTEGER PRIMARY KEY CHECK(id=1), workspace TEXT NOT NULL, owner TEXT NOT NULL)');db.prepare('INSERT INTO workspace_lease VALUES(1,?,?)').run(JSON.stringify(subject),'null');db.close();
  assert.equal(await withWorkspaceLease(f.context,'current-host',()=>true),true);
});
