import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {closeSync,constants,fstatSync,openSync,readFileSync,realpathSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {evaluateGovernance} from '../governance.js';
import {valueDigest} from '../lifecycle/base.js';
import {assertNativeQualificationService,type NativeQualificationService} from '../lifecycle/evidence-qualification.js';
import type {Principal} from '../server/security.js';
import type {NativeEvidenceQualification} from '../lifecycle/correction-contract.js';

interface FileReference {ref:string;sha256:string;}
export interface AcceptanceEvidenceRequest {
  schema:'runtime-release-evidence-input/v1';sourceCommit:string;
  manifest:FileReference;archive:FileReference;sourceRevision:FileReference;
  reports:{scenario:string;report:FileReference}[];
}
export interface CorrectionAcceptanceEvidenceRequest extends Omit<AcceptanceEvidenceRequest,'schema'|'reports'> {
  schema:'runtime-correction-evidence-input/v1';report:FileReference;
}
export interface E20PrerequisiteEvidenceRequest extends Omit<AcceptanceEvidenceRequest,'schema'> {
  schema:'runtime-e20-prerequisite-evidence-input/v1';
}
export interface QualifiedAcceptanceEvidenceRequest extends Omit<AcceptanceEvidenceRequest,'schema'|'reports'> {
  schema:'runtime-qualified-release-evidence-input/v2';scope:{workspaceId:string;projectId:string};
  qualifications:{caseId:string;actionRef:string;actionDigest:string}[];
}
type ObjectValue=Record<string,unknown>;
const sha=(bytes:Buffer):string=>createHash('sha256').update(bytes).digest('hex');
const reject=(message:string):never=>{throw new Error('RELEASE_EVIDENCE: '+message);};
const requireValue=(condition:unknown,message:string):void=>{if(!condition)reject(message);};
const object=(value:unknown):ObjectValue=>value&&typeof value==='object'&&!Array.isArray(value)?value as ObjectValue:reject('Expected an object');
const array=(value:unknown):unknown[]=>Array.isArray(value)?value:reject('Expected an array');
const string=(value:unknown):string=>typeof value==='string'&&value.length>0?value:reject('Expected a nonempty string');
const exact=(value:ObjectValue,keys:string[]):void=>requireValue(isDeepStrictEqual(Object.keys(value).sort(),keys.sort()),'Unexpected input fields');
const digest=(value:unknown):string=>{const d=string(value);requireValue(/^[a-f0-9]{64}$/.test(d),'Invalid SHA256');return d;};
function read(path:string,maximum:number,privateFile=true):Buffer {
  requireValue(isAbsolute(path)&&resolve(path)===path&&realpathSync(path)===path,'Use canonical evidence paths without symlinks');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const before=fstatSync(fd);
    requireValue(before.isFile()&&before.nlink===1&&before.size<=maximum,'Invalid bounded evidence file');
    if(privateFile)requireValue((before.mode&0o077)===0&&before.uid===process.getuid?.(),'Evidence must be private and owned by this user');
    const bytes=readFileSync(fd),after=fstatSync(fd);
    requireValue(bytes.length===before.size&&after.size===before.size&&after.mtimeMs===before.mtimeMs&&after.ctimeMs===before.ctimeMs,'Evidence changed during the audit');
    return bytes;
  }finally{closeSync(fd);}
}
function pinned(value:unknown,maximum:number):Buffer {
  const ref=object(value);exact(ref,['ref','sha256']);const bytes=read(string(ref.ref),maximum);
  requireValue(sha(bytes)===digest(ref.sha256),'Reviewed evidence file changed');return bytes;
}
const parse=(bytes:Buffer):ObjectValue=>object(JSON.parse(bytes.toString('utf8')) as unknown);
const numbered=(prefix:string,count:number):string[]=>Array.from({length:count},(_,i)=>prefix+String(i+1).padStart(2,'0'));

