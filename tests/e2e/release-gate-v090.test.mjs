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
import {inspectQualifiedAcceptanceEvidence,closeQualifiedAcceptanceObservation} from '../../dist/release/evidence.js';

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
 for(const name of ['support.mjs','preflight.mjs','browser.mjs','maintenance.mjs','execution.mjs','usage.test.mjs','correction.test.mjs',...Array.from({length:22},(_,i)=>'e'+String(i+1).padStart(2,'0')+'.test.mjs')])put(join(source,'tests/acceptance/v090',name),'// Synthetic collector identity only.\n');
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
  const dir=join(evidence,scenario),collectorNames=usage?['usage.test.mjs']:['support.mjs','preflight.mjs',scenario.toLowerCase()+'.test.mjs',...(['E01','E02','E04','E05','E06','E07','E12','E13','E16','E17','E18','E19'].includes(scenario)?['browser.mjs']:[]),...(['E05','E14','E15','E17'].includes(scenario)?['maintenance.mjs']:[]),...(['E01','E02','E04','E05','E13','E16','E18'].includes(scenario)?['execution.mjs']:[]),...(scenario==='E13'?['e11.test.mjs']:[]),...(scenario==='E05'?['e16.test.mjs']:[]),...(scenario==='E03'?['browser.mjs','maintenance.mjs','execution.mjs','e11.test.mjs','e12.test.mjs']:[]),...(scenario==='E06'?['execution.mjs','e11.test.mjs','e12.test.mjs','e04.test.mjs','e13.test.mjs']:[]),...(scenario==='E07'?['e12.test.mjs']:[])];
  const selection={scenario,qualification:'FINAL_CANDIDATE',candidate,candidateDigest,collectorPins:Object.fromEntries(collectorNames.map(n=>[n,sha(fs.readFileSync(join(source,'tests/acceptance/v090',n)))])),selectedCaseIds:ids,...(usage?{sourceCommit,addendumDigest:sha(fs.readFileSync(join(source,'governance/token-usage-v090.json')))}:{matrixDigest:sha(matrixBytes)})};
  const selectionRef=put(join(dir,'selection.json'),selection);
  const records=id=>{const n=id??'setup',request=put(join(dir,n+'-request.json'),{caseInstanceId:id,synthetic:true,request:'Integrity fixture'}),response=put(join(dir,n+'-response.json'),{caseInstanceId:id,synthetic:true,response:'Not actual acceptance'});return{caseInstanceId:id,request:n+'-request.json',requestDigest:request.sha256,response:n+'-response.json',fileDigest:response.sha256};};
  const results=ids.map(caseInstanceId=>{const r={caseInstanceId,status:'PASS',qualification:'FINAL_CANDIDATE',candidateDigest,assertions:{synthetic:'Integrity fixture, not evidence of product behavior'},evidence:[records(caseInstanceId)]};put(join(dir,caseInstanceId+'.json'),r);return r;});
  const value={...(usage?{schema:'runtime-usage-acceptance-report/v1',sourceCommit}:{}),scenario,candidate,candidateDigest,selectionDigest:selectionRef.sha256,qualification:'FINAL_CANDIDATE',scenarioDenominator:ids.length,fullDenominator:usage?688:664,selected:ids.length,executed:ids.length,passed:ids.length,failed:0,unexecutedCaseIds:[],scenarioStatus:'OBSERVED_PASS',productAcceptance:'NOT_EVALUATED',releaseAuthorized:false,setupEvidence:[records(null)],results};
  return put(join(dir,'REPORT.json'),value);
 }
 for(let i=1;i<=20;i++){const scenario='E'+String(i).padStart(2,'0');reports.push({scenario,report:report(scenario,matrix.caseInstances.filter(c=>c.scenario===scenario).map(c=>c.caseInstanceId))});}
 const usageReport=report('UT',Array.from({length:23},(_,i)=>'UT'+String(i+1).padStart(2,'0')),true);
 const correctionCases=JSON.parse(fs.readFileSync(join(source,'governance/lifecycle-correction-v090.json'))).acceptance.cases.filter(c=>c.phase==='PRE_RELEASE'),correctionDir=join(evidence,'LC');
 const correctionSelection={scenario:'LC',sourceCommit,phase:'PRE_RELEASE',addendumDigest:sha(fs.readFileSync(join(source,'governance/lifecycle-correction-v090.json'))),qualification:'FINAL_CANDIDATE',candidate,candidateDigest,collectorPins:Object.fromEntries(['correction.test.mjs','execution.mjs','browser.mjs','support.mjs','preflight.mjs','e22.test.mjs'].map(name=>[name,sha(fs.readFileSync(join(source,'tests/acceptance/v090',name)))])),selectedCaseIds:correctionCases.map(c=>c.id)};
 const correctionSelectionRef=put(join(correctionDir,'selection.json'),correctionSelection);
 const correctionRecord=(caseInstanceId,vectorId)=>{const artifact=(caseInstanceId??'setup')+'-'+(vectorId??'setup')+'.raw.json',ref=put(join(correctionDir,artifact),{synthetic:true,message:'Raw integrity test fixture; not actual execution or acceptance',caseInstanceId,vectorId});return{caseInstanceId,vectorId,artifact,fileDigest:ref.sha256};};
 const observed={phase:'PRE_RELEASE',status:'PASS',qualification:'FINAL_CANDIDATE',candidateDigest,assertions:{synthetic:'Integrity fixture only'}};
 const correctionResults=correctionCases.map(c=>{const r={caseInstanceId:c.id,...observed,vectors:c.vectors.map(vectorId=>({vectorId,...observed,evidence:[correctionRecord(c.id,vectorId)]}))};put(join(correctionDir,c.id+'.json'),r);return r;});
 const correctionReport=put(join(correctionDir,'REPORT.json'),{schema:'runtime-correction-acceptance-report/v1',scenario:'LC',sourceCommit,phase:'PRE_RELEASE',candidate,candidateDigest,selectionDigest:correctionSelectionRef.sha256,qualification:'FINAL_CANDIDATE',scenarioDenominator:20,fullDenominator:709,selected:20,executed:20,passed:20,failed:0,unexecutedCaseIds:[],scenarioStatus:'OBSERVED_PASS',productAcceptance:'NOT_EVALUATED',releaseAuthorized:false,setupEvidence:[correctionRecord(null,null)],results:correctionResults});
 const releaseNotes=put(join(evidence,'release-notes.md'),'# Synthetic Runtime Preview\n\nUnit-test notes only; no actual release or acceptance.\n');
 const input={schema:'runtime-release-preflight-input/v1',candidate:{schema:'runtime-release-candidate-input/v1',repository:repo.full_name,sourceCommit,files,sourceCi},scope:{workspaceId:'synthetic',projectId:'synthetic'},reports,usageReport,correctionReport,releaseNotes};
 const prepare=()=>prepareRuntimeRelease(source,input,signal());
 function decision(review){
  const subject={owner:'runtime',operation:'release.publish',workspaceId:'synthetic',scope:{visibility:'private',projectId:'synthetic'},reviewDigest:review.reviewDigest,decision:'APPROVE'};
  const original=put(join(evidence,'synthetic-decision-source.json'),{synthetic:true,message:'Not a human approval; unit-test source only.'});
  return put(join(evidence,'synthetic-decision.json'),{schema:'evopilot-decision-evidence/v1',subject,source:{reference:pathToFileURL(original.ref).href+'#sha256='+original.sha256,description:'Synthetic source, not real authority'}});
 }
 // Re-pin synthetic aggregate and case files so negative tests reach semantic checks.
 function rewriteCorrection(change){
  const report=JSON.parse(fs.readFileSync(input.correctionReport.ref)),selection=JSON.parse(fs.readFileSync(join(correctionDir,'selection.json')));
  change(report,selection);report.selectionDigest=put(join(correctionDir,'selection.json'),selection).sha256;
  for(const result of report.results)put(join(correctionDir,result.caseInstanceId+'.json'),result);
  input.correctionReport=put(input.correctionReport.ref,report);
 }
 return{root,source,evidence,input,put,prepare,decision,rewriteCorrection,correctionCases,candidate:()=>inspectRuntimeReleaseCandidate(source,input.candidate,signal())};
}
const syntheticAuthentication=request=>({schema:'runtime-release-authentication/v1',challenge:request.challenge,subject:request.subject,reviewDigest:request.review.reviewDigest,candidateDigest:request.review.publication.candidateDigest,sourceCommit:request.review.publication.sourceCommit,decisionEvidenceDigest:request.decisionEvidenceDigest,decisionSourceDigest:request.decisionSourceDigest,sourceCiRecordsDigest:request.sourceCiRecordsDigest,decision:'APPROVE',humanIdentity:{kind:'human',id:'synthetic-test-identity-not-an-actual-human'},decisionAuthentication:'AUTHENTICATED_HUMAN_DECISION',sourceCiAuthentication:'AUTHENTICATED_PROVIDER_READS',acceptanceAuthentication:'REVIEWED_ORIGINAL_EXECUTION',authenticatedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()});

