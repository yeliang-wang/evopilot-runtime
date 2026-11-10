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

test('usage installed closure accepts pinned bytes and rejects tampering before code import',async()=>{
 const {verifyUsageInstalledBytes,executeUsageAcceptance}=await import('../acceptance/v090/usage.test.mjs');
 const root=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'usage-installed-import-'));
 try{
  const files={},names=['dist/compat/project/files.js','dist/server/security.js','dist/installation/service-control.js'];
  for(const name of names){const ref=join(root,'package',name),bytes=Buffer.from('// original published helper fixture\n');fs.mkdirSync(dirname(ref),{recursive:true});fs.writeFileSync(ref,bytes);files[name]={type:'file',bytes:bytes.length,sha256:sha(bytes)};}
  const manifest={schema:'runtime-standalone-distribution/v1',version:'0.9.0',archiveDigest:'a'.repeat(64),files},manifestBytes=Buffer.from(JSON.stringify(manifest));fs.writeFileSync(join(root,'distribution-manifest.json'),manifestBytes);
  const expected=sha(manifestBytes);assert.deepEqual(verifyUsageInstalledBytes(root,expected).manifest,manifest);
  const marker=join(root,'MUST-NOT-EXECUTE'),injected='import {writeFileSync} from "node:fs"; writeFileSync('+JSON.stringify(marker)+',"executed");\n';
  fs.writeFileSync(join(root,'package',names[0]),injected);
  const selection={schema:'runtime-v090-usage-selection/v1',installedRoot:root,expectedManifestDigest:expected,sourceRevision:{ref:join(root,'source.txt'),sha256:'b'.repeat(64)},connectionRef:join(root,'connection.json'),workspaceId:'synthetic',projectId:'alpha',runId:'import-guard',outputRoot:join(root,'output'),qualification:'DEVELOPMENT',caseIds:['UT03'],instanceId:'original',targetVersion:'0.9.0',principalRevision:1};
  const ref=join(root,'selection.json');fs.writeFileSync(ref,JSON.stringify(selection),{mode:0o600});
  await assert.rejects(executeUsageAcceptance(ref),{code:'ERR_ASSERTION'});
  assert(!fs.existsSync(marker));assert(!fs.existsSync(selection.outputRoot));
  fs.rmSync(join(root,'package',names[0]));fs.symlinkSync(join(root,'package',names[1]),join(root,'package',names[0]));
  assert.throws(()=>verifyUsageInstalledBytes(root,expected),{code:'ERR_ASSERTION'});
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

// SOURCE regression only: synthetic business originals, actual native Codex
// parser and usage report engine. This fixture never earns installed/Host credit.
async function nativeUsageFixture(t,{missingCacheWrite=false,foreignWork={}}={}){
 const {collectUsageNative}=await import('../acceptance/v090/usage.test.mjs');
 const {inspectCodexSource,collectCodexUsage}=await import('../../dist/usage/codex.js');
 const {createUsageReport}=await import('../../dist/usage/reports.js');
 const {digest}=await import('../../dist/server/errors.js'),hash=v=>'sha256:'+digest(v);
 const root=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'runtime-usage-native-source-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const base=['scope','plan','implementation','candidate','verification','release-decision','publication','closure'],at=n=>new Date(Date.parse('2026-01-01T00:00:00Z')+n*1000).toISOString(),count=n=>({input:n,output:1,total:n+1,cachedInput:0,cacheWriteInput:missingCacheWrite?null:0,reasoningOutput:0}),zero=Object.fromEntries(Object.keys(count(1)).map(k=>[k,0]));
 const selection={workspaceId:'workspace',projectId:'project',targetVersion:'0.9.0',instanceId:'main',expectedManifestDigest:'a'.repeat(64)},proof={schema:'runtime-usage-native-originals/v1',candidateDigest:'sha256:'+selection.expectedManifestDigest,workspaceId:selection.workspaceId,projectId:selection.projectId,targetVersion:selection.targetVersion,completionInstanceId:'main',deadlineAt:new Date(Date.now()+60000).toISOString(),maxRequests:600,stages:[],sources:[]};
 const instances=new Map(),objects=new Map(),registered=[],bindingRows=[],captures=new Map(),events=[],stageViews=new Map(),receipts=new Map(),snapshots=[];
 function instance(id){if(!instances.has(id))instances.set(id,{instance:{id,pins:{projectId:'project',targetRef:'target:'+id,budget:{maxAttempts:4,timeoutSeconds:180}},pinsDigest:hash(id),requestIds:[],stages:{}},loopBudget:{maxLoops:4,consumed:1,remaining:3,deadlineAt:at(180)}});return instances.get(id).instance;}
 const plans=[{stage:'implementation',instanceId:'main',phase:'FAILED',second:2},...base.map((stage,i)=>({stage,instanceId:'main',phase:'COMPLETE',second:i+3})),{stage:'implementation',instanceId:'second',phase:'COMPLETE',second:4},{stage:'implementation',instanceId:'later',phase:'COMPLETE',second:12,version:'0.10.0',...foreignWork}];
 for(const [index,p]of plans.entries()){
  const inst=instance(p.instanceId),id='original-'+index,plan={adapterId:'synthetic-native-shape',adapterDigest:hash('adapter'),action:'base.'+p.stage,bindingDigest:hash({}),parameters:{}};
  const body={schema:'runtime-stage-request/v1',id,workspaceId:'workspace',projectId:'project',instanceId:inst.id,stageId:p.stage,pinsDigest:inst.pinsDigest,inputDigest:hash(id),bindingStamp:hash('bindings'),authorityRef:'authority:original',releaseAuthorityRef:p.stage==='publication'?'release:original':null,initiatedBy:{id:'actor',revision:1},plan,planDigest:hash(plan),requestedAt:at(p.requestedSecond??p.second-1),deadlineAt:at(180),...(p.stage==='implementation'&&p.instanceId==='main'&&p.phase==='COMPLETE'?{correctionRef:'correction:original'}:{})},request={...body,digest:hash(body)};
  inst.requestIds.push(id);inst.stages[p.stage]={status:p.phase==='COMPLETE'?'PASSED':'FAILED',requestId:id,attempts:p.stage==='implementation'&&inst.id==='main'&&p.phase==='COMPLETE'?2:1};
  const observation={requestId:id,inputDigest:request.inputDigest,adapterDigest:plan.adapterDigest,phase:p.phase,handle:null,outcome:{requestId:id,inputDigest:request.inputDigest,receiptRef:'native:'+id,status:p.phase,expiresAt:at(180),checks:[]}},evidence={schema:'runtime-stage-observation/v1',requestId:id,observation,reason:'native-observation',observedAt:at(p.second)},observed={observationRef:hash(evidence),evidence,historical:true};
  const event={seq:index+1,revision:index+1,type:'stage-observed',at:at(p.second),data:{instanceId:inst.id,stageId:p.stage,stageRequestId:id,phase:p.phase,observationRef:observed.observationRef}},admission={requestId:'admit-'+id,operation:'lifecycle.stage.request',principalId:'actor',result:{stageRequestId:id}};
  const original={request,observation:observed,event,admission};if(['publication','closure'].includes(p.stage)){const evidence={schema:'runtime-'+p.stage+'-evidence/v1',requestDigest:request.digest,planDigest:request.planDigest};original.nativeEvidence={evidence,evidenceRef:hash(evidence),automaticRedispatch:false,historical:true};}
  proof.stages.push(original);events.push(event);receipts.set(admission.requestId,admission);stageViews.set(id,{request,progress:{requestId:id,phase:p.phase,terminal:true,observation,observationRef:observed.observationRef},automaticRedispatch:false});
  const sourceId='source-'+index,file=join(root,sourceId+'.jsonl'),counts=count(index+1),observedAt=at(p.usageSecond??p.second-0.1),external={input_tokens:counts.input,output_tokens:counts.output,total_tokens:counts.total,cached_input_tokens:0,...(missingCacheWrite?{}:{cache_write_input_tokens:0}),reasoning_output_tokens:0};
  fs.writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:'thread-'+index,cli_version:'synthetic-format',model_provider:'test'}})+'\n'+JSON.stringify({type:'event_msg',timestamp:observedAt,payload:{type:'token_count',info:{total_token_usage:external,last_token_usage:external}}})+'\n',{mode:0o600});
  const grant={schema:'runtime-codex-usage-grant/v1',id:sourceId,workspaceId:'workspace',projectId:'project',principalId:'actor',principalRevision:1,path:file,identity:inspectCodexSource(file),epoch:'one',agentRole:'main',parentThreadId:null,baseline:zero,baselineEvidence:'controlled:zero',expiresAt:new Date(Date.now()+60000).toISOString()},captured=collectCodexUsage(file,grant.identity,null),source={schema:'runtime-usage-source/v1',id:sourceId,projectId:'project',threadId:grant.identity.threadId,epoch:grant.epoch,agentRole:grant.agentRole,parentThreadId:null,baseline:zero,baselineEvidence:grant.baselineEvidence,principalId:'actor',principalRevision:1,grantDigest:digest(grant),registeredAt:at(0),revoked:false};
  const binding={schema:'runtime-usage-attribution/v1',id:'binding-'+index,sourceId,afterSequence:0,throughSequence:null,projectId:'project',targetVersion:p.version??'0.9.0',targetRef:inst.pins.targetRef,instanceId:inst.id,instancePinsDigest:inst.pinsDigest,stageId:p.stage,baseStage:p.stage,taskId:'task-'+index,attemptId:id,workType:'testing',recordedRevision:30+index},entry={binding,closure:null};
  const originalSource={sourceId,grant:{ref:join(root,sourceId+'-grant.json'),sha256:'a'.repeat(64)},observations:captured.observations,bindings:[entry],expectedDeltas:captured.observations.map(o=>({sequence:o.sequence,counts})),sourceKind:'CONTROLLED'};proof.sources.push(originalSource);captures.set(sourceId,{grant,...captured});registered.push({...source,cursor:{offset:captured.cursor.offset,latestSequence:captured.cursor.latestSequence},health:{sourceId,status:'CAUGHT_UP',code:null}});bindingRows.push(entry);
  for(const [kind,id,value]of [['usage-source',sourceId,source],['usage-attribution',binding.id,binding],...captured.observations.map(o=>['usage-observation',sourceId+'-'+o.sequence,{...o,schema:'runtime-usage-observation/v1',sourceId,epoch:'one',recordedRevision:50+index}])]){const list=objects.get(kind)??[];list.push({id,value});objects.set(kind,list);}
 }
 const store={revision:()=>500,objectsPage:(project,kind,after='')=>(objects.get(kind)??[]).filter(o=>o.id>after).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,100)},report=query=>createUsageReport(store,'project',query);
 for(const stage of proof.stages.filter(s=>s.request.instanceId==='main'&&s.observation.evidence.observation.phase==='COMPLETE')){const r=stage.request,e=stage.event,trigger={instanceId:r.instanceId,stageId:r.stageId,stageRequestId:r.id,eventRevision:e.revision,completedAt:e.at};snapshots.push({schema:'runtime-usage-snapshot/v1',id:digest(trigger),kind:r.stageId==='publication'?'publication':r.stageId==='closure'?'closure':'stage',trigger,report:report({targetVersion:'0.9.0',throughTime:e.at})});}
 const operations=[],artifacts=[],read=async(op,input)=>{operations.push(op);switch(op){
  case'runtime.events.read':return{events:input.cursor?[]:events,cursor:'end'};
  case'lifecycle.stage.request.inspect':return structuredClone(stageViews.get(input.stageRequestId));
  case'lifecycle.stage.observation.read':return structuredClone(proof.stages.find(s=>s.request.id===input.stageRequestId).observation);
  case'runtime.receipt.read':return structuredClone(receipts.get(input.requestId));
  case'lifecycle.instance.inspect':return structuredClone(instances.get(input.instanceId));
  case'usage.sources.list':return{sources:structuredClone(registered),nextAfter:null};
  case'usage.attributions.list':return{bindings:structuredClone(bindingRows),nextAfter:null};
  case'usage.report.read':return report(input);
  case'usage.snapshots.list':return{snapshots:snapshots.map(s=>({id:s.id,kind:s.kind,trigger:s.trigger,reportDigest:s.report.digest,targetVersion:s.report.targetVersion,cutoffRevision:s.report.cutoffRevision})),nextAfter:null};
  case'usage.snapshot.read':return structuredClone(snapshots.find(s=>s.id===input.id));
  case'lifecycle.publication.evidence.read':case'lifecycle.closure.evidence.read':return structuredClone(proof.stages.find(s=>s.request.id===input.stageRequestId).nativeEvidence);
  default:assert.fail('Unexpected write or unsupported read '+op);
 }};
 const run=(caseId,override={})=>collectUsageNative({caseId,selection,proof,read,collectSource:async original=>{const c=captures.get(original.sourceId);return{grant:c.grant,...collectCodexUsage(c.grant.path,c.grant.identity,null)};},artifact:(name,value)=>artifacts.push({name,value}),pause:async()=>{},...override});
 return{run,proof,selection,read,operations,snapshots,registered,bindingRows,captures,events,instances,stageViews,artifacts};
}

