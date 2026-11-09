// Synthetic byte-integrity fixtures only. No real Host, product acceptance or
// release authority is inferred from these deliberately invented records.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {inspectUsageAcceptanceEvidence} from '../../dist/release/usage-evidence.js';

const repository=fileURLToPath(new URL('../../',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const ids=Array.from({length:23},(_,i)=>'UT'+String(i+1).padStart(2,'0'));
function fixture(t){
  const root=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'runtime-usage-audit-')),source=join(root,'source'),evidenceRoot=join(root,'evidence');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(source);fs.mkdirSync(evidenceRoot,{mode:0o700});
  const put=(file,value)=>{fs.mkdirSync(dirname(file),{recursive:true});const bytes=Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');fs.writeFileSync(file,bytes,{mode:0o600});return{ref:file,sha256:sha(bytes)};};
  for(const file of ['package.json','package-lock.json',...fs.readdirSync(join(repository,'governance')).filter(n=>n.endsWith('.json')).map(n=>'governance/'+n)])put(join(source,file),fs.readFileSync(join(repository,file)));
  const collector='tests/acceptance/v090/usage.test.mjs';put(join(source,collector),'// SYNTHETIC identity fixture; never actual acceptance.\n');
  const git=args=>execFileSync('/usr/bin/git',['-c','core.fsmonitor=false','-C',source,...args],{env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},stdio:['ignore','pipe','pipe']}).toString();
  const commit=()=>{git(['add','.']);git(['-c','user.name=Synthetic evidence test','-c','user.email=synthetic@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','Synthetic fixture only']);return git(['rev-parse','HEAD']).trim();};
  git(['init','--quiet']);const sourceCommit=commit();
  const archive=put(join(evidenceRoot,'synthetic.tgz'),'SYNTHETIC archive bytes, not installable software.\n');
  const manifest=put(join(evidenceRoot,'manifest.json'),{schema:'runtime-standalone-distribution/v1',version:'0.9.0',archiveDigest:archive.sha256,files:{'package.json':{type:'file',sha256:sha(Buffer.from('{}')),bytes:2,mode:0o644}}});
  const sourceRevision=put(join(evidenceRoot,'source.txt'),sourceCommit+'\n');
  const candidate={manifestDigest:manifest.sha256,archiveDigest:archive.sha256,version:'0.9.0',serviceId:'synthetic',workspaceId:'synthetic',projectId:'synthetic'},candidateDigest='sha256:'+manifest.sha256;
  const selection={scenario:'UT',sourceCommit,qualification:'FINAL_CANDIDATE',candidate,candidateDigest,addendumDigest:sha(fs.readFileSync(join(source,'governance/token-usage-v090.json'))),collectorPins:{'usage.test.mjs':sha(fs.readFileSync(join(source,collector)))},selectedCaseIds:ids};
  const selectionPin=put(join(evidenceRoot,'selection.json'),selection);
  const record=id=>{const prefix=id??'setup',request=put(join(evidenceRoot,prefix+'-request.json'),{caseInstanceId:id,synthetic:true,request:'read-only fixture'}),response=put(join(evidenceRoot,prefix+'-response.json'),{caseInstanceId:id,synthetic:true,response:'fixture observation'});return{caseInstanceId:id,request:prefix+'-request.json',requestDigest:request.sha256,response:prefix+'-response.json',fileDigest:response.sha256};};
  const results=ids.map(caseInstanceId=>({caseInstanceId,status:'PASS',qualification:'FINAL_CANDIDATE',candidateDigest,assertions:{synthetic:'Integrity fixture only; not a real assertion about product behavior'},evidence:[record(caseInstanceId)]}));
  const report={schema:'runtime-usage-acceptance-report/v1',scenario:'UT',sourceCommit,candidate,candidateDigest,selectionDigest:selectionPin.sha256,qualification:'FINAL_CANDIDATE',scenarioDenominator:23,fullDenominator:688,selected:23,executed:23,passed:23,failed:0,unexecutedCaseIds:[],scenarioStatus:'OBSERVED_PASS',productAcceptance:'NOT_EVALUATED',releaseAuthorized:false,setupEvidence:[record(null)],results};
  for(const r of results)put(join(evidenceRoot,r.caseInstanceId+'.json'),r);
  const input={schema:'runtime-usage-evidence-input/v1',sourceCommit,manifest,archive,sourceRevision,report:put(join(evidenceRoot,'REPORT.json'),report)};
  const saveReport=value=>{input.report=put(input.report.ref,value);};
  const saveSelection=value=>{report.selectionDigest=put(selectionPin.ref,value).sha256;saveReport(report);};
  return{root,source,evidenceRoot,input,report,selection,put,saveReport,saveSelection,commit,audit:()=>inspectUsageAcceptanceEvidence(source,input)};
}

