// Deliberately synthetic integrity/authenticator fixtures. These tests do not
// constitute real source CI, installed acceptance, a human decision or release.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {crc32} from 'node:zlib';
import {RUNTIME_RELEASE_ASSETS,inspectRuntimeReleaseCandidate,prepareRuntimeRelease,verifyRuntimeReleaseDecision,verifyRuntimeReleaseGovernanceCurrent} from '../../dist/release/gate.js';

const repository=fileURLToPath(new URL('../../',import.meta.url)),sha=value=>createHash('sha256').update(value).digest('hex');
const signal=()=>AbortSignal.timeout(30000);
function zip(files){
 const local=[],central=[];let offset=0;
 for(const [key,value]of files){const name=Buffer.from(key),bytes=Buffer.from(value),crc=crc32(bytes),l=Buffer.alloc(30),c=Buffer.alloc(46);
  l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt32LE(crc,14);l.writeUInt32LE(bytes.length,18);l.writeUInt32LE(bytes.length,22);l.writeUInt16LE(name.length,26);
  c.writeUInt32LE(0x02014b50);c.writeUInt16LE(0x314,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc,16);c.writeUInt32LE(bytes.length,20);c.writeUInt32LE(bytes.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE((0o100644<<16)>>>0,38);c.writeUInt32LE(offset,42);
  local.push(l,name,bytes);central.push(c,name);offset+=30+name.length+bytes.length;
 }
 const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.size,8);end.writeUInt16LE(files.size,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,cd,end]);
}
function fixture(t,changeGovernance){
 const root=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'runtime-release-gate-')),source=join(root,'source'),evidence=join(root,'private');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(source);fs.mkdirSync(evidence,{mode:0o700});
 const put=(file,value)=>{fs.mkdirSync(dirname(file),{recursive:true});const bytes=Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');fs.writeFileSync(file,bytes,{mode:0o600});return{ref:file,sha256:sha(bytes)};};
 for(const file of ['package.json','package-lock.json',...fs.readdirSync(join(repository,'governance')).filter(n=>n.endsWith('.json')).map(n=>'governance/'+n)])put(join(source,file),fs.readFileSync(join(repository,file)));
 for(const name of ['support.mjs','browser.mjs','maintenance.mjs','usage.test.mjs',...Array.from({length:22},(_,i)=>'e'+String(i+1).padStart(2,'0')+'.test.mjs')])put(join(source,'tests/acceptance/v090',name),'// Synthetic collector identity only.\n');
 changeGovernance?.({source,put});
 const git=args=>execFileSync('/usr/bin/git',['-c','core.fsmonitor=false','-C',source,...args],{env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},stdio:['ignore','pipe','pipe']}).toString();
 git(['init','--quiet']);git(['add','.']);git(['-c','user.name=Synthetic fixture','-c','user.email=synthetic@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','Synthetic release gate fixture']);const sourceCommit=git(['rev-parse','HEAD']).trim();
 const archive=Buffer.from('Synthetic standalone bytes; not installable software.\n'),manifest=Buffer.from(JSON.stringify({schema:'runtime-standalone-distribution/v1',version:'0.9.0',archiveDigest:sha(archive),files:{'package.json':{type:'file',sha256:sha('{}'),bytes:2,mode:420}}}));
 const materials=new Map([['distribution-manifest.json',manifest],['evopilot-next-runtime-0.9.0.tgz',Buffer.from('Synthetic SDK')],['evopilot-runtime-0.9.0-darwin-arm64.tar.gz',archive],['runtime-dependency-lock.json',fs.readFileSync(join(source,'package-lock.json'))],['source-revision.txt',Buffer.from(sourceCommit+'\n')]]);
 materials.set('SHA256SUMS',Buffer.from([...materials].map(([n,b])=>sha(b)+'  '+n+'\n').join('')));
 const files=Object.fromEntries(RUNTIME_RELEASE_ASSETS.map(n=>[n,put(join(evidence,'assets',n),materials.get(n))]));
 const archiveZip=zip(materials),artifactDigest=sha(archiveZip),repo={id:1416265295,full_name:'yeliang-wang/evopilot-runtime'},artifactName=`evopilot-runtime-${sourceCommit}-package`,runId=12;
 const ci=join(evidence,'source-ci');
 const steps=['Verify the declared source-test platform','Run npm ci --ignore-scripts','Run npm run build','Run npm run check','Run npm test','Pack exact candidate (not a Release)','Retain independently built candidate package'];
 const sourceCi={
  run:put(join(ci,'run.json'),{id:runId,run_attempt:1,repository:repo,head_repository:repo,head_sha:sourceCommit,path:'.github/workflows/ci.yml',status:'completed',conclusion:'success',event:'workflow_dispatch'}),
  jobs:put(join(ci,'jobs.json'),{total_count:1,jobs:[{id:45,name:'source',run_id:runId,run_attempt:1,head_sha:sourceCommit,status:'completed',conclusion:'success',labels:['macos-15'],steps:steps.map(name=>({name,status:'completed',conclusion:'success'}))}]}),
  artifact:put(join(ci,'artifact.json'),{id:23,name:artifactName,size_in_bytes:archiveZip.length,url:`https://api.github.com/repos/${repo.full_name}/actions/artifacts/23`,archive_download_url:`https://api.github.com/repos/${repo.full_name}/actions/artifacts/23/zip`,expired:false,digest:'sha256:'+artifactDigest,expires_at:new Date(Date.now()+86400000).toISOString(),workflow_run:{id:runId,head_sha:sourceCommit,repository_id:repo.id,head_repository_id:repo.id}}),
  jobLog:put(join(ci,'job.log'),'##[group]Run npm test\n##[endgroup]\nℹ tests 7\nℹ pass 7\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n##[group]Run package\nSHA256 digest of uploaded artifact zip is '+artifactDigest+'\nArtifact '+artifactName+'.zip successfully finalized. Artifact ID 23\n'),
  artifactZip:put(join(ci,'artifact.zip'),archiveZip),
 };
 const candidate={manifestDigest:sha(manifest),archiveDigest:sha(archive),version:'0.9.0',serviceId:'synthetic',workspaceId:'synthetic',projectId:'synthetic'},candidateDigest='sha256:'+sha(manifest),matrixBytes=fs.readFileSync(join(source,'governance/parameter-matrix-v090.json')),matrix=JSON.parse(matrixBytes);
 const reports=[];
 function report(scenario,ids,usage=false){
  const dir=join(evidence,scenario),collectorNames=usage?['usage.test.mjs']:['support.mjs',scenario.toLowerCase()+'.test.mjs',...(['E04','E05','E06','E07','E12','E17','E19'].includes(scenario)?['browser.mjs']:[]),...(['E05','E14','E15','E17'].includes(scenario)?['maintenance.mjs']:[])];
  const selection={scenario,qualification:'FINAL_CANDIDATE',candidate,candidateDigest,collectorPins:Object.fromEntries(collectorNames.map(n=>[n,sha(fs.readFileSync(join(source,'tests/acceptance/v090',n)))])),selectedCaseIds:ids,...(usage?{sourceCommit,addendumDigest:sha(fs.readFileSync(join(source,'governance/token-usage-v090.json')))}:{matrixDigest:sha(matrixBytes)})};
  const selectionRef=put(join(dir,'selection.json'),selection);
  const records=id=>{const n=id??'setup',request=put(join(dir,n+'-request.json'),{caseInstanceId:id,synthetic:true,request:'Integrity fixture'}),response=put(join(dir,n+'-response.json'),{caseInstanceId:id,synthetic:true,response:'Not actual acceptance'});return{caseInstanceId:id,request:n+'-request.json',requestDigest:request.sha256,response:n+'-response.json',fileDigest:response.sha256};};
  const results=ids.map(caseInstanceId=>{const r={caseInstanceId,status:'PASS',qualification:'FINAL_CANDIDATE',candidateDigest,assertions:{synthetic:'Integrity fixture, not evidence of product behavior'},evidence:[records(caseInstanceId)]};put(join(dir,caseInstanceId+'.json'),r);return r;});
  const value={...(usage?{schema:'runtime-usage-acceptance-report/v1',sourceCommit}:{}),scenario,candidate,candidateDigest,selectionDigest:selectionRef.sha256,qualification:'FINAL_CANDIDATE',scenarioDenominator:ids.length,fullDenominator:usage?688:664,selected:ids.length,executed:ids.length,passed:ids.length,failed:0,unexecutedCaseIds:[],scenarioStatus:'OBSERVED_PASS',productAcceptance:'NOT_EVALUATED',releaseAuthorized:false,setupEvidence:[records(null)],results};
  return put(join(dir,'REPORT.json'),value);
 }
 for(let i=1;i<=20;i++){const scenario='E'+String(i).padStart(2,'0');reports.push({scenario,report:report(scenario,matrix.caseInstances.filter(c=>c.scenario===scenario).map(c=>c.caseInstanceId))});}
 const usageReport=report('UT',Array.from({length:23},(_,i)=>'UT'+String(i+1).padStart(2,'0')),true);
 const releaseNotes=put(join(evidence,'release-notes.md'),'# Synthetic Runtime Preview\n\nUnit-test notes only; no actual release or acceptance.\n');
 const input={schema:'runtime-release-preflight-input/v1',candidate:{schema:'runtime-release-candidate-input/v1',repository:repo.full_name,sourceCommit,files,sourceCi},scope:{workspaceId:'synthetic',projectId:'synthetic'},reports,usageReport,releaseNotes};
 const prepare=()=>prepareRuntimeRelease(source,input,signal());
 function decision(review){
  const subject={owner:'runtime',operation:'release.publish',workspaceId:'synthetic',scope:{visibility:'private',projectId:'synthetic'},reviewDigest:review.reviewDigest,decision:'APPROVE'};
  const original=put(join(evidence,'synthetic-decision-source.json'),{synthetic:true,message:'Not a human approval; unit-test source only.'});
  return put(join(evidence,'synthetic-decision.json'),{schema:'evopilot-decision-evidence/v1',subject,source:{reference:pathToFileURL(original.ref).href+'#sha256='+original.sha256,description:'Synthetic source, not real authority'}});
 }
 return{root,source,evidence,input,put,prepare,decision,candidate:()=>inspectRuntimeReleaseCandidate(source,input.candidate,signal())};
}
const syntheticAuthentication=request=>({schema:'runtime-release-authentication/v1',challenge:request.challenge,subject:request.subject,reviewDigest:request.review.reviewDigest,candidateDigest:request.review.publication.candidateDigest,sourceCommit:request.review.publication.sourceCommit,decisionEvidenceDigest:request.decisionEvidenceDigest,decisionSourceDigest:request.decisionSourceDigest,sourceCiRecordsDigest:request.sourceCiRecordsDigest,decision:'APPROVE',humanIdentity:{kind:'human',id:'synthetic-test-identity-not-an-actual-human'},decisionAuthentication:'AUTHENTICATED_HUMAN_DECISION',sourceCiAuthentication:'AUTHENTICATED_PROVIDER_READS',acceptanceAuthentication:'REVIEWED_ORIGINAL_EXECUTION',authenticatedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()});

