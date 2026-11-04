// Synthetic retained selections. These tests exercise local ownership boundaries;
// actual published-owner scheduling is verified by an installed-package probe.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {canonical,digest} from '../../dist/server/errors.js';
import {selectOnlineWorker,validateOnlineWorkerSelection,requireCurrentOnlineWorkerSelection} from '../../dist/installation/online/selection.js';
import {onlineWorkerRoot,onlineWorkerLabel,readOnlineWorkerOwner,inspectOnlineWorker,startOnlineWorker,stopOnlineWorker,onlineWorkerCommand,writeOnlineStatus} from '../../dist/installation/online/lifecycle.js';
import {runOnlineWorker} from '../../dist/installation/online/worker.js';
import {installerMain} from '../../dist/installation/installer.js';

const execute=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex'),pin='a'.repeat(64);
const seal=body=>({...body,selectionDigest:digest(body)}),write=(p,v)=>{fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});fs.writeFileSync(p,typeof v==='string'?v:canonical(v)+'\n',{mode:0o600});};
function fixture(t){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'runtime-online-worker-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const binding={workspaceRoot:path.join(root,'workspace'),workspaceId:'synthetic',serviceId:'synthetic-service',migrationDigest:pin};
 const installation=seal({schema:'runtime-installed-service-selection/v1',serviceRoot:path.join(root,'service'),serviceId:binding.serviceId,workspaceId:binding.workspaceId,installationPlanDigest:pin,distributionManifestDigest:pin,specificationDigest:pin,connectionDigest:pin,configurationPins:{},binding,authority:false});
 const selection=seal({schema:'runtime-online-worker-selection/v1',installation,configuration:{ref:path.join(root,'online.json'),digest:pin},hosts:[{connectionRef:path.join(root,'connection.json'),ownerConfigRef:path.join(root,'owner-host.json'),ownerConfigDigest:pin,projectId:'synthetic',connectionDigest:pin,credentialDigest:pin}],authority:false,workerStarted:false});
 return{root,selection};
}
function retained(selection){
 const root=onlineWorkerRoot(selection),nonce=randomUUID(),attempt=path.join(root,'attempts',nonce),plist='<!-- synthetic, never launched -->\n';
 write(path.join(attempt,'job.plist'),plist);
 const body={schema:'runtime-online-worker-owner/v1',selection,nodeExecutable:fs.realpathSync(process.execPath),nodeSha256:sha(fs.readFileSync(process.execPath)),entry:path.join(selection.installation.serviceRoot,'package/dist/installation/online/worker.js'),nonce,plistDigest:sha(plist)},owner={...body,ownerDigest:digest(body)};
 write(path.join(attempt,'owner.json'),owner);write(path.join(root,'runtime-owner.json'),owner);
 return{owner,attempt,root};
}

test('retained selection validates without live credentials but never starts a missing installation',async t=>{
 const f=fixture(t);validateOnlineWorkerSelection(f.selection);assert.throws(()=>requireCurrentOnlineWorkerSelection(f.selection));
 await assert.rejects(startOnlineWorker(f.selection));assert(!fs.existsSync(onlineWorkerRoot(f.selection)));assert.deepEqual(fs.readdirSync(f.root),[]);
});

test('worker selections reject authority changes, changed pins, duplicate projects and malformed nested installation',t=>{
 const f=fixture(t),resign=s=>{delete s.selectionDigest;return seal(s);};
 for(const change of [s=>s.authority=true,s=>s.workerStarted=true,s=>s.hosts.push({...s.hosts[0]}),s=>s.configuration.ref='relative',s=>s.hosts[0].credentialDigest='missing',s=>s.installation.binding.workspaceId='other']){
  const s=structuredClone(f.selection);change(s);assert.throws(()=>validateOnlineWorkerSelection(resign(s)));
 }
 const s=structuredClone(f.selection);s.installation.schema='foreign';delete s.installation.selectionDigest;s.installation=seal(s.installation);assert.throws(()=>validateOnlineWorkerSelection(resign(s)),{code:'ONLINE_WORKER_SELECTION'});
 const changed=structuredClone(f.selection);changed.hosts[0].projectId='different';assert.throws(()=>validateOnlineWorkerSelection(changed),{code:'ONLINE_WORKER_SELECTION'});
});

