// Synthetic integrity fixtures only. No business E2E, release or human approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {inspectAcceptanceEvidence,inspectE20PrerequisiteEvidence} from '../../dist/release/evidence.js';

const repository=fileURLToPath(new URL('../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(t,{prerequisitesOnly=false}={}){
 const root=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'runtime-evidence-audit-')),source=join(root,'source'),evidenceRoot=join(root,'evidence');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(source);fs.mkdirSync(evidenceRoot,{mode:0o700});
 const put=(file,value)=>{fs.mkdirSync(dirname(file),{recursive:true});const bytes=Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');fs.writeFileSync(file,bytes,{mode:0o600});return{ref:file,sha256:sha(bytes)};};
 for(const file of ['package.json','package-lock.json',...fs.readdirSync(join(repository,'governance')).filter(n=>n.endsWith('.json')).map(n=>'governance/'+n)])put(join(source,file),fs.readFileSync(join(repository,file)));
 for(const file of ['support.mjs','preflight.mjs','browser.mjs','maintenance.mjs','execution.mjs',...Array.from({length:22},(_,i)=>'e'+String(i+1).padStart(2,'0')+'.test.mjs')])put(join(source,'tests/acceptance/v090',file),'// SYNTHETIC collector identity fixture; never represents actual E2E.\n');
 const git=args=>execFileSync('git',['-c','core.fsmonitor=false','-C',source,...args],{stdio:['ignore','pipe','pipe']}).toString();
 git(['init','--quiet']);git(['add','.']);git(['-c','user.name=Synthetic evidence test','-c','user.email=synthetic@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','Synthetic audit fixture, not product evidence']);const sourceCommit=git(['rev-parse','HEAD']).trim();
 const archive=put(join(evidenceRoot,'synthetic.tgz'),'SYNTHETIC archive bytes; not an installable Release.\n'),manifest=put(join(evidenceRoot,'manifest.json'),{schema:'runtime-standalone-distribution/v1',version:'0.9.0',archiveDigest:archive.sha256,files:{'package.json':{type:'file',sha256:sha(Buffer.from('{}')),bytes:2,mode:0o644}}}),sourceRevision=put(join(evidenceRoot,'source.txt'),sourceCommit+'\n');
 const matrixBytes=fs.readFileSync(join(source,'governance/parameter-matrix-v090.json')),matrix=JSON.parse(matrixBytes),candidate={manifestDigest:manifest.sha256,archiveDigest:archive.sha256,version:'0.9.0',serviceId:'synthetic',workspaceId:'synthetic',projectId:'synthetic'},candidateDigest='sha256:'+manifest.sha256;
 const input={schema:'runtime-release-evidence-input/v1',sourceCommit,manifest,archive,sourceRevision,reports:[]};
 for(let i=1;i<=(prerequisitesOnly?19:20);i++){
  const scenario='E'+String(i).padStart(2,'0'),dir=join(evidenceRoot,scenario),ids=matrix.caseInstances.filter(c=>c.scenario===scenario).map(c=>c.caseInstanceId),collectorPins=Object.fromEntries(['support.mjs','preflight.mjs',scenario.toLowerCase()+'.test.mjs',...(['E01','E02','E04','E05','E06','E07','E12','E13','E16','E17','E18','E19'].includes(scenario)?['browser.mjs']:[]),...(['E05','E14','E15','E17'].includes(scenario)?['maintenance.mjs']:[]),...(['E01','E02','E04','E05','E13','E16','E18'].includes(scenario)?['execution.mjs']:[]),...(scenario==='E13'?['e11.test.mjs']:[])].map(name=>[name,sha(fs.readFileSync(join(source,'tests/acceptance/v090',name)))]));
  const selection=put(join(dir,'selection.json'),{scenario,qualification:'FINAL_CANDIDATE',candidate,candidateDigest,collectorPins,matrixDigest:sha(matrixBytes),selectedCaseIds:ids,scenarioDenominator:ids.length,fullDenominator:664});
  const records=id=>{const prefix=id??'setup',request=put(join(dir,prefix+'-request.json'),{caseInstanceId:id,synthetic:true,request:'read-only fixture'}),response=put(join(dir,prefix+'-response.json'),{caseInstanceId:id,synthetic:true,response:'fixture result'});return{caseInstanceId:id,request:prefix+'-request.json',requestDigest:request.sha256,response:prefix+'-response.json',fileDigest:response.sha256};};
  const results=ids.map(caseInstanceId=>{const r={caseInstanceId,status:'PASS',qualification:'FINAL_CANDIDATE',candidateDigest,assertions:{synthetic:'Schema/integrity fixture only; not product acceptance'},evidence:[records(caseInstanceId)]};put(join(dir,caseInstanceId+'.json'),r);return r;});
  const report={scenario,candidate,candidateDigest,selectionDigest:selection.sha256,qualification:'FINAL_CANDIDATE',scenarioDenominator:ids.length,fullDenominator:664,selected:ids.length,executed:ids.length,passed:ids.length,failed:0,unexecutedCaseIds:[],scenarioStatus:'OBSERVED_PASS',productAcceptance:'NOT_EVALUATED',releaseAuthorized:false,setupEvidence:[records(null)],results};
  input.reports.push({scenario,report:put(join(dir,'REPORT.json'),report)});
 }
 return{root,source,evidenceRoot,input,put,audit:()=>inspectAcceptanceEvidence(source,input)};
}
test('all 655 pinned pre-release records are required and integrity never supplies source CI or release authority',t=>{
 const f=fixture(t),r=f.audit();assert.equal(r.required,655);assert.equal(r.passed,655);assert.equal(r.postReleaseRemaining,9);assert.equal(r.recordIntegrity,'VERIFIED');assert.equal(r.productAcceptance,'NOT_EVALUATED');assert.equal(r.releaseAuthorized,false);assert.equal(r.evidenceFiles,2*(655+20));assert.equal(r.remainingChecks.length,3);
});
test('partial, development, duplicated, skipped, unasserted and foreign-candidate reports cannot close the denominator',t=>{
 const f=fixture(t),entry=f.input.reports[0],original=fs.readFileSync(entry.report.ref),originalPin=entry.report.sha256;
 for(const mutate of [
  r=>r.qualification='DEVELOPMENT',r=>r.failed=1,r=>r.scenarioStatus='INCOMPLETE',r=>r.unexecutedCaseIds=['E01.journey'],r=>r.passed=0,
  r=>r.results.pop(),r=>r.results[0]=r.results[1],r=>r.results[0].status='SKIP',r=>r.results[0].assertions={},r=>r.results[0].candidateDigest='sha256:'+'b'.repeat(64),r=>r.candidate.version='0.8.3',r=>r.selected=0,
 ]){
  const report=JSON.parse(original);mutate(report);entry.report=f.put(entry.report.ref,report);assert.throws(f.audit);fs.writeFileSync(entry.report.ref,original);entry.report.sha256=originalPin;
 }
 const missing=f.input.reports.pop();assert.throws(f.audit);f.input.reports.push(missing);
 f.input.reports[19]={...f.input.reports[0]};assert.throws(f.audit);
});
test('reviewed report, selection, original request/response and original case bytes are independently pinned',t=>{
 const f=fixture(t),dir=join(f.evidenceRoot,'E01');
 for(const file of ['REPORT.json','selection.json','E01.journey-request.json','E01.journey-response.json','E01.journey.json']){
  const ref=join(dir,file),bytes=fs.readFileSync(ref);fs.writeFileSync(ref,Buffer.concat([bytes,Buffer.from(' ')]));
  if(file==='E01.journey.json'){const value=JSON.parse(bytes);value.assertions={tampered:true};fs.writeFileSync(ref,JSON.stringify(value));}
  assert.throws(f.audit);fs.writeFileSync(ref,bytes);
 }
 const ref=join(dir,'E01.journey-request.json');fs.chmodSync(ref,0o644);assert.throws(f.audit);fs.chmodSync(ref,0o600);
 const original=fs.readFileSync(ref),outside=join(f.root,'outside.json');f.put(outside,original);fs.unlinkSync(ref);fs.symlinkSync(outside,ref);assert.throws(f.audit);fs.unlinkSync(ref);fs.writeFileSync(ref,original,{mode:0o600});assert.equal(f.audit().passed,655);
});
test('changed candidate, wrong source revision and edited collectors cannot reuse old qualification',t=>{
 const f=fixture(t),original=fs.readFileSync(f.input.archive.ref);fs.writeFileSync(f.input.archive.ref,'changed');assert.throws(f.audit);fs.writeFileSync(f.input.archive.ref,original);
 const source=f.input.sourceCommit;f.input.sourceCommit='b'.repeat(40);assert.throws(f.audit);f.input.sourceCommit=source;
 const collector=join(f.source,'tests/acceptance/v090/e01.test.mjs');fs.appendFileSync(collector,'// edited\n');assert.throws(f.audit,/clean committed source/);
});
test('preflight, browser, maintenance and interruption helpers are part of exact collector evidence bindings',t=>{
 const f=fixture(t);
 const pairs=[...['E03','E20'].map(scenario=>[scenario,'preflight.mjs']),...['E01','E02','E04','E05','E06','E07','E12','E13','E16','E17','E18','E19'].map(scenario=>[scenario,'browser.mjs']),...['E05','E14','E15','E17'].map(scenario=>[scenario,'maintenance.mjs']),...['E01','E02','E04','E05','E13','E16','E18'].map(scenario=>[scenario,'execution.mjs']),['E13','e11.test.mjs']];
 for(const [scenario,helper] of pairs){
  const entry=f.input.reports.find(r=>r.scenario===scenario),selectionRef=join(f.evidenceRoot,scenario,'selection.json'),selection=JSON.parse(fs.readFileSync(selectionRef)),original=structuredClone(selection),report=JSON.parse(fs.readFileSync(entry.report.ref));
  for(const value of [null,'0'.repeat(64)]){
   if(value===null)delete selection.collectorPins[helper];else selection.collectorPins[helper]=value;
   report.selectionDigest=f.put(selectionRef,selection).sha256;entry.report=f.put(entry.report.ref,report);assert.throws(f.audit);
  }
  report.selectionDigest=f.put(selectionRef,original).sha256;entry.report=f.put(entry.report.ref,report);
 }
 assert.equal(f.audit().passed,655);
});
test('E20 prerequisites require exactly 652 records without an E20 placeholder and cannot satisfy the full 655 audit',t=>{
 const f=fixture(t,{prerequisitesOnly:true}),input={...f.input,schema:'runtime-e20-prerequisite-evidence-input/v1'};
 assert.equal(fs.existsSync(join(f.evidenceRoot,'E20')),false);
 const r=inspectE20PrerequisiteEvidence(f.source,input);
 assert.equal(r.required,652);assert.equal(r.passed,652);assert.equal(r.fullPreReleaseRequired,655);
 assert.equal(r.remainingE20,3);assert.deepEqual(r.remainingE20CaseIds,['E20.journey','E20.EX12','E20.CV07']);
 assert.equal(r.postReleaseRemaining,9);assert.equal(r.fullReleaseAuditRequired,true);
 assert.equal(r.evidenceFiles,2*(652+19));assert.equal(r.productAcceptance,'NOT_EVALUATED');assert.equal(r.releaseAuthorized,false);
 assert.equal(r.executionAuthenticity,'NOT_ESTABLISHED_BY_FILE_HASHES');
 assert.throws(()=>inspectAcceptanceEvidence(f.source,input),/Wrong source input/);
 assert.throws(f.audit,/Exactly E01–E20 reports are required/);
 for(const extra of [{exclude:['E01']},{expectedCount:652},{remainingE20:0}])assert.throws(()=>inspectE20PrerequisiteEvidence(f.source,{...input,...extra}),/Unexpected input fields/);
 const complete=fixture(t),full=complete.audit();assert.equal(full.passed,r.passed+r.remainingE20);
 assert.throws(()=>inspectE20PrerequisiteEvidence(complete.source,{...complete.input,schema:input.schema}),/Exactly E01–E19 prerequisite reports are required/);
});
test('fixed E20 prerequisite audit rejects missing, duplicated and foreign scenarios before reading their reports',t=>{
 const f=fixture(t,{prerequisitesOnly:true}),input={...f.input,schema:'runtime-e20-prerequisite-evidence-input/v1'};
 for(const reports of [[],input.reports.slice(1),[...input.reports.slice(0,18),input.reports[0]],[...input.reports.slice(0,18),{...input.reports[18],scenario:'E21'}]]){
  assert.throws(()=>inspectE20PrerequisiteEvidence(f.source,{...input,reports}),/Exactly E01–E19 prerequisite reports are required/);
 }
 assert.equal(inspectE20PrerequisiteEvidence(f.source,input).passed,652);
});
test('E20 prerequisite negative cases reach the actual partial, candidate, case-set, status and raw-evidence guards',t=>{
 const f=fixture(t,{prerequisitesOnly:true}),input={...f.input,schema:'runtime-e20-prerequisite-evidence-input/v1'},entry=input.reports[0],original=fs.readFileSync(entry.report.ref),pin=entry.report.sha256;
 const audit=()=>inspectE20PrerequisiteEvidence(f.source,input);
 for(const [mutate,reason] of [
  [r=>r.selected=0,/Partial, failed, skipped or stale report/],
  [r=>r.unexecutedCaseIds=['E01.journey'],/Partial, failed, skipped or stale report/],
  [r=>r.failed=1,/Partial, failed, skipped or stale report/],
  [r=>r.qualification='DEVELOPMENT',/Report is not for this final candidate/],
  [r=>r.candidateDigest='sha256:'+'b'.repeat(64),/Report is not for this final candidate/],
  [r=>r.results.pop(),/Result set is missing, duplicated or foreign/],
  [r=>r.results[0]=r.results[1],/Result set is missing, duplicated or foreign/],
  [r=>r.results[0].caseInstanceId='E21.journey',/Result set is missing, duplicated or foreign/],
  [r=>r.results[0].status='SKIP',/Nonpassing or unasserted case/],
  [r=>r.results[0].status='XFAIL',/Nonpassing or unasserted case/],
  [r=>r.results[0].assertions={},/Nonpassing or unasserted case/],
 ]){
  const report=JSON.parse(original);mutate(report);entry.report=f.put(entry.report.ref,report);assert.throws(audit,reason);
  fs.writeFileSync(entry.report.ref,original);entry.report.sha256=pin;
 }
 const raw=join(f.evidenceRoot,'E01/E01.journey-response.json'),bytes=fs.readFileSync(raw);fs.appendFileSync(raw,' ');
 assert.throws(audit,/Original evidence bytes changed/);fs.writeFileSync(raw,bytes);
 assert.equal(audit().passed,652);assert.equal(fs.existsSync(join(f.evidenceRoot,'E20')),false);
});

