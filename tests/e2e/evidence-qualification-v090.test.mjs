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
