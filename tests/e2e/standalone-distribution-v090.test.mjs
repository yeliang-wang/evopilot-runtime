import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,readlinkSync,realpathSync,rmSync,symlinkSync,utimesSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,isAbsolute,join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {VERSION} from '../../dist/index.js';
import {packStandaloneTree,buildStandaloneDistribution} from '../../dist/installation/distribution.js';
import {runInstaller} from '../../dist/installation/installer.js';

const sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'runtime-distribution-v09-')),source=join(root,'source');mkdirSync(source);
 const content={
  'package.json':JSON.stringify({name:'@evopilot-next/runtime',version:VERSION,dependencies:{'synthetic-dependency':'1.0.0'}}),
  'package-lock.json':JSON.stringify({name:'@evopilot-next/runtime',version:VERSION,lockfileVersion:3,packages:{'':{dependencies:{'synthetic-dependency':'1.0.0'}}}}),
  'node_modules/synthetic-dependency/package.json':JSON.stringify({name:'synthetic-dependency',version:'1.0.0'}),
  'node_modules/synthetic-dependency/bin/fixture.js':'// synthetic distribution fixture; never executes business work\n',
  'dist/index.js':'// synthetic compiled entry\n','dist/index.d.ts':'// synthetic declaration\n',
  'dist/server/cli.js':'#!/usr/bin/env node\n// fixture only\n','dist/installation/installer.js':'// fixture only\n',
  'dist/host/header-helper.js':'// synthetic helper; never executed\n',
  'dist/dashboard/index.html':'<!doctype html><title>Synthetic</title>',
  'plugins/codex/.codex-plugin/plugin.json':JSON.stringify({name:'evopilot-runtime',version:VERSION}),'plugins/codex/mcp.template.json':'{}\n',
  'plugins/codex/skills/evopilot-runtime-expert/SKILL.md':'Synthetic packaging fixture; not an installed Expert.',
 };
 for(const [name,bytes] of Object.entries(content)){mkdirSync(dirname(join(source,name)),{recursive:true});writeFileSync(join(source,name),bytes,{mode:0o644});}
 chmodSync(join(source,'dist/server/cli.js'),0o755);mkdirSync(join(source,'node_modules/.bin'));symlinkSync('../synthetic-dependency/bin/fixture.js',join(source,'node_modules/.bin/fixture'));
 const npmArchive=join(root,'fixture.tgz');writeFileSync(npmArchive,'Synthetic npm archive fixture; no acceptance claim.');
 return{root,source,input:{packageRoot:source,npmArchive,outputDirectory:join(root,'distribution'),sourceCommit:'a'.repeat(40)},cleanup(){rmSync(root,{recursive:true,force:true});}};
}
function unpack(f,archive,destination){
 const archiveRef=isAbsolute(archive)?archive:join(f.root,archive);mkdirSync(destination);
 const r=spawnSync('/usr/bin/tar',['-xzf',archiveRef,'-C',destination],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
}
test('standalone archive is deterministic across file times and preserves portable modes and in-package links',()=>{
 const f=fixture();try{
  const long='nested/'+('directory'.repeat(10))+'/portable-file.txt';mkdirSync(dirname(join(f.source,long)),{recursive:true});writeFileSync(join(f.source,long),'unicode content 文本\n');
  const first=packStandaloneTree(f.source);utimesSync(join(f.source,'dist/index.js'),new Date(0),new Date());const second=packStandaloneTree(f.source);
  assert.deepEqual(first.archive,second.archive);assert.deepEqual(first.files,second.files);
  writeFileSync(join(f.root,'payload.tgz'),first.archive);const dest=join(f.root,'unpacked');unpack(f,'payload.tgz',dest);
  for(const [name,pin] of Object.entries(first.files)){const path=join(dest,'package',name);if(pin.type==='file')assert.equal(sha(readFileSync(path)),pin.sha256);else assert.equal(readlinkSync(path),pin.target);}
  assert.equal(readFileSync(join(dest,'package',long),'utf8'),'unicode content 文本\n');assert.equal(first.files['dist/server/cli.js'].mode,0o755);
 }finally{f.cleanup();}
});
test('standalone archive rejects external, dangling and looping links, hardlinks and oversized portable paths',()=>{
 for(const mode of ['external','dangling','loop','hardlink','long','invalidpath']){const f=fixture();try{
  const path=join(f.source,'untrusted');
  if(mode==='external')symlinkSync(f.input.npmArchive,path);else if(mode==='dangling')symlinkSync('missing',path);else if(mode==='loop')symlinkSync('untrusted',path);else if(mode==='hardlink')linkSync(join(f.source,'package.json'),path);else writeFileSync(join(f.source,mode==='long'?'x'.repeat(101):'bad:entry'),'invalid archive path');
  assert.throws(()=>packStandaloneTree(f.source));assert(!existsSync(f.input.outputDirectory));
 }finally{f.cleanup();}}
});
test('independent distribution binds every asset and stages via the real installer without source dependencies or activation',async()=>{
 const f=fixture();try{
  const result=buildStandaloneDistribution(f.input);assert.equal(result.releaseAuthorized,false);assert.equal(result.productAcceptance,'NOT_EVALUATED');
  const manifestRef=join(result.directory,'distribution-manifest.json'),manifest=JSON.parse(readFileSync(manifestRef));
  const archiveRef=join(result.directory,`evopilot-runtime-${VERSION}-darwin-arm64.tar.gz`);assert.equal(manifest.archiveDigest,sha(readFileSync(archiveRef)));
  for(const line of readFileSync(join(result.directory,'SHA256SUMS'),'utf8').trimEnd().split('\n')){const [digest,name]=line.split('  ');assert.equal(sha(readFileSync(join(result.directory,name))),digest);}
  const dest=join(f.root,'unpacked');unpack(f,archiveRef,dest);
  const nodeExecutable=realpathSync(process.execPath),plan={schema:'runtime-install-plan/v1',root:join(f.root,'installed'),distribution:{packageRoot:join(dest,'package'),manifestRef,manifestDigest:sha(readFileSync(manifestRef)),archiveRef,archiveDigest:manifest.archiveDigest},nodeExecutable,nodeSha256:sha(readFileSync(nodeExecutable)),workspaceId:'synthetic-distribution',projectId:'alpha',principalId:'reader',role:'reader',credentialExpiresAt:new Date(Date.now()+86400000).toISOString(),port:33332,integrationsRef:null,codex:null};
  const installed=await runInstaller(plan,'stage');assert.equal(installed.phase,'STAGED');assert.equal(installed.serviceStarted,false);assert.equal(installed.hostRegistered,false);
  assert.deepEqual(readFileSync(join(plan.root,'package/package.json')),readFileSync(join(f.source,'package.json')));
  assert.equal(readlinkSync(join(plan.root,'package/node_modules/.bin/fixture')),'../synthetic-dependency/bin/fixture.js');
  assert.throws(()=>buildStandaloneDistribution(f.input),{code:'EEXIST'});assert.equal(readFileSync(join(result.directory,'source-revision.txt'),'utf8'),'a'.repeat(40)+'\n');
 }finally{f.cleanup();}
});
test('wrong source identity, package, lock or dependency cannot produce a candidate directory',()=>{
 for(const mode of ['commit','version','lock','dependency','plugin']){const f=fixture();try{
  if(mode==='commit')f.input.sourceCommit='main';else{const file=mode==='version'?'package.json':mode==='lock'?'package-lock.json':mode==='plugin'?'plugins/codex/.codex-plugin/plugin.json':'node_modules/synthetic-dependency/package.json',p=join(f.source,file),value=JSON.parse(readFileSync(p));value.version='999.0.0';writeFileSync(p,JSON.stringify(value));}
  assert.throws(()=>buildStandaloneDistribution(f.input));assert(!existsSync(f.input.outputDirectory));
 }finally{f.cleanup();}}
});
