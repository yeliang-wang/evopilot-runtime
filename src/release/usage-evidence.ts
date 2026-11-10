import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {closeSync,constants,fstatSync,openSync,readFileSync,realpathSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {evaluateGovernance} from '../governance.js';

interface FileReference {ref:string;sha256:string;}
export interface UsageAcceptanceEvidenceRequest {
  schema:'runtime-usage-evidence-input/v1';sourceCommit:string;
  manifest:FileReference;archive:FileReference;sourceRevision:FileReference;report:FileReference;
}
type ObjectValue=Record<string,unknown>;
const sha=(bytes:Buffer):string=>createHash('sha256').update(bytes).digest('hex');
const reject=(message:string):never=>{throw new Error('USAGE_EVIDENCE: '+message);};
const requireValue=(condition:unknown,message:string):void=>{if(!condition)reject(message);};
const object=(value:unknown):ObjectValue=>value&&typeof value==='object'&&!Array.isArray(value)?value as ObjectValue:reject('Expected an object');
const array=(value:unknown):unknown[]=>Array.isArray(value)?value:reject('Expected an array');
const string=(value:unknown):string=>typeof value==='string'&&value.length>0?value:reject('Expected a nonempty string');
const exact=(value:ObjectValue,keys:string[]):void=>requireValue(isDeepStrictEqual(Object.keys(value).sort(),[...keys].sort()),'Unexpected input fields');
const digest=(value:unknown):string=>{const d=string(value);requireValue(/^[a-f0-9]{64}$/.test(d),'Invalid SHA256');return d;};
const parse=(bytes:Buffer):ObjectValue=>object(JSON.parse(bytes.toString('utf8')) as unknown);
const requiredIds=Array.from({length:23},(_,i)=>'UT'+String(i+1).padStart(2,'0'));

function read(path:string,maximum:number,privateFile=true):Buffer {
  requireValue(isAbsolute(path)&&resolve(path)===path&&realpathSync(path)===path,'Use canonical paths without symlinks');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const stat=fstatSync(fd);
    requireValue(stat.isFile()&&stat.nlink===1&&stat.size<=maximum,'Invalid bounded evidence file');
    if(privateFile)requireValue((stat.mode&0o077)===0&&stat.uid===process.getuid?.(),'Evidence must be private and owned by this user');
    const bytes=readFileSync(fd),after=fstatSync(fd);
    requireValue(bytes.length===stat.size&&after.size===stat.size&&after.mtimeMs===stat.mtimeMs&&after.ctimeMs===stat.ctimeMs,'Evidence changed during the audit');
    return bytes;
  }finally{closeSync(fd);}
}
function pinned(value:unknown,maximum:number):Buffer {
  const ref=object(value);exact(ref,['ref','sha256']);const bytes=read(string(ref.ref),maximum);
  requireValue(sha(bytes)===digest(ref.sha256),'Reviewed evidence file changed');return bytes;
}

/** Inspect the additive UT01–UT23 record set. Hashes establish byte integrity,
 * not authenticity of an execution or correctness of its assertions. Original
 * E01–E22, authenticated source CI, the release decision and UT24 remain separate.
 * This function never changes a project's lifecycle or release eligibility. */
