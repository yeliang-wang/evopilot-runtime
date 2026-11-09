import { verifyDecisionEvidence, type DecisionSubject } from '../../vendor/compatibility/v1/decision-evidence.mjs';
import { canonical, evidenceValueDigest, exact, record, reject, slug, string } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import { RuntimeStore, type Receipt, type StoredObject } from '../server/store.js';
import { valueDigest } from '../lifecycle/base.js';
import { atPath, bindingPattern, containsInlineSecret, type EffectiveDefinition } from '../lifecycle/compiler.js';
import { inspectInstance, pinInstance, requiredChecksDigest, stageBudget, type RecoveryLineageService, type RecoveryFailureOrigin, type Budget, type AuthorityResolver, type ExecutionAuthority, type LifecycleInstance, type ReleaseAuthority } from '../lifecycle/instance.js';
import { readIntegrationConfiguration } from './config.js';
import { validateResourceDefinition } from './bindings.js';
import { isPreparationRef, readPreparationPacket, type PreparationVerifier } from '../lifecycle/preparation.js';
import type { StageRequest, StageProgress } from '../lifecycle/execution.js';
import { readReleaseMaterial, releasePredecessors, type ReleaseMaterial } from './release-stages.js';

export const AUTHORITY_READS=['lifecycle.authority.preview','lifecycle.authority.inspect'] as const;
export const AUTHORITY_WRITES=['lifecycle.authority.record','lifecycle.authority.revoke'] as const;
export interface AuthorityPolicy { digest:string; bindingContextDigest:string; principalIds:readonly string[]; expiresAt:string; }
export type AuthorityPolicyProvider=(definition:EffectiveDefinition,actor:Principal)=>AuthorityPolicy;
export type PrincipalLookup=(id:string)=>Principal|null;
type Kind='execution'|'release';
type Choice='APPROVE'|'REJECT';
interface RecoveryIdentity {goalRef:string;loopRef:string;target:{kind:'preparation';id:string;version:string}|{kind:'opaque';ref:string};}
interface NativeRecoveryRoot {
  schema:'runtime-recovery-lineage-root/v1';ref:string;workspaceId:string;projectId:string;
  identity:RecoveryIdentity;identityDigest:string;originalTargetRef:string;originalInstanceId:string;
  originalAuthorityRef:string;originalAuthorityDigest:string;originalPinsDigest:string;
  createdAt:string;deadlineAt:string;graphDigest:string;requirementsDigest:string;budget:Budget;
  stageBudgets:Record<string,Budget>;digest:string;
}
interface RecoveryAttempt {instanceId:string;stageId:string;requestId:string;requestDigest:string;deadlineAt:string;}
interface RecoveryAttempts {schema:'runtime-recovery-attempts/v1';rootRef:string;rootDigest:string;entries:RecoveryAttempt[];digest:string;}
const RECOVERY_KIND='lifecycle-recovery-ledger';
const recoveryReference=(v:unknown):string=>{const s=string(v,128);if(!/^recovery-root:sha256:[a-f0-9]{64}$/.test(s))reject('INVALID_RECOVERY_ROOT','Exact native recovery root reference required');return s;};
export interface NativeRepairSelection {
  schema:'runtime-repair-selection/v1'|'runtime-repair-selection/v2';rootRef:string;rootDigest:string;
  originalRequestId:string;originalRequestDigest:string;originalObservationRef:string;
  originalInstanceId:string;originalStageId:string;deadlineAt:string;
  verificationInstanceId:string;verificationStageId:string;verificationPinsDigest:string;verificationNodeDigest:string;
  origins?:RecoveryFailureOrigin[];originsDigest?:string;
}
export interface NativeRepairCapture extends Omit<NativeRepairSelection,'schema'> {
  schema:'runtime-repair-capture/v1'|'runtime-repair-capture/v2';workspaceId:string;projectId:string;correctionRef:string;
  verificationRequestId:string;verificationRequestDigest:string;verificationPlanDigest:string;
  expectedNativeRequestId:string;boundAt:string;
  inputs:{originalPlanDigest:string;verificationPlanDigest:string;completeInputClosure:false};
  comparison?:{policyDigest:string;expectedRequestId:string};
  digest:string;
}
export interface NativeRepairRound {
  schema:'runtime-repair-round/v1'|'runtime-repair-round/v2';rootRef:string;rootDigest:string;captureDigest:string;
  requestId:string;requestDigest:string;observationRef:string;observedAt:string;completedRevision:number;outcome:'PASS'|'FAIL';
  nativeActionDigest:string|null;nativeRequestId:string;nativeReceiptDigest:string|null;nativeReportDigest:string|null;nativeEvidenceRef:string|null;
  repairVerified:false;digest:string;
  candidateEvidence?:{ci:Record<string,unknown>|null;product:Record<string,unknown>|null;comparison:Record<string,unknown>|null;candidate:Record<string,unknown>|null;comparisonUnavailable?:{reason:string;digest:string}};
}
export function readRecoveryFailureOrigins(store:RuntimeStore,projectId:string,instanceId:string,stageId:string,excluding?:string):RecoveryFailureOrigin[]{
  const root=nativeRepairRoot(store,projectId,instanceId),ledger=record(store.object(projectId,RECOVERY_KIND,'attempts:'+root.rootRef)),{digest,...body}=ledger;
  if(ledger.schema!=='runtime-recovery-attempts/v1'||digest!==valueDigest(body)||ledger.rootRef!==root.rootRef||ledger.rootDigest!==root.rootDigest||!Array.isArray(ledger.entries)||ledger.entries.length>4096)reject('CORRUPT_REPAIR_HISTORY','Complete bounded native root history is required',503);
  const result:RecoveryFailureOrigin[]=[];
  for(const item of ledger.entries){const entry=record(item);if(entry.stageId!==stageId||entry.requestId===excluding)continue;const r=repairRequest(store,projectId,string(entry.requestId)),member=nativeRepairRoot(store,projectId,r.instanceId),p=store.object(projectId,'stage-progress',r.id) as StageProgress|null;
    if(member.rootRef!==root.rootRef||r.digest!==entry.requestDigest||r.instanceId!==entry.instanceId||r.deadlineAt!==entry.deadlineAt||!p)reject('CORRUPT_REPAIR_HISTORY','Root failure lost its original request',503);
    if(p.phase==='COMPLETE')continue;if(p.phase!=='FAILED'||p.terminal!==true)reject('RECONCILE_ORIGINAL_REQUEST','Unresolved same-stage originals permit only observation',409);
    const envelope=record(store.object(projectId,'stage-observation',String(p.observationRef)));
    if(valueDigest(envelope)!==p.observationRef||envelope.schema!=='runtime-stage-observation/v1'||envelope.requestId!==r.id||envelope.reason!==p.reason||envelope.observedAt!==p.observedAt||canonical(envelope.observation)!==canonical(p.observation)||p.observation?.phase!=='FAILED'||p.observation.outcome.status!=='FAILED'||p.observation.requestId!==r.id||p.observation.inputDigest!==r.inputDigest||p.observation.adapterDigest!==r.plan.adapterDigest)reject('CORRUPT_REPAIR_HISTORY','Root failure differs from the immutable terminal observation',503);
    result.push({request:r,progress:p,candidateDigest:member.saved.candidateDigest,pinsDigest:member.saved.pinsDigest,authorityRef:r.authorityRef});
  }
  return result.sort((a,b)=>a.request.id<b.request.id?-1:a.request.id>b.request.id?1:0);
}
function repairRequest(store:RuntimeStore,projectId:string,id:string):StageRequest{
  const r=store.object(projectId,'stage-request',id) as StageRequest|null;if(!r)reject('REPAIR_ORIGINAL_REQUIRED','Original stage request is missing',409);
  const{digest,...body}=r;if(r.schema!=='runtime-stage-request/v1'||r.id!==id||r.projectId!==projectId||r.workspaceId!==store.workspaceId||digest!==valueDigest(body)||r.planDigest!==valueDigest(r.plan))reject('CORRUPT_REPAIR_CAPTURE','Original request identity changed',503);return r;
}
/** Historical native membership only. Live authority and budgets are checked by
 * recovery.admission/claim/permit; this reader cannot grant execution. */