test('UT08/13/14/15 native collectors accept reachable original API shapes and project-version snapshots',async t=>{
 const f=await nativeUsageFixture(t);for(const id of ['UT08','UT13','UT14','UT15']){const result=await f.run(id);assert.equal(result.installedNativeReadback,true);assert.equal(result.formalCaseCredit,0);assert.equal(result.newBusinessDispatches,0);assert.deepEqual(result.sourceKinds,['CONTROLLED']);}
 assert.equal((await f.run('UT13',{selection:{...f.selection,instanceId:'active-other-instance'}})).observedSnapshots,8,'Historical completions need not be the active UT12 instance');
 assert(f.snapshots.find(s=>s.kind==='closure').report.views.instance.some(r=>r.key==='second'),'Same-version other-instance usage is included');
 assert(!f.operations.some(op=>/request$|advance|reconcile|snapshot.create|attribution.bind/.test(op)));
});

test('native completion readback preserves missing native metric subsets as unknown',async t=>{
 const f=await nativeUsageFixture(t,{missingCacheWrite:true});assert.equal((await f.run('UT15')).formalCaseCredit,0);const closure=f.snapshots.find(s=>s.kind==='closure');assert.equal(closure.report.counts.cacheWriteInput.recorded,null);assert.equal(closure.report.counts.cacheWriteInput.unknownRecords,closure.report.records);
});

