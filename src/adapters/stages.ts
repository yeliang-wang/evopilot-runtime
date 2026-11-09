import { randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalEvidence as canonical, canonical as canonicalState, exact, record, reject, ServiceError, string } from '../server/errors.js';
import { authorize, privateFile, type Principal } from '../server/security.js';
import { RuntimeStore } from '../server/store.js';
import {byteDigest} from '../lifecycle/base.js';
import {evidenceValueDigest as valueDigest} from '../server/errors.js';
import { atPath } from '../lifecycle/compiler.js';
import { inspectInstance, type LifecycleInstance } from '../lifecycle/instance.js';
import { isPreparationRef, readPreparationPacket } from '../lifecycle/preparation.js';
import type { StageAdapter, StageObservation, StagePlan, StageProgress, StageRequest, StageRepairSubject, StageRepairFactsV2 } from '../lifecycle/execution.js';
import { nativeSha256, validateNativeReference, type NativeReference, type NativeScope, type NativeValidationContext } from '../../vendor/compatibility/v1/native.mjs';
import { configuredPlatform, readIntegrationConfiguration, type IntegrationConfiguration, type PlatformRegistration } from './config.js';
import { validateResourceDefinition, type BindingConnections } from './bindings.js';
import { ciSourceRef, type PlatformArtifactArchive, type PlatformClient, type PlatformRunObservation, type PlatformRunRequest } from './platforms.js';
import { MAX_ARCHIVE_BYTES, CI_ACCEPTANCE_REPORT_PATH, ciSourceDigest, readArtifactArchive, readCurrentCaseReceipt, verifyCiArtifact, validateCandidateInput, inspectCiAcceptanceReport, unavailableCiAcceptanceReport, type CiAcceptanceReportCapture, type CandidateInput, type VerifiedCiArtifact } from './artifacts.js';
import { ownerRequestDigest, type Owner, type OwnerRequest, type PublishedOwnerAdapter } from './published-owners.js';
import type {SourceTreeObservation} from './source-tree.js';
import type {NativeSourceScope} from '../native-types.js';
import {retainVerificationRun} from './stage-feedback.js';
import {CI_PREPARATION_ADAPTER_ID,CI_PREPARATION_ADAPTER_DIGEST,preparationConfiguration,validatePreparationInput,observePreparedSource,verifyPreparationNativeAction,type CiPreparationInput,type PreparedSourceObservation} from './ci-preparation.js';
import {mappedExtensionCriteria} from './extension-stages.js';
import {readNativeRepairCapture,readNativeRepairHistory,type NativeRepairCapture,type NativeRepairSelection} from './authority.js';

const LEGACY_ID='runtime-ci-owner-stage-v1';
const LEGACY_DIGEST=valueDigest({id:LEGACY_ID,stages:['implementation','candidate','verification'],source:'verified-exact-commit/v1',candidate:'immutable-archive-consumption/v1',workflow:'runtime-ci/v1',owners:'native/v1',observation:'runtime-ci-owner-values/v1',continuation:'explicit-original-request/v1'});
const ADAPTER_ID='runtime-ci-owner-stage-v2';
const ADAPTER_DIGEST=valueDigest({id:ADAPTER_ID,previous:LEGACY_DIGEST,source:'complete-git-tree-and-native-source-scope/v1'});
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
type Pair={criterionId:string;variantId:string};
export interface OwnerPin {ref:string;registrationDigest:string;scope:NativeScope;reference:NativeReference;criteria:Pair[];}
interface CiPlan {
  stageId:string; binding:PlatformRegistration; commit:string; workflowDigest:string;source:VerifiedStageSource;
  expectedChecks:string[]; owners:Record<Owner,OwnerPin>; toolchainLockDigest:string;
  toolchainManifestDigest?:string;
  effectiveConfigDigest:string; candidateDigest:string|null;
  candidateInput?:CandidateInput;
  sourceTree?:SourceTreeObservation;sourceScope?:NativeSourceScope;
  preparation?:{configuration:ReturnType<typeof preparationConfiguration>;input:CiPreparationInput};
  repairComparison?:RepairComparisonPlan;
}
export interface RepairComparisonPlan {schema:'runtime-repair-comparison-policy/v1';resourceDigest:string;owner:OwnerPin;effectiveConfigDigest:string;criteria:{comparable:string;regression:string;progress:string;transient?:string};}
export interface NativeAction {request:OwnerRequest;requestDigest:string;context:NativeValidationContext;observationDigest:string|null;digest:string;}
export interface OwnerResult {owner:Owner;status:'PASS'|'FAIL'|'UNKNOWN';receiptDigest:string|null;reportDigest:string|null;}
export interface VerifiedStageSource {commit:string;evidenceRef:string;}
export interface NativeStageConnections extends Pick<BindingConnections,'owner'|'platform'> {toolchainLockDigest:string;toolchainManifestDigest?:string;source?:(instance:LifecycleInstance,stageId:string,actor:Principal,signal:AbortSignal)=>Promise<VerifiedStageSource>;preparationInput?:(instance:LifecycleInstance,stageId:string,source:VerifiedStageSource,actor:Principal,signal:AbortSignal)=>Promise<CiPreparationInput>;}
const hash=(v:unknown):string=>{const s=string(v,71);if(!/^sha256:[a-f0-9]{64}$/.test(s))reject('STAGE_EVIDENCE_INVALID','Exact evidence digest is required');return s;};
function sourceScope(binding:PlatformRegistration,tree:Omit<SourceTreeObservation,'observedAt'>&{observedAt?:string},commit:string,requirementsDigest:string):NativeSourceScope{
  if(!tree)reject('SOURCE_TREE_REQUIRED','New native evaluations require the complete exact source inventory',409);
  const{schema,factsDigest,observedAt,contentRead,linksFollowed,sourceApproved,...facts}=tree;
  if(schema!=='runtime-source-tree/v1'||factsDigest!==valueDigest(facts)||tree.provider!==binding.provider||tree.projectId!==binding.projectId||tree.repositoryId!==binding.repositoryId||tree.bindingDigest!==valueDigest(binding)||tree.commit!==commit||!Array.isArray(tree.entries)||tree.inventoryDigest!==valueDigest(tree.entries)||tree.treeDigest!==valueDigest({schema:'runtime-git-tree-identity/v1',rootTreeId:tree.rootTreeId,inventoryDigest:tree.inventoryDigest})||contentRead!==false||linksFollowed!==false||sourceApproved!==false)reject('SOURCE_TREE_CHANGED','Native source inventory differs from its registered exact commit',409);
  return{direction:'reverse',locator:binding.host+'/'+binding.repository,revision:commit,treeDigest:tree.treeDigest,inventoryDigest:tree.inventoryDigest,requirementsDigest};
}
function packageJson(pkg:Record<string,unknown>,path:unknown):Record<string,unknown>{
  const text=record(pkg.files)[string(path,512)];if(typeof text!=='string'||Buffer.byteLength(text)>2097152)reject('OWNER_PACKAGE_INVALID','A bounded owner inventory is required');
  try{return record(JSON.parse(text));}catch{return reject('OWNER_PACKAGE_INVALID','Owner inventory is not valid JSON');}
}
export function nativeInventory(pkg:Record<string,unknown>,owner:Owner):Pair[]{
  const entry=record(record(pkg.manifest).entrypoints),result:Pair[]=[];
  const pairs=(ids:unknown,variants:unknown)=>{
    if(!Array.isArray(ids)||!ids.length||!Array.isArray(variants)||!variants.length)reject('OWNER_INVENTORY_INVALID','Native criterion and variant inventory is required');
    for(const id of ids)for(const variant of variants)result.push({criterionId:string(id,256),variantId:string(variant,256)});
  };
  if(owner==='harness'){
    const coverage=packageJson(pkg,entry.coverage);if(!Array.isArray(coverage.requirements))reject('OWNER_INVENTORY_INVALID','Harness requirements are missing');
    for(const raw of coverage.requirements){const r=record(raw);if(!Array.isArray(r.caseIds))reject('OWNER_INVENTORY_INVALID','Harness cases are missing');pairs([r.id],[...r.caseIds,'actual-observation']);}
  }else{
    const cases=packageJson(pkg,entry.cases);if(!Array.isArray(cases.cases))reject('OWNER_INVENTORY_INVALID','Ontology cases are missing');
    for(const raw of cases.cases){const c=record(raw);pairs(c.requirementIds,[c.id]);}
  }
  if(!result.length||result.length>4096||new Set(result.map(p=>p.criterionId+'\0'+p.variantId)).size!==result.length)reject('OWNER_INVENTORY_INVALID','Native inventory is empty, duplicated or too large');
  return result.sort((a,b)=>(a.criterionId+'\0'+a.variantId).localeCompare(b.criterionId+'\0'+b.variantId));
}

/** Shared exact native receipt verifier. Consumers retain the original receipt;
 * neither a declared PASS nor an incomplete criterion set is sufficient. */