export function nativeRepairRoot(store:RuntimeStore,projectId:string,instanceId:string){
  const saved=inspectInstance(record(store.object(projectId,'lifecycle-instance',instanceId)) as unknown as LifecycleInstance),binding=record(store.object(projectId,'instance-authority',instanceId));
  if(saved.id!==instanceId||saved.pins.projectId!==projectId||typeof binding.recoveryRootRef!=='string')reject('REPAIR_NATIVE_ROOT_REQUIRED','Repair capture requires existing native recovery membership',409);
  const root=record(store.object(projectId,RECOVERY_KIND,binding.recoveryRootRef)),member=record(store.object(projectId,RECOVERY_KIND,'member:'+instanceId)),{digest,...body}=root;
  const d=record(store.object(projectId,'authority-decision',string(binding.evidenceRef))),{ref,...decisionBody}=d,subject=record(d.subject);
  if(root.schema!=='runtime-recovery-lineage-root/v1'||root.workspaceId!==store.workspaceId||root.projectId!==projectId||root.ref!==binding.recoveryRootRef||digest!==valueDigest(body)||binding.recoveryRootDigest!==digest||member.schema!=='runtime-recovery-member/v1'||member.rootRef!==root.ref||member.rootDigest!==digest||member.instanceId!==instanceId||member.pinsDigest!==saved.pinsDigest||member.authorityRef!==binding.evidenceRef||d.schema!=='runtime-authority-decision/v1'||d.kind!=='execution'||d.projectId!==projectId||d.workspaceId!==store.workspaceId||ref!==binding.evidenceRef||ref!=='authority:'+valueDigest(decisionBody)||subject.instanceId!==instanceId||instanceId!==root.originalInstanceId&&(subject.recoveryRootRef!==root.ref||subject.recoveryRootDigest!==digest))reject('CORRUPT_REPAIR_CAPTURE','Repair native root membership differs from its original authority',503);
  return{saved,rootRef:string(root.ref),rootDigest:string(digest),deadlineAt:string(root.deadlineAt)};
}
export function selectNativeRepairCapture(store:RuntimeStore,projectId:string,originalId:string,verification:{instanceId:string;stageId:string}):NativeRepairSelection{
  const r=repairRequest(store,projectId,originalId),p=store.object(projectId,'stage-progress',r.id) as StageProgress|null,source=nativeRepairRoot(store,projectId,r.instanceId),target=nativeRepairRoot(store,projectId,verification.instanceId);
  const stage=target.saved.stages[verification.stageId],node=target.saved.definition.nodes.find(n=>n.id===verification.stageId);
  if(source.rootRef!==target.rootRef||source.rootDigest!==target.rootDigest)reject('REPAIR_ROOT_MISMATCH','Original failure and verification must share the same native root',409);
  const candidate=node?.id==='candidate'&&node.source==='base'&&r.stageId==='verification'&&source.saved.id!==target.saved.id;
  if(!node||!candidate&&(node.source!=='project'||!['runtime.check.harness','runtime.check.ontology','runtime.check.artifact'].includes(String(node.action!.actionRef))))reject('REPAIR_VERIFICATION_SCOPE','Select an existing fixed native check or a reviewed successor candidate for verification',409);
  if(!stage||stage.status!=='PENDING'||stage.attempts!==0||stage.requestId!==null)reject('REPAIR_PREBIND_REQUIRED','Verification must be selected before its first request',409);
  if(!p||p.phase!=='FAILED'||p.terminal!==true||!p.observationRef||!p.observation||p.observation.phase!=='FAILED'||p.observation.outcome.status!=='FAILED'||source.saved.stages[r.stageId]?.requestId!==r.id)reject('REPAIR_CONFIRMED_FAILURE_REQUIRED','Select the current confirmed original failure; UNKNOWN permits observation only',409);
  const envelope=record(store.object(projectId,'stage-observation',p.observationRef));
  if(valueDigest(envelope)!==p.observationRef||envelope.schema!=='runtime-stage-observation/v1'||envelope.requestId!==r.id||canonical(envelope.observation)!==canonical(p.observation)||envelope.reason!==p.reason||envelope.observedAt!==p.observedAt||p.observation.requestId!==r.id||p.observation.inputDigest!==r.inputDigest||p.observation.adapterDigest!==r.plan.adapterDigest)reject('CORRUPT_REPAIR_CAPTURE','Original failure differs from its immutable observation',503);
  const origins=candidate?readRecoveryFailureOrigins(store,projectId,r.instanceId,r.stageId):undefined;
  if(origins&&!origins.some(o=>o.request.id===r.id))reject('REPAIR_ORIGINAL_REQUIRED','Selected failure must occur in the complete origin set',409);
  return{schema:candidate?'runtime-repair-selection/v2':'runtime-repair-selection/v1',rootRef:source.rootRef,rootDigest:source.rootDigest,originalRequestId:r.id,originalRequestDigest:r.digest,originalObservationRef:p.observationRef,originalInstanceId:r.instanceId,originalStageId:r.stageId,deadlineAt:new Date(Math.min(Date.parse(r.deadlineAt),Date.parse(source.deadlineAt),Date.parse(target.saved.pins.authorityExpiresAt),...(origins??[]).map(o=>Date.parse(o.request.deadlineAt)))).toISOString(),verificationInstanceId:target.saved.id,verificationStageId:node.id,verificationPinsDigest:target.saved.pinsDigest,verificationNodeDigest:valueDigest(node),...(origins?{origins,originsDigest:valueDigest(origins)}:{})};
}
export function readNativeRepairCapture(store:RuntimeStore,r:StageRequest):NativeRepairCapture|null{
  const raw=store.object(r.projectId,RECOVERY_KIND,'repair-capture:'+r.id);
  if(!r.correctionRef){if(raw)reject('CORRUPT_REPAIR_CAPTURE','A request cannot acquire a correction association after admission',503);return null;}
  if(!raw)reject('REPAIR_CAPTURE_REQUIRED','Associated request has no atomic pre-dispatch capture',409);
  const c=record(raw),{digest,...body}=c,root=nativeRepairRoot(store,r.projectId,r.instanceId),original=repairRequest(store,r.projectId,string(c.originalRequestId)),before=nativeRepairRoot(store,r.projectId,original.instanceId);
  const v2=c.schema==='runtime-repair-capture/v2';
  exact(c,['schema','rootRef','rootDigest','originalRequestId','originalRequestDigest','originalObservationRef','originalInstanceId','originalStageId','deadlineAt','verificationInstanceId','verificationStageId','verificationPinsDigest','verificationNodeDigest','workspaceId','projectId','correctionRef','verificationRequestId','verificationRequestDigest','verificationPlanDigest','expectedNativeRequestId','boundAt','inputs','digest',...(v2?['origins','originsDigest','comparison']:[])]);
  exact(record(c.inputs),['originalPlanDigest','verificationPlanDigest','completeInputClosure']);
  if(record(c.inputs).originalPlanDigest!==original.planDigest||record(c.inputs).verificationPlanDigest!==r.planDigest||!Number.isFinite(Date.parse(String(c.deadlineAt))))reject('CORRUPT_REPAIR_CAPTURE','Original and verification input references changed',503);
  const observation=record(store.object(r.projectId,'stage-observation',string(c.originalObservationRef))),node=root.saved.definition.nodes.find(n=>n.id===r.stageId);
  const expected=v2?'stage-native-'+valueDigest({requestId:r.id,projectId:r.projectId,owner:'harness'}).slice(7,55):'extension-native-'+valueDigest({requestDigest:r.digest}).slice(7,51);
  if(!v2&&c.schema!=='runtime-repair-capture/v1'||c.workspaceId!==r.workspaceId||c.projectId!==r.projectId||digest!==valueDigest(body)||c.correctionRef!==r.correctionRef||c.verificationRequestId!==r.id||c.verificationRequestDigest!==r.digest||c.verificationPlanDigest!==r.planDigest||c.verificationInstanceId!==r.instanceId||c.verificationStageId!==r.stageId||c.verificationPinsDigest!==r.pinsDigest||!node||c.verificationNodeDigest!==valueDigest(node)||root.rootRef!==c.rootRef||root.rootDigest!==c.rootDigest||before.rootRef!==root.rootRef||original.digest!==c.originalRequestDigest||original.instanceId!==c.originalInstanceId||original.stageId!==c.originalStageId||observation.schema!=='runtime-stage-observation/v1'||observation.requestId!==original.id||valueDigest(observation)!==c.originalObservationRef||record(observation.observation).phase!=='FAILED'||c.expectedNativeRequestId!==expected||c.boundAt!==r.requestedAt||Date.parse(r.deadlineAt)>Date.parse(String(c.deadlineAt))||Date.parse(String(c.deadlineAt))>Math.min(Date.parse(original.deadlineAt),Date.parse(root.deadlineAt))||record(c.inputs).completeInputClosure!==false)reject('CORRUPT_REPAIR_CAPTURE','Pre-dispatch repair capture identity changed',503);
  if(v2){const comparison=record(c.comparison);exact(comparison,['policyDigest','expectedRequestId']);
    if(r.stageId!=='candidate'||original.stageId!=='verification'||original.instanceId===r.instanceId||!Array.isArray(c.origins)||!c.origins.length||c.origins.length>4096||c.originsDigest!==valueDigest(c.origins)||!c.origins.some(x=>record(record(x).request).digest===original.digest)||comparison.policyDigest!==valueDigest(record(r.plan.parameters).repairComparison)||comparison.expectedRequestId!=='stage-repair-'+valueDigest({requestDigest:r.digest}).slice(7,55))reject('CORRUPT_REPAIR_CAPTURE','Cross-candidate verification must retain its complete pre-bound origin set and comparison action',503);
    for(const rawOrigin of c.origins){const origin=rawOrigin as RecoveryFailureOrigin,old=repairRequest(store,r.projectId,origin.request.id),prior=nativeRepairRoot(store,r.projectId,old.instanceId);if(old.digest!==origin.request.digest||prior.rootRef!==root.rootRef||prior.saved.candidateDigest!==origin.candidateDigest||prior.saved.pinsDigest!==origin.pinsDigest||old.authorityRef!==origin.authorityRef||valueDigest(store.object(r.projectId,'stage-observation',String(origin.progress.observationRef)))!==origin.progress.observationRef||Date.parse(String(c.deadlineAt))>Date.parse(old.deadlineAt))reject('CORRUPT_REPAIR_CAPTURE','A retained origin changed after capture',503);}
  }
  return c as unknown as NativeRepairCapture;
}
export function readNativeRepairHistory(store:RuntimeStore,projectId:string,originalId:string,actor:Principal){
  authorize(actor,projectId,'read');
  const original=repairRequest(store,projectId,originalId),root=nativeRepairRoot(store,projectId,original.instanceId),raw=record(store.object(projectId,RECOVERY_KIND,'attempts:'+root.rootRef)),{digest,...body}=raw;
  if(raw.schema!=='runtime-recovery-attempts/v1'||raw.rootRef!==root.rootRef||raw.rootDigest!==root.rootDigest||digest!==valueDigest(body)||!Array.isArray(raw.entries)||raw.entries.length>4096)reject('CORRUPT_REPAIR_HISTORY','Complete original root attempts are required',503);
  const captures:NativeRepairCapture[]=[],rounds:NativeRepairRound[]=[],open:string[]=[],claims=new Map<string,StageRequest>();
  for(const item of raw.entries){const entry=record(item),r=repairRequest(store,projectId,string(entry.requestId));if(claims.has(r.id)||r.digest!==entry.requestDigest||r.instanceId!==entry.instanceId||r.stageId!==entry.stageId||r.deadlineAt!==entry.deadlineAt||nativeRepairRoot(store,projectId,r.instanceId).rootRef!==root.rootRef)reject('CORRUPT_REPAIR_HISTORY','Original recovery claim changed',503);claims.set(r.id,r);const capture=readNativeRepairCapture(store,r);if(!capture)continue;
    const p=record(store.object(projectId,'stage-progress',r.id)),rawRound=store.object(projectId,RECOVERY_KIND,'repair-round:'+r.id);let round:NativeRepairRound|null=null;
    if(p.terminal===true){if(!rawRound)reject('CORRUPT_REPAIR_HISTORY','Completed verification lost its atomic repair round',503);const v=record(rawRound),{digest,...body}=v,envelope=record(store.object(projectId,'stage-observation',String(p.observationRef)));if(v.schema!==(capture.schema==='runtime-repair-capture/v2'?'runtime-repair-round/v2':'runtime-repair-round/v1')||valueDigest(body)!==digest||v.rootRef!==root.rootRef||v.rootDigest!==root.rootDigest||v.captureDigest!==capture.digest||v.requestId!==r.id||v.requestDigest!==r.digest||v.observationRef!==p.observationRef||v.observedAt!==p.observedAt||!Number.isSafeInteger(v.completedRevision)||Number(v.completedRevision)<1||Number(v.completedRevision)>store.revision(projectId)||v.outcome!==(p.phase==='COMPLETE'?'PASS':p.phase==='FAILED'?'FAIL':null)||v.repairVerified!==false||valueDigest(envelope)!==p.observationRef||envelope.requestId!==r.id||envelope.schema!=='runtime-stage-observation/v1'||canonical(envelope.observation)!==canonical(p.observation)||envelope.reason!==p.reason||envelope.observedAt!==p.observedAt)reject('CORRUPT_REPAIR_HISTORY','Completed repair round differs from its original terminal observation',503);round=v as unknown as NativeRepairRound;}else if(rawRound)reject('CORRUPT_REPAIR_HISTORY','Unresolved original actions cannot complete a repair round',503);
    if(capture.originalStageId===original.stageId){captures.push(capture);if(round)rounds.push(round);else open.push(r.id);}
  }
  // Independently enumerate immutable requests and member counters. A shortened
  // rehashed ledger must not hide an unfinished check or reset actual rounds.
  const members=new Set<string>(),covered=new Set<string>();let after='',scanned=0;
  for(;;){const rows=store.objectsPage(projectId,'lifecycle-instance',after,200);for(const row of rows){after=row.id;if(++scanned>4096)reject('RECOVERY_HISTORY_LIMIT','Repair member scan is bounded',503);
    const rawBinding=store.object(projectId,'instance-authority',row.id),binding=rawBinding?record(rawBinding):{},member=store.object(projectId,RECOVERY_KIND,'member:'+row.id) as Record<string,unknown>|null;
    if(binding.recoveryRootRef!==root.rootRef&&member?.rootRef!==root.rootRef)continue;
    const saved=nativeRepairRoot(store,projectId,row.id).saved;members.add(saved.id);const counts=new Map<string,number>();
    for(const id of saved.requestIds){const r=claims.get(id);if(covered.has(id)||!r||r.instanceId!==saved.id)reject('CORRUPT_REPAIR_HISTORY','A root request was omitted from repair history',503);covered.add(id);counts.set(r.stageId,(counts.get(r.stageId)??0)+1);}
    for(const [stage,state]of Object.entries(saved.stages))if(state.attempts!==(counts.get(stage)??0))reject('CORRUPT_REPAIR_HISTORY','Root attempts differ from complete repair claims',503);
  }if(rows.length<200)break;}
  if(covered.size!==claims.size)reject('CORRUPT_REPAIR_HISTORY','Repair claims lost their member instance',503);
  after='';scanned=0;for(;;){const rows=store.objectsPage(projectId,'stage-request',after,200);for(const row of rows){after=row.id;if(++scanned>4096)reject('RECOVERY_HISTORY_LIMIT','Repair request scan is bounded',503);if(members.has(String(record(row.value).instanceId))&&!claims.has(row.id))reject('CORRUPT_REPAIR_HISTORY','An immutable request was hidden from repair history',503);}if(rows.length<200)break;}
  rounds.sort((a,b)=>a.completedRevision-b.completedRevision);if(new Set(rounds.map(r=>r.completedRevision)).size!==rounds.length)reject('CORRUPT_REPAIR_HISTORY','Native repair completion order changed',503);
  const remaining=new Map(rounds.map(r=>[r.completedRevision,r]));let cursor:string|undefined;scanned=0;
  while(remaining.size){const page=store.events(actor,projectId,cursor);cursor=page.cursor;if(!page.events.length)reject('CORRUPT_REPAIR_HISTORY','Repair completion has no original terminal event',503);
    for(const raw of page.events){if(++scanned>65536)reject('RECOVERY_HISTORY_LIMIT','Repair event verification exceeds its bounded read limit',503);const event=record(raw),round=remaining.get(Number(event.revision));if(!round)continue;const data=record(event.data);
      if(event.type!=='stage-observed'||data.stageRequestId!==round.requestId||data.observationRef!==round.observationRef||data.phase!==(round.outcome==='PASS'?'COMPLETE':'FAILED'))reject('CORRUPT_REPAIR_HISTORY','Repair round order differs from the original terminal event',503);remaining.delete(round.completedRevision);
    }
  }
  return{rootRef:root.rootRef,rootDigest:root.rootDigest,captures,rounds,open,repairVerified:false as const};
}
interface DecisionRecord {
  schema:'runtime-authority-decision/v1'; ref:string; workspaceId:string; projectId:string;
  kind:Kind; subject:Record<string,unknown>; reviewDigest:string; policyDigest:string; bindingContextDigest:string;
  principalId:string; principalRevision:number; choice:Choice; evidenceRef:string; at:string;
}
interface Revocation { schema:'runtime-authority-revocation/v1'; authorityRef:string; revokedBy:string; principalRevision:number; reason:string; at:string; }
const hash=(v:unknown):string=>{const s=string(v,128);if(!/^sha256:[a-f0-9]{64}$/.test(s))reject('INVALID_REFERENCE','An exact content digest is required');return s;};
const reference=(v:unknown):string=>{const s=string(v,128);if(!/^authority:sha256:[a-f0-9]{64}$/.test(s))reject('INVALID_AUTHORITY_REF','An exact retained authority reference is required');return s;};
const kind=(v:unknown):Kind=>{if(v!=='execution'&&v!=='release')reject('INVALID_AUTHORITY_KIND','Choose execution or release');return v;};
function expiry(v:unknown):string{const s=string(v,128);if(!Number.isFinite(Date.parse(s))||Date.parse(s)<=Date.now())reject('AUTHORITY_EXPIRED','Authority needs a future explicit expiry');return s;}

