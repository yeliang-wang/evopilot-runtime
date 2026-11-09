import { exact, record, reject, string } from '../server/errors.js';
import { byteDigest, valueDigest } from './base.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { release as osRelease } from 'node:os';
import { canonical } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import { RuntimeStore, type Receipt } from '../server/store.js';
import { ownerRequestDigest, type PublishedOwnerAdapter, type OwnerMutationPermit } from '../adapters/published-owners.js';
import { nativeInventory, verifyNativeStageResult, type NativeAction, type OwnerPin } from '../adapters/stages.js';
import { nativeSha256, type NativeValidationContext } from '../../vendor/compatibility/v1/native.mjs';
import {
  EVIDENCE_INPUT_KINDS, LC20_CHILDREN, correctionDigest, correctionEnum, correctionTime, immutableCorrection,
  type EvidenceInputManifest, type EvidenceQualification, type EvidenceScope,
  type HarnessQualificationAssessment, type QualificationInput, type TrustedQualificationVerifier,
  type QualificationSelection, type NativeEvidenceQualification, type TypedCurrentExecutionCapture,
} from './correction-contract.js';
export type {TypedCurrentExecutionCapture} from './correction-contract.js';
export const QUALIFICATION_READS=['lifecycle.qualification.origin.inspect','lifecycle.qualification.action.inspect','lifecycle.qualification.inspect','lifecycle.qualification.execution.inspect','lifecycle.qualification.assessment.preview','lifecycle.qualification.assessment.inspect'] as const;
export const QUALIFICATION_WRITES=['lifecycle.qualification.probe.execute','lifecycle.qualification.plan','lifecycle.qualification.prepare','lifecycle.qualification.dispatch','lifecycle.qualification.execution.capture','lifecycle.qualification.assessment.authorize','lifecycle.qualification.assessment.revoke'] as const;

const outcomes=['PASS','FAIL','NOT_RUN','CANCELLED','UNKNOWN','SKIPPED'] as const;
const ordinal=(a:string,b:string):number=>a<b?-1:a>b?1:0;
function scope(value:EvidenceScope):void {
  exact(record(value),['workspaceId','projectId','acceptanceScopeDigest']);
  string(value.workspaceId,512);string(value.projectId,512);correctionDigest(value.acceptanceScopeDigest);
}
function ids(value:string[]):void {
  if(!Array.isArray(value)||value.length>4096)reject('INVALID_INPUT_CLOSURE','Bounded input identifiers required');
  value.forEach(v=>string(v,512));
  if(new Set(value).size!==value.length)reject('INVALID_INPUT_CLOSURE','Duplicate input identifier');
}
/** Structural completeness is necessary, never proof of actual completeness.
 * Only the trusted owner adapter may attest the declaration covers real inputs. */
function manifest(value:EvidenceInputManifest):{complete:boolean;closureDigest:string} {
  exact(record(value),['schema','candidateDigest','completeness','dynamicInputs','externalInputs','roots','nodes','notApplicable']);
  if(value.schema!=='runtime-evidence-input-manifest/v1')reject('UNSUPPORTED_INPUT_MANIFEST','Unsupported evidence input schema');
  correctionDigest(value.candidateDigest);correctionEnum(value.completeness,['COMPLETE','INCOMPLETE','UNKNOWN']);
  correctionEnum(value.dynamicInputs,['RESOLVED','UNKNOWN']);correctionEnum(value.externalInputs,['RESOLVED','UNKNOWN']);ids(value.roots);
  if(!Array.isArray(value.nodes)||value.nodes.length>4096||!Array.isArray(value.notApplicable)||value.notApplicable.length>EVIDENCE_INPUT_KINDS.length)reject('INVALID_INPUT_CLOSURE','Bounded declared input closure required');
  const nodes=new Map<string,EvidenceInputManifest['nodes'][number]>(),kinds=new Set<string>();
  for(const node of value.nodes){
    exact(record(node),['id','kind','digest','dependsOn']);string(node.id,512);correctionEnum(node.kind,EVIDENCE_INPUT_KINDS);correctionDigest(node.digest);ids(node.dependsOn);
    if(nodes.has(node.id))reject('INVALID_INPUT_CLOSURE','Duplicate declared input');nodes.set(node.id,node);kinds.add(node.kind);
  }
  for(const absent of value.notApplicable){
    exact(record(absent),['kind','reason']);correctionEnum(absent.kind,EVIDENCE_INPUT_KINDS);string(absent.reason,2048);
    if(kinds.has(absent.kind))reject('INVALID_INPUT_CLOSURE','Input kind is both present and absent, or repeats');kinds.add(absent.kind);
  }
  let complete=value.completeness==='COMPLETE'&&value.dynamicInputs==='RESOLVED'&&value.externalInputs==='RESOLVED'&&value.roots.length>0&&kinds.size===EVIDENCE_INPUT_KINDS.length;
  const visited=new Set<string>(),pending=[...value.roots];
  while(pending.length){const id=pending.pop()!;if(visited.has(id))continue;visited.add(id);const node=nodes.get(id);if(!node){complete=false;continue;}pending.push(...node.dependsOn);}
  // Unreachable nodes are not evidence of a closed graph: a missing edge can
  // otherwise silently discard exactly the changed transitive input.
  if(visited.size!==nodes.size||[...nodes.keys()].some(id=>!visited.has(id)))complete=false;
  const normalized={roots:[...value.roots].sort(),nodes:value.nodes.map(n=>({...n,dependsOn:[...n.dependsOn].sort()})).sort((a,b)=>ordinal(a.id,b.id)),notApplicable:[...value.notApplicable].sort((a,b)=>ordinal(a.kind,b.kind))};
  return{complete,closureDigest:valueDigest(normalized)};
}
function validateInput(input:QualificationInput,now:number):{reasons:string[];fallback:EvidenceQualification['fallback'];hasFailureHistory:boolean} {
  exact(record(input),['schema','scope','caseId','currentCandidateDigest','original','originalExecutionDigest','rawReceipt','originalInputs','currentInputs','history','executionRule']);
  if(input.schema!=='runtime-evidence-qualification-input/v1')reject('UNSUPPORTED_QUALIFICATION_SCHEMA','Unsupported qualification schema');
  if(!Number.isFinite(now))reject('INVALID_CORRECTION_TIME','Finite current time required');
  scope(input.scope);string(input.caseId,512);correctionDigest(input.currentCandidateDigest);correctionDigest(input.originalExecutionDigest);correctionEnum(input.executionRule,['MUST_EXECUTE','OWNER_POLICY']);
  const original=input.original;
  exact(record(original),['schema','mode','scope','caseId','runId','candidateDigest','inputManifestDigest','rawReceiptDigest','outcome','executedAt','expiresAt']);
  if(original.schema!=='runtime-original-evidence-execution/v1'||original.mode!=='EXECUTED')reject('ORIGINAL_EXECUTION_REQUIRED','A qualification or reused label cannot replace the original execution');
  scope(original.scope);string(original.caseId,512);string(original.runId,512);correctionEnum(original.outcome,outcomes);
  for(const d of [original.candidateDigest,original.inputManifestDigest,original.rawReceiptDigest])correctionDigest(d);
  const executedAt=correctionTime(original.executedAt),expiresAt=correctionTime(original.expiresAt),reasons:string[]=[];
  if(typeof input.rawReceipt!=='string'||!input.rawReceipt.length||Buffer.byteLength(input.rawReceipt)>131072)reject('INVALID_RAW_RECEIPT','Bounded original receipt bytes required');
  if(valueDigest(original)!==input.originalExecutionDigest||byteDigest(input.rawReceipt)!==original.rawReceiptDigest)reasons.push('ORIGINAL_EVIDENCE_DIGEST_MISMATCH');
  if(valueDigest(input.scope)!==valueDigest(original.scope)||input.caseId!==original.caseId)reasons.push('ORIGINAL_EVIDENCE_SCOPE_MISMATCH');
  if(executedAt>now||expiresAt<=executedAt)reasons.push('ORIGINAL_EVIDENCE_TIME_INVALID');
  if(expiresAt<=now)reasons.push('ORIGINAL_EVIDENCE_EXPIRED');
  if(original.outcome!=='PASS')reasons.push('ORIGINAL_EXECUTION_NOT_PASS');
  const before=manifest(input.originalInputs),after=manifest(input.currentInputs);
  if(valueDigest(input.originalInputs)!==original.inputManifestDigest||input.originalInputs.candidateDigest!==original.candidateDigest||input.currentInputs.candidateDigest!==input.currentCandidateDigest)reasons.push('INPUT_MANIFEST_BINDING_MISMATCH');
  if(!before.complete||!after.complete)reasons.push('INPUT_CLOSURE_UNKNOWN');
  if(before.closureDigest!==after.closureDigest)reasons.push('DECLARED_INPUT_CHANGED');
  if(!Array.isArray(input.history)||!input.history.length||input.history.length>4096)reject('INVALID_EVIDENCE_HISTORY','Complete bounded execution history required');
  const executions=new Set<string>();let last=-Infinity,foundOriginal=false;
  for(const item of input.history){
    exact(record(item),['executionDigest','candidateDigest','rawReceiptDigest','outcome','executedAt']);
    for(const d of [item.executionDigest,item.candidateDigest,item.rawReceiptDigest])correctionDigest(d);correctionEnum(item.outcome,outcomes);
    const at=correctionTime(item.executedAt);
    if(executions.has(item.executionDigest)||at<last||at>now)reject('INVALID_EVIDENCE_HISTORY','Execution history must be unique, chronological and already observed');
    last=at;executions.add(item.executionDigest);
    if(item.executionDigest===input.originalExecutionDigest){
      foundOriginal=true;
      if(item.candidateDigest!==original.candidateDigest||item.rawReceiptDigest!==original.rawReceiptDigest||item.outcome!==original.outcome||item.executedAt!==original.executedAt)reasons.push('ORIGINAL_HISTORY_MISMATCH');
    }
  }
  if(!foundOriginal)reasons.push('ORIGINAL_HISTORY_MISSING');
  const hasFailureHistory=input.history.some(h=>h.outcome!=='PASS'),reuse=original.candidateDigest!==input.currentCandidateDigest;
  // A later failure cannot be hidden by selecting an older PASS; flaky evidence
  // remains visible even when the owner assesses a newly executed current PASS.
  if(reuse&&hasFailureHistory)reasons.push('FAILURE_HISTORY_REQUIRES_EXECUTION');
  const latest=input.history.at(-1)!;
  if(!reuse&&latest.executionDigest!==input.originalExecutionDigest)reasons.push('CURRENT_EXECUTION_SUPERSEDED');
  if(reuse&&input.executionRule==='MUST_EXECUTE')reasons.push('FINAL_MUST_EXECUTE');
  return{reasons,fallback:!before.complete||!after.complete?'FULL':'CASE',hasFailureHistory};
}
function validateAssessment(assessment:HarnessQualificationAssessment,subject:QualificationInput,subjectDigest:string,now:number):void {
  exact(record(assessment),['schema','owner','subjectDigest','policy','assessmentReceiptRef','trustRevision','assessedAt','expiresAt','verdict','executionRequirement']);
  if(assessment.schema!=='runtime-harness-qualification-assessment/v1'||assessment.owner!=='harness'||assessment.subjectDigest!==subjectDigest)reject('OWNER_ASSESSMENT_MISMATCH','Assessment must cover this exact qualification subject');
  exact(record(assessment.policy),['id','version','digest','publishedReceiptRef']);
  for(const s of [assessment.policy.id,assessment.policy.version,assessment.policy.publishedReceiptRef,assessment.assessmentReceiptRef,assessment.trustRevision])string(s,512);
  correctionDigest(assessment.policy.digest);correctionEnum(assessment.verdict,['PASS','FAIL','UNKNOWN']);correctionEnum(assessment.executionRequirement,['MUST_EXECUTE','REUSE_PERMITTED']);
  const assessedAt=correctionTime(assessment.assessedAt),expiresAt=correctionTime(assessment.expiresAt);
  if(assessedAt>now||assessedAt<correctionTime(subject.original.executedAt)||expiresAt<=now||expiresAt<=assessedAt)reject('OWNER_ASSESSMENT_EXPIRED','Current owner assessment and policy validity required');
  if(!subject.currentInputs.nodes.some(n=>n.kind==='policy'&&n.digest===assessment.policy.digest)||!subject.currentInputs.nodes.some(n=>n.kind==='ttl'))reject('OWNER_POLICY_INPUT_MISSING','Exact owner policy and TTL must be declared inputs');
}