export function verifyNativeStageResult(receipt:Record<string,unknown>,kind:Owner,pin:OwnerPin,a:NativeAction,toolchainLockDigest:string,effectiveConfigDigest:string):OwnerResult{
    const result:OwnerResult={owner:kind,status:'UNKNOWN',receiptDigest:null,reportDigest:null};
    if(receipt.requestId!==a.request.requestId||receipt.operation!==a.request.operation||!same(receipt.scope,a.request.scope)||receipt.requestDigest!==nativeSha256({operation:a.request.operation,scope:a.request.scope,input:a.request.input}))reject('OWNER_RECEIPT_MISMATCH','Native receipt differs from the exact original validation request');
    if(receipt.status==='RUNNING'||record(receipt.result??{}).status==='RUNNING'||receipt.status==='UNKNOWN')return result;
    if(receipt.status==='FAILED')return{...result,status:'FAIL',receiptDigest:nativeSha256(receipt)};
    const report=record(receipt.result),{reportDigest,...body}=report;
    if(reportDigest!==nativeSha256(body)||!same(report.context,a.context)||report.toolchainLockDigest!==toolchainLockDigest)reject('OWNER_REPORT_MISMATCH','Native report context, toolchain or content differs');
    const status=kind==='ontology'?report.status:report.qualityStatus;
    if(kind==='ontology'?(report.packageDigest!==pin.reference.digest||!same(report.standardPins,{standardDigest:pin.reference.standardDigest,standardLockDigest:pin.reference.standardLockDigest})):
      (!same(report.reference,pin.reference)||report.observationDigest!==a.observationDigest||report.effectiveConfigDigest!==effectiveConfigDigest))reject('OWNER_REPORT_MISMATCH','Native report asset, configuration or observation differs');
    if(!Array.isArray(report.criteria))reject('OWNER_REPORT_INCOMPLETE','Native report has no fixed criterion results');
    const criteria=report.criteria.map(raw=>{const c=record(raw);exact(c,['criterionId','variantId','status','evidenceDigest']);hash(c.evidenceDigest);if(!['PASS','FAIL','ERROR','UNKNOWN','SKIPPED'].includes(String(c.status)))reject('OWNER_REPORT_INCOMPLETE','Unknown native criterion status');return c;});
    const pairs=criteria.map(c=>({criterionId:string(c.criterionId),variantId:string(c.variantId)})).sort((a,b)=>(a.criterionId+'\0'+a.variantId).localeCompare(b.criterionId+'\0'+b.variantId));
    if(!same(pairs,pin.criteria))reject('OWNER_REPORT_INCOMPLETE','Native report omits or changes a fixed criterion/variant');
    const passed=(kind==='ontology'?status==='CONFORMS':status==='PASS'&&report.executionStatus==='SUCCEEDED')&&criteria.every(c=>c.status==='PASS');
    const failed=['NONCONFORMING','FAIL','ERROR','UNSUPPORTED'].includes(String(status))||criteria.some(c=>['FAIL','ERROR','SKIPPED'].includes(String(c.status)));
    const output:OwnerResult={owner:kind,status:passed?'PASS':failed?'FAIL':'UNKNOWN',receiptDigest:nativeSha256(receipt),reportDigest:String(reportDigest)};
    return output;
}

/** Read the actual original CI/native records. This is an internal protected
 * reader, never an import endpoint or a caller-supplied evaluation result. */
export function readCiRepairEvidence(store:RuntimeStore,r:StageRequest){
  const p=r.plan.parameters as unknown as CiPlan;
  if(r.plan.adapterId!==ADAPTER_ID||r.plan.adapterDigest!==ADAPTER_DIGEST||!['candidate','verification'].includes(r.stageId)||r.digest!==valueDigest((({digest,...body})=>body)(r))||r.planDigest!==valueDigest(r.plan)||r.plan.bindingDigest!==valueDigest(p))reject('REPAIR_CI_ORIGIN','Repair requires the exact retained native CI plan',409);
  const ci=store.object(r.projectId,'ci-stage-artifact',r.id) as VerifiedCiArtifact|null;
  if(ci&&(ci.schema!=='runtime-ci-verified-artifact/v1'||ci.requestId!=='stage-'+valueDigest({workspaceId:r.workspaceId,projectId:r.projectId,requestId:r.id}).slice(7,55)||ci.inputDigest!==r.inputDigest||ci.artifactsVerified!==true))reject('CORRUPT_REPAIR_HISTORY','Original CI artifact identity differs',503);
  const read=(kind:Owner|'comparison')=>{
    const comparison=kind==='comparison',pin=comparison?p.repairComparison?.owner:p.owners[kind],effective=comparison?p.repairComparison?.effectiveConfigDigest:p.effectiveConfigDigest;
    const a=store.object(r.projectId,comparison?'lifecycle-recovery-ledger':'stage-native-action',comparison?'comparison-action:'+r.id:r.id+':'+kind) as NativeAction|null;
    const raw=store.object(r.projectId,comparison?'lifecycle-recovery-ledger':'stage-native-receipt',comparison?'comparison-receipt:'+r.id:r.id+':'+kind);
    if(!a){if(raw)reject('CORRUPT_REPAIR_HISTORY','Native receipt lost its original action',503);return null;}
    if(!pin||!effective||a.digest!==valueDigest((({digest,...body})=>body)(a))||a.requestDigest!==ownerRequestDigest(comparison?'harness':kind,a.request)||a.request.operation!=='native.package.validate'||a.context.claimId!==valueDigest({stageRequestDigest:r.digest})||a.context.inputDigest!==r.inputDigest||a.context.workspaceId!==r.workspaceId||!same(a.request.input.context,a.context)||a.context.scope.projectId!==r.projectId||a.context.requirementSetDigest!==record(p.sourceScope).requirementsDigest||a.request.input.id!==pin.reference.id||a.request.input.version!==pin.reference.version||a.observationDigest!==(comparison||kind==='harness'?nativeSha256(a.request.input.observation):null))reject('CORRUPT_REPAIR_HISTORY','Native action is not the original scoped validation',503);
    if(!raw)return{action:a,receipt:null,result:null};
    const receipt=record(raw),result=verifyNativeStageResult(receipt,comparison?'harness':kind,pin,a,p.toolchainLockDigest,effective);return{action:a,receipt,result};
  };
  return{plan:p,ci,harness:read('harness'),ontology:read('ontology'),comparison:read('comparison')};
}

export interface PublishedExecutionProducer {
  caseId:string;phase:'PRE_RELEASE'|'POST_RELEASE';collectorPath:string;collectorDigest:string;
  workflowDigest:string;catalogDigest:string;maxAgeSeconds:number;
}
/** Original store records and original ZIP bytes only; no caller observation
 * or future completeness declaration is accepted at this boundary. */
export function protectedCiExecutionState(store:RuntimeStore,projectId:string,captureRef:string,caseId:string){
  const original=record(store.object(projectId,'ci-acceptance-capture',captureRef)),{digest,...captureBody}=original;
  if(original.schema!=='runtime-ci-acceptance-capture/v1'||valueDigest(captureBody)!==digest||original.projectId!==projectId||original.workspaceId!==store.workspaceId)reject('QUALIFICATION_ORIGINAL_UNAVAILABLE','Original registered CI capture required',409);
  const request=store.object(projectId,'stage-request',string(original.stageRequestId)) as StageRequest|null;
  if(!request||request.digest!==original.stageRequestDigest||request.planDigest!==original.planDigest||request.pinsDigest!==original.pinsDigest)reject('QUALIFICATION_ORIGINAL_CHANGED','Original stage/capture binding changed',409);
  const view=readCiRepairEvidence(store,request),progress=store.object(projectId,'stage-progress',request.id) as StageProgress|null;
  const observed=progress?.observationRef?store.object(projectId,'stage-observation',progress.observationRef):null;
  const run=store.object(projectId,'ci-stage-observation',request.id) as PlatformRunObservation|null;
  if(!progress||!observed||valueDigest(observed)!==progress.observationRef||!same(record(observed).observation,progress.observation)||!run)reject('QUALIFICATION_ORIGINAL_CHANGED','Exact retained original observation required',409);
  const report=original.report as CiAcceptanceReportCapture,entry=report.cases.find(c=>c.caseId===caseId);
  if(!entry)reject('QUALIFICATION_ORIGINAL_UNAVAILABLE','Original report did not execute this case',409);
  const history:unknown[]=[];let cursor='';
  for(;;){const page=store.objectsPage(projectId,'stage-request',cursor,200);for(const row of page){const r=row.value as StageRequest;if(r.plan?.parameters&&record(r.plan.parameters).workflowDigest===view.plan.workflowDigest&&record(r.plan.parameters).candidateDigest===view.plan.candidateDigest)history.push({id:row.id,request:r,progress:store.object(projectId,'stage-progress',row.id)});if(history.length>4096)reject('QUALIFICATION_HISTORY_LIMIT','Bounded original stage history exceeded',409);}if(page.length<200)break;cursor=page.at(-1)!.id;}
  const archive=view.ci?.archiveDigest;if(!archive)reject('QUALIFICATION_ORIGINAL_UNAVAILABLE','Original retained CI artifact required',409);
  const path=join(store.root,'stage-ci-artifacts',hash(archive).slice(7)+'.zip');privateFile(path);if(realpathSync(path)!==path||lstatSync(path).size>MAX_ARCHIVE_BYTES)reject('CI_ARCHIVE_LIMIT','Original bounded archive required',409);const bytes=readFileSync(path);if(byteDigest(bytes)!==archive)reject('QUALIFICATION_ORIGINAL_CHANGED','Original archive bytes changed',409);
  const facts={original,request,view,progress,observed,run,history,archiveDigest:archive};return{...facts,entry,bytes,stateDigest:valueDigest(facts),historyWatermark:valueDigest(history)};
}
export async function readProtectedCiExecution(store:RuntimeStore,projectId:string,captureRef:string,producer:PublishedExecutionProducer,signal:AbortSignal){
  const state=protectedCiExecutionState(store,projectId,captureRef,producer.caseId),{request,view,progress,run}=state,report=state.original.report as CiAcceptanceReportCapture,origin=record(state.original.origin);
  if(progress.phase!=='COMPLETE'||!progress.terminal||run.status!=='PASSED'||view.ci?.status!=='PASSED'||view.harness?.result?.status!=='PASS'||view.ontology?.result?.status!=='PASS'||report.status!=='OBSERVED'||report.producerBinding!=='MATCHED_ORIGINAL_JOB'||report.workflowSource!=='COMMITTED_BYTES_MATCHED'||report.collectorSource!=='COMMITTED_BYTES_MATCHED'||state.entry.observedOutcome!=='PASS'||!report.report||!view.ci.candidateDigest)reject('QUALIFICATION_EXECUTION_REQUIRED','Actual completed original provider and native evaluations required',409);
  if(origin.ciRequestId!==view.ci.requestId||origin.inputDigest!==request.inputDigest||origin.runId!==run.runId||view.ci.runId!==run.runId||origin.resultDigest!==view.ci.resultDigest||producer.workflowDigest!==view.plan.workflowDigest)reject('QUALIFICATION_ORIGINAL_CHANGED','Original run/candidate/workflow differs',409);
  const files=await readArtifactArchive(state.bytes,signal),reportBytes=files.get(CI_ACCEPTANCE_REPORT_PATH),raw=files.get(state.entry.rawReceipt.path);
  if(!reportBytes||byteDigest(reportBytes)!==report.report.digest||!raw||raw.length!==state.entry.rawReceipt.bytes||byteDigest(raw)!==state.entry.rawReceipt.digest)reject('QUALIFICATION_ORIGINAL_CHANGED','Exact original case/report bytes required',409);
  const parsed=record(JSON.parse(reportBytes.toString('utf8'))),collector=record(parsed.collector),collectorFile=record(collector.file),collectorBytes=files.get(string(collectorFile.path));
  if(collector.sourcePath!==producer.collectorPath||!collectorBytes||byteDigest(collectorBytes)!==producer.collectorDigest||collectorFile.digest!==producer.collectorDigest)reject('QUALIFICATION_COLLECTOR_UNAPPROVED','Actual collector differs from the published producer contract',409);
  const receipt=readCurrentCaseReceipt(raw,{caseId:producer.caseId,sourceCommit:view.plan.commit,candidateDigest:view.ci.candidateDigest,requestId:view.ci.requestId,inputDigest:request.inputDigest});
  if(Date.parse(receipt.startedAt)<Date.parse(request.requestedAt)||Date.parse(receipt.completedAt)>Date.parse(request.deadlineAt))reject('QUALIFICATION_ORIGINAL_CHANGED','Case execution is outside its original request',409);
  signal.throwIfAborted();if(protectedCiExecutionState(store,projectId,captureRef,producer.caseId).stateDigest!==state.stateDigest)reject('QUALIFICATION_ORIGINAL_CHANGED','Original execution changed during byte inspection',409);
  return{stateDigest:state.stateDigest,historyWatermark:state.historyWatermark,request,candidateDigest:view.ci.candidateDigest,rawReceipt:raw.toString('utf8'),...receipt,origin:{kind:'REGISTERED_CI' as const,stageRequestId:request.id,stageRequestDigest:request.digest,provider:view.plan.binding.provider,runId:run.runId!,archiveDigest:view.ci.archiveDigest,reportDigest:report.report.digest,collectorDigest:producer.collectorDigest,catalogDigest:producer.catalogDigest}};
}

