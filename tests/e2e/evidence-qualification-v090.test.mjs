// Synthetic contract tests only. No published Harness compatibility or external
// execution acceptance is established by this injected fixture verifier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { valueDigest, byteDigest } from '../../dist/lifecycle/base.js';
import { EVIDENCE_INPUT_KINDS, evaluateRecovery } from '../../dist/lifecycle/correction-contract.js';
import { qualifyEvidence } from '../../dist/lifecycle/evidence-qualification.js';
const hash=valueDigest,copy=structuredClone,NOW=Date.parse('2026-11-09T08:00:00Z'),iso=n=>new Date(n).toISOString();
const sameScope={workspaceId:'synthetic-workspace',projectId:'synthetic-project',acceptanceScopeDigest:hash('fixed-cases')};
function fixture(candidate='B'){
 const nodes=EVIDENCE_INPUT_KINDS.map(kind=>({id:kind,kind,digest:hash(kind),dependsOn:kind==='test'?EVIDENCE_INPUT_KINDS.filter(k=>k!=='test'):kind==='source'?['source-transitive']:[]}));
 nodes.push({id:'source-transitive',kind:'source',digest:hash('transitive'),dependsOn:[]});
 const originalInputs={schema:'runtime-evidence-input-manifest/v1',candidateDigest:hash('A'),completeness:'COMPLETE',dynamicInputs:'RESOLVED',externalInputs:'RESOLVED',roots:['test'],nodes,notApplicable:[]};
 const rawReceipt='synthetic immutable execution A: PASS\n';
 const original={schema:'runtime-original-evidence-execution/v1',mode:'EXECUTED',scope:copy(sameScope),caseId:'case-one',runId:'original-A',candidateDigest:hash('A'),inputManifestDigest:hash(originalInputs),rawReceiptDigest:byteDigest(rawReceipt),outcome:'PASS',executedAt:iso(NOW-1000),expiresAt:iso(NOW+60000)};
 const currentInputs={...copy(originalInputs),candidateDigest:hash(candidate)};
 const input={schema:'runtime-evidence-qualification-input/v1',scope:copy(sameScope),caseId:'case-one',currentCandidateDigest:hash(candidate),original,originalExecutionDigest:hash(original),rawReceipt,originalInputs,currentInputs,history:[],executionRule:'OWNER_POLICY'};
 seal(input);return input;
}
function seal(input){input.original.inputManifestDigest=hash(input.originalInputs);input.originalExecutionDigest=hash(input.original);const entry={executionDigest:input.originalExecutionDigest,candidateDigest:input.original.candidateDigest,rawReceiptDigest:input.original.rawReceiptDigest,outcome:input.original.outcome,executedAt:input.original.executedAt};input.history=[entry];return input;}
function trusted(input,options={}){
 // The fixture pins original evidence separately from the request. Production
 // must resolve authentic owner records, published policy and trust, not echo.
 const expectedOriginal=hash(input.original),expectedScope=hash(input.scope),expectedRaw=byteDigest(input.rawReceipt);
 return {async verify(subject,subjectDigest,signal){
   if(options.delay)await new Promise(resolve=>setTimeout(resolve,options.delay));
   if(hash(subject.original)!==expectedOriginal||hash(subject.scope)!==expectedScope||byteDigest(subject.rawReceipt)!==expectedRaw)return null;
   if(options.onVerify)options.onVerify(subject,signal);
   return {schema:'runtime-harness-qualification-assessment/v1',owner:'harness',subjectDigest,policy:{id:'synthetic-policy',version:'fixture-1',digest:hash('policy'),publishedReceiptRef:'synthetic:published-fixture'},assessmentReceiptRef:'synthetic:assessment-fixture',trustRevision:'synthetic-trust-1',assessedAt:iso(NOW),expiresAt:iso(NOW+60000),verdict:'PASS',executionRequirement:'REUSE_PERMITTED',...options.assessment};
 }};
}
async function reason(input,expected,verifier=trusted(input)){const result=await qualifyEvidence(input,verifier,NOW);assert.equal(result.status,'EXECUTION_REQUIRED');assert.equal(result.mode,null);assert(result.reasons.includes(expected),JSON.stringify(result.reasons));return result;}

