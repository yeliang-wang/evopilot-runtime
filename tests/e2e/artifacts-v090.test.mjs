import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { readArtifactArchive, verifyCiArtifact, ciSourceDigest, ciBuildDigest } from '../../dist/adapters/artifacts.js';
import { byteDigest, valueDigest } from '../../dist/lifecycle/base.js';
import { platformReader } from '../../dist/adapters/platforms.js';

// Small independent ZIP fixture writer; product parsing uses pinned yauzl.
function zip(entries){
  const local=[],central=[];let offset=0;
  for(const raw of entries){const name=Buffer.from(raw.name),bytes=Buffer.from(raw.bytes??''),method=raw.deflate?8:0,data=method?deflateRawSync(bytes):bytes,crc=crc32(bytes),flags=raw.flags??0x800;
    const l=Buffer.alloc(30);l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt16LE(flags,6);l.writeUInt16LE(method,8);l.writeUInt32LE(crc,14);l.writeUInt32LE(data.length,18);l.writeUInt32LE(raw.declaredSize??bytes.length,22);l.writeUInt16LE(name.length,26);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(0x314,4);c.writeUInt16LE(20,6);c.writeUInt16LE(flags,8);c.writeUInt16LE(method,10);c.writeUInt32LE(raw.crc??crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(raw.declaredSize??bytes.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(((raw.mode??0o100644)<<16)>>>0,38);c.writeUInt32LE(offset,42);
    local.push(l,name,data);central.push(c,name);offset+=l.length+name.length+data.length;
  }
  const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,cd,end]);
}
const signal=()=>AbortSignal.timeout(5000);
function fixture(stageId='candidate'){
  const h=byteDigest('fixed'),request={schema:'runtime-ci-request/v1',requestId:'fixture',projectId:'alpha',bindingDigest:h,commit:'a'.repeat(40),workflowDigest:h,inputDigest:h,stageId,candidateDigest:stageId==='candidate'?null:h,requestedAt:new Date().toISOString(),deadlineAt:new Date(Date.now()+60000).toISOString()};
  const content=Buffer.from('synthetic package bytes'),evidence=Buffer.from('synthetic check evidence'),result={schema:'runtime-ci/v1',requestId:request.requestId,inputDigest:h,provider:'github',repositoryId:'42',runId:'23',sourceCommit:request.commit,workflowDigest:h,stageId,candidateDigest:request.candidateDigest,checks:[{id:'required.check',status:'PASS',evidence:[{path:'evidence/check.txt',digest:byteDigest(evidence),bytes:evidence.length}]}]};
  if(stageId==='candidate')result.candidate={schema:'runtime-candidate/v1',version:'1.0.0-rc.1',profile:'candidate-verification',sourceDigest:ciSourceDigest(request,'github','42'),buildDigest:ciBuildDigest(request,'23'),artifacts:[{name:'package.tgz',digest:byteDigest(content),bytes:content.length}]};
  const archive=(mutate=()=>{},extra=[])=>{const copy=structuredClone(result);mutate(copy);const bytes=zip([{name:'runtime-result.json',bytes:JSON.stringify(copy),deflate:true},{name:'evidence/check.txt',bytes:evidence},...(stageId==='candidate'?[{name:'artifacts/package.tgz',bytes:content}]:[]),...extra]);return{provider:'github',repositoryId:'42',requestId:request.requestId,inputDigest:h,bindingDigest:h,commit:request.commit,runId:'23',runStatus:'PASSED',artifactId:'99',jobId:null,name:'runtime-ci',archiveDigest:byteDigest(bytes),archiveBytes:bytes.length,bytes,evidenceRef:'https://github.com/synthetic/project/actions/runs/23/artifacts/99'};};
  return{request,result,archive};
}
test('ZIP collector verifies stored/deflated regular files without extracting or executing paths',async()=>{
  const entries=[{name:'evidence/',mode:0o040755},{name:'evidence/plain.txt',bytes:'one'},{name:'compressed.txt',bytes:'two'.repeat(100),deflate:true}];
  const files=await readArtifactArchive(zip(entries),signal());assert.equal(files.size,2);assert.equal(files.get('evidence/plain.txt').toString(),'one');assert.equal(files.get('compressed.txt').toString(),'two'.repeat(100));
});
test('ZIP traversal, backslashes, duplicate/case aliases and directory/file collisions are rejected',async()=>{
  for(const entries of [[{name:'../outside',bytes:'x'}],[{name:'/absolute',bytes:'x'}],[{name:'C:/outside',bytes:'x'}],[{name:'a\\b',bytes:'x'}],[{name:'a/./b',bytes:'x'}],[{name:'x',bytes:'one'},{name:'x',bytes:'two'}],[{name:'X',bytes:'one'},{name:'x',bytes:'two'}],[{name:'a',bytes:'x'},{name:'a/b',bytes:'y'}],[{name:'a/b',bytes:'y'},{name:'a',bytes:'x'}]])await assert.rejects(()=>readArtifactArchive(zip(entries),signal()),e=>['CI_ARCHIVE_PATH','CI_ARCHIVE_INVALID'].includes(e.code));
});
test('ZIP links, encrypted files, corrupt CRC, oversized expansion and incomplete bytes fail closed',async()=>{
  for(const entry of [{name:'link',bytes:'target',mode:0o120777},{name:'encrypted',bytes:'x',flags:1},{name:'corrupt',bytes:'x',crc:0},{name:'bomb',bytes:'x',deflate:true,declaredSize:268435457}])await assert.rejects(()=>readArtifactArchive(zip([entry]),signal()));
  const good=zip([{name:'file',bytes:'abc'}]);await assert.rejects(()=>readArtifactArchive(good.subarray(0,-5),signal()),{code:'CI_ARCHIVE_INVALID'});
  await assert.rejects(()=>readArtifactArchive(zip([]),signal()),{code:'CI_ARCHIVE_LIMIT'});
  await assert.rejects(()=>readArtifactArchive(good,AbortSignal.abort()));
});
test('verified CI artifact pins request/source/build and all bytes but does not grant owner or lifecycle acceptance',async()=>{
  const f=fixture(),r=await verifyCiArtifact(f.archive(),f.request,['required.check'],signal());
  assert.equal(r.status,'PASSED');assert.equal(r.artifactsVerified,true);assert.equal(r.ownerEvaluationsVerified,false);assert.equal(r.lifecycleAcceptance,false);assert.equal(r.candidate.version,'1.0.0-rc.1');assert.equal(r.files.length,3);assert.equal(r.archiveDigest,f.archive().archiveDigest);
});
test('CI result metadata and candidate source/build cannot substitute another original request',async()=>{
  const f=fixture();for(const [key,value] of [['requestId','another'],['inputDigest',byteDigest('different')],['provider','gitlab'],['repositoryId','43'],['runId','24'],['sourceCommit','b'.repeat(40)],['workflowDigest',byteDigest('other')],['stageId','publication'],['candidateDigest',byteDigest('candidate')]])await assert.rejects(()=>verifyCiArtifact(f.archive(r=>r[key]=value),f.request,['required.check'],signal()),{code:'CI_RESULT_MISMATCH'});
  for(const key of ['sourceDigest','buildDigest'])await assert.rejects(()=>verifyCiArtifact(f.archive(r=>r.candidate[key]=byteDigest('other')),f.request,['required.check'],signal()),{code:'CI_CANDIDATE_MISMATCH'});
  await assert.rejects(()=>verifyCiArtifact({...f.archive(),archiveDigest:byteDigest('changed')},f.request,['required.check'],signal()),{code:'CI_ARTIFACT_MISMATCH'});
});
test('missing/skipped/duplicate checks and altered, absent or undeclared files never pass',async()=>{
  const f=fixture();for(const mutate of [r=>r.checks=[],r=>r.checks.push(r.checks[0]),r=>r.checks[0].status='SKIPPED',r=>r.checks[0].id='extra',r=>r.checks[0].evidence=[]])await assert.rejects(()=>verifyCiArtifact(f.archive(mutate),f.request,['required.check'],signal()),{code:'CI_CHECK_SCOPE'});
  for(const mutate of [r=>r.checks[0].evidence[0].digest=byteDigest('bad'),r=>r.checks[0].evidence[0].path='evidence/missing',r=>r.candidate.artifacts[0].bytes++,r=>r.candidate.artifacts[0].digest=byteDigest('bad')])await assert.rejects(()=>verifyCiArtifact(f.archive(mutate),f.request,['required.check'],signal()),{code:'CI_ARTIFACT_INTEGRITY'});
  await assert.rejects(()=>verifyCiArtifact(f.archive(()=>{},[{name:'hidden.sh',bytes:'echo extra'}]),f.request,['required.check'],signal()),{code:'CI_ARTIFACT_UNDECLARED'});
});
test('failed/unknown CI evidence remains nonpassing and verification cannot replace candidate bytes',async()=>{
  const f=fixture();assert.equal((await verifyCiArtifact(f.archive(r=>r.checks[0].status='FAIL'),f.request,['required.check'],signal())).status,'FAILED');
  assert.equal((await verifyCiArtifact(f.archive(r=>r.checks[0].status='UNKNOWN'),f.request,['required.check'],signal())).status,'UNKNOWN');
  assert.equal((await verifyCiArtifact({...f.archive(),runStatus:'FAILED'},f.request,['required.check'],signal())).status,'FAILED');
  const verify=fixture('verification');assert.equal((await verifyCiArtifact(verify.archive(),verify.request,['required.check'],signal())).candidateDigest,verify.request.candidateDigest);
  await assert.rejects(()=>verifyCiArtifact(verify.archive(r=>r.candidate=f.result.candidate),verify.request,['required.check'],signal()),{code:'CI_CANDIDATE_MUTATION'});
});