/** Shared exact-source and distribution binding for both original and additive audits. */
function inspectEvidenceCandidate(repositoryRoot:string,input:Pick<AcceptanceEvidenceRequest,'sourceCommit'|'manifest'|'archive'|'sourceRevision'>) {
  requireValue(/^[a-f0-9]{40}$/.test(input.sourceCommit),'Wrong source input');
  requireValue(isAbsolute(repositoryRoot)&&realpathSync(repositoryRoot)===repositoryRoot,'Use the exact source checkout');
  const env={PATH:'/usr/bin:/bin',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'};
  const git=(args:string[]):Buffer=>execFileSync('/usr/bin/git',['-c','core.fsmonitor=false','-C',repositoryRoot,...args],{env,timeout:15000,maxBuffer:4194304,stdio:['ignore','pipe','pipe']});
  requireValue(git(['rev-parse','HEAD']).toString().trim()===input.sourceCommit,'Checkout commit differs from the reviewed source');
  requireValue(git(['status','--porcelain']).length===0,'Qualification requires clean committed source');
  requireValue(evaluateGovernance(repositoryRoot,{mode:'check'}).status==='VALID','Source governance is not valid');
  const packageInfo=parse(read(join(repositoryRoot,'package.json'),1048576,false));
  requireValue(packageInfo.name==='@evopilot-next/runtime'&&packageInfo.version==='0.9.0','Source package is not the independent 0.9.0 Runtime');
  const manifestBytes=pinned(input.manifest,8388608),manifest=parse(manifestBytes),candidateDigest='sha256:'+sha(manifestBytes);
  exact(manifest,['schema','version','archiveDigest','files']);requireValue(Object.keys(object(manifest.files)).length>0&&Object.keys(object(manifest.files)).length<=20000,'Distribution inventory is empty or excessive');
  requireValue(manifest.schema==='runtime-standalone-distribution/v1'&&manifest.version==='0.9.0','A final independent 0.9.0 distribution is required');
  const archive=pinned(input.archive,268435456);requireValue(sha(archive)===digest(manifest.archiveDigest),'Original archive differs from the distribution inventory');
  requireValue(pinned(input.sourceRevision,128).toString()===input.sourceCommit+'\n','Source revision differs from the selected candidate');
  return{git,manifestBytes,manifest,candidateDigest,archive};
}

// The original inventories stay fixed; additive audits never replace these cases.
function inspectFixedEvidence(repositoryRoot:string,input:AcceptanceEvidenceRequest|E20PrerequisiteEvidenceRequest,scope:'FULL'|'PRE_E20') {
  exact(object(input),['schema','sourceCommit','manifest','archive','sourceRevision','reports']);
  requireValue(input.schema===(scope==='FULL'?'runtime-release-evidence-input/v1':'runtime-e20-prerequisite-evidence-input/v1'),'Wrong source input');
  const {git,manifestBytes,manifest,candidateDigest,archive}=inspectEvidenceCandidate(repositoryRoot,input);
  const matrixBytes=read(join(repositoryRoot,'governance/parameter-matrix-v090.json'),2097152,false),matrix=parse(matrixBytes),matrixDigest=sha(matrixBytes);
  const cases=array(matrix.caseInstances).map(object),allPreRelease=cases.filter(c=>c.phase==='PRE_RELEASE');
  requireValue(cases.length===664&&allPreRelease.length===655&&cases.every(c=>c.required===true),'Fixed acceptance denominator changed');
  const e20=allPreRelease.filter(c=>c.scenario==='E20').map(c=>string(c.caseInstanceId)).sort();
  requireValue(isDeepStrictEqual(e20,['E20.CV07','E20.EX12','E20.journey']),'Fixed E20 remainder changed');
  const required=scope==='FULL'?allPreRelease:allPreRelease.filter(c=>c.scenario!=='E20'),expectedCount=scope==='FULL'?655:652;
  requireValue(required.length===expectedCount,'Fixed prerequisite denominator changed');
  const reports=array(input.reports).map(object);
  const scenarioIds=numbered('E',scope==='FULL'?20:19);
  requireValue(reports.length===scenarioIds.length&&isDeepStrictEqual(reports.map(r=>r.scenario).sort(),scenarioIds),scope==='FULL'?'Exactly E01–E20 reports are required':'Exactly E01–E19 prerequisite reports are required');
  let evidenceFiles=0,evidenceBytes=0;const observed=new Set<string>(),reportPins:Record<string,string>={};
  function evidence(root:string,value:unknown,caseId:string|null):void {
    const item=object(value);requireValue(item.caseInstanceId===caseId,'Evidence belongs to another case');
    const file=(name:unknown,expected:unknown):void=>{
      const leaf=string(name);requireValue(/^[A-Za-z0-9_.-]+$/.test(leaf)&&leaf!=='.'&&leaf!=='..','Evidence reference is not an owned leaf');
      const bytes=read(join(root,leaf),16777216);evidenceBytes+=bytes.length;
      requireValue(++evidenceFiles<=30000&&evidenceBytes<=1073741824,'Evidence collection exceeds audit bounds');
      requireValue(sha(bytes)===digest(expected),'Original evidence bytes changed');
    };
    if(Object.hasOwn(item,'artifact')){requireValue(!Object.hasOwn(item,'request')&&!Object.hasOwn(item,'response'),'Ambiguous evidence record');file(item.artifact,item.fileDigest);}
    else{file(item.request,item.requestDigest);file(item.response,item.fileDigest);}
  }
  for(const entry of reports){
    exact(entry,['scenario','report']);const scenario=string(entry.scenario),reportRef=object(entry.report),reportBytes=pinned(reportRef,33554432),report=parse(reportBytes),root=dirname(string(reportRef.ref));
    reportPins[scenario]=sha(reportBytes);
    const expected=required.filter(c=>c.scenario===scenario).map(c=>string(c.caseInstanceId)).sort();
    requireValue(report.scenario===scenario&&report.qualification==='FINAL_CANDIDATE'&&report.candidateDigest===candidateDigest,'Report is not for this final candidate');
    const candidate=object(report.candidate);
    requireValue(candidate.version==='0.9.0'&&candidate.manifestDigest===sha(manifestBytes)&&candidate.archiveDigest===manifest.archiveDigest,'Report candidate identity changed');
    requireValue(report.fullDenominator===664&&report.scenarioDenominator===expected.length&&report.selected===expected.length&&report.executed===expected.length&&report.passed===expected.length&&report.failed===0&&report.scenarioStatus==='OBSERVED_PASS'&&array(report.unexecutedCaseIds).length===0,'Partial, failed, skipped or stale report');
    const selectionBytes=read(join(root,'selection.json'),1048576);requireValue(sha(selectionBytes)===digest(report.selectionDigest),'Original collector selection changed');
    const selection=parse(selectionBytes);
    requireValue(selection.scenario===scenario&&selection.matrixDigest===matrixDigest&&selection.qualification==='FINAL_CANDIDATE'&&selection.candidateDigest===candidateDigest&&isDeepStrictEqual(selection.candidate,report.candidate),'Selection differs from the report or frozen cases');
    requireValue(isDeepStrictEqual(array(selection.selectedCaseIds).map(string).sort(),expected),'Selected case list is incomplete or duplicated');
    const collectorPins=object(selection.collectorPins),collectorNames=['support.mjs','preflight.mjs',scenario.toLowerCase()+'.test.mjs',...(['E01','E02','E04','E05','E06','E07','E12','E13','E16','E17','E19'].includes(scenario)?['browser.mjs']:[]),...(['E05','E14','E15','E17'].includes(scenario)?['maintenance.mjs']:[]),...(['E01','E02','E04','E05','E13'].includes(scenario)?['execution.mjs']:[])];exact(collectorPins,collectorNames);
    for(const name of collectorNames){
      const relative='tests/acceptance/v090/'+name,committed=git(['show',input.sourceCommit+':'+relative]);
      requireValue(sha(committed)===digest(collectorPins[name])&&sha(read(join(repositoryRoot,relative),4194304,false))===sha(committed),'Collector differs from the tested source');
    }
    const results=array(report.results).map(object);
    requireValue(isDeepStrictEqual(results.map(r=>r.caseInstanceId).sort(),expected),'Result set is missing, duplicated or foreign');
    for(const result of results){
      const id=string(result.caseInstanceId);requireValue(!observed.has(id),'Duplicate acceptance instance');observed.add(id);
      requireValue(result.status==='PASS'&&result.qualification==='FINAL_CANDIDATE'&&result.candidateDigest===candidateDigest&&Object.keys(object(result.assertions)).length>0,'Nonpassing or unasserted case');
      requireValue(isDeepStrictEqual(parse(read(join(root,id+'.json'),16777216)),result),'Original case result differs from the aggregate report');
      const items=array(result.evidence);requireValue(items.length>0,'A passing label without raw evidence is insufficient');
      for(const item of items)evidence(root,item,id);
    }
    const setup=array(report.setupEvidence);requireValue(setup.length>0,'Initial installed service evidence is missing');
    for(const item of setup)evidence(root,item,null);
  }
  requireValue(observed.size===expectedCount,'Required pre-release cases remain');
  return{sourceCommit:input.sourceCommit,candidateDigest,archiveDigest:sha(archive),matrixDigest,reportPins,failed:0,skipped:0,postReleaseRemaining:9,evidenceFiles,evidenceBytes,recordIntegrity:'VERIFIED' as const,productAcceptance:'NOT_EVALUATED' as const,releaseAuthorized:false as const};
}

/** Audit all 655 pre-release records, including the three completed E20 cases.
 * This remains the only original-acceptance audit used by release preflight. */
export function inspectAcceptanceEvidence(repositoryRoot:string,input:AcceptanceEvidenceRequest) {
  return{schema:'runtime-release-evidence-audit/v1' as const,...inspectFixedEvidence(repositoryRoot,input,'FULL'),required:655,passed:655,remainingChecks:['Independent source CI and original artifact readback','Actual precise release decision','Public delivery and current Host acceptance']};
}

/** E20 may inspect its fixed 652 prerequisites before its own report exists.
 * Byte integrity cannot establish authentic execution, product acceptance or
 * release authority. The full 655-case audit is still mandatory afterwards. */
export function inspectE20PrerequisiteEvidence(repositoryRoot:string,input:E20PrerequisiteEvidenceRequest) {
  return{schema:'runtime-e20-prerequisite-evidence-audit/v1' as const,...inspectFixedEvidence(repositoryRoot,input,'PRE_E20'),required:652,passed:652,fullPreReleaseRequired:655,remainingE20:3,remainingE20CaseIds:['E20.journey','E20.EX12','E20.CV07'],executionAuthenticity:'NOT_ESTABLISHED_BY_FILE_HASHES' as const,fullReleaseAuditRequired:true as const,remainingChecks:['Complete the three fixed E20 cases, then independently audit all 655 pre-release cases','Independent source CI and original execution authenticity review','Additive usage acceptance, exact release decision and post-release delivery']};
}

/** Audit every LC PRE case and its declared vectors. Only original executed
 * FINAL_CANDIDATE/PASS records are supported. PASS_REUSED needs a separately
 * implemented owner-policy/qualification verifier and fails closed here.
 * Byte integrity does not prove execution authenticity or grant release authority. */
export function inspectCorrectionAcceptanceEvidence(repositoryRoot:string,input:CorrectionAcceptanceEvidenceRequest) {
  exact(object(input),['schema','sourceCommit','manifest','archive','sourceRevision','report']);
  requireValue(input.schema==='runtime-correction-evidence-input/v1','Wrong correction evidence schema');
  const {git,manifestBytes,manifest,candidateDigest,archive}=inspectEvidenceCandidate(repositoryRoot,input);
  const addendumBytes=read(join(repositoryRoot,'governance/lifecycle-correction-v090.json'),2097152,false),addendumDigest=sha(addendumBytes);
  const acceptance=object(parse(addendumBytes).acceptance),cases=array(acceptance.cases).map(object);
  // Governance validates the addendum, including all fixed counts and LC12 POST.
  const requiredIds=numbered('LC',21).filter(id=>id!=='LC12');
  const required=cases.filter(c=>c.phase==='PRE_RELEASE');
  requireValue(isDeepStrictEqual(required.map(c=>c.id).sort(),requiredIds),'Fixed LC pre-release obligations changed');
  const reportBytes=pinned(input.report,33554432),report=parse(reportBytes),root=dirname(input.report.ref);
  exact(report,['schema','scenario','sourceCommit','phase','candidate','candidateDigest','selectionDigest','qualification','scenarioDenominator','fullDenominator','selected','executed','passed','failed','unexecutedCaseIds','scenarioStatus','productAcceptance','releaseAuthorized','setupEvidence','results']);
  requireValue(report.schema==='runtime-correction-acceptance-report/v1'&&report.scenario==='LC'&&report.phase==='PRE_RELEASE'&&report.sourceCommit===input.sourceCommit&&report.qualification==='FINAL_CANDIDATE'&&report.candidateDigest===candidateDigest,'Correction report is not original execution for this final source/candidate and phase');
  const candidate=object(report.candidate);exact(candidate,['manifestDigest','archiveDigest','version','serviceId','workspaceId','projectId']);
  requireValue(candidate.version==='0.9.0'&&candidate.manifestDigest===sha(manifestBytes)&&candidate.archiveDigest===manifest.archiveDigest,'Correction report candidate identity changed');
  for(const key of ['serviceId','workspaceId','projectId'])string(candidate[key]);
  requireValue(report.fullDenominator===709&&report.scenarioDenominator===20&&report.selected===20&&report.executed===20&&report.passed===20&&report.failed===0&&report.scenarioStatus==='OBSERVED_PASS'&&array(report.unexecutedCaseIds).length===0,'Partial, failed, skipped or stale correction report');
  requireValue(report.productAcceptance==='NOT_EVALUATED'&&report.releaseAuthorized===false,'A correction collector cannot declare completion or release authority');
  const selectionBytes=read(join(root,'selection.json'),1048576);requireValue(sha(selectionBytes)===digest(report.selectionDigest),'Original correction selection changed');
  const selection=parse(selectionBytes);
  exact(selection,['scenario','sourceCommit','phase','addendumDigest','qualification','candidate','candidateDigest','collectorPins','selectedCaseIds']);
  requireValue(selection.scenario==='LC'&&selection.phase==='PRE_RELEASE'&&selection.sourceCommit===input.sourceCommit&&selection.addendumDigest===addendumDigest&&selection.qualification==='FINAL_CANDIDATE'&&selection.candidateDigest===candidateDigest&&isDeepStrictEqual(selection.candidate,candidate),'Correction selection differs from source, phase, report or obligations');
  requireValue(isDeepStrictEqual(array(selection.selectedCaseIds).map(string).sort(),requiredIds),'Selected LC list is incomplete, duplicated or foreign');
  const pins=object(selection.collectorPins);exact(pins,['correction.test.mjs']);
  const collector=string(acceptance.collector),committed=git(['show',input.sourceCommit+':'+collector]);
  requireValue(sha(committed)===digest(pins['correction.test.mjs'])&&sha(read(join(repositoryRoot,collector),4194304,false))===sha(committed),'Correction collector differs from the qualified source');

  let evidenceFiles=0,evidenceBytes=0,observedVectors=0;
  const ownedLeaves=new Set<string>(),reservedLeaves=new Set(['selection.json','report.json',basename(input.report.ref),...requiredIds.map(id=>id+'.json')].map(name=>name.toLowerCase()));
  function evidence(value:unknown,caseId:string|null,vectorId:string|null):void {
    const item=object(value);
    requireValue(item.caseInstanceId===caseId&&item.vectorId===vectorId,'Correction evidence belongs to another case or vector');
    const file=(name:unknown,expected:unknown):void=>{
      const leaf=string(name),identity=leaf.toLowerCase();
      requireValue(/^[A-Za-z0-9_.-]+$/.test(leaf)&&leaf!=='.'&&leaf!=='..'&&!reservedLeaves.has(identity),'Correction evidence must be a raw owned leaf');
      requireValue(!ownedLeaves.has(identity),'One raw evidence file cannot stand in for multiple correction observations');ownedLeaves.add(identity);
      const bytes=read(join(root,leaf),16777216);evidenceBytes+=bytes.length;
      requireValue(++evidenceFiles<=10000&&evidenceBytes<=268435456,'Correction evidence exceeds audit bounds');
      requireValue(sha(bytes)===digest(expected),'Original correction evidence bytes changed');
    };
    if(Object.hasOwn(item,'artifact')){exact(item,['caseInstanceId','vectorId','artifact','fileDigest']);file(item.artifact,item.fileDigest);}
    else{exact(item,['caseInstanceId','vectorId','request','requestDigest','response','fileDigest']);file(item.request,item.requestDigest);file(item.response,item.fileDigest);}
  }
  const results=array(report.results).map(object);
  requireValue(isDeepStrictEqual(results.map(r=>r.caseInstanceId).sort(),requiredIds),'Correction results are missing, duplicated or foreign');
  for(const result of results){
    exact(result,['caseInstanceId','phase','status','qualification','candidateDigest','assertions','vectors']);
    const id=string(result.caseInstanceId),expected=required.find(c=>c.id===id)!;
    const executed=(record:ObjectValue):void=>requireValue(record.phase==='PRE_RELEASE'&&record.status==='PASS'&&record.qualification==='FINAL_CANDIDATE'&&record.candidateDigest===candidateDigest&&Object.keys(object(record.assertions)).length>0,'Correction requires raw executed PASS with assertions for the final candidate and PRE phase; reuse is unsupported');
    executed(result);
    requireValue(isDeepStrictEqual(parse(read(join(root,id+'.json'),16777216)),result),'Original correction case differs from the aggregate report');
    const vectors=array(result.vectors).map(object),expectedVectors=array(expected.vectors).map(string).sort();
    requireValue(isDeepStrictEqual(vectors.map(v=>v.vectorId).sort(),expectedVectors),'Every declared correction vector is required exactly once');
    for(const vector of vectors){
      exact(vector,['vectorId','phase','status','qualification','candidateDigest','assertions','evidence']);executed(vector);
      const items=array(vector.evidence);requireValue(items.length>0,'A correction vector PASS label without raw evidence is insufficient');
      for(const item of items)evidence(item,id,string(vector.vectorId));
      observedVectors++;
    }
  }
  const setup=array(report.setupEvidence);requireValue(setup.length>0,'Correction installed service setup evidence is missing');
  for(const item of setup)evidence(item,null,null);
  return{schema:'runtime-correction-evidence-audit/v1' as const,sourceCommit:input.sourceCommit,candidateDigest,archiveDigest:sha(archive),addendumDigest,reportDigest:sha(reportBytes),required:20,passed:20,failed:0,skipped:0,requiredVectors:observedVectors,passedVectors:observedVectors,originalRequired:688,originalAcceptanceIndependentlyRequired:true as const,combinedRequired:709,correctionPostReleaseRemaining:1,evidenceFiles,evidenceBytes,recordIntegrity:'VERIFIED' as const,executionAuthenticity:'NOT_ESTABLISHED_BY_FILE_HASHES' as const,productAcceptance:'NOT_EVALUATED' as const,releaseAuthorized:false as const,remainingChecks:['Original 688 acceptance obligations remain independently required','Review actual execution and Host provenance, not passing labels','Independent source CI and exact release decision','LC12 downloaded release and installed current Host acceptance','HO01–HO03 remain separate post-delivery coordination obligations']};
}

/** Additive v2 audit: each entry is a reference to a durable owner action, never
 * a copied PASS, supplied verifier or self-consistent qualification document.
 * V1 auditors and immutable raw reports keep their original behavior. */
export async function inspectQualifiedAcceptanceEvidence(repositoryRoot:string,input:QualifiedAcceptanceEvidenceRequest,service:NativeQualificationService,actor:Principal,signal:AbortSignal) {
  assertNativeQualificationService(service);signal.throwIfAborted();
  exact(object(input),['schema','sourceCommit','manifest','archive','sourceRevision','scope','qualifications']);exact(object(input.scope),['workspaceId','projectId']);
  requireValue(input.schema==='runtime-qualified-release-evidence-input/v2','Wrong qualification audit schema');
  string(input.scope.workspaceId);string(input.scope.projectId);
  const {candidateDigest,archive}=inspectEvidenceCandidate(repositoryRoot,input);
  const paths=['governance/acceptance-v090.json','governance/parameter-matrix-v090.json','governance/token-usage-v090.json','governance/lifecycle-correction-v090.json'];
  const bindings=paths.map(path=>{const bytes=read(join(repositoryRoot,path),2097152,false);return{path,sha256:'sha256:'+sha(bytes),bytes:bytes.length};});
  const acceptanceScopeDigest=valueDigest({product:'runtime',targetId:'runtime-v090-independent-lifecycle',targetVersion:'0.9.0',catalogBindings:bindings});
  const matrix=parse(read(join(repositoryRoot,paths[1]),2097152,false)),usage=parse(read(join(repositoryRoot,paths[2]),2097152,false)),correction=parse(read(join(repositoryRoot,paths[3]),2097152,false));
  const originalCases=array(matrix.caseInstances).map(object),usageCases=array(object(usage.acceptance).cases).map(object),correctionCases=array(object(correction.acceptance).cases).map(object);
  const original=originalCases.filter(c=>c.phase==='PRE_RELEASE').map(c=>string(c.caseInstanceId)),additive=usageCases.filter(c=>c.phase==='PRE_RELEASE').map(c=>string(c.id)),corrected=correctionCases.filter(c=>c.phase==='PRE_RELEASE').map(c=>string(c.id));
  requireValue(originalCases.length===664&&usageCases.length===24&&correctionCases.length===21&&original.length===655&&additive.length===23&&corrected.length===20,'Fixed original, usage and LC acceptance denominators changed');
  const expected=[...original,...additive,...corrected].sort(),entries=array(input.qualifications).map(object);
  requireValue(entries.length===698&&isDeepStrictEqual(entries.map(e=>e.caseId).sort(),expected),'Every fixed PRE obligation requires one original native qualification action');
  const rows:Awaited<ReturnType<NativeQualificationService['inspect']>>[]=[];let executed=0,reused=0;
  for(const entry of entries){
    signal.throwIfAborted();exact(entry,['caseId','actionRef','actionDigest']);const caseId=string(entry.caseId),actionRef=string(entry.actionRef),actionDigest=string(entry.actionDigest);
    requireValue(/^sha256:[a-f0-9]{64}$/.test(actionDigest),'Exact original assessment action digest required');
    const q=await service.inspect(input.scope.projectId,actionRef,actor,signal);
    requireValue(q.schema==='runtime-evidence-qualification/v2'&&q.phase==='PRE_RELEASE'&&q.actionRef===actionRef&&q.actionDigest===actionDigest&&q.caseId===caseId&&q.currentCandidateDigest===candidateDigest&&isDeepStrictEqual(q.scope,{...input.scope,acceptanceScopeDigest}),'Qualification does not cover the exact current source, case, scope and phase');
    requireValue(q.formalAcceptanceEligible===true&&q.status==='QUALIFIED'&&q.reasons.length===0&&q.assessment?.verdict==='PASS'&&q.nativeReceiptDigest&&q.nativeReportDigest&&q.expiresAt&&Date.parse(q.expiresAt)>Date.now()&&q.establishesEnvironmentState===false&&q.executionAuthorized===false&&q.releaseAuthorized===false,'Current authentic native assessment is unavailable, stale or not passing');
    if(q.mode==='EXECUTED'){requireValue(q.originalCandidateDigest===candidateDigest,'Executed evidence belongs to another candidate');executed++;}
    else{requireValue(q.mode==='PASS_REUSED'&&q.originalCandidateDigest!==candidateDigest&&!q.hasFailureHistory&&q.assessment?.executionRequirement==='REUSE_PERMITTED','Reuse cannot replace execution or hide failures');reused++;}
    rows.push(q);
  }
  // No per-case TTL may expire while the remaining bounded inventory is read.
  requireValue(rows.every(q=>Date.parse(q.expiresAt!)>Date.now()),'A qualification expired during the full audit');signal.throwIfAborted();inspectEvidenceCandidate(repositoryRoot,input);
  const family=(ids:string[])=>({required:ids.length,qualified:ids.length,executed:rows.filter(q=>ids.includes(q.caseId)&&q.mode==='EXECUTED').length,reused:rows.filter(q=>ids.includes(q.caseId)&&q.mode==='PASS_REUSED').length});
  // No async work follows: earlier rows cannot retain revoked trust/history
  // merely because their TTL remains valid while later rows are inspected.
  assertQualifiedAcceptanceCurrent(service,input.scope.projectId,rows,actor,signal);
  return{schema:'runtime-qualified-release-evidence-audit/v2' as const,sourceCommit:input.sourceCommit,candidateDigest,archiveDigest:sha(archive),acceptanceScopeDigest,catalogBindings:bindings,required:698,qualified:698,executed,reused,failed:0,skipped:0,combinedRequired:709,postReleaseRemaining:11,original:family(original),usage:family(additive),correction:family(corrected),qualifications:rows,executionAuthenticity:'CURRENT_NATIVE_ASSESSMENTS' as const,productAcceptance:'NOT_EVALUATED' as const,releaseAuthorized:false as const,establishesEnvironmentState:false as const};
}

/** Same synchronous final guard used by the complete release audit. A saved
 * JSON qualification is not accepted as a freshly authenticated native row. */
export function assertQualifiedAcceptanceCurrent(service:NativeQualificationService,projectId:string,rows:readonly NativeEvidenceQualification[],actor:Principal,signal:AbortSignal):void {
  assertNativeQualificationService(service);requireValue(rows.length>0&&rows.length<=698,'Bounded nonempty native qualification batch required');
  for(const row of rows)service.assertCurrent(projectId,row,actor,signal);
}
