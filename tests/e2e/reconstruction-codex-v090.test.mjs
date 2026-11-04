import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {createCodexReconstructionAdapter,describeCodexReconstruction,CODEX_ADAPTER,CODEX_STATE_ADAPTER} from '../../dist/compat/reconstruction/codex-reconstruction.js';
import {nativeBytesDigest} from '../../vendor/compatibility/v1/native.mjs';
import {reconstructionFixture,hash} from '../fixtures/reconstruction.mjs';
import {ownedStateDevice,CodexStorage} from '../../dist/compat/reconstruction/codex-storage.js';
const digest=p=>nativeBytesDigest(fs.readFileSync(p));
// Synthetic protocol server, actual detached worker and actual macOS sandbox stages.
async function fixture(t,mode='success',run='const app=await import(process.env.EVOPILOT_OUTPUT+"/app.mjs");process.stdout.write(JSON.stringify({actual:app.transform(2)}));',options={}){
 const f=await reconstructionFixture(t,{prepare:false,budget:{wallMs:15000,maxTokens:1000,maxCostMicros:null,maxOutputBytes:65536,...(options.state?{wallMs:60000}:{}),...options.budget}}),root=path.join(f.root,'adapter'),tools=path.join(f.root,'tools');fs.mkdirSync(root,{mode:0o700});fs.mkdirSync(tools,{mode:0o700});
 const policy=path.join(tools,'AGENTS.md');fs.writeFileSync(policy,'Synthetic generic policy.\n',{mode:0o600});
 const executable=path.join(tools,'codex');fs.writeFileSync(executable,'#!'+process.execPath+'\nimport {serve} from '+JSON.stringify(new URL('../fixtures/reconstruction-codex-server-v090.mjs',import.meta.url).href)+';serve('+JSON.stringify(mode)+','+JSON.stringify(policy)+');\n',{mode:0o700});
 const stages=Object.fromEntries(Object.entries({build:options.build??'const app=await import(process.env.EVOPILOT_OUTPUT+"/app.mjs");if(typeof app.transform!=="function")throw Error("missing");',run,...(options.observe?{observe:options.observe}:{})}).map(([name,content])=>{const entry=path.join(tools,name+'.mjs');fs.writeFileSync(entry,content,{mode:0o600});return [name,{entry,argv:[]}];}));
 // This is a synthetic protocol Host. Its pinned configuration must not depend
 // on a developer's real login/configuration or require one on a clean runner.
 // Only this test's OS home lookup is mocked; no process/global env or user
 // configuration is overwritten. Production workers still verify exact pins.
 const fixtureHome=path.join(f.root,'host-fixture');fs.mkdirSync(path.join(fixtureHome,'.codex'),{recursive:true,mode:0o700});
 const configuration=path.join(fixtureHome,'.codex/config.toml');fs.writeFileSync(configuration,'# Synthetic protocol fixture; no model credentials.\n',{mode:0o600});t.mock.method(os,'homedir',()=>fixtureHome);
 const input={files:[{path:'specification.json',content:JSON.stringify({operation:'add',operand:3})}],tools:Object.values(stages).map(s=>({path:s.entry,digest:digest(s.entry)})),stages,...(options.state?{state:options.stateProfile??{kind:'fixed-hfs-v1',bytes:8388608}}:{}),codex:{executable,version:'0.163.0-alpha.10.2',model:'gpt-synthetic',effort:'low',configuration:{path:configuration,digest:digest(configuration)},policyFiles:[{path:policy,digest:digest(policy)}],disabledServers:[]}};
 const pins=describeCodexReconstruction(input),plan={...f.plan,...Object.fromEntries(['inputManifestDigest','environmentDigest','dependenciesDigest'].map(k=>[k,pins[k]])),executor:{id:options.state?CODEX_STATE_ADAPTER:CODEX_ADAPTER,version:input.codex.version,provider:'openai',model:input.codex.model,executableDigest:pins.executableDigest,configurationDigest:pins.configurationDigest}};
 const adapter=createCodexReconstructionAdapter({root,resolve:async()=>input,verify:async p=>({planDigest:hash(p),current:true})});f.close();Object.assign(f.providers,adapter);delete f.providers.observeReconstruction;f.open();const binding=await f.freeze(plan);
 return {...f,input,plan,binding,adapter,adapterRoot:root,directory:a=>path.join(root,a.claim.claimId.slice(7))};
}
test('T4-C01 protocol adapter retains IDs, actual isolated output, cumulative tokens and unknown cost',async t=>{
 const f=await fixture(t),a=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;assert.equal(a.status,'SUCCEEDED',JSON.stringify(a));
 assert.equal(a.receipt.usage.tokens,123);assert.equal(a.receipt.usage.costMicros,null);assert.equal(a.receipt.origin,'SYNTHETIC');
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory(a),'run.stdout'),'utf8')),{actual:5});
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory(a),'generation.turn.json'),'utf8')),{claimId:a.claim.claimId,threadId:'synthetic-thread',turnId:'synthetic-turn'});
 const b=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;assert.equal(b.status,'SUCCEEDED');assert.equal(b.claim.remaining.tokens,877);assert.notEqual(a.receipt.workspaceId,b.receipt.workspaceId);
 f.close();f.open();assert.deepEqual((await f.read('reconstruction.attempt',{id:a.id})).receipt,a.receipt);
 fs.appendFileSync(path.join(f.directory(a),'generation.events.jsonl'),'tampered');await assert.rejects(f.adapter.inspectReconstruction({claim:a.claim,signal:new AbortController().signal}),{code:'CODEX_TRACE_DRIFT'});
});
test('T4-C02 configuration and context drift reject before inference',async t=>{
 for(const mode of ['config-drift','permission-drift','context-drift']){const f=await fixture(t,mode),a=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;assert.equal(a.status,'FAILED',JSON.stringify(a));assert.equal(a.receipt.diagnostic,mode==='context-drift'?'CODEX_CONTEXT_UNREVIEWED':'CODEX_CONFIG_DRIFT');assert(!fs.existsSync(path.join(f.directory(a),'generation.turn.json')));}
});
test('T4-C03 unexpected tools, missing usage, invalid paths and overflowing output fail closed',async t=>{
 for(const [mode,code] of [['tool','CODEX_UNEXPECTED_TOOL'],['missing-usage','CODEX_RESULT_OR_USAGE_MISSING'],['path','CODEX_OUTPUT'],['stream','CODEX_STREAM_LIMIT'],['tokens','CODEX_TOKEN_LIMIT']]){
  const f=await fixture(t,mode),a=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;assert.equal(a.status,'FAILED',JSON.stringify(a));assert.equal(a.receipt.diagnostic,code);assert.equal(a.receipt.stages.build,'NOT_RUN');assert.equal(a.receipt.usage.tokens,null);
  await assert.rejects(f.write('reconstruction.dispatch',{planDigest:f.binding.digest}),{code:'RECONSTRUCTION_BUDGET_UNAVAILABLE'});
 }
});
test('T4-C04 cancelling the original process retains terminal receipt and never fabricates usage',async t=>{
 const f=await fixture(t,'hang'),request=await f.request('reconstruction.dispatch',{planDigest:f.binding.digest});f.close();const pending=f.open().reconstruction(request);let a;
 for(let n=0;n<200;n++){a=await f.read('reconstruction.attempt',{id:request.requestId}).catch(()=>null);if(a&&fs.existsSync(path.join(f.directory(a),'generation.turn.json')))break;await new Promise(r=>setTimeout(r,20));}
 assert(a&&fs.existsSync(path.join(f.directory(a),'generation.turn.json')));await f.write('reconstruction.cancel',{id:a.id});await pending;
 let final=await f.read('reconstruction.attempt',{id:a.id});for(let n=0;n<100&&final.status==='UNKNOWN';n++){await new Promise(r=>setTimeout(r,30));final=(await f.write('reconstruction.reconcile',{id:a.id})).attempt;}
 assert.equal(final.status,'CANCELLED');assert.equal(final.receipt.usage.tokens,null);assert.equal(final.receipt.usage.costMicros,null);assert.equal(final.claim.claimId,a.claim.claimId);
});
test('T4-C05 controller SIGKILL preserves surviving worker and original receipt without replay',async t=>{
 const f=await fixture(t,'success','process.stdout.write("entered\\n");await new Promise(r=>setTimeout(r,1200));'),request=await f.request('reconstruction.dispatch',{planDigest:f.binding.digest});f.close();
 const child=fork(new URL('../fixtures/reconstruction-codex-controller-v090.mjs',import.meta.url),[JSON.stringify({options:f.options,root:f.adapterRoot,input:f.input,request})],{stdio:['ignore','ignore','pipe','ipc']});t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});let dir;
 for(let n=0;n<250;n++){const names=fs.readdirSync(f.adapterRoot);dir=names.length?path.join(f.adapterRoot,names[0]):undefined;if(dir&&fs.existsSync(path.join(dir,'run.process.json')))break;await new Promise(r=>setTimeout(r,20));}
 assert(dir&&fs.existsSync(path.join(dir,'run.process.json')));child.kill('SIGKILL');await once(child,'exit');const reopened=f.open(),original=await f.read('reconstruction.attempt',{id:request.requestId});assert.equal(original.status,'RUNNING');
 for(let n=0;n<200&&!fs.existsSync(path.join(dir,'receipt.json'));n++)await new Promise(r=>setTimeout(r,25));
 const recovered=(await f.write('reconstruction.reconcile',{id:request.requestId})).attempt;assert.equal(recovered.status,'SUCCEEDED',JSON.stringify(recovered));assert.equal(recovered.claim.claimId,original.claim.claimId);
 await reopened.reconstruction(request);assert.equal(fs.readdirSync(f.adapterRoot).length,1);assert.equal(fs.readFileSync(path.join(dir,'run.stdout'),'utf8'),'entered\n');
});
test('T4-C06 executor SIGKILL retains failed original turn, unknown usage and blocks new budget',async t=>{
 const f=await fixture(t,'hang'),pending=f.write('reconstruction.dispatch',{planDigest:f.binding.digest});let dir;
 for(let n=0;n<200;n++){const names=fs.readdirSync(f.adapterRoot);dir=names.length?path.join(f.adapterRoot,names[0]):undefined;if(dir&&fs.existsSync(path.join(dir,'generation.turn.json')))break;await new Promise(r=>setTimeout(r,20));}
 assert(dir&&fs.existsSync(path.join(dir,'generation.turn.json')));const processRecord=JSON.parse(fs.readFileSync(path.join(dir,'generation.process.json'),'utf8'));process.kill(processRecord.pid,'SIGKILL');
 const a=(await pending).attempt;assert.equal(a.status,'FAILED');assert.equal(a.receipt.diagnostic,'CODEX_EXECUTOR_EXIT');assert.equal(a.receipt.usage.tokens,null);f.close();f.open();
 assert.equal((await f.write('reconstruction.reconcile',{id:a.id})).attempt.claim.claimId,a.claim.claimId);await assert.rejects(f.write('reconstruction.dispatch',{planDigest:f.binding.digest}),{code:'RECONSTRUCTION_BUDGET_UNAVAILABLE'});
 assert.equal(fs.readdirSync(f.adapterRoot).length,1);
});
const stateBuild='const app=await import(process.env.EVOPILOT_OUTPUT+"/app.mjs");const db=app.open(process.env.EVOPILOT_STATE_DIR);db.initialize();db.close();';
const stateRun='const app=await import(process.env.EVOPILOT_OUTPUT+"/app.mjs");const db=app.open(process.env.EVOPILOT_STATE_DIR);const before=db.value();db.advance();process.stdout.write(JSON.stringify({before,after:db.value()}));db.close();';
test('T4-C18 the reviewed 30-minute plan reaches actual state build/run/cleanup without a legacy ten-minute rejection',async t=>{
 const f=await fixture(t,'state',stateRun,{state:true,build:stateBuild,budget:{wallMs:1800000}});
 const a=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;
 assert.equal(a.status,'SUCCEEDED',JSON.stringify(a));
 assert.deepEqual(a.receipt.stages,{generation:'SUCCEEDED',build:'SUCCEEDED',run:'SUCCEEDED'});
 assert(a.claim.remaining.wallMs>600000);assert(a.receipt.usage.wallMs<600000);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory(a),'state.result.json'),'utf8')).cleanup,'CLOSED');
 assert.deepEqual(await f.adapter.inspectReconstruction({claim:a.claim,signal:new AbortController().signal}),a.receipt);
 closedState(f.directory(a));
});
async function waitFor(predicate){for(let n=0;n<600;n++){if(predicate())return;await new Promise(r=>setTimeout(r,25));}assert.fail('Timed out waiting for original process evidence');}
function closedState(dir){const s=JSON.parse(fs.readFileSync(path.join(dir,'state.storage.json'),'utf8'));assert.equal(s.events.at(-1).event,'CLOSED');assert.equal(fs.statSync(path.join(dir,'state.dmg')).size,s.events.at(-1).bytes);assert.equal(fs.statSync(s.mount).dev,fs.statSync(path.dirname(s.mount)).dev);return s;}
test('T4-C07 state profile is pinned separately; foreign, duplicate or reused device identities never authorize detach',async t=>{
 const f=await fixture(t,'state',stateRun,{state:true,build:stateBuild}),p=describeCodexReconstruction(f.input),{state,...readonly}=f.input;
 assert.notEqual(p.configurationDigest,describeCodexReconstruction(readonly).configurationDigest);
 assert.throws(()=>describeCodexReconstruction({...f.input,state:{...state,bytes:16777216}}),{code:'CODEX_STATE_PROFILE'});
 const owned={'image-path':'/owned/state.dmg',writeable:true,'system-entities':[{'dev-entry':'/dev/disk4','mount-point':'/owned/state'}]};
 assert.equal(ownedStateDevice([owned],'/owned/state.dmg','/owned/state'),'/dev/disk4');
 assert.equal(ownedStateDevice([],'/owned/state.dmg','/owned/state'),null);
 for(const images of [[owned,owned],[{...owned,'image-path':'/foreign.dmg'}],[{...owned,'system-entities':[{'dev-entry':'/dev/disk4','mount-point':'/foreign'}]}],[{...owned,'system-entities':[{'dev-entry':'/dev/disk4s1','mount-point':'/owned/state'}]}]])assert.throws(()=>ownedStateDevice(images,'/owned/state.dmg','/owned/state'),{code:'CODEX_STATE_IDENTITY'});
});
test('T4-C08 actual fixed volumes persist SQLite across build/run processes and start fresh for the second attempt',async t=>{
 const f=await fixture(t,'state',stateRun,{state:true,build:stateBuild}),receipts=[];
 for(let n=0;n<2;n++){
  const a=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;assert.equal(a.status,'SUCCEEDED',JSON.stringify(a));receipts.push(a);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory(a),'run.stdout'),'utf8')),{before:1,after:2});closedState(f.directory(a));
 }
 assert.notEqual(receipts[0].receipt.workspaceId,receipts[1].receipt.workspaceId);f.close();f.open();
 assert.deepEqual((await f.read('reconstruction.attempt',{id:receipts[0].id})).receipt,receipts[0].receipt);
 const file=path.join(f.directory(receipts[0]),'state.dmg'),fd=fs.openSync(file,'r+');fs.writeSync(fd,Buffer.from([255]),0,1,100);fs.closeSync(fd);
 await assert.rejects(f.adapter.inspectReconstruction({claim:receipts[0].claim,signal:new AbortController().signal}),{code:'CODEX_TRACE_DRIFT'});
});
test('T4-C09 writable state has a hard disk limit and cannot escape to host files, processes or networking',async t=>{
 const run=`import fs from 'node:fs';import path from 'node:path';import net from 'node:net';import {spawnSync} from 'node:child_process';
 const state=process.env.EVOPILOT_STATE_DIR,outside=path.resolve(state,'../../request.json'),denied=fn=>{try{fn();return false;}catch(e){return ['EPERM','EACCES'].includes(e.code);}};
 const checks={read:denied(()=>fs.readFileSync(outside)),write:denied(()=>fs.writeFileSync(path.resolve(state,'../escape'),'forbidden')),outputWrite:denied(()=>fs.writeFileSync(process.env.EVOPILOT_OUTPUT+'/app.mjs','changed'))};
 fs.symlinkSync(outside,state+'/link');checks.symlink=denied(()=>fs.readFileSync(state+'/link'));fs.unlinkSync(state+'/link');
 checks.process=spawnSync(process.execPath,['-e','process.exit(0)']).status!==0;
 checks.network=await new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port:9});s.on('error',e=>resolve(['EPERM','EACCES'].includes(e.code)));s.on('connect',()=>{s.destroy();resolve(false);});});
 let bytes=0,error=null;const fd=fs.openSync(state+'/fill','wx');try{for(let n=0;n<256;n++)bytes+=fs.writeSync(fd,Buffer.alloc(65536));}catch(e){error=e.code;}finally{fs.closeSync(fd);}process.stdout.write(JSON.stringify({checks,bytes,error}));`;
 const f=await fixture(t,'state',run,{state:true,build:stateBuild}),a=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;assert.equal(a.status,'SUCCEEDED',JSON.stringify(a));
 const output=JSON.parse(fs.readFileSync(path.join(f.directory(a),'run.stdout'),'utf8'));assert.deepEqual(output.checks,{read:true,write:true,outputWrite:true,symlink:true,process:true,network:true});assert.equal(output.error,'ENOSPC');assert(output.bytes<8388608&&output.bytes>0);closedState(f.directory(a));
});
test('T4-C10 cancellation kills the actual stateful stage and detaches before its terminal receipt',async t=>{
 const f=await fixture(t,'state','process.stdout.write("entered");setInterval(()=>{},1000);',{state:true,build:stateBuild}),pending=f.write('reconstruction.dispatch',{planDigest:f.binding.digest});let dir;
 await waitFor(()=>{const names=fs.readdirSync(f.adapterRoot);dir=names.length?path.join(f.adapterRoot,names[0]):null;return dir&&fs.existsSync(path.join(dir,'run.process.json'));});
 const request=JSON.parse(fs.readFileSync(path.join(dir,'request.json'),'utf8'));await f.write('reconstruction.cancel',{id:request.claim.attemptId});await pending;
 await waitFor(()=>fs.existsSync(path.join(dir,'receipt.json')));const a=(await f.write('reconstruction.reconcile',{id:request.claim.attemptId})).attempt;
 assert.equal(a.status,'CANCELLED',JSON.stringify(a));assert.equal(a.receipt.diagnostic,'CODEX_CANCELLED');assert.equal(a.receipt.usage.tokens,123);closedState(dir);
});
test('T4-C11 worker SIGKILL closes the live stage and volume but preserves UNKNOWN without a fabricated receipt',async t=>{
 const f=await fixture(t,'state','process.stdout.write("entered");setInterval(()=>{},1000);',{state:true,build:stateBuild}),request=await f.request('reconstruction.dispatch',{planDigest:f.binding.digest});f.close();
 const controller=fork(new URL('../fixtures/reconstruction-codex-controller-v090.mjs',import.meta.url),[JSON.stringify({options:f.options,root:f.adapterRoot,input:f.input,request})],{stdio:['ignore','ignore','pipe','ipc']});t.after(()=>{if(controller.exitCode===null)controller.kill('SIGKILL');});let dir;
 await waitFor(()=>{const names=fs.readdirSync(f.adapterRoot);dir=names.length?path.join(f.adapterRoot,names[0]):null;return dir&&fs.existsSync(path.join(dir,'run.process.json'));});
 const phase=JSON.parse(fs.readFileSync(path.join(dir,'state.phase.json'),'utf8'));process.kill(phase.workerPid,'SIGKILL');controller.kill('SIGKILL');await once(controller,'exit');
 await waitFor(()=>fs.existsSync(path.join(dir,'state.result.json')));closedState(dir);const phaseResult=JSON.parse(fs.readFileSync(path.join(dir,'state.result.json'),'utf8'));assert.equal(phaseResult.diagnostic,'CODEX_WORKER_LOST');assert(!fs.existsSync(path.join(dir,'receipt.json')));
 f.open();const a=(await f.write('reconstruction.reconcile',{id:request.requestId})).attempt;assert.equal(a.status,'UNKNOWN');assert.equal(a.receipt,null);
 await assert.rejects(f.write('reconstruction.dispatch',{planDigest:f.binding.digest}),{code:'RECONSTRUCTION_BUSY'});assert.equal(fs.readdirSync(f.adapterRoot).length,1);
});
test('T4-C12 stage SIGKILL retains failure only after the exact volume is closed',async t=>{
 const f=await fixture(t,'state','process.stdout.write("entered");setInterval(()=>{},1000);',{state:true,build:stateBuild}),pending=f.write('reconstruction.dispatch',{planDigest:f.binding.digest});let dir;
 await waitFor(()=>{const names=fs.readdirSync(f.adapterRoot);dir=names.length?path.join(f.adapterRoot,names[0]):null;return dir&&fs.existsSync(path.join(dir,'run.process.json'));});
 const record=JSON.parse(fs.readFileSync(path.join(dir,'run.process.json'),'utf8'));process.kill(record.pid,'SIGKILL');const a=(await pending).attempt;
 assert.equal(a.status,'FAILED',JSON.stringify(a));assert.equal(a.receipt.diagnostic,'CODEX_STAGE_FAILED');assert.equal(a.receipt.stages.build,'SUCCEEDED');assert.equal(a.receipt.stages.run,'FAILED');closedState(dir);
});
test('T4-C13 controller SIGKILL retains stateful worker results and exact replay does not remount',async t=>{
 const f=await fixture(t,'state','await new Promise(r=>setTimeout(r,1200));'+stateRun,{state:true,build:stateBuild}),request=await f.request('reconstruction.dispatch',{planDigest:f.binding.digest});f.close();
 const child=fork(new URL('../fixtures/reconstruction-codex-controller-v090.mjs',import.meta.url),[JSON.stringify({options:f.options,root:f.adapterRoot,input:f.input,request})],{stdio:['ignore','ignore','pipe','ipc']});t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});let dir;
 await waitFor(()=>{const names=fs.readdirSync(f.adapterRoot);dir=names.length?path.join(f.adapterRoot,names[0]):null;return dir&&fs.existsSync(path.join(dir,'run.process.json'));});
 child.kill('SIGKILL');await once(child,'exit');await waitFor(()=>fs.existsSync(path.join(dir,'receipt.json')));const reopened=f.open();
 const a=(await f.write('reconstruction.reconcile',{id:request.requestId})).attempt;assert.equal(a.status,'SUCCEEDED',JSON.stringify(a));closedState(dir);
 const before=digest(path.join(dir,'state.storage.json'));await reopened.reconstruction(request);assert.equal(digest(path.join(dir,'state.storage.json')),before);assert.equal(fs.readdirSync(f.adapterRoot).length,1);
});
test('T4-C14 stateful deadline stops the stage, retains cleanup time and cannot satisfy success',async t=>{
 const f=await fixture(t,'state','process.stdout.write("entered");setInterval(()=>{},1000);',{state:true,build:stateBuild,budget:{wallMs:8000}});
 const initial=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt,dir=f.directory(initial);await waitFor(()=>fs.existsSync(path.join(dir,'receipt.json')));
 const a=(await f.write('reconstruction.reconcile',{id:initial.id})).attempt;assert.equal(a.status,'FAILED',JSON.stringify(a));assert.equal(a.receipt.diagnostic,'CODEX_TIMEOUT');assert(a.receipt.usage.wallMs>=8000);closedState(dir);
 await assert.rejects(f.write('reconstruction.dispatch',{planDigest:f.binding.digest}),{code:'RECONSTRUCTION_BUDGET'});
});
async function seededInputs(t,bytes=8388608){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'evopilot-seed-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const seeds=[];
 for(let n=0;n<2;n++){
  const directory=path.join(root,'input-'+n);fs.mkdirSync(directory,{mode:0o700});fs.mkdirSync(path.join(directory,'work'),{mode:0o700});
  const storage=new CodexStorage(directory,hash('synthetic-seed-'+n),bytes);const mount=await storage.prepare();
  try{fs.writeFileSync(path.join(mount,'fixture.json'),JSON.stringify({value:17+n}),{mode:0o600});}finally{await storage.close();}
  seeds.push({image:{path:storage.image,digest:digest(storage.image)},mountPoint:mount});
 }
 return {kind:'fixed-hfs-v1',bytes,seeds};
}
test('T4-C15 pinned evaluation data uses fresh image copies and reserved mounts without entering generation context',async t=>{
 const profile=await seededInputs(t,67108864),run='import fs from "node:fs";'+stateRun+';const fixture=JSON.parse(fs.readFileSync(process.env.EVOPILOT_STATE_DIR+"/fixture.json","utf8"));process.stdout.write("\\n"+JSON.stringify(fixture));fs.writeFileSync(process.env.EVOPILOT_STATE_DIR+"/fixture.json","changed only in attempt");';
 const f=await fixture(t,'seeded',run,{state:true,stateProfile:profile,build:stateBuild,budget:{maxAttempts:2}});
 for(let n=0;n<2;n++){
  const a=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;assert.equal(a.status,'SUCCEEDED',JSON.stringify(a));
  const output=fs.readFileSync(path.join(f.directory(a),'run.stdout'),'utf8').split('\n').map(JSON.parse);assert.deepEqual(output,[{before:1,after:2},{value:17+n}]);
  const storage=closedState(f.directory(a));assert.equal(storage.mount,profile.seeds[n].mountPoint);assert.equal(storage.events[0].event,'SEED_COPY_INTENT');assert.equal(storage.events[0].seedDigest,profile.seeds[n].image.digest);
 }
 for(const seed of profile.seeds){assert.equal(digest(seed.image.path),seed.image.digest);assert.equal(fs.readdirSync(seed.mountPoint).length,0);}
});
test('T4-C16 changed seed bytes and occupied reserved mount points fail without changing the source or occupant',async t=>{
 const profile=await seededInputs(t),f=await fixture(t,'seeded',stateRun,{state:true,stateProfile:profile,build:stateBuild,budget:{maxAttempts:2}}),seed=profile.seeds[0];
 const bytes=fs.readFileSync(seed.image.path),changed=Buffer.from(bytes);changed[100]^=255;fs.writeFileSync(seed.image.path,changed);assert.throws(()=>describeCodexReconstruction(f.input),{code:'CODEX_STATE_SEED_PIN'});fs.writeFileSync(seed.image.path,bytes);
 const occupant=path.join(seed.mountPoint,'foreign');fs.writeFileSync(occupant,'preserve',{mode:0o600});
 const a=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;assert.equal(a.status,'FAILED',JSON.stringify(a));assert.equal(a.receipt.diagnostic,'CODEX_STATE_MOUNT_NOT_EMPTY');assert.equal(fs.readFileSync(occupant,'utf8'),'preserve');assert.equal(digest(seed.image.path),seed.image.digest);
});
test('T4-C17 a separate observer captures persisted bytes with no write or generated-code read permission',async t=>{
 const run=stateRun+';import fs from "node:fs";fs.writeFileSync(process.env.EVOPILOT_STATE_DIR+"/observed.json",JSON.stringify({retained:42}));';
 const observe='import fs from "node:fs";const file=process.env.EVOPILOT_STATE_DIR+"/observed.json",actual=JSON.parse(fs.readFileSync(file,"utf8")),denied=fn=>{try{fn();return false;}catch(e){return ["EPERM","EACCES"].includes(e.code);}};process.stdout.write(JSON.stringify({actual,writeDenied:denied(()=>fs.writeFileSync(file,"forged")),codeReadDenied:denied(()=>fs.readFileSync(process.env.EVOPILOT_OUTPUT+"/app.mjs"))}));';
 const f=await fixture(t,'state',run,{state:true,build:stateBuild,observe}),a=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;assert.equal(a.status,'SUCCEEDED',JSON.stringify(a));
 const dir=f.directory(a);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'observe.stdout'),'utf8')),{actual:{retained:42},writeDenied:true,codeReadDenied:true});closedState(dir);
 const runProcess=JSON.parse(fs.readFileSync(path.join(dir,'run.process.json'),'utf8')),observer=JSON.parse(fs.readFileSync(path.join(dir,'observe.process.json'),'utf8'));assert.notEqual(runProcess.pid,observer.pid);assert.notEqual(runProcess.profileDigest,observer.profileDigest);
 fs.appendFileSync(path.join(dir,'observe.stdout'),'tampered');await assert.rejects(f.adapter.inspectReconstruction({claim:a.claim,signal:new AbortController().signal}),{code:'CODEX_TRACE_DRIFT'});
});

test('T4-C21 a 60-minute reviewed plan reaches actual state build/run and verified cleanup',async t=>{
 const f=await fixture(t,'state',stateRun,{state:true,build:stateBuild,budget:{wallMs:3600000}});
 const a=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;
 assert.equal(a.status,'SUCCEEDED',JSON.stringify(a));assert.equal(a.claim.remaining.wallMs,3600000);
 assert.deepEqual(a.receipt.stages,{generation:'SUCCEEDED',build:'SUCCEEDED',run:'SUCCEEDED'});
 closedState(f.directory(a));assert.deepEqual(await f.adapter.inspectReconstruction({claim:a.claim,signal:new AbortController().signal}),a.receipt);
});