test('new qualification preserves immutable original and distinguishes actual execution from reuse',async()=>{
 for(const [candidate,mode] of [['A','EXECUTED'],['B','PASS_REUSED'],['C','PASS_REUSED']]){
  const input=fixture(candidate),before=JSON.stringify(input),result=await qualifyEvidence(input,trusted(input),NOW);
  assert.equal(result.status,'QUALIFIED');assert.equal(result.mode,mode);assert.equal(result.originalCandidateDigest,hash('A'));assert.equal(result.currentCandidateDigest,hash(candidate));assert.equal(result.originalExecutionDigest,input.originalExecutionDigest);assert.equal(result.establishesEnvironmentState,false);assert.equal(result.executionAuthorized,false);assert.equal(JSON.stringify(input),before);assert(Object.isFrozen(result));assert(Object.isFrozen(result.history));
 }
});
test('owner adapter is mandatory and user booleans cannot supply owner trust',async()=>{
 const input=fixture(),missing=await qualifyEvidence(input,undefined,NOW);assert.equal(missing.status,'EXECUTION_REQUIRED');assert(missing.reasons.includes('OWNER_POLICY_UNAVAILABLE'));
 const forged={...input,ownerVerified:true};await assert.rejects(qualifyEvidence(forged,undefined,NOW),{code:'INVALID_FIELDS'});
 await reason(input,'OWNER_POLICY_UNAVAILABLE',{verify:async()=>null});
 await reason(input,'OWNER_ASSESSMENT_UNVERIFIED',{verify:async()=>{throw Error('revoked owner trust');}});
});
test('raw tamper, relabel and qualification-label chaining cannot replace the original execution',async()=>{
 let input=fixture();input.rawReceipt+='tampered';await reason(input,'ORIGINAL_EVIDENCE_DIGEST_MISMATCH');
 input=fixture();const verifier=trusted(input);input.original.candidateDigest=hash('B');input.originalInputs.candidateDigest=hash('B');seal(input);await reason(input,'OWNER_POLICY_UNAVAILABLE',verifier);
 input=fixture();input.original.mode='PASS_REUSED';await assert.rejects(qualifyEvidence(input,trusted(input),NOW),{code:'ORIGINAL_EXECUTION_REQUIRED'});
 input=fixture();input.original.schema='runtime-evidence-qualification/v1';await assert.rejects(qualifyEvidence(input,trusted(input),NOW),{code:'ORIGINAL_EXECUTION_REQUIRED'});
});
test('direct, transitive and every declared input category change require execution',async()=>{
 for(const id of [...EVIDENCE_INPUT_KINDS,'source-transitive']){
  const input=fixture();input.currentInputs.nodes.find(n=>n.id===id).digest=hash('changed-'+id);await reason(input,'DECLARED_INPUT_CHANGED');
 }
 const reordered=fixture();reordered.currentInputs.nodes.reverse();reordered.currentInputs.nodes.forEach(n=>n.dependsOn.reverse());assert.equal((await qualifyEvidence(reordered,trusted(reordered),NOW)).status,'QUALIFIED');
});
test('incomplete closure, missing transitive edge, dynamic and external unknown fall back to full execution',async()=>{
 const changes=[i=>i.currentInputs.completeness='UNKNOWN',i=>i.currentInputs.dynamicInputs='UNKNOWN',i=>i.currentInputs.externalInputs='UNKNOWN',i=>i.currentInputs.nodes.find(n=>n.id==='source').dependsOn=[],i=>i.currentInputs.nodes=i.currentInputs.nodes.filter(n=>n.id!=='source-transitive'),i=>{i.currentInputs.nodes=i.currentInputs.nodes.filter(n=>n.kind!=='toolchain');i.currentInputs.nodes.find(n=>n.id==='test').dependsOn=i.currentInputs.nodes.find(n=>n.id==='test').dependsOn.filter(id=>id!=='toolchain');}];
 for(const change of changes){const input=fixture();change(input);assert.equal((await reason(input,'INPUT_CLOSURE_UNKNOWN')).fallback,'FULL');}
});
test('every non-PASS result and expired original requires real execution',async()=>{
 for(const outcome of ['FAIL','NOT_RUN','CANCELLED','UNKNOWN','SKIPPED']){const input=fixture();input.original.outcome=outcome;seal(input);await reason(input,'ORIGINAL_EXECUTION_NOT_PASS');}
 const expired=fixture();expired.original.expiresAt=iso(NOW-1);seal(expired);await reason(expired,'ORIGINAL_EVIDENCE_EXPIRED');
});
test('mandatory final checks cannot be reused even with a passing owner assessment',async()=>{
 const input=fixture();input.executionRule='MUST_EXECUTE';await reason(input,'FINAL_MUST_EXECUTE');
 input.executionRule='OWNER_POLICY';await reason(input,'OWNER_MUST_EXECUTE',trusted(input,{assessment:{executionRequirement:'MUST_EXECUTE'}}));
 const current=fixture('A');current.executionRule='MUST_EXECUTE';assert.equal((await qualifyEvidence(current,trusted(current,{assessment:{executionRequirement:'MUST_EXECUTE'}}),NOW)).mode,'EXECUTED');
});
test('scope, owner subject, current trust and owner assessment validity remain required',async()=>{
 const wrongScope=fixture();wrongScope.scope.projectId='other';await reason(wrongScope,'ORIGINAL_EVIDENCE_SCOPE_MISMATCH');
 for(const assessment of [{owner:'runtime'},{subjectDigest:hash('other-subject')},{expiresAt:iso(NOW-1)},{verdict:'PASS_REUSED'},{executionRequirement:'TRUST_ME'},{policy:{id:'p',version:'1',digest:hash('other-policy'),publishedReceiptRef:'synthetic:p'}}]){const input=fixture();await reason(input,'OWNER_ASSESSMENT_UNVERIFIED',trusted(input,{assessment}));}
 const input=fixture();await reason(input,'OWNER_ASSESSMENT_NOT_PASS',trusted(input,{assessment:{verdict:'FAIL'}}));
});
test('FAIL-PASS and PASS-FAIL history stays visible and cannot be hidden by reuse',async()=>{
 for(const at of [NOW-2000,NOW-500]){
  const input=fixture(),failure={executionDigest:hash('failure-'+at),candidateDigest:hash('A'),rawReceiptDigest:hash('failure-receipt'),outcome:'FAIL',executedAt:iso(at)};
  input.history.push(failure);input.history.sort((a,b)=>Date.parse(a.executedAt)-Date.parse(b.executedAt));const result=await reason(input,'FAILURE_HISTORY_REQUIRES_EXECUTION');assert.equal(result.hasFailureHistory,true);assert.deepEqual(result.history,input.history);
 }
 const current=fixture('A');current.history.unshift({executionDigest:hash('prior-failure'),candidateDigest:hash('A'),rawReceiptDigest:hash('failed'),outcome:'FAIL',executedAt:iso(NOW-2000)});const result=await qualifyEvidence(current,trusted(current),NOW);assert.equal(result.status,'QUALIFIED');assert.equal(result.hasFailureHistory,true);assert.equal(result.history.length,2);
 current.history.push({executionDigest:hash('later-failure'),candidateDigest:hash('A'),rawReceiptDigest:hash('failed-later'),outcome:'FAIL',executedAt:iso(NOW-500)});await reason(current,'CURRENT_EXECUTION_SUPERSEDED');
});
test('raw and policy TTL expiring during async verification fail closed',async()=>{
 let input=fixture();input.original.expiresAt=iso(NOW+10);seal(input);const result=await qualifyEvidence(input,trusted(input,{delay:35}),NOW);assert.equal(result.status,'EXECUTION_REQUIRED');assert(result.reasons.includes('ORIGINAL_EVIDENCE_EXPIRED'));
 input=fixture();await reason(input,'OWNER_ASSESSMENT_UNVERIFIED',trusted(input,{delay:35,assessment:{expiresAt:iso(NOW+10)}}));
});
test('cancelled owner verification never emits a qualified result',async()=>{
 const input=fixture(),controller=new AbortController();const pending=qualifyEvidence(input,trusted(input,{delay:30}),NOW,controller.signal);controller.abort();assert.equal((await pending).status,'EXECUTION_REQUIRED');
 const controller2=new AbortController();const result=await qualifyEvidence(input,trusted(input,{onVerify:()=>controller2.abort()}),NOW,controller2.signal);assert.equal(result.status,'EXECUTION_REQUIRED');
});
test('unknown qualification/input/history enums and schemas reject instead of normalizing',async()=>{
 for(const change of [i=>i.schema='runtime-evidence-qualification-input/v99',i=>i.currentInputs.schema='unknown',i=>i.currentInputs.dynamicInputs='ASSUMED',i=>i.original.outcome='PASSED',i=>i.history[0].outcome='PASS_REUSED']){const input=fixture();change(input);await assert.rejects(qualifyEvidence(input,trusted(input),NOW));}
});