/** This creates a new applicability record; it never edits the original evidence
 * or maps PASS_REUSED into lifecycle stage completion. Re-evaluate through the
 * trusted verifier before consuming a qualification; a saved record alone does
 * not prove that its policy remains published, trusted or unrevoked. */
export async function qualifyEvidence(input:QualificationInput,verifier?:TrustedQualificationVerifier,now=Date.now(),signal?:AbortSignal):Promise<EvidenceQualification> {
  const started=performance.now();
  const subject=immutableCorrection(input),checked=validateInput(subject,now),subjectDigest=valueDigest(subject),reasons=[...checked.reasons];
  let assessment:HarnessQualificationAssessment|null=null;
  if(!verifier)reasons.push('OWNER_POLICY_UNAVAILABLE');
  else if(!reasons.length){
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
    try{
      if(signal?.aborted)controller.abort();
      const returned=await Promise.race([
        Promise.resolve().then(()=>{controller.signal.throwIfAborted();return verifier.verify(subject,subjectDigest,controller.signal);}),
        new Promise<never>((_resolve,fail)=>{timer=setTimeout(()=>{controller.abort();fail(Error('Owner assessment timed out'));},5000);controller.signal.addEventListener('abort',()=>fail(Error('Owner assessment interrupted')),{once:true});if(controller.signal.aborted)fail(Error('Owner assessment interrupted'));}),
      ]);
      if(!returned)reasons.push('OWNER_POLICY_UNAVAILABLE');
      else{
        controller.signal.throwIfAborted();
        const verified=immutableCorrection(returned),currentTime=now+Math.max(0,performance.now()-started);
        validateAssessment(verified,subject,subjectDigest,currentTime);assessment=verified;
        if(correctionTime(subject.original.expiresAt)<=currentTime)reasons.push('ORIGINAL_EVIDENCE_EXPIRED');
        if(assessment.verdict!=='PASS')reasons.push('OWNER_ASSESSMENT_NOT_PASS');
        if(subject.original.candidateDigest!==subject.currentCandidateDigest&&assessment.executionRequirement==='MUST_EXECUTE')reasons.push('OWNER_MUST_EXECUTE');
      }
    }catch{reasons.push('OWNER_ASSESSMENT_UNVERIFIED');}
    finally{if(timer)clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  if(signal?.aborted&&!reasons.includes('OWNER_ASSESSMENT_UNVERIFIED'))reasons.push('OWNER_ASSESSMENT_INTERRUPTED');
  const finalTime=now+Math.max(0,performance.now()-started);
  if(!reasons.length&&(correctionTime(subject.original.expiresAt)<=finalTime||!assessment||correctionTime(assessment.expiresAt)<=finalTime))reasons.push('QUALIFICATION_EXPIRED_DURING_ASSESSMENT');
  const qualified=reasons.length===0;
  return immutableCorrection({schema:'runtime-evidence-qualification/v1',caseId:subject.caseId,scope:subject.scope,subjectDigest,currentCandidateDigest:subject.currentCandidateDigest,originalExecutionDigest:subject.originalExecutionDigest,originalCandidateDigest:subject.original.candidateDigest,rawReceiptDigest:subject.original.rawReceiptDigest,status:qualified?'QUALIFIED':'EXECUTION_REQUIRED',mode:qualified?(subject.original.candidateDigest===subject.currentCandidateDigest?'EXECUTED':'PASS_REUSED'):null,reasons,fallback:checked.fallback,assessment,expiresAt:qualified?new Date(Math.min(correctionTime(subject.original.expiresAt),correctionTime(assessment!.expiresAt))).toISOString():null,history:subject.history,hasFailureHistory:checked.hasFailureHistory,establishesEnvironmentState:false,executionAuthorized:false});
}

/** These facts are loaded by an operator-installed internal reader from actual
 * collection/provenance records, never from an API import or passing JSON file.
 * Hashes bind those reads; they do not authenticate the source or completeness. */
export interface ProtectedQualificationFacts {
  schema:'runtime-protected-qualification-facts/v2'; input:QualificationInput; formalAcceptanceEligible:boolean;
  original:{receiptRef:string;rawBytesRef:string;revision:string;readbackDigest:string};
  history:{receiptRef:string;watermark:string};
  inventories:{original:{receiptRef:string;revision:string};current:{receiptRef:string;revision:string}};
  policy:{owner:OwnerPin;publishedReceiptRef:string;effectiveConfigDigest:string;toolchainLockDigest:string;
    profileDigest:string;catalogScopeDigest:string;caseInventoryDigest:string;validityContractDigest:string;
    trust:{revision:string;protectedRecordRef:string;recordDigest:string;expiresAt:string};
    requirement:{phase:'PRE_RELEASE'|'POST_RELEASE';executionRequirement:'ALWAYS_MUST_EXECUTE'|'AFFECTED_OR_UNKNOWN_MUST_EXECUTE';impact:'UNCHANGED'|'AFFECTED'|'UNKNOWN';serialGroupStatus:'PROTECTED_COMPLETE_UNCHANGED_GROUP'|'UNKNOWN';inventoryRef:string;inventoryRevision:string};};
  validity:{receiptRef:string;revision:string;recordDigest:string;originalPolicy:{protectedRecordRef:string;recordDigest:string;expiresAt:string}|null;originalPolicyApplicability:'APPLICABLE'|'VERIFIED_NOT_APPLICABLE'};
  assessmentAuthority:{requestId:string;authorityRef:string;authorityDigest:string;deadlineAt:string};
}
export interface NativeQualificationBindings {
  /** Must authenticate originals, a complete history watermark and independently
   * discovered inventories, including current policy revocation and validity.
   * No caller declarations may be promoted to these facts. */
  read(selection:Readonly<QualificationSelection>,actor:Principal,signal:AbortSignal):Promise<ProtectedQualificationFacts>;
  owner(ref:string):PublishedOwnerAdapter;
  /** Trusted composition only: synchronously reload the current principal and
   * exact assessment grant from local credentials/authority state. A request
   * body, saved permit or the initiating principal is not current authority.
   * No await may separate this final check from the local dispatch boundary. */
  authorizeDispatch(subject:Readonly<QualificationDispatchSubject>,initiatingActor:Principal):{actor:Principal;permit:OwnerMutationPermit};
  /** Read-only final boundary: synchronously reload current read credentials
   * and confirm the existing assessment grant, trust, registration and retained
   * complete facts (history and input inventories included) still match this
   * exact subject. Reject when synchronous current authentication is unavailable.
   * Never grant execution or require execution.request. No cached principal. */
  authorizeInspect(subject:Readonly<QualificationInspectionSubject>,observer:Principal):Principal;
  /** Internal registered producer only. Absence is unsupported, never a PASS. */
  readExecution?(projectId:string,captureRef:string,actor:Principal,signal:AbortSignal):Promise<TypedCurrentExecutionCapture>;
  authorizeExecution?(projectId:string,capture:Readonly<TypedCurrentExecutionCapture>,observer:Principal):Principal;
}
export interface QualificationDispatchSubject {
  projectId:string;actionRef:string;actionDigest:string;requestDigest:string;
  authorityRef:string;authorityDigest:string;expiresAt:string;
}
export interface QualificationInspectionSubject extends QualificationDispatchSubject {
  selection:QualificationSelection;protectedFactsDigest:string;ownerRegistrationDigest:string;trustRevision:string;historyWatermark:string;
}
export interface QualificationAction {
  schema:'runtime-native-qualification-action/v2'; selection:QualificationSelection;
  facts:ProtectedQualificationFacts; factsDigest:string; action:NativeAction;
  assessedAt:string; expiresAt:string; digest:string;
}
/** Supplied by the same authenticated service dispatcher, never by JSON. */
export interface QualificationMutationContext {
  operation:string; requestId:string; expectedRevision:number; input:Record<string,unknown>; reauthorize:()=>Principal;
}
const sameQualification=(a:unknown,b:unknown):boolean=>valueDigest(a)===valueDigest(b);
const boundedText=(v:unknown):string=>string(v,512);
function validateSelection(value:QualificationSelection):void {
  exact(record(value),['schema','scope','caseId','currentCandidateDigest','originalExecutionDigest','phase']);
  if(value.schema!=='runtime-evidence-qualification-selection/v2')reject('UNSUPPORTED_QUALIFICATION_SCHEMA','A v2 protected-record selection is required');
  scope(value.scope);boundedText(value.caseId);correctionDigest(value.currentCandidateDigest);correctionDigest(value.originalExecutionDigest);correctionEnum(value.phase,['PRE_RELEASE','POST_RELEASE']);
}
function qualificationFacts(selection:QualificationSelection,facts:ProtectedQualificationFacts,now:number):number {
  exact(record(facts),['schema','input','formalAcceptanceEligible','original','history','inventories','policy','validity','assessmentAuthority']);
  if(facts.schema!=='runtime-protected-qualification-facts/v2')reject('QUALIFICATION_PROVENANCE_REQUIRED','Actual protected v2 facts are required');
  if(typeof facts.formalAcceptanceEligible!=='boolean')reject('QUALIFICATION_PROVENANCE_REQUIRED','Exact formal evidence eligibility required');
  const input=facts.input,checked=validateInput(input,now);
  if(checked.reasons.length)reject('QUALIFICATION_EXECUTION_REQUIRED',checked.reasons.join(', '),409);
  if(!sameQualification(input.scope,selection.scope)||input.caseId!==selection.caseId||input.currentCandidateDigest!==selection.currentCandidateDigest||input.originalExecutionDigest!==selection.originalExecutionDigest)reject('QUALIFICATION_SCOPE_CHANGED','Protected original and current candidate must match the selection');
  for(const value of [facts.original.receiptRef,facts.original.rawBytesRef,facts.original.revision,facts.history.receiptRef,facts.history.watermark,facts.inventories.original.receiptRef,facts.inventories.original.revision,facts.inventories.current.receiptRef,facts.inventories.current.revision,facts.policy.publishedReceiptRef,facts.policy.trust.revision,facts.policy.trust.protectedRecordRef,facts.policy.requirement.inventoryRef,facts.policy.requirement.inventoryRevision,facts.validity.receiptRef,facts.validity.revision,facts.assessmentAuthority.requestId,facts.assessmentAuthority.authorityRef])boundedText(value);
  const p=facts.policy;
  for(const d of [facts.original.readbackDigest,p.effectiveConfigDigest,p.toolchainLockDigest,p.profileDigest,p.catalogScopeDigest,p.caseInventoryDigest,p.validityContractDigest,p.trust.recordDigest,facts.validity.recordDigest,facts.assessmentAuthority.authorityDigest,p.owner.registrationDigest])correctionDigest(d);
  if(p.catalogScopeDigest!==input.scope.acceptanceScopeDigest||p.owner.scope.projectId!==input.scope.projectId||p.owner.reference.product!=='harness'||p.requirement.phase!==selection.phase)reject('QUALIFICATION_POLICY_SCOPE','Published policy must cover the exact acceptance scope and phase');
  correctionEnum(p.requirement.executionRequirement,['ALWAYS_MUST_EXECUTE','AFFECTED_OR_UNKNOWN_MUST_EXECUTE']);correctionEnum(p.requirement.impact,['UNCHANGED','AFFECTED','UNKNOWN']);correctionEnum(p.requirement.serialGroupStatus,['PROTECTED_COMPLETE_UNCHANGED_GROUP','UNKNOWN']);
  if(input.original.candidateDigest!==input.currentCandidateDigest&&(p.requirement.executionRequirement==='ALWAYS_MUST_EXECUTE'||p.requirement.impact!=='UNCHANGED'||p.requirement.serialGroupStatus!=='PROTECTED_COMPLETE_UNCHANGED_GROUP'))reject('QUALIFICATION_EXECUTION_REQUIRED','Current mandatory, affected or uncertain group requires actual execution',409);
  if(!input.currentInputs.nodes.some(n=>n.kind==='policy'&&n.digest===p.owner.reference.digest)||!input.currentInputs.nodes.some(n=>n.kind==='ttl'&&n.digest===p.validityContractDigest))reject('QUALIFICATION_POLICY_INPUT','Exact published policy and validity contract must be declared');
  correctionEnum(facts.validity.originalPolicyApplicability,['APPLICABLE','VERIFIED_NOT_APPLICABLE']);
  if((facts.validity.originalPolicyApplicability==='APPLICABLE')!==(facts.validity.originalPolicy!==null))reject('QUALIFICATION_VALIDITY_UNKNOWN','Original policy applicability requires its actual validity bound');
  const bounds=[input.original.expiresAt,p.trust.expiresAt,facts.assessmentAuthority.deadlineAt];
  if(facts.validity.originalPolicy){boundedText(facts.validity.originalPolicy.protectedRecordRef);correctionDigest(facts.validity.originalPolicy.recordDigest);bounds.push(facts.validity.originalPolicy.expiresAt);}
  const expires=Math.min(...bounds.map(correctionTime));if(expires<=now)reject('QUALIFICATION_EXPIRED','Original evidence, policy, trust or assessment authority expired',409);
  return expires;
}
function closure(value:EvidenceInputManifest,provenance:{receiptRef:string;revision:string}) {
  const nodes=Object.fromEntries(value.nodes.map(n=>[n.id,{kind:n.kind,digest:n.digest,dependsOn:[...n.dependsOn].sort()}])),paths:Record<string,string[]>={},pending=value.roots.map(id=>[id]);
  // One bounded breadth-first path per node; never expand a visited cycle.
  for(let cursor=0;cursor<pending.length;cursor++){const path=pending[cursor],id=path.at(-1)!;if(paths[id])continue;paths[id]=path;for(const dep of nodes[id].dependsOn)if(!paths[dep])pending.push([...path,dep]);}
  const roots=[...value.roots].sort(),notApplicable=Object.fromEntries(value.notApplicable.map(n=>[n.kind,n.reason]));
  return{schema:'runtime-qualification-closure/draft-v1',candidateDigest:value.candidateDigest,completeness:value.completeness,dynamicInputs:value.dynamicInputs,externalInputs:value.externalInputs,roots,nodes,paths,notApplicable,discovery:{status:'PROTECTED_COMPLETE_INVENTORY',originalReceiptRef:provenance.receiptRef,revision:provenance.revision,inventoryDigest:valueDigest(value),nodeIds:Object.keys(nodes).sort(),edges:Object.fromEntries(Object.entries(nodes).map(([id,n])=>[id,n.dependsOn])),notApplicable}};
}
/** Materialize only the reviewed native asset's declared observation contract.
 * The actual Harness engine still owns every HQA criterion and its assessment. */
function policyObservation(selection:QualificationSelection,facts:ProtectedQualificationFacts,assessedAt:string) {
  const i=facts.input,p=facts.policy,epoch=(v:string)=>correctionTime(v)/1000;
  const original={mode:i.original.mode,outcome:i.original.outcome,caseId:i.caseId,scope:i.scope,candidateDigest:i.original.candidateDigest,executionDigest:i.originalExecutionDigest,rawReceiptDigest:i.original.rawReceiptDigest,runId:i.original.runId,executedEpochSeconds:epoch(i.original.executedAt),expiresEpochSeconds:epoch(i.original.expiresAt)};
  const history=i.history.map(h=>({executionDigest:h.executionDigest,candidateDigest:h.candidateDigest,rawReceiptDigest:h.rawReceiptDigest,outcome:h.outcome,executedEpochSeconds:epoch(h.executedAt)}));
  const bounds:Record<string,{expiresEpochSeconds:number;protectedRecordRef:string;recordDigest:string}>={originalEvidence:{expiresEpochSeconds:epoch(i.original.expiresAt),protectedRecordRef:facts.original.receiptRef,recordDigest:i.originalExecutionDigest},currentTrust:{expiresEpochSeconds:epoch(p.trust.expiresAt),protectedRecordRef:p.trust.protectedRecordRef,recordDigest:p.trust.recordDigest},assessmentAuthorization:{expiresEpochSeconds:epoch(facts.assessmentAuthority.deadlineAt),protectedRecordRef:facts.assessmentAuthority.authorityRef,recordDigest:facts.assessmentAuthority.authorityDigest}};
  if(facts.validity.originalPolicy){const o=facts.validity.originalPolicy;bounds.originalPolicy={expiresEpochSeconds:epoch(o.expiresAt),protectedRecordRef:o.protectedRecordRef,recordDigest:o.recordDigest};}
  return{schema:'evopilot-observation/v1',origin:'runtime-observation',source:{revision:facts.original.revision,digest:facts.original.readbackDigest},values:{evidenceQualification:{schema:'runtime-qualification-policy-input/runtime-v090-proposal-v1',binding:{profileContext:'FINAL_CANDIDATE_ACCEPTANCE',subjectDigest:valueDigest(i),currentCandidateDigest:i.currentCandidateDigest,originalCandidateDigest:i.original.candidateDigest,scope:i.scope,currentProtectedScope:i.scope,currentProtectedCandidateDigest:i.currentCandidateDigest,caseId:i.caseId,requestedMode:i.original.candidateDigest===i.currentCandidateDigest?'EXECUTED':'REUSE',currentPhase:selection.phase},original,authenticatedOriginal:{execution:original,status:'PROTECTED_RECORD_READBACK',originalReceiptRef:facts.original.receiptRef,originalRawBytesRef:facts.original.rawBytesRef,readbackRevision:facts.original.revision,readbackDigest:facts.original.readbackDigest,rawBytesDigest:byteDigest(i.rawReceipt)},originalInputs:closure(i.originalInputs,facts.inventories.original),currentInputs:closure(i.currentInputs,facts.inventories.current),inputComparison:{originalClosureDigest:manifest(i.originalInputs).closureDigest,currentClosureDigest:manifest(i.currentInputs).closureDigest,status:'PROTECTED_NORMALIZATION',derivationReceiptRef:facts.inventories.current.receiptRef},policy:{id:p.owner.reference.id,version:p.owner.reference.version,referenceDigest:p.owner.reference.digest,selectedReferenceDigest:p.owner.reference.digest,publicationStatus:'PUBLISHED',originalPublicationReceiptRef:p.publishedReceiptRef,trust:{status:'ACTIVE',scope:i.scope,revision:p.trust.revision,protectedRecordRef:p.trust.protectedRecordRef,recordDigest:p.trust.recordDigest,expiresEpochSeconds:epoch(p.trust.expiresAt)},ttlParameterDigest:p.validityContractDigest},clock:{nowEpochSeconds:epoch(assessedAt),protectedSnapshotRef:facts.assessmentAuthority.requestId},validity:{schema:'runtime-qualification-validity-input/proposal-v1',contractDigest:p.validityContractDigest,status:'PROTECTED_COMPLETE_VALIDITY_BOUNDS',bounds,originalPolicyApplicability:facts.validity.originalPolicyApplicability,earliestExpiresEpochSeconds:Math.min(...Object.values(bounds).map(b=>b.expiresEpochSeconds))},authenticatedValidity:{status:'PROTECTED_CURRENT_VALIDITY_READBACK',bounds,originalPolicyApplicability:facts.validity.originalPolicyApplicability,originalReceiptRef:facts.validity.receiptRef,revision:facts.validity.revision,recordDigest:facts.validity.recordDigest},assessmentAction:{subjectDigest:valueDigest(i),originalRequestId:facts.assessmentAuthority.requestId,originalAuthorityRef:facts.assessmentAuthority.authorityRef,authorityDigest:facts.assessmentAuthority.authorityDigest,originalDeadlineEpochSeconds:epoch(facts.assessmentAuthority.deadlineAt)},requirement:{caseId:i.caseId,phase:selection.phase,currentProtectedPhase:selection.phase,profileDigest:p.profileDigest,protectedInventoryDigest:p.caseInventoryDigest,protectedInventoryRef:p.requirement.inventoryRef,protectedInventoryRevision:p.requirement.inventoryRevision,executionRule:i.executionRule,impact:p.requirement.impact,serialGroupStatus:p.requirement.serialGroupStatus},history:{status:'COMPLETE',entries:history,watermark:facts.history.watermark},authenticatedHistory:{status:'PROTECTED_CURRENT_HISTORY',entries:history,watermark:facts.history.watermark,originalReceiptRef:facts.history.receiptRef,historyDigest:valueDigest(i.history)},constraints:{purpose:'QUALIFICATION_ONLY',establishesEnvironmentState:false,useAsPreparation:false,executionAuthorized:false,releaseAuthorized:false,mutateOriginal:false}}}};
}
const nativeServices=new WeakSet<object>();
export interface NativeQualificationService {
  prepare(selection:QualificationSelection,actor:Principal,signal:AbortSignal,mutation?:QualificationMutationContext):Promise<{actionRef:string;actionDigest:string;requestDigest:string;authorityRef:string;expiresAt:string}>;
  dispatch(projectId:string,actionRef:string,actor:Principal,signal:AbortSignal,mutation?:QualificationMutationContext):Promise<void>;
  inspect(projectId:string,actionRef:string,actor:Principal,signal:AbortSignal):Promise<NativeEvidenceQualification>;
  /** Synchronous final/batch guard, only for this service's actual inspections.
   * It performs no owner calls, asynchronous work or mutations. */
  assertCurrent(projectId:string,qualification:NativeEvidenceQualification,actor:Principal,signal:AbortSignal):void;
  inspectExecution(projectId:string,captureRef:string,actor:Principal,signal:AbortSignal):Promise<TypedCurrentExecutionCapture>;
  assertExecutionCurrent(projectId:string,capture:TypedCurrentExecutionCapture,actor:Principal,signal:AbortSignal):void;
}
/** Internal composition capability. JSON, a v1 verifier and self-signed files
 * cannot supply this service to release auditing. */
export function assertNativeQualificationService(service:NativeQualificationService):void {if(!nativeServices.has(service))reject('TRUSTED_QUALIFICATION_SERVICE_REQUIRED','Use the registered native qualification service');}
export function createNativeQualificationService(store:RuntimeStore,bindings:NativeQualificationBindings):NativeQualificationService {
  const kind='lifecycle-evidence-qualification';
  const inspections=new WeakMap<NativeEvidenceQualification,{subject:QualificationInspectionSubject;observer:{id:string;revision:number}}>();
  const executions=new WeakMap<TypedCurrentExecutionCapture,{id:string;revision:number}>();
  function retain(projectId:string,id:string,value:unknown,actor:Principal,mutation?:QualificationMutationContext):Receipt|undefined {
    const old=store.object(projectId,kind,id);if(old){if(!sameQualification(old,value))reject('QUALIFICATION_IMMUTABLE','Original qualification action cannot change',409);if(!mutation)return;}
    return store.mutate(actor,{projectId,...(mutation??{operation:'lifecycle.qualification.retain',requestId:'qualification-'+randomUUID(),expectedRevision:store.revision(projectId),input:{id,digest:valueDigest(value)}}),permission:'execution.request'},()=>({objects:[{kind,id,value}],value:{actionRef:id.startsWith('dispatch:')?id.slice(9):id,retained:true,automaticRedispatch:false},event:{type:'qualification-native-action',data:{id,digest:valueDigest(value)}}}),mutation?.reauthorize);
  }
  function load(projectId:string,ref:string,actor:Principal):QualificationAction {
    authorize(actor,projectId,'read');const a=store.object(projectId,kind,boundedText(ref)) as QualificationAction|null;
    if(!a||a.schema!=='runtime-native-qualification-action/v2')reject('QUALIFICATION_ACTION_REQUIRED','Original native assessment action is required',409);
    const{digest,...body}=a;if(valueDigest(body)!==digest||a.factsDigest!==valueDigest(a.facts)||a.selection.scope.projectId!==projectId||a.selection.scope.workspaceId!==store.workspaceId)reject('QUALIFICATION_ACTION_CHANGED','Original assessment binding changed',503);return a;
  }
  function registeredOwner(facts:ProtectedQualificationFacts):PublishedOwnerAdapter {
    const owner=bindings.owner(facts.policy.owner.ref),capabilities=record(owner.capabilities());
    if(owner.owner!=='harness'||owner.workspaceId!==store.workspaceId||capabilities.registrationDigest!==facts.policy.owner.registrationDigest)reject('QUALIFICATION_OWNER_CHANGED','Exact published Harness registration required');
    return owner;
  }
  async function current(selection:QualificationSelection,actor:Principal,signal:AbortSignal) {
    validateSelection(selection);authorize(actor,selection.scope.projectId,'read');signal.throwIfAborted();
    if(selection.scope.workspaceId!==store.workspaceId)reject('QUALIFICATION_SCOPE_CHANGED','Qualification must use this service workspace',403);
    const facts=immutableCorrection(await bindings.read(selection,actor,signal));qualificationFacts(selection,facts,Date.now());
    const owner=registeredOwner(facts);
    const pkg=await owner.readPackage(actor,selection.scope.projectId,facts.policy.owner.scope,facts.policy.owner.reference);
    if(!sameQualification(nativeInventory(record(pkg.package),'harness'),facts.policy.owner.criteria))reject('QUALIFICATION_CRITERIA_CHANGED','Every published policy criterion and actual-observation variant is required');
    signal.throwIfAborted();return{facts,owner};
  }
  const service:NativeQualificationService={
    async inspectExecution(projectId,captureRef,actor,signal){
      authorize(actor,projectId,'read');signal.throwIfAborted();
      if(!bindings.readExecution||!bindings.authorizeExecution)reject('QUALIFICATION_EXECUTION_REQUIRED','No registered current execution producer is available',409);
      const output=immutableCorrection(await bindings.readExecution(projectId,boundedText(captureRef),actor,signal));
      if(output.schema!=='runtime-current-execution-capture/v2'||output.captureRef!==captureRef||output.scope.workspaceId!==store.workspaceId||output.scope.projectId!==projectId||output.mode!=='EXECUTED'||output.outcome!=='PASS'||output.formalAcceptanceEligible!==true)reject('QUALIFICATION_EXECUTION_REQUIRED','Exact current registered execution capture required',409);
      const {captureDigest,...body}=output;if(valueDigest(body)!==captureDigest)reject('QUALIFICATION_EXECUTION_CHANGED','Execution capture integrity changed',409);
      executions.set(output,{id:actor.id,revision:actor.revision});service.assertExecutionCurrent(projectId,output,actor,signal);return output;
    },
    assertExecutionCurrent(projectId,capture,actor,signal){
      signal.throwIfAborted();const proof=executions.get(capture);
      if(!proof||proof.id!==actor.id||proof.revision!==actor.revision||capture.scope.projectId!==projectId||!bindings.authorizeExecution)reject('QUALIFICATION_INSPECTION_REQUIRED','Reinspect the original execution through this service',409);
      const fresh=bindings.authorizeExecution(projectId,capture,actor);authorize(fresh,projectId,'read');
      if(fresh.id!==proof.id||fresh.revision!==proof.revision||correctionTime(capture.expiresAt)<=Date.now())reject('QUALIFICATION_EXECUTION_CHANGED','Execution, observer or validity changed',409);signal.throwIfAborted();
    },
    async prepare(raw,actor,signal,mutation){
      const selection=immutableCorrection(raw);authorize(actor,selection.scope.projectId,'execution.request');const{facts,owner}=await current(selection,actor,signal),id=facts.assessmentAuthority.requestId;
      const prior=store.object(selection.scope.projectId,kind,id);if(prior){const a=load(selection.scope.projectId,id,actor);if(!sameQualification(a.selection,selection)||!sameQualification(a.facts,facts))reject('QUALIFICATION_ACTION_CHANGED','Use the exact original assessment request');retain(selection.scope.projectId,id,a,actor,mutation);return{actionRef:id,actionDigest:a.digest,requestDigest:a.action.requestDigest,authorityRef:facts.assessmentAuthority.authorityRef,expiresAt:a.expiresAt};}
      const assessedAt=new Date().toISOString(),expiresAt=new Date(qualificationFacts(selection,facts,Date.now())).toISOString(),observation=policyObservation(selection,facts,assessedAt),p=facts.policy;
      const state=record(await owner.read(actor,selection.scope.projectId,{operation:'workspace.inspect',scope:p.owner.scope,input:{}}));if(!Number.isSafeInteger(state.revision)||Number(state.revision)<0)reject('QUALIFICATION_OWNER_REVISION','Current owner revision required');
      const context:NativeValidationContext={workspaceId:store.workspaceId,scope:p.owner.scope,projectCandidateDigest:selection.currentCandidateDigest,claimId:id,inputDigest:valueDigest(facts.input),effectiveConfigDigest:p.effectiveConfigDigest,sourceScopeDigest:valueDigest(selection.scope),requirementSetDigest:p.caseInventoryDigest};
      const request={operation:'native.package.validate',scope:p.owner.scope,input:{id:p.owner.reference.id,version:p.owner.reference.version,context,observation},requestId:id,expectedRevision:Number(state.revision)};
      const actionBody={request,requestDigest:ownerRequestDigest('harness',request),context,observationDigest:nativeSha256(observation)},action={...actionBody,digest:valueDigest(actionBody)};
      const body={schema:'runtime-native-qualification-action/v2' as const,selection,facts,factsDigest:valueDigest(facts),action,assessedAt,expiresAt},a={...body,digest:valueDigest(body)};
      signal.throwIfAborted();retain(selection.scope.projectId,id,a,actor,mutation);return{actionRef:id,actionDigest:a.digest,requestDigest:action.requestDigest,authorityRef:facts.assessmentAuthority.authorityRef,expiresAt};
    },
    async dispatch(projectId,ref,actor,signal,mutation){
      const a=load(projectId,ref,actor);authorize(actor,projectId,'execution.request');signal.throwIfAborted();
      const marker='dispatch:'+ref;if(store.object(projectId,kind,marker))reject('QUALIFICATION_OBSERVE_ORIGINAL','Original dispatch may have happened; inspect its exact native receipt without redispatch',409);
      await current(a.selection,actor,signal);
      const subject=immutableCorrection({projectId,actionRef:ref,actionDigest:a.digest,requestDigest:a.action.requestDigest,authorityRef:a.facts.assessmentAuthority.authorityRef,authorityDigest:a.facts.assessmentAuthority.authorityDigest,expiresAt:a.expiresAt});
      async function freshFacts() {
        signal.throwIfAborted();
        const facts=immutableCorrection(await bindings.read(a.selection,actor,signal));qualificationFacts(a.selection,facts,Date.now());
        if(!sameQualification(facts,a.facts))reject('QUALIFICATION_AUTHORITY_CHANGED','Protected authority or original evidence changed before dispatch',409);
        signal.throwIfAborted();return facts;
      }
      function authorizeBoundary(facts:ProtectedQualificationFacts) {
        signal.throwIfAborted();
        qualificationFacts(a.selection,facts,Date.now());
        if(typeof bindings.authorizeDispatch!=='function')reject('QUALIFICATION_AUTHORITY_UNAVAILABLE','Trusted current assessment authorization reader is required',409);
        const authorization=bindings.authorizeDispatch(subject,actor),fresh=authorization.actor,permit=authorization.permit;
        authorize(fresh,projectId,'read');authorize(fresh,projectId,'execution.request');
        if(fresh.id!==actor.id||fresh.revision!==actor.revision||permit.projectId!==projectId||permit.owner!=='harness'||permit.requestDigest!==a.action.requestDigest||permit.authorityRef!==facts.assessmentAuthority.authorityRef||permit.expiresAt!==a.expiresAt||correctionTime(permit.expiresAt)<=Date.now())reject('QUALIFICATION_AUTHORITY_CHANGED','Current exact principal, assessment grant and expiry required',409);
        const owner=registeredOwner(facts);signal.throwIfAborted();return{actor:fresh,permit,owner};
      }
      const beforeMarker=authorizeBoundary(await freshFacts());signal.throwIfAborted();
      if(store.object(projectId,kind,marker))reject('QUALIFICATION_OBSERVE_ORIGINAL','Original dispatch may have happened; inspect its exact native receipt without redispatch',409);
      // Commit before external mutation. Timeout or interruption never creates a
      // second owner request or silently extends its original authority.
      retain(projectId,marker,{actionRef:ref,actionDigest:a.digest,requestDigest:a.action.requestDigest},beforeMarker.actor,mutation);
      const final=authorizeBoundary(await freshFacts());signal.throwIfAborted();await final.owner.mutate(final.actor,projectId,a.action.request,final.permit);
    },
    async inspect(projectId,ref,actor,signal){
      const observer={id:actor.id,revision:actor.revision};
      const a=load(projectId,ref,actor),{facts,owner}=await current(a.selection,actor,signal);
      if(!sameQualification(facts,a.facts)||!sameQualification(a.action.request.input.observation,policyObservation(a.selection,facts,a.assessedAt)))reject('QUALIFICATION_FACTS_CHANGED','Reassess changed provenance, closure, history, trust or policy',409);
      if(!store.object(projectId,kind,'dispatch:'+ref))reject('QUALIFICATION_NOT_DISPATCHED','Actual separately authorized native assessment is required',409);
      const receipt=record(await owner.read(actor,projectId,{operation:'native.receipt.inspect',scope:facts.policy.owner.scope,input:{requestId:a.action.request.requestId}}));
      const result=verifyNativeStageResult(receipt,'harness',facts.policy.owner,a.action,facts.policy.toolchainLockDigest,facts.policy.effectiveConfigDigest);
      // Re-read protected state after the owner read, closing async revocation,
      // history extension and dependency changes during qualification.
      const fresh=await current(a.selection,actor,signal);if(!sameQualification(fresh.facts,facts))reject('QUALIFICATION_FACTS_CHANGED','Protected evidence changed during native readback',409);
      const assessment:HarnessQualificationAssessment={schema:'runtime-harness-qualification-assessment/v1',owner:'harness',subjectDigest:valueDigest(facts.input),policy:{id:facts.policy.owner.reference.id,version:facts.policy.owner.reference.version,digest:facts.policy.owner.reference.digest,publishedReceiptRef:facts.policy.publishedReceiptRef},assessmentReceiptRef:'native.receipt:'+a.action.request.requestId,trustRevision:facts.policy.trust.revision,assessedAt:a.assessedAt,expiresAt:a.expiresAt,verdict:result.status,executionRequirement:facts.policy.requirement.executionRequirement==='ALWAYS_MUST_EXECUTE'?'MUST_EXECUTE':'REUSE_PERMITTED'};
      const qualified=await qualifyEvidence(facts.input,{verify:async()=>assessment},Date.now(),signal);
      // current() itself awaits owner package readback, and qualification also
      // yields. Therefore its earlier facts cannot be the final current check.
      // Read complete protected facts after every owner/qualification await,
      // then finish with a synchronous credential/grant/trust boundary only.
      const finalFacts=immutableCorrection(await bindings.read(a.selection,actor,signal));
      qualificationFacts(a.selection,finalFacts,Date.now());
      if(!sameQualification(finalFacts,facts))reject('QUALIFICATION_FACTS_CHANGED','Protected authority, trust or evidence changed during final owner readback',409);
      const subject=immutableCorrection({projectId,actionRef:ref,actionDigest:a.digest,requestDigest:a.action.requestDigest,authorityRef:finalFacts.assessmentAuthority.authorityRef,authorityDigest:finalFacts.assessmentAuthority.authorityDigest,expiresAt:a.expiresAt,selection:a.selection,protectedFactsDigest:a.factsDigest,ownerRegistrationDigest:finalFacts.policy.owner.registrationDigest,trustRevision:finalFacts.policy.trust.revision,historyWatermark:finalFacts.history.watermark});
      const output:NativeEvidenceQualification=immutableCorrection({...qualified,schema:'runtime-evidence-qualification/v2',phase:a.selection.phase,actionRef:ref,actionDigest:a.digest,protectedFactsDigest:a.factsDigest,originalReceiptRef:facts.original.receiptRef,originalRawBytesRef:facts.original.rawBytesRef,historyWatermark:facts.history.watermark,nativeReceiptDigest:result.receiptDigest,nativeReportDigest:result.reportDigest,releaseAuthorized:false,formalAcceptanceEligible:facts.formalAcceptanceEligible});
      inspections.set(output,{subject,observer});service.assertCurrent(projectId,output,actor,signal);return output;
    },
    assertCurrent(projectId,qualification,actor,signal){
      signal.throwIfAborted();const proof=inspections.get(qualification);
      if(!proof||proof.subject.projectId!==projectId||proof.observer.id!==actor.id||proof.observer.revision!==actor.revision)reject('QUALIFICATION_INSPECTION_REQUIRED','Reinspect through this native service before consuming a saved or foreign qualification',409);
      const a=load(projectId,proof.subject.actionRef,actor);
      if(a.digest!==proof.subject.actionDigest||a.factsDigest!==proof.subject.protectedFactsDigest)reject('QUALIFICATION_FACTS_CHANGED','Original assessment binding changed',409);
      if(typeof bindings.authorizeInspect!=='function')reject('QUALIFICATION_READ_AUTHORITY_UNAVAILABLE','Trusted synchronous current read authorization is required',409);
      const principal=bindings.authorizeInspect(proof.subject,actor);authorize(principal,projectId,'read');
      if(principal.id!==proof.observer.id||principal.revision!==proof.observer.revision)reject('QUALIFICATION_READ_AUTHORITY_CHANGED','Current observer identity or credential revision changed',403);
      qualificationFacts(a.selection,a.facts,Date.now());registeredOwner(a.facts);signal.throwIfAborted();
      if(qualification.status==='QUALIFIED'&&(!qualification.expiresAt||correctionTime(qualification.expiresAt)<=Date.now()))reject('QUALIFICATION_EXPIRED','Qualification expired before final consumption',409);
    },
  };
  nativeServices.add(service);return Object.freeze(service);
}

export interface ClosedFixtureQualificationConfiguration {
  scope:EvidenceScope;caseId:string;fixtureRoot:string;
  /** Fixed subordinate LC20 fixture only; it never gains formal case credit. */
  lc20Child?:typeof LC20_CHILDREN[number];
  /** Operator-installed current published policy/trust reader. A configured
   * native asset still needs real publication and semantic approval at use. */
  policy(actor:Principal,signal:AbortSignal):Promise<ProtectedQualificationFacts['policy']>;
  authority(actor:Principal,selection:QualificationSelection,signal:AbortSignal):Promise<ProtectedQualificationFacts['assessmentAuthority']>;
}
interface ClosedFixtureAttempt {
  requestId:string;candidateDigest:string;startedAt:string;expiresAt:string;
  original:QualificationInput['original']|null;inputs:EvidenceInputManifest|null;rawReceipt:string|null;
}
/** Fixed deterministic evaluator. It cannot import code, dispatch commands,
 * observe services, or interpret a caller-defined test. Its oracle and complete
 * input are the two original files; changing either invalidates reuse. */
function closedFixtureEvaluate(input:string,expected:string):{actualDigest:string;expectedDigest:string;outcome:'PASS'|'FAIL'} {
  let nodes=0;
  function normalize(value:unknown,depth=0):unknown {
    if(++nodes>8192||depth>32)throw Error('Closed JSON fixture exceeds its fixed bound');
    if(value===null||typeof value!=='object')return value;
    if(Array.isArray(value))return value.map(v=>normalize(v,depth+1));
    const output:Record<string,unknown>=Object.create(null) as Record<string,unknown>;
    for(const key of Object.keys(value).sort())output[key]=normalize((value as Record<string,unknown>)[key],depth+1);
    return output;
  }
  const oracle=JSON.parse(expected) as {canonicalDigest?:unknown};
  if(!oracle||typeof oracle!=='object'||Array.isArray(oracle)||Object.keys(oracle).length!==1||typeof oracle.canonicalDigest!=='string'||!/^sha256:[a-f0-9]{64}$/.test(oracle.canonicalDigest))throw Error('Exact closed fixture oracle required');
  const actualDigest='sha256:'+createHash('sha256').update(JSON.stringify(normalize(JSON.parse(input) as unknown))).digest('hex'),expectedDigest=oracle.canonicalDigest;
  return{actualDigest,expectedDigest,outcome:actualDigest===expectedDigest?'PASS':'FAIL'};
}
export const LC20_FIXTURE_GRAPH=Object.freeze({a:[],b:['a'],c:['b'],d:[],e:['d'],f:[]} as const);
/** Finite test fixture protocol, not a general program or execution API. */
function lc20FixtureInput(root:string,child:typeof LC20_CHILDREN[number]) {
  const expectedFiles=['a.json','d.json','f.json','graph.json','unrelated.txt',...LC20_CHILDREN.map(id=>'expected-'+id+'.json')].sort();
  if(!sameQualification(readdirSync(root).sort(),expectedFiles))reject('QUALIFICATION_FIXTURE_INVENTORY','LC20 requires its exact fixed subordinate file set',409);
  const graphText=closedFixtureFile(join(root,'graph.json'),4096).toString('utf8'),graph=JSON.parse(graphText),complete=sameQualification(graph,LC20_FIXTURE_GRAPH);
  const leaf=['a','b','c'].includes(child)?'a':['d','e'].includes(child)?'d':'f',bytes=closedFixtureFile(join(root,leaf+'.json'),1024),v=record(JSON.parse(bytes.toString('utf8')));exact(v,['value']);
  if(!Number.isSafeInteger(v.value)||Math.abs(Number(v.value))>1000000)reject('QUALIFICATION_FIXTURE_INPUT','Fixed bounded integer fixture input required',409);
  const value=Number(v.value)+(child==='b'||child==='e'?1:child==='c'?2:0),input=canonical({value}),expected=closedFixtureFile(join(root,'expected-'+child+'.json'),1024).toString('utf8');
  return{input,expected,complete,leafDigest:byteDigest(bytes),graphDigest:byteDigest(graphText),child};
}
function closedFixtureFile(path:string,limit:number,privateRequired=true):Buffer {
  if(!isAbsolute(path)||resolve(path)!==path||realpathSync(path)!==path)reject('QUALIFICATION_FIXTURE_PATH','Use canonical fixture paths without links');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const before=fstatSync(fd);if(!before.isFile()||before.nlink!==1||before.size>limit||(privateRequired&&(before.uid!==process.getuid?.()||(before.mode&0o077)!==0)))reject('QUALIFICATION_FIXTURE_FILE','Private bounded original fixture bytes required');
    const bytes=readFileSync(fd),after=fstatSync(fd);if(before.size!==bytes.length||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)reject('QUALIFICATION_FIXTURE_CHANGED','Fixture changed during collection');return bytes;
  }finally{closeSync(fd);}
}
/** Concrete closed producer for exercising the qualification protocol. It never
 * claims a real E/UT/LC case was executed: formalAcceptanceEligible is always
 * false. Existing live-state collectors cannot import/upgrade their old PASSs
 * through it. Their unknown external dependencies continue to require execution. */
export function createClosedFixtureQualificationProducer(store:RuntimeStore,config:ClosedFixtureQualificationConfiguration) {
  scope(config.scope);boundedText(config.caseId);if(config.scope.workspaceId!==store.workspaceId)reject('QUALIFICATION_SCOPE_CHANGED','Closed fixture must belong to this workspace');
  if(config.lc20Child!==undefined&&(config.caseId!=='LC20'||!LC20_CHILDREN.includes(config.lc20Child)))reject('QUALIFICATION_FIXTURE_INPUT','LC20 child protocol cannot stand for another case');
  const kind='lifecycle-evidence-qualification',key='closed-fixture:'+valueDigest({scope:config.scope,caseId:config.caseId,...(config.lc20Child?{lc20Child:config.lc20Child}:{})}),projectId=config.scope.projectId;
  function ledger():ClosedFixtureAttempt[]{const value=store.object(projectId,kind,key);if(value===null)return[];const r=record(value);if(r.schema!=='runtime-closed-fixture-history/v2'||!Array.isArray(r.attempts)||r.attempts.length>4096)reject('QUALIFICATION_HISTORY_CHANGED','Complete closed producer history unavailable');return r.attempts as ClosedFixtureAttempt[];}
  function save(attempts:ClosedFixtureAttempt[],actor:Principal,mutation?:QualificationMutationContext):void {
    const value={schema:'runtime-closed-fixture-history/v2',attempts};store.mutate(actor,{projectId,...(mutation??{operation:'lifecycle.qualification.fixture.execute',requestId:'fixture-'+randomUUID(),expectedRevision:store.revision(projectId),input:{historyDigest:valueDigest(value)}}),permission:'execution.request'},()=>({objects:[{kind,id:key,value}],value:{historyRef:key,historyDigest:valueDigest(value),formalCaseCredit:0},event:{type:'closed-fixture-execution',data:{historyDigest:valueDigest(value),formalCaseCredit:0}}}),mutation?.reauthorize);
  }
  function inventory(candidateDigest:string,p:ProtectedQualificationFacts['policy']):{manifest:EvidenceInputManifest;input:string;expected:string} {
    const lc20=config.lc20Child?lc20FixtureInput(config.fixtureRoot,config.lc20Child):null;
    if(!lc20&&!sameQualification(readdirSync(config.fixtureRoot).sort(),['expected.json','input.json']))reject('QUALIFICATION_FIXTURE_INVENTORY','Closed fixture contains exactly input.json and expected.json');
    const input=lc20?.input??closedFixtureFile(join(config.fixtureRoot,'input.json'),32768).toString('utf8'),expected=lc20?.expected??closedFixtureFile(join(config.fixtureRoot,'expected.json'),1024).toString('utf8');
    const evaluator={evaluate:closedFixtureEvaluate.toString(),canonical:canonical.toString(),digest:valueDigest.toString(),record:record.toString(),exact:exact.toString(),correctionDigest:correctionDigest.toString(),string:string.toString(),reject:reject.toString()};
    const executable=byteDigest(closedFixtureFile(realpathSync(process.execPath),268435456,false)),source=valueDigest(lc20?{...evaluator,lc20:lc20FixtureInput.toString()}:evaluator),fixture=lc20?valueDigest({input:byteDigest(input),leaf:lc20.leafDigest,graph:lc20.graphDigest}):byteDigest(input),assertion=byteDigest(expected);
    const values:Record<(typeof EVIDENCE_INPUT_KINDS)[number],string>={source,test:valueDigest({operation:'CANONICAL_JSON_DIGEST_EQUALS',version:1}),assertion,generated:source,build:valueDigest({evaluator:source,node:process.version}),lock:executable,toolchain:valueDigest({executable,versions:process.versions}),config:valueDigest({scope:config.scope,caseId:config.caseId,operation:'CLOSED_FIXTURE_ONLY',formalCaseCredit:0}),environment:valueDigest({platform:process.platform,arch:process.arch,osRelease:osRelease()}),collector:source,fixture,prestate:valueDigest({state:'PURE_NO_EXTERNAL_STATE',version:1}),policy:p.owner.reference.digest,ttl:p.validityContractDigest};
    const nodes=EVIDENCE_INPUT_KINDS.map(id=>({id,kind:id,digest:values[id],dependsOn:id==='test'?EVIDENCE_INPUT_KINDS.filter(k=>k!=='test'):[]}));
    return{manifest:{schema:'runtime-evidence-input-manifest/v1',candidateDigest,completeness:lc20&&!lc20.complete?'UNKNOWN':'COMPLETE',dynamicInputs:'RESOLVED',externalInputs:'RESOLVED',roots:['test'],nodes,notApplicable:[]},input,expected};
  }
  function snapshot(selection:Readonly<QualificationSelection>,actor:Principal,policy:ProtectedQualificationFacts['policy'],assessmentAuthority:ProtectedQualificationFacts['assessmentAuthority']):ProtectedQualificationFacts {
    validateSelection(selection);authorize(actor,projectId,'read');if(!sameQualification(selection.scope,config.scope)||selection.caseId!==config.caseId)reject('QUALIFICATION_SCOPE_CHANGED','Closed producer scope differs');
    const attempts=ledger(),a=attempts.find(a=>a.original&&valueDigest(a.original)===selection.originalExecutionDigest);
    if(!a?.original||!a.inputs||!a.rawReceipt)reject('QUALIFICATION_ORIGINAL_UNAVAILABLE','Original actual fixture execution is missing');
    const current=inventory(selection.currentCandidateDigest,policy),history=attempts.map(h=>h.original?{executionDigest:valueDigest(h.original),candidateDigest:h.candidateDigest,rawReceiptDigest:h.original.rawReceiptDigest,outcome:h.original.outcome,executedAt:h.startedAt}:{executionDigest:valueDigest(h),candidateDigest:h.candidateDigest,rawReceiptDigest:valueDigest({requestId:h.requestId,outcome:'UNKNOWN'}),outcome:'UNKNOWN' as const,executedAt:h.startedAt});
    const input:QualificationInput={schema:'runtime-evidence-qualification-input/v1',scope:config.scope,caseId:config.caseId,currentCandidateDigest:selection.currentCandidateDigest,original:a.original,originalExecutionDigest:selection.originalExecutionDigest,rawReceipt:a.rawReceipt,originalInputs:a.inputs,currentInputs:current.manifest,history,executionRule:policy.requirement.executionRequirement==='ALWAYS_MUST_EXECUTE'?'MUST_EXECUTE':'OWNER_POLICY'};
    if(!sameQualification(ledger(),attempts))reject('QUALIFICATION_HISTORY_CHANGED','History changed during protected read');
    const originalRef='runtime:closed-fixture/'+a.requestId,historyRef='runtime:closed-fixture-history/'+key;
    return{schema:'runtime-protected-qualification-facts/v2',input,formalAcceptanceEligible:false,original:{receiptRef:originalRef,rawBytesRef:originalRef+'/raw',revision:a.requestId,readbackDigest:valueDigest(a)},history:{receiptRef:historyRef,watermark:valueDigest(attempts)},inventories:{original:{receiptRef:originalRef+'/inputs',revision:valueDigest(a.inputs)},current:{receiptRef:historyRef+'/current-inputs',revision:valueDigest(current.manifest)}},policy,validity:{receiptRef:historyRef+'/validity',revision:valueDigest({expiresAt:a.expiresAt,trust:policy.trust}),recordDigest:valueDigest({expiresAt:a.expiresAt,trust:policy.trust}),originalPolicy:null,originalPolicyApplicability:'VERIFIED_NOT_APPLICABLE'},assessmentAuthority};
  }
  return Object.freeze({
    snapshot,
    history(actor:Principal){authorize(actor,projectId,'read');return immutableCorrection(ledger());},
    async execute(candidateDigest:string,requestId:string,expiresAt:string,actor:Principal,signal:AbortSignal,mutation?:QualificationMutationContext) {
      authorize(actor,projectId,'execution.request');correctionDigest(candidateDigest);boundedText(requestId);if(correctionTime(expiresAt)<=Date.now())reject('QUALIFICATION_EXPIRED','Use the original explicit fixture execution deadline');
      const policy=await config.policy(actor,signal);signal.throwIfAborted();const history=ledger();if(history.some(a=>a.requestId===requestId))reject('QUALIFICATION_OBSERVE_ORIGINAL','An existing fixture attempt cannot be rerun under the same identity',409);if(history.length>=4096)reject('QUALIFICATION_HISTORY_LIMIT','The complete history reached its fixed bound');
      const attempt:ClosedFixtureAttempt={requestId,candidateDigest,startedAt:new Date().toISOString(),expiresAt,original:null,inputs:null,rawReceipt:null};history.push(attempt);save(history,actor,mutation);
      // The start is durable before touching the oracle. Interrupted/malformed
      // attempts remain visible as UNKNOWN; they can never disappear on retry.
      try{const captured=inventory(candidateDigest,policy),result=closedFixtureEvaluate(captured.input,captured.expected);signal.throwIfAborted();const current=inventory(candidateDigest,policy);if(!sameQualification(captured,current))reject('QUALIFICATION_FIXTURE_CHANGED','Inputs changed during actual execution');
        const rawReceipt=canonical({schema:'runtime-closed-fixture-execution/v2',requestId,candidateDigest,scope:config.scope,caseId:config.caseId,startedAt:attempt.startedAt,completedAt:new Date().toISOString(),inputManifestDigest:valueDigest(captured.manifest),result,formalCaseCredit:0});
        const original:QualificationInput['original']={schema:'runtime-original-evidence-execution/v1',mode:'EXECUTED',scope:config.scope,caseId:config.caseId,runId:requestId,candidateDigest,inputManifestDigest:valueDigest(captured.manifest),rawReceiptDigest:byteDigest(rawReceipt),outcome:result.outcome,executedAt:attempt.startedAt,expiresAt};
        Object.assign(attempt,{original,inputs:captured.manifest,rawReceipt});save(history,actor);return immutableCorrection({original,originalExecutionDigest:valueDigest(original),formalCaseCredit:0});
      }catch(error){save(history,actor);throw error;}
    },
    async read(selection:Readonly<QualificationSelection>,actor:Principal,signal:AbortSignal):Promise<ProtectedQualificationFacts> {
      const policy=await config.policy(actor,signal),authority=await config.authority(actor,selection,signal);signal.throwIfAborted();return snapshot(selection,actor,policy,authority);
    },
  });
}