test('E20 lower layer has no acceptance self-dependency and only the exact independent six public assets',async t=>{
 const f=fixture(t);fs.unlinkSync(f.input.reports[19].report.ref);
 const r=await f.candidate();assert.equal(r.repository,'yeliang-wang/evopilot-runtime');assert.equal(r.tag,'v0.9.0');assert.equal(r.prerelease,true);assert.equal(r.latest,false);assert.deepEqual(Object.keys(r.files).sort(),[...RUNTIME_RELEASE_ASSETS].sort());assert.equal(r.releaseAuthorized,false);assert.equal(r.productAcceptance,'NOT_EVALUATED');assert(!JSON.stringify(r).includes(f.root));
 await assert.rejects(f.prepare);
});
test('full preflight requires original 678 plus 20 LC without claiming eleven post-release cases or human authority',async t=>{
 const f=fixture(t),r=await f.prepare();assert.equal(r.acceptance.passedPreRelease,698);assert.equal(r.acceptance.requiredPreRelease,698);assert.equal(r.acceptance.combinedRequired,709);assert.deepEqual(r.acceptance.postRelease,{required:11,passed:0,status:'NOT_EVALUATED',scenarios:['E21','E22','UT24','LC12']});assert.equal(r.releaseAuthorized,false);assert.equal(r.executionAuthenticity,'TRUSTED_REVIEW_REQUIRED');assert.equal(r.privacy.privateEvidenceUploadAllowed,false);assert(!JSON.stringify(r).includes(f.root));assert.equal((await f.prepare()).reviewDigest,r.reviewDigest);
 assert.equal(r.acceptance.correction.required,20);assert.equal(r.acceptance.correction.passed,20);assert.equal(r.acceptance.correction.requiredVectors,f.correctionCases.reduce((n,c)=>n+c.vectors.length,0));assert.equal(r.acceptance.correction.executionAuthenticity,'NOT_ESTABLISHED_BY_FILE_HASHES');assert.equal(r.acceptance.correction.releaseAuthorized,false);
 assert.deepEqual(r.publication.releaseNotes,{sha256:f.input.releaseNotes.sha256,bytes:fs.statSync(f.input.releaseNotes.ref).size,mediaType:'text/markdown; charset=utf-8'});assert.equal(Object.keys(r.publication.files).length,6);
 const target=JSON.parse(fs.readFileSync(join(f.source,'governance/target-v090.json')));
 assert.deepEqual(r.governance,{status:'VALID',targetId:target.id,targetVersion:'0.9.0',roadmapDigest:sha(fs.readFileSync(join(f.source,'governance/roadmap.json'))),targetDigest:sha(fs.readFileSync(join(f.source,'governance/target-v090.json'))),approvedPlanDigest:target.approvedPlanDigest,acceptanceDigest:target.acceptanceDigest,usageAddendumDigest:sha(fs.readFileSync(join(f.source,'governance/token-usage-v090.json'))),correctionAddendumDigest:sha(fs.readFileSync(join(f.source,'governance/lifecycle-correction-v090.json')))});
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
 const ref=f.input.usageReport,bytes=fs.readFileSync(ref.ref),report=JSON.parse(bytes);report.passed=22;f.input.usageReport=f.put(ref.ref,report);await assert.rejects(f.prepare);fs.writeFileSync(ref.ref,bytes);f.input.usageReport=ref;assert.equal((await f.prepare()).acceptance.passedPreRelease,698);
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
 assert(called);assert.equal(r.releaseAuthorized,true);assert.deepEqual(r.governance,review.governance);assert.equal(r.authorizedOperation,'github.preview.publish');assert.equal(r.installationAuthorized,false);assert.equal(r.migrationAuthorized,false);assert.equal(r.overallCompletion,'NOT_COMPLETE');assert.equal(r.postRelease.passed,0);assert.equal(r.postRelease.required,11);assert(!JSON.stringify(r).includes(f.root));
});
test('post-authentication drift and authenticator exceptions cannot escape final revalidation or expose private error text',async t=>{
 const f=fixture(t),review=await f.prepare(),decision=f.decision(review),verify=auth=>verifyRuntimeReleaseDecision(f.source,f.input,review.reviewDigest,decision,auth,signal());
 await assert.rejects(()=>verify(async()=>{throw Error('private credential must never be copied');}),e=>e.message==='RELEASE_GATE: Trusted release authentication failed');
 const requestFile=join(f.evidence,'UT','UT01-request.json'),before=fs.readFileSync(requestFile);
 await assert.rejects(()=>verify(async request=>{fs.appendFileSync(requestFile,' ');return syntheticAuthentication(request);}));fs.writeFileSync(requestFile,before);
 const controller=new AbortController();await assert.rejects(()=>verifyRuntimeReleaseDecision(f.source,f.input,review.reviewDigest,decision,async()=>{controller.abort();return new Promise(()=>{});},controller.signal),/authentication failed/);
});

test('original 678 cannot bypass mandatory LC evidence or count POST/coordination work as PRE',async t=>{
 const f=fixture(t),original=structuredClone(f.input),missing={...f.input};delete missing.correctionReport;
 await assert.rejects(()=>prepareRuntimeRelease(f.source,missing,signal()),/Unexpected input/);
 f.input.correctionReport=f.input.usageReport;await assert.rejects(f.prepare,/Unexpected input|Correction report/);Object.assign(f.input,original);
 const baseline=JSON.parse(fs.readFileSync(f.input.correctionReport.ref));
 for(const change of [r=>r.results.pop(),r=>r.results.push(r.results[0]),r=>r.results[0].caseInstanceId='LC12',r=>r.results[0].caseInstanceId='HO01',r=>r.phase='POST_RELEASE',r=>r.results[0].phase='POST_RELEASE',r=>r.fullDenominator=688,r=>r.scenarioDenominator=21,r=>r.passed=19]){
  f.rewriteCorrection(change);await assert.rejects(f.prepare,/Correction|correction|Every declared/);f.input.correctionReport=f.put(f.input.correctionReport.ref,baseline);
 }
 assert.equal((await f.prepare()).acceptance.passedPreRelease,698);
});

test('every LC vector requires original raw PASS evidence; composite labels and reuse cannot substitute',async t=>{
 const f=fixture(t),baseline=JSON.parse(fs.readFileSync(f.input.correctionReport.ref));
 for(const change of [
  r=>r.results[0].vectors.pop(),r=>r.results[0].vectors.push(r.results[0].vectors[0]),r=>r.results[0].vectors[0].vectorId='unregistered',
  r=>r.results[0].vectors[0].phase='POST_RELEASE',r=>r.results[0].vectors[0].status='FAIL',r=>r.results[0].vectors[0].status='SKIPPED',r=>r.results[0].status='PASS_REUSED',r=>r.results[0].vectors[0].qualification='PASS_REUSED',
  r=>r.results[0].vectors[0].assertions={},r=>r.results[0].vectors[0].evidence=[],
  r=>r.results[0].vectors[0].evidence[0].caseInstanceId='LC02',r=>r.results[0].vectors[0].evidence[0].vectorId='candidate',
  r=>r.results[0].vectors[1].evidence[0].artifact=r.results[0].vectors[0].evidence[0].artifact,
 ]){
  f.rewriteCorrection(change);await assert.rejects(f.prepare,/correction|Correction|Every declared/);f.input.correctionReport=f.put(f.input.correctionReport.ref,baseline);
 }
 f.rewriteCorrection(()=>{});assert.equal((await f.prepare()).acceptance.correction.passed,20);
});

