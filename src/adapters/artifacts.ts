import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fromBufferPromise, type ZipFile } from 'yauzl';
import { canonical, exact, record, reject, ServiceError, string } from '../server/errors.js';
import { byteDigest, valueDigest } from '../lifecycle/base.js';
import { candidateDigest, type CandidateManifest } from '../lifecycle/instance.js';
import { containsInlineSecret } from '../lifecycle/compiler.js';
import type { PlatformArtifactArchive, PlatformRunObservation, PlatformRunRequest } from './platforms.js';
import type { SourceTreeObservation } from './source-tree.js';
import {validatePreparationInput,validatePreparationOutput,type CiPreparationOutput} from './ci-preparation.js';

export const MAX_ARCHIVE_BYTES=128*1024*1024;
const MAX_EXPANDED_BYTES=256*1024*1024,MAX_ENTRIES=512;
const hash=(v:unknown):string=>{const s=string(v,71);if(!/^sha256:[a-f0-9]{64}$/.test(s))reject('CI_ARTIFACT_INVALID','Expected exact content digest');return s;};
export function artifactPath(value:unknown):string{
  const path=string(value,512);
  if(!/^[-a-zA-Z0-9_./]+$/.test(path)||path.split('/').some(s=>!s||s==='.'||s==='..'))reject('CI_ARCHIVE_PATH','Artifact paths must be relative, unambiguous regular files',409);return path;
}
/** ZIP data never becomes a filesystem path or executable. Upstream validates
 * entry sizes; Runtime additionally bounds expansion and checks CRC, collisions
 * and regular-file types before returning any bytes to its fixed collector. */