test('23 complete usage records are additive and cannot replace original acceptance, authentic execution, source CI or authority',t=>{
  const f=fixture(t),r=f.audit();
  assert.equal(r.required,23);assert.equal(r.passed,23);assert.equal(r.originalRequired,664);assert.equal(r.originalAcceptanceIndependentlyRequired,true);assert.equal(r.combinedRequired,688);assert.equal(r.usagePostReleaseRemaining,1);
  assert.equal(r.recordIntegrity,'VERIFIED');assert.equal(r.executionAuthenticity,'NOT_ESTABLISHED_BY_FILE_HASHES');assert.equal(r.productAcceptance,'NOT_EVALUATED');assert.equal(r.releaseAuthorized,false);assert.equal(r.evidenceFiles,48);assert.equal(r.remainingChecks.length,5);
});

test('partial, development, skipped, duplicate and UT24-in-pre-release reports cannot satisfy UT01–UT23',t=>{
  const f=fixture(t),original=structuredClone(f.report);
  for(const mutate of [
    r=>r.qualification='DEVELOPMENT',r=>r.fullDenominator=664,r=>r.scenarioDenominator=24,r=>r.executed=22,r=>r.passed=22,r=>r.failed=1,r=>r.unexecutedCaseIds=['UT19'],r=>r.scenarioStatus='INCOMPLETE',
    r=>r.results.pop(),r=>r.results[0]=r.results[1],r=>r.results[0].caseInstanceId='UT24',r=>r.results[0].status='SKIP',r=>r.results[0].assertions={},r=>r.setupEvidence=[],r=>r.releaseAuthorized=true,r=>r.productAcceptance='PASS',
  ]){const r=structuredClone(original);mutate(r);f.saveReport(r);assert.throws(f.audit);}
  f.saveReport(original);assert.equal(f.audit().passed,23);
});

test('report and selection must bind exact source, addendum, collector and candidate',t=>{
  const f=fixture(t),original=structuredClone(f.report),selection=structuredClone(f.selection);
  for(const mutate of [r=>r.sourceCommit='a'.repeat(40),r=>r.candidateDigest='sha256:'+'a'.repeat(64),r=>r.candidate.version='0.8.3',r=>r.candidate.archiveDigest='a'.repeat(64)]){
    const r=structuredClone(original);mutate(r);f.saveReport(r);assert.throws(f.audit);
  }
  f.saveReport(original);
  for(const mutate of [s=>s.sourceCommit='a'.repeat(40),s=>s.addendumDigest='a'.repeat(64),s=>s.collectorPins['usage.test.mjs']='a'.repeat(64),s=>s.collectorPins['support.mjs']='b'.repeat(64),s=>s.selectedCaseIds.pop(),s=>s.selectedCaseIds[0]='UT24',s=>s.selectedCaseIds[0]='UT02',s=>s.candidate.serviceId='different']){
    const s=structuredClone(selection);mutate(s);f.saveSelection(s);assert.throws(f.audit);
  }
  f.saveSelection(selection);assert.equal(f.audit().passed,23);
});

