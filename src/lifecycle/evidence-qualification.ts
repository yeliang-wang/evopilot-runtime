import { exact, record, reject, string } from '../server/errors.js';
import { byteDigest, valueDigest } from './base.js';
import {
  EVIDENCE_INPUT_KINDS, correctionDigest, correctionEnum, correctionTime, immutableCorrection,
  type EvidenceInputManifest, type EvidenceQualification, type EvidenceScope,
  type HarnessQualificationAssessment, type QualificationInput, type TrustedQualificationVerifier,
} from './correction-contract.js';

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
