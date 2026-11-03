import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {githubClient} from '../../dist/adapters/github.js';
import {gitlabClient} from '../../dist/adapters/gitlab.js';
import {valueDigest,byteDigest} from '../../dist/lifecycle/base.js';

const actor={id:'reader',projects:['alpha'],permissions:['read'],revision:1,expiresAt:'2030-01-01T00:00:00Z'};
const base='a'.repeat(40),commit='b'.repeat(40),text='export const value = 7;\n',blob=createHash('sha1').update(Buffer.from('blob '+Buffer.byteLength(text)+'\0')).update(text).digest('hex');
function fixture(provider){
  const gh=provider==='github',binding={ref:'binding:alpha/source',workspaceId:'test',projectId:'alpha',provider,host:gh?'https://github.com':'https://gitlab.example.test',repository:'synthetic/project',repositoryId:'42',defaultBranch:'main',credentialRef:'credential:alpha/platform',revision:1,expiresAt:'2030-01-01T00:00:00Z',...(gh?{workflowPath:'.github/workflows/test.yml',runner:'ubuntu-latest'}:{pipelinePath:'.gitlab-ci.yml',runner:'56'})};
  const req={baselineCommit:base,commit,change:{kind:gh?'pull-request':'merge-request',id:'1'},artifacts:[{path:'src/output.mjs',digest:byteDigest(text),bytes:Buffer.byteLength(text)}]};
  const metadata=gh?{number:1,base:{repo:{id:42},ref:'main',sha:base},head:{repo:{id:42},ref:'task/source',sha:commit},state:'open',merged:false,draft:true,changed_files:2}:{iid:1,project_id:42,source_project_id:42,target_project_id:42,target_branch:'main',source_branch:'task/source',sha:commit,diff_refs:{base_sha:base,start_sha:base,head_sha:commit},state:'opened',draft:true,changes_count:'2'};
  const files=gh?[{filename:'src/output.mjs',status:'added'},{filename:'old.mjs',status:'removed'}]:[{old_path:'src/output.mjs',new_path:'src/output.mjs',a_mode:'0',b_mode:'100644',new_file:true,deleted_file:false,renamed_file:false,diff:'@@ ...'},{old_path:'old.mjs',new_path:'old.mjs',a_mode:'100644',b_mode:'0',new_file:false,deleted_file:true,renamed_file:false,diff:'@@ ...'}];
  const file=gh?{type:'file',path:'src/output.mjs',encoding:'base64',content:Buffer.from(text).toString('base64'),size:Buffer.byteLength(text),sha:blob}:{file_path:'src/output.mjs',commit_id:commit,encoding:'base64',content:Buffer.from(text).toString('base64'),size:Buffer.byteLength(text),blob_id:blob,content_sha256:byteDigest(text).slice(7)};
  const compare={status:'ahead',behind_by:0,base_commit:{sha:base},merge_base_commit:{sha:base}},control={overflow:false,branch:base,alter:null,parents:new Map(),parentCompare:null},calls=[],original=globalThis.fetch;let metadataReads=0;
  globalThis.fetch=async(url,options)=>{
    const u=new URL(url),prefix=gh?'/repos/synthetic/project':'/api/v4/projects/42',route=u.pathname.slice(prefix.length);calls.push({url:u.href,method:options.method??'GET'});assert.equal(u.origin,gh?'https://api.github.com':binding.host);assert(u.pathname.startsWith(prefix));assert.equal(options.method??'GET','GET');
    let value;
    if(route==='')value=gh?{id:42,full_name:binding.repository,default_branch:'main',archived:false}:{id:42,path_with_namespace:binding.repository,default_branch:'main',archived:false};
    else if(route===(gh?'/branches/main':'/repository/branches/main'))value={name:'main',commit:{[gh?'sha':'id']:control.branch}};
    else if(route===(gh?'/pulls/1':'/merge_requests/1')){metadataReads++;value=structuredClone(metadata);if(control.alter)control.alter(value,metadataReads);}
    else if(route.startsWith('/compare/'))value=route.startsWith('/compare/'+base)?compare:control.parentCompare;
    else if(route.startsWith('/repository/commits/'))value=control.parents.get(route.split('/').at(-1));
    else if(route==='/pulls/1/files'){const page=Number(u.searchParams.get('page'));value=files.slice((page-1)*100,page*100);}
    else if(route==='/merge_requests/1/changes')value={...metadata,overflow:control.overflow,changes:files};
    else if(route===(gh?'/contents/src/output.mjs':'/repository/files/src%2Foutput.mjs')){assert.equal(u.searchParams.get('ref'),commit);value=file;}
    else throw Error('Unexpected fixed route '+route);
    return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  };
  const client=(gh?githubClient:gitlabClient)(binding,async()=> 'synthetic-token-0123456789');
  return{binding,req,metadata,files,file,compare,control,calls,read:(input=req,who=actor,signal=AbortSignal.timeout(3000))=>client.source(who,input,signal),restore:()=>globalThis.fetch=original};
}

