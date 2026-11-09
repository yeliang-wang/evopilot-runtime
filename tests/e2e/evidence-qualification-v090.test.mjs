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

import {createRegisteredQualificationService} from '../../dist/adapters/bindings.js';
import {readIntegrationConfiguration} from '../../dist/adapters/config.js';
import {NATIVE_CONTRACT_DIGEST} from '../../vendor/compatibility/v1/native.mjs';
import {pathToFileURL} from 'node:url';
import {startRuntimeServer} from '../../dist/server/http.js';
import {initializeCredentials,tokenDigest} from '../../dist/server/security.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Complete registered-composition protocol fixture. Owner outcomes are explicit
// synthetic native protocol fixtures; this is not actual owner publication proof.
async function registeredQualification(t){
 const root=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'runtime-registered-qualification-')),fixtureRoot=join(root,'probe'),stateRoot=join(root,'state');fs.chmodSync(root,0o700);fs.mkdirSync(fixtureRoot,{mode:0o700});
 const put=(path,value)=>fs.writeFileSync(path,JSON.stringify(value),{mode:0o600});put(join(fixtureRoot,'input.json'),{a:1});put(join(fixtureRoot,'expected.json'),{canonicalDigest:hash({a:1})});
 const expiresAt=iso(Date.now()+600000),actor={id:'operator',projects:['alpha'],permissions:['read','execution.request','decision.record'],revision:1,expiresAt},reader={id:'observer',projects:['alpha'],permissions:['read'],revision:1,expiresAt},token='q'.repeat(43),readerToken='r'.repeat(43);fs.mkdirSync(stateRoot,{mode:0o700});initializeCredentials(stateRoot,'synthetic',[{...actor,tokenDigest:tokenDigest(token)},{...reader,tokenDigest:tokenDigest(readerToken)}]);
 const ref='binding:qualification',ownerRef='binding:harness',ownerConfig={owner:'harness',packageRoot:root,workspaceRoot:root,workspaceId:'synthetic',projects:['alpha']},reference={product:'harness',id:'synthetic-policy',version:'1.0.0',digest:hash('synthetic-policy'),specVersion:'v1',visibility:'private',producer:{product:'harness',version:'0.3.0'},contractDigest:NATIVE_CONTRACT_DIGEST,standardDigest:hash('standard'),standardLockDigest:hash('standard-lock')},scope={visibility:'private',projectId:'alpha'};
 const catalogBindings=[{path:'governance/synthetic.json',sha256:hash('synthetic-catalog'),bytes:10}],catalogScope={product:'runtime',targetId:'runtime-v090-independent-lifecycle',targetVersion:'0.9.0',catalogBindings},catalogScopeDigest=hash(catalogScope),cases=Array.from({length:709},(_,i)=>({caseId:i===0?'LC03':'synthetic-case-'+i,phase:i<698?'PRE_RELEASE':'POST_RELEASE',executionRequirement:i>=1&&i<=681?'ALWAYS_MUST_EXECUTE':'AFFECTED_OR_UNKNOWN_MUST_EXECUTE'})),profile={scope:{...catalogScope,catalogScopeDigest},cases},profileText=JSON.stringify(profile),params={profileDigest:byteDigest(profileText),catalogScopeDigest,validityContractDigest:hash('validity'),catalogBindings:Object.fromEntries(catalogBindings.map(r=>[r.path,r.sha256])),mustExecuteCaseIds:cases.filter(c=>c.executionRequirement==='ALWAYS_MUST_EXECUTE').map(c=>c.caseId),conditionalCaseIds:cases.filter(c=>c.executionRequirement!=='ALWAYS_MUST_EXECUTE').map(c=>c.caseId)};
 const tool={executable:process.execPath,version:'synthetic',sha256:'a'.repeat(64)},toolchain={schema:'evopilot-native-toolchain/v1',platform:process.platform,arch:process.arch,lockDigest:hash('lock'),tools:{python:tool,pyshacl:tool,opa:tool,conftest:tool},dependencyLockDigest:hash('dependencies'),environmentRoot:root,dependencyFiles:[{path:process.execPath,sha256:'a'.repeat(64)}],timeoutMs:60000,maxInputBytes:1048576,maxPackageBytes:1048576},toolchainPath=join(root,'toolchain.json');put(toolchainPath,toolchain);
 const config={schema:'runtime-integrations/v1',workspaceId:'synthetic',revision:1,platforms:[],credentials:[],owners:[{ref:ownerRef,...ownerConfig}],resources:[{ref,workspaceId:'synthetic',projectId:'alpha',role:'runtime.qualification',revision:1,expiresAt,definition:{kind:'qualification',adapterRef:ownerRef,scope,reference,publicationRequestId:'original-publication',principalIds:['operator'],probes:[{caseId:'LC03',root:fixtureRoot}]}}],nativeToolchain:{path:toolchainPath,digest:byteDigest(fs.readFileSync(toolchainPath)),lockDigest:toolchain.lockDigest}},configPath=join(root,'integrations.json');const save=()=>put(configPath,config);save();
 const pkg={manifest:{entrypoints:{coverage:'coverage.json'}},files:{'coverage.json':JSON.stringify({requirements:[{id:'HQA01',caseIds:['fixture']}]}),'sources/runtime-profile.json':profileText,'data/qualification.json':JSON.stringify({params})}},pairs=[{criterionId:'HQA01',variantId:'actual-observation'},{criterionId:'HQA01',variantId:'fixture'}],effectiveConfigDigest=hash('effective'),receipts=new Map(),calls=[];let onRead=()=>{},onPackage=()=>{};
 const owner={owner:'harness',workspaceId:'synthetic',capabilities:()=>({registrationDigest:hash(ownerConfig)}),async readPackage(){await onPackage();return{package:pkg,reference,published:true,scope,validation:{reference,effectiveConfigDigest,executionStatus:'SUCCEEDED',qualityStatus:'PASS'}};},async read(_actor,_project,r){await onRead(r);if(r.operation==='workspace.inspect')return{revision:0};if(r.input.requestId==='original-publication')return{requestId:'original-publication',operation:'native.package.publish',scope,status:'SUCCEEDED',result:{reference,published:true}};return copy(receipts.get(r.input.requestId));},async mutate(_actor,_project,r){calls.push(r);const body={reference,context:r.input.context,toolchainLockDigest:toolchain.lockDigest,effectiveConfigDigest,observationDigest:nativeSha256(r.input.observation),executionStatus:'SUCCEEDED',qualityStatus:'PASS',criteria:pairs.map(p=>({...p,status:'PASS',evidenceDigest:hash(p)}))};receipts.set(r.requestId,{requestId:r.requestId,operation:r.operation,scope:r.scope,requestDigest:nativeSha256({operation:r.operation,scope:r.scope,input:r.input}),status:'SUCCEEDED',result:{...body,reportDigest:nativeSha256(body)}});}};
 let store,registered;const factory=(s,principals)=>{store=s;registered=createRegisteredQualificationService(s,configPath,{owner:()=>owner},async()=>readIntegrationConfiguration(configPath,'synthetic'),principals);return registered;};
 const server=await startRuntimeServer({stateRoot,workspaceId:'synthetic'},undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,factory);let serial=0;
 t.after(async()=>{await server.close();fs.rmSync(root,{recursive:true,force:true});});
 const call=async(operation,input,options={})=>{const write=options.write??false,body={operation,projectId:options.projectId??'alpha',input,...(write?{requestId:options.requestId??'client-'+(++serial),expectedRevision:options.expectedRevision??store.revision('alpha')}: {})},response=await fetch(server.url+'/api/v1/request',{method:'POST',headers:{authorization:'Bearer '+(options.reader?readerToken:token),'content-type':'application/json'},body:JSON.stringify(body)});return{status:response.status,...await response.json(),body};};
 const good=async(operation,input,options={})=>{const r=await call(operation,input,options);assert.equal(r.status,200,JSON.stringify(r));return r.result;};
 const evidence=review=>{const n=++serial,source=join(root,'synthetic-source-'+n+'.txt'),path=join(root,'decision-'+n+'.json');fs.writeFileSync(source,'Synthetic regression decision; no user/domain authority.',{mode:0o600});const pin=p=>pathToFileURL(p).href+'#sha256='+byteDigest(fs.readFileSync(p)).slice(7);put(path,{schema:'evopilot-decision-evidence/v1',subject:{owner:'runtime',operation:'lifecycle.qualification.assessment',workspaceId:'synthetic',scope,reviewDigest:review.reviewDigest,decision:'APPROVE'},source:{reference:pin(source),description:'Synthetic qualification regression decision'}});return pin(path);};
 async function original(){await good('lifecycle.qualification.probe.execute',{registrationRef:ref,caseId:'LC03',candidateDigest:hash('A'),expiresAt:iso(Date.now()+300000)},{write:true});const r=await good('lifecycle.qualification.origin.inspect',{registrationRef:ref,caseId:'LC03'});return hash(r.attempts[0].original);}
 async function plan(originalDigest,candidate='B'){const r=await good('lifecycle.qualification.plan',{registrationRef:ref,caseId:'LC03',currentCandidateDigest:hash(candidate),originalExecutionDigest:originalDigest,phase:'PRE_RELEASE',deadlineAt:iso(Date.now()+120000)},{write:true});return r.result.planRef;}
 async function grant(planRef){const review=await good('lifecycle.qualification.assessment.preview',{planRef});return good('lifecycle.qualification.assessment.authorize',{planRef,reviewDigest:review.reviewDigest,evidenceRef:evidence(review)},{write:true});}
 return{root,stateRoot,server,store,registered,ref,config,save,call,good,evidence,original,plan,grant,calls,owner,pkg,actor,reader,token,readerToken,onRead:f=>onRead=f,onPackage:f=>onPackage=f};
}

