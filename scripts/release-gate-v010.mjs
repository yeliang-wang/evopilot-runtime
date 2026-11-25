import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {closeSync,constants,fstatSync,openSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {verifyDecisionEvidence} from '../vendor/compatibility/v1/decision-evidence.mjs';
import {evaluateV010} from './roadmap-v010.mjs';

export const version = '0.10.0';
export const tag = 'v'+version;
export const repository = 'yeliang-wang/evopilot-runtime';
export const repositoryId = 1416265295;
export const assetNames = Object.freeze([
  'SHA256SUMS','distribution-manifest.json','evopilot-next-runtime-'+version+'.tgz',
  'evopilot-runtime-'+version+'-darwin-arm64.tar.gz','runtime-dependency-lock.json','source-revision.txt',
]);
const root = realpathSync(fileURLToPath(new URL('../',import.meta.url)));
const hash = /^[a-f0-9]{64}$/;
const revision = /^[a-f0-9]{40}$/;
const maxAssetBytes = 256 * 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = bytes => JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));

function keys(value,required) {
  assert(value && typeof value==='object' && !Array.isArray(value),'Expected exact object');
  assert.deepEqual(Object.keys(value).sort(),[...required].sort(),'Unexpected input fields');
}

function readPin(pin,limit = maxAssetBytes) {
  keys(pin,['ref','sha256','bytes']);
  assert(hash.test(pin.sha256) && Number.isSafeInteger(pin.bytes) && pin.bytes>0 && pin.bytes<=limit);
  const ref = pin.ref;
  assert(isAbsolute(ref) && resolve(ref)===ref && realpathSync(ref)===ref && !ref.startsWith(root+sep),'Canonical private evidence path required');
  const fd = openSync(ref,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const initial = fstatSync(fd);
    assert(initial.isFile() && initial.nlink===1 && initial.uid===process.getuid() && (initial.mode&0o077)===0 &&
      initial.size===pin.bytes,'Private immutable evidence required');
    const bytes = readFileSync(fd);
    const final = fstatSync(fd);
    assert.equal(final.mtimeMs,initial.mtimeMs);
    assert.equal(final.ctimeMs,initial.ctimeMs);
    assert.equal(bytes.length,pin.bytes);
    assert.equal(sha(bytes),pin.sha256);
    return bytes;
  } finally { closeSync(fd); }
}

export function verifyV010Files(files,sourceCommit) {
  assert(revision.test(sourceCommit));
  assert.deepEqual([...files.keys()].sort(),[...assetNames].sort());
  const checksum = files.get('SHA256SUMS').toString('utf8');
  assert(checksum.endsWith('\n'));
  const names = new Set();
  for (const line of checksum.slice(0,-1).split('\n')) {
    const entry = /^([a-f0-9]{64})  ([a-zA-Z0-9.-]+)$/.exec(line);
    assert(entry && entry[2]!=='SHA256SUMS' && files.has(entry[2]) && !names.has(entry[2]),'Invalid checksum inventory');
    assert.equal(sha(files.get(entry[2])),entry[1]);
    names.add(entry[2]);
  }
  assert.equal(names.size,5);
  assert.equal(files.get('source-revision.txt').toString('utf8'),sourceCommit+'\n');
  const manifest = json(files.get('distribution-manifest.json'));
  keys(manifest,['schema','version','archiveDigest','files']);
  assert.equal(manifest.schema,'runtime-standalone-distribution/v1');
  assert.equal(manifest.version,version);
  assert.equal(manifest.archiveDigest,sha(files.get('evopilot-runtime-'+version+'-darwin-arm64.tar.gz')));
  assert(Object.keys(manifest.files).length>0 && Object.keys(manifest.files).length<=20000);
  const lock = json(files.get('runtime-dependency-lock.json'));
  assert.equal(lock.name,'@evopilot-next/runtime');
  assert.equal(lock.version,version);
  assert.equal(lock.lockfileVersion,3);
}

export function verifyV010AcceptanceCoverage(report, inventory, boundary) {
  assert.equal(report.liveEntry, boundary.liveEntry);
  assert.deepEqual(report.deferred, boundary.deferred);
  const pre = new Map(inventory.cases.filter(entry=>entry.phase==='pre').map(entry=>[entry.id,entry.verification]));
  assert(Array.isArray(report.cases));
  assert.deepEqual(report.cases.map(row=>row.id).sort(),[...pre.keys()].sort());
  for (const row of report.cases) {
    keys(row,['id','status','evidenceKind','artifacts']);
    assert(row.status==='PASS' && row.evidenceKind===pre.get(row.id) && Array.isArray(row.artifacts) &&
      row.artifacts.length>0 && row.artifacts.length<=64,'Required evidence mode missing for '+row.id);
  }
}

/** Structural review only. Protect pins here and reauthenticate actual Codex
 * Desktop, local verification and source CI in the native owner composition. */
