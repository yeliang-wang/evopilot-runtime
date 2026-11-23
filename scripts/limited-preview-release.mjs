#!/usr/bin/env node
// Read-only publication review preparation for the isolated limited distribution.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateGovernance } from '../dist/governance.js';
import { inspectSourceCiRecords } from '../dist/release/source-ci.js';
import { assetNames, repository, sha256, validateDistributionFiles } from './release-gate.mjs';

const root=realpathSync(fileURLToPath(new URL('../',import.meta.url)));
const archiveName='evopilot-runtime-0.9.0-darwin-arm64.tar.gz';
const exact=(value,keys)=>assert.deepEqual(Object.keys(value).sort(),[...keys].sort());
function privateBytes(ref,limit) {
  assert(isAbsolute(ref)&&resolve(ref)===ref&&realpathSync(ref)===ref);
  const file=lstatSync(ref);
  assert(file.isFile()&&file.nlink===1&&file.size>0&&file.size<=limit&&file.uid===process.getuid()&&(file.mode&0o077)===0);
  return readFileSync(ref);
}
function verify(pin,limit) {
  exact(pin,['ref','sha256']);
  const bytes=privateBytes(pin.ref,limit);
  assert.equal(sha256(bytes),pin.sha256);
  return bytes;
}

async function prepare(input) {
  exact(input,['candidate','acceptance','notes']);
  const candidate=JSON.parse(verify(input.candidate,2097152));
  const reportBytes=verify(input.acceptance,2097152);
  const report=JSON.parse(reportBytes);
  const notes=verify(input.notes,262144);
  assert(notes.toString('utf8').includes('limited-preview'));
  assert.equal(report.schema,'runtime-limited-preview-acceptance/v1');
  assert.equal(report.mode,'limited-preview');
  assert.equal(report.phase,'INSTALLED_ISOLATED');
  assert.equal(report.status,'PASSED');
  assert.equal(report.hostRegistered,false);
  assert.equal(report.releaseAuthorized,false);
  assert.equal(report.fullAcceptance,'NOT_EVALUATED');
  assert.equal(report.failure,null);
  assert.match(candidate.sourceCommit,/^[a-f0-9]{40}$/);
  assert.equal(candidate.sourceCommit,report.sourceCommit);
  const git=(...args)=>execFileSync('/usr/bin/git',args,{cwd:root,encoding:'utf8',timeout:15000}).trim();
  assert.equal(git('rev-parse','HEAD'),candidate.sourceCommit);
  assert.equal(git('status','--porcelain'),'');
  assert.equal(evaluateGovernance(root,{mode:'check'}).status,'VALID');
  const targetBytes=readFileSync(join(root,'governance/target-v090.json'));
  const target=JSON.parse(targetBytes);
  const policy=target.limitedPreview;
  assert.equal(policy.tag,'v0.9.0');
  assert.equal(policy.prerelease,true);
  assert.deepEqual(report.cases.map(row=>row.id).sort(),[...policy.preRelease].sort());
  const evidenceRoot=dirname(input.acceptance.ref)+sep;
  const evidence=new Set();
  for(const row of report.cases) {
    assert.equal(row.outcome,'PASS');
    assert(row.artifacts.length>0&&row.artifacts.length<=512);
    for(const {ref,sha256:expected,bytes} of row.artifacts) {
      assert(ref.startsWith(evidenceRoot)&&!evidence.has(ref));
      assert.equal(verify({ref,sha256:expected},128*1024*1024).length,bytes);
      evidence.add(ref);
    }
  }
  exact(candidate.files,assetNames);
  const files=new Map(assetNames.map(name=>[name,verify(candidate.files[name],256*1024*1024)]));
  validateDistributionFiles(files,candidate.sourceCommit);
  assert.equal(sha256(files.get('distribution-manifest.json')),report.manifestDigest);
  assert.equal(sha256(files.get(archiveName)),report.archiveDigest);
  const source=candidate.sourceCi;
  const readJson=pin=>JSON.parse(verify(pin,16*1024*1024));
  const audit=await inspectSourceCiRecords({
    sourceCommit:report.sourceCommit,manifestDigest:report.manifestDigest,archiveDigest:report.archiveDigest,
    artifactDigest:source.artifactZip.sha256,run:readJson(source.run),jobs:readJson(source.jobs),
    artifact:readJson(source.artifact),jobLog:verify(source.jobLog,32*1024*1024).toString('utf8'),
    artifactZip:verify(source.artifactZip,128*1024*1024)
  },AbortSignal.timeout(120000));
  for(const name of assetNames) assert.equal(audit.files[name],candidate.files[name].sha256);
  const review={
    schema:'runtime-limited-preview-publication-review/v1',repository,tag:'v0.9.0',prerelease:true,
    distributionProfile:'limited-preview',sourceCommit:candidate.sourceCommit,
    targetDigest:sha256(targetBytes),sourceCi:audit,
    pinnedAssets:Object.fromEntries([...files].map(([name,bytes])=>[name,{sha256:sha256(bytes),bytes:bytes.length}])),
    acceptance:{reportSha256:sha256(reportBytes),passed:[...policy.preRelease],postRelease:policy.postRelease,fullAcceptance:'NOT_EVALUATED'},
    releaseNotes:{sha256:sha256(notes),bytes:notes.length},
    releaseAuthorized:false
  };
  return {...review,reviewDigest:sha256(JSON.stringify(review))};
}

try {
  assert.equal(process.argv.length,4,'Usage: node scripts/limited-preview-release.mjs PRIVATE_INPUT NEW_PRIVATE_REVIEW');
  const input=JSON.parse(privateBytes(process.argv[2],65536));
  const output=process.argv[3];
  assert(isAbsolute(output)&&resolve(output)===output&&realpathSync(dirname(output))===dirname(output)&&!output.startsWith(root+sep));
  const review=await prepare(input);
  writeFileSync(output,JSON.stringify(review,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(review.reviewDigest);
} catch(error) {
  console.error(error.message);
  process.exitCode=1;
}