test('registered HTTP qualification follows protected plan, independent grant, original CAS dispatch and readonly MCP inspect',async t=>{
 const f=await registeredQualification(t),original=await f.original();
 for(const candidate of ['B','C']){const planRef=await f.plan(original,candidate);assert.equal((await f.call('lifecycle.qualification.prepare',{planRef},{write:true})).status,403);await f.grant(planRef);const prepared=await f.good('lifecycle.qualification.prepare',{planRef},{write:true}),actionRef=prepared.result.actionRef;
 const requestId='original-dispatch-'+candidate,revision=f.store.revision('alpha'),sent=await f.good('lifecycle.qualification.dispatch',{actionRef},{write:true,requestId,expectedRevision:revision});assert.equal(sent.requestId,requestId);const count=f.calls.length;await f.good('lifecycle.qualification.dispatch',{actionRef},{write:true,requestId,expectedRevision:revision});assert.equal(f.calls.length,count);assert.equal((await f.call('lifecycle.qualification.dispatch',{actionRef},{write:true})).status,409);
 const before=f.store.revision('alpha'),result=await f.good('lifecycle.qualification.inspect',{actionRef},{reader:true});assert.equal(result.status,'QUALIFIED');assert.equal(result.mode,'PASS_REUSED');assert.equal(result.originalExecutionDigest,original);assert.equal(result.formalAcceptanceEligible,false);assert.equal(f.store.revision('alpha'),before);
 const client=new Client({name:'qualification-test',version:'1'},{capabilities:{}}),transport=new StreamableHTTPClientTransport(new URL(f.server.url+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+f.readerToken}}});try{await client.connect(transport);const tools=await client.listTools();assert(tools.tools[0].inputSchema.properties.operation.enum.includes('lifecycle.qualification.inspect'));const response=await client.callTool({name:'runtime_read',arguments:{operation:'lifecycle.qualification.inspect',projectId:'alpha',input:{actionRef}}});assert.equal(JSON.parse(response.content[0].text).result.status,'QUALIFIED');}finally{await client.close();}
 }
 assert.equal(f.calls.length,2);
});