/** Policy config does not contain decisions. Referenced configuration is pinned
 * independently from the decision policy. Credential bytes, remote branch head,
 * and unrelated projects/registrations are not execution scope changes. */
export function registeredAuthorityPolicy(configPath:string,workspaceId:string):AuthorityPolicyProvider {
  return(definition,actor)=>{
    authorize(actor,definition.projectId,'read');
    const config=readIntegrationConfiguration(configPath,workspaceId);
    const resources=['authorityPolicyRef','decisionSourceRef'].map(field=>{
      const role='config.release-decision.'+field,ref=atPath(definition.semantic,role);
      const resource=config.resources.find(r=>r.ref===ref&&r.projectId===definition.projectId&&r.role===role);
      if(!resource||Date.parse(resource.expiresAt)<=Date.now())reject('AUTHORITY_POLICY_UNAVAILABLE','Current scoped decision policy is required',409);
      validateResourceDefinition(resource);return resource;
    });
    const refs=new Set<string>();
    const collect=(value:unknown):void=>{if(typeof value==='string'&&bindingPattern.test(value))refs.add(value);else if(Array.isArray(value))value.forEach(collect);else if(value&&typeof value==='object')Object.values(value).forEach(collect);};
    collect(definition.semantic);
    const selected:Record<string,unknown>[]=[];
    // Shared native validators are part of execution scope, even though their
    // protected manifest is operator configuration rather than project YAML.
    if(config.nativeToolchain)selected.push({ref:'native-toolchain',...config.nativeToolchain});
    for(const ref of refs){
      const resource=config.resources.find(r=>r.ref===ref&&r.projectId===definition.projectId);
      const platform=config.platforms.find(p=>p.ref===ref&&p.projectId===definition.projectId);
      const owner=config.owners.find(o=>o.ref===ref&&o.projects.includes(definition.projectId));
      if(resource){const {revision:unusedRevision,expiresAt:unusedExpiry,...scope}=resource;selected.push(scope);collect(resource.definition);}
      else if(platform){const {revision:unusedRevision,expiresAt:unusedExpiry,...scope}=platform;selected.push(scope);}
      else if(owner){const {projects:unusedProjects,...scope}=owner;selected.push({...scope,projectId:definition.projectId});}
      else selected.push({ref,registration:null});
    }
    return{digest:valueDigest({workspaceId,projectId:definition.projectId,resources}),bindingContextDigest:valueDigest(selected.sort((a,b)=>String(a.ref).localeCompare(String(b.ref)))),principalIds:resources[0].definition.principalIds as string[],expiresAt:new Date(Math.min(...resources.map(r=>Date.parse(r.expiresAt)))).toISOString()};
  };
}

