// Original adapter mechanics with synthetic specifications and decisions; not project L3 acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {createLocalReconstructionAdapter,describeLocalReconstruction} from '@evopilot-next/runtime/reconstruction-adapters';
import {nativeBytesDigest} from '../../vendor/compatibility/v1/native.mjs';
import {reconstructionFixture,hash} from '../fixtures/reconstruction.mjs';
// These are synthetic generators and plans, executed in real macOS sandbox processes.
// Their results demonstrate adapter mechanics, not a real project or L3 acceptance.
const generate=`import fs from 'node:fs';
const spec=JSON.parse(JSON.parse(fs.readFileSync(process.env.EVOPILOT_SPECIFICATION,'utf8')).files[0].content);
if(spec.operation!=='add'||!Number.isFinite(spec.operand))throw Error('unsupported specification');
const code='export const transform = value => value + '+JSON.stringify(spec.operand)+';';
process.stdout.write(JSON.stringify({files:[{path:'app.mjs',content:code}],usage:{tokens:0,costMicros:0,iterations:1}}));`;
const build=`const app=await import(process.env.EVOPILOT_OUTPUT+'/app.mjs');if(typeof app.transform!=='function')throw Error('missing implementation');process.stdout.write('build ok');`;
const run=`const app=await import(process.env.EVOPILOT_OUTPUT+'/app.mjs');process.stdout.write(JSON.stringify({actual:app.transform(2)}));`;
async function local(t,{generator=generate,runner=run,budget={}}={}){
 const f=await reconstructionFixture(t,{prepare:false,budget:{wallMs:10000,maxTokens:0,maxCostMicros:0,maxOutputBytes:65536,...budget}});
 const root=path.join(f.root,'builder'),toolRoot=path.join(f.root,'tools');fs.mkdirSync(root,{mode:0o700});fs.mkdirSync(toolRoot,{mode:0o700});
 const stages=Object.fromEntries(Object.entries({generation:generator,build,run:runner}).map(([name,content])=>{const entry=path.join(toolRoot,name+'.mjs');fs.writeFileSync(entry,content,{mode:0o600});return [name,{entry,argv:[]}];}));
 const input={files:[{path:'specification.json',content:JSON.stringify({operation:'add',operand:3})}],tools:Object.values(stages).map(s=>({path:s.entry,digest:nativeBytesDigest(fs.readFileSync(s.entry))})),stages};
 const pins=describeLocalReconstruction(input),plan={...f.plan,...Object.fromEntries(['inputManifestDigest','environmentDigest','dependenciesDigest'].map(k=>[k,pins[k]])),executor:{id:'seatbelt-node-v1',version:'1',executableDigest:pins.executableDigest,configurationDigest:pins.configurationDigest,provider:'local-offline',model:'none'}};
 const adapter=createLocalReconstructionAdapter({root,resolve:async()=>input,verify:async p=>({planDigest:hash(p),current:true})});
 f.close();Object.assign(f.providers,adapter);delete f.providers.observeReconstruction;f.open();
 const binding=await f.freeze(plan);return {...f,plan,binding,adapter,input,root,directory:a=>path.join(root,a.claim.claimId.slice(7))};
}
test('T4-A01 real isolated generation, module build and execution run twice in fresh directories',async t=>{
 const f=await local(t),a=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;
 assert.equal(a.status,'SUCCEEDED',JSON.stringify(a));assert.equal(a.receipt.origin,'SYNTHETIC');
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory(a),'run.stdout'),'utf8')),{actual:5});
 const b=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;assert.equal(b.status,'SUCCEEDED');assert.notEqual(a.receipt.workspaceId,b.receipt.workspaceId);
 f.close();f.open();assert.deepEqual((await f.read('reconstruction.attempt',{id:a.id})).receipt,a.receipt);
 fs.appendFileSync(path.join(f.directory(b),'run.stdout'),'tampered trace');await assert.rejects(f.adapter.inspectReconstruction({claim:b.claim,signal:new AbortController().signal}),{code:'BUILDER_TRACE_DRIFT'});
 await assert.rejects(f.read('reconstruction.evidence',{id:a.id}),{code:'RECONSTRUCTION_UNSUPPORTED'});
 const p=path.join(f.directory(a),'work/output/app.mjs');fs.appendFileSync(p,'\n// changed');await assert.rejects(f.adapter.inspectReconstruction({claim:a.claim,signal:new AbortController().signal}),{code:'BUILDER_OUTPUT_DRIFT'});
});
test('T4-A02 sandbox denies source, oracle, previous outputs, credentials, writes, network and child delegation',async t=>{
 const secretRoot=fs.mkdtempSync('/private/tmp/evopilot-denied-');t.after(()=>fs.rmSync(secretRoot,{recursive:true,force:true}));
 const denied=['original-source','hidden-oracle','previous-output','credentials'].map(n=>path.join(secretRoot,n));denied.forEach(p=>fs.writeFileSync(p,'private synthetic sentinel',{mode:0o600}));
 const attack=`import fs from 'node:fs';import net from 'node:net';import {spawnSync} from 'node:child_process';
const denied=${JSON.stringify(denied)};const results=denied.map(p=>{try{fs.readFileSync(p);return false;}catch{return true;}});
try{fs.writeFileSync(process.env.HOME+'/oversize','no');results.push(false);}catch{results.push(true);}
const fork=spawnSync(process.execPath,['-e','process.stdout.write("delegated")']);results.push(fork.status!==0);
const network=await new Promise(r=>{const socket=net.connect({host:'127.0.0.1',port:9});socket.on('error',e=>r(['EPERM','EACCES'].includes(e.code)));socket.on('connect',()=>{socket.destroy();r(false);});});results.push(network);
if(results.some(x=>!x))throw Error(JSON.stringify(results));
process.stdout.write(JSON.stringify({files:[{path:'app.mjs',content:'export const transform = x => x+3;'}],usage:{tokens:0,costMicros:0,iterations:1}}));`;
 const f=await local(t,{generator:attack}),a=(await f.write('reconstruction.dispatch',{planDigest:f.binding.digest})).attempt;assert.equal(a.status,'SUCCEEDED',JSON.stringify(a));
});
test('T4-A03 builder cannot fabricate stages or emit unlimited files; stderr and failure survive',async t=>{
 const bad=await local(t,{generator:'process.stdout.write(JSON.stringify({files:[],usage:{tokens:0,costMicros:0,iterations:1}}));'});
 const a=(await bad.write('reconstruction.dispatch',{planDigest:bad.binding.digest})).attempt;assert.equal(a.status,'FAILED');assert.equal(a.receipt.stages.build,'NOT_RUN');assert.equal(a.receipt.diagnostic,'BUILDER_GENERATION_FORMAT');
 const huge=await local(t,{generator:'process.stdout.write("x".repeat(100000));',budget:{maxOutputBytes:1024}});
 const b=(await huge.write('reconstruction.dispatch',{planDigest:huge.binding.digest})).attempt;assert.equal(b.status,'FAILED');assert.equal(b.receipt.diagnostic,'BUILDER_STREAM_LIMIT');assert(fs.statSync(path.join(huge.directory(b),'generation.stdout')).size<=1024);
});
test('T4-A04 adapter cancellation retains its actual terminal receipt for recovery',async t=>{
 const f=await local(t,{runner:'await new Promise(r=>setTimeout(r,10000));'}),request=await f.request('reconstruction.dispatch',{planDigest:f.binding.digest});
 f.close();const pending=f.open().reconstruction(request);
 let a;for(let n=0;n<100;n++){a=await f.read('reconstruction.attempt',{id:request.requestId}).catch(()=>null);if(a&&fs.existsSync(path.join(f.directory(a),'run.process.json')))break;await new Promise(r=>setTimeout(r,20));}
 assert(a);await f.write('reconstruction.cancel',{id:a.id});await pending;
 let final=await f.read('reconstruction.attempt',{id:a.id});for(let n=0;n<30&&final.status==='UNKNOWN';n++){await new Promise(r=>setTimeout(r,30));final=(await f.write('reconstruction.reconcile',{id:a.id})).attempt;}
 assert.equal(final.status,'CANCELLED');assert.equal(final.receipt.status,'CANCELLED');
});
test('T4-A06 actual worker survives Runtime SIGKILL; reopen reconciles its original protected output',async t=>{
 const f=await local(t,{runner:run+'\nawait new Promise(r=>setTimeout(r,1200));'}),request=await f.request('reconstruction.dispatch',{planDigest:f.binding.digest});f.close();
 const child=fork(new URL('../fixtures/reconstruction-runner-v090.mjs',import.meta.url),[JSON.stringify({options:f.options,root:f.root,input:f.input,request})],{stdio:['ignore','ignore','pipe','ipc']});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});let dir;
 for(let n=0;n<150;n++){const names=fs.readdirSync(f.root);dir=names.length?path.join(f.root,names[0]):undefined;if(dir&&fs.existsSync(path.join(dir,'run.process.json')))break;await new Promise(r=>setTimeout(r,20));}
 assert(dir&&fs.existsSync(path.join(dir,'run.process.json')));child.kill('SIGKILL');await once(child,'exit');const reopened=f.open();
 const original=await f.read('reconstruction.attempt',{id:request.requestId});assert.equal(original.status,'RUNNING');
 for(let n=0;n<100&&!fs.existsSync(path.join(dir,'receipt.json'));n++)await new Promise(r=>setTimeout(r,25));
 const recovered=await f.write('reconstruction.reconcile',{id:request.requestId});assert.equal(recovered.attempt.status,'SUCCEEDED',JSON.stringify(recovered));assert.equal(recovered.attempt.claim.claimId,original.claim.claimId);
 await reopened.reconstruction(request);assert.equal(fs.readdirSync(f.root).length,1);
});