test('registered service rejects public facts/permit, wrong scope, missing grant, stale CAS and changed protected profile',async t=>{
 const f=await registeredQualification(t),original=await f.original(),planRef=await f.plan(original);
 assert.equal((await f.call('lifecycle.qualification.prepare',{planRef,permit:{approved:true}},{write:true})).status,400);
 assert.equal((await f.call('lifecycle.qualification.origin.inspect',{registrationRef:f.ref,caseId:'LC03',facts:{complete:true}})).status,400);
 assert.equal((await f.call('lifecycle.qualification.origin.inspect',{registrationRef:f.ref,caseId:'LC03'},{projectId:'other'})).status,403);
 await f.grant(planRef);const revision=f.store.revision('alpha');assert.equal((await f.call('lifecycle.qualification.prepare',{planRef},{write:true,expectedRevision:revision-1})).status,409);assert.equal(f.store.revision('alpha'),revision);assert.equal(f.calls.length,0);
 f.config.resources[0].revision++;f.save();assert.equal((await f.call('lifecycle.qualification.prepare',{planRef},{write:true})).status,409);assert.equal(f.calls.length,0);
});

test('registered assessment revocation and owner-await credential revocation prevent native mutation',async t=>{
 const f=await registeredQualification(t),original=await f.original(),planRef=await f.plan(original);await f.grant(planRef);const prepared=await f.good('lifecycle.qualification.prepare',{planRef},{write:true}),actionRef=prepared.result.actionRef;
 await f.good('lifecycle.qualification.assessment.revoke',{planRef,reason:'Synthetic revoked grant'},{write:true});assert.equal((await f.call('lifecycle.qualification.dispatch',{actionRef},{write:true})).status,403);assert.equal(f.calls.length,0);
 const second=await f.plan(original,'C');await f.grant(second);const a=await f.good('lifecycle.qualification.prepare',{planRef:second},{write:true});f.onPackage(()=>{const path=join(f.stateRoot,'auth.json'),auth=JSON.parse(fs.readFileSync(path));auth.principals[0].revision++;fs.writeFileSync(path,JSON.stringify(auth));});assert.equal((await f.call('lifecycle.qualification.dispatch',{actionRef:a.result.actionRef},{write:true})).status,403);assert.equal(f.calls.length,0);
});

test('registered readonly origin rejects observer revocation during the final native publication await',async t=>{
 const f=await registeredQualification(t);await f.original();const before=f.store.revision('alpha');f.onRead(r=>{if(r.input.requestId==='original-publication'){const path=join(f.stateRoot,'auth.json'),auth=JSON.parse(fs.readFileSync(path));auth.principals[1].revision++;fs.writeFileSync(path,JSON.stringify(auth));}});
 const result=await f.call('lifecycle.qualification.origin.inspect',{registrationRef:f.ref,caseId:'LC03'},{reader:true});assert.equal(result.status,403);assert.equal(result.result,undefined);assert.equal(f.store.revision('alpha'),before);assert.equal(f.calls.length,0);
});

