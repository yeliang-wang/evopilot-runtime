import {createHash,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {closeSync,constants,fstatSync,openSync,readFileSync,realpathSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {verifyDecisionEvidence,type DecisionSubject} from '../../vendor/compatibility/v1/decision-evidence.mjs';
import {canonical} from '../server/errors.js';
import {evaluateGovernance} from '../governance.js';
import {inspectSourceCiRecords} from './source-ci.js';
import {inspectAcceptanceEvidence,inspectCorrectionAcceptanceEvidence} from './evidence.js';
import {inspectUsageAcceptanceEvidence} from './usage-evidence.js';

export const RUNTIME_RELEASE_REPOSITORY='yeliang-wang/evopilot-runtime' as const;
export const RUNTIME_RELEASE_ASSETS=Object.freeze(['SHA256SUMS','distribution-manifest.json','evopilot-next-runtime-0.9.0.tgz','evopilot-runtime-0.9.0-darwin-arm64.tar.gz','runtime-dependency-lock.json','source-revision.txt'] as const);
export type RuntimeReleaseAsset=typeof RUNTIME_RELEASE_ASSETS[number];
export interface ReleaseFileReference {ref:string;sha256:string;}
export interface RuntimeReleaseCandidateInput {
 schema:'runtime-release-candidate-input/v1';repository:typeof RUNTIME_RELEASE_REPOSITORY;sourceCommit:string;
 files:Record<RuntimeReleaseAsset,ReleaseFileReference>;
 sourceCi:{run:ReleaseFileReference;jobs:ReleaseFileReference;artifact:ReleaseFileReference;jobLog:ReleaseFileReference;artifactZip:ReleaseFileReference;};
}
export interface RuntimeReleasePreflightInput {
 schema:'runtime-release-preflight-input/v1';candidate:RuntimeReleaseCandidateInput;
 scope:{workspaceId:string;projectId:string;};
 reports:{scenario:string;report:ReleaseFileReference;}[];usageReport:ReleaseFileReference;correctionReport:ReleaseFileReference;releaseNotes:ReleaseFileReference;
}
export interface RuntimeReleaseGovernance {
 status:'VALID';targetId:'runtime-v090-independent-lifecycle';targetVersion:'0.9.0';
 roadmapDigest:string;targetDigest:string;approvedPlanDigest:string;acceptanceDigest:string;usageAddendumDigest:string;correctionAddendumDigest:string;
}
type Obj=Record<string,unknown>;
const fail=(message:string):never=>{throw Error('RELEASE_GATE: '+message);};
const requireValue=(value:unknown,message:string):void=>{if(!value)fail(message);};
const object=(value:unknown):Obj=>value&&typeof value==='object'&&!Array.isArray(value)?value as Obj:fail('Expected an object');
const exact=(value:unknown,keys:readonly string[]):void=>requireValue(isDeepStrictEqual(Object.keys(object(value)).sort(),[...keys].sort()),'Unexpected input fields');
const sha=(bytes:Buffer|string):string=>createHash('sha256').update(bytes).digest('hex');
const digest=(value:unknown):string=>'sha256:'+sha(canonical(value));
const text=(value:unknown):string=>typeof value==='string'&&value.length>0&&value.length<=4096?value:fail('Invalid string');
const hash=(value:unknown):string=>{const result=text(value);requireValue(/^[a-f0-9]{64}$/.test(result),'Invalid SHA256');return result;};
const slug=(value:unknown):void=>requireValue(typeof value==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(value),'Invalid decision scope');
const parse=(bytes:Buffer):Obj=>{try{return object(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown);}catch{return fail('Invalid JSON evidence');}};
function read(filename:string,maximum:number,privateFile=true):Buffer {
 try{
  requireValue(isAbsolute(filename)&&resolve(filename)===filename&&realpathSync(filename)===filename,'Use canonical paths without links');
  const fd=openSync(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const before=fstatSync(fd);requireValue(before.isFile()&&before.nlink===1&&before.size>0&&before.size<=maximum,'Invalid bounded evidence file');
   if(privateFile)requireValue((before.mode&0o077)===0&&before.uid===process.getuid?.(),'Evidence must be private and owned by this user');
   const bytes=readFileSync(fd),after=fstatSync(fd);requireValue(bytes.length===before.size&&after.size===before.size&&after.mtimeMs===before.mtimeMs&&after.ctimeMs===before.ctimeMs,'Evidence changed during inspection');return bytes;
  }finally{closeSync(fd);}
 }catch{return fail('Evidence file is missing, unsafe or changed');}
}
function pinned(value:ReleaseFileReference,maximum:number):Buffer {exact(value,['ref','sha256']);const bytes=read(text(value.ref),maximum);requireValue(sha(bytes)===hash(value.sha256),'Pinned evidence changed');return bytes;}
function source(repositoryRoot:string,commit:string):void {
 requireValue(isAbsolute(repositoryRoot)&&resolve(repositoryRoot)===repositoryRoot&&realpathSync(repositoryRoot)===repositoryRoot,'Use the exact source checkout');
 requireValue(/^[a-f0-9]{40}$/.test(commit),'Invalid source commit');
 const git=(args:string[]):Buffer=>execFileSync('/usr/bin/git',['-c','core.fsmonitor=false','-C',repositoryRoot,...args],{env:{PATH:'/usr/bin:/bin',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'},timeout:15000,maxBuffer:4194304,stdio:['ignore','pipe','pipe']});
 requireValue(git(['rev-parse','HEAD']).toString().trim()===commit&&git(['status','--porcelain']).length===0,'Release requires exact clean committed source');
 const pkg=parse(read(join(repositoryRoot,'package.json'),1048576,false));requireValue(pkg.name==='@evopilot-next/runtime'&&pkg.version==='0.9.0','Only independent Runtime 0.9.0 is supported');
}
function governance(repositoryRoot:string):RuntimeReleaseGovernance {
 const check=evaluateGovernance(repositoryRoot,{mode:'check'});
 requireValue(check.status==='VALID'&&check.releaseAuthorized===false,'Current approved Roadmap/Target governance is not valid');
 const roadmapBytes=read(join(repositoryRoot,'governance/roadmap.json'),2097152,false),targetBytes=read(join(repositoryRoot,'governance/target-v090.json'),2097152,false),target=parse(targetBytes);
 requireValue(target.id==='runtime-v090-independent-lifecycle'&&target.targetVersion==='0.9.0'&&target.roadmapDigest===sha(roadmapBytes),'Current release Target identity or Roadmap binding differs');
 return{status:'VALID',targetId:'runtime-v090-independent-lifecycle',targetVersion:'0.9.0',roadmapDigest:sha(roadmapBytes),targetDigest:sha(targetBytes),approvedPlanDigest:hash(target.approvedPlanDigest),acceptanceDigest:hash(target.acceptanceDigest),usageAddendumDigest:sha(read(join(repositoryRoot,'governance/token-usage-v090.json'),2097152,false)),correctionAddendumDigest:sha(read(join(repositoryRoot,'governance/lifecycle-correction-v090.json'),2097152,false))};
}
/** Read-only recheck of the governance already covered by the exact reviewed
 * release. This function never authenticates a decision or grants authority. */
export function verifyRuntimeReleaseGovernanceCurrent(repositoryRoot:string,sourceCommit:string,expected:RuntimeReleaseGovernance):void{
 source(repositoryRoot,sourceCommit);requireValue(isDeepStrictEqual(governance(repositoryRoot),expected),'Reviewed release governance changed');
}

/** E20 uses this lower layer before its own report exists. It verifies source
 * CI and the exact six public assets, not E20 completion or release authority. */
export async function inspectRuntimeReleaseCandidate(repositoryRoot:string,raw:RuntimeReleaseCandidateInput,signal:AbortSignal) {
 const input=structuredClone(raw);signal.throwIfAborted();exact(input,['schema','repository','sourceCommit','files','sourceCi']);
 requireValue(input.schema==='runtime-release-candidate-input/v1'&&input.repository===RUNTIME_RELEASE_REPOSITORY,'Wrong independent Runtime release scope');source(repositoryRoot,input.sourceCommit);
 exact(input.files,RUNTIME_RELEASE_ASSETS);exact(input.sourceCi,['run','jobs','artifact','jobLog','artifactZip']);
 const refs=[...Object.values(input.files),...Object.values(input.sourceCi)];requireValue(new Set(refs.map(r=>text(r.ref))).size===refs.length,'Evidence roles must have distinct files');
 const files=Object.fromEntries(RUNTIME_RELEASE_ASSETS.map(name=>[name,pinned(input.files[name],name.endsWith('.gz')||name.endsWith('.tgz')?268435456:8388608)])) as Record<RuntimeReleaseAsset,Buffer>;
 requireValue(files['source-revision.txt'].toString()===input.sourceCommit+'\n','Candidate source differs');
 requireValue(sha(files['runtime-dependency-lock.json'])===sha(read(join(repositoryRoot,'package-lock.json'),8388608,false)),'Candidate dependency lock differs from committed source');
 const ciBytes={run:pinned(input.sourceCi.run,8388608),jobs:pinned(input.sourceCi.jobs,8388608),artifact:pinned(input.sourceCi.artifact,8388608),jobLog:pinned(input.sourceCi.jobLog,16777216),artifactZip:pinned(input.sourceCi.artifactZip,268435456)};
 const ci=await inspectSourceCiRecords({sourceCommit:input.sourceCommit,manifestDigest:sha(files['distribution-manifest.json']),archiveDigest:sha(files['evopilot-runtime-0.9.0-darwin-arm64.tar.gz']),artifactDigest:sha(ciBytes.artifactZip),run:parse(ciBytes.run),jobs:parse(ciBytes.jobs),artifact:parse(ciBytes.artifact),jobLog:ciBytes.jobLog.toString('utf8'),artifactZip:ciBytes.artifactZip},signal);
 const filePins=Object.fromEntries(RUNTIME_RELEASE_ASSETS.map(name=>[name,sha(files[name])]));requireValue(isDeepStrictEqual(filePins,ci.files),'Release files differ from the independently built CI artifact');signal.throwIfAborted();source(repositoryRoot,input.sourceCommit);
 return{schema:'runtime-release-candidate-inspection/v1' as const,repository:RUNTIME_RELEASE_REPOSITORY,version:'0.9.0' as const,tag:'v0.9.0' as const,title:'EvoPilot Runtime 0.9.0 Preview' as const,prerelease:true as const,latest:false as const,sourceCommit:input.sourceCommit,candidateDigest:'sha256:'+ci.manifestDigest,archiveDigest:ci.archiveDigest,files:Object.fromEntries(RUNTIME_RELEASE_ASSETS.map(name=>[name,{sha256:filePins[name],bytes:files[name].length}])),sourceCi:{...ci,recordPins:Object.fromEntries(Object.entries(ciBytes).map(([name,bytes])=>[name,sha(bytes)]))},recordIntegrity:'VERIFIED' as const,productAcceptance:'NOT_EVALUATED' as const,releaseAuthorized:false as const};
}

/** Full final preflight. All original 655, usage 23 and correction 20 pre-release cases are
 * independently audited. Private paths and raw evidence never enter the review
 * object or the six-file publication allowlist. No network or write occurs. */
export async function prepareRuntimeRelease(repositoryRoot:string,raw:RuntimeReleasePreflightInput,signal:AbortSignal) {
 const input=structuredClone(raw);exact(input,['schema','candidate','scope','reports','usageReport','correctionReport','releaseNotes']);requireValue(input.schema==='runtime-release-preflight-input/v1','Wrong preflight schema');exact(input.scope,['workspaceId','projectId']);slug(input.scope.workspaceId);slug(input.scope.projectId);
 const governed=governance(repositoryRoot);
 // Markdown is text; its original bytes, including line endings, are reviewed.
 // Do not normalize it or add the private file to the six public attachments.
 const notesBytes=pinned(input.releaseNotes,262144);let notesText:string;
 try{notesText=new TextDecoder('utf-8',{fatal:true}).decode(notesBytes);}catch{return fail('Release notes must be UTF-8 Markdown');}
 requireValue(notesText.trim().length>0&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(notesText),'Release notes must be nonempty Markdown text');
 const releaseNotes={sha256:sha(notesBytes),bytes:notesBytes.length,mediaType:'text/markdown; charset=utf-8' as const};
 const candidate=await inspectRuntimeReleaseCandidate(repositoryRoot,input.candidate,signal),files=input.candidate.files;
 const common={sourceCommit:input.candidate.sourceCommit,manifest:files['distribution-manifest.json'],archive:files['evopilot-runtime-0.9.0-darwin-arm64.tar.gz'],sourceRevision:files['source-revision.txt']};
 const original=inspectAcceptanceEvidence(repositoryRoot,{schema:'runtime-release-evidence-input/v1',...common,reports:input.reports});signal.throwIfAborted();
 const usage=inspectUsageAcceptanceEvidence(repositoryRoot,{schema:'runtime-usage-evidence-input/v1',...common,report:input.usageReport});signal.throwIfAborted();
 const correction=inspectCorrectionAcceptanceEvidence(repositoryRoot,{schema:'runtime-correction-evidence-input/v1',...common,report:input.correctionReport});signal.throwIfAborted();
 for(const audit of [original,usage,correction])requireValue(audit.sourceCommit===candidate.sourceCommit&&audit.candidateDigest===candidate.candidateDigest&&audit.archiveDigest===candidate.archiveDigest&&audit.failed===0&&audit.skipped===0&&audit.releaseAuthorized===false,'Acceptance scope differs from candidate');
 requireValue(original.required===655&&original.passed===655&&original.postReleaseRemaining===9&&usage.required===23&&usage.passed===23&&usage.usagePostReleaseRemaining===1&&correction.required===20&&correction.passed===20&&correction.correctionPostReleaseRemaining===1&&correction.combinedRequired===709&&correction.addendumDigest===governed.correctionAddendumDigest,'Fixed pre/post denominator differs');
 verifyRuntimeReleaseGovernanceCurrent(repositoryRoot,candidate.sourceCommit,governed);
 const review={schema:'runtime-release-review/v1' as const,scope:input.scope,governance:governed,publication:{repository:candidate.repository,version:candidate.version,tag:candidate.tag,title:candidate.title,prerelease:candidate.prerelease,latest:candidate.latest,sourceCommit:candidate.sourceCommit,candidateDigest:candidate.candidateDigest,archiveDigest:candidate.archiveDigest,files:candidate.files,releaseNotes},sourceCi:candidate.sourceCi,acceptance:{original,usage,correction,requiredPreRelease:698 as const,passedPreRelease:698 as const,combinedRequired:709 as const,postRelease:{required:11 as const,passed:0 as const,status:'NOT_EVALUATED' as const,scenarios:['E21','E22','UT24','LC12']}},privacy:{publicAssets:[...RUNTIME_RELEASE_ASSETS],privateEvidenceUploadAllowed:false as const},recordIntegrity:'VERIFIED' as const,executionAuthenticity:'TRUSTED_REVIEW_REQUIRED' as const,productAcceptance:'NOT_EVALUATED' as const,releaseAuthorized:false as const};
 return{...review,reviewDigest:digest(review)};
}
export type RuntimeReleaseReview=Awaited<ReturnType<typeof prepareRuntimeRelease>>;
export interface RuntimeReleaseAuthenticationRequest {
 schema:'runtime-release-authentication-request/v1';challenge:string;review:RuntimeReleaseReview;
 subject:DecisionSubject;decisionEvidenceDigest:string;decisionSourceDigest:string;sourceCiRecordsDigest:string;
 /** Local-only references for the trusted operator's real source verification. */
 decisionEvidence:ReleaseFileReference;decisionSource:ReleaseFileReference;
}
export interface RuntimeReleaseAuthentication {
 schema:'runtime-release-authentication/v1';challenge:string;subject:DecisionSubject;
 reviewDigest:string;candidateDigest:string;sourceCommit:string;decisionEvidenceDigest:string;decisionSourceDigest:string;sourceCiRecordsDigest:string;
 decision:'APPROVE';humanIdentity:{id:string;kind:'human';};
 decisionAuthentication:'AUTHENTICATED_HUMAN_DECISION';sourceCiAuthentication:'AUTHENTICATED_PROVIDER_READS';acceptanceAuthentication:'REVIEWED_ORIGINAL_EXECUTION';
 authenticatedAt:string;expiresAt:string;
}
/** The trusted operator must verify the actual human decision and original
 * provider/execution sources. This callback is code, never a JSON flag, default
 * verifier, file-hash inference or existing implementation authorization. */
export type RuntimeReleaseAuthenticator=(request:RuntimeReleaseAuthenticationRequest,signal:AbortSignal)=>Promise<RuntimeReleaseAuthentication>;
function decision(reference:ReleaseFileReference,subject:DecisionSubject):ReleaseFileReference {
 const value=parse(pinned(reference,1048576));exact(value,['schema','subject','source']);requireValue(value.schema==='evopilot-decision-evidence/v1'&&isDeepStrictEqual(value.subject,subject),'Decision must approve this exact release review');
 const original=object(value.source);exact(original,['reference','description']);text(original.description);let url:URL;
 try{url=new URL(text(original.reference));}catch{return fail('Decision source needs a pinned local reference');}
 requireValue(url.protocol==='file:'&&!url.host&&!url.search&&/^#sha256=[a-f0-9]{64}$/.test(url.hash),'Decision source needs a pinned local reference');const sourceHash=url.hash.slice(8);url.hash='';const sourceRef={ref:fileURLToPath(url),sha256:sourceHash};pinned(sourceRef,1048576);
 try{verifyDecisionEvidence(pathToFileURL(reference.ref).href+'#sha256='+reference.sha256,subject);}catch{return fail('Exact decision evidence verification failed');}return sourceRef;
}

/** Re-audit before and after trusted authentication. This authorizes only the
 * exact GitHub Preview publication. It neither publishes nor authorizes daily
 * installation, data migration, other components, or a post-release PASS. */
export async function verifyRuntimeReleaseDecision(repositoryRoot:string,raw:RuntimeReleasePreflightInput,expectedReviewDigest:string,decisionEvidence:ReleaseFileReference,authenticate:RuntimeReleaseAuthenticator,signal:AbortSignal) {
 requireValue(typeof authenticate==='function','A trusted real-decision authenticator is required');const input=structuredClone(raw),reference=structuredClone(decisionEvidence),review=await prepareRuntimeRelease(repositoryRoot,input,signal);
 requireValue(review.reviewDigest===expectedReviewDigest,'The concrete release review changed');
 const subject:DecisionSubject={owner:'runtime',operation:'release.publish',workspaceId:review.scope.workspaceId,scope:{visibility:'private',projectId:review.scope.projectId},reviewDigest:review.reviewDigest,decision:'APPROVE'},sourceRef=decision(reference,subject);
 const request:RuntimeReleaseAuthenticationRequest={schema:'runtime-release-authentication-request/v1',challenge:randomBytes(32).toString('hex'),review,subject,decisionEvidenceDigest:reference.sha256,decisionSourceDigest:sourceRef.sha256,sourceCiRecordsDigest:digest(review.sourceCi.recordPins),decisionEvidence:reference,decisionSource:sourceRef};
 const started=Date.now(),bounded=AbortSignal.any([signal,AbortSignal.timeout(30000)]);let stop:(()=>void)|undefined;let authenticated:RuntimeReleaseAuthentication;
 try{
  bounded.throwIfAborted();const interrupted=new Promise<never>((_resolve,reject)=>{stop=()=>reject(Error('Authentication interrupted'));bounded.addEventListener('abort',stop,{once:true});if(bounded.aborted)stop();});
  authenticated=structuredClone(await Promise.race([Promise.resolve().then(()=>authenticate(structuredClone(request),bounded)),interrupted]));
 }catch{return fail('Trusted release authentication failed');}finally{if(stop)bounded.removeEventListener('abort',stop);}
 exact(authenticated,['schema','challenge','subject','reviewDigest','candidateDigest','sourceCommit','decisionEvidenceDigest','decisionSourceDigest','sourceCiRecordsDigest','decision','humanIdentity','decisionAuthentication','sourceCiAuthentication','acceptanceAuthentication','authenticatedAt','expiresAt']);exact(authenticated.humanIdentity,['id','kind']);
 requireValue(authenticated.schema==='runtime-release-authentication/v1'&&authenticated.challenge===request.challenge&&isDeepStrictEqual(authenticated.subject,subject)&&authenticated.reviewDigest===review.reviewDigest&&authenticated.candidateDigest===review.publication.candidateDigest&&authenticated.sourceCommit===review.publication.sourceCommit&&authenticated.decisionEvidenceDigest===reference.sha256&&authenticated.decisionSourceDigest===sourceRef.sha256&&authenticated.sourceCiRecordsDigest===request.sourceCiRecordsDigest,'Authentication does not bind the exact request, decision and evidence');
 requireValue(authenticated.decision==='APPROVE'&&authenticated.humanIdentity.kind==='human'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(text(authenticated.humanIdentity.id))&&authenticated.decisionAuthentication==='AUTHENTICATED_HUMAN_DECISION'&&authenticated.sourceCiAuthentication==='AUTHENTICATED_PROVIDER_READS'&&authenticated.acceptanceAuthentication==='REVIEWED_ORIGINAL_EXECUTION','Actual human, provider and execution-source authentication is required');
 const at=Date.parse(authenticated.authenticatedAt),expires=Date.parse(authenticated.expiresAt),now=Date.now();requireValue(Number.isFinite(at)&&at>=started-60000&&at<=now+5000&&Number.isFinite(expires)&&expires>now&&expires>at&&expires<=started+900000,'Authentication is stale or unbounded');signal.throwIfAborted();
 const fresh=await prepareRuntimeRelease(repositoryRoot,input,signal);requireValue(fresh.reviewDigest===review.reviewDigest,'Release material changed during authentication');decision(reference,subject);requireValue(expires>Date.now(),'Authentication expired during final revalidation');signal.throwIfAborted();
 return{schema:'runtime-release-authorization/v1' as const,reviewDigest:review.reviewDigest,governance:review.governance,publication:review.publication,decisionEvidenceDigest:reference.sha256,decisionSourceDigest:sourceRef.sha256,authenticationDigest:digest(authenticated),expiresAt:authenticated.expiresAt,authorizedOperation:'github.preview.publish' as const,releaseAuthorized:true as const,installationAuthorized:false as const,migrationAuthorized:false as const,postRelease:review.acceptance.postRelease,overallCompletion:'NOT_COMPLETE' as const,privateEvidenceUploadAllowed:false as const};
}