test('LC source, candidate, obligations, phase and committed collector pins remain exact',async t=>{
 const f=fixture(t),baseline=JSON.parse(fs.readFileSync(f.input.correctionReport.ref)),selectionRef=join(f.evidence,'LC','selection.json'),baselineSelection=JSON.parse(fs.readFileSync(selectionRef));
 for(const change of [
  r=>r.sourceCommit='0'.repeat(40),r=>r.candidateDigest='sha256:'+'0'.repeat(64),r=>r.candidate.manifestDigest='0'.repeat(64),r=>r.results[0].candidateDigest='sha256:'+'0'.repeat(64),r=>r.results[0].vectors[0].candidateDigest='sha256:'+'0'.repeat(64),
  (_r,s)=>s.addendumDigest='0'.repeat(64),(_r,s)=>s.sourceCommit='0'.repeat(40),(_r,s)=>s.phase='POST_RELEASE',(_r,s)=>s.selectedCaseIds[0]='LC12',(_r,s)=>s.collectorPins['correction.test.mjs']='0'.repeat(64),
  ...['execution.mjs','browser.mjs','support.mjs','preflight.mjs','e22.test.mjs'].map(name=>(_r,s)=>{s.collectorPins[name]='0'.repeat(64);}),
 ]){
  f.rewriteCorrection(change);await assert.rejects(f.prepare,/Correction|correction|Selected LC/);f.put(selectionRef,baselineSelection);f.input.correctionReport=f.put(f.input.correctionReport.ref,baseline);
 }
 f.rewriteCorrection(()=>{});assert.equal((await f.prepare()).acceptance.correction.passed,20);
});

test('LC original case, raw evidence bytes and file ownership are rechecked after authentication',async t=>{
 const f=fixture(t),review=await f.prepare(),decision=f.decision(review),raw=join(f.evidence,'LC','LC01-source.raw.json'),before=fs.readFileSync(raw),caseRef=join(f.evidence,'LC','LC01.json'),caseBytes=fs.readFileSync(caseRef);
 fs.appendFileSync(raw,' ');await assert.rejects(f.prepare,/Original correction evidence bytes changed/);fs.writeFileSync(raw,before);
 fs.chmodSync(raw,0o644);await assert.rejects(f.prepare,/private and owned/);fs.chmodSync(raw,0o600);
 const changedCase=JSON.parse(caseBytes);changedCase.status='FAIL';f.put(caseRef,changedCase);await assert.rejects(f.prepare,/Original correction case differs/);fs.writeFileSync(caseRef,caseBytes);
 await assert.rejects(()=>verifyRuntimeReleaseDecision(f.source,f.input,review.reviewDigest,decision,async request=>{fs.appendFileSync(raw,' ');return syntheticAuthentication(request);},signal()),/Original correction evidence bytes changed/);
});

test('v2 qualification preflight is versioned and never silently upgrades v1 input',async()=>{
 const {prepareQualifiedRuntimeRelease}=await import('../../dist/release/gate.js');
 await assert.rejects(prepareQualifiedRuntimeRelease('/unused',{schema:'runtime-release-preflight-input/v1'}, {}, {},new AbortController().signal),/Unexpected input fields/);
});

import {createNativeQualificationService} from '../../dist/lifecycle/evidence-qualification.js';
import {prepareQualifiedRuntimeRelease,verifyQualifiedRuntimeReleaseDecision,assertQualifiedRuntimeReleaseAuthorizationCurrent} from '../../dist/release/gate.js';
import {assertMixedAcceptanceCurrent} from '../../dist/release/evidence.js';
import {publishQualifiedReviewedRuntime} from '../../scripts/release-gate.mjs';
function mixedFixture(t){
 const f=fixture(t),originalExecutions=[...f.input.reports.map(r=>r.report),f.input.usageReport,f.input.correctionReport].flatMap(report=>JSON.parse(fs.readFileSync(report.ref)).results.map(r=>({caseId:r.caseInstanceId,report}))),input={schema:'runtime-release-preflight-input/v2',candidate:f.input.candidate,scope:f.input.scope,qualifications:[],executions:[],originalExecutions,releaseNotes:f.input.releaseNotes},service=createNativeQualificationService({},{}),actor={id:'synthetic-authenticated-source-reviewer',projects:['synthetic'],permissions:['read'],revision:1,expiresAt:new Date(Date.now()+3600000).toISOString()};
 const prepare=()=>prepareQualifiedRuntimeRelease(f.source,input,service,actor,signal());return{...f,inputV2:input,service,actor,prepareV2:prepare};
}
// Injected unit authenticator only; these synthetic bytes do not become actual
// product acceptance. The production callback must verify all original sources.
const syntheticV2Authentication=request=>({schema:'runtime-release-authentication/v2',challenge:request.challenge,subject:request.subject,reviewDigest:request.review.reviewDigest,candidateDigest:request.review.publication.candidateDigest,sourceCommit:request.review.publication.sourceCommit,decisionEvidenceDigest:request.decisionEvidenceDigest,decisionSourceDigest:request.decisionSourceDigest,sourceCiRecordsDigest:request.sourceCiRecordsDigest,acceptanceSourcesDigest:request.acceptanceSourcesDigest,originalExecutionSourcesDigest:request.originalExecutionSourcesDigest,decision:'APPROVE',humanIdentity:{kind:'human',id:'synthetic-unit-authenticator'},decisionAuthentication:'AUTHENTICATED_HUMAN_DECISION',sourceCiAuthentication:'AUTHENTICATED_PROVIDER_READS',acceptanceAuthentication:'AUTHENTICATED_CURRENT_EXECUTION_AND_NATIVE_QUALIFICATION',originalExecutionAuthentication:'AUTHENTICATED_ACTUAL_EXECUTION_SOURCES',authenticatedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()});
const authorizeV2=async(f,authenticate=async r=>syntheticV2Authentication(r))=>{const review=await f.prepareV2();return verifyQualifiedRuntimeReleaseDecision(f.source,f.inputV2,review.reviewDigest,f.decision(review),f.service,f.actor,authenticate,signal());};

test('v2 raw execution covers all fixed cases but remains review required until exact actual-source authentication',async t=>{
 const f=mixedFixture(t),review=await f.prepareV2();assert.equal(review.acceptance.covered,698);assert.equal(review.acceptance.executed,698);assert.equal(review.acceptance.reused,0);assert.equal(review.acceptance.typedExecuted,0);assert.equal(review.acceptance.reviewRequiredExecuted,698);assert.equal(review.acceptance.executionAuthenticity,'ACTUAL_ORIGINAL_SOURCE_REVIEW_REQUIRED');assert.equal(review.releaseAuthorized,false);assert(!JSON.stringify(review).includes(f.root));
 let requested;const auth=await authorizeV2(f,async r=>{requested=r;return syntheticV2Authentication(r);});assert.equal(requested.schema,'runtime-release-authentication-request/v2');assert(requested.originalExecutionSources.length>698);assert.equal(auth.schema,'runtime-release-authorization/v2');assert.equal(auth.releaseAuthorized,true);assert.equal(auth.postRelease.required,11);assert.equal(auth.postRelease.passed,0);assert.equal(assertQualifiedRuntimeReleaseAuthorizationCurrent(auth,signal()),undefined);
 assert.throws(()=>assertQualifiedRuntimeReleaseAuthorizationCurrent(structuredClone(auth),signal()),/Original v2 authenticated/);
 assert.throws(()=>assertMixedAcceptanceCurrent(structuredClone(review.acceptance),f.service,f.actor,signal()),/Original in-memory/);
});