export function inspectUsageAcceptanceEvidence(repositoryRoot:string,input:UsageAcceptanceEvidenceRequest) {
  exact(object(input),['schema','sourceCommit','manifest','archive','sourceRevision','report']);
  requireValue(input.schema==='runtime-usage-evidence-input/v1'&&/^[a-f0-9]{40}$/.test(input.sourceCommit),'Wrong source input');
  requireValue(isAbsolute(repositoryRoot)&&resolve(repositoryRoot)===repositoryRoot&&realpathSync(repositoryRoot)===repositoryRoot,'Use the exact source checkout');
  const env={PATH:'/usr/bin:/bin',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'};
  const git=(args:string[]):Buffer=>execFileSync('/usr/bin/git',['-c','core.fsmonitor=false','-C',repositoryRoot,...args],{env,timeout:15000,maxBuffer:4194304,stdio:['ignore','pipe','pipe']});
  requireValue(git(['rev-parse','HEAD']).toString().trim()===input.sourceCommit,'Checkout commit differs from the selected source');
  requireValue(git(['status','--porcelain']).length===0,'Qualification requires clean committed source');
  requireValue(evaluateGovernance(repositoryRoot,{mode:'check'}).status==='VALID','Source governance is not valid');
  const packageInfo=parse(read(join(repositoryRoot,'package.json'),1048576,false));
  requireValue(packageInfo.name==='@evopilot-next/runtime'&&packageInfo.version==='0.9.0','Source is not independent Runtime 0.9.0');
  const manifestBytes=pinned(input.manifest,8388608),manifest=parse(manifestBytes),candidateDigest='sha256:'+sha(manifestBytes);
  exact(manifest,['schema','version','archiveDigest','files']);
  requireValue(manifest.schema==='runtime-standalone-distribution/v1'&&manifest.version==='0.9.0','A final independent distribution is required');
  requireValue(Object.keys(object(manifest.files)).length>0&&Object.keys(object(manifest.files)).length<=20000,'Distribution inventory is empty or excessive');
  const archive=pinned(input.archive,268435456);
  requireValue(sha(archive)===digest(manifest.archiveDigest),'Archive differs from the candidate manifest');
  requireValue(pinned(input.sourceRevision,128).toString()===input.sourceCommit+'\n','Source revision differs from the selected candidate');

  const addendumBytes=read(join(repositoryRoot,'governance/token-usage-v090.json'),1048576,false),addendum=parse(addendumBytes),acceptance=object(addendum.acceptance);
  const original=parse(read(join(repositoryRoot,'governance/parameter-matrix-v090.json'),2097152,false)),originalCases=array(original.caseInstances).map(object);
  requireValue(originalCases.length===664&&originalCases.every(c=>c.required===true)&&originalCases.filter(c=>c.phase==='PRE_RELEASE').length===655&&originalCases.filter(c=>c.phase==='POST_RELEASE').length===9,'Original E01–E22 denominator changed');
  requireValue(addendum.schema==='runtime-token-usage-addendum/v1'&&addendum.owner==='runtime'&&addendum.targetVersion==='0.9.0','Wrong usage addendum');
  requireValue(acceptance.originalRequiredInstances===664&&acceptance.originalPreRelease===655&&acceptance.originalPostRelease===9&&acceptance.additionalPreRelease===23&&acceptance.additionalPostRelease===1&&acceptance.combinedRequiredInstances===688,'Additive denominator changed');
  requireValue(acceptance.collector==='tests/acceptance/v090/usage.test.mjs','Unexpected usage collector');
  const cases=array(acceptance.cases).map(object);
  requireValue(cases.length===24&&cases.every(c=>c.required===true)&&isDeepStrictEqual(cases.filter(c=>c.phase==='PRE_RELEASE').map(c=>c.id).sort(),requiredIds)&&isDeepStrictEqual(cases.filter(c=>c.phase==='POST_RELEASE').map(c=>c.id),['UT24']),'Fixed UT01–UT24 obligations changed');
  const addendumDigest=sha(addendumBytes),reportBytes=pinned(input.report,33554432),report=parse(reportBytes),root=dirname(input.report.ref);
  requireValue(report.schema==='runtime-usage-acceptance-report/v1'&&report.scenario==='UT'&&report.sourceCommit===input.sourceCommit&&report.qualification==='FINAL_CANDIDATE'&&report.candidateDigest===candidateDigest,'Report is not for this final source/candidate');
  const candidate=object(report.candidate);
  exact(candidate,['manifestDigest','archiveDigest','version','serviceId','workspaceId','projectId']);
  requireValue(candidate.version==='0.9.0'&&candidate.manifestDigest===sha(manifestBytes)&&candidate.archiveDigest===manifest.archiveDigest,'Report candidate identity changed');
  for(const key of ['serviceId','workspaceId','projectId'])string(candidate[key]);
  requireValue(report.fullDenominator===688&&report.scenarioDenominator===23&&report.selected===23&&report.executed===23&&report.passed===23&&report.failed===0&&report.scenarioStatus==='OBSERVED_PASS'&&array(report.unexecutedCaseIds).length===0,'Partial, failed, skipped or stale usage report');
  requireValue(report.productAcceptance==='NOT_EVALUATED'&&report.releaseAuthorized===false,'A collector cannot declare product completion or release authority');
  const selectionBytes=read(join(root,'selection.json'),1048576);
  requireValue(sha(selectionBytes)===digest(report.selectionDigest),'Original collector selection changed');
  const selection=parse(selectionBytes);
  requireValue(selection.scenario==='UT'&&selection.sourceCommit===input.sourceCommit&&selection.addendumDigest===addendumDigest&&selection.qualification==='FINAL_CANDIDATE'&&selection.candidateDigest===candidateDigest&&isDeepStrictEqual(selection.candidate,candidate),'Selection differs from the source, report or fixed obligations');
  requireValue(isDeepStrictEqual(array(selection.selectedCaseIds).map(string).sort(),requiredIds),'Selected UT list is incomplete, duplicated or foreign');
  const pins=object(selection.collectorPins);exact(pins,['usage.test.mjs','preflight.mjs']);
  requireValue((selection.phase===undefined||selection.phase==='PRE_RELEASE')&&(report.phase===undefined||report.phase==='PRE_RELEASE'),'POST usage cannot qualify PRE');
  for(const name of ['usage.test.mjs','preflight.mjs']){const collector='tests/acceptance/v090/'+name,committed=git(['show',input.sourceCommit+':'+collector]);requireValue(sha(committed)===digest(pins[name])&&sha(read(join(repositoryRoot,collector),4194304,false))===sha(committed),'Collector differs from the qualified source');}

  let evidenceFiles=0,evidenceBytes=0;
  const ownedLeaves=new Set<string>();
  const reservedLeaves=new Set(['selection.json','report.json',basename(input.report.ref),...requiredIds.map(id=>id+'.json')].map(name=>name.toLowerCase()));
  function evidence(value:unknown,caseId:string|null):void {
    const item=object(value);requireValue(item.caseInstanceId===caseId,'Evidence belongs to another case');
    const file=(name:unknown,expected:unknown):void=>{
      const leaf=string(name);
      requireValue(/^[A-Za-z0-9_.-]+$/.test(leaf)&&leaf!=='.'&&leaf!=='..'&&!reservedLeaves.has(leaf.toLowerCase()),'Evidence reference must be a raw owned leaf');
      requireValue(!ownedLeaves.has(leaf),'One raw evidence file cannot stand in for multiple observations');ownedLeaves.add(leaf);
      const bytes=read(join(root,leaf),16777216);evidenceBytes+=bytes.length;
      requireValue(++evidenceFiles<=10000&&evidenceBytes<=268435456,'Evidence collection exceeds audit bounds');
      requireValue(sha(bytes)===digest(expected),'Original evidence bytes changed');
    };
    if(Object.hasOwn(item,'artifact')){
      requireValue(!Object.hasOwn(item,'request')&&!Object.hasOwn(item,'response')&&!Object.hasOwn(item,'requestDigest'),'Ambiguous raw evidence record');file(item.artifact,item.fileDigest);
    }else{
      requireValue(!Object.hasOwn(item,'artifact'),'Ambiguous raw evidence record');file(item.request,item.requestDigest);file(item.response,item.fileDigest);
    }
  }
  const results=array(report.results).map(object);
  requireValue(isDeepStrictEqual(results.map(r=>r.caseInstanceId).sort(),requiredIds),'Usage results are missing, duplicated or foreign');
  for(const result of results){
    const id=string(result.caseInstanceId);
    requireValue(result.status==='PASS'&&result.qualification==='FINAL_CANDIDATE'&&result.candidateDigest===candidateDigest&&Object.keys(object(result.assertions)).length>0,'Nonpassing or unasserted usage case');
    requireValue(isDeepStrictEqual(parse(read(join(root,id+'.json'),16777216)),result),'Original usage case differs from the aggregate report');
    const items=array(result.evidence);requireValue(items.length>0,'Passing labels without raw evidence are insufficient');
    for(const item of items)evidence(item,id);
  }
  const setup=array(report.setupEvidence);requireValue(setup.length>0,'Installed service setup evidence is missing');
  for(const item of setup)evidence(item,null);
  return{schema:'runtime-usage-evidence-audit/v1' as const,sourceCommit:input.sourceCommit,candidateDigest,archiveDigest:sha(archive),addendumDigest,reportDigest:sha(reportBytes),required:23,passed:23,failed:0,skipped:0,originalRequired:664,originalAcceptanceIndependentlyRequired:true as const,combinedRequired:688,usagePostReleaseRemaining:1,evidenceFiles,evidenceBytes,recordIntegrity:'VERIFIED' as const,executionAuthenticity:'NOT_ESTABLISHED_BY_FILE_HASHES' as const,productAcceptance:'NOT_EVALUATED' as const,releaseAuthorized:false as const,remainingChecks:['Original E01–E22 evidence remains independently required','Review actual execution and Host provenance, not passing labels','Independent source CI and exact source/package binding','Actual precise release decision','UT24 downloaded release and current Codex acceptance']};
}
