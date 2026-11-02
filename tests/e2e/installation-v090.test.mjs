import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,linkSync,chmodSync,readFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {byteDigest,valueDigest} from '../../dist/lifecycle/base.js';
import {readInstallationManifest,observeInstallation} from '../../dist/adapters/installation.js';
import {validateResourceDefinition} from '../../dist/adapters/bindings.js';

const signal=()=>AbortSignal.timeout(5000);
function fixture(){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'runtime-installed-readback-')),directory=join(root,'installed');mkdirSync(directory,{mode:0o700});mkdirSync(join(directory,'bin'),{mode:0o700});
 const body=Buffer.from('Exact installed implementation\n');writeFileSync(join(directory,'bin/app.mjs'),body,{mode:0o700});writeFileSync(join(directory,'empty.txt'),'',{mode:0o600});symlinkSync('bin/app.mjs',join(directory,'app'));
 const pkg={name:'software.tgz',digest:valueDigest('synthetic archive'),bytes:100},manifest={schema:'runtime-installation-manifest/v1',version:'0.9.0-preview.1',packages:[pkg],entries:[{path:'bin/app.mjs',type:'file',digest:byteDigest(body),bytes:body.length,executable:true},{path:'empty.txt',type:'file',digest:byteDigest(''),bytes:0,executable:false},{path:'app',type:'symlink',target:'bin/app.mjs'}]};
 const candidate={schema:'runtime-candidate/v1',version:manifest.version,profile:'candidate-verification',sourceDigest:valueDigest('source'),buildDigest:valueDigest('build'),artifacts:[pkg]};
 function pin(m=manifest){const bytes=Buffer.from(JSON.stringify(m)),c={...candidate,artifacts:[pkg,{name:'installation.json',digest:byteDigest(bytes),bytes:bytes.length}]};return{candidate:c,bytes,verified:readInstallationManifest(c,'installation.json',bytes)};}
 return{root,directory,body,manifest,candidate,pin,read:()=>observeInstallation(directory,pin().verified,signal()),cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('exact candidate installation inventory independently verifies files, permissions, empty files and internal links',()=>{
 const f=fixture();try{const before=readFileSync(join(f.directory,'bin/app.mjs')),r=f.read(),{schema,factsDigest,observedAt,softwareExecuted,deploymentAccepted,...facts}=r;assert.equal(r.status,'PASSED');assert(r.entries.every(e=>e.status==='PASSED'));assert.equal(factsDigest,valueDigest(facts));assert.equal(softwareExecuted,false);assert.equal(deploymentAccepted,false);assert.deepEqual(readFileSync(join(f.directory,'bin/app.mjs')),before);assert.equal(f.read().factsDigest,r.factsDigest);}finally{f.cleanup();}
});
test('candidate manifest must be exact bytes and refer to the same original candidate version and packages',()=>{
 const f=fixture();try{const p=f.pin();assert.throws(()=>readInstallationManifest(p.candidate,'other.json',p.bytes),{code:'INSTALLATION_CANDIDATE'});assert.throws(()=>readInstallationManifest(p.candidate,'installation.json',Buffer.from('changed')),{code:'INSTALLATION_CANDIDATE'});
 for(const mutate of [m=>m.version='another',m=>m.packages[0].digest=valueDigest('foreign'),m=>m.packages[0].bytes++,m=>m.packages[0].name='installation.json']){const m=structuredClone(f.manifest);mutate(m);assert.throws(()=>f.pin(m),{code:'INSTALLATION_CANDIDATE'});}
 const damaged=structuredClone(p.verified);damaged.manifest.entries[0].digest=valueDigest('changed');assert.throws(()=>observeInstallation(f.directory,damaged,signal()),{code:'INSTALLATION_CANDIDATE'});
 }finally{f.cleanup();}
});
test('missing installation and incomplete installation remain distinct from passed delivery',()=>{
 const f=fixture();try{const p=f.pin();assert.equal(observeInstallation(join(f.root,'absent'),p.verified,signal()).status,'ABSENT');rmSync(join(f.directory,'empty.txt'));const r=observeInstallation(f.directory,p.verified,signal());assert.equal(r.status,'PARTIAL');assert.equal(r.entries.find(e=>e.path==='empty.txt').status,'MISSING');assert.equal(r.deploymentAccepted,false);}finally{f.cleanup();}
});
for(const variation of ['bytes','size','executable','unsafe-mode','extra-file','hard-link','linked-file','wrong-link','linked-directory'])test('installed '+variation+' cannot match the candidate',()=>{
 const f=fixture();try{
  const path=join(f.directory,'bin/app.mjs');if(variation==='bytes')writeFileSync(path,Buffer.alloc(f.body.length,65));
  if(variation==='size')writeFileSync(path,'short');if(variation==='executable')chmodSync(path,0o600);if(variation==='unsafe-mode')chmodSync(path,0o777);
  if(variation==='extra-file')writeFileSync(join(f.directory,'unexpected.txt'),'extra');
  if(variation==='hard-link')linkSync(path,join(f.root,'outside-hard-link'));
  if(variation==='linked-file'){rmSync(path);writeFileSync(join(f.root,'outside'),f.body,{mode:0o700});symlinkSync(join(f.root,'outside'),path);}
  if(variation==='wrong-link'){rmSync(join(f.directory,'app'));symlinkSync('../outside',join(f.directory,'app'));}
  if(variation==='linked-directory'){rmSync(join(f.directory,'bin'),{recursive:true});mkdirSync(join(f.root,'other'),{mode:0o700});writeFileSync(join(f.root,'other/app.mjs'),f.body,{mode:0o700});symlinkSync(join(f.root,'other'),join(f.directory,'bin'));}
  assert.equal(f.read().status,'MISMATCH');
 }finally{f.cleanup();}
});
test('directory scope and cancellation are checked before file acceptance',()=>{
 const f=fixture();try{const p=f.pin();assert.throws(()=>observeInstallation('relative',p.verified,signal()),{code:'INSTALLATION_SCOPE'});symlinkSync(f.directory,join(f.root,'alias'));assert.throws(()=>observeInstallation(join(f.root,'alias'),p.verified,signal()),{code:'INSTALLATION_SCOPE'});chmodSync(f.directory,0o777);assert.throws(()=>f.read(),{code:'INSTALLATION_SCOPE'});chmodSync(f.directory,0o700);const controller=new AbortController();controller.abort();assert.throws(()=>observeInstallation(f.directory,p.verified,controller.signal),{name:'AbortError'});}finally{f.cleanup();}
});
test('unsafe, duplicate, missing, cyclic or unsupported manifest entries fail before filesystem access',()=>{
 const f=fixture();try{
  const bad=[m=>m.entries=[],m=>m.entries.push({...m.entries[0]}),m=>m.entries.push({...m.entries[0],path:'BIN/APP.MJS'}),m=>m.entries[0].path='../outside',m=>m.entries[0].path='/absolute',m=>m.entries[0].path='bin/../outside',m=>m.entries[0].path='.git/config',m=>m.entries[0].bytes=-1,m=>m.entries[0].bytes=129*1024*1024,m=>m.entries[0].executable='yes',m=>m.entries[0].type='socket',m=>m.entries[2].target='missing',m=>m.entries[2].target='app',m=>m.entries[2].target='../outside',m=>m.entries[2].target='/absolute',m=>m.entries.push({path:'app/nested',type:'file',bytes:0,digest:byteDigest(''),executable:false}),m=>m.entries.push({path:'loop',type:'symlink',target:'app'})&&Object.assign(m.entries[2],{target:'loop'}),m=>m.extra='unrecognized'];
  for(const mutate of bad){const m=structuredClone(f.manifest);mutate(m);assert.throws(()=>f.pin(m),{code:m.extra?'INVALID_FIELDS':'INSTALLATION_MANIFEST'});}
  const directoryCase=structuredClone(f.manifest);directoryCase.entries.push({...directoryCase.entries[0],path:'BIN/second.mjs'});assert.throws(()=>f.pin(directoryCase),{code:'INSTALLATION_MANIFEST'});
 }finally{f.cleanup();}
});
test('relative links to declared directories and chained internal links preserve their exact target text',()=>{
 const f=fixture();try{const m=structuredClone(f.manifest);m.entries.push({path:'bin/second',type:'symlink',target:'../app'},{path:'directory-link',type:'symlink',target:'bin'});symlinkSync('../app',join(f.directory,'bin/second'));symlinkSync('bin',join(f.directory,'directory-link'));const p=f.pin(m),r=observeInstallation(f.directory,p.verified,signal());assert.equal(r.status,'PASSED');assert.equal(r.entries.find(e=>e.path==='bin/second').actual.target,'../app');}finally{f.cleanup();}
});
test('installation and deployment configuration require a candidate manifest artifact while distribution does not invent an installation',()=>{
 const f=fixture();try{const resource={role:'config.closure.deliveryTargetRef'};
  for(const mode of ['local-install','approved-deployment']){const definition={kind:'delivery',mode,directory:f.directory,manifestArtifact:'installation.json'};assert.doesNotThrow(()=>validateResourceDefinition({...resource,definition}));for(const manifestArtifact of [undefined,'../manifest.json','/manifest.json',''])assert.throws(()=>validateResourceDefinition({...resource,definition:{...definition,manifestArtifact}}));}
  const definition={kind:'delivery',mode:'distribution',platformRef:'binding:alpha/platform'};assert.doesNotThrow(()=>validateResourceDefinition({...resource,definition}));assert.throws(()=>validateResourceDefinition({...resource,definition:{...definition,manifestArtifact:'installation.json'}}));
 }finally{f.cleanup();}
});