test('v2 supports an honestly incomplete original scenario without relabeling it complete',async t=>{
 const f=mixedFixture(t),first=f.inputV2.originalExecutions[0],report=JSON.parse(fs.readFileSync(first.report.ref)),selection=JSON.parse(fs.readFileSync(join(dirname(first.report.ref),'selection.json'))),dir=join(f.evidence,'partial');fs.cpSync(dirname(first.report.ref),dir,{recursive:true});
 const selected=report.results.find(r=>r.caseInstanceId===first.caseId),all=report.results.map(r=>r.caseInstanceId);report.results=[selected];report.selected=1;report.executed=1;report.passed=1;report.unexecutedCaseIds=all.filter(id=>id!==first.caseId);report.scenarioStatus='INCOMPLETE';selection.selectedCaseIds=[first.caseId];report.selectionDigest=f.put(join(dir,'selection.json'),selection).sha256;first.report=f.put(join(dir,'REPORT.json'),report);
 const review=await f.prepareV2();assert.equal(review.acceptance.executed,698);assert.equal(JSON.parse(fs.readFileSync(first.report.ref)).scenarioStatus,'INCOMPLETE');assert.equal(review.acceptance.originalExecutions.find(r=>r.caseId===first.caseId).executionAuthenticity,'REVIEW_REQUIRED');
 report.results=[];report.executed=0;report.passed=0;first.report=f.put(first.report.ref,report);await assert.rejects(f.prepareV2,/selected\/result/);
});

test('v2 three evidence classes are an exact disjoint union and raw execution cannot relabel old or closed-fixture evidence',async t=>{
 const f=mixedFixture(t),first=f.inputV2.originalExecutions[0],snapshot=structuredClone(f.inputV2),report=JSON.parse(fs.readFileSync(first.report.ref));
 f.inputV2.qualifications=[{caseId:first.caseId,actionRef:'copied',actionDigest:'sha256:'+'a'.repeat(64)}];await assert.rejects(f.prepareV2,/mutually exclusive/);Object.assign(f.inputV2,structuredClone(snapshot));
 f.inputV2.originalExecutions.pop();await assert.rejects(f.prepareV2,/mutually exclusive/);Object.assign(f.inputV2,structuredClone(snapshot));
 f.inputV2.originalExecutions[0].caseId='LC12';await assert.rejects(f.prepareV2,/mutually exclusive/);Object.assign(f.inputV2,structuredClone(snapshot));
 for(const mutate of [r=>r.candidateDigest='sha256:'+'0'.repeat(64),r=>r.qualification='PASS_REUSED',r=>r.formalAcceptanceEligible=false]){const changed=structuredClone(report);mutate(changed);const ref=f.put(first.report.ref,changed);for(const row of f.inputV2.originalExecutions)if(row.report.ref===ref.ref)row.report=ref;await assert.rejects(f.prepareV2,/CURRENT candidate|Closed fixtures/);f.put(first.report.ref,report);Object.assign(f.inputV2,structuredClone(snapshot));}
});

test('v2 authentication rejects v1 crossparse, partial source claims and source mutation during the await',async t=>{
 const f=mixedFixture(t);
 for(const mutate of [a=>a.schema='runtime-release-authentication/v1',a=>a.acceptanceAuthentication='REVIEWED_ORIGINAL_EXECUTION',a=>a.originalExecutionSourcesDigest='sha256:'+'0'.repeat(64),a=>delete a.originalExecutionAuthentication])await assert.rejects(()=>authorizeV2(f,async r=>{const a=syntheticV2Authentication(r);mutate(a);return a;}),/v2 sources|source authentication|Unexpected input/);
 const raw=join(f.evidence,'E01','E01.journey-response.json'),bytes=fs.readFileSync(raw);await assert.rejects(()=>authorizeV2(f,async r=>{fs.appendFileSync(raw,' ');return syntheticV2Authentication(r);}),/Original raw evidence/);fs.writeFileSync(raw,bytes);
 const auth=await authorizeV2(f);fs.appendFileSync(raw,' ');assert.throws(()=>assertQualifiedRuntimeReleaseAuthorizationCurrent(auth,signal()),/Original source bytes/);fs.writeFileSync(raw,bytes);
 auth.publication.files['SHA256SUMS'].sha256='0'.repeat(64);assert.throws(()=>assertQualifiedRuntimeReleaseAuthorizationCurrent(auth,signal()),/Original v2 authenticated/);
});

function fakePublication(f,{onCall=()=>{},unknownAt=null}={}){
 const calls=[],assets=[],release={id:77,tag_name:'v0.9.0',name:'Runtime 0.9.0 Preview',body:fs.readFileSync(f.input.releaseNotes.ref,'utf8'),prerelease:true,draft:true};let tag=null;
 const response=(body,status=200)=>({status,body:Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body)),transport:'HTTP'});
 const github=async(method,endpoint,options={})=>{calls.push({method,endpoint});onCall(method,endpoint,calls.length);if(unknownAt&&endpoint.includes(unknownAt)&&method!=='GET')return{status:null,body:Buffer.alloc(0),transport:'UNKNOWN'};
  if(method==='GET'&&endpoint==='repos/yeliang-wang/evopilot-runtime')return response({id:1416265295,full_name:'yeliang-wang/evopilot-runtime',permissions:{push:true}});
  if(endpoint.endsWith('/git/ref/tags/v0.9.0'))return tag?response(tag):response({},404);
  if(endpoint.endsWith('/releases/tags/v0.9.0'))return response({},404);
  if(method==='POST'&&endpoint.endsWith('/git/refs')){tag={ref:options.body.ref,object:{type:'commit',sha:options.body.sha}};return response(tag,201);}
  if(method==='POST'&&endpoint.endsWith('/releases')){Object.assign(release,options.body);return response(release,201);}
  if(method==='POST'&&endpoint.includes('/assets?name=')){const name=new URL(endpoint).searchParams.get('name'),a={id:100+assets.length,name,state:'uploaded',size:options.body.length,digest:'sha256:'+sha(options.body)};assets.push({...a,bytes:Buffer.from(options.body)});return response(a,201);}
  if(method==='GET'&&endpoint.endsWith('/assets?per_page=100'))return response(assets.map(({bytes,...a})=>a));
  if(method==='GET'&&/\/releases\/assets\/\d+$/.test(endpoint))return response(assets.find(a=>a.id===Number(endpoint.split('/').at(-1))).bytes);
  if(method==='PATCH'){release.draft=false;release.html_url='https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.9.0';release.published_at=new Date().toISOString();return response(release);}
  if(method==='GET'&&endpoint.endsWith('/releases/77'))return response(release);throw Error('Unreviewed mock endpoint '+endpoint);
 };return{github,calls};
}
async function publishV2Fixture(f,transport){const review=await f.prepareV2();return publishQualifiedReviewedRuntime({repositoryRoot:f.source,input:f.inputV2,expectedReviewDigest:review.reviewDigest,decisionEvidence:f.decision(review),outputRoot:join(f.root,'publication')},f.service,f.actor,async r=>syntheticV2Authentication(r),{github:transport.github,signal:AbortSignal.timeout(120000)});}

test('v2 exact publication runs tag draft six downloads publish while keeping private records private',async t=>{
 const f=mixedFixture(t),transport=fakePublication(f),result=await publishV2Fixture(f,transport);assert.equal(result.schema,'runtime-local-publication/v2');assert.equal(result.status,'PUBLISHED_READBACK_VERIFIED');assert.equal(result.overallCompletion,'NOT_COMPLETE');assert.equal(transport.calls.filter(c=>c.method==='POST'&&c.endpoint.includes('/assets?name=')).length,6);assert.equal(transport.calls.filter(c=>c.method==='PATCH').length,1);assert.equal(transport.calls.some(c=>c.method==='DELETE'),false);assert.equal(result.privateEvidenceUploadAllowed,false);
});

