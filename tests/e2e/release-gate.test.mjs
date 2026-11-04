// Synthetic transport/archive fixtures only. No GitHub calls, publication or
// real authentication occur in these adapter regressions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {crc32,deflateRawSync} from 'node:zlib';
import {parse as parseYaml} from 'yaml';
import {repository,repositoryId,assetNames,sha256,validatePreparation,readReleaseZip,validateDistributionFiles,decodeGitHubResponse,requireAbsent,gitHubRequest,prepareCiDistribution,publishReviewedRuntime,validateReleaseReadback,validateAssetList,main} from '../../scripts/release-gate.mjs';

function zip(entries){
 const local=[],central=[];let offset=0;
 for(const e of entries){const name=Buffer.from(e.name),bytes=Buffer.from(e.bytes),method=e.method??(e.deflate?8:0),data=e.deflate?deflateRawSync(bytes):bytes,crc=e.crc??crc32(bytes),size=e.size??bytes.length,flags=e.flags??0x800,l=Buffer.alloc(30),c=Buffer.alloc(46);
  l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt16LE(flags,6);l.writeUInt16LE(method,8);l.writeUInt32LE(crc,14);l.writeUInt32LE(data.length,18);l.writeUInt32LE(size,22);l.writeUInt16LE(name.length,26);
  c.writeUInt32LE(0x02014b50);c.writeUInt16LE(0x314,4);c.writeUInt16LE(20,6);c.writeUInt16LE(flags,8);c.writeUInt16LE(method,10);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(size,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(e.attributes??((0o100644<<16)>>>0),38);c.writeUInt32LE(offset,42);
  local.push(l,name,data);central.push(c,name);offset+=l.length+name.length+data.length;
 }
 const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,cd,end]);
}
function materials(commit='a'.repeat(40),lock=Buffer.from(JSON.stringify({name:'@evopilot-next/runtime',version:'0.9.0',lockfileVersion:3}))){
 const archive=Buffer.from('Synthetic standalone archive, not installable software.');
 const files=new Map([['distribution-manifest.json',Buffer.from(JSON.stringify({schema:'runtime-standalone-distribution/v1',version:'0.9.0',archiveDigest:sha256(archive),files:{'package.json':{type:'file',sha256:sha256('{}'),bytes:2,mode:420}}}))],['evopilot-next-runtime-0.9.0.tgz',Buffer.from('Synthetic SDK')],['evopilot-runtime-0.9.0-darwin-arm64.tar.gz',archive],['runtime-dependency-lock.json',lock],['source-revision.txt',Buffer.from(commit+'\n')]]);
 files.set('SHA256SUMS',Buffer.from([...files].map(([n,b])=>sha256(b)+'  '+n+'\n').join('')));return files;
}
const entries=files=>[...files].map(([name,bytes])=>({name,bytes}));
const response=(value,status=200)=>({status,transport:'HTTP',body:Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value))});
function fixture(t){
 const root=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'runtime-release-adapter-')),source=join(root,'source');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(source);
 const pkg={name:'@evopilot-next/runtime',version:'0.9.0'},lock=Buffer.from(JSON.stringify({...pkg,lockfileVersion:3}));fs.writeFileSync(join(source,'package.json'),JSON.stringify(pkg));fs.writeFileSync(join(source,'package-lock.json'),lock);
 const git=args=>execFileSync('/usr/bin/git',['-c','core.fsmonitor=false','-C',source,...args],{env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},stdio:['ignore','pipe','pipe']}).toString();git(['init','--quiet']);git(['add','.']);git(['-c','user.name=Synthetic fixture','-c','user.email=synthetic@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','Synthetic adapter fixture']);const sourceCommit=git(['rev-parse','HEAD']).trim();
 const files=materials(sourceCommit,lock),archive=zip(entries(files)),input={repository,repositoryRoot:source,sourceCommit,sourceRunId:'12',artifactDigest:sha256(archive),outputRoot:join(root,'prepared')},repo={id:repositoryId,full_name:repository},run={id:12,run_attempt:1,repository:repo,head_repository:repo,head_sha:sourceCommit,path:'.github/workflows/ci.yml',status:'completed',conclusion:'success',event:'push'},job={id:45,name:'source',run_id:12,run_attempt:1,head_sha:sourceCommit,status:'completed',conclusion:'success'};
 const artifact={id:23,name:`evopilot-runtime-${sourceCommit}-package`,expired:false,expires_at:new Date(Date.now()+86400000).toISOString(),digest:'sha256:'+input.artifactDigest,size_in_bytes:archive.length,workflow_run:{id:12,head_sha:sourceCommit,repository_id:repositoryId,head_repository_id:repositoryId}};
 const base='repos/'+repository,values=new Map([[base+'/actions/runs/12',run],[base+'/actions/runs/12/attempts/1/jobs?per_page=100',{total_count:1,jobs:[job]}],[base+'/actions/runs/12/artifacts?per_page=100',{total_count:1,artifacts:[artifact]}],[base+'/actions/artifacts/23',artifact],[base+'/actions/artifacts/23/zip',archive],[base+'/actions/jobs/45/logs',Buffer.from('Synthetic provider log; not original CI acceptance.\n')]]),calls=[];
 const github=async(method,endpoint)=>{calls.push({method,endpoint});assert.equal(method,'GET','Preparation must never mutate GitHub');assert(values.has(endpoint));return response(values.get(endpoint));};
 return{root,source,input,files,values,calls,github,run,artifact,prepare:()=>prepareCiDistribution(input,{github})};
}

