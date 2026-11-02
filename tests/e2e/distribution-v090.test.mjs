import test from 'node:test';
import assert from 'node:assert/strict';
import {githubClient} from '../../dist/adapters/github.js';
import {gitlabClient} from '../../dist/adapters/gitlab.js';
import {publicationTarget,publicationTag} from '../../dist/adapters/distribution.js';
import {byteDigest,valueDigest} from '../../dist/lifecycle/base.js';
import {ciSourceDigest} from '../../dist/adapters/artifacts.js';

const actor={id:'reader',projects:['alpha'],permissions:['read'],revision:1,expiresAt:'2030-01-01T00:00:00Z'},commit='a'.repeat(40),description='Synthetic reviewed release.\n';
function fixture(provider){
 const gh=provider==='github',binding={ref:'binding:alpha/platform',workspaceId:'test',projectId:'alpha',provider,host:gh?'https://github.com':'https://gitlab.example.test',repository:'synthetic/project',repositoryId:'42',defaultBranch:'main',credentialRef:'credential:alpha/platform',revision:1,expiresAt:actor.expiresAt,runner:gh?'ubuntu-latest':'56',...(gh?{workflowPath:'.github/workflows/test.yml'}:{pipelinePath:'.gitlab-ci.yml'})};
 const bytes=Buffer.from('fixed original candidate artifact'),candidate={schema:'runtime-candidate/v1',version:'0.9.0-preview.1',profile:'candidate-verification',sourceDigest:ciSourceDigest({commit},provider,'42'),buildDigest:valueDigest('synthetic build'),artifacts:[{name:'software.tgz',bytes:bytes.length,digest:byteDigest(bytes)}]},tag='v'+candidate.version,request={commit,candidate,tag,prerelease:true,packageName:gh?null:'software',descriptionDigest:byteDigest(description)};
 const release=gh?{id:10,tag_name:tag,body:description,draft:false,prerelease:true,published_at:'2026-01-01T00:00:00Z'}:{tag_name:tag,description,commit:{id:commit},released_at:'2026-01-01T00:00:00Z',upcoming_release:false};
 const base=gh?'https://api.github.com/repos/'+binding.repository:binding.host+'/api/v4/projects/42',packageRoute='/packages/generic/software/'+candidate.version+'/software.tgz',entries=gh?[{id:11,name:'software.tgz',state:'uploaded',size:bytes.length,digest:byteDigest(bytes)}]:[{id:11,name:'software.tgz',url:base+packageRoute}],packages=[{id:12,name:'software',version:candidate.version,package_type:'generic',status:'default'}],files=[{id:13,file_name:'software.tgz',size:bytes.length,file_sha256:byteDigest(bytes).slice(7)}];
 const ref={ref:'refs/tags/'+tag,object:{type:'commit',sha:commit}},calls=[],control={bytes,missing:false,missingInventory:false,releaseReads:0,change:false,redirect:null,failDownload:false},original=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{
   const full=String(url);calls.push({url:full,headers:options.headers});assert.equal(options.method??'GET','GET');
   if(full.startsWith('https://release-assets.githubusercontent.com/')){assert.equal(options.headers,undefined);return new Response(control.bytes);}
   assert(full.startsWith(base));const u=new URL(url),path=u.pathname.slice(new URL(base).pathname.length);let value;
   if(path==='')value=gh?{id:42,full_name:binding.repository,default_branch:'main',archived:false}:{id:42,path_with_namespace:binding.repository,default_branch:'main',archived:false};
   else if(path==='/releases/'+(gh?'tags/':'')+tag){if(control.missing)return new Response('{}',{status:404});control.releaseReads++;value=structuredClone(release);if(control.change&&control.releaseReads>1)value[gh?'body':'description']='changed';}
   else if(path==='/git/ref/tags/'+tag)value=ref;
   else if(path.startsWith('/git/tags/'))value={sha:'b'.repeat(40),object:{type:'commit',sha:commit}};
   else if(path===(gh?'/releases/10/assets':'/releases/'+tag+'/assets/links')){if(control.missingInventory)return new Response('{}',{status:404});const page=Number(u.searchParams.get('page'));value=entries.slice((page-1)*100,page*100);if(control.reorder&&control.releaseReads>1)value.reverse();}
   else if(path==='/packages')value=packages;
   else if(path==='/packages/12/package_files')value=control.reorder&&control.releaseReads>1?[...files].reverse():files;
   else if(gh?entries.some(e=>path==='/releases/assets/'+e.id):entries.some(e=>e.url===base+path)){
     if(gh)assert.equal(options.headers.accept,'application/octet-stream');
     if(control.failDownload)return new Response('{}',{status:503});if(control.redirect)return new Response(null,{status:302,headers:{location:control.redirect}});
     return new Response(control.bytes,{headers:{'content-length':String(control.bytes.length)}});
   }else throw Error('Unexpected request '+path);
   return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
 };
 const client=(gh?githubClient:gitlabClient)(binding,async()=> 'synthetic-token-0123456789');
 return{binding,request,release,entries,packages,files,ref,control,calls,read:(input=request,who=actor,signal=AbortSignal.timeout(3000))=>client.distribution(who,input,signal),restore:()=>globalThis.fetch=original};
}
for(const provider of ['github','gitlab']){
 test(provider+' inventory ordering does not change release identity while all artifact bytes remain pinned',async()=>{
  const f=fixture(provider);try{f.control.reorder=true;f.request.candidate.artifacts.push({...f.request.candidate.artifacts[0],name:'second.tgz'});f.entries.push({...f.entries[0],id:21,name:'second.tgz',...(provider==='gitlab'?{url:f.entries[0].url.replace('software.tgz','second.tgz')}:{})});f.files.push({...f.files[0],id:22,file_name:'second.tgz'});const r=await f.read();assert.equal(r.status,'PASSED');assert.equal(r.artifacts.length,2);assert(r.artifacts.every(a=>a.status==='PASSED'));}finally{f.restore();}
 });
 test(provider+' independently reads published release, exact source and candidate bytes without granting authority',async()=>{
  const f=fixture(provider);try{const r=await f.read(),{schema,factsDigest,observedAt,releaseAuthorized,...facts}=r;assert.equal(r.status,'PASSED');assert.equal(r.releaseObserved,true);assert.equal(r.release.commit,commit);assert.equal(r.artifacts[0].digest,f.request.candidate.artifacts[0].digest);assert.equal(factsDigest,valueDigest(facts));assert.equal(releaseAuthorized,false);assert.equal(f.control.releaseReads,2);}finally{f.restore();}
 });
 test(provider+' retains absent versus partially observed release without manufacturing delivery',async()=>{
  for(const mode of ['missing','missingInventory','missingAsset','duplicate']){const f=fixture(provider);try{if(mode==='missingAsset')f.entries.length=0;else if(mode==='duplicate')f.entries.push({...f.entries[0],id:20});else f.control[mode]=true;const r=await f.read();assert.equal(r.status,mode==='missing'?'ABSENT':'PARTIAL');assert.equal(r.releaseObserved,mode!=='missing');assert.equal(r.artifacts.length,0);}finally{f.restore();}}
 });
 test(provider+' wrong source, description, artifact bytes or mid-download change cannot establish distribution',async()=>{
  for(const mutate of [f=>provider==='github'?f.ref.object.sha='c'.repeat(40):f.release.commit.id='c'.repeat(40),f=>f.release[provider==='github'?'body':'description']='different',f=>f.control.bytes=Buffer.from('modified payload'),f=>f.control.change=true]){const f=fixture(provider);try{mutate(f);const r=await f.read();assert.equal(r.status,'MISMATCH');assert.equal(r.releaseObserved,true);}finally{f.restore();}}
 });
 test(provider+' authorization and exact manifest scope are checked before network access',async()=>{
  const f=fixture(provider);try{await assert.rejects(()=>f.read(undefined,{...actor,projects:['beta']}),{code:'FORBIDDEN'});for(const alter of [r=>r.tag='another',r=>r.candidate.sourceDigest=valueDigest('foreign'),r=>r.candidate.artifacts[0].bytes=128*1024*1024+1,r=>r.url='https://outside.test',r=>r.packageName=provider==='github'?'unexpected':'../outside']){const r=structuredClone(f.request);alter(r);await assert.rejects(()=>f.read(r));}assert.equal(f.calls.length,0);await assert.rejects(()=>f.read(undefined,actor,AbortSignal.abort()));}finally{f.restore();}
 });
 test(provider+' temporarily unavailable downloads remain partial and no release or asset is retried',async()=>{
  const f=fixture(provider);try{f.control.failDownload=true;const r=await f.read();assert.equal(r.status,'PARTIAL');assert.equal(r.artifacts[0].status,'UNKNOWN');assert.equal(r.artifacts[0].reason,'CI_ARTIFACT_UNAVAILABLE');assert.equal(f.calls.filter(c=>c.url.includes(provider==='github'?'/releases/assets/':'/packages/generic/')).length,1);}finally{f.restore();}
 });
}
test('GitHub resolves bounded annotated tags and never promotes drafts or scheduled releases',async()=>{
 const f=fixture('github');try{f.ref.object={type:'tag',sha:'b'.repeat(40)};assert.equal((await f.read()).status,'PASSED');f.release.draft=true;await assert.rejects(()=>f.read(),{code:'DISTRIBUTION_RELEASE'});f.release.draft=false;f.release.published_at='2099-01-01T00:00:00Z';await assert.rejects(()=>f.read(),{code:'DISTRIBUTION_RELEASE'});}finally{f.restore();}
});
test('GitHub release asset redirects are distinct from CI storage and never forward credentials',async()=>{
 for(const host of ['release-assets.githubusercontent.com','objects.example.test','productionresults.blob.core.windows.net']){const f=fixture('github');try{f.control.redirect='https://'+host+'/fixture?signature=synthetic';const r=await f.read();assert.equal(r.status,host==='release-assets.githubusercontent.com'?'PASSED':'PARTIAL');if(host!=='release-assets.githubusercontent.com')assert(!f.calls.some(c=>c.url.startsWith('https://'+host)));}finally{f.restore();}}
});
test('GitLab rejects external/cross-project release links, ambiguous package versions and duplicate files',async()=>{
 for(const mutate of [f=>f.entries[0].url='https://evil.test/artifact',f=>f.entries[0].url=f.entries[0].url.replace('/42/','/43/'),f=>f.packages.push({...f.packages[0],id:22}),f=>f.files.push({...f.files[0],id:23}),f=>f.files[0].file_sha256='f'.repeat(64)]){const f=fixture('gitlab');try{mutate(f);const r=await f.read();assert.notEqual(r.status,'PASSED');assert(!f.calls.some(c=>c.url.includes('/packages/generic/')));}finally{f.restore();}}
});
test('distribution configuration pins tag rule and provider package instead of arbitrary URL or latest selector',()=>{
 const target=publicationTarget({tagPrefix:'v',prerelease:true,packageName:null},'github');assert.equal(publicationTag('0.9.0-preview.1',target),'v0.9.0-preview.1');
 for(const version of ['../latest','a..b','a/1','1.0.'])assert.throws(()=>publicationTag(version,target));
 for(const value of [{tagPrefix:'moving-',prerelease:true,packageName:null},{tagPrefix:'v',prerelease:'true',packageName:null},{tagPrefix:'v',prerelease:true,packageName:null,url:'https://evil.test'}])assert.throws(()=>publicationTarget(value,'github'));
});
