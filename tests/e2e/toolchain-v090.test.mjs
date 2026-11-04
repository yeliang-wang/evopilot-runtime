import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {archivePath,readTarGz,readWheel} from '../../dist/installation/toolchain/archive.js';
import {inspectBundledToolchainLock,inspectNativeToolchain,prepareNativeToolchain,prepareNativeToolchainRelocation} from '../../dist/installation/toolchain/locked.js';
import {toolchainCommand} from '../../dist/installation/toolchain/cli.js';

const repo=fs.realpathSync(fileURLToPath(new URL('../../',import.meta.url))),base=join(repo,'provenance/native-toolchain');
const temporary=()=>fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'runtime-locked-toolchain-'));
const supported=process.platform==='darwin'&&process.arch==='arm64';

test('relocation material requires separate verified original and copied caches and never prepares missing dependencies',()=>{
 const root=temporary();
 try{
  for(const destination of [root,join(root,'nested')])assert.throws(()=>prepareNativeToolchainRelocation(root,destination),{code:'TOOLCHAIN_PATH'});
  assert.throws(()=>prepareNativeToolchainRelocation(join(root,'source'),join(root,'destination')),{code:supported?'TOOLCHAIN_NOT_READY':'TOOLCHAIN_UNSUPPORTED_PLATFORM'});
  assert.deepEqual(fs.readdirSync(root),[]);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('independent toolchain preserves every original dependency and license pin',()=>{
  const provenance=JSON.parse(fs.readFileSync(join(repo,'provenance/legacy-toolchain.json'),'utf8'));
  for(const pin of provenance.files.filter(pin=>pin.ownedPath.startsWith('provenance/'))){assert.equal(createHash('sha256').update(fs.readFileSync(join(repo,pin.ownedPath))).digest('hex'),pin.sha256,pin.ownedPath);}
  if(!supported){assert.throws(()=>inspectBundledToolchainLock(),{code:'TOOLCHAIN_UNSUPPORTED_PLATFORM'});return;}
  const lock=inspectBundledToolchainLock();assert.equal(lock.lockDigest,'sha256:'+createHash('sha256').update(fs.readFileSync(join(base,'toolchain.lock.json'))).digest('hex'));
  assert.equal(lock.productVersion,'0.3.0','original toolchain edition is not the Runtime product version');
  assert.deepEqual(lock.supportedPlatforms,['darwin-arm64']);
});

test('locked archive parser rejects traversal, malformed containers and empty contents',()=>{
  for(const value of ['../x','/x','a/../../x','a\\b','a//b','C:x','a\0b'])assert.throws(()=>archivePath(value));
  assert.equal(archivePath('python/lib/site.py'),'python/lib/site.py');
  assert.throws(()=>readTarGz(gzipSync(Buffer.alloc(512))),/empty tar/);
  assert.throws(()=>readTarGz(gzipSync(Buffer.alloc(512,1))),/tar/);
  assert.throws(()=>readWheel(Buffer.alloc(100)),/ZIP/);
});

test('inspection is passive and offline preparation cannot fetch or report a cold cache ready',async()=>{
  const root=temporary(),original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('must not fetch');};
  try{
    if(!supported){assert.throws(()=>inspectNativeToolchain({cacheRoot:root}),{code:'TOOLCHAIN_UNSUPPORTED_PLATFORM'});return;}
    assert.throws(()=>inspectNativeToolchain({cacheRoot:join(root,'absent')}),{code:'TOOLCHAIN_NOT_READY'});assert.deepEqual(fs.readdirSync(root),[]);
    await assert.rejects(prepareNativeToolchain({cacheRoot:root,offline:true}),{code:'TOOLCHAIN_NOT_READY'});assert.equal(calls,0);assert.deepEqual(fs.readdirSync(root),['downloads']);assert.deepEqual(fs.readdirSync(join(root,'downloads')),[]);
  }finally{globalThis.fetch=original;fs.rmSync(root,{recursive:true,force:true});}
});

test('bounded download failure and body timeout keep no partial artifact and redact provider diagnostics',async()=>{
  if(!supported){assert.throws(()=>inspectBundledToolchainLock(),{code:'TOOLCHAIN_UNSUPPORTED_PLATFORM'});return;}
  for(const [failure,code] of [[new DOMException('synthetic secret URL','TimeoutError'),'TOOLCHAIN_DOWNLOAD_TIMEOUT'],[new TypeError('synthetic proxy secret'),'TOOLCHAIN_DOWNLOAD_NETWORK'],[null,'TOOLCHAIN_DOWNLOAD']]){
    const root=temporary(),original=globalThis.fetch;
    try{globalThis.fetch=async()=>{if(failure)throw failure;return new Response('unavailable',{status:503});};await assert.rejects(prepareNativeToolchain({cacheRoot:root}),error=>{assert.equal(error.code,code);assert(!error.message.includes('synthetic'));return true;});assert.deepEqual(fs.readdirSync(join(root,'downloads')),[]);}
    finally{globalThis.fetch=original;fs.rmSync(root,{recursive:true,force:true});}
  }
  const root=temporary(),original=globalThis.fetch;
  try{
    globalThis.fetch=async(_url,options)=>{assert(options.signal instanceof AbortSignal);return{ok:true,url:'https://example.invalid/synthetic',body:{async *[Symbol.asyncIterator](){yield Buffer.from('partial');throw new DOMException('synthetic body timeout','TimeoutError');}}};};
    await assert.rejects(prepareNativeToolchain({cacheRoot:root}),{code:'TOOLCHAIN_DOWNLOAD_TIMEOUT'});assert.deepEqual(fs.readdirSync(join(root,'downloads')),[]);assert.throws(()=>inspectNativeToolchain({cacheRoot:root}),{code:'TOOLCHAIN_NOT_READY'});
  }finally{globalThis.fetch=original;fs.rmSync(root,{recursive:true,force:true});}
});

test('preparation preserves corrupt retained bytes and rejects linked ancestors before creating descendants',async()=>{
  if(!supported){assert.throws(()=>inspectBundledToolchainLock(),{code:'TOOLCHAIN_UNSUPPORTED_PLATFORM'});return;}
  const root=temporary(),original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('must not fetch');};
  try{
    const foreign=join(root,'foreign');fs.mkdirSync(foreign,{mode:0o700});fs.symlinkSync(foreign,join(root,'linked'));
    await assert.rejects(prepareNativeToolchain({cacheRoot:join(root,'linked','unexpected'),offline:true}),{code:'TOOLCHAIN_PATH'});assert.deepEqual(fs.readdirSync(foreign),[]);
    const cache=join(root,'cache'),downloads=join(cache,'downloads');fs.mkdirSync(downloads,{recursive:true,mode:0o700});
    const lock=JSON.parse(fs.readFileSync(join(base,'toolchain.lock.json'),'utf8')),pin=lock.platforms['darwin-arm64'].artifacts[0],file=join(downloads,pin.sha256);fs.writeFileSync(file,'retained corrupt bytes',{mode:0o600});
    await assert.rejects(prepareNativeToolchain({cacheRoot:cache}),{code:'TOOLCHAIN_INTEGRITY'});assert.equal(fs.readFileSync(file,'utf8'),'retained corrupt bytes');assert.equal(calls,0);
  }finally{globalThis.fetch=original;fs.rmSync(root,{recursive:true,force:true});}
});

test('owned CLI reads its bundled lock independently and rejects arbitrary URLs or executables',async()=>{
  for(const args of [['prepare','--url','https://example.invalid'],['inspect','--cache','relative'],['inspect','--cache','/tmp','--executable','/bin/sh'],['lock','--cache','/tmp']])await assert.rejects(toolchainCommand(args));
  const root=temporary();try{
    const result=spawnSync(process.execPath,[join(repo,'dist/installation/toolchain/cli.js'),'lock'],{cwd:root,encoding:'utf8',timeout:10000});
    assert.equal(result.status,supported?0:1);if(supported)assert.equal(JSON.parse(result.stdout).lockDigest,inspectBundledToolchainLock().lockDigest);assert.deepEqual(fs.readdirSync(root),[]);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('CLI streaming preserves a complete large dependency inventory through an actual pipe',()=>{
  const program="import {writeToolchainResult} from './dist/installation/toolchain/cli.js'; await writeToolchainResult({files:Array.from({length:3000},(_,i)=>({path:'owned/dependency/'+i+'/source.py',sha256:'a'.repeat(64)}))});";
  const result=spawnSync(process.execPath,['--input-type=module','-e',program],{cwd:repo,encoding:'utf8',timeout:10000,maxBuffer:2*1024*1024});
  assert.equal(result.status,0,result.stderr);assert(result.stdout.length>65536);assert(result.stdout.endsWith('\n'));const parsed=JSON.parse(result.stdout);assert.equal(parsed.files.length,3000);assert.equal(parsed.files.at(-1).path,'owned/dependency/2999/source.py');
});