test('Runtime preparation accepts only one repository, exact source/run/ZIP identity and no authority flags',()=>{
 const input={repository,repositoryRoot:'/synthetic',sourceCommit:'a'.repeat(40),sourceRunId:'12',artifactDigest:'b'.repeat(64),outputRoot:'/synthetic-output'};validatePreparation(input);
 for(const mutate of [v=>v.repository='yeliang-wang/evopilot',v=>v.repository='yeliang-wang/evopilot-harness',v=>v.repository='yeliang-wang/evopilot-ontology',v=>v.sourceCommit+='\n',v=>v.sourceRunId='01',v=>v.sourceRunId='99999999999999999999',v=>v.artifactDigest+='\n',v=>v.publish=true,v=>v.decisionRef='nonempty-does-not-authorize']){const v=structuredClone(input);mutate(v);assert.throws(()=>validatePreparation(v));}
});
test('ZIP retains the six original stored or deflated entries without normalizing bytes',async()=>{
 const files=materials();for(const deflate of [false,true]){const actual=await readReleaseZip(zip(entries(files).map(e=>({...e,deflate}))));assert.deepEqual(actual,files);assert.equal(validateDistributionFiles(actual,'a'.repeat(40)).version,'0.9.0');}
});
test('ZIP traversal, duplicate/colliding names, links, encryption and unsupported compression are rejected',async()=>{
 for(const mutate of [e=>e[0].name='../escape',e=>e[0].name='private.json',e=>e[0].name=e[1].name,e=>e[0].name=e[1].name.toUpperCase(),e=>e[0].attributes=(0o120777<<16)>>>0,e=>e[0].attributes=16,e=>e[0].flags|=1,e=>e[0].method=99,e=>e.push({...e[0]}),e=>e.pop()]){const e=entries(materials());mutate(e);await assert.rejects(()=>readReleaseZip(zip(e)));}
});
test('ZIP size/CRC/truncation/expansion and compression bombs fail before any file extraction',async()=>{
 for(const mutate of [e=>e[0].crc=0,e=>e[0].size=257*1024*1024,e=>{e[0].bytes=Buffer.alloc(2*1024*1024);e[0].deflate=true;}]){const e=entries(materials());mutate(e);await assert.rejects(()=>readReleaseZip(zip(e)));}
 const archive=zip(entries(materials()));await assert.rejects(()=>readReleaseZip(archive.subarray(0,-2)));await assert.rejects(()=>readReleaseZip(Buffer.alloc(21)));const controller=new AbortController();controller.abort();await assert.rejects(()=>readReleaseZip(archive,controller.signal));
});
test('exact checksums and source identity cannot be regenerated to hide altered original assets',()=>{
 const files=materials(),commit='a'.repeat(40);validateDistributionFiles(files,commit);
 for(const mutate of [m=>m.set('evopilot-next-runtime-0.9.0.tgz',Buffer.from('changed')),m=>m.set('SHA256SUMS',Buffer.from('')),m=>m.delete('source-revision.txt'),m=>m.set('private-evidence.json',Buffer.from('{}'))]){const m=new Map(files);mutate(m);assert.throws(()=>validateDistributionFiles(m,commit));}assert.throws(()=>validateDistributionFiles(files,'b'.repeat(40)));
});
test('HTTP parser retains only bounded final bodies and does not turn timeouts or uncertain status into 404',()=>{
 const raw=(stdout,status=0)=>({stdout:Buffer.from(stdout),status,stderr:Buffer.from('secret stderr must not be retained')});
 const r=decodeGitHubResponse(raw('HTTP/2.0 200 OK\r\nAuthorization: secret\r\nLocation: signed-secret\r\n\r\n{"ok":true}'),100);assert.equal(r.status,200);assert.equal(r.body.toString(),'{"ok":true}');assert(!JSON.stringify(r).includes('secret'));
 assert.equal(decodeGitHubResponse(raw('HTTP/2.0 302 Found\nLocation: hidden\n\nHTTP/2.0 200 OK\n\nbytes'),100).body.toString(),'bytes');
 const absent=decodeGitHubResponse(raw('HTTP/2.0 404 Not Found\n\n{}',1),100);requireAbsent(absent);
 for(const value of [decodeGitHubResponse(raw('HTTP/2.0 404 Not Found\n\n{}',0),100),decodeGitHubResponse({...raw('HTTP/2.0 404 Not Found\n\n{}',1),error:Error('private')},100),decodeGitHubResponse(raw('unframed body',1),100),decodeGitHubResponse(raw('HTTP/2.0 200 OK\n\n12345'),4),{status:403,transport:'HTTP'},{status:500,transport:'HTTP'},{status:200,transport:'HTTP'},{status:404,transport:'UNKNOWN'}])assert.throws(()=>requireAbsent(value),/INSPECT_EXISTING/);
});
test('GitHub scope and header validation reject foreign paths before spawning a process',()=>{
 for(const endpoint of ['repos/yeliang-wang/evopilot/git/refs','repos/'+repository+'/../evopilot-harness','repos/'+repository+'/%2e%2e','repos/'+repository+'/bad\nheader','https://example.invalid/assets'])assert.throws(()=>gitHubRequest('GET',endpoint),/GITHUB_SCOPE/);
 assert.throws(()=>gitHubRequest('GET','repos/'+repository,{accept:'secret\nheader'}),/GITHUB_SCOPE/);
});
test('actual preparation adapter is read-only, preserves all six bytes and keeps evidence outside public assets',async t=>{
 const f=fixture(t),result=await f.prepare();assert.equal(result.status,'PACKAGE_STAGED_ONLY');assert.equal(result.releaseAuthorized,false);assert.equal(result.productAcceptance,'NOT_EVALUATED');assert.equal(result.fullLocalPreflightRequired,true);assert.equal(f.calls.length,6);assert(f.calls.every(c=>c.method==='GET'));
 const assets=join(f.input.outputRoot,'assets');assert.deepEqual(fs.readdirSync(assets).sort(),[...assetNames].sort());for(const name of assetNames){assert.deepEqual(fs.readFileSync(join(assets,name)),f.files.get(name));assert.equal(fs.statSync(join(assets,name)).mode&0o777,0o600);}
 const selected=JSON.parse(fs.readFileSync(join(f.input.outputRoot,'candidate-input.json')));assert.equal(selected.schema,'runtime-release-candidate-input/v1');assert.equal(selected.sourceCommit,f.input.sourceCommit);assert.equal(selected.sourceCi.artifactZip.sha256,f.input.artifactDigest);assert(selected.sourceCi.run.ref.includes('/source-ci/'));assert(!JSON.stringify(result).includes(f.root));
 await assert.rejects(f.prepare);assert.equal(f.calls.length,6,'Occupied outputs never start an automatic retry');
});
test('foreign/failed CI and ambiguous or changed artifacts stop preparation and retain safe failure evidence',async t=>{
 for(const mutate of [f=>f.run.repository={id:1,full_name:'foreign/repo'},f=>f.run.conclusion='failure',f=>f.artifact.digest='sha256:'+'0'.repeat(64),f=>f.values.get('repos/'+repository+'/actions/runs/12/artifacts?per_page=100').total_count=2]){const f=fixture(t);mutate(f);await assert.rejects(f.prepare);const failure=JSON.parse(fs.readFileSync(join(f.input.outputRoot,'failure.json')));assert.equal(failure.automaticRetry,false);assert.equal(failure.evidenceRetained,true);assert(!fs.existsSync(join(f.input.outputRoot,'candidate-input.json')));}
});
test('a transport exception is retained as unknown once with no secret exception text and no automatic retry',async t=>{
 const f=fixture(t);let calls=0;await assert.rejects(()=>prepareCiDistribution(f.input,{github:async()=>{calls++;throw Error('a private credential in transport stderr');}}),/GITHUB_OUTCOME_UNKNOWN/);assert.equal(calls,1);
 const evidence=join(f.input.outputRoot,'source-ci');const retained=fs.readdirSync(evidence).map(n=>fs.readFileSync(join(evidence,n)).toString()).join('\n');assert(!retained.includes('private credential'));assert(retained.includes('UNKNOWN'));
});
test('publication metadata readback binds exact notes/title/tag and refuses a draft as published',()=>{
 const publication={tag:'v0.9.0',title:'EvoPilot Runtime 0.9.0 Preview'},notes='# Exact notes\r\n',r={id:23,tag_name:publication.tag,name:publication.title,body:notes,prerelease:true,draft:false,published_at:new Date().toISOString(),html_url:`https://github.com/${repository}/releases/tag/v0.9.0`};assert.equal(validateReleaseReadback(r,publication,notes,false),23);
 for(const change of [{body:notes.replaceAll('\r','')},{name:'other'},{tag_name:'v0.8.3'},{draft:true},{prerelease:false},{html_url:'https://example.invalid/release'},{id:0},{published_at:null}])assert.throws(()=>validateReleaseReadback({...r,...change},publication,notes,false));
});
test('release asset readback requires the six exact unique identities regardless of provider ordering',()=>{
 const files=materials(),pins=Object.fromEntries([...files].map(([name,b])=>[name,{sha256:sha256(b),bytes:b.length}])),assets=[...files].map(([name,b],i)=>({id:i+1,name,state:'uploaded',size:b.length,digest:'sha256:'+sha256(b)}));assert.deepEqual(validateAssetList([...assets].reverse(),pins).map(v=>v.name),[...assetNames].sort());
 for(const mutate of [a=>a.pop(),a=>a.push(a[0]),a=>a[0].size++,a=>a[0].digest='sha256:'+'0'.repeat(64),a=>a[0].id=a[1].id,a=>a[0].name='private.json',a=>a[0].state='starter']){const value=structuredClone(assets);mutate(value);assert.throws(()=>validateAssetList(value,pins));}
});
test('ordinary CLI flags and serialized claims cannot enter the local publisher',async()=>{
 for(const argv of [['publish'],['publish','true','some-decision'],['prepare'],['preflight','input','output','--publish=true']])await assert.rejects(()=>main(argv,{}));
 let calls=0;for(const auth of [undefined,null,true,{authenticated:true}])await assert.rejects(()=>publishReviewedRuntime({releaseAuthorized:true},auth,{github:async()=>{calls++;return response({});}}),/TRUSTED_LOCAL_OPERATOR_REQUIRED/);assert.equal(calls,0);
});
test('cloud workflow has only a read-only preparation job and six explicit original asset upload paths',()=>{
 const bytes=fs.readFileSync(new URL('../../.github/workflows/release.yml',import.meta.url),'utf8'),workflow=parseYaml(bytes);assert.deepEqual(workflow.permissions,{contents:'read',actions:'read'});assert.deepEqual(Object.keys(workflow.jobs),['prepare']);assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(),['expected_artifact_digest','expected_commit','source_run_id']);assert.equal(workflow.concurrency['cancel-in-progress'],false);
 const steps=workflow.jobs.prepare.steps,uploads=steps.filter(s=>s.uses?.startsWith('actions/upload-artifact'));assert.equal(uploads.length,1);const uploaded=uploads[0].with.path.trim().split('\n');assert.deepEqual(uploaded.map(p=>p.slice(p.lastIndexOf('/')+1)).sort(),[...assetNames].sort());assert(uploaded.every(p=>p.includes('/assets/')));
 const commands=steps.filter(s=>s.run).map(s=>s.run);assert(commands.includes('node scripts/release-gate.mjs prepare-ci'));assert(commands.some(s=>s.includes('npm ci --omit=dev --ignore-scripts')));assert(commands.every(s=>!s.includes('${{')&&!/npm (run build|pack)|publish|decision_ref/.test(s)));assert(!bytes.includes('contents: write'));
});
