import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAcceptanceCatalog, evaluateGovernance, governanceDigest } from '../dist/governance.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const catalog = JSON.parse(readFileSync(join(root,'governance/acceptance-v090.json')));
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
    for (const name of ['roadmap.json','target-v090.json','acceptance-v090.json']) writeFileSync(join(dir,'governance',name),readFileSync(join(root,'governance',name)));
    const targetBytes=readFileSync(join(dir,'governance/target-v090.json'));
    const target=JSON.parse(targetBytes);
    const authorization=join(dir,'synthetic-test-authorization.json');
    writeFileSync(authorization,JSON.stringify({schema:'runtime-evolution-authorization/v1',decision:'IMPLEMENT',targetId:target.id,targetDigest:governanceDigest(targetBytes),approvedPlanDigest:target.approvedPlanDigest,implementationMilestones:['M0']}));
    const request={mode:'gate',intent:'runtime-v0.9/M0: verify formal governance',authorization,files:['src/governance.ts']};
    assert.equal(evaluateGovernance(dir,{mode:'check'}).status,'VALID');
    assert.equal(evaluateGovernance(dir,request).status,'ALIGNED');
    assert.equal(evaluateGovernance(dir,{...request,files:['../other-owner/src/index.ts']}).status,'BOUNDARY_CHANGE');
    assert.equal(evaluateGovernance(dir,{...request,intent:'runtime-v0.9/M1: start service'}).status,'BLOCKED');
    assert.equal(evaluateGovernance(dir,{...request,authorization:undefined}).status,'BLOCKED');
    assert.equal(evaluateGovernance(dir,{...request,intent:'any arbitrary new feature'}).status,'UNKNOWN');
    assert.equal(evaluateGovernance(dir,{mode:'release'}).status,'BLOCKED');
    writeFileSync(join(dir,'governance/roadmap.json'),readFileSync(join(dir,'governance/roadmap.json'),'utf8')+' ');
    assert.equal(evaluateGovernance(dir,request).status,'DEVIATION');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