function comparisonStatuses(p:RepairComparisonPlan,receipt:Record<string,unknown>|null){
  if(!receipt)return null;const report=record(receipt.result??{});
  if(report.executionStatus!=='SUCCEEDED'||!Array.isArray(report.criteria))return null;
  const criteria=report.criteria.map(record),selected=Object.fromEntries(Object.entries(p.criteria).map(([key,id])=>[key,criteria.find(c=>c.criterionId===id&&c.variantId==='actual-observation')?.status]));
  if(criteria.some(c=>c.variantId!=='actual-observation'&&c.status!=='PASS')||Object.values(selected).some(s=>s!=='PASS'&&s!=='FAIL'))return null;
  return selected as Record<'comparable'|'regression'|'progress','PASS'|'FAIL'>&{transient?:'PASS'|'FAIL'};
}
function comparisonFacts(request:StageRequest,view:ReturnType<typeof readCiRepairEvidence>){
  if(!view.ci||!view.harness?.receipt||!view.ontology?.receipt)reject('REPAIR_COMPARISON_INPUT','An original product observation is unavailable',409);
  const report=record(view.harness.receipt.result??{}),observation=record(view.harness.action.request.input.observation);
  return{request:{id:request.id,digest:request.digest,instanceId:request.instanceId,stageId:request.stageId,pinsDigest:request.pinsDigest,authorityRef:request.authorityRef,planDigest:request.planDigest},source:view.plan.source,sourceTreeDigest:view.plan.sourceTree?.treeDigest??null,ci:{archiveDigest:view.ci.archiveDigest,resultDigest:view.ci.resultDigest,candidateDigest:view.ci.candidateDigest},product:{owner:view.plan.owners.harness,effectiveConfigDigest:view.plan.effectiveConfigDigest,toolchainLockDigest:view.plan.toolchainLockDigest,actionDigest:view.harness.action.digest,receiptDigest:valueDigest(view.harness.receipt),reportDigest:report.reportDigest??null,executionStatus:report.executionStatus??null,qualityStatus:report.qualityStatus??null,criteria:report.criteria??[],observation},ontologyStatus:view.ontology.result?.status??'UNKNOWN'};
}
/** No provider/owner effects: reject unsupported originals before a candidate
 * request can consume authority or transmit any historical observation. */
export function assertCiRepairOrigins(store:RuntimeStore,selection:NativeRepairSelection|NativeRepairCapture,plan:StagePlan):void{
  const p=plan.parameters as unknown as CiPlan,policy=p.repairComparison;
  if(!policy||!selection.origins?.length)reject('REPAIR_POLICY_REQUIRED','Complete original failures and the exact comparison policy are required',409);
  const originals=selection.origins.map(origin=>{
    const view=readCiRepairEvidence(store,origin.request);
    if(view.plan.owners.harness.scope.visibility==='private'&&policy.owner.scope.visibility!=='private')reject('REPAIR_POLICY_SCOPE','A private original observation cannot enter public comparison scope',409);
    if(!same(view.plan.owners,p.owners)||view.plan.effectiveConfigDigest!==p.effectiveConfigDigest||view.plan.toolchainLockDigest!==p.toolchainLockDigest)reject('REPAIR_ORIGIN_UNPROVEN','Original and probe product pins must be comparable before execution',409);
    const report=record(view.harness?.receipt?.result??{}),criteria=report.criteria;
    if(view.ci?.status!=='PASSED'||view.ontology?.result?.status!=='PASS'||report.executionStatus!=='SUCCEEDED'||!Array.isArray(criteria)||!criteria.some(c=>record(c).variantId==='actual-observation'&&record(c).status==='FAIL')||criteria.some(raw=>{const c=record(raw);return c.status!=='PASS'&&(c.status!=='FAIL'||c.variantId!=='actual-observation');}))reject('REPAIR_ORIGIN_UNPROVEN','This comparison path requires original actual product-check failures',409);
    return{originalObservationRef:origin.progress.observationRef,candidateDigest:origin.candidateDigest,...comparisonFacts(origin.request,view)};
  });
  if(Buffer.byteLength(canonical(originals))>1048576)reject('REPAIR_COMPARISON_LIMIT','Original comparison inputs exceed the bounded profile',409);
  try{canonicalState(originals);}catch(error){if(error instanceof ServiceError&&error.code==='INPUT_LIMIT')reject('REPAIR_COMPARISON_LIMIT','Original inputs cannot fit the existing protected action profile',409);throw error;}
}
export function assertCiRepairCaptureProgress(store:RuntimeStore,actor:Principal,originalId:string,projectId:string):void{
  const history=readNativeRepairHistory(store,projectId,originalId,actor);let noProgress=0;
  for(const round of history.rounds){
    if(round.schema!=='runtime-repair-round/v2'){noProgress=0;continue;}
    const r=store.object(projectId,'stage-request',round.requestId) as StageRequest,view=readCiRepairEvidence(store,r),pin=view.plan.repairComparison,status=pin?comparisonStatuses(pin,view.comparison?.receipt??null):null;
    if(!status||status.comparable!=='PASS'){noProgress=0;continue;}
    // A new registration or policy cannot erase two actual completed rounds
    // on the same root/stage path. Unknown rounds break adjacency only.
    noProgress=status.progress==='FAIL'?noProgress+1:0;
    if(noProgress>=2)reject('TWO_NO_PROGRESS_ROUNDS','Two completed comparable native policy rounds proved no progress',409);
  }
}

/** CI-backed candidate and verification composition. Other base/extension
 * actions remain separate fixed adapters, not generic commands supplied by YAML.
 * The service worker only inspects. Codex explicitly requests advance after CI
 * completion to run the already planned owner validations under current permits. */