test('worker selection requires explicit bounded project connections before accessing an installation',t=>{
 const f=fixture(t),input={serviceRoot:f.selection.installation.serviceRoot,configuration:f.selection.configuration,hosts:[]};
 write(input.configuration.ref,{});
 for(const hosts of [[],null,Array(65).fill({})])assert.throws(()=>selectOnlineWorker({...input,hosts}),{code:'ONLINE_WORKER_SELECTION'});
 assert(!fs.existsSync(input.serviceRoot));
});

test('owner identity keeps immutable attempts and rejects altered job bytes or manual source execution',async t=>{
 const f=fixture(t),r=retained(f.selection),ref=path.join(r.attempt,'owner.json');assert.deepEqual(readOnlineWorkerOwner(ref),r.owner);
 assert.deepEqual(readOnlineWorkerOwner(path.join(r.root,'runtime-owner.json')),r.owner);
 await assert.rejects(runOnlineWorker(ref,r.owner.nonce),{code:'ONLINE_WORKER_IDENTITY'});
 fs.appendFileSync(path.join(r.attempt,'job.plist'),'changed');assert.throws(()=>readOnlineWorkerOwner(ref),{code:'ONLINE_WORKER_OWNER'});
 assert(!fs.existsSync(path.join(r.root,'runtime-worker-lock.sqlite')));
});

test('passive inspection and stop preserve stale identity and never initialize replacement configuration',async t=>{
 const f=fixture(t),r=retained(f.selection),statusRef=path.join(r.root,'runtime-status.json');writeOnlineStatus(statusRef,{nonce:'old',selectionDigest:pin,state:'READY',pid:process.pid,heartbeatAt:Date.now()});
 if(process.platform!=='darwin'){await assert.rejects(inspectOnlineWorker(f.selection),{code:'ONLINE_SUPERVISOR_UNSUPPORTED'});return;}
 const before=fs.readFileSync(path.join(r.root,'runtime-owner.json')),status=await inspectOnlineWorker(f.selection);
 assert.equal(status.registered,false);assert.equal(status.configurationCurrent,false);assert.equal(status.statusCurrent,false);assert.equal(status.ready,false);
 const stopped=await stopOnlineWorker(f.selection,true);assert.equal(stopped.registered,false);assert.equal(stopped.evidencePreserved,true);assert.deepEqual(fs.readFileSync(path.join(r.root,'runtime-owner.json')),before);
 assert(!fs.existsSync(f.selection.installation.serviceRoot));assert(fs.existsSync(statusRef));
});

test('foreign live launchd label is refused without signaling its process',async t=>{
 const f=fixture(t);if(process.platform!=='darwin'){await assert.rejects(inspectOnlineWorker(f.selection),{code:'ONLINE_SUPERVISOR_UNSUPPORTED'});return;}
 const label=onlineWorkerLabel(f.selection),target='gui/'+process.getuid()+'/'+label,ref=path.join(f.root,'foreign.plist');
 write(ref,'<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>'+label+'</string><key>ProgramArguments</key><array><string>/bin/sleep</string><string>120</string></array><key>RunAtLoad</key><true/></dict></plist>');
 await execute('/bin/launchctl',['bootstrap','gui/'+process.getuid(),ref]);
 try{
  const before=(await execute('/bin/launchctl',['print',target])).stdout;
  await assert.rejects(inspectOnlineWorker(f.selection),{code:'ONLINE_WORKER_NOT_OWNED'});await assert.rejects(stopOnlineWorker(f.selection),{code:'ONLINE_WORKER_NOT_OWNED'});
  assert((await execute('/bin/launchctl',['print',target])).stdout.includes('path = '+ref));assert(before.includes('/bin/sleep'));assert(!fs.existsSync(onlineWorkerRoot(f.selection)));
 }finally{await execute('/bin/launchctl',['bootout',target]);}
});

test('explicit installer worker entry validates descriptors and protects stop after expiration',async t=>{
 const f=fixture(t),ref=path.join(f.root,'selection.json');write(ref,f.selection);const out=[];
 for(const args of [['start','--root',f.root],['inspect','--selection-ref',ref,'extra'],['run','--selection-ref',ref]])await assert.rejects(onlineWorkerCommand(args),{code:'ONLINE_WORKER_ARGUMENTS'});
 if(process.platform==='darwin'){
  assert.equal(await installerMain(['online-worker','inspect','--selection-ref',ref],{write:v=>out.push(v)}),0);const result=JSON.parse(out.pop());assert.equal(result.ready,false);assert.equal(result.configurationCurrent,false);
 }
 fs.chmodSync(ref,0o644);await assert.rejects(onlineWorkerCommand(['stop','--selection-ref',ref]),{code:'UNSAFE_STATE'});
});
