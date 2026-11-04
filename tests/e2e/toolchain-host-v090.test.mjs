// SYNTHETIC failed downloads and permissions. Real filesystem, process death,
// Workspace writer exclusion and SDK transport; not final candidate acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {inspectWorkspaceToolchain,inspectToolchainPreparation,startToolchainPreparation,prepareToolchainHistoryDigest} from '../../dist/installation/toolchain/preparation.js';
import {openWorkspaceOperator} from '../../dist/installation/workspace/operator.js';
import {acquireManagedLegacyContext} from '../../dist/compat/managed-store.js';
import {inspectMaintenanceTree} from '../../dist/installation/workspace/stream.js';
import {relocationConfigurationFixture} from '../fixtures/relocation-configuration-v090.mjs';
import {canonical,digest} from '../../dist/server/errors.js';

const repo=fs.realpathSync(new URL('../../',import.meta.url).pathname),prefix='evopilot_v01_';
const fixture=t=>{const root=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'runtime-toolchain-host-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return{workspaceRoot:root,workspaceId:'synthetic',installationDigest:'a'.repeat(64)};};
const maintain=async work=>work();
async function terminal(c){for(let i=0;i<200;i++){const r=inspectToolchainPreparation(c);if(r&&!['RUNNING','UNKNOWN'].includes(r.status))return r;await new Promise(r=>setTimeout(r,10));}throw Error('Original preparation did not terminate');}
const write=(p,v)=>fs.writeFileSync(p,canonical(v)+'\n',{mode:0o600});
const operator=t=>{const f=relocationConfigurationFixture(t,false,false,true);f.operatorConfig.calls=['toolchain_inspect','toolchain_prepare'];write(f.ownerHost.workspaceConfigRef,f.operatorConfig);return{...f,ref:f.ownerHost.workspaceConfigRef,pin:digest(f.operatorConfig)};};

test('toolchain inspection is passive and missing bytes do not invent readiness',t=>{
 const c=fixture(t),before=inspectMaintenanceTree(c.workspaceRoot),r=inspectWorkspaceToolchain(c);
 assert.equal(r.ready,false);assert.equal(r.preparation,null);assert.equal(r.nextAction,'toolchain_prepare');assert.equal(r.authority,false);assert.deepEqual(inspectMaintenanceTree(c.workspaceRoot),before);
});

test('slow original preparation admits promptly, survives independent reads and never redispatches RUNNING or terminal requests',async t=>{
 const c=fixture(t),fetch=globalThis.fetch;let release,calls=0;
 globalThis.fetch=async()=>{calls++;return new Promise(resolve=>{release=()=>resolve(new Response('synthetic unavailable',{status:503}));});};
 try{
  const r=await Promise.race([startToolchainPreparation(c,'slow',maintain),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Admission blocked on download')),2000);timer.unref();})]);
  assert.equal(r.preparation.status,'RUNNING');assert.equal(calls,1);assert.equal((await startToolchainPreparation(c,'slow',maintain)).reused,true);
  await assert.rejects(startToolchainPreparation(c,'replacement',maintain),{code:'TOOLCHAIN_PREPARATION_UNCERTAIN'});
  const fresh=await import(pathToFileURL(path.join(repo,'dist/installation/toolchain/preparation.js')).href+'?independent-toolchain-reader');
  assert.equal(fresh.inspectToolchainPreparation(c).status,'UNKNOWN');assert.equal((await fresh.startToolchainPreparation(c,'slow',maintain)).preparation.status,'UNKNOWN');assert.equal(calls,1);
  release();const failed=await terminal(c);assert.equal(failed.status,'FAILED');assert.equal(failed.diagnostic,'TOOLCHAIN_DOWNLOAD');
  assert.equal((await fresh.startToolchainPreparation(c,'slow',maintain)).preparation.status,'FAILED');assert.equal(calls,1);
  globalThis.fetch=async()=>{calls++;throw Error('synthetic private URL and credential details');};await startToolchainPreparation(c,'explicit-retry',maintain);const retry=await terminal(c);
  assert.equal(retry.diagnostic,'TOOLCHAIN_DOWNLOAD_NETWORK');assert.equal(calls,2);assert(!JSON.stringify(retry).includes('credential'));
  assert.equal(fs.statSync(path.join(c.workspaceRoot,'native-toolchain-preparation/slow.json')).mode&0o777,0o600);
 }finally{release?.();globalThis.fetch=fetch;}
});

test('concurrent admission of the same request shares one task and snapshots its original context',async t=>{
 const c=fixture(t),original={...c},fetch=globalThis.fetch;let enter,count=0;
 globalThis.fetch=async()=>{count++;throw Error('synthetic offline');};
 try{
  const barrier=new Promise(resolve=>{enter=resolve;});
  const first=startToolchainPreparation(c,'concurrent',async work=>{await barrier;await work();});
  const second=startToolchainPreparation(c,'concurrent',maintain);c.workspaceRoot=path.join(original.workspaceRoot,'foreign');enter();
  const results=await Promise.all([first,second]);assert.equal(results[1].reused,true);assert.equal(count,1);assert.equal((await terminal(original)).status,'FAILED');assert(!fs.existsSync(c.workspaceRoot));
 }finally{globalThis.fetch=fetch;}
});

test('historical receipts stay readable but cannot authorize a changed installation or forged readiness',async t=>{
 const c=fixture(t),root=path.join(c.workspaceRoot,'native-toolchain-preparation');fs.mkdirSync(root,{mode:0o700});
 const lock=inspectWorkspaceToolchain(c).lock;
 const old={schema:'evopilot-toolchain-preparation/v1',...c,installationDigest:'b'.repeat(64),requestId:'old',lockDigest:lock.lockDigest,status:'SUCCEEDED',startedAt:'2026-01-01T00:00:00Z',completedAt:'2026-01-01T00:01:00Z',diagnostic:null};write(path.join(root,'old.json'),old);
 assert.equal(inspectToolchainPreparation(c).status,'SUCCEEDED');assert.equal(inspectWorkspaceToolchain(c).ready,false);
 await assert.rejects(startToolchainPreparation(c,'old',maintain),{code:'REQUEST_CONFLICT'});
 write(path.join(root,'old.json'),{...old,workspaceId:'other'});assert.throws(()=>inspectToolchainPreparation(c),{code:'TOOLCHAIN_PREPARATION_IDENTITY'});
 write(path.join(root,'old.json'),{...old,status:'RUNNING',completedAt:old.completedAt});assert.throws(()=>inspectToolchainPreparation(c),{code:'TOOLCHAIN_PREPARATION_INVALID'});
});

test('relocation reads only exact bound historical preparation bytes and preserves current readiness checks',async t=>{
 const original=fixture(t),moved=fixture(t),again=fixture(t),from=path.join(original.workspaceRoot,'native-toolchain-preparation');fs.mkdirSync(from,{mode:0o700});
 const old={schema:'evopilot-toolchain-preparation/v1',...original,requestId:'original',lockDigest:inspectWorkspaceToolchain(original).lock.lockDigest,status:'SUCCEEDED',startedAt:'2026-01-01T00:00:00Z',completedAt:'2026-01-01T00:01:00Z',diagnostic:null};write(path.join(from,'original.json'),old);
 const to=path.join(moved.workspaceRoot,'native-toolchain-preparation');fs.cpSync(from,to,{recursive:true});fs.chmodSync(to,0o700);
 assert.throws(()=>inspectToolchainPreparation(moved),{code:'TOOLCHAIN_PREPARATION_IDENTITY'});
 const bound={...moved,installationDigest:'b'.repeat(64),historicalRecordsDigest:prepareToolchainHistoryDigest(original)},bytes=fs.readFileSync(path.join(to,'original.json'));
 assert.equal(inspectToolchainPreparation(bound).historical,true);assert.equal(inspectToolchainPreparation(bound).workspaceRoot,original.workspaceRoot);
 assert.equal(inspectWorkspaceToolchain(bound).ready,false,'historical success cannot replace current dependency inspection');
 await assert.rejects(startToolchainPreparation(bound,'original',maintain),{code:'REQUEST_CONFLICT'});
 write(path.join(to,'original.json'),{...old,diagnostic:null,completedAt:'2026-01-01T00:02:00Z'});assert.throws(()=>inspectToolchainPreparation(bound),{code:'TOOLCHAIN_PREPARATION_IDENTITY'});fs.writeFileSync(path.join(to,'original.json'),bytes);
 write(path.join(to,'new.json'),{...old,workspaceRoot:moved.workspaceRoot,installationDigest:bound.installationDigest,requestId:'new',startedAt:'2026-01-02T00:00:00Z',completedAt:'2026-01-02T00:01:00Z'});
 assert.equal(inspectToolchainPreparation(bound).historical,false);
 const next={...again,historicalRecordsDigest:prepareToolchainHistoryDigest(bound)};fs.cpSync(to,path.join(again.workspaceRoot,'native-toolchain-preparation'),{recursive:true});fs.chmodSync(path.join(again.workspaceRoot,'native-toolchain-preparation'),0o700);assert.equal(inspectToolchainPreparation(next).historical,true);
 fs.unlinkSync(path.join(to,'original.json'));assert.throws(()=>inspectToolchainPreparation(bound),{code:'TOOLCHAIN_PREPARATION_IDENTITY'});
 assert.deepEqual(fs.readFileSync(path.join(from,'original.json')),bytes);
});

test('protected Host aliases reject arbitrary paths/downloads and do not widen existing grants',async t=>{
 const f=operator(t),r=openWorkspaceOperator(f.ref,f.pin),before=inspectMaintenanceTree(f.root);
 const view=await r.call(prefix+'toolchain_inspect',{});assert.equal(view.ready,false);assert.deepEqual(inspectMaintenanceTree(f.root),before);
 assert.equal(r.deactivatesSession(prefix+'toolchain_prepare'),true);assert.equal(r.requiresActiveSession(prefix+'toolchain_prepare',{}),false);
 for(const input of [{requestId:'wrong',url:'https://example.invalid'},{requestId:'wrong',cacheRoot:f.root},{requestId:'../escape'}])await assert.rejects(r.call(prefix+'toolchain_prepare',input));
 assert.deepEqual(inspectMaintenanceTree(f.root),before);
 const readOnly={...f.operatorConfig,calls:['toolchain_inspect']};write(f.ref,readOnly);await assert.rejects(openWorkspaceOperator(f.ref,digest(readOnly)).call(prefix+'toolchain_prepare',{requestId:'denied'}),{code:'WORKSPACE_OPERATOR_FORBIDDEN'});
});

test('another managed writer blocks preparation before downloading or admitting a request',async t=>{
 const f=operator(t),r=openWorkspaceOperator(f.ref,f.pin),lease=acquireManagedLegacyContext(f.binding),fetch=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;throw Error('must not download');};
 try{await assert.rejects(r.call(prefix+'toolchain_prepare',{requestId:'owned-writer'}),{code:'LEGACY_WRITER_ACTIVE'});assert.equal(calls,0);assert(!fs.existsSync(path.join(f.source.workspaceRoot,'native-toolchain-preparation')));}
 finally{lease.close();globalThis.fetch=fetch;}
});

test('actual stdio advertises only selected original toolchain aliases and inspects while Runtime is offline',async t=>{
 const f=operator(t),client=new Client({name:'synthetic-toolchain-reader',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,'dist/installation/workspace-host.js'),'--operator-config-ref',f.ref,'--operator-config-digest',f.pin],stderr:'pipe'});
 try{await client.connect(transport);const names=(await client.listTools()).tools.map(x=>x.name);assert(names.includes(prefix+'toolchain_inspect'));assert(names.includes(prefix+'toolchain_prepare'));assert(!names.includes(prefix+'workspace_migrate'));
  const result=await client.callTool({name:prefix+'toolchain_inspect',arguments:{}});assert(!result.isError);assert.equal(result.structuredContent.result.ready,false);
 }finally{await client.close();await transport.close();}
});

