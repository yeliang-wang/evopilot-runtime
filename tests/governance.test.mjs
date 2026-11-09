import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAcceptanceCatalog, validateTokenUsageAddendum, validateCorrectionAddendum, evaluateGovernance, governanceDigest } from '../dist/governance.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const catalog = JSON.parse(readFileSync(join(root,'governance/acceptance-v090.json')));
test('usage addendum preserves original coverage and cannot hide required stage, Host or post-release cases',()=>{
  const original=JSON.parse(readFileSync(join(root,'governance/token-usage-v090.json')));validateTokenUsageAddendum(original);
  for(const mutate of [a=>a.baseStages.pop(),a=>a.acceptance.cases.pop(),a=>a.acceptance.cases.find(c=>c.id==='UT19').required=false,a=>a.acceptance.cases.find(c=>c.id==='UT24').phase='PRE_RELEASE',a=>a.acceptance.originalRequiredInstances=655,a=>a.acceptance.combinedRequiredInstances=664,a=>a.owner='harness']){
    const changed=structuredClone(original);mutate(changed);assert.throws(()=>validateTokenUsageAddendum(changed));
  }
});
test('catalog preserves the real pre/post-release denominator and bidirectional variants', () => {
  validateAcceptanceCatalog(catalog);
  for (const mutate of [
    c => c.requirements.pop(),
    c => c.scenarios.find(s=>s.id==='E07').groups.push('P04'),
    c => c.scenarios.find(s=>s.id==='E22').phase='PRE_RELEASE',
    c => c.closure[0].cases.pop(),
    c => c.coverage.pop(),
    c => c.scenarios[0].required=false,
    c => c.scenarios[0].steps=[],
    c => c.scenarios[0].requiredExtensionSubcases=['EX99'],
  ]) {
    const changed = structuredClone(catalog); mutate(changed);
    assert.throws(()=>validateAcceptanceCatalog(changed));
  }
});
test('scope gate rejects drift, unbound milestones, unapproved files and release shortcuts', () => {
  const dir = mkdtempSync(join(tmpdir(),'runtime-governance-'));
  try {
    mkdirSync(join(dir,'governance'));
    for (const name of ['roadmap.json','target-v090.json','acceptance-v090.json','lifecycle-contract-v090.json','parameter-matrix-v090.json','environment-contract-v090.json','token-usage-v090.json','lifecycle-correction-v090.json']) writeFileSync(join(dir,'governance',name),readFileSync(join(root,'governance',name)));
    writeFileSync(join(dir,'package-lock.json'),readFileSync(join(root,'package-lock.json')));
    const targetBytes=readFileSync(join(dir,'governance/target-v090.json'));
    const target=JSON.parse(targetBytes);
    const authorization=join(dir,'synthetic-test-authorization.json');
    writeFileSync(authorization,JSON.stringify({schema:'runtime-evolution-authorization/v1',decision:'IMPLEMENT',targetId:target.id,targetDigest:governanceDigest(targetBytes),approvedPlanDigest:target.approvedPlanDigest,addendumDigest:target.approvedAddenda[0].contractDigest,correctionAddendumDigest:target.approvedAddenda.find(a=>a.id==='v090-lifecycle-correction').contractDigest,implementationMilestones:['M0']}));
    const request={mode:'gate',intent:'runtime-v0.9/M0: verify formal governance',authorization,files:['src/governance.ts']};
    assert.equal(evaluateGovernance(dir,{mode:'check'}).status,'VALID');
    assert.equal(evaluateGovernance(dir,request).status,'ALIGNED');
    assert.equal(evaluateGovernance(dir,{...request,files:['../other-owner/src/index.ts']}).status,'BOUNDARY_CHANGE');
    assert.equal(evaluateGovernance(dir,{...request,intent:'runtime-v0.9/M1: start service'}).status,'BLOCKED');
    assert.equal(evaluateGovernance(dir,{...request,authorization:undefined}).status,'BLOCKED');
    assert.equal(evaluateGovernance(dir,{...request,intent:'any arbitrary new feature'}).status,'UNKNOWN');
    const release=evaluateGovernance(dir,{mode:'release'});assert.equal(release.status,'BLOCKED');assert.equal(release.releaseAuthorized,false);assert.match(release.reasons.join(' '),/native review.*scripts\/release-gate\.mjs preflight/);
    assert.equal(evaluateGovernance(dir,{mode:'release',authorization}).releaseAuthorized,false);
    const matrixPath = join(dir,'governance/parameter-matrix-v090.json');
    const matrixBytes = readFileSync(matrixPath);
    const matrix = JSON.parse(matrixBytes); matrix.caseInstances.pop();
    writeFileSync(matrixPath,JSON.stringify(matrix));
    assert.equal(evaluateGovernance(dir,request).status,'DEVIATION');
    writeFileSync(matrixPath,matrixBytes);
    writeFileSync(join(dir,'governance/roadmap.json'),readFileSync(join(dir,'governance/roadmap.json'),'utf8')+' ');
    assert.equal(evaluateGovernance(dir,request).status,'DEVIATION');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

 test('correction coverage remains additive, phase-correct and separate from handoff', () => {
  const original=JSON.parse(readFileSync(join(root,'governance/lifecycle-correction-v090.json')));
  validateCorrectionAddendum(original);
  for(const mutate of [
    a=>a.acceptance.cases.pop(),a=>a.acceptance.cases[0].vectors=[],
    a=>a.acceptance.cases.find(c=>c.id==='LC12').phase='PRE_RELEASE',
    a=>a.acceptance.cases[0].required=false,a=>a.acceptance.combinedRequiredInstances=700,
    a=>a.acceptance.originalRequiredInstances=664,a=>a.handoff.separateFromRuntimeAcceptance=false,
    a=>a.handoff.targetChat='another chat',a=>a.compatibility.rawStageEnumUnchanged=false,
  ]) {const changed=structuredClone(original);mutate(changed);assert.throws(()=>validateCorrectionAddendum(changed));}
 });
