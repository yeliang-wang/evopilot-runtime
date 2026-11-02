import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {githubClient} from '../../dist/adapters/github.js';
import {gitlabClient} from '../../dist/adapters/gitlab.js';
import {releaseDocuments} from '../../dist/adapters/documents.js';
import {valueDigest,byteDigest} from '../../dist/lifecycle/base.js';

const actor={id:'reader',projects:['alpha'],permissions:['read'],revision:1,expiresAt:'2030-01-01T00:00:00Z'};
const commit='b'.repeat(40),root='c'.repeat(40),subtree='d'.repeat(40);
const mapping=[{role:'release-notes',path:'RELEASE.md'},{role:'migration',path:'MIGRATION.md'},{role:'readme',path:'README.md'},{role:'technical',path:'docs/technical.md'}];
function fixture(provider){
  const gh=provider==='github',binding={ref:'binding:alpha/source',workspaceId:'test',projectId:'alpha',provider,host:gh?'https://github.com':'https://gitlab.example.test',repository:'synthetic/project',repositoryId:'42',defaultBranch:'main',credentialRef:'credential:alpha/platform',revision:1,expiresAt:'2030-01-01T00:00:00Z',...(gh?{workflowPath:'.github/workflows/test.yml',runner:'ubuntu-latest'}:{pipelinePath:'.gitlab-ci.yml',runner:'56'})};
  const repo=gh?{id:42,full_name:binding.repository,default_branch:'main',archived:false}:{id:42,path_with_namespace:binding.repository,default_branch:'main',archived:false};
  const files={},trees={'':[],docs:[]},control={truncated:false,commit},calls=[],original=globalThis.fetch;
  function content(path,bytes){
    const blob=createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');
    files[path]=gh?{type:'file',path,encoding:'base64',content:bytes.toString('base64'),size:bytes.length,sha:blob}:{file_path:path,commit_id:commit,encoding:'base64',content:bytes.toString('base64'),size:bytes.length,blob_id:blob,content_sha256:byteDigest(bytes).slice(7)};
    const parent=path.includes('/')?'docs':'',entry=trees[parent].find(x=>x.path===(gh?path.split('/').at(-1):path));
    if(entry)entry[gh?'sha':'id']=blob;else trees[parent].push({path:gh?path.split('/').at(-1):path,mode:'100644',type:'blob',[gh?'sha':'id']:blob});
  }
  for(const d of mapping)content(d.path,Buffer.from('# '+d.role+'\nSynthetic candidate documentation.\n'));
  trees[''].push({path:'docs',mode:'040000',type:'tree',[gh?'sha':'id']:subtree});
  globalThis.fetch=async(url,options)=>{
    const u=new URL(url),prefix=gh?'/repos/synthetic/project':'/api/v4/projects/42',route=u.pathname.slice(prefix.length);calls.push(u.href);assert.equal(options.method??'GET','GET');assert.equal(u.origin,gh?'https://api.github.com':binding.host);assert(u.pathname.startsWith(prefix));let value;
    if(route==='')value=repo;
    else if(route===(gh?'/git/commits/':'/repository/commits/')+commit)value=gh?{sha:control.commit,tree:{sha:root}}:{id:control.commit};
    else if(gh&&route.startsWith('/git/trees/')){const sha=route.split('/').at(-1);assert([root,subtree].includes(sha));value={sha,truncated:control.truncated,tree:trees[sha===root?'':'docs']};}
    else if(!gh&&route==='/repository/tree'){assert.equal(u.searchParams.get('ref'),commit);const rows=trees[u.searchParams.get('path')],page=Number(u.searchParams.get('page'));value=rows.slice((page-1)*100,page*100);}
    else if(route.startsWith(gh?'/contents/':'/repository/files/')){assert.equal(u.searchParams.get('ref'),commit);value=files[decodeURIComponent(route.slice((gh?'/contents/':'/repository/files/').length))];}
    else throw Error('Unexpected route '+route);
    return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  };
  const client=(gh?githubClient:gitlabClient)(binding,async()=> 'synthetic-token-0123456789');
  return{binding,repo,files,trees,control,calls,content,read:(input={commit,documents:mapping},who=actor,signal=AbortSignal.timeout(3000))=>client.documents(who,input,signal),restore:()=>globalThis.fetch=original};
}
for(const provider of ['github','gitlab']){
  test(provider+' release documents bind exact source, full text and independent hashes without reading HEAD or granting approval',async()=>{
    const f=fixture(provider);try{const v=await f.read(),{schema,factsDigest,observedAt,releaseAuthorized,...facts}=v;assert.equal(factsDigest,valueDigest(facts));assert.equal(v.commit,commit);assert.equal(v.bindingDigest,valueDigest(f.binding));assert.equal(releaseAuthorized,false);assert.equal(v.documents.length,4);for(const d of v.documents){assert.equal(d.digest,byteDigest(d.text));assert.equal(d.bytes,Buffer.byteLength(d.text));}assert(!f.calls.some(x=>x.includes('/branches/')));assert.equal((await f.read()).factsDigest,factsDigest);}finally{f.restore();}
  });
  test(provider+' rejects links, submodules, ambiguous paths and missing source instead of following them',async()=>{
    for(const mutate of [f=>f.repo.id=43,f=>f.control.commit='e'.repeat(40),f=>f.trees[''].pop(),f=>f.trees[''].push(structuredClone(f.trees[''][0])),f=>f.trees[''][0].mode='120000',f=>f.trees[''][0].mode='160000',f=>f.trees[''].at(-1).mode='120000']){
      const f=fixture(provider);try{mutate(f);await assert.rejects(()=>f.read());}finally{f.restore();}
    }
  });
  test(provider+' rejects mismatched, oversized, invalid UTF8, blank and credential-bearing source documents',async()=>{
    for(const mutate of [f=>f.files['README.md'].size++,f=>f.files['README.md'].size=1048577,f=>f.files['README.md'].content='???',f=>f.files['README.md'][provider==='github'?'sha':'blob_id']='f'.repeat(40),f=>f.content('README.md',Buffer.from([255,254])),f=>f.content('README.md',Buffer.from(' \n')),f=>f.content('README.md',Buffer.from('text\0hidden')),f=>f.content('README.md',Buffer.from('Authorization: Bearer synthetic-secret-value-0123456789'))]){
      const f=fixture(provider);try{mutate(f);await assert.rejects(()=>f.read(),e=>e.code.startsWith('RELEASE_DOCUMENT'));}finally{f.restore();}
    }
  });
  test(provider+' checks scope and strict mappings before provider access, and honors cancellation',async()=>{
    const f=fixture(provider);try{await assert.rejects(()=>f.read(undefined,{...actor,projects:['beta']}),{code:'FORBIDDEN'});for(const docs of [mapping.slice(1),[...mapping,mapping[0]],mapping.map((d,i)=>i?d:{...d,path:'../secret.md'}),mapping.map((d,i)=>i?d:{...d,path:'https://other.test/a.md'})])await assert.rejects(()=>f.read({commit,documents:docs}));assert.equal(f.calls.length,0);await assert.rejects(()=>f.read(undefined,actor,AbortSignal.abort()));}finally{f.restore();}
  });
  test(provider+' one file may fulfill distinct configured document roles without duplicate byte fetches',async()=>{
    const f=fixture(provider);try{const v=await f.read({commit,documents:mapping.map(d=>({...d,path:'README.md'}))});assert.equal(v.documents.length,4);assert.equal(f.calls.filter(x=>x.includes(provider==='github'?'/contents/':'/repository/files/')).length,1);}finally{f.restore();}
  });
}
test('GitHub rejects truncated document trees and GitLab requires complete paginated directories',async()=>{
  let f=fixture('github');try{f.control.truncated=true;await assert.rejects(()=>f.read(),{code:'RELEASE_DOCUMENT_TREE'});}finally{f.restore();}
  f=fixture('gitlab');try{for(let i=0;i<100;i++)f.trees[''].push({path:'unused-'+i,mode:'100644',type:'blob',id:'f'.repeat(40)});assert.equal((await f.read()).documents.length,4);assert(f.calls.some(x=>x.endsWith('page=2')));for(let i=100;i<1000;i++)f.trees[''].push({path:'unused-'+i,mode:'100644',type:'blob',id:'f'.repeat(40)});await assert.rejects(()=>f.read(),{code:'RELEASE_DOCUMENT_TREE'});}finally{f.restore();}
});
test('document roles are mandatory, unique and bounded configuration rather than caller-selected URLs',()=>{
  assert.deepEqual(new Set(releaseDocuments(mapping).map(d=>d.role)),new Set(mapping.map(d=>d.role)));
  for(const path of ['/README.md','a/../README.md','a/.git/README.md','a\\README.md','a\nREADME.md','README.exe','a//README.md'])assert.throws(()=>releaseDocuments(mapping.map((d,i)=>i?d:{...d,path})),e=>['INVALID_INPUT','RELEASE_DOCUMENT_CONFIGURATION'].includes(e.code));
});
