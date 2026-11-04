// Synthetic integrity fixtures only. No business E2E, release or human approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {inspectAcceptanceEvidence} from '../../dist/release/evidence.js';

const repository=fileURLToPath(new URL('../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(t){
 const root=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'runtime-evidence-audit-')),source=join(root,'source'),evidenceRoot=join(root,'evidence');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(source);fs.mkdirSync(evidenceRoot,{mode:0o700});
 const put=(file,value)=>{fs.mkdirSync(dirname(file),{recursive:true});const bytes=Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');fs.writeFileSync(file,bytes,{mode:0o600});return{ref:file,sha256:sha(bytes)};};
 for(const file of ['package.json','package-lock.json',...fs.readdirSync(join(repository,'governance')).filter(n=>n.endsWith('.json')).map(n=>'governance/'+n)])put(join(source,file),fs.readFileSync(join(repository,file)));
 for(const file of ['support.mjs','browser.mjs','maintenance.mjs',...Array.from({length:22},(_,i)=>'e'+String(i+1).padStart(2,'0')+'.test.mjs')])put(join(source,'tests/acceptance/v090',file),'// SYNTHETIC collector identity fixture; never represents actual E2E.\n');
 const git=args=>execFileSync('git',['-c','core.fsmonitor=false','-C',source,...args],{stdio:['ignore','pipe','pipe']}).toString();
 git(['init','--quiet']);git(['add','.']);git(['-c','user.name=Synthetic evidence test','-c','user.email=synthetic@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','Synthetic audit fixture, not product evidence']);const sourceCommit=git(['rev-parse','HEAD']).trim();
 const archive=put(join(evidenceRoot,'synthetic.tgz'),'SYNTHETIC archive bytes; not an installable Release.\n'),manifest=put(join(evidenceRoot,'manifest.json'),{schema:'runtime-standalone-distribution/v1',version:'0.9.0',archiveDigest:archive.sha256,files:{'package.json':{type:'file',sha256:sha(Buffer.from('{}')),bytes:2,mode:0o644}}}),sourceRevision=put(join(evidenceRoot,'source.txt'),sourceCommit+'\n');
 const matrixBytes=fs.readFileSync(join(source,'governance/parameter-matrix-v090.json')),matrix=JSON.parse(matrixBytes),candidate={manifestDigest:manifest.sha256,archiveDigest:archive.sha256,version:'0.9.0',serviceId:'synthetic',workspaceId:'synthetic',projectId:'synthetic'},candidateDigest='sha256:'+manifest.sha256;
 const input={schema:'runtime-release-evidence-input/v1',sourceCommit,manifest,archive,sourceRevision,reports:[]};
 for(let i=1;i<=20;i++){
  const scenario='E'+String(i).padStart(2,'0'),dir=join(evidenceRoot,scenario),ids=matrix.caseInstances.filter(c=>c.scenario===scenario).map(c=>c.caseInstanceId),collectorPins=Object.fromEntries(['support.mjs',scenario.toLowerCase()+'.test.mjs',...(['E04','E06','E07','E12'].includes(scenario)?['browser.mjs']:[]),...(['E14','E15'].includes(scenario)?['maintenance.mjs']:[])].map(name=>[name,sha(fs.readFileSync(join(source,'tests/acceptance/v090',name)))]));
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
test('browser and maintenance helper dependencies are part of exact collector evidence bindings',t=>{
 const f=fixture(t);
 for(const scenario of ['E04','E06','E07','E12','E14','E15']){
  const helper=['E14','E15'].includes(scenario)?'maintenance.mjs':'browser.mjs';
  const entry=f.input.reports.find(r=>r.scenario===scenario),selectionRef=join(f.evidenceRoot,scenario,'selection.json'),selection=JSON.parse(fs.readFileSync(selectionRef)),original=structuredClone(selection),report=JSON.parse(fs.readFileSync(entry.report.ref));
  for(const value of [null,'0'.repeat(64)]){
   if(value===null)delete selection.collectorPins[helper];else selection.collectorPins[helper]=value;
   report.selectionDigest=f.put(selectionRef,selection).sha256;entry.report=f.put(entry.report.ref,report);assert.throws(f.audit);
  }
  report.selectionDigest=f.put(selectionRef,original).sha256;entry.report=f.put(entry.report.ref,report);
 }
 assert.equal(f.audit().passed,655);
});