function recovery(){
 const root={schema:'runtime-recovery-root/v1',workspaceId:'workspace',projectId:'project',lineageId:'original-owner-lineage',originalRequestId:'request-one',originalRequestDigest:hash('request-one'),authorityDigest:hash('original-authority'),initialInputDigest:hash('initial-input'),startedAt:iso(NOW-1000),deadlineAt:iso(NOW+60000),maxAttempts:4};
 return{schema:'runtime-recovery-facts/v1',root,rootDigest:hash(root),attempts:[{requestId:'request-one',inputDigest:root.initialInputDigest,requestedAt:root.startedAt}],rounds:[],current:{requestId:'request-one',phase:'FAILED',failureClass:'TRANSIENT',authorityDigest:root.authorityDigest},proposedInputDigest:root.initialInputDigest};
}
test('recovery only returns advisory eligibility and unknown always observes original',()=>{
 const facts=recovery();let result=evaluateRecovery(facts,'RETRY',NOW);assert.equal(result.disposition,'ELIGIBLE');assert.equal(result.executionAuthorized,false);
 facts.current.phase='UNKNOWN';for(const action of ['RETRY','CONTINUE_ORIGINAL','OBSERVE_ORIGINAL']){result=evaluateRecovery(facts,action,NOW);assert.equal(result.disposition,'OBSERVE_ONLY');assert.equal(result.originalRequestId,'request-one');assert(result.reasons.includes('RECONCILE_ORIGINAL_REQUEST'));}
});
test('deterministic unchanged input and two no-progress repairs deny another attempt',()=>{
 const facts=recovery();facts.current.failureClass='DETERMINISTIC';assert(evaluateRecovery(facts,'RETRY',NOW).reasons.includes('UNCHANGED_DETERMINISTIC_FAILURE'));
 facts.proposedInputDigest=hash('verified-repair');assert.equal(evaluateRecovery(facts,'RETRY',NOW).disposition,'ELIGIBLE');
 facts.rounds=[{beforeFactsDigest:hash('failure'),afterFactsDigest:hash('failure')},{beforeFactsDigest:hash('same-failure'),afterFactsDigest:hash('same-failure')}];assert(evaluateRecovery(facts,'RETRY',NOW).reasons.includes('TWO_NO_PROGRESS_ROUNDS'));
});
test('cumulative attempts, policy bounds, expiry and original authority remain binding',()=>{
 const facts=recovery();facts.root.maxAttempts=2;facts.rootDigest=hash(facts.root);facts.attempts.push({requestId:'request-two',inputDigest:hash('repaired'),requestedAt:iso(NOW-500)});facts.current.requestId='request-two';assert(evaluateRecovery(facts,'RETRY',NOW).reasons.includes('CUMULATIVE_ATTEMPTS_EXHAUSTED'));
 const expired=evaluateRecovery(facts,'RETRY',NOW+60001);assert.equal(expired.disposition,'OBSERVE_ONLY');assert(expired.reasons.includes('ORIGINAL_DEADLINE_EXHAUSTED'));
 const changed=recovery();changed.current.authorityDigest=hash('replacement-authority');assert(evaluateRecovery(changed,'RETRY',NOW).reasons.includes('ORIGINAL_AUTHORITY_CHANGED'));
 const legacy=recovery();legacy.root.maxRepairRounds=1;legacy.rootDigest=hash(legacy.root);assert.throws(()=>evaluateRecovery(legacy,'RETRY',NOW),{code:'INVALID_FIELDS'});
});
test('retained recovery root cannot be relabeled or replaced with a new request in supplied history',()=>{
 const facts=recovery();facts.root.deadlineAt=iso(NOW+120000);assert.throws(()=>evaluateRecovery(facts,'RETRY',NOW),{code:'INVALID_RECOVERY_ROOT'});
 const lost=recovery();lost.attempts[0].requestId='new-request';lost.current.requestId='new-request';assert.throws(()=>evaluateRecovery(lost,'RETRY',NOW),{code:'INVALID_RECOVERY_HISTORY'});
 const unknown=recovery();unknown.current.phase='PASS_REUSED';assert.throws(()=>evaluateRecovery(unknown,'RETRY',NOW),{code:'INVALID_CORRECTION_ENUM'});
 const host=recovery();host.hostId='different-host';assert.throws(()=>evaluateRecovery(host,'RETRY',NOW),{code:'INVALID_FIELDS'});
});
test('continuation must preserve original input and cannot waive exhausted history',()=>{
 const facts=recovery();facts.current.phase='RUNNING';assert.equal(evaluateRecovery(facts,'CONTINUE_ORIGINAL',NOW).disposition,'ELIGIBLE');facts.proposedInputDigest=hash('different');assert(evaluateRecovery(facts,'CONTINUE_ORIGINAL',NOW).reasons.includes('ORIGINAL_INPUT_CHANGED'));
 facts.proposedInputDigest=facts.root.initialInputDigest;facts.root.maxAttempts=1;facts.rootDigest=hash(facts.root);facts.attempts.push({requestId:'second',inputDigest:facts.proposedInputDigest,requestedAt:iso(NOW-500)});facts.current.requestId='second';assert(evaluateRecovery(facts,'CONTINUE_ORIGINAL',NOW).reasons.includes('CUMULATIVE_ATTEMPTS_EXHAUSTED'));
});