for(const provider of ['github','gitlab']){
  test(provider+' independently reads exact changed source and full deletion inventory without granting approval',async()=>{
    const f=fixture(provider);try{const v=await f.read();assert.equal(v.commit,commit);assert.equal(v.baselineCommit,base);assert.equal(v.bindingDigest,valueDigest(f.binding));assert.deepEqual(v.changes.map(x=>[x.path,x.status]),[['old.mjs','removed'],['src/output.mjs','added']]);assert.deepEqual(v.artifacts,f.req.artifacts);assert.equal(v.draft,true);assert.equal(v.sourceReviewApproved,false);assert.equal(v.ciVerified,false);assert.equal(v.releaseAuthorized,false);assert(f.calls.every(c=>c.method==='GET'));const{schema,evidenceRef,observedAt,factsDigest,sourceReviewApproved,ciVerified,releaseAuthorized,...facts}=v;assert.equal(factsDigest,valueDigest(facts));}finally{f.restore();}
  });
  test(provider+' rejects wrong repository, head, baseline and incomplete change counts',async()=>{
    for(const mutate of provider==='github'?[f=>f.metadata.head.repo.id=43,f=>f.metadata.base.repo.id=43,f=>f.metadata.head.sha='c'.repeat(40),f=>f.metadata.base.sha='c'.repeat(40),f=>f.metadata.changed_files=3]:[f=>f.metadata.source_project_id=43,f=>f.metadata.target_project_id=43,f=>f.metadata.sha='c'.repeat(40),f=>f.metadata.diff_refs.base_sha='c'.repeat(40),f=>f.metadata.changes_count='3',f=>f.metadata.changes_count='1000+']){
      const f=fixture(provider);try{mutate(f);await assert.rejects(()=>f.read(),e=>e.code.startsWith("SOURCE_"));assert(f.calls.every(c=>c.method==='GET'));}finally{f.restore();}
    }
  });
  test(provider+' rejects baseline and change movement during observation',async()=>{
    const f=fixture(provider);try{f.control.branch='c'.repeat(40);await assert.rejects(()=>f.read(),{code:'SOURCE_BASELINE_CHANGED'});f.control.branch=base;f.control.alter=(m,n)=>{if(n===2)m.draft=false;};await assert.rejects(()=>f.read(),{code:'SOURCE_CHANGE_CHANGED'});}finally{f.restore();}
  });
  test(provider+' verifies remote output bytes rather than trusting client hashes or provider metadata',async()=>{
    for(const mutate of [f=>f.file.content=Buffer.from('wrong').toString('base64'),f=>f.req.artifacts[0].digest=valueDigest('wrong'),f=>f.req.artifacts[0].bytes++,f=>f.file[provider==='github'?'sha':'blob_id']='f'.repeat(40),f=>f.req.artifacts[0].path='not-in-change.mjs']){
      const f=fixture(provider);try{mutate(f);await assert.rejects(()=>f.read(),e=>e.code.startsWith("SOURCE_"));}finally{f.restore();}
    }
  });
  test(provider+' rejects incomplete, duplicate and escaping file inventories',async()=>{
    for(const mutate of [f=>f.files.pop(),f=>f.files[1]=structuredClone(f.files[0]),f=>f.files[0][provider==='github'?'filename':'new_path']='../secret']){
      const f=fixture(provider);try{mutate(f);await assert.rejects(()=>f.read(),e=>e.code.startsWith("SOURCE_"));}finally{f.restore();}
    }
  });
  test(provider+' rejects unscoped, arbitrary and oversized input before any source request',async()=>{
    const f=fixture(provider);try{
      await assert.rejects(()=>f.read(f.req,{...actor,projects:['beta']}),{code:'FORBIDDEN'});
      for(const alter of [r=>r.url='https://other.test',r=>r.change.id='../2',r=>r.change.kind='other',r=>r.baselineCommit=commit,r=>r.artifacts[0].path='../secret',r=>r.artifacts[0].bytes=1048577,r=>r.artifacts.push(r.artifacts[0]),r=>r.artifacts=[]]){const r=structuredClone(f.req);alter(r);await assert.rejects(()=>f.read(r));}
      assert.equal(f.calls.length,0);
    }finally{f.restore();}
  });
  test(provider+' preserves empty regular file bytes and closed state without manufacturing PASS',async()=>{
    const f=fixture(provider);try{const empty=createHash('sha1').update(Buffer.from('blob 0\0')).digest('hex');f.req.artifacts[0]={...f.req.artifacts[0],bytes:0,digest:byteDigest('')};Object.assign(f.file,{size:0,content:'',[provider==='github'?'sha':'blob_id']:empty});if(provider==='gitlab')f.file.content_sha256=byteDigest('').slice(7);f.metadata.state='closed';const v=await f.read();assert.equal(v.state,'CLOSED');assert.equal(v.sourceReviewApproved,false);assert.equal(v.artifacts[0].bytes,0);}finally{f.restore();}
  });
}
test('GitHub complete file inventory pages past the first 100 files',async()=>{
  const f=fixture('github');try{for(let i=2;i<102;i++)f.files.push({filename:'extra-'+i+'.mjs',status:'modified'});f.metadata.changed_files=102;const v=await f.read();assert.equal(v.changes.length,102);assert(f.calls.some(c=>c.url.endsWith('/files?per_page=100&page=2')));}finally{f.restore();}
});
test('GitHub ancestry and regular-file constraints reject divergence, links and submodules',async()=>{
  for(const mutate of [f=>f.compare.status='diverged',f=>f.compare.merge_base_commit.sha='c'.repeat(40),f=>f.file.type='symlink',f=>f.file.submodule_git_url='https://other.test/submodule',f=>f.file.target='outside']){const f=fixture('github');try{mutate(f);await assert.rejects(()=>f.read(),e=>e.code.startsWith("SOURCE_"));}finally{f.restore();}}
});
test('GitLab 15 changes endpoint requires explicit no-overflow and supported regular-file modes',async()=>{
  for(const mutate of [f=>f.control.overflow=true,f=>f.control.overflow=undefined,f=>f.files[0].b_mode='120000',f=>f.files[0].b_mode='160000',f=>f.files[0].too_large=true,f=>f.files[0].collapsed=true,f=>f.files[0].deleted_file=true]){const f=fixture('gitlab');try{mutate(f);await assert.rejects(()=>f.read(),e=>e.code.startsWith("SOURCE_"));}finally{f.restore();}}
});