export async function readArtifactArchive(bytes:Buffer,signal:AbortSignal):Promise<ReadonlyMap<string,Buffer>>{
  if(bytes.length<22||bytes.length>MAX_ARCHIVE_BYTES)reject('CI_ARCHIVE_LIMIT','Artifact archive exceeds the bounded transfer profile',409);
  let zip:ZipFile|undefined;
  try{
    signal.throwIfAborted();zip=await fromBufferPromise(bytes,{lazyEntries:true,strictFileNames:true,validateEntrySizes:true,decodeStrings:true});
    if(zip.entryCount<1||zip.entryCount>MAX_ENTRIES)reject('CI_ARCHIVE_LIMIT','Artifact entry count exceeds the bounded profile',409);
    const files=new Map<string,Buffer>(),paths=new Map<string,boolean>();let expanded=0,count=0;
    for await(const entry of zip.eachEntry()){
      signal.throwIfAborted();if(++count>MAX_ENTRIES)reject('CI_ARCHIVE_LIMIT','Artifact entry count exceeds the bounded profile',409);
      const directory=entry.fileName.endsWith('/'),path=artifactPath(directory?entry.fileName.slice(0,-1):entry.fileName),key=path.toLowerCase(),mode=(entry.externalFileAttributes>>>16)&0o170000;
      if(paths.has(key)||[...paths].some(([old,isDir])=>old.startsWith(key+'/')&&!directory||key.startsWith(old+'/')&&!isDir))reject('CI_ARCHIVE_PATH','Artifact paths overlap or collide',409);
      paths.set(key,directory);
      if(entry.generalPurposeBitFlag&1||![0,8].includes(entry.compressionMethod)||mode!==0&&mode!==(directory?0o040000:0o100000))reject('CI_ARCHIVE_TYPE','Encrypted, linked or special artifact entries are not supported',409);
      if(!Number.isSafeInteger(entry.uncompressedSize)||entry.uncompressedSize<0||entry.uncompressedSize>MAX_EXPANDED_BYTES||expanded+entry.uncompressedSize>MAX_EXPANDED_BYTES||directory&&entry.uncompressedSize!==0)reject('CI_ARCHIVE_LIMIT','Artifact expansion exceeds the bounded profile',409);
      if(directory)continue;
      expanded+=entry.uncompressedSize;const stream=await zip.openReadStreamPromise(entry),chunks:Buffer[]=[];let actual=0,crc=0;
      const abort=()=>stream.destroy(new ServiceError('CI_ARTIFACT_INTERRUPTED','Artifact verification was interrupted',409));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      try{for await(const part of stream){const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);actual+=chunk.length;if(actual>entry.uncompressedSize||actual>MAX_EXPANDED_BYTES)reject('CI_ARCHIVE_LIMIT','Artifact expanded beyond its declared size',409);crc=crc32(chunk,crc);chunks.push(chunk);}}
      finally{signal.removeEventListener('abort',abort);stream.destroy();}
      if(actual!==entry.uncompressedSize||crc!==entry.crc32)reject('CI_ARCHIVE_INTEGRITY','Artifact size or CRC differs from its ZIP metadata',409);
      files.set(path,Buffer.concat(chunks));
    }
    signal.throwIfAborted();if(!files.size||count!==zip.entryCount)reject('CI_ARCHIVE_INVALID','Artifact archive is incomplete or empty',409);return files;
  }catch(e){if(e instanceof ServiceError)throw e;return reject('CI_ARCHIVE_INVALID','Artifact archive could not be safely verified',409);}finally{zip?.close();}
}
export interface CiEvidenceFile { path:string; digest:string; bytes:number; }
export interface CandidateArchiveIdentity {
  provider:'github'|'gitlab';repositoryId:string;runId:string;artifactId:string;jobId:string|null;
  archiveDigest:string;archiveBytes:number;
}
export interface CandidateInput {schema:'runtime-ci-candidate-input/v1';manifest:CandidateManifest;archive:CandidateArchiveIdentity;}
/** An immutable provider identity, never an arbitrary download URL or token. */
export function validateCandidateInput(value:CandidateInput,request:Pick<PlatformRunRequest,'candidateDigest'|'commit'>,provider:string,repositoryId:string):CandidateInput{
  const v=record(value);exact(v,['schema','manifest','archive']);const a=record(v.archive);exact(a,['provider','repositoryId','runId','artifactId','jobId','archiveDigest','archiveBytes']);
  if(v.schema!=='runtime-ci-candidate-input/v1'||candidateDigest(v.manifest as CandidateManifest)!==request.candidateDigest||record(v.manifest).sourceDigest!==ciSourceDigest(request as PlatformRunRequest,provider,repositoryId)||a.provider!==provider||a.repositoryId!==repositoryId||!['runId','artifactId','repositoryId'].every(k=>/^[1-9][0-9]{0,19}$/.test(string(a[k],20)))||provider==='github'&&a.jobId!==null||provider==='gitlab'&&(a.jobId!==a.artifactId)||!Number.isSafeInteger(a.archiveBytes)||Number(a.archiveBytes)<22||Number(a.archiveBytes)>MAX_ARCHIVE_BYTES||Buffer.byteLength(canonical(v))>49152)reject('CI_CANDIDATE_INPUT_INVALID','Candidate input must pin the original bounded archive and manifest',409);
  hash(a.archiveDigest);return value;
}
export interface CiArtifactCheck { id:string; status:'PASS'|'FAIL'|'UNKNOWN'; evidence:CiEvidenceFile[]; }
export interface CiArtifactResult {
  schema:'runtime-ci/v1'; requestId:string; inputDigest:string; provider:'github'|'gitlab';
  repositoryId:string; runId:string; sourceCommit:string; workflowDigest:string;
  stageId:string; candidateDigest:string|null; checks:CiArtifactCheck[]; candidate?:CandidateManifest;
  candidateConsumption?:{inputDigest:string;artifacts:CandidateManifest['artifacts']};
  preparationOutput?:CiPreparationOutput;
}
export interface VerifiedCiArtifact {
  schema:'runtime-ci-verified-artifact/v1'; requestId:string; inputDigest:string;
  runId:string; archiveDigest:string; resultDigest:string; evidenceRef:string;
  status:'PASSED'|'FAILED'|'UNKNOWN'; checks:CiArtifactCheck[]; candidate:CandidateManifest|null;
  candidateDigest:string|null; files:CiEvidenceFile[]; artifactsVerified:true;
  ownerEvaluationsVerified:false; lifecycleAcceptance:false;
  sourceArchive:CandidateArchiveIdentity;
  preparationOutput?:CiPreparationOutput;
}
/** Optional private evidence, never a required runtime-ci/v1 field. The fixed
 * reader is called only after registered-provider capture and archive retention.
 * Its integrity findings do not authenticate arbitrary caller-supplied bytes. */