/** Existing local operator evidence + authenticated capability, not an approval
 * portal or an assertion that a file hash authenticates a human. No YAML, LLM
 * output, content grade or successful activation creates a grant. */
export function createAuthorityService(store:RuntimeStore,policies:AuthorityPolicyProvider|undefined,principals:PrincipalLookup,preparations?:PreparationVerifier){
  function prepared(subject:Record<string,unknown>,effective:EffectiveDefinition,actor:Principal,reviewerId:string){
    if(!String(subject.targetRef).startsWith('preparation:'))return null;
    if(!isPreparationRef(subject.targetRef)||!preparations)reject('PREPARATION_REQUIRED','Exact retained preparation and current validation are required',409);
    const {packet,facts}=preparations(subject.targetRef,effective,actor);
    if(packet.input.definitionRevisionId!==subject.definitionRevisionId||packet.input.goalRef!==subject.goalRef||packet.input.loopRef!==subject.loopRef)reject('PREPARATION_SCOPE','Authority must bind the same preparation, goal, loop and definition',409);
    if(!facts.reviewerIds.includes(reviewerId))reject('PREPARATION_REVIEWER','The deciding principal is not a configured plan reviewer',403);
    return packet;
  }
  function definition(projectId:string,id:unknown):EffectiveDefinition{
    const digest=hash(id),saved=store.object(projectId,'definition-revision',digest);
    if(!saved)reject('NOT_FOUND','Definition revision not found',404);
    const r=record(saved),c=record(r.compilation);
    if(r.id!==digest||valueDigest({yaml:r.yaml,compilation:r.compilation})!==digest||c.valid!==true||!c.effective)reject('CORRUPT_DEFINITION','Authority requires an intact valid definition',409);
    const effective=c.effective as EffectiveDefinition;
    if(effective.projectId!==projectId||valueDigest(effective.semantic)!==effective.semanticDigest)reject('CORRUPT_DEFINITION','Definition scope or semantics changed',503);
    return effective;
  }
  function instance(projectId:string,id:unknown):LifecycleInstance{
    const instanceId=slug(id),saved=store.object(projectId,'lifecycle-instance',instanceId);
    if(!saved)reject('NOT_FOUND','Lifecycle instance not found',404);
    const checked=inspectInstance(saved as LifecycleInstance);
    if(checked.id!==instanceId||checked.pins.projectId!==projectId)reject('CORRUPT_INSTANCE','Instance scope changed',503);
    return checked;
  }
  function releaseEvidence(saved:LifecycleInstance):void{
    releasePredecessors(saved);
  }
  function policy(definition:EffectiveDefinition,actor:Principal,deciding=false):AuthorityPolicy{
    if(!policies)reject('AUTHORITY_POLICY_UNAVAILABLE','No current authority policy adapter is configured',409);
    const p=policies(definition,actor);hash(p.digest);hash(p.bindingContextDigest);
    if(!Array.isArray(p.principalIds)||!p.principalIds.length||p.principalIds.some(id=>typeof id!=='string')||Date.parse(p.expiresAt)<=Date.now()||!Number.isFinite(Date.parse(p.expiresAt)))reject('AUTHORITY_POLICY_UNAVAILABLE','Current explicit authority policy is required',409);
    if(deciding){authorize(actor,definition.projectId,'decision.record');if(!p.principalIds.includes(actor.id))reject('DECISION_PRINCIPAL','Principal is not allowed by this exact project policy',403);}
    return p;
  }
  function verifyEvidence(d:DecisionRecord):void{
    const expected:DecisionSubject={owner:'runtime',operation:'lifecycle.authority.'+d.kind,workspaceId:store.workspaceId,scope:{visibility:'private',projectId:d.projectId},reviewDigest:d.reviewDigest,decision:d.choice};
    try{verifyDecisionEvidence(d.evidenceRef,expected);}catch{reject('DECISION_EVIDENCE_REQUIRED','Pinned evidence must match this exact reviewed decision and retained source',409);}
  }
  function savedDecision(projectId:string,ref:unknown):DecisionRecord{
    const key=reference(ref),saved=store.object(projectId,'authority-decision',key);
    if(!saved)reject('NOT_FOUND','Authority decision not found',404);
    const d=saved as DecisionRecord,{ref:unused,...content}=d;
    if(d.schema!=='runtime-authority-decision/v1'||d.workspaceId!==store.workspaceId||d.projectId!==projectId||d.ref!==key||'authority:'+valueDigest(content)!==key)reject('CORRUPT_AUTHORITY','Decision content or scope changed',503);
    return d;
  }
  function selectedDefinition(d:DecisionRecord):EffectiveDefinition{return definition(d.projectId,d.subject.definitionRevisionId);}
  function current(d:DecisionRecord,actor:Principal):void{
    authorize(actor,d.projectId,'read');
    if(d.choice!=='APPROVE'||store.object(d.projectId,'authority-revocation',d.ref))reject('AUTHORITY_REVOKED','This decision is not an active approval',403);
    const selected=store.object(d.projectId,d.kind==='execution'?'instance-execution':'instance-release',String(d.subject.instanceId)) as {authorityRef:string}|null;
    if(selected?.authorityRef!==d.ref)reject('AUTHORITY_SUPERSEDED','A subsequent exact decision replaced this instance authority',409);
    expiry(d.subject.expiresAt);
    const effective=selectedDefinition(d),p=policy(effective,actor);
    if(p.digest!==d.policyDigest)reject('AUTHORITY_POLICY_CHANGED','The exact authority policy changed; prior approval cannot be reused',409);
    if(p.bindingContextDigest!==d.bindingContextDigest)reject('AUTHORITY_BINDINGS_CHANGED','Referenced execution configuration changed; an existing instance cannot be retargeted',409);
    const grantor=principals(d.principalId);
    if(!grantor||grantor.revision!==d.principalRevision||!p.principalIds.includes(grantor.id))reject('AUTHORITY_PRINCIPAL_CHANGED','The deciding principal changed or was removed',403);
    authorize(grantor,d.projectId,'decision.record');verifyEvidence(d);
    if(d.kind==='execution'){
      const packet=prepared(d.subject,effective,actor,grantor.id);
      if(d.subject.recoveryRootRef!==undefined)verifySuccessor(readRecoveryRoot(d.projectId,d.subject.recoveryRootRef),d.subject,effective,actor,packet);
    }
    if(d.kind==='release'){
      const saved=instance(d.projectId,d.subject.instanceId);
      if(saved.pinsDigest!==d.subject.pinsDigest||saved.candidateDigest!==d.subject.candidateDigest)reject('AUTHORITY_MISMATCH','Release instance or candidate changed',409);
      releaseEvidence(saved);
      const material=readReleaseMaterial(store,saved);
      if(material.digest!==d.subject.releaseMaterialDigest||material.bindingContextDigest!==p.bindingContextDigest)reject('RELEASE_MATERIAL_CHANGED','Release decision no longer matches exact collected material and configuration',409);
    }
  }
  function execution(d:DecisionRecord):ExecutionAuthority{
    if(d.kind!=='execution')reject('AUTHORITY_KIND_MISMATCH','An execution decision is required',403);
    const s=d.subject;
    return{projectId:d.projectId,instanceId:String(s.instanceId),definitionRevisionId:String(s.definitionRevisionId),semanticDigest:String(s.semanticDigest),requirementsDigest:String(s.requirementsDigest),goalRef:String(s.goalRef),targetRef:String(s.targetRef),loopRef:String(s.loopRef),budget:s.budget as ExecutionAuthority['budget'],...(s.recoveryRootRef!==undefined?{recoveryRootRef:String(s.recoveryRootRef),recoveryRootDigest:String(s.recoveryRootDigest)}:{}),evidenceRef:d.ref,revision:d.reviewDigest,expiresAt:String(s.expiresAt)};
  }
  function release(d:DecisionRecord):ReleaseAuthority{
    if(d.kind!=='release')reject('AUTHORITY_KIND_MISMATCH','A separate release decision is required',403);
    const s=d.subject;
    return{projectId:d.projectId,instanceId:String(s.instanceId),pinsDigest:String(s.pinsDigest),definitionRevisionId:String(s.definitionRevisionId),semanticDigest:String(s.semanticDigest),requirementsDigest:String(s.requirementsDigest),candidateDigest:String(s.candidateDigest),channel:String(s.channel),decisionRef:d.ref,expiresAt:String(s.expiresAt)};
  }
  function prepare(actor:Principal,projectId:string,input:Record<string,unknown>){
    exact(input,['kind','subject']);const type=kind(input.kind),source=record(input.subject);
    if(containsInlineSecret(canonical(source)))reject('INLINE_SECRET','Authority subjects use references, not raw credentials');
    let effective:EffectiveDefinition,subject:Record<string,unknown>,releaseMaterial:ReleaseMaterial|undefined;
    if(type==='execution'){
      exact(source,['instanceId','definitionRevisionId','goalRef','targetRef','loopRef','budget','expiresAt'],['recoveryRootRef']);
      const instanceId=slug(source.instanceId),revisionId=hash(source.definitionRevisionId);
      if(store.object(projectId,'lifecycle-instance',instanceId))reject('INSTANCE_EXISTS','An authority amendment cannot reset an existing instance',409);
      const pointer=store.object(projectId,'definition-pointer','active') as {revisionId:string}|null;
      if(pointer?.revisionId!==revisionId)reject('DEFINITION_NOT_ACTIVE','New execution authority requires the exact active definition',409);
      effective=definition(projectId,revisionId);
      subject={instanceId,definitionRevisionId:revisionId,semanticDigest:effective.semanticDigest,requirementsDigest:requiredChecksDigest(effective),goalRef:string(source.goalRef,512),targetRef:string(source.targetRef,512),loopRef:string(source.loopRef,512),budget:source.budget,expiresAt:expiry(source.expiresAt)};

    }else{
      exact(source,['instanceId','candidateDigest','expiresAt']);const saved=instance(projectId,source.instanceId);
      if(!saved.candidateDigest||hash(source.candidateDigest)!==saved.candidateDigest)reject('CANDIDATE_REQUIRED','Release authority requires the exact immutable candidate',409);
      effective=saved.definition;
      releaseEvidence(saved);
      releaseMaterial=readReleaseMaterial(store,saved);
      subject={instanceId:saved.id,pinsDigest:saved.pinsDigest,definitionRevisionId:saved.pins.definitionRevisionId,semanticDigest:saved.pins.semanticDigest,requirementsDigest:saved.pins.requirementsDigest,candidateDigest:saved.candidateDigest,releaseMaterialDigest:releaseMaterial.digest,channel:atPath(effective.semantic,'config.publication.channel'),expiresAt:expiry(source.expiresAt)};
    }
    const p=policy(effective,actor,true);
    if(releaseMaterial&&releaseMaterial.bindingContextDigest!==p.bindingContextDigest)reject('RELEASE_BINDINGS_CHANGED','Configuration changed after release material collection',409);
    if(Date.parse(String(subject.expiresAt))>Math.min(Date.parse(p.expiresAt),Date.parse(actor.expiresAt)))reject('AUTHORITY_EXPIRY_BOUND','Decision expiry must fit the current policy and deciding credential');
    const preparation=type==='execution'?prepared(subject,effective,actor,actor.id):null;
    if(type==='execution'){
      if(source.recoveryRootRef!==undefined)subject.recoveryRootRef=recoveryReference(source.recoveryRootRef);
      bindRecoverySubject(projectId,subject,effective,actor,preparation);
      // Reuse publisher budget/pin verification without persisting or dispatching.
      pinInstance(String(subject.instanceId),String(subject.definitionRevisionId),effective,execution({kind:type,projectId,subject,ref:'preview',reviewDigest:'preview'} as DecisionRecord));
    }
    const review={schema:'runtime-authority-review/v1',workspaceId:store.workspaceId,projectId,kind:type,subject,policyDigest:p.digest,bindingContextDigest:p.bindingContextDigest,principalId:actor.id,principalRevision:actor.revision,...(preparation?{preparation}:{}),...(releaseMaterial?{releaseMaterial}:{})};
    return{...review,reviewDigest:evidenceValueDigest(review)};
  }
  function recoveryIdentity(subject:Record<string,unknown>,packet:ReturnType<typeof prepared>):RecoveryIdentity{
    return{goalRef:String(subject.goalRef),loopRef:String(subject.loopRef),target:packet?{kind:'preparation',id:packet.input.target.id,version:packet.input.target.version}:{kind:'opaque',ref:String(subject.targetRef)}};
  }
  function readRecoveryRoot(projectId:string,ref:unknown):NativeRecoveryRoot{
    const id=recoveryReference(ref),raw=store.object(projectId,RECOVERY_KIND,id);
    if(!raw)reject('RECOVERY_ROOT_NOT_FOUND','No native original recovery root exists; historical instances cannot be backfilled implicitly',409);
    const r=record(raw);exact(r,['schema','ref','workspaceId','projectId','identity','identityDigest','originalTargetRef','originalInstanceId','originalAuthorityRef','originalAuthorityDigest','originalPinsDigest','createdAt','deadlineAt','graphDigest','requirementsDigest','budget','stageBudgets','digest']);
    const{digest,...body}=r;
    if(r.schema!=='runtime-recovery-lineage-root/v1'||r.ref!==id||r.workspaceId!==store.workspaceId||r.projectId!==projectId||valueDigest(body)!==digest||valueDigest(r.identity)!==r.identityDigest||!Number.isFinite(Date.parse(String(r.createdAt)))||!Number.isFinite(Date.parse(String(r.deadlineAt)))||Date.parse(String(r.deadlineAt))<=Date.parse(String(r.createdAt)))reject('CORRUPT_RECOVERY_ROOT','Original native root identity changed',503);
    const root=r as unknown as NativeRecoveryRoot,original=instance(projectId,root.originalInstanceId),d=savedDecision(projectId,root.originalAuthorityRef);
    if(d.kind!=='execution'||d.subject.recoveryRootRef!==undefined||d.subject.instanceId!==root.originalInstanceId||valueDigest(execution(d))!==root.originalAuthorityDigest||original.pinsDigest!==root.originalPinsDigest||original.pins.authorityDigest!==root.originalAuthorityDigest||original.createdAt!==root.createdAt||original.pins.graphDigest!==root.graphDigest||original.pins.requirementsDigest!==root.requirementsDigest||canonical(original.pins.budget)!==canonical(root.budget)||root.originalTargetRef!==original.pins.targetRef)reject('CORRUPT_RECOVERY_ROOT','Recovery root must bind its actual original native authority and instance',503);
    const originalPacket=isPreparationRef(d.subject.targetRef)?readPreparationPacket(store,projectId,String(d.subject.targetRef)):null;
    if(canonical(root.identity)!==canonical(recoveryIdentity(d.subject,originalPacket))||canonical(root.stageBudgets)!==canonical(Object.fromEntries(original.definition.nodes.map(n=>[n.id,stageBudget(original,n)])))||root.deadlineAt!==new Date(Math.min(Date.parse(original.createdAt)+original.pins.budget.timeoutSeconds*1000,Date.parse(original.pins.authorityExpiresAt))).toISOString())reject('CORRUPT_RECOVERY_ROOT','Original native scope or cumulative bounds changed',503);
    const index=record(store.object(projectId,RECOVERY_KIND,'lineage:'+root.identityDigest));
    if(index.schema!=='runtime-recovery-lineage-index/v1'||index.rootRef!==root.ref||index.rootDigest!==root.digest||index.identityDigest!==root.identityDigest)reject('CORRUPT_RECOVERY_ROOT','Original native lineage index differs',503);
    return root;
  }
  function rootAuthority(root:NativeRecoveryRoot,actor:Principal):void{
    const d=savedDecision(root.projectId,root.originalAuthorityRef),selected=store.object(root.projectId,'instance-execution',root.originalInstanceId) as {authorityRef:string}|null;
    if(d.choice!=='APPROVE'||store.object(root.projectId,'authority-revocation',d.ref)||selected?.authorityRef!==d.ref)reject('RECOVERY_AUTHORITY_REVOKED','Original recovery authority was revoked or superseded',403);
    const grantor=principals(d.principalId),p=policy(selectedDefinition(d),actor);
    if(!grantor||grantor.revision!==d.principalRevision||!p.principalIds.includes(grantor.id)||p.digest!==d.policyDigest)reject('RECOVERY_AUTHORITY_CHANGED','Original recovery deciding authority or policy changed',403);
    authorize(grantor,root.projectId,'decision.record');verifyEvidence(d);
    if(Date.parse(root.deadlineAt)<=Date.now()||Date.parse(String(d.subject.expiresAt))<=Date.now())reject('RECOVERY_DEADLINE_EXHAUSTED','The original recovery window permits observation only',409);
    // A successor has its own exact current source/configuration approval.
    // Do not reinterpret historical original source bytes as successor inputs.
  }
  function verifySuccessor(root:NativeRecoveryRoot,subject:Record<string,unknown>,effective:EffectiveDefinition,actor:Principal,packet:ReturnType<typeof prepared>):void{
    rootAuthority(root,actor);
    if(subject.recoveryRootDigest!==undefined&&subject.recoveryRootDigest!==root.digest||canonical(recoveryIdentity(subject,packet))!==canonical(root.identity)||valueDigest(effective.nodes)!==root.graphDigest||requiredChecksDigest(effective)!==root.requirementsDigest)reject('RECOVERY_SCOPE_CHANGED','Successor must preserve the exact native goal/target/loop and graph/check obligations',409);
    const b=record(subject.budget);
    if(Object.keys(root.budget).some(key=>!Number.isSafeInteger(b[key])||Number(b[key])>root.budget[key as keyof Budget])||Date.parse(String(subject.expiresAt))>Date.parse(root.deadlineAt))reject('RECOVERY_BUDGET_WIDENED','Successor approval cannot extend original budget or deadline',409);
    for(const node of effective.nodes){const original=root.stageBudgets[node.id],next=stageBudget({definition:effective} as LifecycleInstance,node);if(!original||Object.keys(original).some(key=>next[key as keyof Budget]>original[key as keyof Budget]))reject('RECOVERY_BUDGET_WIDENED','Successor stage bounds cannot exceed the original reviewed stage',409);}
  }
  function requireNewOrigin(projectId:string,identity:RecoveryIdentity,instanceId:string):void{
    let after='';
    for(;;){const rows=store.objectsPage(projectId,'instance-execution',after,200);for(const row of rows){after=row.id;if(row.id===instanceId||!store.object(projectId,'lifecycle-instance',row.id))continue;
      const d=existingNativeDecision(projectId,record(row.value).authorityRef);if(!d)continue;const packet=isPreparationRef(d.subject.targetRef)?readPreparationPacket(store,projectId,String(d.subject.targetRef)):null;
      if(canonical(recoveryIdentity(d.subject,packet))===canonical(identity))reject('RECOVERY_ORIGIN_UNAVAILABLE','This exact reviewed lineage already has historical work without an original native root; it cannot be silently restarted or backfilled',409);
    }if(rows.length<200)return;}
  }
  function bindRecoverySubject(projectId:string,subject:Record<string,unknown>,effective:EffectiveDefinition,actor:Principal,packet:ReturnType<typeof prepared>):void{
    const identity=recoveryIdentity(subject,packet),index=store.object(projectId,RECOVERY_KIND,'lineage:'+valueDigest(identity));
    if(subject.recoveryRootRef===undefined){if(index)reject('RECOVERY_ROOT_REQUIRED','This exact native lineage already exists; review an explicit recoveryRootRef instead of resetting it',409);requireNewOrigin(projectId,identity,String(subject.instanceId));return;}
    const root=readRecoveryRoot(projectId,subject.recoveryRootRef);verifySuccessor(root,subject,effective,actor,packet);subject.recoveryRootDigest=root.digest;
  }
  function existingNativeDecision(projectId:string,ref:unknown):DecisionRecord|null{
    if(typeof ref!=='string'||!/^authority:sha256:[a-f0-9]{64}$/.test(ref)||!store.object(projectId,'authority-decision',ref))return null;
    return savedDecision(projectId,ref);
  }
  function member(saved:LifecycleInstance,grant?:ExecutionAuthority):NativeRecoveryRoot|null{
    const binding=store.object(saved.pins.projectId,'instance-authority',saved.id) as {evidenceRef:string;recoveryRootRef?:string;recoveryRootDigest?:string}|null;
    if(!binding?.recoveryRootRef){
      const retained=store.object(saved.pins.projectId,RECOVERY_KIND,'member:'+saved.id),pointer=store.object(saved.pins.projectId,'instance-execution',saved.id) as {authorityRef:string}|null;
      const nativeRef=binding?.evidenceRef??pointer?.authorityRef,d=existingNativeDecision(saved.pins.projectId,nativeRef),subject=d?.subject??{goalRef:saved.pins.goalRef,loopRef:saved.pins.loopRef,targetRef:saved.pins.targetRef};
      const packet=isPreparationRef(subject.targetRef)&&store.object(saved.pins.projectId,'lifecycle-preparation',subject.targetRef)?readPreparationPacket(store,saved.pins.projectId,String(subject.targetRef)):null;
      const indexed=store.object(saved.pins.projectId,RECOVERY_KIND,'lineage:'+valueDigest(recoveryIdentity(subject,packet)));
      const originalRef=nativeRef?'recovery-root:'+valueDigest({workspaceId:store.workspaceId,projectId:saved.pins.projectId,instanceId:saved.id,authorityRef:nativeRef}):null;
      if(retained||indexed||originalRef&&store.object(saved.pins.projectId,RECOVERY_KIND,originalRef)||binding?.recoveryRootDigest||d?.subject.recoveryRootRef||grant?.recoveryRootRef)reject('CORRUPT_RECOVERY_MEMBER','Retained native recovery evidence cannot downgrade to a legacy binding',503);
      return null;
    }
    const root=readRecoveryRoot(saved.pins.projectId,binding.recoveryRootRef),retained=store.object(saved.pins.projectId,RECOVERY_KIND,'member:'+saved.id);
    if(!retained)reject('CORRUPT_RECOVERY_MEMBER','Native recovery member record is missing',503);const raw=record(retained);
    if(binding.recoveryRootDigest!==root.digest||raw.schema!=='runtime-recovery-member/v1'||raw.rootRef!==root.ref||raw.rootDigest!==root.digest||raw.instanceId!==saved.id||raw.pinsDigest!==saved.pinsDigest||raw.authorityRef!==binding.evidenceRef||grant&&(grant.evidenceRef!==binding.evidenceRef||valueDigest(grant)!==saved.pins.authorityDigest))reject('CORRUPT_RECOVERY_MEMBER','Native recovery membership differs from the immutable instance',503);
    const native=execution(savedDecision(saved.pins.projectId,binding.evidenceRef));
    if(valueDigest(native)!==saved.pins.authorityDigest||native.instanceId!==saved.id)reject('CORRUPT_RECOVERY_MEMBER','Recovery member must preserve its exact native grant',503);
    if(saved.id!==root.originalInstanceId&&(native.recoveryRootRef!==root.ref||native.recoveryRootDigest!==root.digest))reject('RECOVERY_BINDING_REQUIRED','Only exact reviewed native authority may join a recovery root',409);
    return root;
  }
  function attempts(root:NativeRecoveryRoot):RecoveryAttempts{
    const raw=store.object(root.projectId,RECOVERY_KIND,'attempts:'+root.ref);
    if(!raw)reject('CORRUPT_RECOVERY_LEDGER','Original recovery attempt ledger is missing',503);
    const value=record(raw);exact(value,['schema','rootRef','rootDigest','entries','digest']);const{digest,...body}=value;
    if(value.schema!=='runtime-recovery-attempts/v1'||value.rootRef!==root.ref||value.rootDigest!==root.digest||valueDigest(body)!==digest||!Array.isArray(value.entries)||value.entries.length>4096)reject('CORRUPT_RECOVERY_LEDGER','Original recovery attempt ledger changed',503);
    const seen=new Set<string>(),requests=new Map<string,StageRequest>();
    for(const item of value.entries){const e=record(item);exact(e,['instanceId','stageId','requestId','requestDigest','deadlineAt']);string(e.instanceId);string(e.stageId);string(e.requestId);hash(e.requestDigest);
      const r=store.object(root.projectId,'stage-request',String(e.requestId)) as StageRequest|null;
      if(!r)reject('CORRUPT_RECOVERY_LEDGER','Original recovery request is missing',503);const{digest:requestDigest,...requestBody}=r;
      if(seen.has(r.id)||r.schema!=='runtime-stage-request/v1'||r.workspaceId!==root.workspaceId||r.projectId!==root.projectId||r.id!==e.requestId||r.instanceId!==e.instanceId||r.stageId!==e.stageId||requestDigest!==e.requestDigest||valueDigest(requestBody)!==requestDigest||valueDigest(r.plan)!==r.planDigest||r.deadlineAt!==e.deadlineAt||Date.parse(r.deadlineAt)>Date.parse(root.deadlineAt)||!Number.isFinite(Date.parse(r.deadlineAt))||member(instance(root.projectId,r.instanceId))?.ref!==root.ref)reject('CORRUPT_RECOVERY_LEDGER','Recovery request identity or membership changed',503);seen.add(r.id);requests.set(r.id,r);
      const capture=readNativeRepairCapture(store,r);if(capture){const p=store.object(root.projectId,'stage-progress',r.id) as StageProgress|null,round=store.object(root.projectId,RECOVERY_KIND,'repair-round:'+r.id);if(p?.terminal===true&&!round||p?.terminal===false&&round)reject('CORRUPT_REPAIR_HISTORY','Root claims and completed repair rounds disagree',503);}
    }
    // Membership and the independently retained instance counters/request IDs
    // must be complete. A rehashed shortened ledger cannot renew an allowance.
    const members=new Set<string>(),covered=new Set<string>();let after='',scanned=0;
    for(;;){const rows=store.objectsPage(root.projectId,'lifecycle-instance',after,200);
      for(const row of rows){after=row.id;if(++scanned>4096)reject('RECOVERY_HISTORY_LIMIT','Recovery integrity scan exceeds its bounded read limit',503);
        const saved=instance(root.projectId,row.id);if(member(saved)?.ref!==root.ref)continue;members.add(saved.id);
        const local=new Set<string>(),counts=new Map<string,number>(),latest=new Map<string,string>();
        for(const id of saved.requestIds){const r=requests.get(id);if(local.has(id)||covered.has(id)||!r||r.instanceId!==saved.id||r.pinsDigest!==saved.pinsDigest||r.authorityRef!==(store.object(root.projectId,'instance-authority',saved.id) as {evidenceRef:string}).evidenceRef||!saved.stages[r.stageId])reject('CORRUPT_RECOVERY_LEDGER','Original instance request history differs from its recovery claims',503);local.add(id);covered.add(id);counts.set(r.stageId,(counts.get(r.stageId)??0)+1);latest.set(r.stageId,id);}
        for(const [stageId,state]of Object.entries(saved.stages)){
          if(!Number.isSafeInteger(state.attempts)||state.attempts!==(counts.get(stageId)??0)||state.attempts>0&&(!state.requestId||state.requestId!==latest.get(stageId)))reject('CORRUPT_RECOVERY_LEDGER','Original stage attempt counters differ from retained recovery requests',503);
          if(!state.attempts){if(stageId==='candidate'&&(saved.candidate!==null||saved.candidateDigest!==null))reject('CORRUPT_RECOVERY_LEDGER','An unexecuted candidate stage cannot establish a candidate',503);if(state.status!=='PENDING'||[state.requestId,state.inputDigest,state.receiptRef,state.outcomeDigest,state.expiresAt].some(v=>v!==null))reject('CORRUPT_RECOVERY_LEDGER','An unexecuted stage cannot acquire an outcome projection',503);continue;}
          const r=requests.get(state.requestId!)!,e=(value.entries as RecoveryAttempt[]).find(e=>e.requestId===r.id)!,p=attemptProgress(root,e),o=p.observation?.outcome??null;
          const status=p.phase==='DISPATCHING'?'RUNNING':o?.status==='COMPLETE'?'PASSED':o?.status;
          if(state.inputDigest!==r.inputDigest||state.status!==status||state.receiptRef!==(o?.receiptRef??null)||state.outcomeDigest!==(o?valueDigest(o):null)||state.expiresAt!==(o?.expiresAt??null))reject('CORRUPT_RECOVERY_LEDGER','Stage projection differs from its latest immutable request and observation',503);
          if(stageId==='candidate'&&(o?.status==='COMPLETE'?(!o.candidate||canonical(saved.candidate)!==canonical(o.candidate)):(saved.candidate!==null||saved.candidateDigest!==null)))reject('CORRUPT_RECOVERY_LEDGER','Only the authentic completed candidate outcome can establish the immutable candidate',503);
        }
      }if(rows.length<200)break;
    }
    if(!members.has(root.originalInstanceId)||covered.size!==requests.size)reject('CORRUPT_RECOVERY_LEDGER','Recovery ledger contains missing members or omitted original requests',503);
    after='member:';scanned=0;const declaredMembers=new Set<string>();
    for(;;){const rows=store.objectsPage(root.projectId,RECOVERY_KIND,after,200);let ended=false;
      for(const row of rows){after=row.id;if(!row.id.startsWith('member:')){ended=true;break;}if(++scanned>4096)reject('RECOVERY_HISTORY_LIMIT','Recovery membership scan exceeds its bounded read limit',503);const v=record(row.value);if(v.rootRef!==root.ref)continue;
        if(v.schema!=='runtime-recovery-member/v1'||row.id!=='member:'+v.instanceId||v.rootDigest!==root.digest||!members.has(String(v.instanceId)))reject('CORRUPT_RECOVERY_MEMBER','Retained recovery member has no matching immutable instance',503);declaredMembers.add(String(v.instanceId));
      }if(ended||rows.length<200)break;
    }
    if(declaredMembers.size!==members.size)reject('CORRUPT_RECOVERY_MEMBER','Native recovery membership is incomplete',503);
    after='';scanned=0;
    for(;;){const rows=store.objectsPage(root.projectId,'stage-request',after,200);for(const row of rows){after=row.id;if(++scanned>4096)reject('RECOVERY_HISTORY_LIMIT','Original request scan exceeds its bounded read limit',503);const r=record(row.value);if(members.has(String(r.instanceId))&&(!requests.has(row.id)||r.id!==row.id||canonical(requests.get(row.id))!==canonical(r)))reject('CORRUPT_RECOVERY_LEDGER','An immutable original request was omitted from recovery history',503);}if(rows.length<200)break;}

    return value as unknown as RecoveryAttempts;
  }
  function attemptProgress(root:NativeRecoveryRoot,e:RecoveryAttempt):StageProgress{
    const r=store.object(root.projectId,'stage-request',e.requestId) as StageRequest,p=store.object(root.projectId,'stage-progress',e.requestId) as StageProgress|null;
    if(!p||p.requestId!==r.id||!Number.isFinite(Date.parse(p.observedAt)))reject('CORRUPT_RECOVERY_LEDGER','Original recovery progress is missing',503);
    if(p.phase==='DISPATCHING'){if(p.terminal!==false||p.observation!==null||p.observationRef!==null||p.handle!==null||p.reason!==null)reject('CORRUPT_RECOVERY_LEDGER','Initial recovery progress changed',503);return p;}
    const o=p.observation,envelope=p.observationRef?store.object(root.projectId,'stage-observation',p.observationRef):null;
    if(!o||!envelope)reject('CORRUPT_RECOVERY_LEDGER','Original recovery observation is missing',503);const v=record(envelope);exact(v,['schema','requestId','observation','reason','observedAt']);
    if(!['WAITING_AGENT','CI_PENDING','CI_RUNNING','RUNNING','UNKNOWN','COMPLETE','FAILED'].includes(p.phase)||p.terminal!==['COMPLETE','FAILED'].includes(p.phase)||o.phase!==p.phase||o.requestId!==r.id||o.inputDigest!==r.inputDigest||o.adapterDigest!==r.plan.adapterDigest||canonical(o.handle)!==canonical(p.handle)||o.outcome.requestId!==r.id||o.outcome.inputDigest!==r.inputDigest||o.outcome.status!==(p.phase==='COMPLETE'?'COMPLETE':p.phase==='FAILED'?'FAILED':p.phase==='UNKNOWN'?'UNKNOWN':'RUNNING')||v.schema!=='runtime-stage-observation/v1'||v.requestId!==r.id||valueDigest(v)!==p.observationRef||canonical(v.observation)!==canonical(o)||v.reason!==p.reason||v.observedAt!==p.observedAt)reject('CORRUPT_RECOVERY_LEDGER','Recovery progress differs from its immutable original observation',503);
    return p;
  }
  const recovery:RecoveryLineageService={
    create(saved,grant,actor){
      verifyExecution(grant,saved.definition,actor);const d=savedDecision(saved.pins.projectId,grant.evidenceRef),packet=prepared(d.subject,saved.definition,actor,d.principalId),identity=recoveryIdentity(d.subject,packet),objects:StoredObject[]=[];let root:NativeRecoveryRoot;
      if(grant.recoveryRootRef){root=readRecoveryRoot(saved.pins.projectId,grant.recoveryRootRef);verifySuccessor(root,d.subject,saved.definition,actor,packet);}
      else{
        if(store.object(saved.pins.projectId,RECOVERY_KIND,'lineage:'+valueDigest(identity)))reject('RECOVERY_ROOT_REQUIRED','Exact native lineage already has an original root; obtain an explicit reviewed successor link',409);
        requireNewOrigin(saved.pins.projectId,identity,saved.id);
        const ref='recovery-root:'+valueDigest({workspaceId:store.workspaceId,projectId:saved.pins.projectId,instanceId:saved.id,authorityRef:grant.evidenceRef}),body={schema:'runtime-recovery-lineage-root/v1' as const,ref,workspaceId:store.workspaceId,projectId:saved.pins.projectId,identity,identityDigest:valueDigest(identity),originalTargetRef:saved.pins.targetRef,originalInstanceId:saved.id,originalAuthorityRef:grant.evidenceRef,originalAuthorityDigest:saved.pins.authorityDigest,originalPinsDigest:saved.pinsDigest,createdAt:saved.createdAt,deadlineAt:new Date(Math.min(Date.parse(saved.createdAt)+grant.budget.timeoutSeconds*1000,Date.parse(grant.expiresAt))).toISOString(),graphDigest:saved.pins.graphDigest,requirementsDigest:saved.pins.requirementsDigest,budget:grant.budget,stageBudgets:Object.fromEntries(saved.definition.nodes.map(n=>[n.id,stageBudget(saved,n)]))};root={...body,digest:valueDigest(body)};
        const ledger={schema:'runtime-recovery-attempts/v1',rootRef:root.ref,rootDigest:root.digest,entries:[]};
        objects.push({kind:RECOVERY_KIND,id:ref,value:root},{kind:RECOVERY_KIND,id:'lineage:'+root.identityDigest,value:{schema:'runtime-recovery-lineage-index/v1',identityDigest:root.identityDigest,rootRef:root.ref,rootDigest:root.digest}},{kind:RECOVERY_KIND,id:'attempts:'+root.ref,value:{...ledger,digest:valueDigest(ledger)}});
      }
      objects.push({kind:RECOVERY_KIND,id:'member:'+saved.id,value:{schema:'runtime-recovery-member/v1',instanceId:saved.id,pinsDigest:saved.pinsDigest,authorityRef:grant.evidenceRef,rootRef:root.ref,rootDigest:root.digest}},{kind:'instance-authority',id:saved.id,value:{evidenceRef:grant.evidenceRef,recoveryRootRef:root.ref,recoveryRootDigest:root.digest}});return objects;
    },
    admission(saved,grant,stageId,actor,requestId,repair){
      const root=member(saved,grant),fallback={allowed:true,reasons:[] as string[],deadlineAt:new Date(Math.min(Date.parse(saved.createdAt)+saved.pins.budget.timeoutSeconds*1000,Date.parse(grant.expiresAt))).toISOString(),rootRef:null,stageAttempts:saved.stages[stageId]?.attempts??0};if(!root)return fallback;
      rootAuthority(root,actor);const ledger=attempts(root),selected=ledger.entries.filter(e=>e.stageId===stageId),node=saved.definition.nodes.find(n=>n.id===stageId);if(!node||!root.stageBudgets[stageId])reject('RECOVERY_SCOPE_CHANGED','Stage is outside the original root graph',409);
      const local=stageBudget(saved,node),limit=Math.min(root.budget.maxAttempts,root.stageBudgets[stageId].maxAttempts,grant.budget.maxAttempts,local.maxAttempts),reasons:string[]=[],states=ledger.entries.map(e=>({entry:e,progress:attemptProgress(root,e)}));
      if(requestId&&!selected.some(e=>e.requestId===requestId&&e.instanceId===saved.id))reject('RECOVERY_CLAIM_REQUIRED','Dispatch requires its retained original root attempt claim',409);
      if(selected.length>(requestId?limit:limit-1))reasons.push('RECOVERY_ATTEMPTS_EXHAUSTED');
      const failed=states.filter(s=>s.entry.stageId===stageId&&s.progress.phase==='FAILED');
      const repairOrigins=failed.length?readRecoveryFailureOrigins(store,root.projectId,saved.id,stageId,requestId):[];
      const covered=!!repair&&repair.rootRef===root.ref&&repair.rootDigest===root.digest&&repair.originsDigest===valueDigest(repairOrigins)&&repair.candidateDigest===saved.candidateDigest&&/^sha256:[a-f0-9]{64}$/.test(repair.subjectDigest)&&/^sha256:[a-f0-9]{64}$/.test(repair.factsDigest)&&Date.parse(repair.expiresAt)>Date.now();
      for(const {entry,progress:p}of states){if(entry.stageId!==stageId||entry.instanceId===saved.id)continue;if(!p.terminal)reasons.push('RECONCILE_ORIGINAL_REQUEST');else if(p.phase==='FAILED'&&!covered)reasons.push('RECOVERY_REPAIR_EVIDENCE_REQUIRED');}
      const active=states.filter(s=>!s.progress.terminal),activeBounds=active.flatMap(({entry})=>{
        const owner=instance(root.projectId,entry.instanceId),binding=store.object(root.projectId,'instance-authority',owner.id) as {evidenceRef:string},original=execution(savedDecision(root.projectId,binding.evidenceRef)),stage=owner.definition.nodes.find(n=>n.id===entry.stageId);
        if(!stage||valueDigest(original)!==owner.pins.authorityDigest||member(owner,original)?.ref!==root.ref||!root.stageBudgets[entry.stageId])reject('CORRUPT_RECOVERY_MEMBER','Active claims require their exact original native grant and stage bounds',503);
        return[original.budget.maxConcurrency,owner.pins.budget.maxConcurrency,stageBudget(owner,stage).maxConcurrency,root.stageBudgets[entry.stageId].maxConcurrency];
      });
      const inFlight=active.length,concurrency=Math.min(root.budget.maxConcurrency,grant.budget.maxConcurrency,local.maxConcurrency,root.stageBudgets[stageId].maxConcurrency,...activeBounds);
      if(inFlight>(requestId?concurrency:concurrency-1))reasons.push('RECOVERY_CONCURRENCY_EXHAUSTED');
      // A separately reviewed successor actually reruns prior passing work.
      // Its root window and cumulative attempts remain shared, but a completed
      // other member's one-shot request deadline is not this new RC's window.
      // Failed, unresolved and same-instance requests keep their original cutoff.
      const reviewedSuccessor=saved.id!==root.originalInstanceId&&grant.recoveryRootRef===root.ref&&grant.recoveryRootDigest===root.digest;
      const retainedCutoffs=states.filter(({entry,progress:p})=>entry.stageId===stageId&&(!reviewedSuccessor||entry.instanceId===saved.id||p.phase!=='COMPLETE'||p.terminal!==true)).map(({entry})=>Date.parse(entry.deadlineAt));
      const deadline=Math.min(Date.parse(root.deadlineAt),Date.parse(grant.expiresAt),...retainedCutoffs);
      if(deadline<=Date.now())reasons.push('RECOVERY_DEADLINE_EXHAUSTED');return{allowed:reasons.length===0,reasons:[...new Set(reasons)],deadlineAt:new Date(deadline).toISOString(),rootRef:root.ref,rootDigest:root.digest,stageAttempts:selected.length,...(repairOrigins.length?{repairOrigins}:{})};
    },
    claim(saved,grant,r,actor,repair){
      const root=member(saved,grant);if(!root)return[];const admitted=recovery.admission(saved,grant,r.stageId,actor,undefined,repair);if(!admitted.allowed)reject('STAGE_BLOCKED',admitted.reasons.join('; '),409);
      if(r.instanceId!==saved.id||r.pinsDigest!==saved.pinsDigest||r.authorityRef!==grant.evidenceRef||Date.parse(r.deadlineAt)>Date.parse(admitted.deadlineAt))reject('RECOVERY_CLAIM_MISMATCH','New request does not fit the original root',409);
      const prior=attempts(root);if(prior.entries.some(e=>e.requestId===r.id))reject('RECOVERY_CLAIM_MISMATCH','An original request cannot consume another attempt',409);
      const body={schema:'runtime-recovery-attempts/v1' as const,rootRef:root.ref,rootDigest:root.digest,entries:[...prior.entries,{instanceId:saved.id,stageId:r.stageId,requestId:r.id,requestDigest:r.digest,deadlineAt:r.deadlineAt}]};return[{kind:RECOVERY_KIND,id:'attempts:'+root.ref,value:{...body,digest:valueDigest(body)}}];
    },
    inspect(saved){const root=member(saved);if(!root)return null;const ledger=attempts(root);return{rootRef:root.ref,rootDigest:root.digest,originalInstanceId:root.originalInstanceId,originalAuthorityRef:root.originalAuthorityRef,originalTargetRef:root.originalTargetRef,identity:root.identity,deadlineAt:root.deadlineAt,budget:root.budget,attempts:ledger.entries,executionAuthorized:false};},
  };
  const resolveExecution:AuthorityResolver=async(ref,effective,actor,signal)=>{
    signal.throwIfAborted();const d=savedDecision(effective.projectId,ref);current(d,actor);
    const grant=execution(d);if(grant.semanticDigest!==effective.semanticDigest||grant.requirementsDigest!==requiredChecksDigest(effective))reject('AUTHORITY_MISMATCH','Authority does not match these exact semantics',403);return grant;
  };
  function verifyExecution(grant:ExecutionAuthority,effective:EffectiveDefinition,actor:Principal):void{
    const d=savedDecision(effective.projectId,grant.evidenceRef);current(d,actor);
    if(canonical(execution(d))!==canonical(grant)||grant.semanticDigest!==effective.semanticDigest)reject('AUTHORITY_CHANGED','Authority changed before transaction commit',409);
  }
  function resolveRelease(saved:LifecycleInstance,actor:Principal):ReleaseAuthority|undefined{
    const selected=store.object(saved.pins.projectId,'instance-release',saved.id) as {authorityRef:string}|null;
    if(!selected)return undefined;
    const d=savedDecision(saved.pins.projectId,selected.authorityRef);current(d,actor);const grant=release(d);
    if(grant.instanceId!==saved.id||grant.pinsDigest!==saved.pinsDigest||grant.candidateDigest!==saved.candidateDigest)reject('AUTHORITY_MISMATCH','Release decision does not cover this exact instance/candidate',403);return grant;
  }
  function read(actor:Principal,projectId:string,operation:string,input:Record<string,unknown>):unknown{
    authorize(actor,projectId,'read');
    if(operation==='lifecycle.authority.preview')return{...prepare(actor,projectId,input),authorityGranted:false,executionDispatched:false};
    if(operation!=='lifecycle.authority.inspect')reject('UNKNOWN_OPERATION','Unsupported authority operation',404);
    exact(input,['authorityRef']);const d=savedDecision(projectId,input.authorityRef);
    let usable=false,reason:string|null=null;
    try{current(d,actor);usable=true;}catch(e){reason=e&&typeof e==='object'&&'code'in e?String(e.code):'AUTHORITY_UNKNOWN';}
    return{decision:d,revocation:store.object(projectId,'authority-revocation',d.ref),usable,reason,projectRevision:store.revision(projectId),executionDispatched:false};
  }
  function write(actor:Principal,projectId:string,operation:string,input:Record<string,unknown>,requestId:string,expectedRevision:number,reauthorize:()=>Principal):Receipt{
    authorize(actor,projectId,'decision.record');
    if(!AUTHORITY_WRITES.includes(operation as typeof AUTHORITY_WRITES[number]))reject('UNKNOWN_OPERATION','Unsupported authority operation',404);
    exact(input,operation==='lifecycle.authority.record'?['kind','subject','reviewDigest','decision','evidenceRef']:['authorityRef','reason']);
    const mutation={projectId,operation,requestId,expectedRevision,input,permission:'decision.record' as const};
    // Replays are historical receipts, never an assertion of current usability.
    if(store.findReceipt(actor,projectId,requestId))return store.mutate(actor,mutation,()=>{throw new Error('Unreachable replay callback');},reauthorize);
    return store.mutate(actor,mutation,()=>{
      const fresh=reauthorize();authorize(fresh,projectId,'decision.record');
      if(operation==='lifecycle.authority.revoke'){
        const d=savedDecision(projectId,input.authorityRef);policy(selectedDefinition(d),fresh,true);
        if(store.object(projectId,'authority-revocation',d.ref))reject('AUTHORITY_REVOKED','Revocation is already retained',409);
        const reason=string(input.reason,2048);if(containsInlineSecret(reason))reject('INLINE_SECRET','Revocation reasons must not contain secrets');
        const revocation:Revocation={schema:'runtime-authority-revocation/v1',authorityRef:d.ref,revokedBy:fresh.id,principalRevision:fresh.revision,reason,at:new Date().toISOString()};
        return{objects:[{kind:'authority-revocation',id:d.ref,value:revocation}],value:{authorityRef:d.ref,status:'REVOKED',executionDispatched:false},event:{type:'authority-revoked',data:{authorityRef:d.ref,kind:d.kind,instanceId:d.subject.instanceId,revokedBy:fresh.id}}};
      }
      const review=prepare(fresh,projectId,{kind:input.kind,subject:input.subject});
      if(hash(input.reviewDigest)!==review.reviewDigest)reject('AUTHORITY_REVIEW_STALE','Exact subject, policy or principal changed after review',409);
      if(input.decision!=='APPROVE'&&input.decision!=='REJECT')reject('INVALID_DECISION','An explicit APPROVE or REJECT decision is required');
      const content:Omit<DecisionRecord,'ref'>={schema:'runtime-authority-decision/v1',workspaceId:store.workspaceId,projectId,kind:review.kind,subject:review.subject,reviewDigest:review.reviewDigest,policyDigest:review.policyDigest,bindingContextDigest:review.bindingContextDigest,principalId:fresh.id,principalRevision:fresh.revision,choice:input.decision,evidenceRef:string(input.evidenceRef,8192),at:new Date().toISOString()};
      const d:DecisionRecord={...content,ref:'authority:'+valueDigest(content)};verifyEvidence(d);
      const objects:StoredObject[]=[{kind:'authority-decision',id:d.ref,value:d}];
      objects.push({kind:d.kind==='release'?'instance-release':'instance-execution',id:String(d.subject.instanceId),value:{authorityRef:d.ref}});
      return{objects,value:{authorityRef:d.ref,status:d.choice==='APPROVE'?'APPROVED':'REJECTED',kind:d.kind,reviewDigest:d.reviewDigest,instanceId:d.subject.instanceId,executionDispatched:false},event:{type:'authority-recorded',data:{authorityRef:d.ref,kind:d.kind,reviewDigest:d.reviewDigest,instanceId:d.subject.instanceId,choice:d.choice,principalId:fresh.id,executionDispatched:false}}};
    },reauthorize);
  }
  return{read,write,resolveExecution,verifyExecution,resolveRelease,recovery};
}