for(const provider of ['github','gitlab']){
  test(provider+' preparation ancestry retains original baseline and independently binds its input parent',async()=>{
    const f=fixture(provider),parent='c'.repeat(40),middle='d'.repeat(40);try{
      f.req.parentCommit=parent;f.control.parentCompare={status:'ahead',behind_by:0,base_commit:{sha:parent},merge_base_commit:{sha:parent}};
      f.control.parents.set(commit,{id:commit,parent_ids:[middle]});f.control.parents.set(middle,{id:middle,parent_ids:[parent]});
      const v=await f.read();assert.equal(v.baselineCommit,base);assert.equal(v.parentCommit,parent);assert.equal(v.commit,commit);assert.equal(v.sourceReviewApproved,false);
      assert(f.calls.some(c=>c.url.includes(provider==='github'?'/compare/'+parent:'/repository/commits/'+middle)));
      const n=f.calls.length;await assert.rejects(()=>f.read({...f.req,parentCommit:'../secret'}));assert.equal(f.calls.length,n);
      f.req.parentCommit=commit;const same=await f.read();assert.equal(same.parentCommit,commit);assert.equal(same.baselineCommit,base);
    }finally{f.restore();}
  });
  test(provider+' preparation ancestry rejects unrelated replacement even when the original baseline still matches',async()=>{
    const f=fixture(provider),parent='c'.repeat(40);try{f.req.parentCommit=parent;f.control.parentCompare={status:'diverged',behind_by:1,base_commit:{sha:parent},merge_base_commit:{sha:base}};f.control.parents.set(commit,{id:commit,parent_ids:[base]});f.control.parents.set(base,{id:base,parent_ids:[]});await assert.rejects(()=>f.read(),{code:'SOURCE_PARENT_MISMATCH'});}finally{f.restore();}
  });
}
test('GitLab ancestry follows merge parents and rejects mismatched, cyclic or unbounded evidence',async()=>{
  const parent='c'.repeat(40),middle='d'.repeat(40);
  for(const mutate of [f=>f.control.parents.set(commit,{id:middle,parent_ids:[parent]}),f=>f.control.parents.set(commit,{id:commit,parent_ids:[commit]}),f=>f.control.parents.set(commit,{id:commit,parent_ids:[middle]}),f=>f.control.parents.set(commit,{id:commit,parent_ids:Array.from({length:1001},(_,n)=>n.toString(16).padStart(40,'0'))})]){
    const f=fixture('gitlab');try{f.req.parentCommit=parent;f.control.parents.set(middle,{id:middle,parent_ids:[commit]});mutate(f);await assert.rejects(()=>f.read(),{code:'SOURCE_PARENT_MISMATCH'});}finally{f.restore();}
  }
  const f=fixture('gitlab');try{f.req.parentCommit=parent;f.control.parents.set(commit,{id:commit,parent_ids:[base,middle]});f.control.parents.set(base,{id:base,parent_ids:[]});f.control.parents.set(middle,{id:middle,parent_ids:[parent]});assert.equal((await f.read()).parentCommit,parent);}finally{f.restore();}
});