export const CI_ACCEPTANCE_REPORT_PATH='evidence/acceptance-report.json';
export interface CiAcceptanceReportCapture {
  status:'ABSENT'|'INVALID'|'OBSERVED'|'UNAVAILABLE'; reasons:string[];
  report:CiEvidenceFile|null;
  producerJobId:string|null;
  producerBinding:'MATCHED_ORIGINAL_JOB'|'UNVERIFIED';
  workflowSource:'COMMITTED_BYTES_MATCHED'|'UNVERIFIED';
  collectorSource:'COMMITTED_BYTES_MATCHED'|'UNVERIFIED';
  collectorSemanticApproval:'UNKNOWN'; caseCatalog:'UNKNOWN';
  cases:{caseId:string;observedOutcome:'PASS'|'FAIL'|'NOT_RUN'|'CANCELLED'|'UNKNOWN'|'SKIPPED';rawReceipt:CiEvidenceFile}[];
}
export function unavailableCiAcceptanceReport(reason:string):CiAcceptanceReportCapture{
  return{status:'UNAVAILABLE',reasons:[reason],report:null,producerJobId:null,producerBinding:'UNVERIFIED',workflowSource:'UNVERIFIED',collectorSource:'UNVERIFIED',collectorSemanticApproval:'UNKNOWN',caseCatalog:'UNKNOWN',cases:[]};
}
/** Retain references to original ZIP bytes, never a rewritten receipt or an
 * OriginalEvidenceExecution. A matched committed blob is not semantic approval. */