test('revoked assessment retains original receipt observation without reviving a grant or dispatching again',async t=>{
 const f=await registeredQualification(t),original=await f.original(),planRef=await f.plan(original);await f.grant(planRef);const prepared=await f.good('lifecycle.qualification.prepare',{planRef},{write:true}),actionRef=prepared.result.actionRef;await f.good('lifecycle.qualification.dispatch',{actionRef},{write:true});await f.good('lifecycle.qualification.assessment.revoke',{planRef,reason:'Revoked after actual original dispatch'},{write:true});const revision=f.store.revision('alpha');
 assert.equal((await f.call('lifecycle.qualification.inspect',{actionRef},{reader:true})).status,403);const read=await f.good('lifecycle.qualification.action.inspect',{actionRef},{reader:true});assert.equal(read.observedStatus,'PASS');assert.equal(read.qualification,'NOT_ASSESSED');assert.equal(read.automaticRedispatch,false);assert.equal(f.store.revision('alpha'),revision);assert.equal(f.calls.length,1);
});

// Whole-protocol parser fixtures. These bytes are synthetic and are never
// accepted by the registered installed-service/CI provenance reader.
import {createHash} from 'node:crypto';
import {readLc20ProducerContract,readLc20InputSnapshot,readLc20Execution,observeLc20Protocol,LC20_INPUT_PATH,LC20_EXECUTION_PATH} from '../../dist/adapters/artifacts.js';
import {LC20_CHILDREN,LC20_VECTORS} from '../../dist/lifecycle/correction-contract.js';
function completeLc20Fixture(){
 const files=new Map(),rawPin=(path,value)=>{const raw=Buffer.from(typeof value==='string'?value:JSON.stringify(value));files.set(path,raw);return{path,digest:byteDigest(raw),bytes:raw.length};},candidate=hash('whole-candidate'),sourceCommit='a'.repeat(40),scope={workspaceId:'test',projectId:'alpha',acceptanceScopeDigest:hash('catalog')},runtime=[['runtime:installed-code','generated'],['runtime:environment','environment'],['runtime:toolchain','toolchain'],['runtime:configuration','config'],['runtime:prestate','prestate']].map(([id,kind])=>({id,kind,raw:JSON.stringify({synthetic:true,id}),digest:byteDigest(JSON.stringify({synthetic:true,id}))}));
 const nodes=EVIDENCE_INPUT_KINDS.filter(k=>!['policy','ttl','environment','toolchain','config','prestate'].includes(k)).map(kind=>({id:kind,kind,digest:byteDigest('synthetic-'+kind),sourcePath:kind==='collector'?'tests/acceptance/v090/correction.test.mjs':kind==='source'?'src/fixed.ts':null,candidatePath:kind==='generated'?'dist/fixed.js':null,dependsOn:[]}));nodes.push(...runtime.map(r=>({id:r.id,kind:r.kind,digest:null,sourcePath:null,candidatePath:null,dependsOn:[]})));
 const contract={schema:'runtime-lc20-producer-contract/v1',protocol:'runtime-lc20-local-installed/v1',caseId:'LC20',phase:'PRE_RELEASE',catalogDigest:scope.acceptanceScopeDigest,collector:{sourcePath:'tests/acceptance/v090/correction.test.mjs',digest:byteDigest('synthetic-collector')},workflows:{EXECUTE:{sourcePath:'.github/workflows/lc20.yml',digest:hash('execute')},INVENTORY:{sourcePath:'.github/workflows/lc20-inventory.yml',digest:hash('inventory')}},roots:nodes.map(n=>n.id),nodes,vectors:[...LC20_VECTORS],children:[...LC20_CHILDREN],maxAgeSeconds:60};
 const observation={schema:'runtime-lc20-protocol-observation/v1',scope,status:'COMPLETE',reasons:[],installedCandidateDigest:candidate,inputs:runtime,files:[],childHistory:[]},pin={schema:'runtime-lc20-producer-pin/v1',registrationRef:'binding:synthetic',registrationDigest:hash('registration'),registrationExpiresAt:iso(Date.now()+60000),policyReferenceDigest:hash('policy'),publicationRequestId:'synthetic-publication',validityContractDigest:hash('ttl'),contract,contractDigest:hash(contract),mode:'EXECUTE',protocolObservation:observation},expected={requestId:'outer-original-A',inputDigest:hash('input'),sourceCommit,candidateDigest:candidate},source={entries:[]},candidateFiles=new Map(),inputs=[];
 for(const n of nodes){const raw=runtime.find(r=>r.id===n.id)?.raw??'synthetic-'+n.kind,p=rawPin('inputs/'+n.id.replaceAll(':','-')+'.json',raw);inputs.push({id:n.id,file:p});if(n.sourcePath)source.entries.push({path:n.sourcePath,type:'blob',mode:'100644',objectId:createHash('sha1').update('blob '+Buffer.byteLength(raw)+'\0').update(raw).digest('hex')});if(n.candidatePath)candidateFiles.set(n.candidatePath,n.digest);}
 const snapshot={schema:'runtime-lc20-input-snapshot/v1',contractDigest:pin.contractDigest,mode:'EXECUTE',...expected,producerJobId:'71',inputs};rawPin(LC20_INPUT_PATH,snapshot);
 const now=Date.now(),start=iso(now-5000),end=iso(now-1000),expires=iso(now+60000),protocol={schema:'runtime-lc20-protocol-readback/v1',stageRequestId:expected.requestId,stageRequestDigest:hash('stage-request'),inputDigest:expected.inputDigest,contractDigest:pin.contractDigest,contract,mode:'EXECUTE',original:observation,current:observation,disposition:'PROVEN_FIXED_INPUTS',formalAcceptanceEligible:false,executionAuthorized:false,releaseAuthorized:false},vectors=[];
 for(const vector of LC20_VECTORS){const before=hash({candidate,vector,fixture:'baseline'}),after=hash({candidate,vector,fixture:'current'}),required=vector==='unrelated'?[]:vector==='direct'?['f']:vector==='transitive'?['a','b','c']:[...LC20_CHILDREN],make=(role,id)=>{const candidateDigest=role==='baseline'?before:after,requestId=vector+'-'+role+'-'+id,value=role==='baseline'||!required.includes(id)?id:id+'-changed',rawReceipt=JSON.stringify({schema:'runtime-closed-fixture-execution/v2',requestId,candidateDigest,scope,caseId:'LC20',startedAt:start,completedAt:end,inputManifestDigest:hash('inputs'),result:{outcome:'PASS',value},formalCaseCredit:0}),original={schema:'runtime-original-evidence-execution/v1',mode:'EXECUTED',scope,caseId:'LC20',runId:requestId,candidateDigest,inputManifestDigest:hash('inputs'),rawReceiptDigest:byteDigest(rawReceipt),outcome:'PASS',executedAt:start,expiresAt:expires},proof={schema:'runtime-lc20-child-observation/v1',id,originalExecutionDigest:hash(original),original,rawReceipt};return{id,receipt:rawPin('observations/'+requestId+'.json',proof),proof};};
  const baseline=LC20_CHILDREN.map(id=>make('baseline',id)),selective=required.map(id=>make('selective',id)),full=LC20_CHILDREN.map(id=>make('full',id));if(vector==='missing-edge-fallback')for(const [i,child]of full.entries()){const r=JSON.parse(child.proof.rawReceipt);r.result.value=LC20_CHILDREN[i];child.proof.rawReceipt=JSON.stringify(r);child.proof.original.rawReceiptDigest=byteDigest(child.proof.rawReceipt);child.proof.originalExecutionDigest=hash(child.proof.original);child.receipt=rawPin(child.receipt.path,child.proof);const selected=selective[i],s=JSON.parse(selected.proof.rawReceipt);s.result.value=LC20_CHILDREN[i];selected.proof.rawReceipt=JSON.stringify(s);selected.proof.original.rawReceiptDigest=byteDigest(selected.proof.rawReceipt);selected.proof.originalExecutionDigest=hash(selected.proof.original);selected.receipt=rawPin(selected.receipt.path,selected.proof);}
  const decisions=baseline.map(old=>({id:old.id,qualification:rawPin('observations/'+vector+'-decision-'+old.id+'.json',required.includes(old.id)?{schema:'runtime-probe-input-preview/v1',selection:{originalExecutionDigest:old.proof.originalExecutionDigest,currentCandidateDigest:after},formalAcceptanceEligible:false,disposition:'EXECUTION_REQUIRED',reasons:[vector==='missing-edge-fallback'?'INPUT_CLOSURE_UNKNOWN':'INPUT_CHANGED'],fallback:vector==='missing-edge-fallback'?'FULL':'CASE'}:{schema:'runtime-evidence-qualification/v2',caseId:'LC20',phase:'PRE_RELEASE',hasFailureHistory:false,actionRef:'synthetic-native-action',formalAcceptanceEligible:false,status:'QUALIFIED',mode:'PASS_REUSED',originalExecutionDigest:old.proof.originalExecutionDigest,rawReceiptDigest:old.proof.original.rawReceiptDigest,originalCandidateDigest:before,currentCandidateDigest:after,scope,nativeReceiptDigest:hash('native-receipt'),nativeReportDigest:hash('native-report'),expiresAt:expires})}));vectors.push({id:vector,baseline:baseline.map(({id,receipt})=>({id,receipt})),selective:selective.map(({id,receipt})=>({id,receipt})),full:full.map(({id,receipt})=>({id,receipt})),decisions,outcome:'PASS'});
 }
 const receipt={schema:'runtime-lc20-complete-execution/v1',caseId:'LC20',phase:'PRE_RELEASE',mode:'EXECUTED',contractDigest:pin.contractDigest,...expected,startedAt:start,completedAt:end,inputSnapshotDigest:byteDigest(files.get(LC20_INPUT_PATH)),protocol:{before:rawPin('observations/protocol-before.json',protocol),after:rawPin('observations/protocol-after.json',protocol)},vectors,outcome:'PASS'};rawPin(LC20_EXECUTION_PATH,receipt);return{files,pin,expected,source,candidateFiles,snapshot,receipt,rawPin};
}
test('complete LC20 reader requires all four vectors and real six-child original/selective/full identities',()=>{
 const f=completeLc20Fixture();assert.deepEqual(readLc20ProducerContract(f.pin.contract),f.pin.contract);assert.equal(readLc20InputSnapshot(f.files,f.pin,{...f.expected,producerJobId:'71'},f.source,f.candidateFiles).completeness,'COMPLETE');const read=readLc20Execution(f.files,f.pin,f.expected);assert.equal(read.rawReceiptDigest,byteDigest(f.files.get(LC20_EXECUTION_PATH)));assert.equal(JSON.parse(read.rawReceipt).vectors.length,4);
 for(const mutate of [r=>r.vectors.pop(),r=>r.vectors[0].full.pop(),r=>r.vectors[1].selective=[],r=>r.vectors[2].full[0].receipt=r.vectors[2].baseline[0].receipt,r=>r.mode='PASS_REUSED',r=>r.candidateDigest=hash('unbound-current')]){const bad=completeLc20Fixture();mutate(bad.receipt);bad.rawPin(LC20_EXECUTION_PATH,bad.receipt);assert.throws(()=>readLc20Execution(bad.files,bad.pin,bad.expected));}
});
test('LC20 archived self-described environment cannot replace a protected actual protocol observation',()=>{
 for(const mutate of [f=>f.pin.protocolObservation.inputs=[],f=>f.pin.protocolObservation.inputs[1].raw='caller complete',f=>f.source.entries=[],f=>f.candidateFiles.clear(),f=>f.snapshot.inputs.pop()]){const f=completeLc20Fixture();mutate(f);f.rawPin(LC20_INPUT_PATH,f.snapshot);assert.throws(()=>readLc20InputSnapshot(f.files,f.pin,{...f.expected,producerJobId:'71'},f.source,f.candidateFiles));}
 const f=completeLc20Fixture();f.pin.protocolObservation.status='UNKNOWN';f.pin.protocolObservation.reasons=['LC20_RUNTIME_INPUT_UNKNOWN'];assert.equal(readLc20InputSnapshot(f.files,f.pin,{...f.expected,producerJobId:'71'},f.source,f.candidateFiles).completeness,'UNKNOWN');
 const b=completeLc20Fixture();b.pin.protocolObservation.installedCandidateDigest=hash('other-installed-package');assert.equal(readLc20InputSnapshot(b.files,b.pin,{...b.expected,producerJobId:'71'},b.source,b.candidateFiles).completeness,'UNKNOWN');
});
test('LC20 end observation and assessment validity cannot be manufactured after execution',()=>{
 for(const mutate of [f=>{const p=JSON.parse(f.files.get('observations/protocol-after.json'));p.current.inputs=[];f.receipt.protocol.after=f.rawPin('observations/protocol-after.json',p);},f=>{const ref=f.receipt.vectors[0].decisions[0].qualification,q=JSON.parse(f.files.get(ref.path));q.expiresAt=iso(Date.now()-60000);f.receipt.vectors[0].decisions[0].qualification=f.rawPin(ref.path,q);},f=>{const ref=f.receipt.vectors[3].decisions[0].qualification,q=JSON.parse(f.files.get(ref.path));q.fallback='CASE';f.receipt.vectors[3].decisions[0].qualification=f.rawPin(ref.path,q);}]){const f=completeLc20Fixture();mutate(f);f.rawPin(LC20_EXECUTION_PATH,f.receipt);assert.throws(()=>readLc20Execution(f.files,f.pin,f.expected));}
});


