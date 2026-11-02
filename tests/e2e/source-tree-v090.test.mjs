import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {githubClient} from '../../dist/adapters/github.js';
import {gitlabClient} from '../../dist/adapters/gitlab.js';
import {valueDigest} from '../../dist/lifecycle/base.js';

const actor={id:'reader',projects:['alpha'],permissions:['read'],revision:1,expiresAt:'2030-01-01T00:00:00Z'},commit='b'.repeat(40);
function fixture(provider,count=0){
  const dir=mkdtempSync(join(tmpdir(),'runtime-git-tree-'));
  execFileSync('git',['init','--bare','--quiet',dir]);
  const git=(args,input='')=>execFileSync('git',['--git-dir',dir,...args],{input,encoding:'utf8'}).trim();
  const blob=git(['hash-object','-w','--stdin'],'original source\n'),link=git(['hash-object','-w','--stdin'],'README.md');
  const tree=rows=>git(['mktree','--missing'],rows.map(r=>r.mode+' '+r.type+' '+r.id+'\t'+r.name+'\n').join(''));
  const child=[{name:'a.md',mode:'100644',type:'blob',id:blob}],subtree=tree(child);
  const rows=count?Array.from({length:count},(_,i)=>({name:'file-'+String(i).padStart(4,'0'),mode:'100644',type:'blob',id:blob})):[
    {name:'README.md',mode:'100644',type:'blob',id:blob},{name:'run',mode:'100755',type:'blob',id:blob},
    {name:'readme-link',mode:'120000',type:'blob',id:link},{name:'external',mode:'160000',type:'commit',id:'f'.repeat(40)},
    {name:'docs',mode:'040000',type:'tree',id:subtree}];
  const root=tree(rows),gh=provider==='github',binding={ref:'binding:alpha/source',workspaceId:'test',projectId:'alpha',provider,host:gh?'https://github.com':'https://gitlab.example.test',repository:'synthetic/project',repositoryId:'42',defaultBranch:'main',credentialRef:'credential:alpha/platform',revision:1,expiresAt:'2030-01-01T00:00:00Z',...(gh?{workflowPath:'.github/workflows/test.yml',runner:'ubuntu-latest'}:{pipelinePath:'.gitlab-ci.yml',runner:'56'})};
  const repo=gh?{id:42,full_name:binding.repository,default_branch:'main',archived:false}:{id:42,path_with_namespace:binding.repository,default_branch:'main',archived:false};
  const convert=(rs,parent)=>rs.map(r=>({path:gh?r.name:(parent?parent+'/':'')+r.name,mode:r.mode,type:r.type,[gh?'sha':'id']:r.id}));
  const trees={'':convert(rows,''),docs:convert(child,'docs')},control={root,commit,truncated:false,repeatPages:false},calls=[],original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    const u=new URL(url),prefix=gh?'/repos/synthetic/project':'/api/v4/projects/42',route=u.pathname.slice(prefix.length);calls.push(u.href);
    assert.equal(options.method??'GET','GET');assert.equal(u.origin,gh?'https://api.github.com':binding.host);assert(u.pathname.startsWith(prefix));let v;
    if(route==='')v=repo;
    else if(route===(gh?'/git/commits/':'/repository/commits/')+commit)v=gh?{sha:control.commit,tree:{sha:control.root}}:{id:control.commit};
    else if(gh&&route.startsWith('/git/trees/')){const sha=route.split('/').at(-1);assert([root,subtree].includes(sha));v={sha,truncated:control.truncated,tree:trees[sha===root?'':'docs']};}
    else if(!gh&&route==='/repository/tree'){assert.equal(u.searchParams.get('ref'),commit);const page=control.repeatPages?1:Number(u.searchParams.get('page')),rs=trees[u.searchParams.get('path')];v=rs.slice((page-1)*100,page*100);}
    else throw Error('Unexpected source access '+route);
    return new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});
  };
  const client=(gh?githubClient:gitlabClient)(binding,async()=> 'synthetic-token-0123456789');
  return{binding,repo,trees,control,calls,root,subtree,read:(input={commit},who=actor,signal=AbortSignal.timeout(3000))=>client.sourceTree(who,input,signal),restore:()=>{globalThis.fetch=original;rmSync(dir,{recursive:true,force:true});}};
}
for(const provider of ['github','gitlab']){
  test(provider+' complete source inventory matches real Git tree objects and keeps links/submodules as metadata',async()=>{
    const f=fixture(provider);try{const v=await f.read();assert.equal(v.rootTreeId,f.root);assert.equal(v.commit,commit);assert.equal(v.entries.length,6);assert.equal(v.inventoryDigest,valueDigest(v.entries));assert.equal(v.entries.find(e=>e.path==='docs').objectId,f.subtree);assert.equal(v.entries.find(e=>e.path==='external').type,'commit');assert.equal(v.entries.find(e=>e.path==='readme-link').mode,'120000');assert.equal(v.contentRead,false);assert.equal(v.linksFollowed,false);assert.equal(v.sourceApproved,false);const{schema,factsDigest,observedAt,contentRead,linksFollowed,sourceApproved,...facts}=v;assert.equal(factsDigest,valueDigest(facts));assert.equal((await f.read()).factsDigest,factsDigest);assert(!f.calls.some(x=>/branches|contents|repository\/files/.test(x)));}finally{f.restore();}
  });
  test(provider+' scope, exact input and cancellation reject before provider access',async()=>{
    const f=fixture(provider);try{await assert.rejects(()=>f.read(undefined,{...actor,projects:['beta']}),{code:'FORBIDDEN'});for(const input of [{commit:'main'},{commit,extra:'ignored'}])await assert.rejects(()=>f.read(input));await assert.rejects(()=>f.read(undefined,actor,AbortSignal.abort()));assert.equal(f.calls.length,0);}finally{f.restore();}
  });
  test(provider+' wrong repository/commit cannot supply source inventory',async()=>{
    for(const mutate of [f=>f.repo.id=43,f=>f.control.commit='c'.repeat(40)]){const f=fixture(provider);try{mutate(f);await assert.rejects(()=>f.read());}finally{f.restore();}}
  });
  test(provider+' rejects duplicate, escaping, ambiguous and unsupported tree entries',async()=>{
    for(const mutate of [f=>f.trees[''].push(f.trees[''][0]),f=>f.trees[''][0].path='../secret',f=>f.trees[''][0].path='a/b',f=>f.trees[''][0].path='.git',f=>f.trees[''][0].mode='100666',f=>f.trees[''][0].type='tree',f=>f.trees[''][0][provider==='github'?'sha':'id']='x'.repeat(40)]){
      const f=fixture(provider);try{mutate(f);await assert.rejects(()=>f.read());}finally{f.restore();}
    }
  });
  test(provider+' independently reconstructs nested trees so omissions and changed identities fail',async()=>{
    for(const mutate of [f=>f.trees.docs.pop(),f=>f.trees.docs[0][provider==='github'?'sha':'id']='f'.repeat(40),f=>f.trees.docs[0].mode='100755']){
      const f=fixture(provider);try{mutate(f);await assert.rejects(()=>f.read(),{code:'SOURCE_TREE_INTEGRITY'});}finally{f.restore();}
    }
  });
}
test('GitHub complete root identity rejects omissions, truncation and reordered facts remain stable',async()=>{
  const f=fixture('github');try{const first=await f.read();f.trees[''].reverse();assert.equal((await f.read()).factsDigest,first.factsDigest);f.control.truncated=true;await assert.rejects(()=>f.read(),{code:'SOURCE_TREE_INCOMPLETE'});f.control.truncated=false;f.trees[''].pop();await assert.rejects(()=>f.read(),{code:'SOURCE_TREE_INTEGRITY'});}finally{f.restore();}
});
test('GitLab paginates complete directories including exactly full final pages',async()=>{
  const f=fixture('gitlab',1000);try{const v=await f.read();assert.equal(v.entries.length,1000);assert.equal(v.rootTreeId,f.root);assert(f.calls.some(c=>c.endsWith('page=11')));}finally{f.restore();}
});
test('GitLab nonterminating or overflowing directory pages fail without partial success',async()=>{
  const f=fixture('gitlab',1001);try{await assert.rejects(()=>f.read(),{code:'SOURCE_TREE_LIMIT'});f.control.repeatPages=true;await assert.rejects(()=>f.read(),{code:'SOURCE_TREE_LIMIT'});}finally{f.restore();}
});
test('GitLab rejects a child returned under a different parent',async()=>{
  const f=fixture('gitlab');try{f.trees.docs[0].path='elsewhere/a.md';await assert.rejects(()=>f.read(),{code:'SOURCE_TREE_PATH'});}finally{f.restore();}
});