test('real Host process death retains UNKNOWN and forbids a replacement download',async t=>{
 const c=fixture(t),module=pathToFileURL(path.join(repo,'dist/installation/toolchain/preparation.js')).href;
 const program=`import {startToolchainPreparation} from ${JSON.stringify(module)};globalThis.fetch=async()=>new Promise(()=>{});const timer=setInterval(()=>{},1000);await startToolchainPreparation(${JSON.stringify(c)},'killed',async work=>work());process.stdout.write('ADMITTED\\n');`;
 const child=spawn(process.execPath,['--input-type=module','-e',program],{stdio:['ignore','pipe','pipe']});let output='';child.stdout.setEncoding('utf8');child.stdout.on('data',v=>{output+=v;});
 try{for(let i=0;i<200&&!output.includes('ADMITTED');i++){if(child.exitCode!==null)throw Error('Child ended before admission');await new Promise(r=>setTimeout(r,10));}assert(output.includes('ADMITTED'));const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  assert.equal(inspectToolchainPreparation(c).status,'UNKNOWN');let effects=0;const noEffects=async work=>{effects++;await work();};
  assert.equal((await startToolchainPreparation(c,'killed',noEffects)).preparation.status,'UNKNOWN');await assert.rejects(startToolchainPreparation(c,'replacement',noEffects),{code:'TOOLCHAIN_PREPARATION_UNCERTAIN'});assert.equal(effects,0);
 }finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}}
});