test('UT15 rejects foreign work or original usage that does not follow the actual closure cutoff',async t=>{
 for(const foreignWork of [
  {requestedSecond:7,second:8.5,usageSecond:8}, // exact independent-review counterexample
  {requestedSecond:7,second:12,usageSecond:8}, // later completion cannot move original usage forward
  {requestedSecond:7,second:8.5,usageSecond:12}, // later Host counter alone cannot prove later business work
  {requestedSecond:7,second:12,usageSecond:10}, // equal to closure is not subsequent
  {requestedSecond:7,second:10,usageSecond:12}, // work at the cutoff is not subsequent
 ]){
  const f=await nativeUsageFixture(t,{foreignWork}),closure=f.snapshots.find(s=>s.kind==='closure'),before=structuredClone(closure);
  assert.equal(closure.trigger.completedAt,'2026-01-01T00:00:10.000Z');
  await assert.rejects(f.run('UT15'),/original other-version work and usage must be observed after closure/);
  assert.deepEqual(closure,before);
 }
 const same=await nativeUsageFixture(t,{foreignWork:{version:'0.9.0'}});await assert.rejects(same.run('UT15'),/separately bound other-version consumption required/);
});

test('UT15 accepts genuine later work including spanning requests, delayed Host counters and older or non-semver Targets',async t=>{
 for(const foreignWork of [
  {version:'0.10.0'},
  {version:'0.8.3',requestedSecond:7,second:12,usageSecond:11},
  {version:'maintenance-branch',requestedSecond:7,second:12,usageSecond:13},
 ]){
  const f=await nativeUsageFixture(t,{foreignWork}),closure=f.snapshots.find(s=>s.kind==='closure'),before=structuredClone(closure),result=await f.run('UT15');
  assert.equal(result.formalCaseCredit,0);assert.deepEqual(closure,before);
  const capture=f.artifacts.find(a=>a.name==='post-closure-other-version-usage').value;
  assert.equal(capture.closureCutoff,closure.trigger.completedAt);assert.equal(capture.observations.length,1);
  const row=capture.observations[0],original=f.proof.stages.find(s=>s.request.id===row.stageRequestId);assert.equal(row.targetVersion,foreignWork.version);assert.equal(row.requestedAt,original.request.requestedAt);assert.equal(row.workObservedAt,original.event.at);
  const source=f.proof.sources.find(s=>s.sourceId===row.sourceId);assert.equal(row.usageObservedAt,source.observations.find(o=>o.sequence===row.sequence).observedAt);assert(row.recordedTotal>0);assert(Date.parse(row.usageObservedAt)>Date.parse(capture.closureCutoff));assert(Date.parse(row.workObservedAt)>Date.parse(capture.closureCutoff));
  assert(!closure.report.views.instance.some(r=>r.key==='later'));
 }
});

