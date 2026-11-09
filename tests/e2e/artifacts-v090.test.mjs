import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readArtifactArchive, verifyCiArtifact, validateCandidateInput, ciSourceDigest, ciBuildDigest, inspectCiAcceptanceReport, CI_ACCEPTANCE_REPORT_PATH } from '../../dist/adapters/artifacts.js';
import { byteDigest, valueDigest } from '../../dist/lifecycle/base.js';
import { platformReader, ciInputs, validateRunRequest } from '../../dist/adapters/platforms.js';

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
  if(stageId==='verification'){
    const manifest={schema:'runtime-candidate/v1',version:'1.0.0-rc.1',profile:'candidate-verification',sourceDigest:ciSourceDigest(request,'github','42'),buildDigest:ciBuildDigest(request,'22'),artifacts:[{name:'package.tgz',digest:byteDigest(content),bytes:content.length}]};
    request.candidateDigest=valueDigest(manifest);result.candidateDigest=request.candidateDigest;
    request.candidateInput={schema:'runtime-ci-candidate-input/v1',manifest,archive:{provider:'github',repositoryId:'42',runId:'22',artifactId:'98',jobId:null,archiveDigest:byteDigest('original archive'),archiveBytes:1000}};
    result.candidateConsumption={inputDigest:valueDigest(request.candidateInput),artifacts:manifest.artifacts};
  }
  const archive=(mutate=()=>{},extra=[])=>{const copy=structuredClone(result);mutate(copy);const bytes=zip([{name:'runtime-result.json',bytes:JSON.stringify(copy),deflate:true},{name:'evidence/check.txt',bytes:evidence},...(stageId==='candidate'?[{name:'artifacts/package.tgz',bytes:content}]:[{name:'candidate/package.tgz',bytes:content}]),...extra]);return{provider:'github',repositoryId:'42',requestId:request.requestId,inputDigest:h,bindingDigest:h,commit:request.commit,runId:'23',runStatus:'PASSED',artifactId:'99',jobId:null,name:'runtime-ci',archiveDigest:byteDigest(bytes),archiveBytes:bytes.length,bytes,evidenceRef:'https://github.com/synthetic/project/actions/runs/23/artifacts/99'};};
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
// Synthetic report bytes exercise capture integrity, not actual acceptance or
// collector semantic approval. All source and provider facts below are fixtures.
async function acceptanceFixture({provider='github',mutateReport=()=>{},mutateProof=()=>{},mutateFiles=()=>{}}={}){
  const f=fixture(),workflow=Buffer.from('fixed'),collector=Buffer.from('synthetic collector'),entries=[{name:'evidence/workflow.txt',bytes:workflow},{name:'evidence/collector.txt',bytes:collector}],pin=e=>({path:e.name,digest:byteDigest(e.bytes),bytes:e.bytes.length});
  const candidate={...f.result.candidate,sourceDigest:ciSourceDigest(f.request,provider,'42')};
  const report={schema:'runtime-ci-acceptance-report/v1',requestId:f.request.requestId,inputDigest:f.request.inputDigest,sourceCommit:f.request.commit,workflowDigest:f.request.workflowDigest,candidateDigest:valueDigest(candidate),requirementsDigest:byteDigest('requirements'),producerJobId:'71',workflow:{sourcePath:'.github/workflows/test.yml',file:pin(entries[0])},collector:{sourcePath:'tests/collector.mjs',file:pin(entries[1])},cases:['PASS','FAIL','NOT_RUN','CANCELLED','UNKNOWN','SKIPPED'].map((outcome,i)=>{const entry={name:'evidence/case-'+i+'.json',bytes:Buffer.from(' {"synthetic":true,"outcome":"'+outcome+'"}\r\n')};entries.push(entry);return{caseId:'CASE.'+i,outcome,rawReceipt:pin(entry)};})};
  mutateReport(report);entries.push({name:CI_ACCEPTANCE_REPORT_PATH,bytes:Buffer.from(JSON.stringify(report))});mutateFiles(entries);
  const archive={...f.archive(r=>{r.provider=provider;r.candidate=candidate;r.checks[0].evidence.push(...entries.map(pin));},entries),provider,jobId:provider==='gitlab'?'71':null,artifactId:provider==='gitlab'?'71':'99'};
  const jobs=[{jobId:'71',provider,repositoryId:'42',projectId:'alpha',runId:'23',commit:f.request.commit,status:'PASSED',providerStatus:'success',runnerId:'1'}];
  const proof={run:{requestId:f.request.requestId,inputDigest:f.request.inputDigest,provider,repositoryId:'42',commit:f.request.commit,runId:'23',jobs},workflowPath:'.github/workflows/test.yml',requirementsDigest:byteDigest('requirements'),sourceTree:{commit:f.request.commit,provider,repositoryId:'42',projectId:'alpha',bindingDigest:f.request.bindingDigest,contentRead:false,sourceApproved:false,entries:[{path:'.github/workflows/test.yml',type:'blob',mode:'100644',objectId:createHash('sha1').update(Buffer.from('blob '+workflow.length+'\0')).update(workflow).digest('hex')},{path:'tests/collector.mjs',type:'blob',mode:'100644',objectId:createHash('sha1').update(Buffer.from('blob '+collector.length+'\0')).update(collector).digest('hex')}]}};
  proof.sourceTree.inventoryDigest=valueDigest(proof.sourceTree.entries);mutateProof(proof);
  const verified=await verifyCiArtifact(archive,f.request,['required.check'],signal());
  return{archive,request:f.request,verified,proof,capture:()=>inspectCiAcceptanceReport(archive,f.request,verified,proof,signal())};
}
test('optional acceptance report absence leaves existing runtime-ci artifacts valid and explicitly unavailable',async()=>{
  const f=fixture(),archive=f.archive(),verified=await verifyCiArtifact(archive,f.request,['required.check'],signal());
  const captured=await inspectCiAcceptanceReport(archive,f.request,verified,{run:{jobs:[]},workflowPath:'.github/workflows/test.yml',requirementsDigest:byteDigest('requirements')},signal());
  assert.equal(verified.status,'PASSED');assert.equal(captured.status,'ABSENT');assert.deepEqual(captured.cases,[]);assert.deepEqual(captured.reasons,['REPORT_ABSENT']);
});
test('original CI capture preserves six raw outcomes and exact raw-byte references without asserting approval',async()=>{
  for(const provider of ['github','gitlab']){
    const f=await acceptanceFixture({provider}),captured=await f.capture(),files=await readArtifactArchive(f.archive.bytes,signal());
    assert.equal(captured.status,'OBSERVED');assert.equal(captured.producerBinding,'MATCHED_ORIGINAL_JOB');assert.equal(captured.producerJobId,'71');assert.equal(captured.workflowSource,'COMMITTED_BYTES_MATCHED');assert.equal(captured.collectorSource,'COMMITTED_BYTES_MATCHED');assert.equal(captured.collectorSemanticApproval,'UNKNOWN');assert.equal(captured.caseCatalog,'UNKNOWN');
    assert.deepEqual(captured.cases.map(c=>c.observedOutcome),['PASS','FAIL','NOT_RUN','CANCELLED','UNKNOWN','SKIPPED']);
    for(const c of captured.cases){assert.equal(byteDigest(files.get(c.rawReceipt.path)),c.rawReceipt.digest);assert(files.get(c.rawReceipt.path).toString().endsWith('\r\n'));assert.equal(c.rawReceipt.rawText,undefined);}
  }
});
test('foreign acceptance identities, reused labels, duplicate cases and invalid raw receipts stay nonqualifying',async()=>{
  for(const mutateReport of [r=>r.requestId='foreign',r=>r.sourceCommit='b'.repeat(40),r=>r.candidateDigest=byteDigest('foreign'),r=>r.requirementsDigest=byteDigest('other'),r=>r.cases[0].outcome='PASS_REUSED',r=>r.cases.push(r.cases[0]),r=>r.cases[0].rawReceipt.digest=byteDigest('drift'),r=>r.cases[0].rawReceipt.path='evidence/absent.json',r=>r.cases[1].rawReceipt=r.cases[0].rawReceipt]){
    const f=await acceptanceFixture({mutateReport}),captured=await f.capture();assert.equal(captured.status,'INVALID');assert.deepEqual(captured.cases,[]);assert(captured.report.digest);
  }
});
test('self-consistent changed raw bytes cannot use a stale per-case receipt pin',async()=>{
  const f=await acceptanceFixture({mutateFiles:entries=>{entries.find(e=>e.name==='evidence/case-0.json').bytes=Buffer.from('changed after report capture');}});
  assert.equal((await f.capture()).status,'INVALID');
});
test('GitHub multiple-job or foreign-job claims never establish an uploader identity',async()=>{
  for(const mutateProof of [p=>p.run.jobs.push({...p.run.jobs[0],jobId:'72'}),p=>p.run.jobs[0].jobId='72',p=>p.run.runId='24']){
    const f=await acceptanceFixture({mutateProof}),captured=await f.capture();assert.equal(captured.status,'OBSERVED');assert.equal(captured.producerBinding,'UNVERIFIED');assert.equal(captured.producerJobId,null);assert(captured.reasons.includes('PRODUCER_JOB_UNVERIFIED'));
  }
});
test('collector/report hashes never replace protected committed source pins or semantic approval',async()=>{
  for(const mutateProof of [p=>delete p.sourceTree,p=>p.sourceTree.entries[1].objectId='f'.repeat(40),p=>p.sourceTree.sourceApproved=true,p=>p.workflowPath='different.yml']){
    const f=await acceptanceFixture({mutateProof}),captured=await f.capture();assert.equal(captured.status,'OBSERVED');assert(captured.workflowSource==='UNVERIFIED'||captured.collectorSource==='UNVERIFIED');assert.equal(captured.collectorSemanticApproval,'UNKNOWN');
  }
  const f=await acceptanceFixture({mutateFiles:entries=>{entries.find(e=>e.name===CI_ACCEPTANCE_REPORT_PATH).bytes=Buffer.from('{');}});assert.equal((await f.capture()).status,'INVALID');
});
test('verification requires original candidate input and exact consumed-artifact inventory',async()=>{
  const f=fixture('verification'),missing={...f.request};delete missing.candidateInput;
  await assert.rejects(()=>verifyCiArtifact(f.archive(),missing,['required.check'],signal()),{code:'CI_CANDIDATE_INPUT_REQUIRED'});
  for(const change of [r=>delete r.candidateConsumption,r=>r.candidateConsumption.inputDigest=byteDigest('another archive'),r=>r.candidateConsumption.artifacts=[],r=>r.candidateConsumption.artifacts[0].digest=byteDigest('rebuilt')])await assert.rejects(()=>verifyCiArtifact(f.archive(change),f.request,['required.check'],signal()));
  const files=await readArtifactArchive(f.archive().bytes,signal());
  for(const altered of [null,Buffer.from('rebuilt bytes')]){
    const entries=[...files].filter(([name])=>name!=='candidate/package.tgz').map(([name,bytes])=>({name,bytes}));if(altered)entries.push({name:'candidate/package.tgz',bytes:altered});
    const bytes=zip(entries),archive={...f.archive(),bytes,archiveBytes:bytes.length,archiveDigest:byteDigest(bytes)};
    await assert.rejects(()=>verifyCiArtifact(archive,f.request,['required.check'],signal()),{code:'CI_ARTIFACT_INTEGRITY'});
  }
});
test('candidate delivery rejects different provider/repository/source, ambiguous IDs and arbitrary URLs',()=>{
  const f=fixture('verification');
  for(const change of [v=>v.archive.repositoryId='43',v=>v.archive.provider='gitlab',v=>v.archive.jobId='99',v=>v.archive.artifactId='../latest',v=>v.archive.archiveBytes=129*1024*1024,v=>v.archive.url='https://elsewhere.invalid/archive',v=>v.manifest.sourceDigest=byteDigest('another source')]){
    const value=structuredClone(f.request.candidateInput);change(value);assert.throws(()=>validateCandidateInput(value,f.request,'github','42'));
  }
  const gl=structuredClone(f.request.candidateInput);Object.assign(gl.archive,{provider:'gitlab',artifactId:'98',jobId:'98'});gl.manifest.sourceDigest=ciSourceDigest(f.request,'gitlab','42');const request={...f.request,candidateDigest:valueDigest(gl.manifest)};assert.equal(validateCandidateInput(gl,request,'gitlab','42'),gl);
  gl.archive.jobId='97';assert.throws(()=>validateCandidateInput(gl,request,'gitlab','42'),{code:'CI_CANDIDATE_INPUT_INVALID'});
});
test('CI dispatch correlates the bounded candidate input and rejects digest-only verification',()=>{
  const f=fixture('verification'),p={ref:'binding:alpha/github',workspaceId:'test',projectId:'alpha',provider:'github',host:'https://github.com',repository:'synthetic/project',repositoryId:'42',defaultBranch:'main',credentialRef:'credential:alpha/github',workflowPath:'.github/workflows/test.yml',runner:'ubuntu-latest',revision:1,expiresAt:'2030-01-01T00:00:00Z'};
  f.request.bindingDigest=valueDigest(p);assert.equal(validateRunRequest(f.request,p).candidateInput.archive.artifactId,'98');assert.deepEqual(JSON.parse(ciInputs(f.request).runtime_candidate_input),f.request.candidateInput);
  const missing={...f.request};delete missing.candidateInput;assert.throws(()=>validateRunRequest(missing,p),{code:'CI_CANDIDATE_INPUT_REQUIRED'});
  const candidate=fixture();assert.equal(ciInputs(candidate.request).runtime_candidate_input,'none');
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

test('preparation archive binds exact input and every prepared file but still needs independent provider and owner validation',async()=>{
 const f=fixture('candidate'),content=Buffer.from('generated source'),evidence=Buffer.from('preparation evidence');f.request.stageId='project.prepare';f.request.preparationInput={schema:'runtime-ci-preparation-input/v1',baselineCommit:'b'.repeat(40),parentCommit:f.request.commit,change:{kind:'pull-request',id:'1'},requirementsDigest:byteDigest('requirements')};
 const output={schema:'runtime-ci-preparation-output/v1',inputDigest:valueDigest(f.request.preparationInput),source:{commit:'c'.repeat(40),change:{kind:'pull-request',id:'1'},artifacts:[{path:'generated.ts',digest:byteDigest(content),bytes:content.length}]}};
 const result={...f.result,stageId:'project.prepare',preparationOutput:output,checks:[{id:'required.check',status:'PASS',evidence:[{path:'evidence/preparation.txt',digest:byteDigest(evidence),bytes:evidence.length}]}]};delete result.candidate;
 const archive=(mutate=()=>{},source=content)=>{const r=structuredClone(result);mutate(r);const bytes=zip([{name:'runtime-result.json',bytes:JSON.stringify(r)},{name:'evidence/preparation.txt',bytes:evidence},{name:'prepared-source/generated.ts',bytes:source}]);return{...f.archive(),bytes,archiveDigest:byteDigest(bytes),archiveBytes:bytes.length};};
 const checked=await verifyCiArtifact(archive(),f.request,['required.check'],signal());assert.deepEqual(checked.preparationOutput,output);assert.equal(checked.candidate,null);assert.equal(checked.ownerEvaluationsVerified,false);assert.equal(checked.lifecycleAcceptance,false);
 for(const mutate of [r=>delete r.preparationOutput,r=>r.preparationOutput.inputDigest=byteDigest('another input'),r=>r.preparationOutput.source.artifacts[0].digest=byteDigest('wrong'),r=>r.candidate=f.result.candidate])await assert.rejects(()=>verifyCiArtifact(archive(mutate),f.request,['required.check'],signal()));
 await assert.rejects(()=>verifyCiArtifact(archive(()=>{},Buffer.from('different')),f.request,['required.check'],signal()),{code:'CI_ARTIFACT_INTEGRITY'});
 const ordinary={...f.request};delete ordinary.preparationInput;await assert.rejects(()=>verifyCiArtifact(archive(),ordinary,['required.check'],signal()),{code:'CI_PREPARATION_OUTPUT'});
});

// Synthetic modern dyld layout only: no system cache is opened by these tests.
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openLc20ObservationScope,acquireLc20CacheBytes,readLc20DyldLayout} from '../../dist/adapters/artifacts.js';
function dyldFixture(t){
 const root=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'lc20-cache-fixture-'));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const main=join(root,'dyld_shared_cache_arm64e'),sub=main+'.01',base=0x100000000,length=8192,paths=['/usr/lib/dyld','/usr/lib/libSystem.B.dylib'];
 const header=(address,uuid)=>{const b=Buffer.alloc(length);b.write('dyld_v1  arm64e');b.writeUInt32LE(552,16);b.writeUInt32LE(1,20);b.writeBigUInt64LE(BigInt(length),40);Buffer.alloc(16,uuid).copy(b,88);b.writeUInt32LE(1,216);b.writeBigUInt64LE(BigInt(address),552);b.writeBigUInt64LE(BigInt(length),560);b.writeUInt32LE(5,576);b.writeUInt32LE(5,580);return b;};
 const macho=(b,offset,address,type)=>{b.writeUInt32LE(0xfeedfacf,offset);b.writeUInt32LE(0x100000c,offset+4);b.writeUInt32LE(type,offset+12);b.writeUInt32LE(1,offset+16);b.writeUInt32LE(72,offset+20);b.writeUInt32LE(0x19,offset+32);b.writeUInt32LE(72,offset+36);b.write('__TEXT',offset+40);b.writeBigUInt64LE(BigInt(address),offset+56);b.writeBigUInt64LE(128n,offset+64);b.writeBigUInt64LE(128n,offset+80);};
 const a=header(base,1),b=header(base+length,2);a.writeBigUInt64LE(BigInt(base+4096),120);a.writeUInt32LE(1536,392);a.writeUInt32LE(1,396);Buffer.alloc(16,2).copy(a,1536);a.writeBigUInt64LE(BigInt(length),1552);a.write('.01',1560);a.writeUInt32LE(1024,448);a.writeUInt32LE(1,452);a.writeBigUInt64LE(BigInt(base+length+4096),1024);a.writeUInt32LE(2048,1048);a.write(paths[1],2048);macho(a,4096,base+4096,7);macho(b,4096,base+length+4096,6);
 const save=()=>{fs.writeFileSync(main,a,{mode:0o600});fs.writeFileSync(sub,b,{mode:0o600});};save();return{root,main,sub,a,b,paths,save};
}
async function cacheProof(f,body){const controller=new AbortController(),scope=openLc20ObservationScope(controller.signal);try{return await scope.run(async()=>{const proof=await acquireLc20CacheBytes(f.main,f.paths,controller.signal);return body?body(proof,scope,controller):structuredClone(proof);});}finally{scope.close();await scope.drain();}}
test('Darwin proof hashes every complete main/subcache byte and maps actual logical images including special dyld',async t=>{
 const f=dyldFixture(t),proof=await cacheProof(f);assert.equal(proof.basis,'PROCESS_PATHS_CURRENT_SYSTEM_FILES');assert.deepEqual(proof.files.map(x=>[x.path,x.digest,x.bytes]),[f.main,f.sub].map(path=>[path,byteDigest(fs.readFileSync(path)),8192]));assert.deepEqual(proof.images.map(x=>[x.logicalPath,x.source]),[[f.paths[0],'DYLD_HEADER'],[f.paths[1],'IMAGE_TABLE']]);
 const first=proof.files[1].digest;f.b[7000]=17;f.save();const next=await cacheProof(f);assert.equal(next.onDiskCacheUuid,proof.onDiskCacheUuid);assert.notEqual(next.files[1].digest,first,'Fresh request hashes changed bytes despite unchanged UUID');
});
test('Darwin parser rejects missing images, mismatched UUID, unsafe suffix, unsupported header and uncovered image segments',async t=>{
 for(const mutate of [f=>f.a[1536]=9,f=>f.a.write('../x\0',1560),f=>f.a.writeUInt32LE(560,16),f=>f.a.writeUInt32LE(65537,452),f=>f.a.writeUInt32LE(16,396),f=>f.a.writeBigUInt64LE(0xffffffffffffffffn,1024),f=>f.b.writeBigUInt64LE(9000n,4096+80),f=>f.a.writeBigUInt64LE(0n,120)]){const f=dyldFixture(t);mutate(f);f.save();await assert.rejects(cacheProof(f),{code:'LC20_RUNTIME_INPUT_UNKNOWN'});}
 const f=dyldFixture(t);f.paths.push('/usr/lib/not-in-cache.dylib');await assert.rejects(cacheProof(f),{code:'LC20_RUNTIME_INPUT_UNKNOWN'});
});
test('Darwin open-descriptor proof rejects mutation, path replacement, symlinks and parent retargeting',async t=>{
 for(const change of [f=>{fs.writeFileSync(f.sub,Buffer.alloc(8192),{mode:0o600});},f=>{fs.renameSync(f.sub,f.sub+'.old');fs.writeFileSync(f.sub,f.b,{mode:0o600});},f=>{fs.renameSync(f.sub,f.sub+'.old');fs.symlinkSync(f.sub+'.old',f.sub);}]){const f=dyldFixture(t);await cacheProof(f,async(_proof,_scope,controller)=>{change(f);await assert.rejects(acquireLc20CacheBytes(f.main,f.paths,controller.signal),{code:'LC20_RUNTIME_INPUT_UNKNOWN'});});}
});
test('Darwin acquisition has one active slot, no queue, and cancellation releases resources before the next acquisition',async t=>{
 const f=dyldFixture(t),controller=new AbortController(),first=openLc20ObservationScope(controller.signal),second=openLc20ObservationScope(new AbortController().signal);
 try{const pending=first.run(()=>acquireLc20CacheBytes(f.main,f.paths,controller.signal));await assert.rejects(second.run(()=>acquireLc20CacheBytes(f.main,f.paths,new AbortController().signal)),/busy/);controller.abort();await assert.rejects(pending,{code:'LC20_RUNTIME_INPUT_UNKNOWN'});assert.throws(()=>first.run(()=>{}),{code:'LC20_RUNTIME_INPUT_UNKNOWN'});}finally{first.close();second.close();await first.drain();await second.drain();}
 assert.equal((await cacheProof(f)).files.length,2);
});
test('Darwin scopes expire even when an acquired result is never consumed and reject any later guard',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=dyldFixture(t),scope=openLc20ObservationScope(new AbortController().signal);
 try{await scope.run(()=>acquireLc20CacheBytes(f.main,f.paths,new AbortController().signal));t.mock.timers.tick(12000);assert.throws(()=>scope.run(()=>{}),{code:'LC20_RUNTIME_INPUT_UNKNOWN'});}finally{scope.close();await scope.drain();}
});
test('Darwin parser uses finite checked binary ranges and never accepts an arbitrary header-only UUID',async t=>{
 const f=dyldFixture(t),files=new Map([[f.main,f.a],[f.sub,f.b]]),read=async(p,o,n)=>files.get(p).subarray(o,o+n),size=async p=>files.get(p).length;
 const result=await readLc20DyldLayout(f.main,f.paths,read,size);assert.deepEqual(result.members,[f.main,f.sub]);
 f.a.writeUInt32LE(9000,448);await assert.rejects(readLc20DyldLayout(f.main,f.paths,read,size),{code:'LC20_RUNTIME_INPUT_UNKNOWN'});
});
test('nested consumers borrow one open cache proof but a new root request performs fresh acquisition',async t=>{
 const f=dyldFixture(t);await cacheProof(f,async(proof,_parent,controller)=>{const nested=openLc20ObservationScope(controller.signal);try{assert.equal(await nested.run(()=>acquireLc20CacheBytes(f.main,f.paths,controller.signal)),proof);}finally{nested.close();}assert.equal(await acquireLc20CacheBytes(f.main,f.paths,controller.signal),proof,'Borrowed close must not close parent descriptors');});
 assert.equal((await cacheProof(f)).files.length,2);
});