import {inspectQualifiedAcceptanceEvidence} from '../../dist/release/evidence.js';
import {createNativeQualificationService} from '../../dist/lifecycle/evidence-qualification.js';
test('v2 release audit refuses caller-supplied verifiers and serialized passing assessments',async()=>{
 const controller=new AbortController();for(const service of [{inspect:async()=>({schema:'runtime-evidence-qualification/v2',status:'QUALIFIED'})},{schema:'runtime-evidence-qualification/v2',status:'QUALIFIED'},{}])await assert.rejects(inspectQualifiedAcceptanceEvidence(repository,{},service,{},controller.signal),{code:'TRUSTED_QUALIFICATION_SERVICE_REQUIRED'});
});
test('v2 release audit freezes the exact 698 PRE identities before any owner lookup',async t=>{
 const f=fixture(t),service=createNativeQualificationService({},{}),common={schema:'runtime-qualified-release-evidence-input/v2',sourceCommit:f.input.sourceCommit,manifest:f.input.manifest,archive:f.input.archive,sourceRevision:f.input.sourceRevision,scope:{workspaceId:'synthetic',projectId:'synthetic'},qualifications:[],executions:[],originalExecutions:[]},signal=new AbortController().signal;
 for(const qualifications of [[],[{caseId:'LC12',actionRef:'post-release',actionDigest:'sha256:'+'a'.repeat(64)}],Array.from({length:698},()=>({caseId:'E01.journey',actionRef:'duplicate',actionDigest:'sha256:'+'a'.repeat(64)}))])await assert.rejects(inspectQualifiedAcceptanceEvidence(f.source,{...common,qualifications},service,{},signal),/Every fixed PRE obligation/);
});