test('v2 rechecks raw sources before each effect and UNKNOWN does not retry or delete remote objects',async t=>{
 for(const mode of ['before-tag','after-upload','unknown']){const f=mixedFixture(t),raw=join(f.evidence,'E01','E01.journey-response.json');let changed=false;const transport=fakePublication(f,{unknownAt:mode==='unknown'?'/releases':null,onCall(method,endpoint){if(!changed&&(mode==='before-tag'&&method==='GET'||mode==='after-upload'&&method==='POST'&&endpoint.includes('/assets?name='))){changed=true;fs.appendFileSync(raw,' ');}}});await assert.rejects(()=>publishV2Fixture(f,transport),/PUBLICATION_STOPPED_INSPECT_ORIGINAL_EVIDENCE/);assert.equal(transport.calls.some(c=>c.method==='DELETE'),false);if(mode==='before-tag')assert.equal(transport.calls.some(c=>c.method==='POST'),false);if(mode==='after-upload')assert.equal(transport.calls.filter(c=>c.method==='POST'&&c.endpoint.includes('/assets?name=')).length,1);if(mode==='unknown')assert.equal(transport.calls.filter(c=>c.method==='POST'&&c.endpoint.endsWith('/releases')).length,1);assert.equal(JSON.parse(fs.readFileSync(join(f.root,'publication/failure.json'))).automaticRetry,false);}
});

import {valueDigest,byteDigest} from '../../dist/lifecycle/base.js';
import {EVIDENCE_INPUT_KINDS} from '../../dist/lifecycle/correction-contract.js';
import {RuntimeStore} from '../../dist/server/store.js';
import {nativeSha256} from '../../vendor/compatibility/v1/native.mjs';
// Explicit trust-boundary unit fixture: synthetic protected reader + synthetic
// owner transport. This exercises real service/action brands, not installed CI.
async function threeSourceFixture(t,{formal=true,mustExecute=false,observationScope,observe}={}){
 const f=mixedFixture(t),baseline=await f.prepareV2(),scope={...f.inputV2.scope,acceptanceScopeDigest:baseline.acceptance.acceptanceScopeDigest},hash=valueDigest,expiresAt=new Date(Date.now()+600000).toISOString(),candidateDigest=baseline.publication.candidateDigest,caseId='LC03',actor={...f.actor,permissions:['read','execution.request']},store=new RuntimeStore(join(f.root,'native-state'),'synthetic');t.after(()=>store.close());
 const reference={product:'harness',id:'synthetic-unit-reuse-policy',version:'1.0.0',digest:hash('policy'),specVersion:'v1',visibility:'private',producer:{name:'synthetic',version:'1'},contractDigest:hash('contract'),standardDigest:hash('standard'),standardLockDigest:hash('standard-lock')},pairs=[{criterionId:'HQA01',variantId:'actual-observation'},{criterionId:'HQA01',variantId:'fixture'}];
 const policy={owner:{ref:'harness',registrationDigest:hash('registration'),scope:{visibility:'private',projectId:'synthetic'},reference,criteria:pairs},publishedReceiptRef:'synthetic:unit-policy',effectiveConfigDigest:hash('config'),toolchainLockDigest:hash('toolchain'),profileDigest:hash('profile'),catalogScopeDigest:scope.acceptanceScopeDigest,caseInventoryDigest:hash('inventory'),validityContractDigest:hash('ttl'),trust:{revision:'one',protectedRecordRef:'synthetic:trust',recordDigest:hash('trust'),expiresAt},requirement:{phase:'PRE_RELEASE',executionRequirement:'AFFECTED_OR_UNKNOWN_MUST_EXECUTE',impact:'UNCHANGED',serialGroupStatus:'PROTECTED_COMPLETE_UNCHANGED_GROUP',inventoryRef:'synthetic:inventory',inventoryRevision:'one'}};
 const nodes=EVIDENCE_INPUT_KINDS.map(kind=>({id:kind,kind,digest:hash(kind),dependsOn:kind==='test'?EVIDENCE_INPUT_KINDS.filter(k=>k!=='test'):[]})),originalInputs={schema:'runtime-evidence-input-manifest/v1',candidateDigest:hash('old-candidate'),completeness:'COMPLETE',dynamicInputs:'RESOLVED',externalInputs:'RESOLVED',roots:['test'],nodes,notApplicable:[]},rawReceipt='Synthetic original receipt for service-boundary unit test, not actual acceptance.\n',original={schema:'runtime-original-evidence-execution/v1',mode:'EXECUTED',scope,caseId,runId:'synthetic-original',candidateDigest:hash('old-candidate'),inputManifestDigest:hash(originalInputs),rawReceiptDigest:byteDigest(rawReceipt),outcome:'PASS',executedAt:new Date(Date.now()-1000).toISOString(),expiresAt},originalExecutionDigest=hash(original),input={schema:'runtime-evidence-qualification-input/v1',scope,caseId,currentCandidateDigest:candidateDigest,original,originalExecutionDigest,rawReceipt,originalInputs,currentInputs:{...structuredClone(originalInputs),candidateDigest},history:[{executionDigest:originalExecutionDigest,candidateDigest:original.candidateDigest,rawReceiptDigest:original.rawReceiptDigest,outcome:'PASS',executedAt:original.executedAt}],executionRule:'OWNER_POLICY'};
 if(mustExecute)policy.requirement.executionRequirement='ALWAYS_MUST_EXECUTE';
 const facts={schema:'runtime-protected-qualification-facts/v2',input,formalAcceptanceEligible:formal,original:{receiptRef:'synthetic:original',rawBytesRef:'synthetic:raw',revision:'one',readbackDigest:hash('readback')},history:{receiptRef:'synthetic:history',watermark:'one'},inventories:{original:{receiptRef:'synthetic:old-inventory',revision:'one'},current:{receiptRef:'synthetic:current-inventory',revision:'one'}},policy,validity:{receiptRef:'synthetic:validity',revision:'one',recordDigest:hash('validity'),originalPolicy:null,originalPolicyApplicability:'VERIFIED_NOT_APPLICABLE'},assessmentAuthority:{requestId:'synthetic-assessment',authorityRef:'synthetic:authority',authorityDigest:hash('authority'),deadlineAt:expiresAt}};
 const typedBody={schema:'runtime-current-execution-capture/v2',captureRef:'synthetic:typed-current',scope,caseId:'E01.journey',phase:'PRE_RELEASE',candidateDigest,mode:'EXECUTED',outcome:'PASS',originalExecutionDigest:hash('typed-execution'),originalReceiptRef:'synthetic:typed-receipt',originalRawBytesRef:'synthetic:typed-raw',rawReceiptDigest:hash('typed-raw'),protectedFactsDigest:hash('typed-facts'),historyWatermark:'one',expiresAt,formalAcceptanceEligible:true,requirement:'ALWAYS_MUST_EXECUTE',policy:{referenceDigest:reference.digest,profileDigest:policy.profileDigest,catalogScopeDigest:scope.acceptanceScopeDigest},origin:{kind:'REGISTERED_CI',stageRequestId:'synthetic-request',stageRequestDigest:hash('request'),provider:'github',runId:'1',archiveDigest:hash('archive'),reportDigest:hash('report'),collectorDigest:hash('collector'),catalogDigest:hash('catalog')},establishesEnvironmentState:false,executionAuthorized:false,releaseAuthorized:false},typed={...typedBody,captureDigest:hash(typedBody)},receipts=new Map(),control={nativeCurrent:true,executionCurrent:true,afterRead:null};
 const owner={owner:'harness',workspaceId:'synthetic',capabilities:()=>({registrationDigest:hash('registration')}),async readPackage(){return{package:{manifest:{entrypoints:{coverage:'coverage.json'}},files:{'coverage.json':JSON.stringify({requirements:[{id:'HQA01',caseIds:['fixture']}]})}}};},async read(_a,_p,r){if(r.operation==='workspace.inspect')return{revision:0};return structuredClone(receipts.get(r.input.requestId));},async mutate(_a,_p,r){const body={reference,context:r.input.context,toolchainLockDigest:policy.toolchainLockDigest,effectiveConfigDigest:policy.effectiveConfigDigest,observationDigest:nativeSha256(r.input.observation),executionStatus:'SUCCEEDED',qualityStatus:'PASS',criteria:pairs.map(p=>({...p,status:'PASS',evidenceDigest:hash(p)}))},receipt={requestId:r.requestId,operation:r.operation,scope:r.scope,requestDigest:nativeSha256({operation:r.operation,scope:r.scope,input:r.input}),status:'SUCCEEDED',result:{...body,reportDigest:nativeSha256(body)}};receipts.set(r.requestId,receipt);}};
 const bindings={...(observationScope?{openObservationScope:observationScope}:{}),read:async()=>{await observe?.();return structuredClone(facts);},owner:()=>owner,authorizeDispatch:s=>({actor,permit:{owner:'harness',projectId:'synthetic',requestDigest:s.requestDigest,authorityRef:s.authorityRef,expiresAt:s.expiresAt}}),authorizeInspect:()=>{assert(control.nativeCurrent,'native trust revoked');return actor;},readExecution:async()=>{control.afterRead?.();return structuredClone(typed);},authorizeExecution:()=>{assert(control.executionCurrent,'current execution source revoked');return actor;}},service=createNativeQualificationService(store,bindings),selection={schema:'runtime-evidence-qualification-selection/v2',scope,caseId,currentCandidateDigest:candidateDigest,originalExecutionDigest,phase:'PRE_RELEASE'};
 const action=await service.prepare(selection,actor,signal());await service.dispatch('synthetic',action.actionRef,actor,signal());f.inputV2.qualifications=[{caseId,actionRef:action.actionRef,actionDigest:action.actionDigest}];f.inputV2.executions=[{caseId:typed.caseId,captureRef:typed.captureRef,captureDigest:typed.captureDigest}];f.inputV2.originalExecutions=f.inputV2.originalExecutions.filter(r=>![caseId,typed.caseId].includes(r.caseId));return{...f,service,actor,control,facts,typed,prepareV2:()=>prepareQualifiedRuntimeRelease(f.source,f.inputV2,service,actor,signal())};
}