export async function inspectCiAcceptanceReport(archive:PlatformArtifactArchive,request:PlatformRunRequest,verified:VerifiedCiArtifact,proof:{run:PlatformRunObservation;workflowPath:string;requirementsDigest:string;sourceTree?:SourceTreeObservation},signal:AbortSignal):Promise<CiAcceptanceReportCapture>{
  if(verified.requestId!==request.requestId||verified.inputDigest!==request.inputDigest||verified.runId!==archive.runId||verified.archiveDigest!==archive.archiveDigest||archive.archiveDigest!==byteDigest(archive.bytes))reject('CI_CAPTURE_ORIGIN_CHANGED','Acceptance capture requires the exact verified original archive',409);
  const files=await readArtifactArchive(archive.bytes,signal),bytes=files.get(CI_ACCEPTANCE_REPORT_PATH),capture=unavailableCiAcceptanceReport('REPORT_ABSENT');
  capture.status='ABSENT';if(!bytes)return capture;
  capture.report={path:CI_ACCEPTANCE_REPORT_PATH,digest:byteDigest(bytes),bytes:bytes.length};capture.status='INVALID';capture.reasons=[];
  const declared=new Map(verified.checks.flatMap(c=>c.evidence).map(f=>[f.path,f]));
  const file=(value:unknown):CiEvidenceFile=>{
    const f=record(value);exact(f,['path','digest','bytes']);const path=artifactPath(f.path),raw=files.get(path),expected=declared.get(path);
    if(path===CI_ACCEPTANCE_REPORT_PATH||!raw||!expected||raw.length!==f.bytes||raw.length>131072||raw.length===0||hash(f.digest)!==byteDigest(raw)||expected.digest!==f.digest||expected.bytes!==f.bytes)reject('CI_CAPTURE_FILE_INVALID','Acceptance raw evidence must match a bounded declared original file',409);
    return{path,digest:String(f.digest),bytes:raw.length};
  };
  try{
    const reportPin=declared.get(CI_ACCEPTANCE_REPORT_PATH);
    if(!reportPin||reportPin.digest!==capture.report.digest||reportPin.bytes!==bytes.length||bytes.length<1||bytes.length>131072)reject('CI_CAPTURE_REPORT_INVALID','Optional acceptance report must be bounded declared check evidence',409);
    const r=record(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
    exact(r,['schema','requestId','inputDigest','sourceCommit','workflowDigest','candidateDigest','requirementsDigest','producerJobId','workflow','collector','cases']);
    if(r.schema!=='runtime-ci-acceptance-report/v1'||r.requestId!==request.requestId||r.inputDigest!==request.inputDigest||r.sourceCommit!==request.commit||r.workflowDigest!==request.workflowDigest||r.candidateDigest!==verified.candidateDigest||r.requirementsDigest!==proof.requirementsDigest)reject('CI_CAPTURE_REPORT_MISMATCH','Acceptance report differs from original request/source/candidate requirements',409);
    if(!/^[1-9][0-9]{0,19}$/.test(string(r.producerJobId,20)))reject('CI_CAPTURE_REPORT_INVALID','Exact producer job identifier required',409);
    if(!Array.isArray(r.cases)||!r.cases.length||r.cases.length>64)reject('CI_CAPTURE_REPORT_INVALID','A bounded nonempty observed case set is required',409);
    const ids=new Set<string>(),paths=new Set<string>();
    const cases=r.cases.map(raw=>{
      const c=record(raw);exact(c,['caseId','outcome','rawReceipt']);const caseId=string(c.caseId,256);
      if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(caseId)||ids.has(caseId)||!['PASS','FAIL','NOT_RUN','CANCELLED','UNKNOWN','SKIPPED'].includes(String(c.outcome)))reject('CI_CAPTURE_REPORT_INVALID','Duplicate case or unsupported raw outcome',409);
      ids.add(caseId);const rawReceipt=file(c.rawReceipt);if(paths.has(rawReceipt.path))reject('CI_CAPTURE_REPORT_INVALID','Each observed case requires its distinct original receipt',409);paths.add(rawReceipt.path);
      return{caseId,observedOutcome:c.outcome as CiAcceptanceReportCapture['cases'][number]['observedOutcome'],rawReceipt};
    });
    // The report may identify a file, but the expected Git object comes only
    // from the original protected plan's authenticated source inventory.
    const tree=proof.sourceTree,treeValid=!!tree&&tree.commit===request.commit&&tree.provider===archive.provider&&tree.repositoryId===archive.repositoryId&&tree.projectId===request.projectId&&tree.bindingDigest===request.bindingDigest&&tree.inventoryDigest===valueDigest(tree.entries)&&tree.contentRead===false&&tree.sourceApproved===false;
    const source=(value:unknown,workflow:boolean):boolean=>{
      const s=record(value);exact(s,['sourcePath','file']);const sourcePath=artifactPath(s.sourcePath),pin=file(s.file),raw=files.get(pin.path)!;
      if(paths.has(pin.path))reject('CI_CAPTURE_REPORT_INVALID','Collector proof cannot replace a case receipt',409);paths.add(pin.path);
      const entry=treeValid?tree!.entries.find(e=>e.path===sourcePath):undefined;
      return !!entry&&entry.type==='blob'&&['100644','100755'].includes(entry.mode)&&entry.objectId===createHash('sha1').update(Buffer.from('blob '+raw.length+'\0')).update(raw).digest('hex')&&(!workflow||sourcePath===proof.workflowPath&&pin.digest===request.workflowDigest);
    };
    const workflow=source(r.workflow,true),collector=source(r.collector,false),run=proof.run;
    const sameRun=run.requestId===request.requestId&&run.inputDigest===request.inputDigest&&run.provider===archive.provider&&run.repositoryId===archive.repositoryId&&run.commit===request.commit&&run.runId===archive.runId;
    const matching=run.jobs.filter(j=>j.jobId===r.producerJobId&&j.provider===archive.provider&&j.repositoryId===archive.repositoryId&&j.projectId===request.projectId&&j.runId===archive.runId&&j.commit===request.commit);
    const producer=sameRun&&matching.length===1&&(archive.provider==='github'?archive.jobId===null&&run.jobs.length===1:archive.jobId===r.producerJobId&&archive.artifactId===r.producerJobId);
    return{status:'OBSERVED',reasons:[...(!producer?['PRODUCER_JOB_UNVERIFIED']:[]),...(!workflow?['WORKFLOW_SOURCE_UNVERIFIED']:[]),...(!collector?['COLLECTOR_SOURCE_UNVERIFIED']:[]),'COLLECTOR_SEMANTIC_APPROVAL_UNKNOWN','CASE_CATALOG_UNKNOWN'],report:capture.report,producerJobId:producer?String(r.producerJobId):null,producerBinding:producer?'MATCHED_ORIGINAL_JOB':'UNVERIFIED',workflowSource:workflow?'COMMITTED_BYTES_MATCHED':'UNVERIFIED',collectorSource:collector?'COMMITTED_BYTES_MATCHED':'UNVERIFIED',collectorSemanticApproval:'UNKNOWN',caseCatalog:'UNKNOWN',cases};
  }catch(error){
    signal.throwIfAborted();capture.reasons=[error instanceof ServiceError&&error.code.startsWith('CI_CAPTURE_')?error.code:'CI_CAPTURE_REPORT_INVALID'];return capture;
  }
}
export const ciSourceDigest=(request:PlatformRunRequest,provider:string,repositoryId:string):string=>valueDigest({provider,repositoryId,commit:request.commit});
export const ciBuildDigest=(request:PlatformRunRequest,runId:string):string=>valueDigest({requestId:request.requestId,inputDigest:request.inputDigest,bindingDigest:request.bindingDigest,workflowDigest:request.workflowDigest,runId});
/** The CI contract is evidence from the exact workflow, not a generic client
 * PASS endpoint. Owner evaluations and release authority are separate checks. */