test('a source loader or caller-complete configuration cannot certify the installed LC20 environment',t=>{
 const f=closedFixture(t),scope={workspaceId:'synthetic',projectId:'alpha',acceptanceScopeDigest:hash('catalog')},result=observeLc20Protocol(f.store,{resources:[{projectId:'alpha'}],complete:true,sandbox:'trusted'},scope,hash('policy'),f.actor);assert.equal(result.status,'UNKNOWN');assert(result.reasons.includes('LC20_RUNTIME_INPUT_UNKNOWN'));assert.equal(result.installedCandidateDigest,null);
});


test('only the five fixed protected observation nodes admit null contract digests',()=>{
 for(const mutate of [p=>p.nodes.find(n=>n.kind==='source').digest=null,p=>p.nodes.find(n=>n.id==='runtime:environment').id='runtime:caller-environment',p=>p.nodes.find(n=>n.id==='runtime:environment').digest=hash('caller pin')]){const f=completeLc20Fixture(),p=copy(f.pin.contract);mutate(p);assert.throws(()=>readLc20ProducerContract(p));}
 const f=completeLc20Fixture();const entry=f.snapshot.inputs.find(n=>n.id==='runtime:environment'),changed=JSON.stringify({actualEnvironment:'changed'});entry.file=f.rawPin(entry.file.path,changed);f.rawPin(LC20_INPUT_PATH,f.snapshot);assert.throws(()=>readLc20InputSnapshot(f.files,f.pin,{...f.expected,producerJobId:'71'},f.source,f.candidateFiles),{code:'LC20_INPUT_UNAVAILABLE'});
 const before=completeLc20Fixture(),after=completeLc20Fixture(),node=after.pin.protocolObservation.inputs.find(n=>n.id==='runtime:environment');node.raw=changed;node.digest=byteDigest(changed);const actual=after.snapshot.inputs.find(n=>n.id===node.id);actual.file=after.rawPin(actual.file.path,changed);after.rawPin(LC20_INPUT_PATH,after.snapshot);const a=readLc20InputSnapshot(before.files,before.pin,{...before.expected,producerJobId:'71'},before.source,before.candidateFiles),b=readLc20InputSnapshot(after.files,after.pin,{...after.expected,producerJobId:'71'},after.source,after.candidateFiles);assert.notEqual(a.nodes.find(n=>n.id===node.id).digest,b.nodes.find(n=>n.id===node.id).digest);
});