test('v2 combines typed current execution native reuse and original source review without converting their meanings',async t=>{
 const f=await threeSourceFixture(t),review=await f.prepareV2();assert.deepEqual([review.acceptance.covered,review.acceptance.executed,review.acceptance.typedExecuted,review.acceptance.reviewRequiredExecuted,review.acceptance.reused],[698,697,1,696,1]);assert.equal(review.acceptance.qualifications[0].mode,'PASS_REUSED');assert.equal(review.acceptance.executions[0].mode,'EXECUTED');assert.equal(review.acceptance.executions[0].requirement,'ALWAYS_MUST_EXECUTE');
 assert.throws(()=>f.service.assertExecutionCurrent('synthetic',structuredClone(review.acceptance.executions[0]),f.actor,signal()),{code:'QUALIFICATION_INSPECTION_REQUIRED'});
 const publication=await publishV2Fixture(f,fakePublication(f));assert.equal(publication.status,'PUBLISHED_READBACK_VERIFIED');
 f.control.afterRead=()=>{f.control.nativeCurrent=false;};await assert.rejects(f.prepareV2,/native trust revoked/);
});

test('v2 current native and typed sources are rechecked at publication mutation boundaries',async t=>{
 for(const source of ['nativeCurrent','executionCurrent']){const f=await threeSourceFixture(t);const transport=fakePublication(f,{onCall(method){if(method==='GET')f.control[source]=false;}});await assert.rejects(()=>publishV2Fixture(f,transport),/PUBLICATION_STOPPED_INSPECT_ORIGINAL_EVIDENCE/);assert.equal(transport.calls.some(c=>c.method==='POST'),false);}
});


test('v2 rejects ineligible native fixture evidence and mandatory reuse before publication',async t=>{
 const closed=await threeSourceFixture(t,{formal:false});await assert.rejects(closed.prepareV2,/ineligible/);
 await assert.rejects(()=>threeSourceFixture(t,{mustExecute:true}),{code:'QUALIFICATION_EXECUTION_REQUIRED'});
});

test('all-raw v2 publication needs its own unexpired exact human decision rather than a Runtime actor object',async t=>{
 const expired=mixedFixture(t),review=await expired.prepareV2();let calls=0;
 await assert.rejects(()=>publishQualifiedReviewedRuntime({repositoryRoot:expired.source,input:expired.inputV2,expectedReviewDigest:review.reviewDigest,decisionEvidence:expired.decision(review),outputRoot:join(expired.root,'publication')},expired.service,expired.actor,async r=>({...syntheticV2Authentication(r),expiresAt:new Date(Date.now()-1).toISOString()}),{github:async()=>{calls++;throw Error('No external effect permitted');},signal:signal()}),/stale or unbounded/);assert.equal(calls,0);
 const changed=mixedFixture(t);let altered=false;const transport=fakePublication(changed,{onCall(method){if(method==='GET'&&!altered){altered=true;fs.appendFileSync(join(changed.evidence,'synthetic-decision.json'),' ');}}});await assert.rejects(()=>publishV2Fixture(changed,transport),/PUBLICATION_STOPPED_INSPECT_ORIGINAL_EVIDENCE/);assert.equal(transport.calls.some(c=>c.method==='POST'),false);
});

import {openLc20ObservationScope,acquireLc20CacheBytes} from '../../dist/adapters/artifacts.js';
function trackedObservationScopes(){const active=new Set();let opened=0,closed=0;return{active,get opened(){return opened;},get closed(){return closed;},open(signal){const scope=openLc20ObservationScope(signal);let ended=false;const tracked={run:read=>scope.run(read),cacheDependent:()=>scope.cacheDependent(),async drain(){tracked.close();await scope.drain();},close(){if(!ended){ended=true;closed++;active.delete(tracked);scope.close();}}};opened++;active.add(tracked);return tracked;},expire(){for(const scope of [...active])scope.close();}};}
test('actual release consumer closes review scopes, reopens after authentication, and closes successful publication',async t=>{
 const scopes=trackedObservationScopes(),f=await threeSourceFixture(t,{observationScope:signal=>scopes.open(signal)}),review=await f.prepareV2();assert.equal(scopes.active.size,0,'Human review retains a snapshot, not open descriptors');const before=scopes.opened;
 const transport=fakePublication(f),result=await publishQualifiedReviewedRuntime({repositoryRoot:f.source,input:f.inputV2,expectedReviewDigest:review.reviewDigest,decisionEvidence:f.decision(review),outputRoot:join(f.root,'scope-publication')},f.service,f.actor,async request=>{assert.equal(scopes.active.size,0,'Pre-authentication scopes must already be closed');return syntheticV2Authentication(request);},{github:transport.github,signal:signal()});
 assert.equal(result.status,'PUBLISHED_READBACK_VERIFIED');assert(scopes.opened>before);assert.equal(scopes.active.size,0);assert.equal(scopes.opened,scopes.closed);
});
test('expired publication observation blocks the next mutation after an actual partial upload and closes all scopes',async t=>{
 const scopes=trackedObservationScopes(),f=await threeSourceFixture(t,{observationScope:signal=>scopes.open(signal)});let expired=false;
 const transport=fakePublication(f,{onCall(method,endpoint){if(!expired&&method==='POST'&&endpoint.includes('/assets?name=')){expired=true;scopes.expire();}}});
 await assert.rejects(()=>publishV2Fixture(f,transport),/PUBLICATION_STOPPED_INSPECT_ORIGINAL_EVIDENCE/);
 assert.equal(transport.calls.filter(c=>c.method==='POST'&&c.endpoint.includes('/assets?name=')).length,1);assert.equal(transport.calls.some(c=>c.method==='PATCH'),false);assert.equal(transport.calls.some(c=>c.method==='DELETE'),false);assert.equal(scopes.active.size,0);assert.equal(scopes.opened,scopes.closed);
 const failure=JSON.parse(fs.readFileSync(join(f.root,'publication/failure.json')));assert.equal(failure.automaticRetry,false);assert.equal(failure.evidenceRetained,true);
});