export function prepareV010ReleaseReview(raw) {
  const input = structuredClone(raw);
  keys(input,['sourceCommit','sourceCi','files','acceptance','releaseNotes']);
  assert(revision.test(input.sourceCommit));
  const git = (...args) => execFileSync('/usr/bin/git',['-c','core.fsmonitor=false',...args],{
    cwd:root,encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024,
    env:{PATH:'/usr/bin:/bin',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'},
  }).trim();
  assert.equal(git('rev-parse','HEAD'),input.sourceCommit);
  assert.equal(git('status','--porcelain'),'');
  const pkg = json(readFileSync(join(root,'package.json')));
  assert.equal(pkg.name,'@evopilot-next/runtime');
  assert.equal(pkg.version,version);
  assert.equal(evaluateV010(root,{mode:'check'}).status,'VALID');
  const inventory = json(readFileSync(join(root,'governance/acceptance-v010.json')));
  const boundary = json(readFileSync(join(root,'governance/roadmap-v010.json'))).acceptanceBoundary;
  const pre = inventory.cases.filter(entry=>entry.phase==='pre').map(entry=>entry.id);
  const post = inventory.cases.filter(entry=>entry.phase==='post').map(entry=>entry.id);
  const deferred = inventory.cases.filter(entry=>entry.phase==='deferred').map(entry=>entry.id);
  assert.deepEqual(deferred,['CHANNEL-REAL']);
  keys(input.files,assetNames);
  const files = new Map(assetNames.map(name=>[name,readPin(input.files[name])]));
  verifyV010Files(files,input.sourceCommit);
  const source = input.sourceCi;
  keys(source,['repositoryId','runId','artifactId','artifactSha256','sourceCommit','conclusion']);
  assert(source.repositoryId===repositoryId && Number.isSafeInteger(source.runId) && source.runId>0 &&
    Number.isSafeInteger(source.artifactId) && source.artifactId>0 && hash.test(source.artifactSha256));
  assert.equal(source.sourceCommit,input.sourceCommit);
  assert.equal(source.conclusion,'success');
  const reportBytes = readPin(input.acceptance,2*1024*1024);
  const report = json(reportBytes);
  keys(report,['schema','sourceCommit','manifestSha256','archiveSha256','liveEntry','deferred','cases']);
  assert.equal(report.schema,'runtime-v010-pre-release-evidence/v2');
  assert.equal(report.sourceCommit,input.sourceCommit);
  assert.equal(report.manifestSha256,input.files['distribution-manifest.json'].sha256);
  assert.equal(report.archiveSha256,input.files['evopilot-runtime-'+version+'-darwin-arm64.tar.gz'].sha256);
  verifyV010AcceptanceCoverage(report,inventory,boundary);
  for (const row of report.cases) {
    const refs = new Set();
    for (const pin of row.artifacts) {
      const evidenceDirectory = dirname(input.acceptance.ref);
      assert(pin.ref.startsWith(evidenceDirectory+sep) && !refs.has(pin.ref));
      readPin(pin,32*1024*1024);
      refs.add(pin.ref);
    }
  }
  readPin(input.releaseNotes,256*1024);
  assert.equal(sha(readFileSync(join(root,'docs/images/runtime-v010-workflow-reference.png'))),
    'ee818e3e97b068d1856b33a7c921bac8de22e0d30938c72a985927b428419143');
  const body = {
    schema:'runtime-v010-publication-review/v1',repository,repositoryId,tag,version,prerelease:true,
    sourceCommit:input.sourceCommit,sourceCi:source,
    targetDigest:sha(readFileSync(join(root,'governance/target-v010.json'))),
    files:Object.fromEntries(assetNames.map(name=>[name,{sha256:input.files[name].sha256,bytes:input.files[name].bytes}])),
    acceptance:{reportSha256:input.acceptance.sha256,pre,post,deferred,design:inventory.design,
      liveEntry:boundary.liveEntry,liveE2E:boundary.liveE2E},
    notesSha256:input.releaseNotes.sha256,releaseAuthorized:false,
  };
  return {review:{...body,reviewDigest:'sha256:'+sha(JSON.stringify(body))},report};
}

export async function verifyV010ReleaseDecision(input, decision, authenticate, signal = AbortSignal.timeout(30_000)) {
  assert(typeof authenticate==='function','A registered authenticated release decision source is required');
  const {review,report} = prepareV010ReleaseReview(input);
  const selected = structuredClone(decision);
  keys(selected,['evidence','reviewDigest']);
  assert.equal(selected.reviewDigest,review.reviewDigest);
  readPin(selected.evidence,1024*1024);
  const subject = {
    owner:'runtime',operation:'release.publish',workspaceId:'runtime-v010',scope:{visibility:'private',projectId:'runtime-v010-preview'},
    reviewDigest:review.reviewDigest,decision:'APPROVE',
  };
  verifyDecisionEvidence(pathToFileURL(selected.evidence.ref).href+'#sha256='+selected.evidence.sha256,subject);
  const challenge = randomBytes(32).toString('hex');
  signal.throwIfAborted();
  let onAbort;
  const response = await Promise.race([
    authenticate({review,report,evidence:selected.evidence,subject,challenge},signal),
    new Promise((_,rejectPromise)=>{
      onAbort=()=>rejectPromise(signal.reason);
      signal.addEventListener('abort',onAbort,{once:true});
    }),
  ]).finally(()=>signal.removeEventListener('abort',onAbort));
  signal.throwIfAborted();
  keys(response,['challenge','reviewDigest','verifiedEvidence','approved','validUntil']);
  assert(response.challenge===challenge && response.reviewDigest===review.reviewDigest && response.verifiedEvidence===true &&
    response.approved===true && Number.isSafeInteger(response.validUntil) && response.validUntil>Date.now(),'Current actual release approval and acceptance required');
  assert.equal(prepareV010ReleaseReview(input).review.reviewDigest,review.reviewDigest,'Candidate changed during approval verification');
  return Object.freeze({reviewDigest:review.reviewDigest,sourceCommit:review.sourceCommit,validUntil:response.validUntil});
}
