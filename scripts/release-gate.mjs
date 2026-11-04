// Runtime-only I/O adapter. TypeScript owns source/evidence/decision judgments.
// This file never builds a package or supplies an authentication implementation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {crc32} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const repository='yeliang-wang/evopilot-runtime',repositoryId=1416265295;
export const assetNames=Object.freeze(['SHA256SUMS','distribution-manifest.json','evopilot-next-runtime-0.9.0.tgz','evopilot-runtime-0.9.0-darwin-arm64.tar.gz','runtime-dependency-lock.json','source-revision.txt']);
const sourceRoot=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url))),MAX_ZIP=128*1024*1024,MAX_EXPANDED=256*1024*1024;
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
const requireValue=(value,code)=>{if(!value)fail(code);};
const object=value=>{requireValue(value&&typeof value==='object'&&!Array.isArray(value),'INVALID_OBJECT');return value;};
const exact=(value,keys)=>assert.deepEqual(Object.keys(object(value)).sort(),[...keys].sort(),'Unexpected input fields');
const hash=value=>requireValue(typeof value==='string'&&value.length===64&&/^[a-f0-9]{64}$/.test(value),'INVALID_DIGEST');
const id=value=>{requireValue(Number.isSafeInteger(value)&&value>0,'INVALID_PROVIDER_ID');return value;};
const parse=bytes=>{try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return fail('INVALID_JSON_RESPONSE');}};
function read(filename,maximum=16*1024*1024,privateFile=true){
 requireValue(path.isAbsolute(filename)&&path.resolve(filename)===filename&&fs.realpathSync(filename)===filename,'UNSAFE_PATH');const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const s=fs.fstatSync(fd);requireValue(s.isFile()&&s.nlink===1&&s.size>0&&s.size<=maximum,'UNSAFE_FILE');if(privateFile)requireValue((s.mode&0o077)===0&&s.uid===process.getuid?.(),'PRIVATE_FILE_REQUIRED');const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd);requireValue(bytes.length===s.size&&after.mtimeMs===s.mtimeMs&&after.ctimeMs===s.ctimeMs&&after.size===s.size,'FILE_CHANGED');return bytes;}finally{fs.closeSync(fd);}
}
function pinned(ref,maximum){exact(ref,['ref','sha256']);hash(ref.sha256);const bytes=read(ref.ref,maximum);requireValue(sha256(bytes)===ref.sha256,'PIN_CHANGED');return bytes;}
function newRoot(root,repo=sourceRoot){requireValue(path.isAbsolute(root)&&path.resolve(root)===root&&fs.realpathSync(path.dirname(root))===path.dirname(root)&&root!==repo&&!root.startsWith(repo+path.sep),'NEW_PRIVATE_OUTPUT_REQUIRED');fs.mkdirSync(root,{mode:0o700});return root;}
const save=(root,name,value)=>{requireValue(/^[A-Za-z0-9_.-]+$/.test(name),'INVALID_EVIDENCE_NAME');const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value,null,2)+'\n'),ref=path.join(root,name);fs.writeFileSync(ref,bytes,{flag:'wx',mode:0o600});return{ref,sha256:sha256(bytes)};};
function cleanSource(root,commit){
 requireValue(path.isAbsolute(root)&&fs.realpathSync(root)===root&&typeof commit==='string'&&commit.length===40&&/^[a-f0-9]{40}$/.test(commit),'INVALID_SOURCE');
 const git=args=>{const r=spawnSync('/usr/bin/git',['-c','core.fsmonitor=false','-C',root,...args],{env:{PATH:'/usr/bin:/bin',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'},encoding:'utf8',timeout:15000,maxBuffer:4194304});requireValue(!r.error&&r.status===0,'SOURCE_INSPECTION_FAILED');return r.stdout;};
 requireValue(git(['rev-parse','HEAD']).trim()===commit&&git(['status','--porcelain']).length===0,'EXACT_CLEAN_SOURCE_REQUIRED');const pkg=parse(read(path.join(root,'package.json'),1048576,false));requireValue(pkg.name==='@evopilot-next/runtime'&&pkg.version==='0.9.0','INDEPENDENT_RUNTIME_REQUIRED');
}

/** Never retain headers/stderr: they can contain signed URLs or credentials. */
export function decodeGitHubResponse(result,maxBytes){
 if(result.error||result.signal||result.status===null||!Buffer.isBuffer(result.stdout)||result.stdout.length>maxBytes+65536)return{status:null,body:Buffer.alloc(0),transport:'UNKNOWN'};
 let bytes=result.stdout;
 for(let n=0;n<5;n++){
  const crlf=bytes.indexOf('\r\n\r\n'),lf=bytes.indexOf('\n\n'),end=crlf>=0&&(lf<0||crlf<lf)?crlf:lf,delimiter=end===crlf&&crlf>=0?4:2;if(end<0||end>65536)return{status:null,body:Buffer.alloc(0),transport:'UNKNOWN'};
  const m=/^HTTP\/\S+ ([0-9]{3})(?:[ \r\n]|$)/.exec(bytes.subarray(0,end).toString('latin1'));if(!m)return{status:null,body:Buffer.alloc(0),transport:'UNKNOWN'};const status=Number(m[1]);bytes=bytes.subarray(end+delimiter);
  if(status>=300&&status<400&&/^HTTP\//.test(bytes.subarray(0,16).toString('ascii')))continue;
  if(bytes.length>maxBytes||result.status===0&&status>=400||result.status!==0&&status<400)return{status:null,body:Buffer.alloc(0),transport:'UNKNOWN'};return{status,body:bytes,transport:'HTTP'};
 }
 return{status:null,body:Buffer.alloc(0),transport:'UNKNOWN'};
}
export function gitHubRequest(method,endpoint,{body=null,accept='application/vnd.github+json',maxBytes=16*1024*1024}={}){
 requireValue(['GET','POST','PATCH'].includes(method)&&Number.isSafeInteger(maxBytes)&&maxBytes>0&&maxBytes<=MAX_EXPANDED,'INVALID_GITHUB_REQUEST');
 requireValue(typeof endpoint==='string'&&!endpoint.includes('..')&&!endpoint.includes('%')&&!/[\\\r\n#]/.test(endpoint)&&['application/vnd.github+json','application/octet-stream'].includes(accept),'GITHUB_SCOPE');
 requireValue(endpoint.startsWith('repos/'+repository+'/')||endpoint==='repos/'+repository||new RegExp('^https://uploads\\.github\\.com/repos/'+repository+'/releases/[1-9][0-9]*/assets\\?name=[A-Za-z0-9.-]+$').test(endpoint),'GITHUB_SCOPE');
 const args=['api','--include','--method',method,endpoint,'-H','Accept: '+accept];let input;if(body!==null){input=Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));args.push('-H','Content-Type: '+(Buffer.isBuffer(body)?'application/octet-stream':'application/json'),'--input','-');}
 const result=spawnSync('gh',args,{input,encoding:null,maxBuffer:maxBytes+65536,timeout:180000,env:{...process.env,GH_PAGER:'cat',GH_PROMPT_DISABLED:'1'}});return decodeGitHubResponse(result,maxBytes);
}
function journal(root,transport){let sequence=0;return async(method,endpoint,options={})=>{
 const n=String(++sequence).padStart(4,'0'),body=options.body===undefined?null:Buffer.isBuffer(options.body)?options.body:Buffer.from(JSON.stringify(options.body));save(root,n+'-request.json',{method,endpoint,bodyBytes:body?.length??0,bodyDigest:body?sha256(body):null,automaticRetry:false});
 let response;try{response=await transport(method,endpoint,options);}catch{response={status:null,body:Buffer.alloc(0),transport:'UNKNOWN'};}
 requireValue(response&&Buffer.isBuffer(response.body)&&response.body.length<=(options.maxBytes??16*1024*1024),'INVALID_TRANSPORT_RESPONSE');const raw=save(root,n+'-response.bin',response.body);save(root,n+'-response.json',{status:response.status,transport:response.transport,bodyDigest:raw.sha256,bodyBytes:response.body.length});return response;
};}
function expect(response,status){requireValue(response.transport==='HTTP'&&response.status===status,'GITHUB_OUTCOME_UNKNOWN_OR_UNEXPECTED');return response.body;}
export function requireAbsent(response){requireValue(response?.transport==='HTTP'&&response.status===404,'INSPECT_EXISTING_BEFORE_RETRY');}

/** Flat allowlist, bounded expansion and CRC. No ZIP path is extracted. */
export async function readReleaseZip(bytes,signal=AbortSignal.timeout(30000)){
 requireValue(Buffer.isBuffer(bytes)&&bytes.length>=22&&bytes.length<=MAX_ZIP,'ZIP_LIMIT');const {fromBufferPromise}=await import('yauzl');let zip;
 try{
  zip=await fromBufferPromise(bytes,{lazyEntries:true,strictFileNames:true,validateEntrySizes:true,decodeStrings:true});requireValue(zip.entryCount===6,'ZIP_ENTRY_ALLOWLIST');const files=new Map();let expanded=0;
  for await(const e of zip.eachEntry()){
   signal.throwIfAborted();const mode=(e.externalFileAttributes>>>16)&0o170000;requireValue(assetNames.includes(e.fileName)&&!files.has(e.fileName)&&!e.fileName.includes('/')&&![...files.keys()].some(n=>n.toLowerCase()===e.fileName.toLowerCase()),'ZIP_ENTRY_ALLOWLIST');
   requireValue(!(e.generalPurposeBitFlag&1)&&[0,8].includes(e.compressionMethod)&&[0,0o100000].includes(mode)&&!(e.externalFileAttributes&16),'ZIP_REGULAR_FILE_REQUIRED');
   requireValue(Number.isSafeInteger(e.uncompressedSize)&&e.uncompressedSize>0&&e.uncompressedSize<=MAX_EXPANDED&&Number.isSafeInteger(e.compressedSize)&&e.compressedSize>=0&&e.compressedSize<=bytes.length&&expanded+e.uncompressedSize<=MAX_EXPANDED&&e.uncompressedSize<=Math.max(65536,e.compressedSize*1000),'ZIP_EXPANSION_LIMIT');expanded+=e.uncompressedSize;
   const stream=await zip.openReadStreamPromise(e),parts=[];let length=0,crc=0;const abort=()=>stream.destroy(Error('ZIP_INTERRUPTED'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
   try{for await(const part of stream){const b=Buffer.from(part);length+=b.length;requireValue(length<=e.uncompressedSize&&length<=MAX_EXPANDED,'ZIP_EXPANSION_LIMIT');crc=crc32(b,crc);parts.push(b);}}finally{signal.removeEventListener('abort',abort);stream.destroy();}
   requireValue(length===e.uncompressedSize&&crc===e.crc32,'ZIP_INTEGRITY');files.set(e.fileName,Buffer.concat(parts));
  }
  assert.deepEqual([...files.keys()].sort(),[...assetNames].sort());signal.throwIfAborted();return files;
 }catch(error){if(error?.code)throw error;return fail('ZIP_INVALID');}finally{zip?.close();}
}
export function validateDistributionFiles(files,commit){
 assert.deepEqual([...files.keys()].sort(),[...assetNames].sort());const checksum=files.get('SHA256SUMS').toString('utf8');requireValue(checksum.endsWith('\n'),'CHECKSUM_FORMAT');const lines=checksum.slice(0,-1).split('\n'),seen=new Set();requireValue(lines.length===5,'CHECKSUM_COVERAGE');
 for(const line of lines){const m=/^([a-f0-9]{64})  ([A-Za-z0-9.-]+)$/.exec(line);requireValue(m&&m[2]!=='SHA256SUMS'&&files.has(m[2])&&!seen.has(m[2]),'CHECKSUM_COVERAGE');seen.add(m[2]);requireValue(sha256(files.get(m[2]))===m[1],'CHECKSUM_MISMATCH');}
 requireValue(files.get('source-revision.txt').toString()===commit+'\n','SOURCE_REVISION_MISMATCH');const manifest=parse(files.get('distribution-manifest.json'));exact(manifest,['schema','version','archiveDigest','files']);hash(manifest.archiveDigest);requireValue(manifest.schema==='runtime-standalone-distribution/v1'&&manifest.version==='0.9.0'&&sha256(files.get('evopilot-runtime-0.9.0-darwin-arm64.tar.gz'))===manifest.archiveDigest&&Object.keys(object(manifest.files)).length>0&&Object.keys(manifest.files).length<=20000,'DISTRIBUTION_IDENTITY');
 const lock=parse(files.get('runtime-dependency-lock.json'));requireValue(lock.name==='@evopilot-next/runtime'&&lock.version==='0.9.0'&&lock.lockfileVersion===3,'DISTRIBUTION_LOCK');return manifest;
}
export function validatePreparation(input){
 exact(input,['repository','repositoryRoot','sourceCommit','sourceRunId','artifactDigest','outputRoot']);requireValue(input.repository===repository&&typeof input.sourceCommit==='string'&&input.sourceCommit.length===40&&/^[a-f0-9]{40}$/.test(input.sourceCommit),'RUNTIME_RELEASE_SCOPE');hash(input.artifactDigest);requireValue(typeof input.sourceRunId==='string'&&/^[1-9][0-9]*$/.test(input.sourceRunId)&&String(id(Number(input.sourceRunId)))===input.sourceRunId,'INVALID_RUN_ID');
}
export async function prepareCiDistribution(raw,{github=gitHubRequest,signal=AbortSignal.timeout(300000)}={}){
 const input=structuredClone(raw);validatePreparation(input);cleanSource(input.repositoryRoot,input.sourceCommit);newRoot(input.outputRoot,input.repositoryRoot);const evidence=path.join(input.outputRoot,'source-ci'),assets=path.join(input.outputRoot,'assets');fs.mkdirSync(evidence,{mode:0o700});fs.mkdirSync(assets,{mode:0o700});const call=journal(evidence,github),prefix='repos/'+repository;
 try{
  const runBytes=expect(await call('GET',prefix+'/actions/runs/'+input.sourceRunId),200),run=parse(runBytes);id(run.id);id(run.run_attempt);requireValue(run.id===Number(input.sourceRunId)&&run.repository?.id===repositoryId&&run.repository?.full_name===repository&&run.head_repository?.id===repositoryId&&run.head_sha===input.sourceCommit&&run.path==='.github/workflows/ci.yml'&&run.status==='completed'&&run.conclusion==='success'&&['push','workflow_dispatch','pull_request'].includes(run.event),'SOURCE_CI_IDENTITY');
  const jobsBytes=expect(await call('GET',prefix+'/actions/runs/'+input.sourceRunId+'/attempts/'+run.run_attempt+'/jobs?per_page=100'),200),jobs=parse(jobsBytes);requireValue(jobs.total_count===1&&Array.isArray(jobs.jobs)&&jobs.jobs.length===1,'SOURCE_JOBS_INCOMPLETE');const job=jobs.jobs[0];id(job.id);requireValue(job.name==='source'&&job.run_id===run.id&&job.run_attempt===run.run_attempt&&job.head_sha===input.sourceCommit&&job.status==='completed'&&job.conclusion==='success','SOURCE_JOB_IDENTITY');
  const listed=parse(expect(await call('GET',prefix+'/actions/runs/'+input.sourceRunId+'/artifacts?per_page=100'),200));requireValue(Array.isArray(listed.artifacts)&&listed.total_count===listed.artifacts.length&&listed.total_count<=100,'ARTIFACT_LIST_INCOMPLETE');const matches=listed.artifacts.filter(a=>a.name===`evopilot-runtime-${input.sourceCommit}-package`);requireValue(matches.length===1,'ARTIFACT_AMBIGUOUS');const artifactId=id(matches[0].id);
  const artifactBytes=expect(await call('GET',prefix+'/actions/artifacts/'+artifactId),200),artifact=parse(artifactBytes);requireValue(artifact.id===artifactId&&artifact.name===matches[0].name&&artifact.expired===false&&Date.parse(artifact.expires_at)>Date.now()&&artifact.workflow_run?.id===run.id&&artifact.workflow_run?.head_sha===input.sourceCommit&&artifact.workflow_run?.repository_id===repositoryId&&artifact.workflow_run?.head_repository_id===repositoryId&&artifact.digest==='sha256:'+input.artifactDigest,'ARTIFACT_IDENTITY');
  const zipBytes=expect(await call('GET',prefix+'/actions/artifacts/'+artifactId+'/zip',{accept:'application/octet-stream',maxBytes:MAX_ZIP}),200);requireValue(zipBytes.length===artifact.size_in_bytes&&sha256(zipBytes)===input.artifactDigest,'ARTIFACT_DIGEST');
  const logBytes=expect(await call('GET',prefix+'/actions/jobs/'+job.id+'/logs'),200),files=await readReleaseZip(zipBytes,signal);validateDistributionFiles(files,input.sourceCommit);requireValue(sha256(files.get('runtime-dependency-lock.json'))===sha256(read(path.join(input.repositoryRoot,'package-lock.json'),8388608,false)),'SOURCE_LOCK_MISMATCH');cleanSource(input.repositoryRoot,input.sourceCommit);
  const sourceCi={run:save(evidence,'run.json',runBytes),jobs:save(evidence,'jobs.json',jobsBytes),artifact:save(evidence,'artifact.json',artifactBytes),jobLog:save(evidence,'job.log',logBytes),artifactZip:save(evidence,'artifact.zip',zipBytes)},fileRefs=Object.fromEntries(assetNames.map(n=>[n,save(assets,n,files.get(n))]));save(input.outputRoot,'candidate-input.json',{schema:'runtime-release-candidate-input/v1',repository,sourceCommit:input.sourceCommit,files:fileRefs,sourceCi});
  const result={schema:'runtime-ci-preparation/v1',status:'PACKAGE_STAGED_ONLY',repository,sourceCommit:input.sourceCommit,artifactDigest:input.artifactDigest,files:Object.fromEntries(assetNames.map(n=>[n,fileRefs[n].sha256])),productAcceptance:'NOT_EVALUATED',releaseAuthorized:false,fullLocalPreflightRequired:true,privateEvidenceUploadAllowed:false};save(input.outputRoot,'preparation.json',result);return result;
 }catch(error){save(input.outputRoot,'failure.json',{code:typeof error?.code==='string'?error.code:'PREPARATION_FAILED',automaticRetry:false,evidenceRetained:true});throw error;}
}
export async function preflightRelease(inputRef,outputRoot,repositoryRoot=sourceRoot){const input=parse(read(inputRef,2097152));const {prepareRuntimeRelease}=await import('../dist/release/gate.js');const review=await prepareRuntimeRelease(repositoryRoot,input,AbortSignal.timeout(300000));newRoot(outputRoot,repositoryRoot);save(outputRoot,'REVIEW.json',review);return review;}
export function validateReleaseReadback(value,publication,notes,draft){const r=object(value);id(r.id);requireValue(r.tag_name===publication.tag&&r.name===publication.title&&r.body===notes&&r.prerelease===true&&r.draft===draft&&(draft||r.html_url===`https://github.com/${repository}/releases/tag/${publication.tag}`&&Number.isFinite(Date.parse(r.published_at))&&Date.parse(r.published_at)<=Date.now()+5000),'RELEASE_READBACK_MISMATCH');return r.id;}
function assetIdentity(value,expected){const a=object(value);id(a.id);requireValue(a.name===expected.name&&a.state==='uploaded'&&a.size===expected.bytes&&(a.digest==null||a.digest==='sha256:'+expected.sha256),'ASSET_READBACK_MISMATCH');return{id:a.id,name:a.name,state:a.state,size:a.size,digest:a.digest??null};}
const byName=(a,b)=>a.name<b.name?-1:a.name>b.name?1:0;
export function validateAssetList(values,filePins){
 assert.deepEqual(Object.keys(object(filePins)).sort(),[...assetNames].sort());requireValue(Array.isArray(values)&&values.length===6,'RELEASE_ASSET_ALLOWLIST');const mapped=values.map(v=>{requireValue(Object.hasOwn(filePins,v.name),'RELEASE_ASSET_ALLOWLIST');return assetIdentity(v,{name:v.name,...filePins[v.name]});}).sort(byName);
 assert.deepEqual(mapped.map(a=>a.name),[...assetNames].sort());requireValue(new Set(mapped.map(a=>a.id)).size===6,'RELEASE_ASSET_IDENTITY');return mapped;
}

/** Only trusted local code may supply real authentication. No CLI flag,
 * serialized authorization or module-path loader can provide it. */
export async function publishReviewedRuntime(raw,authenticate,{github=gitHubRequest,signal=AbortSignal.timeout(900000)}={}){
 requireValue(typeof authenticate==='function','TRUSTED_LOCAL_OPERATOR_REQUIRED');const options=structuredClone(raw);exact(options,['repositoryRoot','input','expectedReviewDigest','decisionEvidence','outputRoot']);const {verifyRuntimeReleaseDecision}=await import('../dist/release/gate.js');
 const authorization=await verifyRuntimeReleaseDecision(options.repositoryRoot,options.input,options.expectedReviewDigest,options.decisionEvidence,authenticate,signal),publication=authorization.publication;requireValue(authorization.releaseAuthorized===true&&authorization.authorizedOperation==='github.preview.publish'&&publication.repository===repository&&publication.tag==='v0.9.0','EXACT_PUBLICATION_AUTHORITY_REQUIRED');
 newRoot(options.outputRoot,options.repositoryRoot);const evidence=path.join(options.outputRoot,'evidence'),staged=path.join(options.outputRoot,'assets');fs.mkdirSync(evidence,{mode:0o700});fs.mkdirSync(staged,{mode:0o700});const call=journal(evidence,github),prefix='repos/'+repository;
 const current=()=>{signal.throwIfAborted();requireValue(Date.parse(authorization.expiresAt)>Date.now(),'PUBLICATION_AUTHORITY_EXPIRED');cleanSource(options.repositoryRoot,publication.sourceCommit);};
 try{
  save(evidence,'authorization.json',authorization);const files=new Map();for(const name of assetNames){const bytes=pinned(options.input.candidate.files[name],MAX_EXPANDED);requireValue(sha256(bytes)===publication.files[name].sha256&&bytes.length===publication.files[name].bytes,'PUBLICATION_BYTES_CHANGED');files.set(name,bytes);save(staged,name,bytes);}validateDistributionFiles(files,publication.sourceCommit);
  const notesBytes=pinned(options.input.releaseNotes,262144);requireValue(sha256(notesBytes)===publication.releaseNotes.sha256&&notesBytes.length===publication.releaseNotes.bytes,'PUBLICATION_NOTES_CHANGED');save(evidence,'release-notes.md',notesBytes);const notes=notesBytes.toString('utf8');
  const repo=parse(expect(await call('GET',prefix),200));requireValue(repo.id===repositoryId&&repo.full_name===repository&&repo.permissions?.push===true,'REPOSITORY_WRITE_PERMISSION_REQUIRED');requireAbsent(await call('GET',prefix+'/git/ref/tags/'+publication.tag));requireAbsent(await call('GET',prefix+'/releases/tags/'+publication.tag));current();
  const tag=parse(expect(await call('POST',prefix+'/git/refs',{body:{ref:'refs/tags/'+publication.tag,sha:publication.sourceCommit}}),201));requireValue(tag.ref==='refs/tags/'+publication.tag&&tag.object?.type==='commit'&&tag.object?.sha===publication.sourceCommit,'TAG_CREATE_UNKNOWN');current();
  const release=parse(expect(await call('POST',prefix+'/releases',{body:{tag_name:publication.tag,target_commitish:publication.sourceCommit,name:publication.title,body:notes,draft:true,prerelease:true,make_latest:'false'}}),201)),releaseId=validateReleaseReadback(release,publication,notes,true),uploaded=[];
  for(const name of assetNames){current();const a=parse(expect(await call('POST',`https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${name}`,{body:files.get(name)}),201));uploaded.push(assetIdentity(a,{name,...publication.files[name]}));}
  const list=async()=>validateAssetList(parse(expect(await call('GET',prefix+'/releases/'+releaseId+'/assets?per_page=100'),200)),publication.files);
  const before=await list();assert.deepEqual(before,[...uploaded].sort(byName));validateReleaseReadback(parse(expect(await call('GET',prefix+'/releases/'+releaseId),200)),publication,notes,true);
  for(const asset of before){const bytes=expect(await call('GET',prefix+'/releases/assets/'+asset.id,{accept:'application/octet-stream',maxBytes:MAX_EXPANDED}),200);requireValue(bytes.length===publication.files[asset.name].bytes&&sha256(bytes)===publication.files[asset.name].sha256,'DOWNLOADED_ASSET_MISMATCH');}
  assert.deepEqual(await list(),before);current();const published=parse(expect(await call('PATCH',prefix+'/releases/'+releaseId,{body:{draft:false,make_latest:'false'}}),200));requireValue(validateReleaseReadback(published,publication,notes,false)===releaseId,'RELEASE_ID_CHANGED');
  const finalTag=parse(expect(await call('GET',prefix+'/git/ref/tags/'+publication.tag),200));requireValue(finalTag.ref==='refs/tags/'+publication.tag&&finalTag.object?.type==='commit'&&finalTag.object?.sha===publication.sourceCommit,'TAG_READBACK_MISMATCH');requireValue(validateReleaseReadback(parse(expect(await call('GET',prefix+'/releases/'+releaseId),200)),publication,notes,false)===releaseId,'RELEASE_ID_CHANGED');assert.deepEqual(await list(),before);
  const result={schema:'runtime-local-publication/v1',repository,sourceCommit:publication.sourceCommit,tag:publication.tag,releaseId,reviewDigest:authorization.reviewDigest,files:publication.files,releaseNotes:publication.releaseNotes,status:'PUBLISHED_READBACK_VERIFIED',assetBytesVerifiedBeforePublication:true,postRelease:authorization.postRelease,overallCompletion:'NOT_COMPLETE',installationAuthorized:false,automaticRetry:false,privateEvidenceUploadAllowed:false};save(options.outputRoot,'publication.json',result);return result;
 }catch(error){save(options.outputRoot,'failure.json',{code:typeof error?.code==='string'?error.code:'PUBLICATION_OUTCOME_REQUIRES_INSPECTION',automaticRetry:false,remoteCleanupAttempted:false,evidenceRetained:true});return fail('PUBLICATION_STOPPED_INSPECT_ORIGINAL_EVIDENCE');}
}
export async function main(argv=process.argv.slice(2),env=process.env){
 requireValue(process.versions.node==='24.14.0','FROZEN_NODE_REQUIRED');
 if(argv[0]==='prepare-ci'){requireValue(argv.length===1&&!env.PUBLISH&&!env.DECISION_REF,'PREPARATION_ONLY');const input={repository:env.GITHUB_REPOSITORY,repositoryRoot:sourceRoot,sourceCommit:env.EXPECTED_COMMIT,sourceRunId:env.SOURCE_RUN_ID,artifactDigest:env.EXPECTED_ARTIFACT_DIGEST,outputRoot:path.join(env.RUNNER_TEMP??'','runtime-release-preparation')};const result=await prepareCiDistribution(input);if(env.GITHUB_OUTPUT)fs.appendFileSync(env.GITHUB_OUTPUT,`artifactName=runtime-v090-source-assets-${input.sourceCommit}\n`);return result;}
 if(argv[0]==='preflight'){requireValue(argv.length===3,'USAGE_PREFLIGHT_INPUT_OUTPUT');return preflightRelease(path.resolve(argv[1]),path.resolve(argv[2]));}
 return fail('CLI_CANNOT_PUBLISH_USE_TRUSTED_LOCAL_OPERATOR');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{console.log(JSON.stringify(await main()));}catch(error){console.error(JSON.stringify({code:typeof error?.code==='string'?error.code:'RELEASE_ADAPTER_FAILED',automaticRetry:false,evidenceRetained:true}));process.exitCode=1;}}