function releaseCacheFixture(t){
 const root=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'lc20-cache-fixture-'));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const main=join(root,'dyld_shared_cache_arm64e'),sub=main+'.01',base=0x100000000,length=8192,paths=['/usr/lib/dyld','/usr/lib/libSystem.B.dylib'];
 const header=(address,uuid)=>{const b=Buffer.alloc(length);b.write('dyld_v1  arm64e');b.writeUInt32LE(552,16);b.writeUInt32LE(1,20);b.writeBigUInt64LE(BigInt(length),40);Buffer.alloc(16,uuid).copy(b,88);b.writeUInt32LE(1,216);b.writeBigUInt64LE(BigInt(address),552);b.writeBigUInt64LE(BigInt(length),560);b.writeUInt32LE(5,576);b.writeUInt32LE(5,580);return b;};
 const macho=(b,offset,address,type)=>{b.writeUInt32LE(0xfeedfacf,offset);b.writeUInt32LE(0x100000c,offset+4);b.writeUInt32LE(type,offset+12);b.writeUInt32LE(1,offset+16);b.writeUInt32LE(72,offset+20);b.writeUInt32LE(0x19,offset+32);b.writeUInt32LE(72,offset+36);b.write('__TEXT',offset+40);b.writeBigUInt64LE(BigInt(address),offset+56);b.writeBigUInt64LE(128n,offset+64);b.writeBigUInt64LE(128n,offset+80);};
 const a=header(base,1),b=header(base+length,2);a.writeBigUInt64LE(BigInt(base+4096),120);a.writeUInt32LE(1536,392);a.writeUInt32LE(1,396);Buffer.alloc(16,2).copy(a,1536);a.writeBigUInt64LE(BigInt(length),1552);a.write('.01',1560);a.writeUInt32LE(1024,448);a.writeUInt32LE(1,452);a.writeBigUInt64LE(BigInt(base+length+4096),1024);a.writeUInt32LE(2048,1048);a.write(paths[1],2048);macho(a,4096,base+4096,7);macho(b,4096,base+length+4096,6);
 const save=()=>{fs.writeFileSync(main,a,{mode:0o600});fs.writeFileSync(sub,b,{mode:0o600});};save();return{root,main,sub,a,b,paths,save};
}

test('all-raw publication with a registered observation hook outlives 12 seconds under original authority',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const scopes=trackedObservationScopes(),f=mixedFixture(t),service=createNativeQualificationService({},{openObservationScope:signal=>scopes.open(signal)}),review=await f.prepareV2();let advanced=false;
 const transport=fakePublication(f,{onCall(method,endpoint){if(!advanced&&method==='POST'&&endpoint.includes('/assets?name=')){advanced=true;t.mock.timers.tick(13000);}}});
 const result=await publishQualifiedReviewedRuntime({repositoryRoot:f.source,input:f.inputV2,expectedReviewDigest:review.reviewDigest,decisionEvidence:f.decision(review),outputRoot:join(f.root,'allraw-lazy-publication')},service,f.actor,async r=>syntheticV2Authentication(r),{github:transport.github,signal:signal()});
 assert.equal(result.status,'PUBLISHED_READBACK_VERIFIED');assert.equal(advanced,true);assert.equal(scopes.active.size,0);assert.equal(scopes.opened,scopes.closed);
});
test('actual cache-scoped publication refreshes stale bytes before the next effect without redispatch or authority changes',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const cache=releaseCacheFixture(t),scopes=trackedObservationScopes(),proofs=new Set(),observe=async()=>{proofs.add(await acquireLc20CacheBytes(cache.main,cache.paths,signal()));};
 const f=await threeSourceFixture(t,{observationScope:signal=>scopes.open(signal),observe});let advanced=false;
 const transport=fakePublication(f,{onCall(method,endpoint){if(!advanced&&method==='POST'&&endpoint.includes('/assets?name=')){advanced=true;t.mock.timers.tick(13000);}}}),before=proofs.size;
 const result=await publishV2Fixture(f,transport);assert.equal(result.status,'PUBLISHED_READBACK_VERIFIED');assert.equal(advanced,true);assert.equal(proofs.size-before,12,'Three review preparations plus exactly one fresh root proof for each of nine mutations');
 assert.equal(transport.calls.filter(c=>c.method==='POST'&&c.endpoint.includes('/assets?name=')).length,6);assert.equal(transport.calls.filter(c=>c.method==='PATCH').length,1);assert.equal(scopes.active.size,0);assert.equal(scopes.opened,scopes.closed);
});
test('cache refresh rejects changed original sources after a partial upload and preserves completed effects',async t=>{
 const cache=releaseCacheFixture(t),scopes=trackedObservationScopes(),f=await threeSourceFixture(t,{observationScope:signal=>scopes.open(signal),observe:()=>acquireLc20CacheBytes(cache.main,cache.paths,signal())});let changed=false;
 const transport=fakePublication(f,{onCall(method,endpoint){if(!changed&&method==='POST'&&endpoint.includes('/assets?name=')){changed=true;fs.appendFileSync(join(f.evidence,'E02','E02.journey-response.json'),' ');}}});
 await assert.rejects(()=>publishV2Fixture(f,transport),/PUBLICATION_STOPPED_INSPECT_ORIGINAL_EVIDENCE/);assert.equal(transport.calls.filter(c=>c.method==='POST'&&c.endpoint.includes('/assets?name=')).length,1);assert.equal(transport.calls.some(c=>c.method==='PATCH'||c.method==='DELETE'),false);assert.equal(scopes.active.size,0);assert.equal(scopes.opened,scopes.closed);assert.equal(JSON.parse(fs.readFileSync(join(f.root,'publication/failure.json'))).automaticRetry,false);
});
test('cache refresh cannot renew authority that expires during its awaited observation',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const cache=releaseCacheFixture(t),scopes=trackedObservationScopes();let expireNext=false,expired=false,authenticated=0;
 const f=await threeSourceFixture(t,{observationScope:signal=>scopes.open(signal),observe:async()=>{await acquireLc20CacheBytes(cache.main,cache.paths,signal());if(expireNext){expireNext=false;expired=true;t.mock.timers.setTime(Date.now()+61000);}}}),review=await f.prepareV2();
 const transport=fakePublication(f,{onCall(method,endpoint){if(!expired&&method==='POST'&&endpoint.includes('/assets?name='))expireNext=true;}});
 await assert.rejects(()=>publishQualifiedReviewedRuntime({repositoryRoot:f.source,input:f.inputV2,expectedReviewDigest:review.reviewDigest,decisionEvidence:f.decision(review),outputRoot:join(f.root,'publication')},f.service,f.actor,async request=>{authenticated++;return syntheticV2Authentication(request);},{github:transport.github,signal:AbortSignal.timeout(120000)}),/PUBLICATION_STOPPED_INSPECT_ORIGINAL_EVIDENCE/);
 assert.equal(expired,true);assert.equal(authenticated,1);assert.equal(transport.calls.filter(c=>c.method==='POST'&&c.endpoint.includes('/assets?name=')).length,1);assert.equal(transport.calls.some(c=>c.method==='PATCH'||c.method==='DELETE'),false);assert.equal(scopes.active.size,0);assert.equal(scopes.opened,scopes.closed);assert.equal(JSON.parse(fs.readFileSync(join(f.root,'publication/failure.json'))).automaticRetry,false);
});
test('publication stop and original journal survive a separately reported terminal cleanup failure',async t=>{
 const scopes=trackedObservationScopes();let failedEffect=false;
 const f=await threeSourceFixture(t,{observationScope:signal=>{const scope=scopes.open(signal);return{...scope,async drain(){await scope.drain();if(failedEffect)throw Error('Synthetic descriptor cleanup failure');}};}});
 const transport=fakePublication(f,{unknownAt:'/assets?name=',onCall(method,endpoint){if(method==='POST'&&endpoint.includes('/assets?name='))failedEffect=true;}});
 await assert.rejects(()=>publishV2Fixture(f,transport),error=>{assert(error instanceof AggregateError);assert.match(error.message,/PUBLICATION_STOPPED_INSPECT_ORIGINAL_EVIDENCE/);assert.equal(error.errors.length,2);assert.match(error.errors[0].message,/PUBLICATION_STOPPED_INSPECT_ORIGINAL_EVIDENCE/);assert.match(error.errors[1].message,/Synthetic descriptor cleanup failure/);return true;});
 assert.equal(transport.calls.filter(c=>c.method==='POST'&&c.endpoint.includes('/assets?name=')).length,1);assert.equal(transport.calls.some(c=>c.method==='PATCH'||c.method==='DELETE'),false);assert.equal(scopes.active.size,0);assert.equal(scopes.opened,scopes.closed);const failure=JSON.parse(fs.readFileSync(join(f.root,'publication/failure.json')));assert.equal(failure.automaticRetry,false);assert.equal(failure.evidenceRetained,true);
});