const actor={id:'reader',projects:['alpha'],permissions:['read'],revision:1,expiresAt:'2030-01-01T00:00:00Z'};
const binding={ref:'binding:alpha/github',workspaceId:'test',projectId:'alpha',provider:'github',host:'https://github.com',repository:'synthetic/project',repositoryId:'42',defaultBranch:'main',credentialRef:'credential:alpha/github',runner:'ubuntu-latest',workflowPath:'.github/workflows/test.yml',revision:1,expiresAt:'2030-01-01T00:00:00Z'};
test('artifact transfer follows only authenticated GitHub storage redirect and never forwards credentials',async()=>{
  const old=globalThis.fetch,bytes=zip([{name:'file',bytes:'actual bytes'}]),calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url:String(url),options});if(calls.length===1){assert.match(options.headers.authorization,/^Bearer /);assert.equal(options.redirect,'manual');return new Response(null,{status:302,headers:{location:'https://productionresultsfixture.blob.core.windows.net/owned/archive?signature=synthetic'}});}assert.equal(options.headers,undefined);assert.equal(options.redirect,'error');return new Response(bytes,{headers:{'content-length':String(bytes.length)}});};
  try{const downloaded=await platformReader(binding,async()=> 'synthetic-token-0123456789').download(actor,'/actions/artifacts/99/zip',signal());assert.deepEqual(downloaded,bytes);assert.equal(calls.length,2);}finally{globalThis.fetch=old;}
});
test('artifact transfer rejects cross-provider redirects, arbitrary routes and oversized declared bodies',async()=>{
  const old=globalThis.fetch,reader=platformReader(binding,async()=> 'synthetic-token-0123456789');let calls=0;
  try{
    for(const location of ['http://productionresultsfixture.blob.core.windows.net/a','https://evil.test/secret','https://user:secret@productionresultsfixture.blob.core.windows.net/a','https://productionresultsfixture.blob.core.windows.net.evil.test/a']){
      calls=0;globalThis.fetch=async()=>{calls++;return new Response(null,{status:302,headers:{location}});};await assert.rejects(()=>reader.download(actor,'/actions/artifacts/99/zip',signal()),e=>e.code==='CI_ARTIFACT_REDIRECT'&&!e.message.includes('secret'));assert.equal(calls,1);
    }
    await assert.rejects(()=>reader.download(actor,'/releases/99',signal()),{code:'INVALID_PLATFORM_ROUTE'});
    globalThis.fetch=async()=>new Response('small',{headers:{'content-length':'134217729'}});await assert.rejects(()=>reader.download(actor,'/actions/artifacts/99/zip',signal()),{code:'CI_ARCHIVE_LIMIT'});
    globalThis.fetch=async()=>new Response('small',{headers:{'content-length':'20'}});await assert.rejects(()=>reader.download(actor,'/actions/artifacts/99/zip',signal()),{code:'CI_ARTIFACT_INTEGRITY'});
  }finally{globalThis.fetch=old;}
});