import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RuntimeStore} from '../../dist/server/store.js';
import {createClosedFixtureQualificationProducer,createNativeQualificationService,assertNativeQualificationService} from '../../dist/lifecycle/evidence-qualification.js';
import {nativeSha256} from '../../vendor/compatibility/v1/native.mjs';
function closedFixture(t){
 const root=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'runtime-closed-qualification-')),fixtureRoot=join(root,'fixture');fs.mkdirSync(fixtureRoot,{mode:0o700});
 const put=(name,value)=>fs.writeFileSync(join(fixtureRoot,name),JSON.stringify(value),{mode:0o600});put('input.json',{z:2,a:1});put('expected.json',{canonicalDigest:hash({z:2,a:1})});
 const scope={workspaceId:'synthetic',projectId:'alpha',acceptanceScopeDigest:hash('catalog')},actor={id:'synthetic-operator',projects:['alpha'],permissions:['read','execution.request'],revision:1,expiresAt:'2030-01-01T00:00:00Z'},expiresAt=iso(Date.now()+600000),store=new RuntimeStore(join(root,'state'),'synthetic');
 t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
 const pairs=[{criterionId:'HQA01',variantId:'actual-observation'},{criterionId:'HQA01',variantId:'fixture'}],reference={product:'harness',id:'synthetic-policy',version:'1.0.0',digest:hash('policy'),specVersion:'v1',visibility:'private',producer:{name:'synthetic',version:'1'},contractDigest:hash('contract'),standardDigest:hash('standard'),standardLockDigest:hash('standard-lock')};
 const policy={owner:{ref:'harness',registrationDigest:hash('registration'),scope:{visibility:'private',projectId:'alpha'},reference,criteria:pairs},publishedReceiptRef:'synthetic:published-policy',effectiveConfigDigest:hash('config'),toolchainLockDigest:hash('toolchain'),profileDigest:hash('profile'),catalogScopeDigest:scope.acceptanceScopeDigest,caseInventoryDigest:hash('inventory'),validityContractDigest:hash('ttl'),trust:{revision:'one',protectedRecordRef:'synthetic:trust',recordDigest:hash('trust'),expiresAt},requirement:{phase:'PRE_RELEASE',executionRequirement:'AFFECTED_OR_UNKNOWN_MUST_EXECUTE',impact:'UNCHANGED',serialGroupStatus:'PROTECTED_COMPLETE_UNCHANGED_GROUP',inventoryRef:'synthetic:inventory',inventoryRevision:'one'}};
 const producer=createClosedFixtureQualificationProducer(store,{scope,caseId:'LC03',fixtureRoot,policy:async()=>copy(policy),authority:async(_actor,s)=>({requestId:'assessment-'+hash(s).slice(7,55),authorityRef:'synthetic:authority',authorityDigest:hash('authority'),deadlineAt:expiresAt})});
 const receipts=new Map(),calls=[];let published=true,editReceipt=r=>r;
 const owner={owner:'harness',workspaceId:'synthetic',capabilities:()=>({registrationDigest:hash('registration')}),async readPackage(){calls.push('package');if(!published)throw Error('policy unpublished');return{package:{manifest:{entrypoints:{coverage:'coverage.json'}},files:{'coverage.json':JSON.stringify({requirements:[{id:'HQA01',caseIds:['fixture']}]})}}};},async read(_actor,_project,request){calls.push(request.operation);if(request.operation==='workspace.inspect')return{revision:0};return copy(editReceipt(receipts.get(request.input.requestId)));},async mutate(_actor,_project,request){calls.push(request.operation);const body={reference,context:request.input.context,toolchainLockDigest:policy.toolchainLockDigest,effectiveConfigDigest:policy.effectiveConfigDigest,observationDigest:nativeSha256(request.input.observation),executionStatus:'SUCCEEDED',qualityStatus:'PASS',criteria:pairs.map(p=>({...p,status:'PASS',evidenceDigest:hash(p)}))},receipt={requestId:request.requestId,operation:request.operation,scope:request.scope,requestDigest:nativeSha256({operation:request.operation,scope:request.scope,input:request.input}),status:'SUCCEEDED',result:{...body,reportDigest:nativeSha256(body)}};receipts.set(request.requestId,receipt);}};
 const readPrincipals=new Map([[actor.id,copy(actor)]]);
 const bindings={read:producer.read,owner:()=>owner,authorizeInspect:(_subject,observer)=>copy(readPrincipals.get(observer.id)),authorizeDispatch:s=>({actor,permit:{owner:'harness',projectId:'alpha',requestDigest:s.requestDigest,authorityRef:s.authorityRef,expiresAt:s.expiresAt}})},service=createNativeQualificationService(store,bindings),signal=new AbortController().signal;
 const selection=(original,candidate='B')=>({schema:'runtime-evidence-qualification-selection/v2',scope,caseId:'LC03',currentCandidateDigest:hash(candidate),originalExecutionDigest:original.originalExecutionDigest,phase:'PRE_RELEASE'});
 async function assess(s){const a=await service.prepare(s,actor,signal);await service.dispatch('alpha',a.actionRef,actor,signal);return a;}
 return{store,root,put,policy,producer,service,bindings,owner,readPrincipals,actor,signal,expiresAt,selection,assess,calls,receipts,setPublished:v=>published=v,editReceipt:f=>editReceipt=f};
}
test('closed producer actually executes immutable fixtures and native v2 qualifies A to B to C without rewriting A',async t=>{
 const f=closedFixture(t),original=await f.producer.execute(hash('A'),'execution-a',f.expiresAt,f.actor,f.signal);assert.equal(original.original.outcome,'PASS');
 for(const candidate of ['B','C']){const s=f.selection(original,candidate),a=await f.assess(s),before=f.store.revision('alpha'),q=await f.service.inspect('alpha',a.actionRef,f.actor,f.signal);assert.equal(q.schema,'runtime-evidence-qualification/v2');assert.equal(q.status,'QUALIFIED');assert.equal(q.mode,'PASS_REUSED');assert.equal(q.originalExecutionDigest,original.originalExecutionDigest);assert.equal(q.originalCandidateDigest,hash('A'));assert.equal(q.history.length,1);assert.equal(q.formalAcceptanceEligible,false);assert.equal(q.releaseAuthorized,false);assert.equal(f.store.revision('alpha'),before,'Readonly inspection must not write state');assert.equal(f.calls.filter(x=>x==='native.package.validate').length,candidate==='B'?1:2);}
 assert.throws(()=>assertNativeQualificationService({inspect:async()=>({status:'QUALIFIED'})}),{code:'TRUSTED_QUALIFICATION_SERVICE_REQUIRED'});
});
test('native v2 never dispatches twice, preserves request after restart and rechecks current publication',async t=>{
 const f=closedFixture(t),original=await f.producer.execute(hash('A'),'execution-a',f.expiresAt,f.actor,f.signal),s=f.selection(original),a=await f.assess(s);
 const restarted=createNativeQualificationService(f.store,f.bindings);assert.equal((await restarted.inspect('alpha',a.actionRef,f.actor,f.signal)).status,'QUALIFIED');
 await assert.rejects(restarted.dispatch('alpha',a.actionRef,f.actor,f.signal),{code:'QUALIFICATION_OBSERVE_ORIGINAL'});
 f.setPublished(false);await assert.rejects(restarted.inspect('alpha',a.actionRef,f.actor,f.signal),/unpublished/);assert.equal(f.calls.filter(x=>x==='native.package.validate').length,1);
});
test('closed producer retains all failures and refuses fixture, policy, trust or history changes',async t=>{
 const f=closedFixture(t);f.put('expected.json',{canonicalDigest:hash('wrong')});const failed=await f.producer.execute(hash('A'),'failed',f.expiresAt,f.actor,f.signal);assert.equal(failed.original.outcome,'FAIL');f.put('expected.json',{canonicalDigest:hash({z:2,a:1})});const passed=await f.producer.execute(hash('A'),'passed',f.expiresAt,f.actor,f.signal);
 const facts=await f.producer.read(f.selection(passed),f.actor,f.signal);assert.deepEqual(facts.input.history.map(x=>x.outcome),['FAIL','PASS']);await assert.rejects(f.service.prepare(f.selection(passed),f.actor,f.signal),{code:'QUALIFICATION_EXECUTION_REQUIRED'});
 const current=f.selection(passed,'A'),a=await f.assess(current);assert.equal((await f.service.inspect('alpha',a.actionRef,f.actor,f.signal)).hasFailureHistory,true);
 f.policy.trust.revision='revoked-revision';await assert.rejects(f.service.inspect('alpha',a.actionRef,f.actor,f.signal),{code:'QUALIFICATION_FACTS_CHANGED'});
});
test('interrupted closed attempts cannot be erased or upgraded into a complete PASS history',async t=>{
 const f=closedFixture(t);f.put('expected.json',{invalid:true});await assert.rejects(f.producer.execute(hash('A'),'malformed',f.expiresAt,f.actor,f.signal));f.put('expected.json',{canonicalDigest:hash({z:2,a:1})});const passed=await f.producer.execute(hash('A'),'later',f.expiresAt,f.actor,f.signal),facts=await f.producer.read(f.selection(passed),f.actor,f.signal);assert.deepEqual(facts.input.history.map(x=>x.outcome),['UNKNOWN','PASS']);await assert.rejects(f.service.prepare(f.selection(passed),f.actor,f.signal),{code:'QUALIFICATION_EXECUTION_REQUIRED'});await assert.rejects(f.producer.execute(hash('A'),'malformed',f.expiresAt,f.actor,f.signal),{code:'QUALIFICATION_OBSERVE_ORIGINAL'});
});
test('native report tamper, missing actual criterion and changed fixture do not qualify',async t=>{
 const f=closedFixture(t),original=await f.producer.execute(hash('A'),'execution-a',f.expiresAt,f.actor,f.signal),a=await f.assess(f.selection(original));
 f.editReceipt(r=>({...r,requestDigest:hash('other')}));await assert.rejects(f.service.inspect('alpha',a.actionRef,f.actor,f.signal),{code:'OWNER_RECEIPT_MISMATCH'});
 f.editReceipt(r=>{const v=copy(r);v.result.criteria.pop();const{reportDigest,...body}=v.result;v.result.reportDigest=nativeSha256(body);return v;});await assert.rejects(f.service.inspect('alpha',a.actionRef,f.actor,f.signal),{code:'OWNER_REPORT_INCOMPLETE'});
 f.editReceipt(r=>r);f.put('input.json',{z:3,a:1});await assert.rejects(f.service.inspect('alpha',a.actionRef,f.actor,f.signal),{code:'QUALIFICATION_EXECUTION_REQUIRED'});
});