test('E20 lower layer has no acceptance self-dependency and only the exact independent six public assets',async t=>{
 const f=fixture(t);fs.unlinkSync(f.input.reports[19].report.ref);
 const r=await f.candidate();assert.equal(r.repository,'yeliang-wang/evopilot-runtime');assert.equal(r.tag,'v0.9.0');assert.equal(r.prerelease,true);assert.equal(r.latest,false);assert.deepEqual(Object.keys(r.files).sort(),[...RUNTIME_RELEASE_ASSETS].sort());assert.equal(r.releaseAuthorized,false);assert.equal(r.productAcceptance,'NOT_EVALUATED');assert(!JSON.stringify(r).includes(f.root));
 await assert.rejects(f.prepare);
});
test('full preflight combines 655 plus 23 without claiming the ten post-release cases or human authority',async t=>{
 const f=fixture(t),r=await f.prepare();assert.equal(r.acceptance.passedPreRelease,678);assert.equal(r.acceptance.requiredPreRelease,678);assert.equal(r.acceptance.combinedRequired,688);assert.deepEqual(r.acceptance.postRelease,{required:10,passed:0,status:'NOT_EVALUATED',scenarios:['E21','E22','UT24']});assert.equal(r.releaseAuthorized,false);assert.equal(r.executionAuthenticity,'TRUSTED_REVIEW_REQUIRED');assert.equal(r.privacy.privateEvidenceUploadAllowed,false);assert(!JSON.stringify(r).includes(f.root));assert.equal((await f.prepare()).reviewDigest,r.reviewDigest);
 assert.deepEqual(r.publication.releaseNotes,{sha256:f.input.releaseNotes.sha256,bytes:fs.statSync(f.input.releaseNotes.ref).size,mediaType:'text/markdown; charset=utf-8'});assert.equal(Object.keys(r.publication.files).length,6);
 const target=JSON.parse(fs.readFileSync(join(f.source,'governance/target-v090.json')));
 assert.deepEqual(r.governance,{status:'VALID',targetId:target.id,targetVersion:'0.9.0',roadmapDigest:sha(fs.readFileSync(join(f.source,'governance/roadmap.json'))),targetDigest:sha(fs.readFileSync(join(f.source,'governance/target-v090.json'))),approvedPlanDigest:target.approvedPlanDigest,acceptanceDigest:target.acceptanceDigest,usageAddendumDigest:sha(fs.readFileSync(join(f.source,'governance/token-usage-v090.json')))});
 assert.equal(verifyRuntimeReleaseGovernanceCurrent(f.source,f.input.candidate.sourceCommit,r.governance),undefined);
 assert.throws(()=>verifyRuntimeReleaseGovernanceCurrent(f.source,f.input.candidate.sourceCommit,{...r.governance,targetDigest:'0'.repeat(64)}),/Reviewed release governance changed/);
 await assert.rejects(()=>prepareRuntimeRelease(f.source,{...f.input,postRelease:{passed:10}},signal()),/Unexpected input/);
});
test('clean committed source and complete evidence cannot publish when the approved Roadmap/Target binding is invalid',async t=>{
 const f=fixture(t,({source,put})=>{const ref=join(source,'governance/target-v090.json'),target=JSON.parse(fs.readFileSync(ref));target.roadmapDigest='0'.repeat(64);put(ref,target);});
 // The lower E20 candidate inspector still has no dependency on its own final
 // report; complete release preflight must independently enforce governance.
 assert.equal((await f.candidate()).recordIntegrity,'VERIFIED');
 await assert.rejects(f.prepare,/Roadmap\/Target governance is not valid/);
 let authenticated=false;
 await assert.rejects(()=>verifyRuntimeReleaseDecision(f.source,f.input,'sha256:'+'0'.repeat(64),{ref:join(f.evidence,'not-a-decision.json'),sha256:'0'.repeat(64)},async request=>{authenticated=true;return syntheticAuthentication(request);},signal()),/Roadmap\/Target governance is not valid/);
 assert.equal(authenticated,false);
});
test('exact private UTF-8 notes are reviewed without becoming an attachment and cannot change after approval',async t=>{
 const f=fixture(t),ref=f.input.releaseNotes,bytes=fs.readFileSync(ref.ref),review=await f.prepare(),decision=f.decision(review);
 const missing={...f.input};delete missing.releaseNotes;await assert.rejects(()=>prepareRuntimeRelease(f.source,missing,signal()),/Unexpected input/);
 for(const invalid of [Buffer.from([0xff]),Buffer.from(' \n\t'),Buffer.from('# Notes\n\u0000'),Buffer.alloc(262145,0x61)]){f.input.releaseNotes=f.put(ref.ref,invalid);await assert.rejects(f.prepare);}
 fs.writeFileSync(ref.ref,bytes);f.input.releaseNotes=ref;fs.chmodSync(ref.ref,0o644);await assert.rejects(f.prepare);fs.chmodSync(ref.ref,0o600);
 f.input.releaseNotes=f.put(ref.ref,Buffer.concat([bytes,Buffer.from('\nChanged public claim.\n')]));const changed=await f.prepare();assert.notEqual(changed.reviewDigest,review.reviewDigest);
 let called=false;await assert.rejects(()=>verifyRuntimeReleaseDecision(f.source,f.input,review.reviewDigest,decision,async request=>{called=true;return syntheticAuthentication(request);},signal()),/concrete release review changed/);assert.equal(called,false);
 fs.writeFileSync(ref.ref,bytes);f.input.releaseNotes=ref;
 await assert.rejects(()=>verifyRuntimeReleaseDecision(f.source,f.input,review.reviewDigest,decision,async request=>{called=true;fs.appendFileSync(ref.ref,'\nChanged during authentication.\n');return syntheticAuthentication(request);},signal()));assert.equal(called,true);
});
test('foreign components, different CI bytes, duplicate evidence roles and altered source remain rejected',async t=>{
 const f=fixture(t),original=structuredClone(f.input.candidate);
 for(const mutate of [c=>c.repository='yeliang-wang/evopilot',c=>c.files.extra=c.files.SHA256SUMS,c=>delete c.files['source-revision.txt'],c=>c.sourceCi.jobs=c.sourceCi.run]){const v=structuredClone(original);mutate(v);await assert.rejects(()=>inspectRuntimeReleaseCandidate(f.source,v,signal()));}
 const sdk=f.input.candidate.files['evopilot-next-runtime-0.9.0.tgz'];f.input.candidate.files['evopilot-next-runtime-0.9.0.tgz']=f.put(sdk.ref,'Changed SDK');await assert.rejects(f.candidate,/differ from the independently built/);
 fs.appendFileSync(join(f.source,'package.json'),' ');await assert.rejects(f.candidate,/clean committed source/);
});
test('partial original or usage evidence cannot borrow the other denominator or the E20 source result',async t=>{
 const f=fixture(t),last=f.input.reports.pop();await assert.rejects(f.prepare);f.input.reports.push(last);
 const ref=f.input.usageReport,bytes=fs.readFileSync(ref.ref),report=JSON.parse(bytes);report.passed=22;f.input.usageReport=f.put(ref.ref,report);await assert.rejects(f.prepare);fs.writeFileSync(ref.ref,bytes);f.input.usageReport=ref;assert.equal((await f.prepare()).acceptance.passedPreRelease,678);
});
test('decision hashes and implementation approval never replace an exact real-authenticator interface',async t=>{
 const f=fixture(t),review=await f.prepare(),decision=f.decision(review),verify=auth=>verifyRuntimeReleaseDecision(f.source,f.input,review.reviewDigest,decision,auth,signal());
 await assert.rejects(()=>verify(undefined),/trusted real-decision/);
 for(const modify of [()=>true,r=>({...r,reviewDigest:'sha256:'+'0'.repeat(64)}),r=>({...r,sourceCiAuthentication:'HASHES_ONLY'}),r=>({...r,acceptanceAuthentication:'SYNTHETIC_FIXTURES'}),r=>({...r,expiresAt:'2000-01-01T00:00:00Z'})])await assert.rejects(()=>verify(async request=>modify(syntheticAuthentication(request))));
 await assert.rejects(()=>verifyRuntimeReleaseDecision(f.source,f.input,'sha256:'+'0'.repeat(64),decision,async r=>syntheticAuthentication(r),signal()),/concrete release review changed/);
 const old=JSON.parse(fs.readFileSync(decision.ref));old.subject.operation='implementation.approve';const wrong=f.put(decision.ref,old);await assert.rejects(()=>verifyRuntimeReleaseDecision(f.source,f.input,review.reviewDigest,wrong,async r=>syntheticAuthentication(r),signal()),/exact release review/);
});
test('an exact synthetic authenticator exercises only bounded publication and does not authorize install, migration or post-release PASS',async t=>{
 const f=fixture(t),review=await f.prepare(),decision=f.decision(review);let called=false;
 const r=await verifyRuntimeReleaseDecision(f.source,f.input,review.reviewDigest,decision,async request=>{called=true;assert.equal(request.subject.operation,'release.publish');assert.equal(request.decisionEvidence.ref,decision.ref);return syntheticAuthentication(request);},signal());
 assert(called);assert.equal(r.releaseAuthorized,true);assert.deepEqual(r.governance,review.governance);assert.equal(r.authorizedOperation,'github.preview.publish');assert.equal(r.installationAuthorized,false);assert.equal(r.migrationAuthorized,false);assert.equal(r.overallCompletion,'NOT_COMPLETE');assert.equal(r.postRelease.passed,0);assert.equal(r.postRelease.required,10);assert(!JSON.stringify(r).includes(f.root));
});
test('post-authentication drift and authenticator exceptions cannot escape final revalidation or expose private error text',async t=>{
 const f=fixture(t),review=await f.prepare(),decision=f.decision(review),verify=auth=>verifyRuntimeReleaseDecision(f.source,f.input,review.reviewDigest,decision,auth,signal());
 await assert.rejects(()=>verify(async()=>{throw Error('private credential must never be copied');}),e=>e.message==='RELEASE_GATE: Trusted release authentication failed');
 const requestFile=join(f.evidence,'UT','UT01-request.json'),before=fs.readFileSync(requestFile);
 await assert.rejects(()=>verify(async request=>{fs.appendFileSync(requestFile,' ');return syntheticAuthentication(request);}));fs.writeFileSync(requestFile,before);
 const controller=new AbortController();await assert.rejects(()=>verifyRuntimeReleaseDecision(f.source,f.input,review.reviewDigest,decision,async()=>{controller.abort();return new Promise(()=>{});},controller.signal),/authentication failed/);
});