test('changed raw evidence and original case records remain invalid even with an unchanged passing aggregate',t=>{
  const f=fixture(t);
  for(const file of ['REPORT.json','selection.json','UT01-request.json','UT01-response.json','UT01.json']){
    const ref=join(f.evidenceRoot,file),original=fs.readFileSync(ref);
    if(file==='UT01.json'){const value=JSON.parse(original);value.assertions={tampered:true};fs.writeFileSync(ref,JSON.stringify(value));}
    else fs.appendFileSync(ref,' ');
    assert.throws(f.audit);fs.writeFileSync(ref,original);
  }
  assert.equal(f.audit().passed,23);
});

test('raw files cannot be self-referential, aliased between cases or owned by a different case',t=>{
  const f=fixture(t),original=structuredClone(f.report);
  for(const mutate of [
    r=>r.results[0].evidence=[],
    r=>r.results[0].evidence[0].caseInstanceId='UT02',
    r=>r.results[0].evidence[0].artifact='raw.json',
    r=>r.results[0].evidence[0].request='../outside.json',
    r=>r.results[0].evidence[0].request='REPORT.json',
    r=>r.results[0].evidence[0].request='UT01.json',
    r=>r.results[1].evidence=[{...r.results[0].evidence[0],caseInstanceId:'UT02'}],
  ]){
    const r=structuredClone(original);mutate(r);
    for(const result of r.results)f.put(join(f.evidenceRoot,result.caseInstanceId+'.json'),result);
    f.saveReport(r);assert.throws(f.audit);
  }
  for(const result of original.results)f.put(join(f.evidenceRoot,result.caseInstanceId+'.json'),result);
  f.saveReport(original);assert.equal(f.audit().passed,23);
});

test('permissions, symlinks, hardlinks and excessive raw files fail closed',t=>{
  const f=fixture(t),ref=join(f.evidenceRoot,'UT01-request.json'),original=fs.readFileSync(ref),outside=join(f.root,'outside.json');
  fs.chmodSync(ref,0o644);assert.throws(f.audit,/private/);fs.chmodSync(ref,0o600);
  f.put(outside,original);fs.unlinkSync(ref);fs.symlinkSync(outside,ref);assert.throws(f.audit,/symlink/);fs.unlinkSync(ref);f.put(ref,original);
  const link=join(f.root,'link.json');fs.linkSync(ref,link);assert.throws(f.audit,/bounded evidence/);fs.unlinkSync(link);
  fs.truncateSync(ref,16777217);assert.throws(f.audit,/bounded evidence/);f.put(ref,original);
  assert.equal(f.audit().passed,23);
});

test('report self-references and case-insensitive reserved aliases cannot masquerade as raw artifacts',t=>{
  const f=fixture(t),original=structuredClone(f.report);
  f.input.report=f.put(join(f.evidenceRoot,'custom-review.json'),original);
  for(const artifact of ['report.json','REPORT.JSON','selection.JSON','ut01.JSON','custom-review.json','CUSTOM-REVIEW.JSON']){
    const report=structuredClone(original);
    report.results[0].evidence=[{caseInstanceId:'UT01',artifact,fileDigest:'a'.repeat(64)}];
    f.put(join(f.evidenceRoot,'UT01.json'),report.results[0]);f.saveReport(report);
    assert.throws(f.audit,/Evidence reference must be a raw owned leaf/);
  }
  f.put(join(f.evidenceRoot,'UT01.json'),original.results[0]);f.saveReport(original);
  assert.equal(f.audit().passed,23);
});

test('raw artifact evidence is allowed with exact bytes but is not execution authentication',t=>{
  const f=fixture(t),bytes=Buffer.from('SYNTHETIC opaque output, not an actual Host transcript.\n'),pin=f.put(join(f.evidenceRoot,'UT19-counter-capture.txt'),bytes);
  f.report.results[18].evidence=[{caseInstanceId:'UT19',artifact:'UT19-counter-capture.txt',fileDigest:pin.sha256}];
  f.put(join(f.evidenceRoot,'UT19.json'),f.report.results[18]);f.saveReport(f.report);
  const r=f.audit();assert.equal(r.evidenceFiles,47);assert.equal(r.executionAuthenticity,'NOT_ESTABLISHED_BY_FILE_HASHES');
  fs.appendFileSync(pin.ref,'changed');assert.throws(f.audit,/Original evidence bytes changed/);
});