export function createCiStageAdapter(store:RuntimeStore,configPath:string,connections:NativeStageConnections):StageAdapter{
  hash(connections.toolchainLockDigest);
  if(connections.toolchainManifestDigest!==undefined)hash(connections.toolchainManifestDigest);
  const system=(projectId:string):Principal=>({id:'runtime:stage-adapter',projects:[projectId],permissions:['read'],revision:1,expiresAt:new Date(Date.now()+60000).toISOString()});
  function retain(projectId:string,kind:string,id:string,value:unknown,immutable=false):void{
    const old=store.object(projectId,kind,id);if(old&&same(old,value))return;
    if(old&&immutable)reject('STAGE_EVIDENCE_CHANGED','Original stage evidence cannot be replaced',409);
    store.mutate(system(projectId),{projectId,operation:'lifecycle.stage.evidence',requestId:'stage-fact-'+randomUUID(),expectedRevision:store.revision(projectId),input:{kind,id,digest:valueDigest(value)},permission:'read'},()=>({objects:[{kind,id,value}],value:{kind,id,digest:valueDigest(value)},event:{type:'stage-evidence-retained',data:{kind,id,digest:valueDigest(value)}}}));
  }
  function archiveBytes(archive:PlatformArtifactArchive):void{
    if(byteDigest(archive.bytes)!==archive.archiveDigest)reject('CI_ARTIFACT_INTEGRITY','Downloaded archive digest changed');
    const root=join(store.root,'stage-ci-artifacts');mkdirSync(root,{recursive:true,mode:0o700});
    const stat=lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(root)!==root||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)reject('UNSAFE_STATE','Stage evidence directory is not private');
    const path=join(root,hash(archive.archiveDigest).slice(7)+'.zip');
    if(existsSync(path)){privateFile(path);const s=lstatSync(path);if(s.size!==archive.bytes.length||byteDigest(readFileSync(path))!==archive.archiveDigest)reject('CI_ARTIFACT_INTEGRITY','Retained archive bytes differ');return;}
    const temporary=join(root,randomUUID()+'.pending'),fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{writeFileSync(fd,archive.bytes);fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(temporary,path);const directory=openSync(root,constants.O_RDONLY);try{fsyncSync(directory);}finally{closeSync(directory);}
  }
  function retainAcceptanceCapture(r:StageRequest,p:CiPlan,ci:PlatformRunRequest,run:PlatformRunObservation,report:CiAcceptanceReportCapture,verified:VerifiedCiArtifact|null):void{
    // This path receives observations only from the registered client for the
    // protected original request. It is not an evidence-import operation.
    const jobs=run.jobs.map(j=>({jobId:j.jobId,status:j.status,providerStatus:j.providerStatus,runnerId:j.runnerId})).sort((a,b)=>a.jobId.localeCompare(b.jobId));
    // Fixed provider clients admit GitHub attempt 1 only, and reject GitLab
    // retried jobs. GitLab has no corresponding numeric run-attempt field.
    const providerAttempt=p.binding.provider==='github'?{kind:'GITHUB_RUN_ATTEMPT',runId:run.runId,number:run.runId===null?null:1}:{kind:'GITLAB_ORIGINAL_PIPELINE_JOBS',pipelineId:run.runId,jobIds:jobs.map(j=>j.jobId),retriedJobsRejected:true};
    const body={schema:'runtime-ci-acceptance-capture/v1',workspaceId:r.workspaceId,projectId:r.projectId,instanceId:r.instanceId,stageRequestId:r.id,stageRequestDigest:r.digest,planDigest:r.planDigest,pinsDigest:r.pinsDigest,authorityRef:r.authorityRef,
      origin:{kind:'REGISTERED_CI_OBSERVATION',provider:p.binding.provider,repositoryId:p.binding.repositoryId,bindingDigest:ci.bindingDigest,ciRequestId:ci.requestId,ciRequestDigest:valueDigest(ci),inputDigest:ci.inputDigest,sourceCommit:ci.commit,workflowDigest:ci.workflowDigest,sourceTreeDigest:p.sourceTree?.treeDigest??null,sourceApproved:false,runId:run.runId,runStatus:run.status,providerAttempt,jobsDigest:valueDigest(jobs),jobCount:jobs.length,archive:verified?.sourceArchive??null,resultDigest:verified?.resultDigest??null},
      report,history:'UNKNOWN',inputClosure:'UNKNOWN',qualification:'UNAVAILABLE',reuseAuthorized:false,executionAuthorized:false,releaseAuthorized:false};
    // Content-addressed observations preserve UNKNOWN/failure and later results
    // separately. Repeated reads do not overwrite history or invent a new run.
    const digest=valueDigest(body);retain(r.projectId,'ci-acceptance-capture',r.id+':'+digest.slice(7),{...body,digest},true);
  }
  function configuration(actor:Principal,projectId:string):Readonly<IntegrationConfiguration>{authorize(actor,projectId,'read');return readIntegrationConfiguration(configPath,store.workspaceId);}
  function targetVersion(instance:LifecycleInstance):string|null{
    if(!isPreparationRef(instance.pins.targetRef))return null;
    const packet=readPreparationPacket(store,instance.pins.projectId,instance.pins.targetRef);
    if(packet.input.definitionRevisionId!==instance.pins.definitionRevisionId||packet.input.goalRef!==instance.pins.goalRef||packet.input.loopRef!==instance.pins.loopRef||packet.semanticDigest!==instance.pins.semanticDigest)reject('PREPARATION_SCOPE','CI must use the exact reviewed preparation',409);
    return packet.input.target.version;
  }
  function resource(config:Readonly<IntegrationConfiguration>,instance:LifecycleInstance,role:string){
    const ref=atPath(instance.definition.semantic,role),r=config.resources.find(x=>x.ref===ref&&x.projectId===instance.pins.projectId&&x.role===role);
    if(!r||Date.parse(r.expiresAt)<=Date.now())reject('STAGE_BINDING_UNAVAILABLE','Current scoped stage resource is required');validateResourceDefinition(r);return r;
  }
  function owner(config:Readonly<IntegrationConfiguration>,pin:OwnerPin,kind:Owner,projectId:string):PublishedOwnerAdapter{
    const registration=config.owners.find(x=>x.ref===pin.ref&&x.owner===kind&&x.projects.includes(projectId));if(!registration)reject('OWNER_BINDING_CHANGED','Original scoped owner registration is unavailable');
    const a=connections.owner(pin.ref,config);
    if(a.owner!==kind||a.workspaceId!==store.workspaceId||record(a.capabilities()).registrationDigest!==pin.registrationDigest)reject('OWNER_BINDING_CHANGED','Original owner connection differs');return a;
  }
  async function source(instance:LifecycleInstance,stageId:string,actor:Principal,signal:AbortSignal):Promise<VerifiedStageSource>{
    if(!connections.source)reject('VERIFIED_SOURCE_REQUIRED','CI requires reviewed or completed implementation source evidence',409);
    const value=await connections.source(instance,stageId,actor,signal);exact(record(value),['commit','evidenceRef']);
    if(!/^[a-f0-9]{40}$/.test(string(value.commit,40)))reject('VERIFIED_SOURCE_REQUIRED','Exact verified implementation commit is required',409);string(value.evidenceRef,256);return value;
  }
  async function currentSource(p:CiPlan,instance:LifecycleInstance,actor:Principal,signal:AbortSignal){if(!same(await source(instance,p.stageId,actor,signal),p.source))reject('VERIFIED_SOURCE_CHANGED','Original CI source authority changed',409);}
  function candidateInput(instance:LifecycleInstance,binding:PlatformRegistration,commit:string):CandidateInput|undefined{
    if(!instance.candidate)return undefined;
    const stage=instance.stages.candidate,raw=stage.requestId?store.object(instance.pins.projectId,'stage-candidate-source',stage.requestId):null;
    if(stage.status!=='PASSED'||!raw)reject('CI_CANDIDATE_INPUT_REQUIRED','Original completed candidate archive evidence is required',409);
    const saved=record(raw),{digest,...body}=saved;
    if(saved.schema!=='runtime-candidate-source-evidence/v1'||valueDigest(body)!==digest||saved.requestId!==stage.requestId||saved.pinsDigest!==instance.pinsDigest||saved.outcomeDigest!==stage.outcomeDigest||!same(record(saved.input).manifest,instance.candidate))reject('CI_CANDIDATE_INPUT_INVALID','Candidate archive proof differs from the completed candidate',409);
    return validateCandidateInput(saved.input as CandidateInput,{commit,candidateDigest:instance.candidateDigest},binding.provider,binding.repositoryId);
  }
  async function prepare(instance:LifecycleInstance,stageId:string,actor:Principal,signal:AbortSignal):Promise<StagePlan>{
    inspectInstance(instance);signal.throwIfAborted();
    const preparing=instance.definition.nodes.find(n=>n.id===stageId)?.action?.actionRef==='runtime.operation.ci-prepare';
    if(!preparing&&stageId!=='implementation'&&stageId!=='candidate'&&stageId!=='verification')reject('STAGE_ADAPTER_UNAVAILABLE','This fixed adapter owns implementation, candidate and verification CI only',409);
    if(stageId==='candidate'&&instance.candidate||stageId==='verification'&&!instance.candidate)reject('CANDIDATE_SCOPE','Stage does not match the current immutable candidate');
    const config=configuration(actor,instance.pins.projectId),preparationConfig=preparing?preparationConfiguration(store,config,instance,stageId):null;
    const implementation=record(atPath(instance.definition.semantic,'config.implementation'));
    let binding:PlatformRegistration;
    if(stageId==='implementation'){
      const matches=config.platforms.filter(p=>p.projectId===instance.pins.projectId&&(['provider','host','repository','repositoryId','defaultBranch','credentialRef','workflowPath','pipelinePath','runner'] as const).every(k=>p[k]===implementation[k]));if(matches.length!==1)reject('PLATFORM_SCOPE','Implementation must use one exact configured connection',409);binding=configuredPlatform(config,actor,instance.pins.projectId,matches[0]!.ref);
    }else{const workflow=preparationConfig?.workflow??resource(config,instance,'config.'+stageId+'.'+(stageId==='candidate'?'buildWorkflowRef':'verifyWorkflowRef'));binding=configuredPlatform(config,actor,instance.pins.projectId,string(workflow.definition.platformRef));}
    for(const key of ['provider','host','repository','repositoryId','defaultBranch'] as const)if(binding[key]!==implementation[key])reject('PLATFORM_SCOPE','CI stage uses a different source repository');
    const selected=await source(instance,stageId,actor,signal),current=await connections.platform(binding).revision(actor,selected.commit,signal);
    if(current.commit!==selected.commit||current.sourceSelection!=='exact-commit'||current.bindingDigest!==valueDigest(binding)||current.projectId!==instance.pins.projectId||current.repositoryId!==binding.repositoryId||Date.parse(current.expiresAt)<=Date.now())reject('PLATFORM_SCOPE','CI stage readiness differs from its exact source registration');
    if(instance.candidate&&instance.candidate.sourceDigest!==ciSourceDigest({commit:current.commit} as PlatformRunRequest,binding.provider,binding.repositoryId))reject('CANDIDATE_SOURCE_CHANGED','Verification cannot move the pinned candidate to another source commit');
    const pins={} as Record<Owner,OwnerPin>;let effectiveConfigDigest='';
    for(const kind of ['ontology','harness'] as const){
      const selected=record(atPath(instance.definition.semantic,'assets.'+kind)),mapping=resource(config,instance,'assets.'+kind+'.mappingRef'),reference=mapping.definition.reference as NativeReference;
      validateNativeReference(reference,{product:kind});if(reference.id!==selected.id||reference.version!==selected.version||reference.digest!==selected.digest||reference.visibility!==selected.visibility)reject('OWNER_SCOPE','Stage mapping differs from the selected immutable asset');const adapter=connections.owner(string(selected.adapterRef),config),scope={visibility:reference.visibility,projectId:string(selected.projectId)};
      if(adapter.workspaceId!==store.workspaceId||adapter.owner!==kind)reject('OWNER_SCOPE','Selected owner scope differs');
      const material=await adapter.readPackage(actor,instance.pins.projectId,scope,reference),pkg=record(material.package);
      if(preparationConfig)mappedExtensionCriteria(pkg,kind,preparationConfig.requirements.filter(r=>r.definition.owner===kind));
      pins[kind]={ref:string(selected.adapterRef),registrationDigest:hash(record(adapter.capabilities()).registrationDigest),scope,reference,criteria:nativeInventory(pkg,kind)};
      if(kind==='harness'){const validation=record(material.validation),{reportDigest,...body}=validation;
        if(reportDigest!==nativeSha256(body)||!same(validation.reference,reference)||validation.qualityStatus!=='PASS')reject('OWNER_BASELINE_INVALID','Published Harness configuration validation is unavailable');
        effectiveConfigDigest=hash(validation.effectiveConfigDigest);
      }
    }
    signal.throwIfAborted();
    const originalCandidate=candidateInput(instance,binding,current.commit);
    const tree=await connections.platform(binding).sourceTree(actor,{commit:current.commit},signal),scope=sourceScope(binding,tree,current.commit,instance.pins.requirementsDigest);signal.throwIfAborted();
    let preparation:CiPlan['preparation'];
    if(preparationConfig){
      if(!connections.preparationInput)reject('CI_PREPARATION_INPUT','Original reviewed preparation input resolver is required',409);
      const input=await connections.preparationInput(instance,stageId,selected,actor,signal);validatePreparationInput(input,{stageId,commit:selected.commit,candidateDigest:null},binding.provider);
      if(input.baselineCommit!==preparationConfig.baselineCommit||input.requirementsDigest!==instance.pins.requirementsDigest)reject('CI_PREPARATION_INPUT','Preparation must preserve the original reviewed baseline and requirements',409);
      preparation={configuration:preparationConfig,input};
    }
    let repairComparison:RepairComparisonPlan|undefined;
    const failure=config.resources.find(x=>x.projectId===instance.pins.projectId&&x.ref===atPath(instance.definition.semantic,'config.verification.failurePolicyRef')&&x.role==='config.verification.failurePolicyRef');
    if(failure?.definition.repairComparison!==undefined){
      validateResourceDefinition(failure);if(Date.parse(failure.expiresAt)<=Date.now())reject('REPAIR_POLICY_EXPIRED','Repair comparison registration expired',409);
      const policy=record(failure.definition.repairComparison),reference=validateNativeReference(policy.reference,{product:'harness'}),scope=record(policy.scope) as unknown as NativeScope;
      if(pins.harness.scope.visibility==='private'&&scope.visibility!=='private')reject('REPAIR_POLICY_SCOPE','Private original observations cannot be sent to a public comparison scope',409);
      const registration=config.owners.find(o=>o.ref===policy.adapterRef&&o.owner==='harness'&&o.projects.includes(instance.pins.projectId));if(!registration)reject('REPAIR_POLICY_SCOPE','Repair policy requires the registered project Harness owner',409);
      const adapter=connections.owner(string(policy.adapterRef),config);if(adapter.owner!=='harness'||adapter.workspaceId!==store.workspaceId)reject('REPAIR_POLICY_SCOPE','Repair comparison owner scope differs',409);
      const material=await adapter.readPackage(actor,instance.pins.projectId,scope,reference),validation=record(material.validation),{reportDigest,...body}=validation,criteria=nativeInventory(record(material.package),'harness');
      const actual=criteria.filter(c=>c.variantId==='actual-observation').map(c=>c.criterionId).sort(),required=Object.values(record(policy.criteria)).map(String).sort();
      if(reportDigest!==nativeSha256(body)||!same(validation.reference,reference)||validation.qualityStatus!=='PASS'||!same(actual,required))reject('REPAIR_POLICY_INVALID','Exact published comparison policy and its complete declared actual criteria are required',409);
      repairComparison={schema:'runtime-repair-comparison-policy/v1',resourceDigest:valueDigest(failure),owner:{ref:string(policy.adapterRef),registrationDigest:hash(record(adapter.capabilities()).registrationDigest),scope,reference,criteria},effectiveConfigDigest:hash(validation.effectiveConfigDigest),criteria:policy.criteria as RepairComparisonPlan['criteria']};
    }
    const parameters:CiPlan={stageId,binding,commit:current.commit,workflowDigest:current.workflowDigest,source:selected,sourceTree:tree,sourceScope:scope,...(preparation?{preparation}:{}),...(originalCandidate?{candidateInput:originalCandidate}:{}),...(repairComparison?{repairComparison}:{}),expectedChecks:[...instance.definition.nodes.find(n=>n.id===stageId)!.checks],owners:pins,toolchainLockDigest:connections.toolchainLockDigest,...(connections.toolchainManifestDigest?{toolchainManifestDigest:connections.toolchainManifestDigest}:{}),effectiveConfigDigest,candidateDigest:instance.candidateDigest};
    return{adapterId:preparing?CI_PREPARATION_ADAPTER_ID:ADAPTER_ID,adapterDigest:preparing?CI_PREPARATION_ADAPTER_DIGEST:ADAPTER_DIGEST,action:preparing?'runtime.operation.ci-prepare':'base.'+stageId,bindingDigest:valueDigest(parameters),parameters:parameters as unknown as Record<string,unknown>};
  }
  function plan(r:StageRequest,instance:LifecycleInstance,actor:Principal):{p:CiPlan;config:Readonly<IntegrationConfiguration>;client:PlatformClient;ci:PlatformRunRequest}{
    inspectInstance(instance);const p=r.plan.parameters as unknown as CiPlan,config=configuration(actor,r.projectId);
    const legacy=r.plan.adapterId===LEGACY_ID&&r.plan.adapterDigest===LEGACY_DIGEST&&!p.sourceTree&&!p.sourceScope;
    const preparing=r.plan.adapterId===CI_PREPARATION_ADAPTER_ID&&r.plan.adapterDigest===CI_PREPARATION_ADAPTER_DIGEST;
    const currentAdapter=r.plan.adapterId===ADAPTER_ID&&r.plan.adapterDigest===ADAPTER_DIGEST||preparing;
    if(preparing){if(!p.preparation||!same(p.preparation.configuration,preparationConfiguration(store,config,instance,r.stageId)))reject('CI_PREPARATION_BINDING_CHANGED','Original preparation action, resources and predecessors must remain fixed',409);validatePreparationInput(p.preparation.input,{stageId:r.stageId,commit:p.commit,candidateDigest:p.candidateDigest},p.binding.provider);}else if(p.preparation)reject('STAGE_PLAN_MISMATCH','Non-preparation stage cannot supply preparation inputs',409);
    if(currentAdapter&&(!p.sourceTree||!same(p.sourceScope,sourceScope(p.binding,p.sourceTree,p.commit,instance.pins.requirementsDigest))))reject('SOURCE_TREE_CHANGED','Original native source scope differs from its pinned inventory',409);
    const version=targetVersion(instance);if(version&&instance.candidate&&instance.candidate.version!==version)reject('CANDIDATE_VERSION_MISMATCH','Existing candidate differs from the reviewed target version',409);
    if(p.toolchainManifestDigest!==connections.toolchainManifestDigest)reject('TOOLCHAIN_CHANGED','Original native stage manifest cannot change across service restarts',409);
    if(r.workspaceId!==store.workspaceId||r.projectId!==instance.pins.projectId||r.instanceId!==instance.id||r.pinsDigest!==instance.pinsDigest||!legacy&&!currentAdapter||r.plan.action!==(preparing?'runtime.operation.ci-prepare':'base.'+r.stageId)||r.plan.bindingDigest!==valueDigest(p)||valueDigest(r.plan)!==r.planDigest||p.stageId!==r.stageId||!preparing&&!['implementation','candidate','verification'].includes(p.stageId)||p.source.commit!==p.commit||p.toolchainLockDigest!==connections.toolchainLockDigest||p.candidateDigest!==instance.candidateDigest||!same(p.expectedChecks,instance.definition.nodes.find(n=>n.id===r.stageId)?.checks))reject('STAGE_PLAN_MISMATCH','CI execution differs from its original immutable stage plan');
    const current=configuredPlatform(config,actor,r.projectId,p.binding.ref);if(!same(current,p.binding))reject('PLATFORM_BINDING_CHANGED','Original stage platform registration changed');
    if(!same(p.candidateInput??null,candidateInput(instance,p.binding,p.commit)??null))reject('CI_CANDIDATE_INPUT_INVALID','Original candidate delivery identity cannot change',409);
    for(const kind of ['ontology','harness'] as const)owner(config,p.owners[kind],kind,r.projectId);
    if(p.repairComparison){const failure=config.resources.find(x=>x.projectId===r.projectId&&x.ref===atPath(instance.definition.semantic,'config.verification.failurePolicyRef')&&x.role==='config.verification.failurePolicyRef');if(!failure||valueDigest(failure)!==p.repairComparison.resourceDigest||Date.parse(failure.expiresAt)<=Date.now())reject('REPAIR_POLICY_CHANGED','Original repair comparison registration changed',409);owner(config,p.repairComparison.owner,'harness',r.projectId);}
    const ci:PlatformRunRequest={schema:'runtime-ci-request/v1',requestId:'stage-'+valueDigest({workspaceId:r.workspaceId,projectId:r.projectId,requestId:r.id}).slice(7,55),projectId:r.projectId,bindingDigest:valueDigest(p.binding),commit:p.commit,workflowDigest:p.workflowDigest,inputDigest:r.inputDigest,stageId:r.stageId,candidateDigest:p.candidateDigest,...(p.preparation?{preparationInput:p.preparation.input}:{}),...(p.candidateInput?{candidateInput:p.candidateInput}:{}),requestedAt:r.requestedAt,deadlineAt:r.deadlineAt};
    return{p,config,client:connections.platform(p.binding),ci};
  }
  function observation(r:StageRequest,p:CiPlan,ci:PlatformRunRequest,phase:StageObservation['phase'],checks:StageObservation['outcome']['checks']=[],candidate?:NonNullable<LifecycleInstance['candidate']>):StageObservation{
    return{requestId:r.id,inputDigest:r.inputDigest,adapterDigest:r.plan.adapterDigest,phase,handle:{provider:p.binding.provider,repositoryId:p.binding.repositoryId,requestId:ci.requestId,ref:ciSourceRef(ci)},outcome:{requestId:r.id,inputDigest:r.inputDigest,receiptRef:'runtime:ci-stage/'+r.id,status:phase==='COMPLETE'?'COMPLETE':phase==='FAILED'?'FAILED':phase==='UNKNOWN'?'UNKNOWN':'RUNNING',expiresAt:r.deadlineAt,checks,...(candidate?{candidate}:{})}};
  }
  function pinRun(r:StageRequest,value:PlatformRunObservation):void{
    if(value.runId)retain(r.projectId,'ci-stage-run',r.id,{requestId:value.requestId,runId:value.runId},true);
    retain(r.projectId,'ci-stage-observation',r.id,value);
  }
  function action(r:StageRequest,kind:Owner):NativeAction|null{
    const v=store.object(r.projectId,'stage-native-action',r.id+':'+kind) as NativeAction|null;if(!v)return null;
    const {digest,...body}=v;if(valueDigest(body)!==digest||ownerRequestDigest(kind,v.request)!==v.requestDigest)reject('CORRUPT_STAGE_ACTION','Original native validation request changed',503);return v;
  }
  async function ownerResult(r:StageRequest,p:CiPlan,config:Readonly<IntegrationConfiguration>,kind:Owner,actor:Principal):Promise<OwnerResult>{
    const a=action(r,kind),result:OwnerResult={owner:kind,status:'UNKNOWN',receiptDigest:null,reportDigest:null};if(!a)return result;
    if(p.preparation){const prepared=store.object(r.projectId,'ci-preparation-observation',r.id),artifact=store.object(r.projectId,'ci-stage-artifact',r.id);if(!prepared||!artifact)reject('CORRUPT_CI_PREPARATION','Original preparation facts are required before reading native results',503);verifyPreparationNativeAction(r,kind,a,record(prepared).observation as unknown as PreparedSourceObservation,artifact as VerifiedCiArtifact);}
    let receipt:Record<string,unknown>;try{receipt=record(await owner(config,p.owners[kind],kind,r.projectId).read(actor,r.projectId,{operation:'native.receipt.inspect',scope:a.request.scope,input:{requestId:a.request.requestId}}));}
    catch(error){if(error instanceof ServiceError&&error.code==='NOT_FOUND')return result;throw error;}
    const output=verifyNativeStageResult(receipt,kind,p.owners[kind],a,p.toolchainLockDigest,p.effectiveConfigDigest);
    retain(r.projectId,'stage-native-receipt',r.id+':'+kind,receipt);return output;
  }
  function comparisonInput(r:StageRequest,capture:NativeRepairCapture){
    const current=readCiRepairEvidence(store,r);
    if(capture.schema!=='runtime-repair-capture/v2'||!capture.origins||!current.ci||!current.harness?.receipt||!current.ontology?.receipt)reject('REPAIR_COMPARISON_INPUT','Comparison requires original actual product results',409);
    const value={schema:'runtime-repair-comparison-input/v1',rootRef:capture.rootRef,rootDigest:capture.rootDigest,captureDigest:capture.digest,originsDigest:capture.originsDigest,origins:capture.origins.map(o=>({originalObservationRef:o.progress.observationRef,candidateDigest:o.candidateDigest,...comparisonFacts(o.request,readCiRepairEvidence(store,o.request))})),probe:comparisonFacts(r,current)};
    if(Buffer.byteLength(canonical(value))>1048576)reject('REPAIR_COMPARISON_LIMIT','Comparison input exceeds its fixed bounded native profile',409);return value;
  }
  async function compare(r:StageRequest,p:CiPlan,config:Readonly<IntegrationConfiguration>,actor:Principal,permit:(()=>Promise<Principal>)|undefined,signal:AbortSignal):Promise<'DONE'|'PENDING'> {
    const capture=readNativeRepairCapture(store,r);if(capture?.schema!=='runtime-repair-capture/v2')return'DONE';
    const policy=p.repairComparison;if(!policy||!capture.comparison)reject('REPAIR_POLICY_REQUIRED','Pre-bound candidate repair requires its exact published comparison policy',409);
    let a=store.object(r.projectId,'lifecycle-recovery-ledger','comparison-action:'+r.id) as NativeAction|null;
    assertCiRepairOrigins(store,capture,r.plan);
    const unavailable=store.object(r.projectId,'lifecycle-recovery-ledger','comparison-unavailable:'+r.id);
    if(unavailable){const v=record(unavailable),{digest,...body}=v;if(a||v.schema!=='runtime-repair-comparison-unavailable/v1'||v.requestDigest!==r.digest||v.captureDigest!==capture.digest||v.reason!=='REPAIR_COMPARISON_LIMIT'||digest!==valueDigest(body))reject('CORRUPT_REPAIR_HISTORY','Comparison unavailability differs from its original request',503);return'DONE';}
    const retainUnavailable=()=>{const body={schema:'runtime-repair-comparison-unavailable/v1',requestDigest:r.digest,captureDigest:capture.digest,reason:'REPAIR_COMPARISON_LIMIT'};retain(r.projectId,'lifecycle-recovery-ledger','comparison-unavailable:'+r.id,{...body,digest:valueDigest(body)},true);};
    let values:ReturnType<typeof comparisonInput>;
    try{values=comparisonInput(r,capture);}catch(error){
      if(a||!(error instanceof ServiceError)||error.code!=='REPAIR_COMPARISON_LIMIT')throw error;
      retainUnavailable();return'DONE';
    }
    const adapter=owner(config,policy.owner,'harness',r.projectId),observed=record(readCiRepairEvidence(store,r).harness!.action.request.input.observation);
    const context={...readCiRepairEvidence(store,r).harness!.action.context,effectiveConfigDigest:policy.effectiveConfigDigest};
    const observationInput={...observed,values:{runtimeRepairComparison:values}};
    if(a){
      if(record(a).captureDigest!==capture.digest||record(a).policyDigest!==valueDigest(policy)||record(a).originsDigest!==capture.originsDigest||a.request.requestId!==capture.comparison.expectedRequestId||!same(a.request.input.observation,observationInput)||!same(a.context,context))reject('REPAIR_COMPARISON_CHANGED','Original comparison action or complete origin input changed',503);
    }else{
      if(!permit)return'PENDING';
      const state=record(await adapter.read(actor,r.projectId,{operation:'workspace.inspect',scope:policy.owner.scope,input:{}}));if(!Number.isSafeInteger(state.revision)||Number(state.revision)<0)reject('OWNER_REVISION_INVALID','Comparison owner revision unavailable',409);
      const request:OwnerRequest={operation:'native.package.validate',scope:policy.owner.scope,input:{id:policy.owner.reference.id,version:policy.owner.reference.version,context,observation:observationInput},requestId:capture.comparison.expectedRequestId,expectedRevision:Number(state.revision)};
      const body={request,requestDigest:ownerRequestDigest('harness',request),context,observationDigest:nativeSha256(observationInput),captureDigest:capture.digest,policyDigest:valueDigest(policy),originsDigest:capture.originsDigest};a={...body,digest:valueDigest(body)};
      try{canonicalState(a);}catch(error){if(!(error instanceof ServiceError)||error.code!=='INPUT_LIMIT')throw error;retainUnavailable();return'DONE';}
      signal.throwIfAborted();retain(r.projectId,'lifecycle-recovery-ledger','comparison-action:'+r.id,a,true);
      const fresh=await permit();signal.throwIfAborted();await adapter.mutate(fresh,r.projectId,request,{projectId:r.projectId,owner:'harness',requestDigest:a.requestDigest,authorityRef:r.authorityRef,expiresAt:r.deadlineAt});
    }
    let receipt:Record<string,unknown>;
    try{receipt=record(await adapter.read(actor,r.projectId,{operation:'native.receipt.inspect',scope:policy.owner.scope,input:{requestId:a.request.requestId}}));}
    catch(error){if(error instanceof ServiceError&&['NOT_FOUND','RECEIPT_NOT_FOUND'].includes(error.code))return'PENDING';throw error;}
    const result=verifyNativeStageResult(receipt,'harness',policy.owner,a,p.toolchainLockDigest,policy.effectiveConfigDigest);if(result.status==='UNKNOWN')return'PENDING';
    retain(r.projectId,'lifecycle-recovery-ledger','comparison-receipt:'+r.id,receipt,true);return'DONE';
  }
  async function preparedSource(r:StageRequest,p:CiPlan,verified:VerifiedCiArtifact,client:PlatformClient,actor:Principal,signal:AbortSignal):Promise<{digest:string;observation:PreparedSourceObservation}|null>{
    if(!p.preparation)return null;if(!verified.preparationOutput)reject('CI_PREPARATION_OUTPUT','Exact preparation CI output is required',409);
    const saved=store.object(r.projectId,'ci-preparation-observation',r.id) as {digest:string;requestDigest:string;artifactDigest:string;observation:PreparedSourceObservation}|null;
    if(saved){const{digest,...body}=saved;if(digest!==valueDigest(body)||saved.requestDigest!==r.digest||saved.artifactDigest!==valueDigest(verified)||saved.observation.inputDigest!==valueDigest(p.preparation.input)||saved.observation.outputDigest!==valueDigest(verified.preparationOutput))reject('CORRUPT_CI_PREPARATION','Original independent preparation observation changed',503);return saved;}
    const observation=await observePreparedSource(client,p.binding,actor,p.preparation.input,verified.preparationOutput,signal),body={schema:'runtime-retained-preparation-observation/v1',requestDigest:r.digest,artifactDigest:valueDigest(verified),observation},value={...body,digest:valueDigest(body)};
    signal.throwIfAborted();retain(r.projectId,'ci-preparation-observation',r.id,value,true);return value;
  }
  async function inspect(r:StageRequest,instance:LifecycleInstance,_progress:StageProgress,actor:Principal,signal:AbortSignal):Promise<StageObservation>{
    const {p,config,client,ci}=plan(r,instance,actor),known=store.object(r.projectId,'ci-stage-run',r.id) as {runId:string}|null;
    const run=await client.run(actor,ci,known?.runId??null,signal);pinRun(r,run);
    if(run.status==='PENDING'||run.status==='RUNNING'){retainAcceptanceCapture(r,p,ci,run,unavailableCiAcceptanceReport('RUN_'+run.status),null);return observation(r,p,ci,run.status==='PENDING'?'CI_PENDING':'CI_RUNNING');}
    if(run.status==='UNKNOWN'||!run.runId){retainAcceptanceCapture(r,p,ci,run,unavailableCiAcceptanceReport('RUN_UNKNOWN'),null);return observation(r,p,ci,'UNKNOWN');}
    // Preserve the original failure without requiring a new download or
    // classifying its cause. Case coverage/history remain explicitly unknown.
    if(run.status==='FAILED'){retainAcceptanceCapture(r,p,ci,run,unavailableCiAcceptanceReport('FAILED_RUN_REPORT_UNAVAILABLE'),null);return observation(r,p,ci,'FAILED');}
    const archive=await client.artifact(actor,ci,run.runId,signal),verified=await verifyCiArtifact(archive,ci,p.expectedChecks,signal);archiveBytes(archive);
    retain(r.projectId,'ci-stage-artifact',r.id,verified,true);
    const captured=await inspectCiAcceptanceReport(archive,ci,verified,{run,workflowPath:p.binding.workflowPath??p.binding.pipelinePath!,requirementsDigest:instance.pins.requirementsDigest,...(p.sourceTree?{sourceTree:p.sourceTree}:{})},signal);
    signal.throwIfAborted();retainAcceptanceCapture(r,p,ci,run,captured,verified);
    const version=targetVersion(instance);
    if(version&&verified.candidate&&verified.candidate.version!==version){
      const evidence={schema:'runtime-ci-target-mismatch/v1',requestId:r.id,inputDigest:r.inputDigest,preparationRef:instance.pins.targetRef,expectedVersion:version,actualVersion:verified.candidate.version,artifact:verified},ref=valueDigest(evidence);retain(r.projectId,'ci-stage-evidence',ref,evidence,true);
      return observation(r,p,ci,'FAILED',p.expectedChecks.map(id=>({id,status:id==='base.candidate.immutable-manifest'?'FAIL':'UNKNOWN',evidenceRef:ref})));
    }
    if(verified.status==='FAILED')return observation(r,p,ci,'FAILED',verified.checks.map(c=>({id:c.id,status:c.status,evidenceRef:verified.evidenceRef})));
    if(verified.status!=='PASSED')return observation(r,p,ci,'UNKNOWN');
    const prepared=await preparedSource(r,p,verified,client,actor,signal);
    const owners=await Promise.all((['ontology','harness'] as const).map(kind=>ownerResult(r,p,config,kind,actor)));signal.throwIfAborted();
    const failed=owners.some(o=>o.status==='FAIL'),complete=owners.every(o=>o.status==='PASS');
    if(complete)await currentSource(p,instance,actor,signal);
    const evidence={schema:'runtime-ci-stage-evidence/v1',requestId:r.id,inputDigest:r.inputDigest,ci:verified,owners,...(prepared?{preparationRef:prepared.digest}:{}),softwareRelease:false},ref=valueDigest(evidence);retain(r.projectId,'ci-stage-evidence',ref,evidence,true);
    if(r.stageId==='verification'&&r.plan.adapterId===ADAPTER_ID&&owners.every(o=>o.status!=='UNKNOWN'))retainVerificationRun(store,r,instance,ref,actor);
    const checks=verified.checks.map(c=>({id:c.id,status:failed?'FAIL' as const:complete?'PASS' as const:'UNKNOWN' as const,evidenceRef:ref}));
    const result=observation(r,p,ci,failed?'FAILED':complete?'COMPLETE':'RUNNING',checks,complete&&p.stageId==='candidate'?verified.candidate!:undefined);
    if(complete&&prepared){const body={schema:'runtime-prepared-source/v1',requestDigest:r.digest,pinsDigest:r.pinsDigest,outcomeDigest:valueDigest(result.outcome),observationDigest:prepared.digest,evidenceRef:ref,input:p.source,output:{commit:prepared.observation.source.commit,evidenceRef:prepared.digest}};retain(r.projectId,'ci-preparation-source',r.id,{...body,digest:valueDigest(body)},true);}
    if(complete&&p.stageId==='candidate'){
      const input:CandidateInput={schema:'runtime-ci-candidate-input/v1',manifest:verified.candidate!,archive:verified.sourceArchive};
      validateCandidateInput(input,{commit:p.commit,candidateDigest:verified.candidateDigest},p.binding.provider,p.binding.repositoryId);
      const body={schema:'runtime-candidate-source-evidence/v1',requestId:r.id,requestDigest:r.digest,pinsDigest:r.pinsDigest,outcomeDigest:valueDigest(result.outcome),input};retain(r.projectId,'stage-candidate-source',r.id,{...body,digest:valueDigest(body)},true);
    }
    if(readNativeRepairCapture(store,r)?.schema==='runtime-repair-capture/v2'&&owners.every(o=>o.status!=='UNKNOWN')&&await compare(r,p,config,actor,undefined,signal)==='PENDING')return observation(r,p,ci,'RUNNING');
    return result;
  }
  async function advance(r:StageRequest,instance:LifecycleInstance,progress:StageProgress,permit:()=>Promise<Principal>,signal:AbortSignal):Promise<StageObservation>{
    const actor=await permit(),{p,config,ci,client}=plan(r,instance,actor),observed=await inspect(r,instance,progress,actor,signal);
    if(observed.phase!=='RUNNING')return observed;
    const verified=store.object(r.projectId,'ci-stage-artifact',r.id) as VerifiedCiArtifact|null;if(!verified||verified.status!=='PASSED')reject('CI_EVIDENCE_REQUIRED','Owner validation waits for the exact complete CI artifact');
    const path=join(store.root,'stage-ci-artifacts',hash(verified.archiveDigest).slice(7)+'.zip');privateFile(path);if(lstatSync(path).size>MAX_ARCHIVE_BYTES)reject('CI_ARCHIVE_LIMIT','Retained archive exceeds its fixed byte bound');const bytes=readFileSync(path);
    if(byteDigest(bytes)!==verified.archiveDigest)reject('CI_ARTIFACT_INTEGRITY','Retained original archive changed');
    const files=await readArtifactArchive(bytes,signal),raw=files.get('evidence/owner-values.json');if(!raw||raw.length>1048576)reject('OWNER_OBSERVATION_MISSING','CI must retain its rule input values as declared evidence/owner-values.json');
    let values:Record<string,unknown>;try{values=record(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)));}catch{return reject('OWNER_OBSERVATION_INVALID','CI owner values must be bounded UTF-8 JSON');}
    exact(values,['schema','values']);if(values.schema!=='runtime-ci-owner-values/v1')reject('OWNER_OBSERVATION_INVALID','CI owner values use a fixed input contract');record(values.values);
    const prepared=await preparedSource(r,p,verified,client,actor,signal),nativeScope=prepared?sourceScope(p.binding,prepared.observation.sourceTree,prepared.observation.source.commit,instance.pins.requirementsDigest):p.sourceScope;
    const nativeCommit=prepared?.observation.source.commit??p.commit;
    if(prepared){if(Object.hasOwn(record(values.values),'runtimePreparation'))reject('CI_PREPARATION_OBSERVATION','CI cannot impersonate Runtime preparation source facts',409);values.values={...record(values.values),runtimePreparation:{input:p.preparation!.input,output:verified.preparationOutput,verifiedSource:prepared.observation,configuration:p.preparation!.configuration}};}
    const context:NativeValidationContext={workspaceId:r.workspaceId,scope:{visibility:'private',projectId:r.projectId},projectCandidateDigest:verified.candidateDigest??instance.pinsDigest,claimId:valueDigest({stageRequestDigest:r.digest}),inputDigest:r.inputDigest,effectiveConfigDigest:p.effectiveConfigDigest,sourceScopeDigest:nativeScope?nativeSha256(nativeScope):ciSourceDigest(ci,p.binding.provider,p.binding.repositoryId),requirementSetDigest:instance.pins.requirementsDigest};
    const observationInput={schema:'evopilot-observation/v1',origin:'execution-result',source:{revision:nativeCommit,digest:nativeScope?.treeDigest??context.sourceScopeDigest},values:values.values,collectionReceiptRef:{id:'ci-stage:'+r.id,digest:verified.resultDigest,claimId:context.claimId},sourceScopeDigest:context.sourceScopeDigest};
    for(const kind of ['ontology','harness'] as const){
      signal.throwIfAborted();if(action(r,kind))continue;
      const a=owner(config,p.owners[kind],kind,r.projectId),scope=p.owners[kind].scope,state=record(await a.read(actor,r.projectId,{operation:'workspace.inspect',scope,input:{}}));
      if(!Number.isSafeInteger(state.revision)||Number(state.revision)<0)reject('OWNER_REVISION_INVALID','Native owner revision is unavailable');
      const request:OwnerRequest={operation:'native.package.validate',scope,input:{id:p.owners[kind].reference.id,version:p.owners[kind].reference.version,context,...(kind==='harness'?{observation:observationInput}:{})},requestId:'stage-native-'+valueDigest({requestId:r.id,projectId:r.projectId,owner:kind}).slice(7,55),expectedRevision:Number(state.revision)};
      const body={request,requestDigest:ownerRequestDigest(kind,request),context,observationDigest:kind==='harness'?nativeSha256(observationInput):null};retain(r.projectId,'stage-native-action',r.id+':'+kind,{...body,digest:valueDigest(body)},true);
      await currentSource(p,instance,actor,signal);signal.throwIfAborted();
      const fresh=await permit();signal.throwIfAborted();authorize(fresh,r.projectId,'execution.request');
      if(fresh.id!==r.initiatedBy.id||fresh.revision!==r.initiatedBy.revision)reject('AUTHORITY_CHANGED','Native continuation requires the original current principal');
      await a.mutate(fresh,r.projectId,request,{projectId:r.projectId,owner:kind,requestDigest:body.requestDigest,authorityRef:r.authorityRef,expiresAt:r.deadlineAt});
    }
    if(readNativeRepairCapture(store,r)?.schema==='runtime-repair-capture/v2'){
      // The ordinary inspector authenticates and retains the product receipts
      // before the separate comparison can consume them.
      await inspect(r,instance,progress,actor,signal);const results=readCiRepairEvidence(store,r);
      if(results.harness?.receipt&&results.ontology?.receipt&&results.harness.result?.status!=='UNKNOWN'&&results.ontology.result?.status!=='UNKNOWN')await compare(r,p,config,actor,permit,signal);
    }
    return inspect(r,instance,progress,actor,signal);
  }
  async function verifyRepair(subject:StageRepairSubject,actor:Principal,signal:AbortSignal):Promise<StageRepairFactsV2|null>{
    if(subject.schema!=='runtime-stage-repair-subject/v2'||subject.stageId!=='verification'||!subject.candidateDigest||!subject.origins.length)return null;
    authorize(actor,subject.projectId,'execution.request');signal.throwIfAborted();
    const current=subject.preparedPlan.parameters as unknown as CiPlan,policy=current.repairComparison;
    if(subject.preparedPlan.adapterId!==ADAPTER_ID||!policy||current.candidateDigest!==subject.candidateDigest)return null;
    const history=readNativeRepairHistory(store,subject.projectId,subject.origins[0].request.id,actor);
    if(history.rootRef!==subject.root.ref||history.rootDigest!==subject.root.digest||history.open.length)return null;
    assertCiRepairCaptureProgress(store,actor,subject.origins[0].request.id,subject.projectId);
    const rounds:StageRepairFactsV2['rounds']=[],originDigest=valueDigest(subject.origins);let chosen:{capture:NativeRepairCapture;round:typeof history.rounds[number];view:ReturnType<typeof readCiRepairEvidence>;request:StageRequest}|null=null;
    for(const round of history.rounds){
      if(round.schema!=='runtime-repair-round/v2')return null;
      const capture=history.captures.find(c=>c.verificationRequestId===round.requestId)!;const r=store.object(subject.projectId,'stage-request',round.requestId) as StageRequest,view=readCiRepairEvidence(store,r),status=view.plan.repairComparison?comparisonStatuses(view.plan.repairComparison,view.comparison?.receipt??null):null;
      const before=valueDigest({originsDigest:capture.originsDigest,policy:view.plan.repairComparison??null});
      rounds.push({evidenceRef:'runtime:repair-round/'+r.id,beforeFactsDigest:before,afterFactsDigest:status?.comparable==='PASS'&&status.progress==='FAIL'?before:valueDigest({round:round.digest,status})});
      if(capture.schema!=='runtime-repair-capture/v2'||capture.originsDigest!==originDigest||r.instanceId!==subject.instanceId||round.outcome!=='PASS'||!same(view.plan.repairComparison,policy)||!status||status.comparable!=='PASS'||status.regression!=='PASS'||!view.ci?.candidate||!view.harness?.receipt||!view.comparison?.receipt||view.ontology?.result?.status!=='PASS')continue;
      const candidate=round.candidateEvidence?.candidate,progress=store.object(subject.projectId,'stage-progress',r.id) as StageProgress,manifest=progress.observation?.outcome.candidate,source=store.object(subject.projectId,'stage-candidate-source',r.id);
      if(!candidate||!manifest||!source||progress.phase!=='COMPLETE'||valueDigest(manifest)!==subject.candidateDigest||view.ci.candidateDigest!==subject.candidateDigest||valueDigest(view.ci.candidate)!==subject.candidateDigest||view.harness.action.context.projectCandidateDigest!==subject.candidateDigest||candidate.manifestDigest!==subject.candidateDigest||candidate.outcomeDigest!==valueDigest(progress.observation!.outcome)||candidate.sourceEvidenceDigest!==record(source).digest||record(source).outcomeDigest!==candidate.outcomeDigest||record(source).digest!==valueDigest((({digest,...body})=>body)(record(source))))reject('REPAIR_CANDIDATE_CHANGED','Completed probe candidate must match its own outcome, CI archive and native action',409);
      if(!same(record(view.comparison.action.request.input.observation).values,{runtimeRepairComparison:comparisonInput(r,capture)})||record(view.comparison.action).captureDigest!==capture.digest||record(view.comparison.action).originsDigest!==originDigest||record(view.comparison.action).policyDigest!==valueDigest(policy)||view.comparison.action.request.requestId!==capture.comparison?.expectedRequestId||round.candidateEvidence?.comparison?.actionDigest!==view.comparison.action.digest||round.candidateEvidence?.comparison?.receiptDigest!==valueDigest(view.comparison.receipt)||round.candidateEvidence?.product?.actionDigest!==view.harness.action.digest||round.candidateEvidence?.product?.receiptDigest!==valueDigest(view.harness.receipt)||!same(round.candidateEvidence?.ci,{archiveDigest:view.ci.archiveDigest,resultDigest:view.ci.resultDigest,candidateDigest:view.ci.candidateDigest}))reject('REPAIR_COMPARISON_CHANGED','Native comparison must certify the exact complete original input',503);
      chosen={capture,round,view,request:r};
    }
    if(!chosen)return null;
    // Both sides describe the same fault-relevant inputs. Request, receipt and
    // comparison action identities authenticate evidence; they are not repairs.
    const inputs=(p:CiPlan,candidateDigest:string,observation:unknown)=>({sourceDigest:p.sourceTree!.treeDigest,candidateDigest,toolchainDigest:valueDigest({lock:p.toolchainLockDigest,manifest:p.toolchainManifestDigest??null}),dependencyClosureDigest:valueDigest({owners:p.owners,binding:p.binding,effectiveConfigDigest:p.effectiveConfigDigest,values:record(observation).values})});
    const selected=chosen,after=inputs(current,subject.candidateDigest,selected.view.harness!.action.request.input.observation);
    if(selected.view.plan.commit!==current.commit||selected.view.plan.sourceTree?.treeDigest!==current.sourceTree?.treeDigest||!same(selected.view.plan.binding,current.binding)||!same(selected.view.plan.owners,current.owners)||selected.view.plan.effectiveConfigDigest!==current.effectiveConfigDigest||selected.view.plan.toolchainLockDigest!==current.toolchainLockDigest||selected.view.plan.toolchainManifestDigest!==current.toolchainManifestDigest)return null;
    const currentReport=record(selected.view.harness!.receipt!.result),currentCriteria=(currentReport.criteria as Record<string,unknown>[]);
    if(currentReport.executionStatus!=='SUCCEEDED')return null;
    const origins:StageRepairFactsV2['origins']=[];
    for(const origin of subject.origins){
      const original=readCiRepairEvidence(store,origin.request),report=record(original.harness?.receipt?.result??{}),criteria=report.criteria;
      if(origin.request.stageId!=='verification'||!origin.candidateDigest||!original.ci||original.ci.status!=='PASSED'||original.ontology?.result?.status!=='PASS'||!original.harness?.receipt||report.executionStatus!=='SUCCEEDED'||!Array.isArray(criteria)||criteria.some(raw=>{const c=record(raw);return c.status!=='PASS'&&(c.status!=='FAIL'||c.variantId!=='actual-observation');})||original.harness.action.context.projectCandidateDigest!==origin.candidateDigest||!same(original.plan.owners,current.owners)||original.plan.effectiveConfigDigest!==current.effectiveConfigDigest||original.plan.toolchainLockDigest!==current.toolchainLockDigest)return null;
      const failedCriteria=criteria.map(record).filter(c=>c.status==='FAIL').map(c=>({criterionId:string(c.criterionId),variantId:'actual-observation' as const,evidenceDigest:hash(c.evidenceDigest)}));
      if(!failedCriteria.length||failedCriteria.some(c=>!currentCriteria.some(x=>x.criterionId===c.criterionId&&x.variantId==='actual-observation'&&x.status==='PASS')))return null;
      origins.push({requestId:origin.request.id,requestDigest:origin.request.digest,observationRef:origin.progress.observationRef!,before:inputs(original.plan,origin.candidateDigest,original.harness.action.request.input.observation),failedCriteria,coverage:failedCriteria.map(c=>({criterionId:c.criterionId,captureDigest:selected.capture.digest,roundDigest:selected.round.digest,nativeActionDigest:selected.view.harness!.action.digest,nativeReceiptDigest:valueDigest(selected.view.harness!.receipt),comparisonActionDigest:selected.view.comparison!.action.digest,comparisonReceiptDigest:valueDigest(selected.view.comparison!.receipt),probeCandidateDigest:subject.candidateDigest!}))});
    }
    signal.throwIfAborted();return{schema:'runtime-stage-repair-facts/v2',subjectDigest:valueDigest(subject),rootRef:subject.root.ref,rootDigest:subject.root.digest,originsDigest:originDigest,failureClass:comparisonStatuses(policy,selected.view.comparison!.receipt)?.transient==='PASS'?'TRANSIENT':'DETERMINISTIC',failureKind:'FIXED_PRODUCT_CHECK',origins,after,rounds,evidenceRef:'runtime:repair-round/'+selected.request.id,expiresAt:new Date(Math.min(...subject.origins.map(o=>Date.parse(o.request.deadlineAt)),Date.parse(selected.capture.deadlineAt))).toISOString()};
  }
  return{prepare,inspect,reconcileAdvance:inspect,advance,verifyRepair,async dispatch(r,instance,permit,signal){
    const actor=await permit(),{p,client,ci}=plan(r,instance,actor);
    await currentSource(p,instance,actor,signal);signal.throwIfAborted();
    // The execution core persisted the original StageRequest before entering
    // here. Platform clients independently refuse replacement/ref redispatch.
    const run=await client.dispatch(ci,async requested=>{if(!same(requested,ci))reject('CI_REQUEST_MISMATCH','CI permit cannot change its original request');return permit();},signal);pinRun(r,run);
    if(run.status==='PENDING'||run.status==='RUNNING'||run.status==='UNKNOWN'){retainAcceptanceCapture(r,p,ci,run,unavailableCiAcceptanceReport('RUN_'+run.status),null);return observation(r,p,ci,run.status==='PENDING'?'CI_PENDING':run.status==='RUNNING'?'CI_RUNNING':'UNKNOWN');}
    return inspect(r,instance,{requestId:r.id,phase:'RUNNING',terminal:false,handle:null,observation:null,observationRef:null,reason:null,observedAt:new Date().toISOString()},actor,signal);
  }};
}