// Collector fixture guards are source evidence only; no provider is invoked.
import {ADMISSION_STAGES,validateStageAdmissionFixture,assertStageAdmissionPair,collectStageAdmission} from '../acceptance/v090/execution.mjs';
function admissionFixture(provider='github'){
 const context={caseInstanceId:provider==='github'?'E01.variant.04':'E02.variant.03',candidateDigest:hash('installed'),workspaceId:'workspace',projectId:'project',provider};
 return{context,value:{schema:'runtime-v090-stage-admission/v1',...context,sourceCommit:'a'.repeat(40),positive:{instanceId:'complete',codingSourceSelection:{kind:'ORIGINAL_RECORD'}},journeyReport:{ref:'/synthetic/REPORT.json',sha256:'a'.repeat(64)},blocked:ADMISSION_STAGES.map(stageId=>({stageId,instanceId:stageId==='scope'?'complete':'pending',creationRequestId:'native-create'}))}};
}
test('stage admission missing fixture fails before all installed/network/mutation access',async()=>{
 let touched=0;await assert.rejects(()=>collectStageAdmission({selection:{},read:()=>{touched++;},request:()=>{touched++;}}, {caseInstanceId:'E01.variant.04'},'github'),/STAGE_ADMISSION_FIXTURE_REQUIRED/);assert.equal(touched,0);
});
for(const provider of ['github','gitlab'])test('stage admission '+provider+' fixed matrix rejects missing, repeated, reordered, cross-provider and fabricated outcomes',()=>{
 const {value,context}=admissionFixture(provider);assert.equal(validateStageAdmissionFixture(value,context),value);
 const faults=[v=>v.blocked.pop(),v=>v.blocked[1]=copy(v.blocked[0]),v=>v.blocked.reverse(),v=>v.provider=provider==='github'?'gitlab':'github',v=>v.caseInstanceId='E01.journey',v=>v.candidateDigest=hash('other'),v=>v.positive.codingSourceSelection.kind='CURRENT_JOURNEY',v=>v.blocked[1].instanceId='complete',v=>v.blocked[0].instanceId='pending',v=>v.blocked[2].status='PASS',v=>v.sourceCommit='latest'];
 for(const mutate of faults){const f=copy(value);mutate(f);assert.throws(()=>validateStageAdmissionFixture(f,context));}
});
test('stage admission positive raw wire binds allow, input, identity, principal and retained original request',()=>{
 const original={id:'original-request',instanceId:'complete',projectId:'project',stageId:'scope',inputDigest:hash('input'),initiatedBy:{id:'executor'}};
 const input={instanceId:'complete',stageId:'scope'},envelope={projectId:'project',input};
 const pair={admission:{request:{envelope:{...envelope,operation:'lifecycle.stage.admission'}},response:{status:200,body:{result:{allowed:true,reasons:[],executionDispatched:false,inputDigest:original.inputDigest}}}},request:{request:{envelope:{...envelope,operation:'lifecycle.stage.request',requestId:'wire-request'}},response:{status:200,body:{result:{projectId:'project',requestId:'wire-request',principalId:'executor',operation:'lifecycle.stage.request',result:{stageRequestId:original.id,instanceId:'complete',stageId:'scope',inputDigest:original.inputDigest,status:'REQUEST_RETAINED',automaticRedispatch:false}}}}}};
 assert.equal(assertStageAdmissionPair('scope',original,pair).stageRequestId,original.id);
 for(const mutate of [p=>p.admission.response.body.result.allowed=false,p=>p.admission.response.body.result.inputDigest=hash('other'),p=>p.request.response.body.result.result.stageRequestId='other',p=>p.request.response.body.result.principalId='fabricated',p=>p.request.request.envelope.input={...input,outcome:'PASS'},p=>p.request.response.status=409,p=>p.request.response.body.result.result.automaticRedispatch=true]){const p=copy(pair);mutate(p);assert.throws(()=>assertStageAdmissionPair('scope',original,p));}
});