import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
test('unused observation scopes do not impose the cache lifetime on unrelated work',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const scope=openLc20ObservationScope(new AbortController().signal);
 try{t.mock.timers.tick(13000);assert.equal(scope.cacheDependent(),false);assert.equal(scope.run(()=>42),42);}finally{await scope.drain();}
});
test('cache slot remains occupied until every delayed close drains after failure and success',async t=>{
 for(const bad of [true,false]){
  const f=dyldFixture(t),originalOpen=fsPromises.open,pending=[];let completed=0;
  fsPromises.open=async(...args)=>{const h=await originalOpen(...args),close=h.close;h.close=()=>new Promise((resolve,reject)=>pending.push(async()=>{try{await close.call(h);completed++;resolve();}catch(e){reject(e);}}));return h;};syncBuiltinESMExports();
  const first=openLc20ObservationScope(new AbortController().signal),next=openLc20ObservationScope(new AbortController().signal);
  try{if(bad){f.a[0]=0;f.save();await assert.rejects(first.run(()=>acquireLc20CacheBytes(f.main,f.paths,new AbortController().signal)));}else await first.run(()=>acquireLc20CacheBytes(f.main,f.paths,new AbortController().signal));
   first.close();let drained=false;const drain=first.drain().then(()=>{drained=true;});await new Promise(setImmediate);assert.equal(pending.length,bad?1:2);assert.equal(drained,false);
   await assert.rejects(next.run(()=>acquireLc20CacheBytes(f.main,f.paths,new AbortController().signal)),/busy/);
   fsPromises.open=originalOpen;syncBuiltinESMExports();for(const close of pending.splice(0))await close();await drain;assert.equal(completed,bad?1:2);f.a[0]=100;f.save();assert.equal((await next.run(()=>acquireLc20CacheBytes(f.main,f.paths,new AbortController().signal))).files.length,2);
  }finally{fsPromises.open=originalOpen;syncBuiltinESMExports();for(const close of pending.splice(0))await close();first.close();next.close();await first.drain();await next.drain();}
 }
});
test('retained proof does not own the acquisition slot and its old cleanup cannot release a newer owner',async t=>{
 const f=dyldFixture(t),originalOpen=fsPromises.open,delayedClose=[];let phase='retained',resumeRead;
 fsPromises.open=async(...args)=>{const h=await originalOpen(...args);if(phase==='retained'){const close=h.close;h.close=()=>new Promise((resolve,reject)=>delayedClose.push(async()=>{try{await close.call(h);resolve();}catch(error){reject(error);}}));}else if(phase==='reading'){const read=h.read;let first=true;h.read=async(...args)=>{if(first){first=false;await new Promise(resolve=>{resumeRead=resolve;});}return read.apply(h,args);};}return h;};syncBuiltinESMExports();
 const signal=new AbortController().signal,old=openLc20ObservationScope(signal),active=openLc20ObservationScope(signal),next=openLc20ObservationScope(signal);let pending;
 try{
  await old.run(()=>acquireLc20CacheBytes(f.main,f.paths,signal));phase='reading';pending=active.run(()=>acquireLc20CacheBytes(f.main,f.paths,signal));while(!resumeRead)await new Promise(setImmediate);
  phase='normal';old.close();const draining=old.drain();await new Promise(setImmediate);assert.equal(delayedClose.length,2);await assert.rejects(next.run(()=>acquireLc20CacheBytes(f.main,f.paths,signal)),/busy/);
  for(const close of delayedClose.splice(0))await close();await draining;await assert.rejects(next.run(()=>acquireLc20CacheBytes(f.main,f.paths,signal)),/busy/,'Old cleanup must not clear the newer active owner');
  resumeRead();await pending;pending=null;assert.equal((await next.run(()=>acquireLc20CacheBytes(f.main,f.paths,signal))).files.length,2,'A retained successful proof is not active acquisition I/O');
 }finally{fsPromises.open=originalOpen;syncBuiltinESMExports();resumeRead?.();if(pending)await pending.catch(()=>{});for(const close of delayedClose.splice(0))await close();await old.drain();await active.drain();await next.drain();}
});
test('cancelled pending read drains before descriptor close and before any successor acquisition',async t=>{
 const f=dyldFixture(t),originalOpen=fsPromises.open;let resumeRead,closes=0;
 fsPromises.open=async(...args)=>{const h=await originalOpen(...args),read=h.read,close=h.close;let first=true;h.read=async(...args)=>{if(first){first=false;await new Promise(resolve=>{resumeRead=resolve;});}return read.apply(h,args);};h.close=async()=>{closes++;await close.call(h);};return h;};syncBuiltinESMExports();
 const controller=new AbortController(),first=openLc20ObservationScope(controller.signal),next=openLc20ObservationScope(new AbortController().signal);let pending;
 try{pending=first.run(()=>acquireLc20CacheBytes(f.main,f.paths,controller.signal));while(!resumeRead)await new Promise(setImmediate);controller.abort();const draining=first.drain();await new Promise(setImmediate);assert.equal(closes,0);await assert.rejects(next.run(()=>acquireLc20CacheBytes(f.main,f.paths,new AbortController().signal)),/busy/);
  fsPromises.open=originalOpen;syncBuiltinESMExports();resumeRead();await assert.rejects(pending,{code:'LC20_RUNTIME_INPUT_UNKNOWN'});pending=null;await draining;assert.equal(closes,1);assert.equal((await next.run(()=>acquireLc20CacheBytes(f.main,f.paths,new AbortController().signal))).files.length,2);
 }finally{fsPromises.open=originalOpen;syncBuiltinESMExports();resumeRead?.();if(pending)await pending.catch(()=>{});await first.drain();await next.drain();}
});