test('native usage collectors reject missing/stale original events, receipts, scopes and source deltas',async t=>{
 const f=await nativeUsageFixture(t),original=structuredClone(f.proof);
 for(const mutate of [p=>p.stages[0].event.revision++,p=>p.stages[0].admission.principalId='other',p=>p.sources[0].expectedDeltas[0].counts.total++,p=>p.sources[0].observations[0].provenanceDigest='b'.repeat(64),p=>p.sources[0].bindings[0].binding.instanceId='other',p=>p.candidateDigest='sha256:'+'b'.repeat(64),p=>p.deadlineAt='2020-01-01T00:00:00Z',p=>p.maxRequests=2]){const p=structuredClone(original);mutate(p);await assert.rejects(f.run('UT08',{proof:p}));}
 assert.equal((await f.run('UT08')).formalCaseCredit,0);
 let clock=Date.now();const proof={...original,deadlineAt:new Date(clock+1000).toISOString()};await assert.rejects(f.run('UT08',{proof,now:()=>clock,read:async(op,input)=>{clock+=1001;return f.read(op,input);}}),/deadline exhausted/);
});

test('native completion collectors require every Base completion and publication/closure native evidence',async t=>{
 const f=await nativeUsageFixture(t);
 for(const stage of ['scope','publication','closure']){const p=structuredClone(f.proof);p.stages=p.stages.filter(s=>s.request.stageId!==stage);await assert.rejects(f.run('UT13',{proof:p}));}
 const p=structuredClone(f.proof);delete p.stages.find(s=>s.request.stageId==='publication').nativeEvidence;await assert.rejects(f.run('UT14',{proof:p}),/native publication evidence original/);
 const snapshot=f.snapshots.find(s=>s.kind==='publication'),before=structuredClone(snapshot);snapshot.report.counts.total.recorded++;await assert.rejects(f.run('UT14'));Object.assign(snapshot,before);
 const read=async(op,input)=>{const value=await f.read(op,input);if(op==='usage.snapshot.read')value.kind='on-demand';return value;};await assert.rejects(f.run('UT14',{read}));
});