export async function verifyCiArtifact(archive:PlatformArtifactArchive,request:PlatformRunRequest,expectedChecks:readonly string[],signal:AbortSignal):Promise<VerifiedCiArtifact>{
  if(archive.requestId!==request.requestId||archive.inputDigest!==request.inputDigest||archive.bindingDigest!==request.bindingDigest||archive.commit!==request.commit||archive.name!=='runtime-ci'||archive.archiveDigest!==byteDigest(archive.bytes)||archive.archiveBytes!==archive.bytes.length)reject('CI_ARTIFACT_MISMATCH','Archive does not match the original request and downloaded bytes',409);
  if(expectedChecks.length>128||new Set(expectedChecks).size!==expectedChecks.length||expectedChecks.some(id=>typeof id!=='string'||!id.length))reject('CI_CHECK_SCOPE','Expected checks must be a fixed unique set',409);
  const files=await readArtifactArchive(archive.bytes,signal),resultBytes=files.get('runtime-result.json');
  if(!resultBytes||resultBytes.length>2097152)reject('CI_RESULT_MISSING','Bounded runtime-result.json is required at archive root',409);
  let result:Record<string,unknown>;try{result=record(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(resultBytes)));}catch{return reject('CI_RESULT_INVALID','CI result must be valid UTF-8 JSON',409);}
  exact(result,['schema','requestId','inputDigest','provider','repositoryId','runId','sourceCommit','workflowDigest','stageId','candidateDigest','checks'],['candidate','candidateConsumption','preparationOutput']);
  if(result.schema!=='runtime-ci/v1'||result.requestId!==request.requestId||result.inputDigest!==request.inputDigest||result.provider!==archive.provider||result.repositoryId!==archive.repositoryId||result.runId!==archive.runId||result.sourceCommit!==request.commit||result.workflowDigest!==request.workflowDigest||result.stageId!==request.stageId||result.candidateDigest!==request.candidateDigest)reject('CI_RESULT_MISMATCH','CI evidence belongs to different request/source/stage/candidate pins',409);
  if(containsInlineSecret(canonical(result)))reject('CI_RESULT_INVALID','CI result metadata contains inline credentials',409);
  if(!Array.isArray(result.checks)||result.checks.length>128)reject('CI_CHECK_SCOPE','CI result check set must be bounded',409);
  const declared=new Set<string>(['runtime-result.json']),ids=new Set<string>();
  const verifyFile=(raw:unknown):CiEvidenceFile=>{const f=record(raw);exact(f,['path','digest','bytes']);const path=artifactPath(f.path),bytes=files.get(path);if(!bytes||!Number.isSafeInteger(f.bytes)||f.bytes!==bytes.length||hash(f.digest)!==byteDigest(bytes))reject('CI_ARTIFACT_INTEGRITY','Required artifact content differs or is missing',409);declared.add(path);return{path,digest:String(f.digest),bytes:Number(f.bytes)};};
  const checks:CiArtifactCheck[]=result.checks.map(raw=>{const c=record(raw);exact(c,['id','status','evidence']);const id=string(c.id,256);if(ids.has(id)||!expectedChecks.includes(id)||!['PASS','FAIL','UNKNOWN'].includes(String(c.status))||!Array.isArray(c.evidence)||!c.evidence.length||c.evidence.length>64)reject('CI_CHECK_SCOPE','CI evidence contains duplicate, unexpected or unsupported checks',409);ids.add(id);return{id,status:c.status as CiArtifactCheck['status'],evidence:c.evidence.map(verifyFile)};});
  if(ids.size!==expectedChecks.length)reject('CI_CHECK_SCOPE','CI result omits a fixed required check',409);
  let candidate:CandidateManifest|null=null,newDigest:string|null=request.candidateDigest;
  if(result.candidate!==undefined){
    if(request.stageId!=='candidate'||request.candidateDigest!==null)reject('CI_CANDIDATE_MUTATION','Only candidate creation may introduce a candidate manifest',409);
    candidate=result.candidate as CandidateManifest;newDigest=candidateDigest(candidate);
    if(candidate.sourceDigest!==ciSourceDigest(request,archive.provider,archive.repositoryId)||candidate.buildDigest!==ciBuildDigest(request,archive.runId))reject('CI_CANDIDATE_MISMATCH','Candidate source/build identities differ from the actual CI request',409);
    for(const item of candidate.artifacts)verifyFile({path:'artifacts/'+item.name,digest:item.digest,bytes:item.bytes});
  }else if(request.stageId==='candidate')reject('CI_CANDIDATE_MISSING','Candidate stage needs its exact built artifact manifest',409);
  if(request.candidateDigest!==null){
    if(!request.candidateInput)reject('CI_CANDIDATE_INPUT_REQUIRED','Verification needs the original candidate archive, not only its digest',409);
    const input=validateCandidateInput(request.candidateInput,request,archive.provider,archive.repositoryId),consumed=record(result.candidateConsumption??{});
    exact(consumed,['inputDigest','artifacts']);
    if(consumed.inputDigest!==valueDigest(input)||canonical(consumed.artifacts)!==canonical(input.manifest.artifacts))reject('CI_CANDIDATE_CONSUMPTION','Evidence must identify every consumed artifact from the original candidate',409);
    for(const item of input.manifest.artifacts)verifyFile({path:'candidate/'+item.name,digest:item.digest,bytes:item.bytes});
  }else if(result.candidateConsumption!==undefined||request.candidateInput!==undefined)reject('CI_CANDIDATE_CONSUMPTION','A pre-candidate stage cannot claim candidate consumption',409);
  let preparationOutput:CiPreparationOutput|undefined;
  if(request.preparationInput){
    validatePreparationInput(request.preparationInput,request,archive.provider);
    preparationOutput=validatePreparationOutput(result.preparationOutput as CiPreparationOutput,request.preparationInput,archive.provider);
    for(const file of preparationOutput.source.artifacts)verifyFile({...file,path:'prepared-source/'+file.path});
  }else if(result.preparationOutput!==undefined)reject('CI_PREPARATION_OUTPUT','A non-preparation request cannot introduce a source output',409);
  for(const path of files.keys())if(!declared.has(path))reject('CI_ARTIFACT_UNDECLARED','CI archive includes undeclared files',409);
  const status=archive.runStatus==='FAILED'||checks.some(c=>c.status==='FAIL')?'FAILED':archive.runStatus==='PASSED'&&checks.every(c=>c.status==='PASS')?'PASSED':'UNKNOWN';
  const sourceArchive:CandidateArchiveIdentity={provider:archive.provider,repositoryId:archive.repositoryId,runId:archive.runId,artifactId:archive.artifactId,jobId:archive.jobId,archiveDigest:archive.archiveDigest,archiveBytes:archive.archiveBytes};
  return{schema:'runtime-ci-verified-artifact/v1',requestId:request.requestId,inputDigest:request.inputDigest,runId:archive.runId,archiveDigest:archive.archiveDigest,resultDigest:byteDigest(resultBytes),evidenceRef:archive.evidenceRef,status,checks,candidate,candidateDigest:newDigest,files:[...files].map(([path,bytes])=>({path,digest:byteDigest(bytes),bytes:bytes.length})),artifactsVerified:true,ownerEvaluationsVerified:false,lifecycleAcceptance:false,sourceArchive,...(preparationOutput?{preparationOutput}:{})};
}