test('native qualification pins the actual owner registration even when workspace identity is unchanged',async t=>{
 const f=closedFixture(t),original=await f.producer.execute(hash('A'),'binding-origin',f.expiresAt,f.actor,f.signal),selection=f.selection(original);
 f.owner.capabilities=()=>({registrationDigest:hash('other-owner-root')});
 await assert.rejects(f.service.prepare(selection,f.actor,f.signal),{code:'QUALIFICATION_OWNER_CHANGED'});
 assert.equal(f.calls.filter(x=>x==='native.package.validate').length,0);assert.equal(f.calls.filter(x=>x==='package').length,0);
});
test('qualification dispatch rechecks protected authority after awaited owner read and before the marker',async t=>{
 const f=closedFixture(t),original=await f.producer.execute(hash('A'),'authority-origin',f.expiresAt,f.actor,f.signal),a=await f.service.prepare(f.selection(original),f.actor,f.signal),read=f.owner.readPackage;
 f.owner.readPackage=async(...args)=>{const pkg=await read(...args);f.policy.trust.revision='revoked-during-owner-read';return pkg;};
 await assert.rejects(f.service.dispatch('alpha',a.actionRef,f.actor,f.signal),{code:'QUALIFICATION_AUTHORITY_CHANGED'});
 assert.equal(f.store.object('alpha','lifecycle-evidence-qualification','dispatch:'+a.actionRef),null);assert.equal(f.calls.filter(x=>x==='native.package.validate').length,0);
});
test('current principal and exact permit are required after every async dispatch prerequisite',async t=>{
 for(const change of [r=>r.actor.permissions=['execution.request'],r=>r.actor.permissions=['read'],r=>r.actor.id='other',r=>r.actor.revision++,r=>r.permit.projectId='other',r=>r.permit.owner='ontology',r=>r.permit.requestDigest=hash('wrong'),r=>r.permit.authorityRef='wrong',r=>r.permit.expiresAt=iso(Date.now()-1)]){
  const f=closedFixture(t),original=await f.producer.execute(hash('A'),'principal-origin',f.expiresAt,f.actor,f.signal),a=await f.service.prepare(f.selection(original),f.actor,f.signal),authorize=f.bindings.authorizeDispatch,read=f.owner.readPackage;let revoked=false;
  f.owner.readPackage=async(...args)=>{const pkg=await read(...args);revoked=true;return pkg;};
  f.bindings.authorizeDispatch=(...args)=>{const result=copy(authorize(...args));if(revoked)change(result);return result;};
  await assert.rejects(f.service.dispatch('alpha',a.actionRef,f.actor,f.signal));assert.equal(f.calls.filter(x=>x==='native.package.validate').length,0);assert.equal(f.store.object('alpha','lifecycle-evidence-qualification','dispatch:'+a.actionRef),null);
 }
});
test('revocation after dispatch marker prevents native effect and keeps original-only recovery',async t=>{
 const f=closedFixture(t),original=await f.producer.execute(hash('A'),'marker-origin',f.expiresAt,f.actor,f.signal),a=await f.service.prepare(f.selection(original),f.actor,f.signal),read=f.bindings.read,authorize=f.bindings.authorizeDispatch;let revoked=false,checks=0;
 f.bindings.read=async(...args)=>{const value=await read(...args);if(f.store.object('alpha','lifecycle-evidence-qualification','dispatch:'+a.actionRef))revoked=true;return value;};
 f.bindings.authorizeDispatch=(...args)=>{checks++;if(revoked)throw Error('Synthetic original authority revoked');return authorize(...args);};
 await assert.rejects(f.service.dispatch('alpha',a.actionRef,f.actor,f.signal),/original authority revoked/);assert.equal(checks,2);assert(f.store.object('alpha','lifecycle-evidence-qualification','dispatch:'+a.actionRef));assert.equal(f.calls.filter(x=>x==='native.package.validate').length,0);
 await assert.rejects(f.service.dispatch('alpha',a.actionRef,f.actor,f.signal),{code:'QUALIFICATION_OBSERVE_ORIGINAL'});
 const revision=f.store.revision('alpha');await assert.rejects(f.service.inspect('alpha',a.actionRef,f.actor,f.signal));assert.equal(f.store.revision('alpha'),revision);assert.equal(f.calls.filter(x=>x==='native.package.validate').length,0);
});
test('binding replacement or interruption after marker leaves no native effect',async t=>{
 for(const fault of ['owner','abort']){
  const f=closedFixture(t),controller=new AbortController(),original=await f.producer.execute(hash('A'),'final-boundary-origin',f.expiresAt,f.actor,f.signal),a=await f.service.prepare(f.selection(original),f.actor,f.signal),read=f.bindings.read;
  f.bindings.read=async(...args)=>{const facts=await read(...args);if(f.store.object('alpha','lifecycle-evidence-qualification','dispatch:'+a.actionRef)){if(fault==='owner')f.owner.capabilities=()=>({registrationDigest:hash('replacement')});else controller.abort();}return facts;};
  await assert.rejects(f.service.dispatch('alpha',a.actionRef,f.actor,controller.signal));assert(f.store.object('alpha','lifecycle-evidence-qualification','dispatch:'+a.actionRef));assert.equal(f.calls.filter(x=>x==='native.package.validate').length,0);
 }
});