test('native retry and closure collectors cannot credit absent repair, later version or post-publication work',async t=>{
 const f=await nativeUsageFixture(t),original=structuredClone(f.proof);
 // Removing the original failure/repair from proof cannot preserve the claimed
 // attribution inventory, even when an aggregate total looks unchanged.
 for(const [id,keep]of [['UT08',s=>s.observation.evidence.observation.phase!=='FAILED'],['UT08',s=>!s.request.correctionRef],['UT15',s=>s.request.instanceId!=='later']]){const p=structuredClone(original);p.stages=p.stages.filter(keep);await assert.rejects(f.run(id,{proof:p}));}
 const closure=f.snapshots.find(s=>s.kind==='closure'),publication=f.snapshots.find(s=>s.kind==='publication'),saved=structuredClone(closure);closure.report=structuredClone(publication.report);await assert.rejects(f.run('UT15'));Object.assign(closure,saved);
});

test('native usage collectors preserve original snapshots and detect new dispatch or budget changes',async t=>{
 const f=await nativeUsageFixture(t);
 await assert.rejects(f.run('UT13',{pause:async()=>{f.snapshots[0].report.records++;}}));f.snapshots[0].report.records--;
 const before=structuredClone(f.instances.get('main'));await assert.rejects(f.run('UT14',{pause:async()=>{f.instances.get('main').loopBudget.consumed++;}}),/budget/);f.instances.set('main',before);
 await assert.rejects(f.run('UT14',{pause:async()=>{f.events.push({seq:100,revision:100,type:'stage-requested',at:new Date().toISOString(),data:{}});}}),/business events/);

});
