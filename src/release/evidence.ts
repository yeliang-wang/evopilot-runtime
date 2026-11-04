import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {evaluateGovernance} from '../governance.js';

interface FileReference {ref:string;sha256:string;}
export interface AcceptanceEvidenceRequest {
  schema:'runtime-release-evidence-input/v1';sourceCommit:string;
  manifest:FileReference;archive:FileReference;sourceRevision:FileReference;
  reports:{scenario:string;report:FileReference}[];
}
export interface E20PrerequisiteEvidenceRequest extends Omit<AcceptanceEvidenceRequest,'schema'> {
  schema:'runtime-e20-prerequisite-evidence-input/v1';
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
  const stat=lstatSync(path);
  requireValue(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=maximum,'Invalid bounded evidence file');
  if(privateFile)requireValue((stat.mode&0o077)===0&&stat.uid===process.getuid?.(),'Evidence must be private and owned by this user');
  return readFileSync(path);
}
function pinned(value:unknown,maximum:number):Buffer {
  const ref=object(value);exact(ref,['ref','sha256']);const bytes=read(string(ref.ref),maximum);
  requireValue(sha(bytes)===digest(ref.sha256),'Reviewed evidence file changed');return bytes;
}
const parse=(bytes:Buffer):ObjectValue=>object(JSON.parse(bytes.toString('utf8')) as unknown);
const numbered=(prefix:string,count:number):string[]=>Array.from({length:count},(_,i)=>prefix+String(i+1).padStart(2,'0'));

// The only two inventories are fixed here. No caller can omit a case, choose a
// scenario range or turn a prerequisite audit into the complete release audit.
function inspectFixedEvidence(repositoryRoot:string,input:AcceptanceEvidenceRequest|E20PrerequisiteEvidenceRequest,scope:'FULL'|'PRE_E20') {
  exact(object(input),['schema','sourceCommit','manifest','archive','sourceRevision','reports']);
  requireValue(input.schema===(scope==='FULL'?'runtime-release-evidence-input/v1':'runtime-e20-prerequisite-evidence-input/v1')&&/^[a-f0-9]{40}$/.test(input.sourceCommit),'Wrong source input');
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
    const collectorPins=object(selection.collectorPins),collectorNames=['support.mjs',scenario.toLowerCase()+'.test.mjs',...(['E01','E04','E05','E06','E07','E12','E13','E17','E19'].includes(scenario)?['browser.mjs']:[]),...(['E05','E14','E15','E17'].includes(scenario)?['maintenance.mjs']:[]),...(scenario==='E13'?['execution.mjs']:[])];exact(collectorPins,collectorNames);
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