test('source, archive and original 664 acceptance cannot be replaced by UT evidence',t=>{
  const f=fixture(t),original=fs.readFileSync(f.input.archive.ref);fs.writeFileSync(f.input.archive.ref,'changed');assert.throws(f.audit);fs.writeFileSync(f.input.archive.ref,original);
  const revision=fs.readFileSync(f.input.sourceRevision.ref);f.input.sourceRevision=f.put(f.input.sourceRevision.ref,'a'.repeat(40)+'\n');assert.throws(f.audit,/Source revision/);f.input.sourceRevision=f.put(f.input.sourceRevision.ref,revision);
  const collector=join(f.source,'tests/acceptance/v090/usage.test.mjs');fs.appendFileSync(collector,'// edited\n');assert.throws(f.audit,/clean committed source/);
  const newCommit=f.commit();f.input.sourceCommit=newCommit;assert.throws(f.audit,/Source revision/);
  const matrixRef=join(f.source,'governance/parameter-matrix-v090.json'),matrix=JSON.parse(fs.readFileSync(matrixRef));matrix.caseInstances.pop();f.put(matrixRef,matrix);f.input.sourceCommit=f.commit();assert.throws(f.audit,/governance is not valid/);
});

test('usage collector import does not read selection or register an acceptance run',()=>{
 const module=join(repository,'tests/acceptance/v090/usage.test.mjs');
 const output=execFileSync(process.execPath,['--input-type=module','-e','const m=await import(process.argv[1]); if(typeof m.executeUsageAcceptance!=="function") throw Error("missing callable entry"); process.stdout.write("import-only");',new URL('file://'+module).href],{encoding:'utf8',env:{...process.env,EVOPILOT_V090_USAGE_SELECTION:'/missing/must-not-read.json'},timeout:5000});
 assert.equal(output,'import-only');
});

test('UT03 installed driver assertions exercise native cumulative ledger semantics',async()=>{
 const {collectUsageReplay}=await import('../acceptance/v090/usage.test.mjs');
 const {deriveDeltas}=await import('../../dist/usage/ledger.js');
 const source={id:'replay-source',parentThreadId:null,baseline:{input:0,output:0,total:0,cachedInput:0,cacheWriteInput:0,reasoningOutput:0}};
 const records=[],bindings=[{sourceId:source.id,afterSequence:0,throughSequence:null}];let bound=false;
 const report=()=>{const deltas=deriveDeltas(source,records,bindings),totals=deltas.map(d=>d.metrics.total);return{
  counts:{total:{recorded:7+totals.reduce((n,v)=>n+(v??0),0),unknownRecords:2+totals.filter(v=>v===null).length}},
  sources:[{id:source.id,records:records.length}],issues:deltas.flatMap(d=>d.issues.map(code=>({code,records:1})))
 };};
 const result=await collectUsageReplay({report,source:async()=>source,bind:async s=>{assert.equal(s,source);bound=true;},append:(s,cumulative,last,context,observedAt)=>{
  assert(bound);assert.equal(s,source);assert.equal(context,true);records.push({sourceId:s.id,sequence:records.length+1,cumulative,last,observedAt});
 },waitFor:async(s,count)=>{assert.equal(s,source);assert.equal(records.length,count);return report();}});
 assert.equal(result.recordedTotal,220);assert.equal(result.syntheticSource,true);
 assert(Date.parse(records[3].observedAt)<Date.parse(records[2].observedAt),'The delayed event actually predates its predecessor');
 assert.equal(report().counts.total.recorded,227);assert.equal(report().counts.total.unknownRecords,3);
});