// Synthetic report provenance only; no installed execution or release credit.
test('LC full release reader rejects missing helper pins and changed helper bytes',async t=>{
 const f=fixture(t),baseline=JSON.parse(fs.readFileSync(f.input.correctionReport.ref)),selectionRef=join(f.evidence,'LC','selection.json'),originalSelection=JSON.parse(fs.readFileSync(selectionRef));
 for(const name of ['execution.mjs','browser.mjs','support.mjs','preflight.mjs','e22.test.mjs']){
  f.rewriteCorrection((_r,s)=>{delete s.collectorPins[name];});
  await assert.rejects(f.prepare,/RELEASE_EVIDENCE: Unexpected input fields/);
  f.put(selectionRef,originalSelection);f.input.correctionReport=f.put(f.input.correctionReport.ref,baseline);
  const file=join(f.source,'tests/acceptance/v090',name),before=fs.readFileSync(file);
  fs.appendFileSync(file,'// changed executable helper\n');
  await assert.rejects(f.prepare,/Release requires exact clean committed source/);
  fs.writeFileSync(file,before);
 }
 assert.equal((await f.prepare()).acceptance.correction.passed,20);
});

test('LC mixed release reader binds the full helper closure without crediting source fixtures',async t=>{
 const f=fixture(t),files=f.input.candidate.files,service=createNativeQualificationService({},{}),actor={id:'synthetic',projects:['synthetic'],permissions:['read']};
 const buildInput=()=>({schema:'runtime-qualified-release-evidence-input/v2',sourceCommit:f.input.candidate.sourceCommit,manifest:files['distribution-manifest.json'],archive:files['evopilot-runtime-0.9.0-darwin-arm64.tar.gz'],sourceRevision:files['source-revision.txt'],scope:f.input.scope,qualifications:[],executions:[],originalExecutions:[...f.input.reports.map(r=>r.report),f.input.usageReport,f.input.correctionReport].flatMap(report=>JSON.parse(fs.readFileSync(report.ref)).results.map(r=>({caseId:r.caseInstanceId,report})))});
 const audit=async()=>{const result=await inspectQualifiedAcceptanceEvidence(f.source,buildInput(),service,actor,signal());closeQualifiedAcceptanceObservation(result);return result;};
 const result=await audit();assert.equal(result.covered,698);assert.equal(result.reviewRequiredExecuted,698);assert.equal(result.typedExecuted,0);assert.equal(result.reused,0);assert.equal(result.executionAuthenticity,'ACTUAL_ORIGINAL_SOURCE_REVIEW_REQUIRED');assert.equal(result.productAcceptance,'NOT_EVALUATED');assert.equal(result.releaseAuthorized,false);
 const baseline=JSON.parse(fs.readFileSync(f.input.correctionReport.ref)),selectionRef=join(f.evidence,'LC','selection.json'),originalSelection=JSON.parse(fs.readFileSync(selectionRef));
 for(const name of ['execution.mjs','browser.mjs','support.mjs','preflight.mjs','e22.test.mjs']){
  f.rewriteCorrection((_r,s)=>{delete s.collectorPins[name];});
  await assert.rejects(audit,/Unexpected input fields/);
  f.put(selectionRef,originalSelection);f.input.correctionReport=f.put(f.input.correctionReport.ref,baseline);
  f.rewriteCorrection((_r,s)=>{s.collectorPins[name]='0'.repeat(64);});
  await assert.rejects(audit,/Original collector is not the exact committed current source/);
  f.put(selectionRef,originalSelection);f.input.correctionReport=f.put(f.input.correctionReport.ref,baseline);
 }
 assert.equal((await audit()).covered,698);
});

test('LC06 and LC07 actual report assembler reaches the public mixed reader with honest partial reports',async t=>{
 const {lcProviderSelectionRecord,assembleLcProviderReport}=await import('../acceptance/v090/correction.test.mjs'),f=mixedFixture(t),original=JSON.parse(fs.readFileSync(f.input.correctionReport.ref)),selection=JSON.parse(fs.readFileSync(join(f.evidence,'LC','selection.json'))),lanes=[];
 for(const caseId of ['LC06','LC07']){
  const dir=join(f.evidence,caseId),row=original.results.find(r=>r.caseInstanceId===caseId),selected=lcProviderSelectionRecord({sourceCommit:selection.sourceCommit,phase:'PRE_RELEASE',qualification:'FINAL_CANDIDATE',caseIds:[caseId]},selection.candidate,selection.addendumDigest,Object.fromEntries(Object.entries(selection.collectorPins).filter(([name])=>name!=='e22.test.mjs'))),selectedRef=f.put(join(dir,'selection.json'),selected);
  for(const e of [...original.setupEvidence,...row.vectors.flatMap(v=>v.evidence)])f.put(join(dir,e.artifact),fs.readFileSync(join(f.evidence,'LC',e.artifact)));
  const {result,report}=assembleLcProviderReport({selected,selectionDigest:selectedRef.sha256,catalog:f.correctionCases,setupEvidence:original.setupEvidence,vectors:row.vectors,status:'PASS',assertions:{synthetic:'Actual assembler compatibility; observations are synthetic, formal credit zero'}});
  assert.equal(report.scenarioStatus,'INCOMPLETE');assert.equal(report.selected,1);assert.equal(report.scenarioDenominator,20);assert.equal(report.fullDenominator,709);assert.equal(report.unexecutedCaseIds.length,19);
  f.put(join(dir,caseId+'.json'),result);const ref=f.put(join(dir,'REPORT.json'),report),entry=f.inputV2.originalExecutions.find(e=>e.caseId===caseId);entry.report=ref;lanes.push({caseId,dir,report,result,entry});
 }
 const review=await f.prepareV2();assert.equal(review.acceptance.covered,698);assert.equal(review.acceptance.reviewRequiredExecuted,698);assert.equal(review.acceptance.executionAuthenticity,'ACTUAL_ORIGINAL_SOURCE_REVIEW_REQUIRED');assert.equal(review.releaseAuthorized,false);closeQualifiedAcceptanceObservation(review.acceptance);
 for(const lane of lanes){
  const changed=structuredClone(lane.report);delete changed.results[0].vectors[0].phase;
  f.put(join(lane.dir,lane.caseId+'.json'),changed.results[0]);lane.entry.report=f.put(join(lane.dir,'REPORT.json'),changed);
  await assert.rejects(f.prepareV2,/Nonpassing original correction vector/);
  f.put(join(lane.dir,lane.caseId+'.json'),lane.result);lane.entry.report=f.put(join(lane.dir,'REPORT.json'),lane.report);
 }
 const restored=await f.prepareV2();assert.equal(restored.acceptance.covered,698);closeQualifiedAcceptanceObservation(restored.acceptance);
});