import {openLc20ObservationScope} from '../../dist/adapters/artifacts.js';
test('native invocation observation is retained only on original output and final currentness remains synchronous',async t=>{
 const f=closedFixture(t),original=await f.producer.execute(hash('A'),'scope-original',f.expiresAt,f.actor,f.signal),a=await f.assess(f.selection(original));let opened=0,runs=0,closed=0;
 f.bindings.openObservationScope=signal=>{opened++;const scope=openLc20ObservationScope(signal);return{run(fn){runs++;return scope.run(fn);},close(){closed++;scope.close();}};};
 const first=await f.service.inspect('alpha',a.actionRef,f.actor,f.signal),before=runs;
 assert.equal(f.service.assertCurrent('alpha',first,f.actor,f.signal),undefined);assert.equal(runs,before+1);assert.equal(opened,1);assert.equal(closed,0);
 f.service.closeInspection(first);assert.equal(closed,1);assert.throws(()=>f.service.assertCurrent('alpha',first,f.actor,f.signal),{code:'QUALIFICATION_INSPECTION_REQUIRED'});
 const second=await f.service.inspect('alpha',a.actionRef,f.actor,f.signal);assert.equal(opened,2,'New standalone invocation opens fresh observation');f.service.closeInspection(second);assert.equal(closed,2);
});
test('native observation closes after awaited revocation and caller abort invalidates a retained result',async t=>{
 const f=closedFixture(t),original=await f.producer.execute(hash('A'),'scope-abort-original',f.expiresAt,f.actor,f.signal),a=await f.assess(f.selection(original)),controller=new AbortController();let closed=0;
 f.bindings.openObservationScope=signal=>{const scope=openLc20ObservationScope(signal);return{run:fn=>scope.run(fn),close(){closed++;scope.close();}};};
 const q=await f.service.inspect('alpha',a.actionRef,f.actor,controller.signal);controller.abort();assert.throws(()=>f.service.assertCurrent('alpha',q,f.actor,f.signal),{code:'LC20_RUNTIME_INPUT_UNKNOWN'});f.service.closeInspection(q);
 const read=f.owner.readPackage;f.owner.readPackage=async(...args)=>{const pkg=await read(...args);f.policy.trust.revision='revoked-with-open-byte-scope';return pkg;};
 await assert.rejects(f.service.inspect('alpha',a.actionRef,f.actor,f.signal),{code:'QUALIFICATION_FACTS_CHANGED'});assert.equal(closed,2);
});
test('trusted release root scope survives nested inspections and closes every retained currentness guard together',async t=>{
 const f=closedFixture(t),original=await f.producer.execute(hash('A'),'scope-batch-original',f.expiresAt,f.actor,f.signal),a=await f.assess(f.selection(original));f.bindings.openObservationScope=openLc20ObservationScope;
 const service=createNativeQualificationService(f.store,f.bindings),parent=service.openObservationScope(f.signal);let first,second;
 try{await parent.run(async()=>{first=await service.inspect('alpha',a.actionRef,f.actor,f.signal);second=await service.inspect('alpha',a.actionRef,f.actor,f.signal);assertQualifiedAcceptanceCurrent(service,'alpha',[first,second],f.actor,f.signal);});
  assertQualifiedAcceptanceCurrent(service,'alpha',[first,second],f.actor,f.signal);
 }finally{parent.close();}
 assert.throws(()=>assertQualifiedAcceptanceCurrent(service,'alpha',[first,second],f.actor,f.signal),{code:'LC20_RUNTIME_INPUT_UNKNOWN'});service.closeInspection(first);service.closeInspection(second);
});
test('LC20 current-system environment v2 cannot relabel a retained v1 input as unchanged',()=>{
 const f=completeLc20Fixture(),environment=f.pin.protocolObservation.inputs.find(i=>i.id==='runtime:environment');environment.raw=JSON.stringify({schema:'runtime-lc20-environment/v1',libraries:[]});environment.digest=byteDigest(environment.raw);const input=f.snapshot.inputs.find(i=>i.id===environment.id);input.file=f.rawPin(input.file.path,environment.raw);f.rawPin(LC20_INPUT_PATH,f.snapshot);assert.equal(readLc20InputSnapshot(f.files,f.pin,{...f.expected,producerJobId:'71'},f.source,f.candidateFiles).completeness,'COMPLETE');
 const original=environment.raw;environment.raw=JSON.stringify({schema:'runtime-lc20-environment/v2',basis:'PROCESS_PATHS_CURRENT_SYSTEM_FILES',libraries:[],cache:null});environment.digest=byteDigest(environment.raw);assert.throws(()=>readLc20InputSnapshot(f.files,f.pin,{...f.expected,producerJobId:'71'},f.source,f.candidateFiles),{code:'LC20_INPUT_UNAVAILABLE'});assert.equal(f.files.get(input.file.path).toString(),original,'Historical original bytes remain unchanged');
});