test('final owner package await cannot hide trust or assessment authority revocation',async t=>{
 for(const fault of ['trust','authority']){
  const f=closedFixture(t),original=await f.producer.execute(hash('A'),'inspect-final-origin',f.expiresAt,f.actor,f.signal),a=await f.assess(f.selection(original)),readPackage=f.owner.readPackage,readFacts=f.bindings.read;let packages=0,revoked=false;
  f.owner.readPackage=async(...args)=>{const pkg=await readPackage(...args);if(++packages===2){revoked=true;if(fault==='trust')f.policy.trust.revision='revoked-in-final-package-read';}return pkg;};
  f.bindings.read=async(...args)=>{const facts=await readFacts(...args);if(revoked&&fault==='authority')facts.assessmentAuthority.authorityDigest=hash('revoked-assessment-grant');return facts;};
  const revision=f.store.revision('alpha'),mutations=f.calls.filter(x=>x==='native.package.validate').length;
  await assert.rejects(f.service.inspect('alpha',a.actionRef,f.actor,f.signal),{code:'QUALIFICATION_FACTS_CHANGED'});assert.equal(packages,2,'Fault must occur only in the final owner package read');assert.equal(f.store.revision('alpha'),revision);assert.equal(f.calls.filter(x=>x==='native.package.validate').length,mutations);
 }
});
test('final owner package await cannot swap the registered owner unnoticed',async t=>{
 const f=closedFixture(t),original=await f.producer.execute(hash('A'),'inspect-owner-origin',f.expiresAt,f.actor,f.signal),a=await f.assess(f.selection(original)),readPackage=f.owner.readPackage;let packages=0;
 f.owner.readPackage=async(...args)=>{const pkg=await readPackage(...args);if(++packages===2)f.owner.capabilities=()=>({registrationDigest:hash('replaced-after-final-read')});return pkg;};
 const revision=f.store.revision('alpha'),mutations=f.calls.filter(x=>x==='native.package.validate').length;
 await assert.rejects(f.service.inspect('alpha',a.actionRef,f.actor,f.signal),{code:'QUALIFICATION_OWNER_CHANGED'});assert.equal(packages,2);assert.equal(f.store.revision('alpha'),revision);assert.equal(f.calls.filter(x=>x==='native.package.validate').length,mutations);
});
test('final synchronous read boundary rejects revoked credentials or grant without demanding execution permission',async t=>{
 const f=closedFixture(t),original=await f.producer.execute(hash('A'),'readonly-observer-origin',f.expiresAt,f.actor,f.signal),a=await f.assess(f.selection(original)),observer={...copy(f.actor),id:'readonly-observer',permissions:['read']};f.readPrincipals.set(observer.id,copy(observer));
 const revision=f.store.revision('alpha'),mutations=f.calls.filter(x=>x==='native.package.validate').length;
 assert.equal((await f.service.inspect('alpha',a.actionRef,observer,f.signal)).status,'QUALIFIED');assert.deepEqual(observer.permissions,['read']);
 const readFacts=f.bindings.read;let reads=0;f.bindings.read=async(...args)=>{const facts=await readFacts(...args);if(++reads===3)f.readPrincipals.set(observer.id,{...observer,permissions:[]});return facts;};
 await assert.rejects(f.service.inspect('alpha',a.actionRef,observer,f.signal));assert.equal(reads,3,'Revoke only after the last protected facts snapshot');
 f.bindings.read=readFacts;f.readPrincipals.set(observer.id,{...observer,revision:observer.revision+1});await assert.rejects(f.service.inspect('alpha',a.actionRef,observer,f.signal),{code:'QUALIFICATION_READ_AUTHORITY_CHANGED'});
 f.readPrincipals.set(observer.id,copy(observer));f.bindings.authorizeInspect=()=>{throw Error('Synthetic existing assessment grant revoked at final boundary');};await assert.rejects(f.service.inspect('alpha',a.actionRef,observer,f.signal),/grant revoked/);
 assert.equal(f.store.revision('alpha'),revision);assert.equal(f.calls.filter(x=>x==='native.package.validate').length,mutations);
});

import {assertQualifiedAcceptanceCurrent} from '../../dist/release/evidence.js';
test('release batch final guard rejects earlier case revocation or history drift during a later case read',async t=>{
 for(const fault of ['trust','history','inventory']){
  const f=closedFixture(t),original=await f.producer.execute(hash('A'),'batch-first-origin',f.expiresAt,f.actor,f.signal),first=await f.assess(f.selection(original)),firstResult=await f.service.inspect('alpha',first.actionRef,f.actor,f.signal);
  const scope=original.original.scope,secondProducer=createClosedFixtureQualificationProducer(f.store,{scope,caseId:'LC04',fixtureRoot:join(f.root,'fixture'),policy:async()=>copy(f.policy),authority:async(_actor,s)=>({requestId:'assessment-'+hash(s).slice(7,55),authorityRef:'synthetic:authority',authorityDigest:hash('authority'),deadlineAt:f.expiresAt})});
  const secondOriginal=await secondProducer.execute(hash('A'),'batch-second-origin',f.expiresAt,f.actor,f.signal),secondSelection={...f.selection(secondOriginal),caseId:'LC04'},read=f.bindings.read;
  f.bindings.read=(s,...args)=>s.caseId==='LC04'?secondProducer.read(s,...args):read(s,...args);const second=await f.assess(secondSelection),readPackage=f.owner.readPackage,authorize=f.bindings.authorizeInspect;let firstCurrent=true;
  // This fixture models the trusted synchronous reader's actual protected
  // grant/history/inventory watermark changing while a different case awaits.
  f.owner.readPackage=async(...args)=>{const pkg=await readPackage(...args);firstCurrent=false;return pkg;};
  f.bindings.authorizeInspect=(subject,observer)=>{if(subject.actionRef===first.actionRef&&!firstCurrent)throw Error('Protected first-case '+fault+' changed');return authorize(subject,observer);};
  const secondResult=await f.service.inspect('alpha',second.actionRef,f.actor,f.signal),revision=f.store.revision('alpha'),mutations=f.calls.filter(x=>x==='native.package.validate').length;
  assert.equal(secondResult.status,'QUALIFIED');assert.equal(firstResult.expiresAt>iso(Date.now()),true,'TTL is unchanged and still valid');
  assert.throws(()=>assertQualifiedAcceptanceCurrent(f.service,'alpha',[firstResult,secondResult],f.actor,f.signal),new RegExp('first-case '+fault+' changed'));
  assert.equal(f.store.revision('alpha'),revision);assert.equal(f.calls.filter(x=>x==='native.package.validate').length,mutations);
 }
});
test('synchronous qualification consumption requires original in-memory service inspection, never copied JSON',async t=>{
 const f=closedFixture(t),original=await f.producer.execute(hash('A'),'batch-authentic-origin',f.expiresAt,f.actor,f.signal),a=await f.assess(f.selection(original)),q=await f.service.inspect('alpha',a.actionRef,f.actor,f.signal),revision=f.store.revision('alpha'),mutations=f.calls.filter(x=>x==='native.package.validate').length;
 assertQualifiedAcceptanceCurrent(f.service,'alpha',[q],f.actor,f.signal);
 assert.throws(()=>assertQualifiedAcceptanceCurrent(f.service,'alpha',[copy(q)],f.actor,f.signal),{code:'QUALIFICATION_INSPECTION_REQUIRED'});
 const other=createNativeQualificationService(f.store,f.bindings);assert.throws(()=>assertQualifiedAcceptanceCurrent(other,'alpha',[q],f.actor,f.signal),{code:'QUALIFICATION_INSPECTION_REQUIRED'});
 assert.equal(f.store.revision('alpha'),revision);assert.equal(f.calls.filter(x=>x==='native.package.validate').length,mutations);
});
