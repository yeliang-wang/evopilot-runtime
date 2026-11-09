// Source-level deterministic regressions; these are not actual LC acceptance.
// LC03–05 fixtures below validate collector refusal and routing only. They are
// synthetic and are never emitted as native acceptance artifacts.
test('LC native selector rejects caller conclusions, dispatch and mismatched provenance',async()=>{
 const {validateLcNativeSelection:check,LC_NATIVE_VECTORS:vectors}=await import('../acceptance/v090/correction.test.mjs');
 const pin={ref:'/synthetic-only/original.json',sha256:'b'.repeat(64)},original={stageRequestId:'original',record:pin},selection={expectedManifestDigest:'a'.repeat(64),sourceCommit:'c'.repeat(40),phase:'PRE_RELEASE',caseIds:['LC03']};
 const value={schema:'runtime-lc-native-selection/v1',candidateDigest:'sha256:'+selection.expectedManifestDigest,sourceCommit:selection.sourceCommit,workspaceId:'workspace',projectId:'project',caseId:'LC03',vectors:Object.fromEntries(vectors.LC03.map(v=>[v,{original,...(v==='same-text-different-baseline'?{second:{...original,stageRequestId:'other'}}:{}),...(v==='unknown'?{}:{correctionRef:'correction:sha256:'+'d'.repeat(64)})}]))};
 assert.deepEqual(check(value,selection),value);
 for(const change of [v=>v.outcome='PASS',v=>v.failureClass='TRANSIENT',v=>v.sourceCommit='e'.repeat(40),v=>v.candidateDigest='sha256:'+'e'.repeat(64),v=>v.vectors.unknown.correctionRef='correction:sha256:'+'d'.repeat(64),v=>v.vectors.unknown.dispatch=true,v=>v.vectors.unknown.original.record.sha256='not-a-hash',v=>delete v.vectors['facts-vs-hypothesis'],v=>v.vectors['two-no-progress']={original}]){const bad=structuredClone(value);change(bad);assert.throws(()=>check(bad,selection));}
});
test('LC UNKNOWN routing inspects the original once and never seeks admission or dispatch',async()=>{
 const {observeLcNativeVector:observe}=await import('../acceptance/v090/correction.test.mjs'),{createHash}=await import('node:crypto');
 const stable=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(stable).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}',hash=v=>'sha256:'+createHash('sha256').update(stable(v)).digest('hex');
 const request={id:'original',digest:'request-digest',instanceId:'instance',stageId:'verification',pinsDigest:'pins',inputDigest:'inputs',planDigest:'plan',plan:{adapterId:'native',adapterDigest:'adapter',bindingDigest:'binding'},authorityRef:'existing',deadlineAt:'2026-11-01T00:00:00Z'},progress={phase:'UNKNOWN',terminal:false,reason:'uncertain',observationRef:'observation',observation:{retained:'synthetic-routing-only'}},stage={request,progress},facts={originalRequestId:request.id,originalRequestDigest:request.digest,instanceId:request.instanceId,stageId:request.stageId,pinsDigest:request.pinsDigest,inputDigest:request.inputDigest,planDigest:request.planDigest,adapterId:request.plan.adapterId,adapterDigest:request.plan.adapterDigest,bindingDigest:request.plan.bindingDigest,authorityRef:request.authorityRef,deadlineAt:request.deadlineAt,phase:progress.phase,terminal:progress.terminal,reason:progress.reason,observationRef:progress.observationRef,observationDigest:hash(progress.observation)},view={facts,proposal:null,executionAuthorized:false,releaseAuthorized:false,automaticRedispatch:false};
 const calls=[];const read=async(op,input)=>{calls.push({op,input});assert.equal(op,'lifecycle.correction.inspect');return view;};const result=await observe('LC03','unknown',{original:{stageRequestId:'original'}},read,async()=>stage);assert.equal(result.assertions.inspectOnly,true);assert.equal(calls.length,1);
 for(const key of ['executionAuthorized','releaseAuthorized','automaticRedispatch']){const bad=structuredClone(view);bad[key]=true;await assert.rejects(observe('LC03','unknown',{original:{}},async()=>bad,async()=>stage));}
});
test('LC native original pins cannot supply alternate requests or rewritten outcomes',async()=>{
 const {assertLcNativeOriginal:check}=await import('../acceptance/v090/correction.test.mjs'),{createHash}=await import('node:crypto');
 const stable=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(stable).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}',hash=v=>'sha256:'+createHash('sha256').update(stable(v)).digest('hex');
 const body={id:'retained',workspaceId:'workspace',projectId:'project',inputDigest:'input'},request={...body,digest:hash(body)},progress={requestId:'retained',phase:'FAILED',terminal:true,observationRef:'raw',observation:{requestId:'retained',inputDigest:'input',outcome:{status:'FAILED'}}},original={request,progress},stage={...original,automaticRedispatch:false},config={workspaceId:'workspace',projectId:'project'};
 assert.deepEqual(check(stage,original,config,'retained'),stage);
 for(const change of [v=>v.request.id='other',v=>v.request.projectId='other',v=>v.request.digest='forged',v=>v.progress.phase='COMPLETE',v=>v.progress.observation.outcome.status='PASS',v=>v.automaticRedispatch=true]){const bad=structuredClone(stage);change(bad);assert.throws(()=>check(bad,original,config,'retained'));}
});
import test from 'node:test';
import assert from 'node:assert/strict';
import { CORRECTION_BINDING_KEYS, preflightCorrection, planCorrectionBranches } from '../../dist/lifecycle/correction-planner.js';
const phase = 'PRE_RELEASE';
const bindings = Object.fromEntries(CORRECTION_BINDING_KEYS.map(key => [key, `observed-${key}`]));
const entries = new Map([['pre', () => { throw Error('must never execute'); }], ['post', () => { throw Error('must never execute'); }]]);
function preflight() { return { phase, expected: { ...bindings }, observed: { ...bindings }, cases: [
  { id: 'pre', phase, dependsOn: [], entry: 'pre' },
  { id: 'post', phase: 'POST_RELEASE', dependsOn: ['pre'], entry: 'post' }
] }; }
function node(id, dependsOn = [], overrides = {}) { return { id, phase, dependsOn, status: 'NOT_RUN', authorized: true, originalRequestId: null, ...overrides }; }
function fixture() { return { phase, nodes: [node('A'), node('B', ['A']), node('C1'), node('C2', ['C1']), node('D')], serialGroups: [['C1', 'C2']], invalidations: [] }; }
function actions(plan) { return Object.fromEntries(plan.decisions.map(d => [d.id, d.action])); }
function rejects(input, code) { assert.throws(() => planCorrectionBranches(input), e => e.code === code); }

test('phase-specific bindings and callable mapping never invoke entries or require POST output', () => {
  const result = preflightCorrection(preflight(), entries);
  assert.equal(result.ready, true);
  assert.deepEqual(result.callableCaseIds, ['pre']);
  assert.equal(result.dispatchAuthorized, false);
  const post = preflight(); post.phase = 'POST_RELEASE';
  assert.deepEqual(preflightCorrection(post, entries).callableCaseIds, ['post']);
});
for (const key of CORRECTION_BINDING_KEYS) test(`preflight rejects observed ${key} mismatch`, () => {
  const input = preflight(); input.observed[key] = 'different';
  const result = preflightCorrection(input, entries);
  assert.equal(result.ready, false);
  assert.deepEqual(result.issues, [{ code: 'BINDING_MISMATCH', id: key }]);
});
test('fixed mapping rejects absent and non-callable entries, missing dependencies, and phase cycles', () => {
  assert.deepEqual(preflightCorrection(preflight(), new Map([['pre', 1]])).issues, [
    { code: 'UNCALLABLE_ENTRY', id: 'pre' }, { code: 'MISSING_ENTRY', id: 'post' }
  ]);
  const missing = preflight(); missing.cases[0].dependsOn = ['unknown'];
  assert.equal(preflightCorrection(missing, entries).issues[0].code, 'MISSING_DEPENDENCY');
  const cyclic = preflight(); cyclic.cases[0].dependsOn = ['post'];
  assert.throws(() => preflightCorrection(cyclic, entries), e => e.code === 'CORRECTION_PHASE_DEPENDENCY');
  const duplicate = preflight(); duplicate.cases.push(duplicate.cases[0]);
  assert.throws(() => preflightCorrection(duplicate, entries), e => e.code === 'CORRECTION_DUPLICATE');
});
test('independent branches continue after A and D failures without rewriting results', () => {
  const input = fixture(); input.nodes[0].status = 'FAIL'; input.nodes[4].status = 'FAIL';
  const before = structuredClone(input), plan = planCorrectionBranches(input);
  assert.deepEqual(actions(plan), { A: 'RETAIN', B: 'BLOCKED', C1: 'READY', C2: 'WAITING', D: 'RETAIN' });
  assert.deepEqual(plan.readyUnits, [['C1', 'C2']]);
  assert.deepEqual(plan.requiredFailures, ['A', 'D']);
  assert.equal(plan.dispatchAuthorized, false);
  assert.deepEqual(input, before);
  assert.deepEqual(plan, planCorrectionBranches(input));
});
test('a next candidate plan needs new raw inputs and does not clear earlier failures', () => {
  const old = fixture(); old.nodes[0].status = 'FAIL';
  const next = fixture();
  assert.deepEqual(planCorrectionBranches(old).requiredFailures, ['A']);
  assert.deepEqual(planCorrectionBranches(next).readyUnits, [['A'], ['C1', 'C2'], ['D']]);
  assert.equal(old.nodes[0].status, 'FAIL');
});
for (const kind of ['CANDIDATE', 'SHARED_ENVIRONMENT', 'AUTHORITY', 'BUDGET']) test(`${kind} invalidation stops affected branches and global invalidation stops all`, () => {
  const input = fixture(); input.invalidations = [{ kind, nodeIds: ['A'] }];
  assert.deepEqual(actions(planCorrectionBranches(input)), { A: 'BLOCKED', B: 'BLOCKED', C1: 'READY', C2: 'WAITING', D: 'READY' });
  input.invalidations[0].nodeIds = null;
  assert.ok(planCorrectionBranches(input).decisions.every(d => d.action === 'BLOCKED'));
});
test('UNKNOWN retains the original request for observation even when budgets expire', () => {
  const input = fixture(); input.nodes[0].status = 'UNKNOWN'; input.nodes[0].originalRequestId = 'accepted-original';
  let plan = planCorrectionBranches(input);
  assert.equal(actions(plan).A, 'OBSERVE_ONLY'); assert.equal(actions(plan).B, 'WAITING'); assert.equal(actions(plan).D, 'READY');
  input.invalidations = [{ kind: 'BUDGET', nodeIds: null }]; plan = planCorrectionBranches(input);
  assert.equal(actions(plan).A, 'OBSERVE_ONLY'); assert.equal(actions(plan).B, 'BLOCKED');
  assert.equal(plan.decisions[0].originalRequestId, 'accepted-original');
  input.nodes[0].originalRequestId = null; rejects(input, 'CORRECTION_REQUEST');
});
test('serial units require all external prerequisites and group authority before admission', () => {
  const input = fixture(); input.nodes[3].dependsOn.push('D');
  assert.equal(actions(planCorrectionBranches(input)).C1, 'WAITING');
  input.nodes[4].status = 'PASS'; assert.equal(actions(planCorrectionBranches(input)).C1, 'READY');
  input.nodes[3].authorized = false;
  assert.equal(actions(planCorrectionBranches(input)).C1, 'BLOCKED');
  input.nodes[3].authorized = true; input.nodes[2].status = 'FAIL';
  assert.equal(actions(planCorrectionBranches(input)).C2, 'BLOCKED');
});
test('serial observation and missing dependencies are conservative', () => {
  const input = fixture(); input.nodes[2].status = 'UNKNOWN'; input.nodes[2].originalRequestId = 'original';
  assert.equal(actions(planCorrectionBranches(input)).C2, 'WAITING');
  input.nodes[0].dependsOn = ['absent'];
  const result = actions(planCorrectionBranches(input));
  assert.equal(result.A, 'BLOCKED'); assert.equal(result.B, 'BLOCKED'); assert.equal(result.D, 'READY');
});
test('PASS is retained but invalid evidence cannot admit descendants', () => {
  const input = fixture(); input.nodes[0].status = 'PASS';
  assert.equal(actions(planCorrectionBranches(input)).B, 'READY');
  input.invalidations = [{ kind: 'CANDIDATE', nodeIds: ['A'] }];
  const plan = planCorrectionBranches(input);
  assert.equal(plan.decisions[0].rawStatus, 'PASS');
  assert.equal(actions(plan).A, 'RETAIN'); assert.equal(actions(plan).B, 'BLOCKED');
});
test('graph bounds, duplicate IDs/edges, cycles and malformed groups reject', () => {
  const mutations = [
    [p => p.nodes.push(node('A')), 'CORRECTION_DUPLICATE'],
    [p => p.nodes[1].dependsOn.push('A'), 'CORRECTION_DUPLICATE'],
    [p => p.nodes[0].dependsOn.push('B'), 'CORRECTION_CYCLE'],
    [p => p.nodes[0].dependsOn.push('A'), 'CORRECTION_CYCLE'],
    [p => p.nodes[0].phase = 'POST_RELEASE', 'CORRECTION_PHASE_DEPENDENCY'],
    [p => p.serialGroups.push(['C1', 'C2']), 'CORRECTION_SERIAL'],
    [p => p.serialGroups = [['C2', 'C1']], 'CORRECTION_SERIAL'],
    [p => p.serialGroups = [['absent', 'C2']], 'CORRECTION_SERIAL'],
    [p => p.nodes = Array.from({ length: 1025 }, (_, i) => node(String(i))), 'CORRECTION_LIMIT'],
    [p => p.invalidations = [{ kind: 'AUTHORITY', nodeIds: ['absent'] }], 'CORRECTION_INVALIDATION'],
    [p => p.nodes[0].status = 'PASS_REUSED', 'CORRECTION_STATUS'],
    [p => p.nodes[0].authorized = 'true', 'CORRECTION_INPUT']
  ];
  for (const [mutate, code] of mutations) { const input = fixture(); mutate(input); rejects(input, code); }
});

// Infrastructure integration with real file observations and explicitly
// registered local callbacks; not installed collector or LC acceptance.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { observeAcceptanceBindings, createAcceptanceCollectorPreflight } from '../acceptance/v090/preflight.mjs';
function collectorFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'correction-preflight-')));
  const profile = Object.fromEntries(['source', 'candidate', 'toolchain', 'fixture', 'collector', 'permission'].map(key => {
    const filename = path.join(root, key); fs.writeFileSync(filename, `actual-${key}`, { mode: 0o600 }); return [key, [filename]];
  }));
  const observed = observeAcceptanceBindings(profile), calls = [];
  const cases = [{ id: 'fixed-pre', entry: 'pre', phase: 'PRE_RELEASE', dependsOn: [] }, { id: 'fixed-post', entry: 'post', phase: 'POST_RELEASE', dependsOn: ['fixed-pre'] }];
  const entries = new Map([['pre', () => { calls.push('pre'); return { actualLocalCallback: true }; }], ['post', () => { calls.push('post'); return { actualLocalCallback: true }; }]]);
  const options = { cases, entries, expectedByPhase: { PRE_RELEASE: observed }, observationsByPhase: { PRE_RELEASE: profile }, preflightCorrection };
  return { root, profile, observed, calls, options, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
test('binding observers load without a source dist or implicit preflight implementation', async () => {
  const f = collectorFixture();
  try {
    const { pathToFileURL } = await import('node:url');
    const copied = path.join(f.root, 'standalone-observer.mjs');
    fs.copyFileSync(new URL('../acceptance/v090/preflight.mjs', import.meta.url), copied);
    // Relative product imports cannot resolve here: only this single module and
    // six observed files exist in the private temporary directory.
    const isolated = await import(pathToFileURL(copied).href);
    assert.deepEqual(isolated.observeAcceptanceBindings(f.profile), f.observed);
    const { preflightCorrection: omitted, ...missing } = f.options;
    assert.throws(() => isolated.createAcceptanceCollectorPreflight(missing), /explicitly verified/);
    assert.deepEqual(f.calls, []);
  } finally { f.cleanup(); }
});
test('registered collector preflight invokes real PRE callback without observing POST artifacts', async () => {
  const f = collectorFixture();
  try {
    // No POST profile exists; a real POST callable still must be registered.
    const collector = createAcceptanceCollectorPreflight(f.options);
    const result = await collector.collect('PRE_RELEASE', 'fixed-pre');
    assert.deepEqual(f.calls, ['pre']); assert.equal(result.result.actualLocalCallback, true);
    assert.equal(result.assessment.dispatchAuthorized, false); assert.equal(result.assessment.productAcceptance, 'NOT_EVALUATED');
    await assert.rejects(collector.collect('PRE_RELEASE', 'fixed-pre'), { code: 'COLLECTOR_ALREADY_ATTEMPTED' });
    await assert.rejects(collector.collect('PRE_RELEASE', 'fixed-post'), { code: 'COLLECTOR_CASE_PHASE' });
  } finally { f.cleanup(); }
});
test('missing or non-callable POST mapping blocks all selected PRE effects', async () => {
  for (const mode of ['missing', 'uncallable']) {
    const f = collectorFixture();
    try {
      if (mode === 'missing') f.options.entries.delete('post'); else f.options.entries.set('post', 'not executable');
      const collector = createAcceptanceCollectorPreflight(f.options);
      await assert.rejects(collector.collect('PRE_RELEASE', 'fixed-pre'), { code: mode === 'missing' ? 'MISSING_ENTRY' : 'UNCALLABLE_ENTRY' });
      assert.deepEqual(f.calls, []);
    } finally { f.cleanup(); }
  }
});
test('each observed file binding and actual platform mismatch stops before callback', async () => {
  for (const key of ['source', 'candidate', 'toolchain', 'fixture', 'collector', 'permission', 'platform']) {
    const f = collectorFixture();
    try {
      if (key === 'platform') f.options.expectedByPhase.PRE_RELEASE.platform = 'sha256:' + '0'.repeat(64);
      const collector = createAcceptanceCollectorPreflight(f.options);
      if (key !== 'platform') fs.appendFileSync(f.profile[key][0], '-changed');
      await assert.rejects(collector.collect('PRE_RELEASE', 'fixed-pre'), error => error.code === 'COLLECTOR_PREFLIGHT_REJECTED' && error.issues.some(i => i.id === key));
      assert.deepEqual(f.calls, []);
    } finally { f.cleanup(); }
  }
});
test('preflight is reobserved after drift and registry replacement cannot substitute callbacks', async () => {
  const f = collectorFixture();
  try {
    const collector = createAcceptanceCollectorPreflight(f.options); collector.preflight('PRE_RELEASE');
    f.options.entries.set('pre', () => assert.fail('caller registry mutation must not replace callback'));
    fs.appendFileSync(f.profile.fixture[0], '-drift');
    await assert.rejects(collector.collect('PRE_RELEASE', 'fixed-pre'), { code: 'COLLECTOR_PREFLIGHT_REJECTED' });
    assert.deepEqual(f.calls, []);
  } finally { f.cleanup(); }
});
test('collector failures retain the attempted state and cannot become a rewritten PASS', async () => {
  const f = collectorFixture();
  try {
    f.options.entries.set('pre', () => { f.calls.push('failure'); throw Error('actual-local-failure'); });
    const collector = createAcceptanceCollectorPreflight(f.options);
    await assert.rejects(collector.collect('PRE_RELEASE', 'fixed-pre'), /actual-local-failure/);
    await assert.rejects(collector.collect('PRE_RELEASE', 'fixed-pre'), { code: 'COLLECTOR_ALREADY_ATTEMPTED' });
    assert.deepEqual(f.calls, ['failure']);
  } finally { f.cleanup(); }
});

import { preflightCallableRegistry } from '../acceptance/v090/preflight.mjs';
test('partial callable registry reports full gaps without pretending complete binding readiness', () => {
  const catalog = [
    { caseInstanceId: 'supported', phase: 'PRE_RELEASE' },
    { caseInstanceId: 'missing', phase: 'PRE_RELEASE' },
    { caseInstanceId: 'post', phase: 'POST_RELEASE' }
  ];
  const entries = new Map([['supported', () => 1], ['post', () => 2]]);
  const report = preflightCallableRegistry({ catalog, entries, selectedCaseIds: ['supported'], phase: 'PRE_RELEASE' });
  assert.equal(report.selectedCallable, true); assert.equal(report.fullCatalogCallable, false); assert.equal(report.bindingsVerified, false);
  assert.deepEqual(report.gaps.map(g => g.caseInstanceId), ['missing']);
  assert.throws(() => preflightCallableRegistry({ catalog, entries, selectedCaseIds: ['missing'], phase: 'PRE_RELEASE' }), error => error.code === 'COLLECTOR_MAPPING_INCOMPLETE' && error.preflight.gaps.length === 1);
  assert.throws(() => preflightCallableRegistry({ catalog, entries, selectedCaseIds: ['post'], phase: 'PRE_RELEASE' }), { code: 'COLLECTOR_MAPPING_INCOMPLETE' });
});
test('actual support entry rejects selected missing E03 callback before installation access or setup effects', async () => {
  const { openScenario, repository } = await import('../acceptance/v090/support.mjs');
  const f = collectorFixture(), previous = process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION;
  try {
    const selection = { schema: 'runtime-v090-acceptance-selection/v1', installedRoot: path.join(f.root, 'absent-installation'), expectedManifestDigest: 'a'.repeat(64), connectionRef: path.join(f.root, 'absent-connection'), workspaceId: 'test', projectId: 'test', runId: 'registry-test', outputRoot: path.join(f.root, 'must-not-exist'), qualification: 'DEVELOPMENT', caseIds: ['E03.journey'] };
    const filename = path.join(f.root, 'selection.json'); fs.writeFileSync(filename, JSON.stringify(selection), { mode: 0o600 });
    process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION = filename;
    let registered = 0;
    await assert.rejects(openScenario('E03', { phase: 'PRE_RELEASE', register(catalog) {
      registered = catalog.length;
      // No placeholder for the unsupported journey. These closures are never invoked.
      return new Map(catalog.filter(c => ['REAL_SERVICE_PARAMETER', 'ENTRY_ADMISSION'].includes(c.kind) || c.caseInstanceId === 'E03.EX12').map(c => [c.caseInstanceId, () => assert.fail('setup cannot run')]));
    } }), error => error.code === 'COLLECTOR_MAPPING_INCOMPLETE' && error.preflight.gaps.some(g => g.caseInstanceId === 'E03.journey'));
    const matrix = JSON.parse(fs.readFileSync(path.join(repository, 'governance/parameter-matrix-v090.json')));
    assert.equal(registered, matrix.caseInstances.filter(c => c.scenario === 'E03').length);
    assert.equal(fs.existsSync(selection.outputRoot), false); assert.equal(fs.existsSync(selection.installedRoot), false);
  } finally {
    if (previous === undefined) delete process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION; else process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION = previous;
    f.cleanup();
  }
});

test('EX02 selection gates stop before installation access; valid file pins alone do not establish readiness', async t => {
  const { openScenario, sha } = await import('../acceptance/v090/support.mjs');
  const f = collectorFixture(), previous = process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION;
  const selectionRef = path.join(f.root, 'ex02-selection.json');
  function selected() {
    const fieldClassification = Object.fromEntries(['github', 'gitlab'].map(provider => {
      const yamlRef = path.join(f.root, provider + '.yaml');
      // Intentionally not a legal lifecycle. This test ends before YAML/service
      // validation and cannot claim that provider/owner bindings are ready.
      fs.writeFileSync(yamlRef, `provider: ${provider}\n`, { mode: 0o600 }); fs.chmodSync(yamlRef, 0o600);
      return [provider, { yamlRef, yamlSha256: sha(fs.readFileSync(yamlRef)) }];
    }));
    return { schema: 'runtime-v090-acceptance-selection/v1', installedRoot: path.join(f.root, 'absent-installation'), expectedManifestDigest: 'a'.repeat(64), connectionRef: path.join(f.root, 'absent-connection'), workspaceId: 'test', projectId: 'test', runId: 'ex02-boundary-test', outputRoot: path.join(f.root, 'must-not-exist'), qualification: 'DEVELOPMENT', caseIds: ['E03.EX02'], fieldClassification };
  }
  const checks = [
    { name: 'EX02 requires both selected inputs', change: s => { delete s.fieldClassification; }, error: /E03.EX02 requires selected fieldClassification inputs/ },
    { name: 'provider keys are exact', change: s => { s.fieldClassification.gitLab = s.fieldClassification.gitlab; delete s.fieldClassification.gitlab; }, error: { code: 'ERR_ASSERTION' } },
    { name: 'null provider cannot stand in for a pin', change: s => { s.fieldClassification.github = null; }, error: { code: 'ERR_ASSERTION' } },
    { name: 'original byte drift invalidates the digest', change: s => fs.appendFileSync(s.fieldClassification.github.yamlRef, 'changed'), error: /Selected provider YAML digest mismatch/ },
    { name: 'public input permissions are unsafe', change: s => fs.chmodSync(s.fieldClassification.github.yamlRef, 0o644), error: { code: 'UNSAFE_FILE' } },
    { name: 'another scenario cannot supply EX02 inputs', scenario: 'E04', change: s => { s.caseIds = ['E04.EX02']; }, error: /fieldClassification is scoped to E03.EX02/ },
    { name: 'another E03 case cannot supply EX02 inputs', change: s => { s.caseIds = ['E03.EX12']; }, error: /fieldClassification requires E03.EX02 selected/ }
  ];
  try {
    process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION = selectionRef;
    for (const check of checks) await t.test(check.name, async () => {
      const selection = selected(); check.change(selection);
      fs.writeFileSync(selectionRef, JSON.stringify(selection), { mode: 0o600 });
      await assert.rejects(openScenario(check.scenario ?? 'E03'), check.error);
      assert.equal(fs.existsSync(selection.outputRoot), false);
      assert.equal(fs.existsSync(selection.installedRoot), false);
    });
    await t.test('protected exact pins reach only the original installation read boundary', async () => {
      const selection = selected(); fs.writeFileSync(selectionRef, JSON.stringify(selection), { mode: 0o600 });
      await assert.rejects(openScenario('E03'), error => error.code === 'ENOENT' && typeof error.path === 'string' && (error.path === selection.installedRoot || error.path.startsWith(selection.installedRoot + path.sep)));
      assert.equal(fs.existsSync(selection.outputRoot), false);
      assert.equal(fs.existsSync(selection.installedRoot), false);
    });
  } finally {
    if (previous === undefined) delete process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION; else process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION = previous;
    f.cleanup();
  }
});

test('EX01 requires the exact protected second-project selection before installation reads', async t => {
  const { openScenario, sha } = await import('../acceptance/v090/support.mjs');
  const f = collectorFixture(), previous = process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION;
  const selectionRef = path.join(f.root, 'ex01-selection.json'), connectionRef = path.join(f.root, 'beta-connection.json');
  function selected() {
    // Only a file-pin probe: the absent installation stops this test before
    // connection parsing, authentication, project readiness or any public call.
    fs.writeFileSync(connectionRef, '{"sourceTestOnly":true}', { mode: 0o600 }); fs.chmodSync(connectionRef, 0o600);
    return { schema: 'runtime-v090-acceptance-selection/v1', installedRoot: path.join(f.root, 'absent-installation'), expectedManifestDigest: 'a'.repeat(64), connectionRef: path.join(f.root, 'absent-default'), workspaceId: 'test', projectId: 'alpha', runId: 'ex01-boundary-test', outputRoot: path.join(f.root, 'must-not-exist'), qualification: 'DEVELOPMENT', caseIds: ['E03.EX01'], principals: { beta: { connectionRef, connectionSha256: sha(fs.readFileSync(connectionRef)), principalId: 'beta-reader', projectId: 'beta', expectedPermissions: ['read', 'draft.write', 'definition.activate'] } } };
  }
  const checks = [
    ['missing beta selection', s => { delete s.principals; }, /E03.EX01 requires a protected beta connection/],
    ['unknown principal alias', s => { s.principals.gamma = s.principals.beta; delete s.principals.beta; }, { code: 'ERR_ASSERTION' }],
    ['same project is not isolation', s => { s.principals.beta.projectId = s.projectId; }, /EX01 requires a distinct second project/],
    ['missing activation capability', s => { s.principals.beta.expectedPermissions = ['read']; }, /EX01 beta needs current configuration permissions/],
    ['changed connection bytes', () => fs.appendFileSync(connectionRef, 'changed'), /EX01 beta connection digest mismatch/],
    ['public connection bytes', () => fs.chmodSync(connectionRef, 0o644), { code: 'UNSAFE_FILE' }],
    ['unselected EX01 rejects named principals', s => { s.caseIds = ['E03.EX12']; }, /E03 named principals require EX01 selected/]
  ];
  try {
    process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION = selectionRef;
    for (const [name, change, error] of checks) await t.test(name, async () => {
      const selection = selected(); change(selection); fs.writeFileSync(selectionRef, JSON.stringify(selection), { mode: 0o600 });
      await assert.rejects(openScenario('E03'), error); assert.equal(fs.existsSync(selection.outputRoot), false);
    });
    await t.test('valid protected pin reaches only existing installation inspection', async () => {
      const selection = selected(); fs.writeFileSync(selectionRef, JSON.stringify(selection), { mode: 0o600 });
      await assert.rejects(openScenario('E03'), error => error.code === 'ENOENT' && typeof error.path === 'string' && (error.path === selection.installedRoot || error.path.startsWith(selection.installedRoot + path.sep)));
      assert.equal(fs.existsSync(selection.outputRoot), false);
    });
  } finally {
    if (previous === undefined) delete process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION; else process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION = previous;
    f.cleanup();
  }
});

test('actual EX11 collectors reject missing actual fixtures before installation access or browser launch', { timeout: 60000 }, async t => {
 for(const scenario of ['E04','E05'])await t.test(scenario,async()=>{
  const { execFile } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const f = collectorFixture();
  try {
    const selection = { schema: 'runtime-v090-acceptance-selection/v1', installedRoot: path.join(f.root, 'absent-installation'), expectedManifestDigest: 'a'.repeat(64), connectionRef: path.join(f.root, 'absent-connection'), workspaceId: 'test', projectId: 'test', runId: 'e04-registry-test', outputRoot: path.join(f.root, 'must-not-exist'), qualification: 'DEVELOPMENT', caseIds: [scenario+'.EX11'] };
    const filename = path.join(f.root, 'e04-selection.json'); fs.writeFileSync(filename, JSON.stringify(selection), { mode: 0o600 });
    // Carry only the active source loader into this bounded child; no global
    // NODE_OPTIONS change and no compiled dist mutation is needed.
    const loaderArgs = [];
    for (let i = 0; i < process.execArgv.length; i++) {
      const arg = process.execArgv[i];
      if (arg === '--experimental-loader' || arg === '--loader') loaderArgs.push(arg, process.execArgv[++i]);
      else if (arg.startsWith('--experimental-loader=') || arg.startsWith('--loader=')) loaderArgs.push(arg);
    }
    const childEnv = { ...process.env, EVOPILOT_V090_ACCEPTANCE_SELECTION: filename };
    delete childEnv.NODE_TEST_CONTEXT; // This is a fresh test runner, not its parent's worker.
    const result = await new Promise(resolve => execFile(process.execPath, [...loaderArgs, '--test', '--test-concurrency=1', fileURLToPath(new URL('../acceptance/v090/'+scenario.toLowerCase()+'.test.mjs', import.meta.url))], { env: childEnv, timeout: 30000, maxBuffer: 1048576, encoding: 'utf8' }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
    assert.equal(result.error?.code, 1); assert.equal(result.error.killed, false);
    assert((result.stdout + result.stderr).includes(scenario+'.EX11 requires protected actual owner obligations fixture'));
    assert.doesNotMatch(result.stdout + result.stderr, /ENOENT/);
    assert.equal(fs.existsSync(selection.outputRoot), false); assert.equal(fs.existsSync(selection.installedRoot), false);
  } finally { f.cleanup(); }
 });
});

test('EX11 actual owner selection rejects incomplete or unsafe protected fixtures before installation reads',async t=>{
 const {openScenario,sha}=await import('../acceptance/v090/support.mjs');
 for(const scenario of ['E04','E05'])for(const variant of ['missing-case-plan','wrong-case-plan','unexpected-plan-field','unsafe-fixture','valid-protected'])await t.test(scenario+':'+variant,async()=>{
  const f=collectorFixture(),prior=process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION;
  try{
   const selection={schema:'runtime-v090-acceptance-selection/v1',installedRoot:path.join(f.root,'absent-installation'),expectedManifestDigest:'a'.repeat(64),connectionRef:path.join(f.root,'absent-connection'),workspaceId:'test',projectId:'test',runId:'ex11-input-test',outputRoot:path.join(f.root,'must-not-exist'),qualification:'DEVELOPMENT',caseIds:[scenario+'.EX11']};
   const fixture={schema:'runtime-v090-extension-execution-fixture/v1',candidateDigest:'sha256:'+selection.expectedManifestDigest,workspaceId:'test',projectId:'test',syntheticAssets:true,syntheticDecisions:true,exchangeRoot:f.root,casePlans:variant==='unexpected-plan-field'?{[scenario+'.EX11']:{status:'PASS'}}:variant==='wrong-case-plan'?{[scenario==='E04'?'E05.EX11':'E04.EX11']:{status:'PASS'}}:{}};
   if(variant==='valid-protected'){
    const pinned=(name,value)=>{const ref=path.join(f.root,name),bytes=Buffer.from(value);fs.writeFileSync(ref,bytes,{mode:0o600});return{ref,sha256:sha(bytes)};};
    // A schema-only fixture reaches the absent installation. These source bytes
    // cannot establish owner execution, business approval or acceptance credit.
    fixture.casePlans[scenario+'.EX11']={baseline:pinned('baseline.yaml','schema-only baseline\n'),extended:pinned('extended.yaml','schema-only extension\n'),ownerConnection:pinned('owner.json','{}\n'),passed:{instanceId:'pass-instance',targetRef:'target:pass',definitionRevisionId:'revision:exact'},failed:{instanceId:'fail-instance',targetRef:'target:fail',definitionRevisionId:'revision:exact'},stageId:'project.owner-check',successorId:'implementation'};
   }
   const pinRef=path.join(f.root,'fixture.json'),bytes=Buffer.from(JSON.stringify(fixture));fs.writeFileSync(pinRef,bytes,{mode:variant==='unsafe-fixture'?0o644:0o600});selection.extensionExecution={ref:pinRef,sha256:sha(bytes)};const ref=path.join(f.root,'selection.json');fs.writeFileSync(ref,JSON.stringify(selection),{mode:0o600});process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION=ref;
   await assert.rejects(openScenario(scenario,{phase:'PRE_RELEASE',register:catalog=>new Map(catalog.map(c=>[c.caseInstanceId,()=>{throw Error('must not execute');}]))}),error=>{if(variant==='valid-protected')assert.equal(error.code,'ENOENT');else assert(!String(error).includes('ENOENT'));return true;});assert.equal(fs.existsSync(selection.outputRoot),false);
  }finally{if(prior===undefined)delete process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION;else process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION=prior;f.cleanup();}
 });
});


test('E05 live parent campaign defers native EX11 fixture validation to its exact child',async()=>{
 const {openScenario,sha}=await import('../acceptance/v090/support.mjs'),f=collectorFixture(),prior=process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION;
 try{
  const ref=path.join(f.root,'campaign.json'),bytes=Buffer.from('{}\n');fs.writeFileSync(ref,bytes,{mode:0o600});
  const selection={schema:'runtime-v090-acceptance-selection/v1',installedRoot:path.join(f.root,'absent-installation'),expectedManifestDigest:'a'.repeat(64),connectionRef:path.join(f.root,'absent-connection'),workspaceId:'test',projectId:'test',runId:'ex11-live-parent',outputRoot:path.join(f.root,'must-not-exist'),qualification:'DEVELOPMENT',caseIds:['E05.EX11'],caseCampaign:{ref,sha256:sha(bytes)}};
  const filename=path.join(f.root,'selection.json');fs.writeFileSync(filename,JSON.stringify(selection),{mode:0o600});process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION=filename;
  await assert.rejects(openScenario('E05'),error=>error.code==='ENOENT'&&(error.path===selection.installedRoot||error.path.startsWith(selection.installedRoot+path.sep)));
  assert.equal(fs.existsSync(selection.outputRoot),false);
 }finally{if(prior===undefined)delete process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION;else process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION=prior;f.cleanup();}
});

// Guard regressions only: these synthetic inputs never establish native journeys.
test('E05 journey preserves original Host stdout and rejects unrecognized output',async()=>{
 const {parseOriginalCodingHostStdout:parse}=await import('../acceptance/v090/execution.mjs');
 const line='{"phase":"propose"}\n',notice='(node:1234) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use `node --trace-warnings ...` to show where the warning was created)\n';
 assert.deepEqual(parse(line,'propose').value,{phase:'propose'});
 for(const stdout of [notice+line,line+notice]){const proof=parse(stdout,'propose');assert.equal(proof.interpretation.originalToolOutputRetained,true);assert.equal(proof.interpretation.rawStdoutBytes,Buffer.byteLength(stdout));assert.equal(proof.interpretation.unknownOutputIgnored,false);assert.equal(proof.interpretation.notice.pid,1234);}
 for(const [stdout,phase]of [[notice+line,'submit'],[notice+notice+line,'propose'],['unrecognized log\n'+line,'propose'],[line+'{}\n','propose'],['{"ph'+notice+'ase":"propose"}\n','propose']])assert.throws(()=>parse(stdout,phase));
});
test('E05 journey binds selected Host identity to actual original session metadata',async()=>{
 const {assertOriginalCodingHostIdentity:check}=await import('../acceptance/v090/execution.mjs'),{sha}=await import('../acceptance/v090/support.mjs');
 const header=Buffer.from(JSON.stringify({type:'session_meta',payload:{id:'session-a',session_id:'session-a',originator:'Codex Desktop',source:'vscode',cli_version:'pinned',model_provider:'original-provider'}})+'\n'),selected={selection:{sessionId:'session-a'},metadata:{sessionId:'session-a',hostVersion:'pinned',originator:'Codex Desktop',source:'vscode',provider:'original-provider'},startOffset:header.length,metaBytes:header.length,metaSha256:sha(header)};
 check(selected,header);
 for(const change of [s=>s.metadata.provider='other-provider',s=>s.metadata.hostVersion='other-version',s=>s.selection.sessionId='other-session',s=>s.startOffset=-1,s=>s.metaSha256='0'.repeat(64)]){const forged=structuredClone(selected);change(forged);assert.throws(()=>check(forged,header));}
});
test('E05 journey ignores only monotonic current project revision in historical readback',async()=>{
 const {assertHistoricalInspection:check}=await import('../acceptance/v090/execution.mjs'),original={projectRevision:3,request:{id:'original',inputDigest:'retained'},progress:{phase:'COMPLETE',observation:{checks:[{id:'required',status:'PASS'}]}},workerError:null,automaticRedispatch:false};
 check(original,{...structuredClone(original),projectRevision:4});
 for(const change of [v=>v.projectRevision=2,v=>delete v.projectRevision,v=>v.request.id='replacement',v=>v.progress.observation.checks=[],v=>v.workerError='hidden',v=>v.automaticRedispatch=true,v=>v.extraHistoricalField='invented']){const current=structuredClone(original);change(current);assert.throws(()=>check(original,current));}
});
test('E05 journey candidate comparison requires real identity changes and all old checks',async()=>{
 const {candidateEvolution}=await import('../acceptance/v090/execution.mjs');
 const before={id:'before',candidateDigest:'old',candidate:{sourceDigest:'source-a',buildDigest:'build-a',artifacts:[{name:'archive',digest:'a',bytes:1}]},definition:{nodes:[{id:'verification',checks:['required']}]},stages:{candidate:{requestId:'candidate-a'},verification:{requestId:'verification-a',inputDigest:'input-a'}}};
 const after={...structuredClone(before),id:'after',candidateDigest:'new',stages:{candidate:{requestId:'candidate-b'},verification:{requestId:'verification-b',inputDigest:'input-b'}}};after.candidate.sourceDigest='source-b';
 assert.equal(candidateEvolution(before,after).changed.source,true);
 for(const change of [v=>v.candidate=structuredClone(before.candidate),v=>v.definition.nodes[0].checks=[],v=>v.stages.verification.requestId='verification-a',v=>v.stages.verification.inputDigest='input-a',v=>v.candidateDigest='old']){const invalid=structuredClone(after);change(invalid);assert.throws(()=>candidateEvolution(before,invalid));}
});
test('E05 journey selects its exact protected before/after fixture and provider',async()=>{
 const {lifecycleReadbackPlan}=await import('../acceptance/v090/execution.mjs'),{sha}=await import('../acceptance/v090/support.mjs'),f=collectorFixture();
 try{
  const pin=(name,value)=>{const ref=path.join(f.root,name),bytes=Buffer.from(JSON.stringify(value));fs.writeFileSync(ref,bytes,{mode:0o600});return{ref,sha256:sha(bytes)};},a=path.join(f.root,'before'),b=path.join(f.root,'after');fs.mkdirSync(a,{mode:0o700});fs.mkdirSync(b,{mode:0o700});
  const record=(id,exchangeRoot)=>({instanceId:id,expectedVersion:'0.9.0-preview.1',preparation:pin(id+'-preparation.json',{}),ownerFixture:pin(id+'-owner.json',{}),codingSourceSelection:{kind:'ORIGINAL_RECORD',...pin(id+'-host.json',{})},exchangeRoot}),fixture={schema:'runtime-v090-lifecycle-variants-fixture/v1',candidateDigest:'sha256:'+'a'.repeat(64),workspaceId:'test',projectId:'test',provider:'github',syntheticAssets:true,syntheticDecisions:true,casePlans:{'E05.journey':{before:record('before',a),after:record('after',b)}}};
  let index=0;const run=value=>({candidateDigest:fixture.candidateDigest,selection:{workspaceId:'test',projectId:'test',lifecycleVariants:pin('fixture-'+(++index)+'.json',value)},all:[{caseInstanceId:'E05.journey'}],artifact(){}}),c={caseInstanceId:'E05.journey'};
  assert.deepEqual(lifecycleReadbackPlan(run(fixture),c,'github'),fixture.casePlans['E05.journey']);
  for(const change of [v=>v.provider='gitlab',v=>v.casePlans['E05.journey'].after.instanceId='before',v=>v.casePlans['E05.journey'].after.exchangeRoot=a,v=>v.casePlans={'E01.variant.02':v.casePlans['E05.journey']},v=>v.casePlans['E05.journey'].after.claimedPass=true]){const invalid=structuredClone(fixture);change(invalid);assert.throws(()=>lifecycleReadbackPlan(run(invalid),c,'github'));}
 }finally{f.cleanup();}
});
test('E05 journey requires original lifecycle evidence before installation reads',async()=>{
 const {openScenario,sha}=await import('../acceptance/v090/support.mjs'),f=collectorFixture(),prior=process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION;
 try{
  const selection={schema:'runtime-v090-acceptance-selection/v1',installedRoot:path.join(f.root,'absent-installation'),expectedManifestDigest:'a'.repeat(64),connectionRef:path.join(f.root,'absent-connection'),workspaceId:'test',projectId:'test',runId:'e05-journey-source-guard',outputRoot:path.join(f.root,'must-not-exist'),qualification:'DEVELOPMENT',caseIds:['E05.journey']},filename=path.join(f.root,'selection.json');
  fs.writeFileSync(filename,JSON.stringify(selection),{mode:0o600});process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION=filename;
  await assert.rejects(openScenario('E05'),/E05\.journey requires exact original before\/after lifecycle records/);
  const ref=path.join(f.root,'original-records.json'),bytes=Buffer.from('{}\n');fs.writeFileSync(ref,bytes,{mode:0o600});selection.lifecycleVariants={ref,sha256:sha(bytes)};selection.caseIds=['E05.variant.01'];fs.writeFileSync(filename,JSON.stringify(selection),{mode:0o600});
  await assert.rejects(openScenario('E05'),/E05 lifecycle readback belongs only to its fixed journey/);assert.equal(fs.existsSync(selection.outputRoot),false);
 }finally{if(prior===undefined)delete process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION;else process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION=prior;f.cleanup();}
});

test('E05 RC missing-artifact case requires an actual candidate request after passed prerequisites',async()=>{
 const {requireMissingRcLifecycle:check}=await import('../acceptance/v090/execution.mjs'),h='sha256:'+'a'.repeat(64),stages={};
 for(const id of ['scope','plan','implementation','candidate','verification','release-decision','publication','closure'])stages[id]=['scope','plan','implementation','candidate'].includes(id)?{status:id==='candidate'?'UNKNOWN':'PASSED',attempts:1,requestId:'original-'+id,inputDigest:h,outcomeDigest:h}:{status:'PENDING',attempts:0,requestId:null};
 const instance={id:'rc-missing',stages,candidate:null,candidateDigest:null},plan={instanceId:instance.id,expectedVersion:'0.9.0-rc.1'};assert.deepEqual(check(instance,plan),['scope','plan','implementation','candidate']);
 for(const change of [v=>v.stages.implementation.status='PENDING',v=>v.stages.candidate.status='PENDING',v=>v.stages.candidate.requestId=null,v=>v.stages.candidate.attempts=0,v=>v.stages.candidate.outcomeDigest=null,v=>v.stages.verification.attempts=1,v=>v.candidate={version:plan.expectedVersion},v=>v.candidateDigest=h]){const invalid=structuredClone(instance);change(invalid);assert.throws(()=>check(invalid,plan));}
 assert.throws(()=>check(instance,{...plan,expectedVersion:'0.9.0-preview.1'}));
});
test('E05 RC archive guard distinguishes missing candidate payload from unrelated or forged failures',async()=>{
 const {assertMissingRcPayload:check}=await import('../acceptance/v090/execution.mjs'),{sha}=await import('../acceptance/v090/support.mjs'),{candidateDigest}=await import('../../dist/lifecycle/instance.js'),artifactApi=await import('../../dist/adapters/artifacts.js');
 const request={requestId:'stage-original',inputDigest:'sha256:'+'a'.repeat(64),bindingDigest:'sha256:'+'b'.repeat(64),commit:'c'.repeat(40),workflowDigest:'sha256:'+'d'.repeat(64),stageId:'candidate',candidateDigest:null},archive={provider:'github',repositoryId:'123',runId:'456'},payload=Buffer.from('built payload'),evidence=Buffer.from('required-check evidence'),version='0.9.0-rc.1';
 const result={schema:'runtime-ci/v1',requestId:request.requestId,inputDigest:request.inputDigest,provider:archive.provider,repositoryId:archive.repositoryId,runId:archive.runId,sourceCommit:request.commit,workflowDigest:request.workflowDigest,stageId:'candidate',candidateDigest:null,checks:[{id:'required',status:'PASS',evidence:[{path:'evidence/check.txt',digest:'sha256:'+sha(evidence),bytes:evidence.length}]}],candidate:{schema:'runtime-candidate/v1',version,profile:'candidate-verification',sourceDigest:artifactApi.ciSourceDigest(request,archive.provider,archive.repositoryId),buildDigest:artifactApi.ciBuildDigest(request,archive.runId),artifacts:[{name:'runtime.tgz',digest:'sha256:'+sha(payload),bytes:payload.length}]}};
 const files=new Map([['evidence/check.txt',evidence]]),verify=(r,m=files)=>check(r,m,version,request,archive,['required'],candidateDigest,artifactApi);
 assert.deepEqual(verify(result),['artifacts/runtime.tgz']);
 for(const change of [v=>v.candidate.version='0.9.0-preview.1',v=>v.requestId='another-request',v=>v.runId='another-run',v=>v.candidate.sourceDigest='sha256:'+'f'.repeat(64),v=>v.candidate.buildDigest='sha256:'+'f'.repeat(64),v=>v.checks=[],v=>v.checks[0].status='UNKNOWN',v=>v.candidate.artifacts=[],v=>v.candidateDigest='sha256:'+'f'.repeat(64)]){const invalid=structuredClone(result);change(invalid);assert.throws(()=>verify(invalid));}
 assert.throws(()=>verify(result,new Map()),/Missing prerequisite\/check evidence/);
 assert.throws(()=>verify(result,new Map([...files,['artifacts/runtime.tgz',payload]])),/complete RC payload/);
 assert.throws(()=>verify(result,new Map([...files,['artifacts/runtime.tgz',Buffer.from('corrupt payload')]])));
});
test('E05 RC missing-artifact callback rejects absent original evidence before installation access',async()=>{
 const {openScenario}=await import('../acceptance/v090/support.mjs'),f=collectorFixture(),prior=process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION;
 try{
  const selection={schema:'runtime-v090-acceptance-selection/v1',installedRoot:path.join(f.root,'absent-installation'),expectedManifestDigest:'a'.repeat(64),connectionRef:path.join(f.root,'absent-connection'),workspaceId:'test',projectId:'test',runId:'e05-rc-source-guard',outputRoot:path.join(f.root,'must-not-exist'),qualification:'DEVELOPMENT',caseIds:['E05.variant.02']},filename=path.join(f.root,'selection.json');fs.writeFileSync(filename,JSON.stringify(selection),{mode:0o600});process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION=filename;
  await assert.rejects(openScenario('E05'),/E05\.variant\.02 requires exact original RC candidate missing-artifact records/);assert.equal(fs.existsSync(selection.outputRoot),false);
 }finally{if(prior===undefined)delete process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION;else process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION=prior;f.cleanup();}
});

// LC guard inputs are synthetic; no source test establishes actual tool vectors.
test('LC collector keeps the fixed twenty PRE and one POST obligations',async()=>{
 const {correctionCatalog,correctionCounts,validateCorrectionCases}=await import('../acceptance/v090/correction.test.mjs'),catalog=JSON.parse(fs.readFileSync(new URL('../../governance/lifecycle-correction-v090.json',import.meta.url)));
 const pre=correctionCatalog(catalog,'PRE_RELEASE'),post=correctionCatalog(catalog,'POST_RELEASE');assert.equal(pre.length,20);assert.deepEqual(post.map(c=>c.id),['LC12']);
 const partial=correctionCounts(pre,['LC21'],[{caseInstanceId:'LC21',status:'PASS'}]);assert.equal(partial.fullDenominator,709);for(const ids of [[],['LC21','LC21'],['LC12'],['unknown']])assert.throws(()=>validateCorrectionCases(pre,ids));assert.deepEqual(validateCorrectionCases(pre,['LC21']),['LC21']);assert.equal(partial.unexecutedCaseIds.length,19);assert.equal(partial.scenarioStatus,'INCOMPLETE');assert.equal(partial.executed,1);assert.equal(correctionCounts(post,['LC12'],[]).executed,0);
 for(const change of [c=>c.acceptance.cases.pop(),c=>c.acceptance.cases.find(c=>c.id==='LC21').vectors.pop(),c=>c.acceptance.cases.find(c=>c.id==='LC12').phase='PRE_RELEASE']){const invalid=structuredClone(catalog);change(invalid);assert.throws(()=>correctionCatalog(invalid,'PRE_RELEASE'));}
});
test('LC21 parser verifies real failure protocol and preserves unknown costs',async()=>{
 const {parseLC21Driver:parse,LC21_FAULTS}=await import('../acceptance/v090/correction.test.mjs');
 const result={schema:'runtime-correction-tooling-result/v1',tool:'graph',status:'COMPLETED',toolIdentity:{node:'v24.14.0','dependency-cruiser':'18.7.2'},elapsedMs:4,tokenUsage:null,monetaryCost:null,costStatus:'UNKNOWN',acceptance:'NOT_EVALUATED',graph:{closureComplete:false,modules:4,edges:3}},raw=value=>({code:0,signal:null,exceeded:null,stdout:JSON.stringify(value)+'\n',stderr:'',elapsedMs:5});
 assert.equal(parse(raw(result),'valid-output').status,'COMPLETED');assert.equal(parse(raw(result),'unknown-cost').monetaryCost,null);
 const protocol={...result,status:'FAILED',error:'Invalid dependency graph protocol'},command={...result,status:'FAILED',error:'graph exited 23: LC21 controlled command failure\n'};
 assert.equal(parse({...raw(protocol),code:1},'cli-protocol-mismatch').status,'FAILED');assert.equal(parse({...raw(command),code:1},'command-fail').status,'FAILED');
 for(const change of [r=>r.code=1,r=>r.signal='SIGKILL',r=>r.exceeded='TIME_LIMIT',r=>r.stdout='noise\n'+r.stdout]){const invalid=raw(result);change(invalid);assert.throws(()=>parse(invalid,'valid-output'));}
 for(const change of [r=>r.monetaryCost=0,r=>r.tokenUsage=0,r=>r.costStatus='KNOWN',r=>r.toolIdentity['dependency-cruiser']='invented',r=>r.graph.closureComplete=true]){const invalid=structuredClone(result);change(invalid);assert.throws(()=>parse(raw(invalid),'unknown-cost'));}
 assert.throws(()=>parse({...raw(protocol),code:0},'cli-protocol-mismatch'));assert.throws(()=>parse({...raw({...command,error:'unrelated error'}),code:1},'command-fail'));
 assert.match(LC21_FAULTS['cli-protocol-mismatch'],/CONTROLLED/);assert.match(LC21_FAULTS['command-fail'],/exitCode=23/);
});

test('LC21 executable streaming identity has a distinct bounded executable budget',async()=>{
 const {hashExecutable}=await import('../acceptance/v090/correction.test.mjs'),f=collectorFixture();
 try{const file=path.join(f.root,'node-executable-fixture');const fd=fs.openSync(file,'wx',0o700);fs.ftruncateSync(fd,16777217);fs.closeSync(fd);const identity=hashExecutable(file);assert.equal(identity.bytes,16777217);assert(/^[a-f0-9]{64}$/.test(identity.sha256));const huge=fs.openSync(file,'r+');fs.ftruncateSync(huge,268435457);fs.closeSync(huge);assert.throws(()=>hashExecutable(file));const link=path.join(f.root,'alias');fs.symlinkSync(file,link);assert.throws(()=>hashExecutable(link));}finally{f.cleanup();}
});

test('LC21 graph closure explicitly requires locked TypeScript independently of upstream dependency metadata',async t=>{
 const {toolClosure}=await import('../acceptance/v090/correction.test.mjs'),{sha}=await import('../acceptance/v090/support.mjs');
 const make=()=>{const f=collectorFixture(),put=(name,version)=>{const root=path.join(f.root,'node_modules',name);fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name,version,dependencies:{}}));return root;};const tool=put('dependency-cruiser','18.7.2'),typescript=put('typescript','5.9.3'),lib=path.join(typescript,'lib/typescript.js');fs.mkdirSync(path.dirname(lib));fs.writeFileSync(lib,'// Synthetic closure guard input, not an upstream TypeScript implementation.\n');return{...f,tool,typescript,lib,lock:{packages:{'node_modules/dependency-cruiser':{version:'18.7.2'},'node_modules/typescript':{version:'5.9.3'}}}};};
 await t.test('TypeScript is independently selected and its implementation bytes are pinned',()=>{const f=make();try{const closure=toolClosure(f.root,f.lock);assert.deepEqual([...closure.values()].map(p=>[p.name,p.version]).sort(),[['dependency-cruiser','18.7.2'],['typescript','5.9.3']]);const pin=closure.get(f.typescript).pins['lib/typescript.js'];assert.equal(pin.sha256,sha(fs.readFileSync(f.lib)));fs.appendFileSync(f.lib,'// changed original bytes\n');assert.notEqual(toolClosure(f.root,f.lock).get(f.typescript).pins['lib/typescript.js'].sha256,pin.sha256);}finally{f.cleanup();}});
 for(const [name,change]of [['missing-typescript',f=>fs.rmSync(f.typescript,{recursive:true})],['unsupported-even-if-lock-agrees',f=>{fs.writeFileSync(path.join(f.typescript,'package.json'),JSON.stringify({name:'typescript',version:'5.9.4'}));f.lock.packages['node_modules/typescript'].version='5.9.4';}],['wrong-package-identity',f=>fs.writeFileSync(path.join(f.typescript,'package.json'),JSON.stringify({name:'other-package',version:'5.9.3'}))],['lock-version-drift',f=>f.lock.packages['node_modules/typescript'].version='5.9.4']])await t.test(name,()=>{const f=make();try{change(f);assert.throws(()=>toolClosure(f.root,f.lock));}finally{f.cleanup();}});
});

// E16 source guards are synthetic inputs, never actual owner/Host acceptance.
test('E16 owner fixture binds exact candidate workspace project and fixed case',async()=>{
 const {validateOwnerCaseFixture:check}=await import('../acceptance/v090/e16.test.mjs'),s={expectedManifestDigest:'a'.repeat(64),workspaceId:'workspace',projectId:'project'},f={schema:'runtime-v090-owner-feedback-fixture/v1',candidateDigest:'sha256:'+s.expectedManifestDigest,workspaceId:s.workspaceId,projectId:s.projectId,syntheticAssets:true,syntheticDecisions:true,casePlans:{'E16.journey':{originalsOnly:true}}};assert.deepEqual(check(f,s,'E16.journey'),f.casePlans['E16.journey']);
 for(const change of [v=>v.candidateDigest='sha256:'+'b'.repeat(64),v=>v.workspaceId='other',v=>v.projectId='other',v=>v.casePlans={},v=>v.casePlans['invented.case']={},v=>v.fixtureClaimsPASS=true]){const invalid=structuredClone(f);change(invalid);assert.throws(()=>check(invalid,s,'E16.journey'));}
});
test('E16 historical owner values require exact original event sequence kind id and digest',async()=>{
 const {assertOwnerHistorySnapshot:check}=await import('../acceptance/v090/e16.test.mjs'),{evidenceValueDigest:vd}=await import('../../dist/server/errors.js'),snapshot={sequence:4,value:{status:'UNKNOWN',receiptDigest:null,dispositionDigest:null,softwareRelease:false}},events=[{seq:4,type:'owner-feedback-observed',data:{kind:'owner-feedback-observation',id:'event:harness',digest:vd(snapshot.value)}}];assert.deepEqual(check(snapshot,events,'owner-feedback-observation','event:harness',vd),snapshot.value);
 for(const change of [v=>v.sequence=5,v=>v.value.status='REUSE_APPROVED',v=>v.claimedNative=true]){const invalid=structuredClone(snapshot);change(invalid);assert.throws(()=>check(invalid,events,'owner-feedback-observation','event:harness',vd));}assert.throws(()=>check(snapshot,events,'owner-feedback-delivery','event:harness',vd));assert.throws(()=>check(snapshot,events,'owner-feedback-observation','another-event:harness',vd));
});
test('E16 single owner recovery preserves the other successful receipt and original ordering',async()=>{
 const {assertPartialOwnerRecovery:check}=await import('../acceptance/v090/e16.test.mjs'),history={ontology:[{sequence:1,value:{status:'REVIEW_REQUIRED',receiptDigest:'retained-ontology'}}],harness:[{sequence:2,value:{status:'UNKNOWN',receiptDigest:null}},{sequence:3,value:{status:'REVIEW_REQUIRED',receiptDigest:'original-harness'}}]};assert.equal(check(history,'harness').preservedReceiptDigest,'retained-ontology');
 for(const change of [v=>v.harness.shift(),v=>v.harness[1].sequence=1,v=>v.harness[1].value.status='UNKNOWN',v=>v.ontology[0].sequence=4,v=>v.ontology.push({sequence:4,value:{status:'REVIEW_REQUIRED',receiptDigest:'replacement-receipt'}})]){const invalid=structuredClone(history);change(invalid);assert.throws(()=>check(invalid,'harness'));}
});
test('E16 reuse guard requires a real current fixed LC20 native owner qualification',async()=>{
 const {assertCurrentOwnerReuse:check}=await import('../acceptance/v090/e16.test.mjs'),q={schema:'runtime-evidence-qualification/v2',caseId:'LC20',formalAcceptanceEligible:true,status:'QUALIFIED',mode:'PASS_REUSED',phase:'PRE_RELEASE',originalCandidateDigest:'old',currentCandidateDigest:'current',releaseAuthorized:false,executionAuthorized:false,establishesEnvironmentState:false,expiresAt:new Date(Date.now()+60000).toISOString(),nativeReceiptDigest:'receipt',nativeReportDigest:'report',originalReceiptRef:'original',originalRawBytesRef:'bytes',reasons:[]};check(q);
 for(const change of [v=>v.formalAcceptanceEligible=false,v=>v.mode='EXECUTED',v=>v.caseId='E16.CV06',v=>v.nativeReportDigest=null,v=>v.originalCandidateDigest='current',v=>v.expiresAt=new Date(0).toISOString(),v=>v.reasons=['OWNER_POLICY_UNAVAILABLE'],v=>v.releaseAuthorized=true]){const invalid=structuredClone(q);change(invalid);assert.throws(()=>check(invalid));}
});
test('E16 three owner cases require protected real bindings before installation access',async()=>{
 const {openScenario}=await import('../acceptance/v090/support.mjs'),f=collectorFixture(),prior=process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION;
 try{const ref=path.join(f.root,'selection.json');for(const caseId of ['E16.journey','E16.variant.01','E16.CV06']){const selection={schema:'runtime-v090-acceptance-selection/v1',installedRoot:path.join(f.root,'absent-installation'),expectedManifestDigest:'a'.repeat(64),connectionRef:path.join(f.root,'absent-connection'),workspaceId:'test',projectId:'test',runId:'e16-owner-input-guard',outputRoot:path.join(f.root,'must-not-exist'),qualification:'DEVELOPMENT',caseIds:[caseId]};fs.writeFileSync(ref,JSON.stringify(selection),{mode:0o600});process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION=ref;await assert.rejects(openScenario('E16'),/NOT_READY|NOTREADY|ownerFeedback/);assert.equal(fs.existsSync(selection.outputRoot),false);}}
 finally{if(prior===undefined)delete process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION;else process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION=prior;f.cleanup();}
});

test('CV06 later failure uses an original PASS-only action and actual failed stage readback',async()=>{
 const {deriveLaterOwnerFailure}=await import('../acceptance/v090/e16.test.mjs'),{qualifyEvidence,createNativeQualificationService}=await import('../../dist/lifecycle/evidence-qualification.js'),{EVIDENCE_INPUT_KINDS}=await import('../../dist/lifecycle/correction-contract.js'),{valueDigest:vd,byteDigest}=await import('../../dist/lifecycle/base.js');
 // Synthetic regression material only. No native owner/provider result is
 // manufactured by this test or used as actual E16 acceptance evidence.
 const now=Date.now(),old=vd('old'),current=vd('current'),scope={workspaceId:'workspace',projectId:'known-project',acceptanceScopeDigest:vd('catalog')},manifest=candidateDigest=>({schema:'runtime-evidence-input-manifest/v1',candidateDigest,completeness:'COMPLETE',dynamicInputs:'RESOLVED',externalInputs:'RESOLVED',roots:['source'],nodes:[{id:'source',kind:'source',digest:vd('unchanged'),dependsOn:[]}],notApplicable:EVIDENCE_INPUT_KINDS.filter(k=>k!=='source').map(kind=>({kind,reason:'Synthetic phase guard only'}))}),before=manifest(old),after=manifest(current),rawReceipt='{"synthetic":"phase guard"}\n',original={schema:'runtime-original-evidence-execution/v1',mode:'EXECUTED',scope,caseId:'LC20',runId:'original-pass',candidateDigest:old,inputManifestDigest:vd(before),rawReceiptDigest:byteDigest(rawReceipt),outcome:'PASS',executedAt:new Date(now-20000).toISOString(),expiresAt:new Date(now+60000).toISOString()},input={schema:'runtime-evidence-qualification-input/v1',scope,caseId:'LC20',currentCandidateDigest:current,original,originalExecutionDigest:vd(original),rawReceipt,originalInputs:before,currentInputs:after,history:[{executionDigest:vd(original),candidateDigest:old,rawReceiptDigest:original.rawReceiptDigest,outcome:'PASS',executedAt:original.executedAt}],executionRule:'OWNER_POLICY'},selection={schema:'runtime-evidence-qualification-selection/v2',scope,caseId:'LC20',currentCandidateDigest:current,originalExecutionDigest:vd(original),phase:'PRE_RELEASE'},facts={schema:'runtime-protected-qualification-facts/v2',input,formalAcceptanceEligible:true,original:{},history:{},inventories:{},policy:{owner:{reference:{digest:vd('policy')}}},validity:{},assessmentAuthority:{}},body={schema:'runtime-native-qualification-action/v2',selection,facts,factsDigest:vd(facts),action:{request:{requestId:'good-assessment'}},assessedAt:new Date(now-10000).toISOString(),expiresAt:new Date(now+60000).toISOString()},good={...body,digest:vd(body)};
 assert.deepEqual((await qualifyEvidence(input)).reasons,['OWNER_POLICY_UNAVAILABLE']);
 const contract={caseId:'LC20',phase:'PRE_RELEASE',catalogDigest:scope.acceptanceScopeDigest},requestBody={id:'later-failed-claim',workspaceId:scope.workspaceId,projectId:scope.projectId,inputDigest:vd('failed-input'),requestedAt:new Date(now-5000).toISOString(),plan:{parameters:{candidateDigest:current,qualificationProducer:{mode:'EXECUTE',contract,contractDigest:vd(contract),policyReferenceDigest:vd('policy')}}}};requestBody.planDigest=vd(requestBody.plan);const request={...requestBody,digest:vd(requestBody)},observation={requestId:request.id,inputDigest:request.inputDigest,phase:'FAILED',outcome:{status:'FAILED'}},evidence={requestId:request.id,observation,observedAt:new Date(now-1000).toISOString()},observed={observationRef:vd(evidence),evidence},failed={request,progress:{phase:'FAILED',terminal:true,observationRef:observed.observationRef,observation},workerError:null,automaticRedispatch:false};
 const probe=deriveLaterOwnerFailure(good,failed,observed,scope,vd);assert.equal(input.history.length,1);assert(input.history.every(h=>h.outcome==='PASS'));assert.equal(probe.scope.projectId,'known-project');assert.equal(probe.history.at(-1).outcome,'FAIL');const rejected=await qualifyEvidence(probe);assert.equal(rejected.status,'EXECUTION_REQUIRED');assert(rejected.reasons.includes('FAILURE_HISTORY_REQUIRES_EXECUTION'));
 let ownerCalls=0,writes=0;const actor={id:'reader',projects:[scope.projectId],permissions:['read','execution.request'],revision:1,expiresAt:new Date(now+60000).toISOString()},withFailure={...facts,input:probe},store={workspaceId:scope.workspaceId,object:(_project,_kind,id)=>id==='good-assessment'?good:null,mutate:()=>{writes++;throw Error('Unexpected mutation');}},service=createNativeQualificationService(store,{read:async()=>withFailure,owner:()=>{ownerCalls++;throw Error('Unexpected owner assessment');}});
 // A pre-existing FAIL prevents preparation. An already stored clean action
 // instead becomes unusable when current protected history acquires that FAIL.
 await assert.rejects(service.prepare(selection,actor,AbortSignal.timeout(1000)),e=>e.code==='QUALIFICATION_EXECUTION_REQUIRED'&&e.message.includes('FAILURE_HISTORY_REQUIRES_EXECUTION'));
 await assert.rejects(service.inspect(scope.projectId,'good-assessment',actor,AbortSignal.timeout(1000)),e=>e.code==='QUALIFICATION_EXECUTION_REQUIRED'&&e.message.includes('FAILURE_HISTORY_REQUIRES_EXECUTION'));
 assert.equal(ownerCalls,0);assert.equal(writes,0);
 const invalidGood=structuredClone(good);invalidGood.facts.input.history.push(probe.history.at(-1));assert.throws(()=>deriveLaterOwnerFailure(invalidGood,failed,observed,scope,vd),/cannot already contain failed history/);
 const otherScope={...scope,projectId:'primary-project'};assert.throws(()=>deriveLaterOwnerFailure(good,failed,observed,otherScope,vd));
 const early=structuredClone(failed);early.request.requestedAt=new Date(now-15000).toISOString();const{digest:unused,...earlyBody}=early.request;early.request.digest=vd(earlyBody);assert.throws(()=>deriveLaterOwnerFailure(good,early,observed,scope,vd),/after the original valid assessment/);
 const unknown=structuredClone(failed);unknown.progress.phase='UNKNOWN';assert.throws(()=>deriveLaterOwnerFailure(good,unknown,observed,scope,vd));const forged=structuredClone(observed);forged.evidence.observation.outcome.status='PASS';assert.throws(()=>deriveLaterOwnerFailure(good,failed,forged,scope,vd));
});

// CV07 guard material below is synthetic parser input, never an actual case
// report or provider fixture. E20 remains an independent later obligation.
function coverageGuardFixture(scenario='E01'){
 const matrix=JSON.parse(fs.readFileSync(new URL('../../governance/parameter-matrix-v090.json',import.meta.url))),expectedIds=matrix.caseInstances.filter(c=>c.scenario===scenario).map(c=>c.caseInstanceId),candidate={manifestDigest:'a'.repeat(64),archiveDigest:'b'.repeat(64),version:'0.9.0',serviceId:'original-service',workspaceId:'workspace',projectId:'project'},context={scenario,expectedIds,qualification:'DEVELOPMENT',candidate,matrixDigest:'c'.repeat(64),collectorPins:{'support.mjs':'d'.repeat(64)}};
 const records=expectedIds.filter(id=>id!==scenario+'.CV07').map(caseInstanceId=>{const result={caseInstanceId,status:'PASS',candidateDigest:'sha256:'+candidate.manifestDigest,qualification:context.qualification,assertions:{syntheticGuardInput:true},evidence:[{caseInstanceId,artifact:'original.json',fileDigest:'e'.repeat(64)}]},selection={scenario,qualification:context.qualification,candidate,candidateDigest:result.candidateDigest,selectedCaseIds:[caseInstanceId],sourceQualification:'SEPARATE_E20_OBLIGATION',matrixDigest:context.matrixDigest,collectorPins:context.collectorPins},report={scenario,candidate,candidateDigest:result.candidateDigest,selectionDigest:'f'.repeat(64),qualification:context.qualification,scenarioDenominator:expectedIds.length,fullDenominator:664,selected:1,executed:1,passed:1,failed:0,unexecutedCaseIds:expectedIds.filter(id=>id!==caseInstanceId),scenarioStatus:'INCOMPLETE',productAcceptance:'NOT_EVALUATED',releaseAuthorized:false,dailyInstallationChanged:false,setupEvidence:[{caseInstanceId:null,artifact:'setup.json',fileDigest:'e'.repeat(64)}],results:[result]};return{caseInstanceId,report,selection,caseRecord:structuredClone(result)};});return{context,records};
}
test('CV07 recognizes the actual original emit schema without requiring a nonexistent mode or E20',async()=>{
 const {validateCoverageInventoryRecords:check}=await import('../acceptance/v090/execution.mjs');
 for(const scenario of ['E01','E02','E18']){const {records,context}=coverageGuardFixture(scenario),result=check(records,context);assert.equal(result.originalExecutions,context.expectedIds.length-1);assert.equal(result.siblingExecutionsReexecuted,false);assert(!result.originalCaseIds.includes(scenario+'.CV07'));assert(!result.originalCaseIds.some(id=>id.startsWith('E20.')));assert.equal(result.sourceQualification,'SEPARATE_E20_OBLIGATION');assert.equal(Object.hasOwn(records[0].report.results[0],'mode'),false);}
});
test('CV07 rejects missing empty duplicate skipped xfailed reused and wrong-candidate original inputs',async()=>{
 const {validateCoverageInventoryRecords:check}=await import('../acceptance/v090/execution.mjs'),f=coverageGuardFixture();
 for(const change of [v=>v.pop(),v=>v.splice(0),v=>v.push(structuredClone(v[0])),v=>v[0].report.results=[],v=>v[0].report.results[0].assertions={},v=>v[0].report.results[0].evidence=[],v=>v[0].report.results[0].status='SKIP',v=>v[0].report.results[0].status='XFAIL',v=>v[0].report.results[0].status='PASS_REUSED',v=>v[0].report.results[0].mode='PASS_REUSED',v=>v[0].selection.mode='PASS_REUSED',v=>v[0].report.results[0].assertions.mode='PASS_REUSED',v=>v[0].report.candidateDigest='sha256:'+'0'.repeat(64),v=>v[0].report.candidate.archiveDigest='0'.repeat(64),v=>v[0].selection.collectorPins={'support.mjs':'0'.repeat(64)},v=>v[0].selection.matrixDigest='0'.repeat(64),v=>v[0].caseRecord.assertions.changed=true,v=>v[0].report.schema='unknown-original-schema',v=>v[0].selection.caseCampaign={suppliedPASS:true}]){const invalid=structuredClone(f.records);change(invalid);assert.throws(()=>check(invalid,f.context));}
 assert.equal(check(f.records,f.context).originalExecutions,7,'Fault copies must leave the original records intact');
});
test('CV07 provider inventory requires both E18 providers and original sibling bindings',async()=>{
 const {validateCoverageProviderBindings:check}=await import('../acceptance/v090/execution.mjs'),f=coverageGuardFixture('E18'),provider=(name,index)=>({provider:name,reportCaseId:f.records[index].caseInstanceId,selection:{ref:'/synthetic/not-acceptance',sha256:'a'.repeat(64)},allowServiceRestart:true,record:{codingSourceSelection:{kind:'ORIGINAL_RECORD'}}}),providers=[provider('github',0),provider('gitlab',1)];assert.deepEqual(check(providers,'E18',f.records),providers);
 for(const change of [v=>v.pop(),v=>v.reverse(),v=>v.push(structuredClone(v[0])),v=>v[1].provider='github',v=>v[1].reportCaseId='E20.journey',v=>v[1].allowServiceRestart=false,v=>v[1].record.codingSourceSelection.kind='CURRENT_JOURNEY']){const invalid=structuredClone(providers);change(invalid);assert.throws(()=>check(invalid,'E18',f.records));}
});
test('CV07 authenticates native instance provenance while respecting original MCP and CLI wire formats',async()=>{
 const {coverageOriginalInstance:check}=await import('../acceptance/v090/execution.mjs'),{sha}=await import('../acceptance/v090/support.mjs'),caseId='E01.journey',candidate={projectId:'project'},request={caseInstanceId:caseId,envelope:{operation:'lifecycle.instance.inspect',projectId:'project',input:{instanceId:'real-instance'}}},body={result:{instance:{id:'real-instance',pins:{projectId:'project'}}}},rawBody=JSON.stringify(body),response={caseInstanceId:caseId,status:200,rawBody,body},item={responseDigest:sha(rawBody)};
 assert.equal(check(request,response,item,caseId,candidate),'real-instance');
 for(const change of [v=>v.request.envelope.projectId='other',v=>v.request.envelope.input.instanceId='another',v=>v.response.body.result.instance.pins.projectId='other',v=>v.response.rawBody='{}',v=>v.response.caseInstanceId='E02.journey']){const invalid=structuredClone({request,response});change(invalid);assert.throws(()=>check(invalid.request,invalid.response,item,caseId,candidate));}
 const protocol={caseInstanceId:caseId,path:'/mcp',rawBody:'{}'},protocolResponse={caseInstanceId:caseId,status:202,rawBody:''};assert.equal(check(protocol,protocolResponse,{responseDigest:sha('')},caseId,candidate),null);
 const cli={operation:'runtime.status',projectId:'project',input:{}},cliResponse={caseInstanceId:caseId,exitCode:0,signal:null,stdout:'{}',stderr:''};assert.equal(check(cli,cliResponse,{},caseId,candidate),null);
});
test('all three CV07 selectors reject missing actual bindings before installation access',async()=>{
 const {openScenario}=await import('../acceptance/v090/support.mjs'),f=collectorFixture(),prior=process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION;
 try{const ref=path.join(f.root,'selection.json');for(const scenario of ['E01','E02','E18']){const selection={schema:'runtime-v090-acceptance-selection/v1',installedRoot:path.join(f.root,'absent-installation'),expectedManifestDigest:'a'.repeat(64),connectionRef:path.join(f.root,'absent-connection'),workspaceId:'test',projectId:'test',runId:'cv07-guard',outputRoot:path.join(f.root,'must-not-exist'),qualification:'DEVELOPMENT',caseIds:[scenario+'.CV07']};fs.writeFileSync(ref,JSON.stringify(selection),{mode:0o600});process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION=ref;await assert.rejects(openScenario(scenario),/CV07.*NOT_READY/);assert.equal(fs.existsSync(selection.outputRoot),false);}}
 finally{if(prior===undefined)delete process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION;else process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION=prior;f.cleanup();}
});

// These pagination fixtures test collector recovery only; they are not native
// execution receipts and contribute no formal LC20 acceptance evidence.
test('LC20 original child recovery follows retained cursors beyond 50 without mutation',async()=>{
 const {findLc20OriginalAttempt:find}=await import('../acceptance/v090/correction.test.mjs');
 for(const count of [1,51,101,4096]){
  const attempts=Array.from({length:count},(_,i)=>({requestId:'original-'+i,original:{synthetic:true,index:i}})),calls=[];
  const read=async(op,input)=>{calls.push({op,input});assert.equal(op,'lifecycle.qualification.origin.inspect');assert.equal(input.registrationRef,'binding:child');assert.equal(input.limit,50);const start=input.afterRequestId?attempts.findIndex(a=>a.requestId===input.afterRequestId)+1:0,selected=attempts.slice(start,start+50);return{producer:'CLOSED_PROBE',formalAcceptanceEligible:false,totalAttempts:count,historyWatermark:'sha256:'+'a'.repeat(64),attempts:selected,nextRequestId:start+selected.length<count?selected.at(-1).requestId:null};};
  assert.deepEqual(await find(read,'binding:child','original-'+(count-1)),attempts.at(-1));assert.equal(calls.length,Math.ceil(count/50));
 }
});
test('LC20 child history drift truncation and unknown originals never trigger redispatch',async()=>{
 const {findLc20OriginalAttempt:find}=await import('../acceptance/v090/correction.test.mjs'),attempts=Array.from({length:51},(_,i)=>({requestId:'original-'+i,original:{synthetic:true}}));
 for(const fault of ['watermark','total','cycle','duplicate','truncated','unknown','missing','oversized']){
  let calls=0;const read=async(op,input)=>{calls++;assert.equal(op,'lifecycle.qualification.origin.inspect');const start=input.afterRequestId?50:0,selected=structuredClone(attempts.slice(start,start+50)),result={producer:'CLOSED_PROBE',formalAcceptanceEligible:false,totalAttempts:51,historyWatermark:'sha256:'+'a'.repeat(64),attempts:selected,nextRequestId:start===0?'original-49':null};
   if(fault==='oversized')result.totalAttempts=4097;
   if(start===0&&fault==='truncated')result.nextRequestId=null;
   if(start>0){if(fault==='watermark')result.historyWatermark='sha256:'+'b'.repeat(64);if(fault==='total')result.totalAttempts=52;if(fault==='cycle')result.nextRequestId='original-49';if(fault==='duplicate')result.attempts[0].requestId='original-0';if(fault==='unknown')result.attempts[0].original=null;}return result;};
  await assert.rejects(find(read,'binding:child',fault==='missing'?'absent':'original-50'));assert(calls<=2);
 }
});

// E17 synthetic boundary inputs are not native migration or six-entry evidence.
function e17GuardFixture(){
 const selection={expectedManifestDigest:'a'.repeat(64),workspaceId:'workspace',projectId:'project'},entries=['http-api','http-mcp','cli','expert','dashboard-yaml','dashboard-graph'].map((entry,i)=>({entry,instanceId:'initial-'+i,authorityRef:'authority-'+i})),value={schema:'runtime-v090-initialization-migration/v1',candidateDigest:'sha256:'+selection.expectedManifestDigest,workspaceId:selection.workspaceId,projectId:selection.projectId,casePlans:{'E17.CV01':{yaml:{ref:'/synthetic-only/yaml',sha256:'b'.repeat(64)},graphField:'implementation-binding',entries}}};return{selection,value};
}
test('E17 CV01 keeps all six entry producers with distinct exact native authority bindings',async()=>{
 const{validateE17Fixture:check}=await import('../acceptance/v090/maintenance.mjs'),{selection,value}=e17GuardFixture();assert.equal(check(value,selection,'E17.CV01').entries.length,6);
 for(const change of [v=>v.candidateDigest='sha256:'+'c'.repeat(64),v=>v.workspaceId='other',v=>v.projectId='other',v=>v.casePlans['E17.CV01'].entries.pop(),v=>v.casePlans['E17.CV01'].entries.reverse(),v=>v.casePlans['E17.CV01'].entries[1].entry='http-api',v=>v.casePlans['E17.CV01'].entries[1].instanceId='initial-0',v=>v.casePlans['E17.CV01'].entries[0].authorityRef='',v=>v.casePlans['E17.CV01'].status='PASS',v=>v.casePlans['E17.EX10']={}]){const invalid=structuredClone(value);change(invalid);assert.throws(()=>check(invalid,selection,'E17.CV01'));}assert.throws(()=>check(value,selection,'E17.journey'),/NOT_READY/);
});
test('E17 field vectors preserve exact canonical graph input and actual required binding semantics',async()=>{
 const{e17InputVectors:check}=await import('../acceptance/v090/maintenance.mjs'),{parse}=await import('yaml'),field={path:'config.plan.bindingRef',required:true,type:'bindingRef',policy:'CONFIGURABLE'},yaml='config:\n  plan:\n    bindingRef: binding:plan\n',vectors=check(yaml,field);assert.deepEqual(vectors.map(v=>v.name),['valid','missing-required','invalid-type']);assert.equal(vectors[0].yaml,yaml);assert.equal(parse(vectors[1].yaml).config.plan.bindingRef,'');assert.equal(parse(vectors[2].yaml).config.plan.bindingRef,'not-a-binding-reference');assert.throws(()=>check(yaml,{...field,required:false}));assert.throws(()=>check(yaml,{...field,policy:'LOCKED'}));assert.throws(()=>check(yaml,{...field,type:'integer'}));assert.throws(()=>check('config: {plan: {bindingRef: binding:plan}}\n',field),/canonical/);
});
test('E17 new-instance guard binds original revision effective graph Base and untouched PENDING history',async()=>{
 const{assertE17NewInstance:check}=await import('../acceptance/v090/maintenance.mjs'),effective={semanticDigest:'sha256:'+'a'.repeat(64),base:{id:'base',digest:'sha256:'+'b'.repeat(64)},nodes:[{id:'scope'}]},definition={id:'sha256:'+'c'.repeat(64),compilation:{effective}},plan={instanceId:'actual-new'},instance={id:plan.instanceId,pins:{projectId:'project',definitionRevisionId:definition.id,semanticDigest:effective.semanticDigest,base:effective.base},definition:effective,requestIds:[],stages:Object.fromEntries(['scope','plan','implementation','candidate','verification','release-decision','publication','closure'].map(id=>[id,{status:'PENDING',attempts:0,requestId:null}])),pinsDigest:'synthetic-guard-only'};assert.equal(check(instance,definition,plan,'project'),instance.pinsDigest);
 for(const change of [v=>v.id='other',v=>v.pins.projectId='other',v=>v.pins.definitionRevisionId='other',v=>v.pins.semanticDigest='other',v=>v.pins.base.digest='other',v=>v.definition.nodes=[],v=>v.requestIds=['old-request'],v=>v.stages.scope.status='PASSED',v=>v.stages.scope.attempts=1,v=>v.stages.scope.requestId='old-request',v=>delete v.stages.closure]){const invalid=structuredClone(instance);change(invalid);assert.throws(()=>check(invalid,definition,plan,'project'));}
});
test('E17 protected fixture is checked again after original bytes change',async()=>{
 const{e17Plan}=await import('../acceptance/v090/maintenance.mjs'),{sha}=await import('../acceptance/v090/support.mjs'),f=collectorFixture(),{selection,value}=e17GuardFixture();try{const ref=path.join(f.root,'fixture.json');fs.writeFileSync(ref,JSON.stringify(value),{mode:0o600});const run={selection:{...selection,initializationMigration:{ref,sha256:sha(fs.readFileSync(ref))}}},prepared=e17Plan(run,{caseInstanceId:'E17.CV01'});prepared.recheck();fs.appendFileSync(ref,' ');assert.throws(()=>prepared.recheck());}finally{f.cleanup();}
});
test('both E17 selectors refuse absent actual migration/initialization bindings before installed access',async()=>{
 const{openScenario}=await import('../acceptance/v090/support.mjs'),f=collectorFixture(),prior=process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION;try{for(const id of ['E17.journey','E17.CV01']){const ref=path.join(f.root,'selection.json'),selection={schema:'runtime-v090-acceptance-selection/v1',installedRoot:path.join(f.root,'absent'),connectionRef:path.join(f.root,'absent-connection'),expectedManifestDigest:'a'.repeat(64),workspaceId:'workspace',projectId:'project',runId:'e17-source-only',outputRoot:path.join(f.root,'never-created'),qualification:'DEVELOPMENT',caseIds:[id]};fs.writeFileSync(ref,JSON.stringify(selection),{mode:0o600});process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION=ref;await assert.rejects(openScenario('E17'),/NOT_READY|initializationMigration/);assert.equal(fs.existsSync(selection.outputRoot),false);}}finally{if(prior===undefined)delete process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION;else process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION=prior;f.cleanup();}
});

// Synthetic E17 journey parser material; no original native records are made.
function e17JourneyGuardPlan(){const hash='a'.repeat(64),pin={ref:'/fixture/original.json',sha256:hash};return{sourceRoot:'/fixture/source',sourceSnapshotDigest:hash,originalRoot:'/fixture/original',originalSnapshotDigest:hash,backupRoot:'/fixture/backup',preservationRoot:'/fixture/preservation',installPlan:pin,projectRoot:'/fixture/project',referenceFiles:[],oldPackage:{root:'/fixture/package',archiveRef:'/fixture/official.tgz',archiveSha256:'4eef2130c2854fe1ecd56ca664882c4aa3026145388cad88d258de3bba3fd42d'},reads:[{family:'planning',operation:'planning.read',input:{id:'original'},original:pin,statusPointers:[{pointer:'/readable/snapshot/stages/0/status',value:'PENDING'}],pinPointers:['/revision/draft']},{family:'reconstruction',operation:'reconstruction.attempt',input:{id:'retained'},original:pin,statusPointers:[{pointer:'/receipt/stages/build',value:'NOT_RUN'}],pinPointers:['/claim']}],preservedFiles:['ontology','harness','decision'].map(role=>({role,ref:'/fixture/project/'+role+'.json',sha256:hash})),unknownSchema:{root:'/fixture/unknown',databaseSha256:hash},newGoal:{id:'new-evidence',description:'Explicit case evidence without decision or dispatch'},additiveEvidence:pin,allowServiceControl:true};}
test('E17 complete journey fixture requires official baseline isolated roots literal histories and all preservation bindings',async()=>{
 const{validateE17JourneyPlan:check}=await import('../acceptance/v090/maintenance.mjs'),p=e17JourneyGuardPlan();assert.deepEqual(check(p),p);
 for(const change of [v=>delete v.preservationRoot,v=>v.originalRoot=v.sourceRoot,v=>v.backupRoot=v.sourceRoot+'/backup',v=>v.oldPackage.archiveSha256='0'.repeat(64),v=>v.reads=[],v=>v.reads[0].statusPointers[0].value='PREPARED',v=>v.reads[1].statusPointers[0].value='APPROVED',v=>v.reads[0].operation='planning.decide',v=>v.reads.forEach(r=>r.pinPointers=[]),v=>v.preservedFiles.pop(),v=>v.unknownSchema.root=v.sourceRoot,v=>v.nativePASS=true,v=>v.allowServiceControl=false]){const invalid=structuredClone(p);change(invalid);assert.throws(()=>check(invalid));}
});
test('E17 original public history requires unchanged values exact literal status paths and nonempty pins',async()=>{
 const{assertE17HistoricalValue:check}=await import('../acceptance/v090/maintenance.mjs'),value={state:{pending:'PENDING',stages:{build:'NOT_RUN'}},pins:{source:'retained-original'},decision:{id:'original-decision'}},read={statusPointers:[{pointer:'/state/pending',value:'PENDING'},{pointer:'/state/stages/build',value:'NOT_RUN'}],pinPointers:['/pins']};assert.deepEqual(check(value,structuredClone(value),read),value);
 for(const change of [v=>v.state.pending='PREPARED',v=>v.state.stages.build='SUCCEEDED',v=>v.pins.source='new',v=>v.decision.id='replacement']){const invalid=structuredClone(value);change(invalid);assert.throws(()=>check(invalid,value,read));}assert.throws(()=>check(value,value,{...read,pinPointers:['/absent']}));assert.throws(()=>check(value,value,{...read,statusPointers:[{pointer:'/state/absent',value:'PENDING'}]}));assert.throws(()=>check({...value,pins:{}},{...value,pins:{}},read));
});
test('E17 old published package verifier refuses caller-selected archives before any package import',async()=>{
 const{verifyE17PublishedArchive:check}=await import('../acceptance/v090/maintenance.mjs');assert.throws(()=>check('/absent-never-imported',Buffer.from('synthetic not official archive')));
});

// Never accepted as product evidence: these mocks exercise fail-closed routing.
test('LC04 and LC05 reject absent native proofs and ambiguous deterministic refusal',async()=>{
 const {observeLcNativeVector:observe}=await import('../acceptance/v090/correction.test.mjs'),{createHash}=await import('node:crypto');
 const stable=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(stable).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}',hash=v=>'sha256:'+createHash('sha256').update(stable(v)).digest('hex');
 const request={id:'original',digest:'request-digest',instanceId:'instance',stageId:'verification',pinsDigest:'pins',inputDigest:'inputs',planDigest:'plan',plan:{adapterId:'runtime-ci-owner-stage-v2',adapterDigest:'adapter',bindingDigest:'binding'},authorityRef:'existing',deadlineAt:'2026-11-01T00:00:00Z'},progress={phase:'FAILED',terminal:true,reason:'failure',observationRef:'observation',observation:{synthetic:true}},stage={request,progress},facts={originalRequestId:request.id,originalRequestDigest:request.digest,instanceId:request.instanceId,stageId:request.stageId,pinsDigest:request.pinsDigest,inputDigest:request.inputDigest,planDigest:request.planDigest,adapterId:request.plan.adapterId,adapterDigest:request.plan.adapterDigest,bindingDigest:request.plan.bindingDigest,authorityRef:request.authorityRef,deadlineAt:request.deadlineAt,phase:progress.phase,terminal:progress.terminal,reason:progress.reason,observationRef:progress.observationRef,observationDigest:hash(progress.observation)};
 const view={facts,proposal:{input:{stageRequestId:request.id,hypothesis:'synthetic hypothesis only'},facts,factsDigest:hash(facts)},proposalCurrent:true,executionAuthorized:false,releaseAuthorized:false,automaticRedispatch:false,nativeEvidence:{status:'AVAILABLE',originalRequestId:request.id,originalRequestDigest:request.digest},captureHistory:{rounds:[]}};
 for(const [caseId,vector,reason] of [['LC04','preparation-defect','REPAIR_EVIDENCE_REQUIRED'],['LC04','product-defect','REPAIR_EVIDENCE_REQUIRED'],['LC05','transient-bounded','REPAIR_EVIDENCE_REQUIRED'],['LC05','unchanged-deterministic','REPAIR_ORIGIN_UNPROVEN'],['LC05','two-no-progress','TWO_NO_PROGRESS_ROUNDS']]){
  const calls=[];const read=async op=>{calls.push(op);return op==='lifecycle.correction.inspect'?view:{...view,allowed:false,repairAdmission:{allowed:false,reasons:[reason]}};};await assert.rejects(observe(caseId,vector,{original:{},correctionRef:'synthetic'},read,async()=>stage),/NOT_READY|Assertion/);assert.deepEqual(calls,['lifecycle.correction.inspect','lifecycle.correction.admission']);
 }
});

// Explicit synthetic byte/error guards only; not an actual old/native E17 run.
function e17SyntheticSQLite(version=9){const bytes=Buffer.alloc(4096);Buffer.from('SQLite format 3\0').copy(bytes);bytes.writeUInt16BE(4096,16);bytes[18]=2;bytes[19]=2;bytes.writeUInt32BE(version,60);return bytes;}
test('E17 pinned public schema refusal requires literal managed header9 verified native reads and unchanged bytes',async()=>{
 const{assertE17PublicSchemaRefusal:check}=await import('../acceptance/v090/maintenance.mjs'),before=e17SyntheticSQLite(),context=()=>({officialArchiveSha256:'4eef2130c2854fe1ecd56ca664882c4aa3026145388cad88d258de3bba3fd42d',managedReadbacksVerified:true,beforeBytes:Buffer.from(before),afterBytes:Buffer.from(before)}),error={code:'CORRUPT_STATE',message:'Cannot open verified Runtime state: CORRUPT_STATE'},result=check(error,context());assert.equal(result.before.sqliteUserVersion,9);assert.deepEqual(result.officialSourceSchemas,[1,2,3,4,5,6,7,8]);assert.deepEqual(result.publicError,error);
 for(const mutate of [c=>c.officialArchiveSha256='0'.repeat(64),c=>c.managedReadbacksVerified=false,c=>c.beforeBytes.writeUInt32BE(7,60),c=>{c.beforeBytes.writeUInt32BE(999,60);c.afterBytes.writeUInt32BE(999,60);},c=>c.afterBytes[4095]=1,c=>c.afterBytes.writeUInt32BE(8,60),c=>c.beforeBytes[0]=0,c=>c.beforeBytes[18]=0,c=>c.beforeBytes=c.beforeBytes.subarray(0,100)]){const invalid=context();mutate(invalid);assert.throws(()=>check(error,invalid));}
 for(const invalid of [null,{...error,code:'NOT_FOUND'},{...error,message:'Unknown state schema'},{...error,message:'Cannot open verified Runtime state: INVALID_LINEAGE'},{...error,message:'Cannot open verified Runtime state: invalid database'},{...error,message:'SQLite integrity check failed'}])assert.throws(()=>check(invalid,context()));
});
test('E17 postrollback receipt absence retains the exact unwrapped public NOT_FOUND contract',async()=>{
 const{e17MissingReceipt:check}=await import('../acceptance/v090/maintenance.mjs');assert.equal(check({code:'NOT_FOUND',message:'Receipt not found'}),true);for(const value of [null,{},new Error('Receipt not found'),{code:'NOT_FOUND',message:'Goal not found'},{code:'CORRUPT_STATE',message:'Cannot open verified Runtime state: NOT_FOUND'},{code:'NOT_FOUND',message:'Cannot open verified Runtime state: NOT_FOUND'}])assert.equal(check(value),false);
});

// CV03 tests validate fail-closed collection boundaries only. No synthetic
// fixture in this file is written as actual native/provider acceptance evidence.
function cv03GuardFixture(caseInstanceId='E01.CV03'){
 const original=id=>({instanceId:id,stageRequestId:id+'-request',creationRequestId:id+'-create',requestReceiptId:id+'-receipt'}),context={caseInstanceId,candidateDigest:'sha256:'+'a'.repeat(64),workspaceId:'workspace',projectId:'project',provider:caseInstanceId==='E02.CV03'?'gitlab':'github'},fixture={schema:'runtime-v090-managed-budget/v1',...context,sourceCommit:'b'.repeat(40),stageAdmission:{ref:'/synthetic-only/admission.json',sha256:'c'.repeat(64)},time:original('time'),attempts:{within:original('attempt-within'),reach:original('attempt-reach')},concurrency:{within:original('concurrency-within'),reach:original('concurrency-reach')},loops:[1,2,3,4].map(limit=>({limit,members:Array.from({length:limit},(_,i)=>original('loop-'+limit+'-'+i)),exhausted:{instanceId:'exhausted-'+limit,creationRequestId:'exhausted-'+limit+'-create'}})),unknownUsage:{instanceId:'unknown',targetVersion:'0.9.0'}};return{context,fixture};
}
test('CV03 exact fixtures retain all four cases and loop limits1–4 without caller outcomes or operations',async()=>{
 const {validateManagedBudgetFixture:check,MANAGED_BUDGET_CASES:cases}=await import('../acceptance/v090/execution.mjs');assert.deepEqual(cases,['E01.CV03','E02.CV03','E13.CV03','E18.CV03']);
 for(const id of cases){const f=cv03GuardFixture(id);assert.equal(check(f.fixture,f.context),f.fixture);for(const change of [v=>v.status='PASS',v=>v.sourceCommit='old',v=>v.caseInstanceId='E13.journey',v=>v.candidateDigest='sha256:'+'d'.repeat(64),v=>v.projectId='other',v=>v.provider='mock',v=>v.time.operation='lifecycle.stage.request',v=>v.time.deadlineAt='2099-01-01',v=>v.attempts.reach=v.attempts.within,v=>v.concurrency.reach.instanceId=v.concurrency.within.instanceId,v=>v.loops.pop(),v=>v.loops.reverse(),v=>v.loops[1].members.pop(),v=>v.loops[1].members[1]=v.loops[1].members[0],v=>v.loops[0].exhausted.instanceId=v.loops[0].members[0].instanceId,v=>v.stageAdmission.sha256='not-a-pin',v=>v.stageAdmission.ref='relative',v=>v.unknownUsage.maxTokens=0]){const bad=structuredClone(f.fixture);change(bad);assert.throws(()=>check(bad,f.context));}}
});
test('CV03 measured boundaries reject unknown usage, counterfeit reach and exceeded publisher caps',async()=>{
 const {assertManagedBudgetBoundary:check}=await import('../acceptance/v090/execution.mjs');
 for(const dimension of ['attempts','concurrency','loops'])for(let limit=1;limit<=4;limit++){assert.equal(check(dimension,'within',limit,limit-1).remaining,1);assert.equal(check(dimension,'reach',limit,limit).remaining,0);for(const invalid of [null,undefined,NaN,-1,0.5,'0',limit+1])assert.throws(()=>check(dimension,'reach',limit,invalid));assert.throws(()=>check(dimension,'within',limit,limit));}
 for(const args of [['maxTokens','within',1,0],['loops','PASS',1,0],['loops','reach',5,5],['loops','reach',0,0]])assert.throws(()=>check(...args));
});
test('CV03 denied calls require identical native ledger state and complete provider run/job inventories',async()=>{
 const {assertManagedBudgetNoDispatch:check}=await import('../acceptance/v090/execution.mjs'),before={instance:{requestIds:['original'],stages:{candidate:{attempts:1,status:'UNKNOWN'}}},recovery:{loopBudget:{consumed:1,remaining:0},attempts:['original']},events:[{type:'stage-requested',id:'original'}],revision:5,provider:{repositories:[{runs:[{id:'actual',attempt:1}]}],jobs:[{run:'actual',jobs:[{id:'job'}]}]}};
 check(before,structuredClone(before));for(const change of [v=>v.instance.requestIds.push('extra'),v=>v.instance.stages.candidate.attempts++,v=>v.instance.stages.candidate.status='PASSED',v=>v.recovery.loopBudget.consumed=0,v=>v.recovery.attempts.push('extra'),v=>v.events.push({type:'stage-advance-requested'}),v=>v.revision++,v=>v.provider.repositories[0].runs.push({id:'extra',attempt:1}),v=>v.provider.repositories[0].runs[0].attempt++,v=>v.provider.jobs[0].jobs.push({id:'retry'}),v=>v.provider.jobs=[]]){const after=structuredClone(before);change(after);assert.throws(()=>check(before,after));}
});
test('CV03 missing fixture stops all four actual callbacks before service, Host or provider calls',async()=>{
 const {collectManagedBudget,MANAGED_BUDGET_CASES}=await import('../acceptance/v090/execution.mjs');let touched=0;const fail=()=>{touched++;throw Error('must not access service');};for(const id of MANAGED_BUDGET_CASES)await assert.rejects(collectManagedBudget({selection:{},read:fail,request:fail,artifact:fail},{caseInstanceId:id}),/CV03_NOT_READY/);assert.equal(touched,0);
});
test('all CV03 selectors require protected singleton fixture and preserve early NOT_READY',async()=>{
 const {openScenario,sha}=await import('../acceptance/v090/support.mjs'),f=collectorFixture(),prior=process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION;
 try{const ref=path.join(f.root,'selection.json'),fixture=path.join(f.root,'budget.json');fs.writeFileSync(fixture,'{}',{mode:0o600});const pin={ref:fixture,sha256:sha(fs.readFileSync(fixture))};for(const scenario of ['E01','E02','E13','E18']){const selection={schema:'runtime-v090-acceptance-selection/v1',installedRoot:path.join(f.root,'absent-installation'),expectedManifestDigest:'a'.repeat(64),connectionRef:path.join(f.root,'absent-connection'),workspaceId:'test',projectId:'test',runId:'cv03-guard',outputRoot:path.join(f.root,'must-not-exist'),qualification:'DEVELOPMENT',caseIds:[scenario+'.CV03']};process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION=ref;fs.writeFileSync(ref,JSON.stringify(selection),{mode:0o600});await assert.rejects(openScenario(scenario),/CV03_NOT_READY/);assert.equal(fs.existsSync(selection.outputRoot),false);
  for(const change of [v=>v.caseIds.push(scenario+'.journey'),v=>v.managedBudget.sha256='d'.repeat(64),v=>v.stageAdmission=pin]){const bad={...structuredClone(selection),managedBudget:structuredClone(pin)};change(bad);fs.writeFileSync(ref,JSON.stringify(bad));await assert.rejects(openScenario(scenario),e=>e.code!=='ENOENT');assert.equal(fs.existsSync(selection.outputRoot),false);}
 }}finally{if(prior===undefined)delete process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION;else process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION=prior;f.cleanup();}
});
test('CV03 eight-stage fixture accepts each exact provider case and rejects stage omission',async()=>{
 const {validateStageAdmissionFixture:check,ADMISSION_STAGES:stages}=await import('../acceptance/v090/execution.mjs');for(const id of ['E01.CV03','E02.CV03','E13.CV03','E18.CV03']){const {context}=cv03GuardFixture(id),fixture={schema:'runtime-v090-stage-admission/v1',...context,sourceCommit:'b'.repeat(40),positive:{instanceId:'closed',codingSourceSelection:{kind:'ORIGINAL_RECORD'}},journeyReport:{ref:'/synthetic-only/report.json',sha256:'c'.repeat(64)},blocked:stages.map((stageId,index)=>({stageId,instanceId:index?'pending':'closed',creationRequestId:'original-create'}))};assert.equal(check(fixture,context),fixture);const bad=structuredClone(fixture);bad.blocked.pop();assert.throws(()=>check(bad,context));}
});

// E05.CV06 parser boundaries only. All inputs here are synthetic; no actual
// native owner/Host/provider/reuse result is manufactured by these source tests.
test('E05 CV06 fixture keeps exact native reuse deliver rebound and both partial feedback branches',async()=>{
 const {validateRevisionRecoveryFixture:check}=await import('../acceptance/v090/e16.test.mjs'),selection={expectedManifestDigest:'a'.repeat(64),workspaceId:'workspace',projectId:'project'},plan={reuse:{},deliver:{},rebound:{},qualification:{},partialRecovery:{},rejection:{}},fixture={schema:'runtime-v090-revision-recovery-fixture/v1',candidateDigest:'sha256:'+selection.expectedManifestDigest,workspaceId:'workspace',projectId:'project',syntheticAssets:true,syntheticDecisions:true,casePlans:{'E05.CV06':plan}};assert.deepEqual(check(fixture,selection,'E05.CV06'),plan);
 for(const change of [v=>v.candidateDigest='sha256:'+'b'.repeat(64),v=>v.workspaceId='foreign',v=>v.projectId='foreign',v=>v.syntheticAssets=false,v=>v.syntheticDecisions=false,v=>v.casePlans['E16.CV06']={},v=>delete v.casePlans['E05.CV06'].partialRecovery,v=>delete v.casePlans['E05.CV06'].rejection,v=>delete v.casePlans['E05.CV06'].rebound,v=>v.casePlans['E05.CV06'].fixturePASS=true]){const invalid=structuredClone(fixture);change(invalid);assert.throws(()=>check(invalid,selection,'E05.CV06'));}assert.throws(()=>check(fixture,selection,'E16.CV06'));
});
test('E05 single-owner rejection preserves actual other-owner approval receipt and event ordering',async()=>{
 const {assertSingleOwnerRejection:check,assertPartialOwnerRecovery:recover}=await import('../acceptance/v090/e16.test.mjs'),history={ontology:[{sequence:1,value:{status:'REUSE_APPROVED',receiptDigest:'original-other-owner'}}],harness:[{sequence:2,value:{status:'REVIEW_REQUIRED',receiptDigest:'original-failed-owner'}},{sequence:3,value:{status:'REJECTED',receiptDigest:'original-failed-owner'}}]};assert.equal(check(history,'harness').preservedReceiptDigest,'original-other-owner');
 for(const change of [v=>v.harness[1].value.status='REVIEW_REQUIRED',v=>v.harness[1].value.receiptDigest=null,v=>v.ontology[0].value.status='REJECTED',v=>v.ontology.push({sequence:4,value:{status:'REUSE_APPROVED',receiptDigest:'replacement'}}),v=>v.harness[1].sequence=1,v=>v.ontology[0].sequence=4]){const invalid=structuredClone(history);change(invalid);assert.throws(()=>check(invalid,'harness'));}assert.throws(()=>check(history,'other'));assert.throws(()=>recover(history,'harness'),'Rejection alone must not be labelled unknown recovery');const recovered=structuredClone(history);recovered.harness[0].value={status:'UNKNOWN',receiptDigest:null};recovered.harness[1].value.status='REUSE_APPROVED';assert.equal(recover(recovered,'harness').preservedReceiptDigest,'original-other-owner');
});
test('E05 direct shared CV06 callback rejects absent protected fixture before installed reads',async()=>{
 const {ownerFeedbackCase}=await import('../acceptance/v090/e16.test.mjs');let calls=0;await assert.rejects(ownerFeedbackCase({selection:{},read:()=>{calls++;throw Error('must not read');}},{caseInstanceId:'E05.CV06'}),/CV06_NOT_READY/);assert.equal(calls,0);
});
test('E05 selection requires a real CV06 protected binding before output or installed access',async()=>{
 const {openScenario}=await import('../acceptance/v090/support.mjs'),f=collectorFixture(),prior=process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION;try{const ref=path.join(f.root,'e05-cv06-selection.json'),selection={schema:'runtime-v090-acceptance-selection/v1',installedRoot:path.join(f.root,'absent'),expectedManifestDigest:'a'.repeat(64),connectionRef:path.join(f.root,'absent-connection'),workspaceId:'workspace',projectId:'project',runId:'cv06-source-only',outputRoot:path.join(f.root,'never-created'),qualification:'DEVELOPMENT',caseIds:['E05.CV06']};fs.writeFileSync(ref,JSON.stringify(selection),{mode:0o600});process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION=ref;await assert.rejects(openScenario('E05'),/CV06_NOT_READY|revisionRecovery/);assert.equal(fs.existsSync(selection.outputRoot),false);}finally{if(prior===undefined)delete process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION;else process.env.EVOPILOT_V090_ACCEPTANCE_SELECTION=prior;f.cleanup();}
});

test('actual shared CV06 decision branch accepts E05 six-key plan while preserving E16 exact four',async()=>{
 const {ownerFeedbackDecisionPlan:select}=await import('../acceptance/v090/e16.test.mjs'),original={reuse:{},deliver:{},rebound:{},qualification:{}},revision={...original,partialRecovery:{},rejection:{}};assert.deepEqual(select(revision,'E05.CV06'),revision);assert.deepEqual(select(original,'E16.CV06'),original);assert.throws(()=>select(original,'E05.CV06'));assert.throws(()=>select(revision,'E16.CV06'));assert.throws(()=>select(revision,'E05.journey'));for(const key of ['partialRecovery','rejection']){const invalid=structuredClone(revision);delete invalid[key];assert.throws(()=>select(invalid,'E05.CV06'));}
});

// Synthetic collector guards only: no protected native action is minted here.
function syntheticOwnerExpiryFixture(hash,change=()=>{}){
 const now=Date.now(),iso=n=>new Date(n).toISOString(),selection={schema:'runtime-evidence-qualification-selection/v2',scope:{workspaceId:'workspace',projectId:'project',acceptanceScopeDigest:hash('catalog')},caseId:'LC20',currentCandidateDigest:hash('current'),originalExecutionDigest:hash('original'),phase:'PRE_RELEASE'},facts={input:{original:{expiresAt:iso(now-1000)}}},planBody={schema:'runtime-qualification-assessment-plan/v2',projectId:'project',selection,protectedPlanDigest:hash(facts),registrationDigest:hash('live-registration'),requestId:'synthetic-native-request',deadlineAt:iso(now-2000),principalIds:['reader'],initiatedBy:{id:'reader',revision:1}},times={assessedAt:iso(now-3000),grantAt:iso(now-4000)};
 change({now,facts,planBody,times});planBody.protectedPlanDigest=hash(facts);const digest=hash(planBody),plan={...planBody,digest,ref:'qualification-plan:'+digest},grantBody={schema:'runtime-qualification-assessment-grant/v2',plan,reviewDigest:hash('review'),evidenceRef:'synthetic-only-not-an-approval',principalId:'reader',principalRevision:1,at:times.grantAt},grantDigest=hash(grantBody),grant={...grantBody,digest:grantDigest,ref:'qualification-authority:'+grantDigest};
 facts.assessmentAuthority={requestId:plan.requestId,authorityRef:grant.ref,authorityDigest:grant.digest,deadlineAt:plan.deadlineAt};const body={schema:'runtime-native-qualification-action/v2',selection,facts,factsDigest:hash(facts),assessedAt:times.assessedAt},action={...body,digest:hash(body)},inventory=[{seq:1,type:'qualification-plan-retained',data:{planRef:plan.ref}},{seq:2,type:'qualification-authority-granted',data:{authorityRef:grant.ref,planRef:plan.ref}},{seq:3,type:'qualification-native-action',data:{id:plan.requestId,digest:hash(action)}}];return{now,action,grant,inventory};
}
test('E05 expiry callable authenticates immutable original plan and native deadline ordering before age evaluation',async()=>{
 const {assertNativeOwnerExpiry:check}=await import('../acceptance/v090/e16.test.mjs'),{evidenceValueDigest:hash,reject}=await import('../../dist/server/errors.js'),{createNativeQualificationService}=await import('../../dist/lifecycle/evidence-qualification.js'),{createQualificationAssessmentAuthority}=await import('../../dist/adapters/authority.js');
 const f=syntheticOwnerExpiryFixture(hash),actor={id:'reader',revision:1,projects:['project'],permissions:['read'],expiresAt:new Date(Date.now()+60000).toISOString()},calls=[];
 // source-faithful currentPlan adapter boundary: registration is still live;
 // invoke actual authority.read and actual native.inspect, not a green label.
 const store={workspaceId:'workspace',object:()=>f.action},authority=createQualificationAssessmentAuthority(store,()=>actor,(_project,ref)=>{calls.push('currentPlan');assert.equal(ref,f.grant.plan.ref);if(Date.parse(f.grant.plan.deadlineAt)<=Date.now())reject('QUALIFICATION_PLAN_CHANGED','Original plan registration or deadline changed',409);return f.grant.plan;}),native=createNativeQualificationService(store,{read:async()=>{authority.read(actor,'project','lifecycle.qualification.assessment.preview',{planRef:f.grant.plan.ref});calls.push('facts-after-currentPlan');return f.action.facts;},owner:()=>{assert.fail('Owner evaluation must not run after expired plan');}});
 const result=await check(f.action,f.grant,f.inventory,hash,async ref=>{try{await native.inspect('project',ref,actor,AbortSignal.timeout(1000));assert.fail('Expired plan cannot inspect');}catch(e){return{status:e.status,body:{error:{code:e.code,message:e.message}}};}},f.now);assert.equal(result.refusalLayer,'NATIVE_CURRENT_PLAN_DEADLINE_BEFORE_EVIDENCE_AGE');assert.deepEqual(calls,['currentPlan']);
});
test('E05 expiry callable rejects generic denial, unbound grants, unexpired evidence and impossible plan timing',async()=>{
 const {assertNativeOwnerExpiry:check}=await import('../acceptance/v090/e16.test.mjs'),{evidenceValueDigest:hash}=await import('../../dist/server/errors.js'),denial=async()=>({status:409,body:{error:{code:'QUALIFICATION_PLAN_CHANGED',message:'Original plan registration or deadline changed'}}});
 for(const change of [f=>f.grant.plan.deadlineAt=new Date(f.now-500).toISOString(),f=>f.grant.ref='unbound',f=>f.inventory[1].seq=4]){const f=syntheticOwnerExpiryFixture(hash);change(f);await assert.rejects(check(f.action,f.grant,f.inventory,hash,denial,f.now));}
 for(const alter of [({now,facts})=>facts.input.original.expiresAt=new Date(now+60000).toISOString(),({now,planBody})=>planBody.deadlineAt=new Date(now-500).toISOString(),({now,times})=>times.assessedAt=new Date(now).toISOString()]){const f=syntheticOwnerExpiryFixture(hash,alter);await assert.rejects(check(f.action,f.grant,f.inventory,hash,denial,f.now));}
 for(const error of [{code:'QUALIFICATION_PLAN_CHANGED',message:'Retained plan changed'},{code:'QUALIFICATION_EXECUTION_REQUIRED',message:'ORIGINAL_EVIDENCE_EXPIRED'},{code:'FORBIDDEN',message:'No read'}]){const f=syntheticOwnerExpiryFixture(hash);await assert.rejects(check(f.action,f.grant,f.inventory,hash,async()=>({status:409,body:{error}}),f.now));}
});
test('CV03 unknown usage binds native preparation and rejects real empty wrong-version reports',async t=>{
 const {managedUsageQuery:query,assertManagedUnknownUsage:check}=await import('../acceptance/v090/execution.mjs'),{RuntimeStore}=await import('../../dist/server/store.js'),{valueDigest:vd}=await import('../../dist/lifecycle/base.js'),{digest}=await import('../../dist/server/errors.js'),{createUsageReport}=await import('../../dist/usage/reports.js'),{retainObservations}=await import('../../dist/usage/ledger.js'),{unknownMetrics,zeroMetrics}=await import('../../dist/usage/contract.js');
 const scope={workspaceId:'synthetic-usage',projectId:'alpha'},body={schema:'runtime-preparation/v1',...scope,semanticDigest:vd('semantic'),input:{definitionRevisionId:vd('definition'),goalRef:'synthetic:goal',loopRef:'synthetic:loop',verification:{requirementsDigest:vd('requirements')},target:{version:'0.9.0'}}},packet={...body,digest:vd(body)},preparation={preparationRef:'preparation:'+packet.digest,packet},pins={projectId:scope.projectId,semanticDigest:body.semanticDigest,definitionRevisionId:body.input.definitionRevisionId,goalRef:body.input.goalRef,loopRef:body.input.loopRef,requirementsDigest:body.input.verification.requirementsDigest,targetRef:preparation.preparationRef},instance={id:'instance',pins,pinsDigest:vd(pins)},selected={instanceId:instance.id,targetVersion:'0.9.0'};
 const q=query(instance,preparation,selected,scope,vd);assert.equal(q.targetVersion,'0.9.0');
 assert.throws(()=>query(instance,preparation,{...selected,targetVersion:'not-the-target'},scope,vd));
 for(const mutate of [p=>p.projectId='other',p=>p.workspaceId='other',p=>p.input.definitionRevisionId=vd('other'),p=>p.input.goalRef='other',p=>p.input.loopRef='other',p=>p.input.verification.requirementsDigest=vd('other')]){const b=structuredClone(body);mutate(b);const p={...b,digest:vd(b)};assert.throws(()=>query(instance,{preparationRef:'preparation:'+p.digest,packet:p},selected,scope,vd));}
 // Synthetic source-test inputs only; the real store/ledger/report algorithms
 // reproduce the previously passing empty-query exploit. Never case evidence.
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'cv03-usage-')),store=new RuntimeStore(root,scope.workspaceId),actor={id:'synthetic',projects:['alpha'],permissions:['read','draft.write'],revision:1,expiresAt:'2030-01-01T00:00:00Z'};t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
 const at=new Date().toISOString(),source={schema:'runtime-usage-source/v1',id:'source',projectId:'alpha',threadId:'synthetic-thread',epoch:'epoch',baseline:zeroMetrics(),baselineEvidence:'synthetic:known-zero',agentRole:'main',parentThreadId:null,principalId:actor.id,principalRevision:1,grantDigest:'0'.repeat(64),registeredAt:at,revoked:false},binding={schema:'runtime-usage-attribution/v1',id:'binding',sourceId:source.id,afterSequence:0,throughSequence:null,projectId:'alpha',targetVersion:'0.9.0',targetRef:pins.targetRef,instanceId:instance.id,instancePinsDigest:instance.pinsDigest,stageId:'implementation',baseStage:'implementation',taskId:'task',attemptId:'attempt',workType:'coding',recordedRevision:1};
 store.mutate(actor,{projectId:'alpha',operation:'synthetic.test.seed',input:{synthetic:true},requestId:'synthetic-seed',expectedRevision:0,permission:'read'},()=>({objects:[{kind:'usage-source',id:source.id,value:source},{kind:'usage-attribution',id:binding.id,value:binding}],value:{synthetic:true},event:{type:'synthetic-only',data:{}}}));
 const obs=(sequence,cumulative)=>({sequence,eventId:'event-'+sequence,observedAt:at,turnId:null,cumulative,last:unknownMetrics(),model:null,provider:null,provenanceDigest:digest({sequence,cumulative})});
 retainObservations(store,actor,source,[obs(1,unknownMetrics())],{cursor:1},()=>actor);
 const report=createUsageReport(store,'alpha',q);assert.equal(check(report,q,pins.targetRef,'alpha',vd).unknownRecords,1);
 const empty=createUsageReport(store,'alpha',{...q,targetVersion:'not-the-target'});assert.equal(empty.records,0);assert.equal(empty.counts.total.recorded,null);assert.throws(()=>check(empty,q,pins.targetRef,'alpha',vd));assert.throws(()=>check(empty,{...q,targetVersion:'not-the-target'},pins.targetRef,'alpha',vd));
 retainObservations(store,actor,source,[obs(2,{input:10,output:2,total:12,cachedInput:0,cacheWriteInput:0,reasoningOutput:0})],{cursor:2},()=>actor);
 const known=createUsageReport(store,'alpha',q);assert.equal(known.counts.total.recorded,12);assert.throws(()=>check(known,q,pins.targetRef,'alpha',vd));
});


// Explicit synthetic source guards; not original provider CI/credential evidence.
test('E18 fork selection requires original native upstream and fork jobs without caller outcomes',async()=>{
 const {validateForkCredentialSelection:check,assertForkLineage:lineage}=await import('../acceptance/v090/e18.test.mjs'),p={stageRequestId:'fork-original',runId:'2',jobId:'22',credentialName:'TEST_PROTECTED_CREDENTIAL',upstream:{stageRequestId:'parent-original',runId:'1',jobId:'11'}};assert.deepEqual(check(p),p);
 for(const change of [v=>v.available=false,v=>delete v.upstream,v=>v.jobId='0',v=>v.credentialName='GITHUB_TOKEN',v=>v.upstream.runId='caller-PASS']){const b=structuredClone(p);change(b);assert.throws(()=>check(b));}assert.throws(()=>check(null),/E18_FORK_CREDENTIAL_NOT_READY/);
 for(const provider of ['github','gitlab']){const fork=provider==='github'?{id:2,fork:true,parent:{id:1}}:{id:2,forked_from_project:{id:1}};assert.deepEqual(lineage(provider,{id:1},fork,'1','2'),{provider,upstreamId:'1',forkId:'2'});assert.throws(()=>lineage(provider,{id:1},{...fork,id:3},'1','2'));assert.throws(()=>lineage(provider,{id:1},fork,'2','2'));assert.throws(()=>lineage(provider,{id:1},provider==='github'?{...fork,parent:{id:9}}:{...fork,forked_from_project:{id:9}},'1','2'));}
});
test('E18 exact fixed probe really measures absent and present env without recording secret values',async()=>{
 const {forkCredentialProbeScript:script,assertForkCredentialMeasurement:check}=await import('../acceptance/v090/e18.test.mjs'),{spawnSync}=await import('node:child_process'),base={provider:'github',repositoryId:'2',runId:'3',request:{requestId:'native-original',inputDigest:'input',commit:'source',workflowDigest:'workflow'},credentialName:'TEST_PROTECTED_CREDENTIAL'};
 for(const state of ['ABSENT','PRESENT']){const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'e18-probe-synthetic-'));try{const env={PATH:path.dirname(process.execPath),PROBE_PROVIDER:base.provider,PROBE_REPOSITORY_ID:base.repositoryId,PROBE_RUN_ID:base.runId,runtime_request_id:base.request.requestId,runtime_input_digest:base.request.inputDigest,runtime_source_commit:base.request.commit,runtime_workflow_digest:base.request.workflowDigest,...(state==='PRESENT'?{TEST_PROTECTED_CREDENTIAL:'explicit-synthetic-secret-value'}:{})},result=spawnSync('/bin/bash',['-c',script(base.credentialName)],{cwd:root,env,timeout:5000,maxBuffer:8192});assert.equal(result.status,state==='ABSENT'?78:0);assert.equal(result.error,undefined);const files=new Map(['fork-credential-probe.json','fork-credential-probe.stdout','fork-credential-probe.stderr'].map(n=>[n,fs.readFileSync(path.join(root,n))]));assert.equal(check(files,{...base,state}).credentialState,state);for(const bytes of files.values())assert(!bytes.includes(Buffer.from('explicit-synthetic-secret-value')));
 for(const changed of [{...base,state,runId:'other'},{...base,state,request:{...base.request,inputDigest:'other'}},{...base,state:state==='PRESENT'?'ABSENT':'PRESENT'}])assert.throws(()=>check(files,changed));const extra=new Map(files);extra.set('token.txt',Buffer.from('synthetic'));assert.throws(()=>check(extra,{...base,state}));
 }finally{fs.rmSync(root,{recursive:true,force:true});}}
});
test('E18 real Actions lifecycle and exact probe failure cannot be replaced by arbitrary red jobs',async()=>{
 const {assertForkProbeJobObservation:check,FORK_PROBE_JOB}=await import('../acceptance/v090/e18.test.mjs'),job={name:FORK_PROBE_JOB,run_attempt:1,conclusion:'failure',steps:['Set up job','Measure protected credential','Upload credential measurement','Post Upload credential measurement','Complete job'].map((name,i)=>({name,number:i+1,status:'completed',conclusion:name==='Measure protected credential'?'failure':'success'}))};assert.equal(check('github',job,'ABSENT'),job);
 for(const change of [v=>v.steps.splice(0,1),v=>v.steps[1].conclusion='success',v=>v.steps[2].conclusion='failure',v=>v.steps[3].name='Run arbitrary business',v=>v.steps.splice(1,0,{...v.steps[1]}),v=>v.run_attempt=2]){const b=structuredClone(job);change(b);assert.throws(()=>check('github',b,'ABSENT'));}
 const gl={name:FORK_PROBE_JOB,status:'failed',failure_reason:'script_failure',allow_failure:false};assert.equal(check('gitlab',gl,'ABSENT'),gl);for(const b of [{...gl,failure_reason:'runner_system_failure'},{...gl,allow_failure:true},{...gl,status:'skipped'}])assert.throws(()=>check('gitlab',b,'ABSENT'));
});
test('E18 versioned producer requires fixed env-presence source and forbids credential override or caller PASS',async()=>{
 const {assertForkProbeJob:check,forkCredentialProbeScript:script,FORK_PROBE_JOB:key}=await import('../acceptance/v090/e18.test.mjs'),name='TEST_PROTECTED_CREDENTIAL',job={name:key,'runs-on':'ubuntu-latest',permissions:{},env:{PROBE_PROVIDER:'github',PROBE_REPOSITORY_ID:'${{ github.repository_id }}',PROBE_RUN_ID:'${{ github.run_id }}',runtime_request_id:'${{ inputs.runtime_request_id }}',runtime_input_digest:'${{ inputs.runtime_input_digest }}',runtime_source_commit:'${{ inputs.runtime_source_commit }}',runtime_workflow_digest:'${{ inputs.runtime_workflow_digest }}',[name]:'${{ secrets.'+name+' }}'},steps:[{name:'Measure protected credential',shell:'bash',run:script(name)},{name:'Upload credential measurement',if:'always()',uses:'actions/upload-artifact@'+'a'.repeat(40),with:{name:key,path:'fork-credential-probe.json\nfork-credential-probe.stderr\nfork-credential-probe.stdout','if-no-files-found':'error'}}]},document={jobs:{[key]:job}};assert.equal(check('github',document,{runner:'ubuntu-latest'},name),job);
 for(const change of [v=>v.steps[0].run='echo PASS',v=>v.env[name]='',v=>v.steps[0].env={[name]:''},v=>v.steps[1].if='success()',v=>v.steps[1].uses='actions/upload-artifact@main']){const b=structuredClone(document);change(b.jobs[key]);assert.throws(()=>check('github',b,{runner:'ubuntu-latest'},name));}
 for(const injected of [{env:{NODE_OPTIONS:'--import=data:text/javascript,process.env.TEST_PROTECTED_CREDENTIAL=String(1)'}},{defaults:{run:{shell:'bash'}}}])assert.throws(()=>check('github',{...document,...injected},{runner:'ubuntu-latest'},name));
 const gl={stage:'test',image:'node:24.14.0@sha256:'+'b'.repeat(64),inherit:{default:false,variables:false},before_script:[],after_script:[],script:[`PROBE_PROVIDER=gitlab PROBE_REPOSITORY_ID="$CI_PROJECT_ID" PROBE_RUN_ID="$CI_PIPELINE_ID" ${script(name)}`],artifacts:{when:'always',paths:['fork-credential-probe.json','fork-credential-probe.stderr','fork-credential-probe.stdout']},allow_failure:false};assert.equal(check('gitlab',{[key]:gl},{},name),gl);assert.throws(()=>check('gitlab',{[key]:gl,include:[{local:'override-job.yml',inputs:{[key]:{script:['echo forged measurement']}}}]},{},name));for(const change of [v=>v.variables={[name]:''},v=>v.script=['echo PASS'],v=>v.allow_failure=true,v=>v.before_script=['unset '+name]]){const b=structuredClone(gl);change(b);assert.throws(()=>check('gitlab',{[key]:b},{},name));}
});
test('E18 original GitLab artifact availability uses actual file metadata rather than expiry alone',async()=>{
 const {assertForkGitLabArtifact:check}=await import('../acceptance/v090/e18.test.mjs');for(const expires of ['2000-01-01T00:00:00Z','2099-01-01T00:00:00Z',null]){const value={artifacts_expire_at:expires,artifacts_file:{filename:'artifacts.zip',size:1024}};assert.equal(check(value),value);}
 for(const value of [{},{artifacts_file:{filename:'other.zip',size:1024}},...[0,1.5,1048577].map(size=>({artifacts_file:{filename:'artifacts.zip',size}}))])assert.throws(()=>check(value));
});

// E13 guard records are synthetic unit inputs only. No app-server/model,
// provider, service or owner is started by these checks.
test('E13 continuous selection rejects invented outcomes and replacement identities',async()=>{
 const {validateE13JourneyPlan:check}=await import('../acceptance/v090/e13.test.mjs'),pin={ref:'/synthetic-only/current-codex.mjs',sha256:'a'.repeat(64)},plan={instanceId:'original',extraLoopInstanceId:'inert',allowServiceRestart:true,faultPlan:pin,providerBindingRef:'provider',hostExchangeRoot:'/synthetic-only/fresh',codingDriver:pin,codingInstructions:pin,reviewerId:'independent',executionSecondsRemaining:180,creationRequestIds:{main:'created-main',extra:'created-extra'},preparationRequestIds:{scope:'prepared-scope',plan:'prepared-plan'}};assert.equal(check(plan),plan);
 for(const change of [v=>v.status='PASS',v=>v.allowServiceRestart=false,v=>v.extraLoopInstanceId=v.instanceId,v=>v.executionSecondsRemaining=601,v=>v.executionSecondsRemaining=179,v=>v.codingDriver={...pin,ref:'/synthetic-only/fake-host.mjs'},v=>v.faultPlan={...pin,sha256:'old'},v=>v.hostExchangeRoot='relative',v=>v.reviewDecision='APPROVE']){const bad=structuredClone(plan);change(bad);assert.throws(()=>check(bad));}
});
test('E13 native app-server command and file records cannot be substituted by Desktop wrappers or caller PASS',async()=>{
 const {assertE13AppServerItem:check}=await import('../acceptance/v090/execution.mjs'),policy={cwd:'/synthetic-only/workspace',commands:['exact original command'],editPaths:[]},item={type:'commandExecution',id:'native-item',cwd:policy.cwd,command:policy.commands[0],source:'agent',pluginId:null,scriptPath:null,commandActions:[],status:'completed',exitCode:0,aggregatedOutput:'original native output',durationMs:1};assert.equal(check(item,policy,true),item);
 for(const change of [v=>v.type='custom_tool_call',v=>v.source='userShell',v=>v.cwd='/foreign',v=>v.command='echo PASS',v=>v.status='inProgress',v=>v.exitCode=null,v=>v.aggregatedOutput=null,v=>v.durationMs=-1,v=>v.pluginId='unexpected']){const bad=structuredClone(item);change(bad);assert.throws(()=>check(bad,policy,true));}
 const editPolicy={cwd:policy.cwd,commands:[],editPaths:[policy.cwd+'/summary.sh',policy.cwd+'/summary.test.sh']},edit={type:'fileChange',id:'native-patch',status:'completed',changes:[{path:editPolicy.editPaths[0],kind:{type:'update',move_path:null},diff:'actual original patch'}]};assert.equal(check(edit,editPolicy,true),edit);for(const change of [v=>v.changes[0].path='/credential',v=>v.changes[0].kind={type:'delete'},v=>v.changes[0].kind.move_path='/foreign',v=>v.status='failed',v=>v.changes=[]]){const bad=structuredClone(edit);change(bad);assert.throws(()=>check(bad,editPolicy,true));}
});
test('E13 Host approvals are one exact phase and cannot extend permissions or another session',async()=>{
 const {e13HostApproval:approve}=await import('../acceptance/v090/execution.mjs'),policy={cwd:'/synthetic-only/workspace',commands:['exact'],editPaths:[]},state={active:true,closing:false,deadline:Date.now()+10000,threadId:'thread',turnId:'turn',policy,started:new Map()},message={method:'item/commandExecution/requestApproval',params:{kind:'command',threadId:'thread',turnId:'turn',itemId:'item',command:'exact',cwd:policy.cwd}};assert.equal(approve(message,state),true);
 for(const change of [v=>v.params.command='exact; extra',v=>v.params.kind='writeStdin',v=>v.params.turnId='other',v=>v.params.threadId='other',v=>v.params.proposedExecpolicyAmendment=['allow-all'],v=>v.params.additionalPermissions={network:{enabled:true}},v=>v.params.networkApprovalContext={host:'foreign'},v=>v.method='mcpServer/elicitation/request']){const bad=structuredClone(message);change(bad);assert.equal(approve(bad,state),false);}for(const changed of [{...state,active:false},{...state,closing:true},{...state,deadline:0}])assert.equal(approve(message,changed),false);
 const edit={type:'fileChange',id:'patch',status:'inProgress',changes:[{path:policy.cwd+'/summary.sh',kind:{type:'add'},diff:'actual'}]},patch={method:'item/fileChange/requestApproval',params:{threadId:'thread',turnId:'turn',itemId:'patch'}},editing={...state,policy:{...policy,commands:[],editPaths:[edit.changes[0].path]},started:new Map([['patch',edit]])};assert.equal(approve(patch,editing),true);assert.equal(approve({...patch,params:{...patch.params,grantRoot:policy.cwd}},editing),false);assert.equal(approve(patch,{...editing,started:new Map()}),false);
});
function e13SyntheticCodingChain(){
 const identity={threadId:'owned-thread',version:'0.167.0-alpha.3.2',model:'synthetic-model',provider:'synthetic-provider'},handoff={stageRequestId:'original',digest:'handoff',agent:{version:identity.version,hostId:'registered-host'},workspaceRoot:'/synthetic-only/workspace',preparation:{synthetic:true},deadlineAt:new Date(200).toISOString()},claim={digest:'claim',handoffDigest:'handoff',host:{...identity,sessionId:identity.threadId,hostId:'registered-host'},claimedAt:new Date(25).toISOString()},report={digest:'report',claimDigest:'claim',state:'SUBMITTED',late:false,independentlyVerified:false,receivedAt:new Date(105).toISOString(),result:{commit:'commit',change:{id:'original-change'},artifacts:[{path:'runtime-chain-probe/summary.sh',digest:'synthetic'}]}};
 const phases=['inspect','claim','edit','validation','propose','submit'],turns=phases.map((label,i)=>{let items;if(label==='edit')items=[{type:'fileChange',changes:['summary.sh','summary.test.sh'].map(p=>({path:handoff.workspaceRoot+'/runtime-chain-probe/'+p}))}];else{const output={phase:label,stageRequestId:'original',handoffDigest:'handoff',...(label==='inspect'?{taskDigest:'task'}:{claimDigest:'claim'}),...(['propose','submit'].includes(label)?{commit:'commit',change:report.result.change}:{}),...(label==='propose'?{artifacts:report.result.artifacts}:{}),...(label==='submit'?{reportDigest:'report'}:{})};items=[{type:'commandExecution',status:'completed',exitCode:0,aggregatedOutput:label==='validation'?'checks=7 passed=7 failed=0\n':JSON.stringify(output)+'\n'}];}return{label,threadId:identity.threadId,status:'completed',model:identity.model,provider:identity.provider,startedAt:i*20,completedAt:i*20+10,items};});return{identity,handoff,claim,report,turns};
}
test('E13 real coding chain requires exact native claim/report times and original session/model/source result',async()=>{
 const {assertE13CodingChain:check}=await import('../acceptance/v090/execution.mjs'),f=e13SyntheticCodingChain(),run=v=>check(v.turns,v.handoff,v.claim,v.report,v.identity,()=> 'task');assert.equal(run(f).sourceFormat,'APP_SERVER_THREAD_ITEM');
 for(const change of [v=>v.claim.host.sessionId='desktop-parent',v=>v.claim.claimedAt=new Date(90).toISOString(),v=>v.report.receivedAt=new Date(150).toISOString(),v=>v.report.late=true,v=>v.report.result.commit='replacement',v=>v.identity.version='0.166.0-alpha.5.1',v=>v.turns[2].items.pop(),v=>v.turns[3].items[0].aggregatedOutput='PASS',v=>v.turns[1].provider='different',v=>v.turns.reverse(),v=>v.turns[0].items.push(v.turns[0].items[0])]){const bad=structuredClone(f);change(bad);assert.throws(()=>run(bad));}
});
test('E13 independent source review must be an actual exact native receipt after this submitted report',async()=>{
 const {assertE13ExistingSourceReview:check,assertE13OriginalDerivation:derive}=await import('../acceptance/v090/e13.test.mjs'),request={id:'original',digest:'request',pinsDigest:'pins',workspaceId:'workspace',projectId:'project',instanceId:'instance',inputDigest:'input',authorityRef:'existing',requestedAt:'2026-01-01T00:00:00Z',deadlineAt:'2026-01-01T00:10:00Z',initiatedBy:{id:'coding'}},report={digest:'report',receivedAt:'2026-01-01T00:01:00Z',result:{commit:'original-commit'}},decision={choice:'APPROVE',ref:'native-review',reviewDigest:'review-digest',review:{stageRequestId:request.id,requestDigest:request.digest,pinsDigest:request.pinsDigest,agentReportDigest:report.digest,reviewerId:'independent'},source:{factsDigest:'actual-source'},at:'2026-01-01T00:02:00Z'},selection={schema:'runtime-e13-existing-source-review/v1',caseInstanceId:'E13.journey',runId:'fresh',candidateDigest:'candidate',stageRequestId:request.id,reportDigest:report.digest,reviewRef:decision.ref,requestId:'native-review-receipt'},view={usable:true,revocation:null,executionAuthorized:false,releaseAuthorized:false,decision},receipt={operation:'lifecycle.implementation.review.record',requestId:selection.requestId,principalId:'independent',result:{reviewRef:decision.ref,stageRequestId:request.id,reviewDigest:decision.reviewDigest,decision:'APPROVE'}},context={request,report,reviewerId:'independent',principalId:'coding',candidateDigest:'candidate',selection};assert.equal(check(view,receipt,context),decision);
 for(const change of [v=>v.usable=false,v=>v.revocation={},v=>v.decision.review.reviewerId='coding',v=>v.decision.review.agentReportDigest='old-report',v=>v.decision.at='2025-01-01T00:00:00Z',v=>v.decision.ref='substitute',v=>v.releaseAuthorized=true]){const bad=structuredClone(view);change(bad);assert.throws(()=>check(bad,receipt,context));}assert.throws(()=>check(view,{...receipt,principalId:'coding'},context));
 const derivation={parentRequestId:request.id,parentRequestDigest:request.digest,agentReportDigest:report.digest,sourceReviewRef:decision.ref,sourceReviewDigest:decision.reviewDigest,sourceFactsDigest:decision.source.factsDigest,request:{...request,plan:{parameters:{commit:report.result.commit,source:{evidenceRef:decision.ref}}}}};assert.equal(derive(derivation,request,report,decision),derivation);for(const key of ['instanceId','authorityRef','deadlineAt','requestedAt','inputDigest','pinsDigest']){const bad=structuredClone(derivation);bad.request[key]='replacement';assert.throws(()=>derive(bad,request,report,decision));}
});
test('E13 original native inspection waits for actual worker drain and refuses degraded evidence',async()=>{
 const {e13Drain:drain}=await import('../acceptance/v090/e13.test.mjs');let reads=0,artifact;const run={read:async operation=>{assert.equal(operation,'runtime.status');return{observationWorker:{state:'READY',error:null,inFlight:reads++===0?1:0,automaticRedispatch:false}};},artifact:(name,value)=>{artifact=value;}};await drain(run,Date.now()+5000,'synthetic-only');assert.equal(reads,2);assert.equal(artifact.drained,true);assert.deepEqual(artifact.samples.map(s=>s.worker.inFlight),[1,0]);await assert.rejects(drain({...run,read:async()=>({observationWorker:{state:'DEGRADED',error:'native-failure',inFlight:0,automaticRedispatch:false}})},Date.now()+5000,'synthetic-only'),/degraded/);
});
test('E13 bidirectional RPC approval ids cannot collide with pending client response ids',async()=>{
 const {e13RpcKind:kind,e13HostApproval:approve,projectE13HostFrame:project,assertE13FixedHostModel:fixedModel}=await import('../acceptance/v090/execution.mjs'),pending=new Map([[1,{label:'pending-client'}]]),message={id:1,method:'item/commandExecution/requestApproval',params:{kind:'command',threadId:'thread',turnId:'turn',command:'exact',cwd:'/synthetic-only'}};
 assert.equal(kind(message,pending),'server-request');assert.equal(pending.size,1);const rerouted={method:'model/rerouted',params:{threadId:'thread',turnId:'turn',fromModel:'original',toModel:'other'}};assert.deepEqual(project(rerouted).message,rerouted);assert.throws(()=>fixedModel(rerouted),/model rerouted/);assert.doesNotThrow(()=>fixedModel({method:'turn/completed'}));assert.equal(approve(message,{active:true,closing:false,deadline:Date.now()+10000,threadId:'thread',turnId:'turn',policy:{commands:['exact'],cwd:'/synthetic-only'},started:new Map()}),true);assert.equal(kind({id:1,result:{original:true}},pending),'response');assert.equal(kind({method:'turn/completed',params:{}},pending),'notification');
 for(const bad of [{id:2,result:{}},{id:1},{id:1,result:{},error:{code:1,message:'bad'}},{id:1,method:message.method,result:{}},{id:1,error:null}])assert.throws(()=>kind(bad,pending));
 const raw={method:'turn/completed',params:{turn:{id:'turn',items:[{id:'private',type:'reasoning',summary:['private reasoning']},{id:'tool',type:'commandExecution',command:'exact',aggregatedOutput:'original bytes'}]}}},safe=project(raw);assert.equal(safe.reasoningItemsOmitted,1);assert.equal(JSON.stringify(safe).includes('private reasoning'),false);assert.deepEqual(safe.message.params.turn.items,[raw.params.turn.items[1]]);assert.equal(raw.params.turn.items.length,2);for(const method of ['item/reasoning/textDelta','item/reasoning/summaryTextDelta','item/reasoning/summaryPartAdded','rawResponseItem/completed','unrequested/privateEvent']){const omitted=project({method,params:{delta:'private reasoning',item:{type:'private',text:'private reasoning'}}});assert.equal(omitted.notificationPayloadOmitted,true);assert.equal(JSON.stringify(omitted).includes('private reasoning'),false);assert.deepEqual(omitted.message,{method});}
});
test('E13 failed owned process cleanup terminates the actual detached group and retained descendants',async()=>{
 const {trackE13OwnedProcess:track,stopE13OwnedProcess:stop}=await import('../acceptance/v090/execution.mjs'),{spawn}=await import('node:child_process'),{once}=await import('node:events');
 // A real synthetic Node parent/child tests OS cleanup, never an actual Host,
 // model, provider, Runtime service, fixture producer or business operation.
 const child=spawn(process.execPath,['-e',"const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000);"],{detached:true,stdio:['pipe','pipe','pipe']}),exited=once(child,'exit').then(([code,signal])=>({code,signal}));let tracker;
 try{const [output]=await once(child.stdout,'data'),descendant=Number(output.toString().trim());assert(descendant>1);tracker=track(child);const before=tracker.sample();assert(before.some(p=>p.pid===child.pid&&p.pgid===child.pid));assert(before.some(p=>p.pid===descendant&&p.pgid===child.pid));const closed=await stop(child,tracker,exited);assert.equal(closed.groupEmpty,true);assert.equal(closed.descendantsStopped,true);assert.deepEqual(tracker.sample(),[]);assert.notEqual(closed.exit,null);}finally{if(!tracker)tracker=track(child);if(tracker.sample().length)await stop(child,tracker,exited);}
});
test('E13 independent approval receipt uses the protected reviewer principal and native receipt isolation',async t=>{
 const {RuntimeStore}=await import('../../dist/server/store.js'),{readE13SourceReviewReceipt:read}=await import('../acceptance/v090/e13.test.mjs'),root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'e13-review-receipt-')),store=new RuntimeStore(root,'synthetic-workspace'),common={projects:['alpha'],permissions:['read','decision.record'],revision:1,expiresAt:'2030-01-01T00:00:00Z'},reviewer={...common,id:'independent'},coding={...common,id:'coding'};t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
 const original=store.mutate(reviewer,{projectId:'alpha',operation:'lifecycle.implementation.review.record',requestId:'synthetic-review-only',expectedRevision:0,input:{syntheticSourceGuard:true},permission:'decision.record'},()=>({objects:[],value:{reviewRef:'synthetic-only',stageRequestId:'original',decision:'APPROVE'},event:{type:'synthetic-only',data:{}}}));assert.throws(()=>store.receipt(coding,'alpha',original.requestId),e=>e.code==='NOT_FOUND');let calls=0;const run={selection:{projectId:'alpha'},principal:alias=>({principalId:alias==='source-reviewer'?reviewer.id:coding.id,projectId:'alpha'}),principalRequest:async(alias,operation,input)=>{calls++;assert.equal(alias,'source-reviewer');assert.equal(operation,'runtime.receipt.read');return{status:200,body:{result:store.receipt(reviewer,'alpha',input.requestId)}};}};assert.deepEqual(await read(run,reviewer.id,original.requestId),original);assert.equal(calls,1);await assert.rejects(read(run,coding.id,original.requestId));assert.equal(calls,1);
});

// Synthetic source guards only: no provider, installed service or actual case credit.
test('LC06 LC07 singleton selectors preserve exact source/candidate and fixed recovery modes',async()=>{
 const {validateLcProviderSelection:check,LC_PROVIDER_VECTORS:vectors}=await import('../acceptance/v090/correction.test.mjs');assert.deepEqual(vectors,{LC06:['accepted-response-lost','same-job-reconciled'],LC07:['stale-revision','exact-restoration']});
 const pin={ref:'/synthetic-only/original.json',sha256:'a'.repeat(64)};
 for(const caseId of ['LC06','LC07']){const selection={caseIds:[caseId],sourceCommit:'b'.repeat(40),expectedManifestDigest:'c'.repeat(64),phase:'PRE_RELEASE'},value={schema:'runtime-lc-provider-selection/v1',caseId,mode:caseId==='LC06'?'ORIGINAL_FAULT':'ORIGINAL_ACTIVATION',sourceCommit:selection.sourceCommit,candidateDigest:'sha256:'+selection.expectedManifestDigest,workspaceId:'workspace',projectId:'project',serviceId:'service',connection:pin,original:pin,deadlineAt:'2030-01-01T00:00:00Z',maxNativeCalls:200,maxProviderCalls:200,[caseId==='LC06'?'fault':'definition']:pin};assert.equal(check(value,selection),value);
  for(const change of [v=>v.status='PASS',v=>v.sourceCommit='d'.repeat(40),v=>v.candidateDigest='sha256:'+'d'.repeat(64),v=>v.mode='FRESH_DISPATCH',v=>v.operation='lifecycle.stage.advance',v=>v.maxNativeCalls=301,v=>v.maxProviderCalls=0,v=>v.original.sha256='old',v=>v.connection.ref='relative',v=>v.deadlineAt='unknown']){const bad=structuredClone(value);change(bad);assert.throws(()=>check(bad,selection));}assert.throws(()=>check(value,{...selection,caseIds:['LC06','LC07']}));
 }
});
test('LC06 same job composite rejects replacement jobs reruns partial pages and active worker',async()=>{
 const {assertLcProviderJobs:jobs,assertLcProviderDrained:drained}=await import('../acceptance/v090/correction.test.mjs'),original={complete:true,runId:'1',attempt:1,jobs:[{id:'10',attempt:1}],all:[{id:'1',attempt:1}]};assert.equal(jobs(original,structuredClone(original)),true);
 for(const change of [v=>v.complete=false,v=>v.runId='2',v=>v.attempt=2,v=>v.jobs[0].id='11',v=>v.jobs[0].attempt=2,v=>v.jobs=[],v=>v.all.push({id:'2',attempt:1})]){const bad=structuredClone(original);change(bad);assert.throws(()=>jobs(original,bad));}
 const status={observationWorker:{state:'READY',error:null,inFlight:0,automaticRedispatch:false}};assert(drained(status));for(const patch of [{state:'DEGRADED'},{error:'failed'},{inFlight:1},{automaticRedispatch:true}])assert.throws(()=>drained({observationWorker:{...status.observationWorker,...patch}}));
});
test('LC07 exact restoration requires full original rereads and stable binding preview',async()=>{
 const {assertLcProviderRestoration:check}=await import('../acceptance/v090/correction.test.mjs'),before={request:{id:'original',authorityRef:'original-authority',deadlineAt:'original-deadline',inputDigest:'ci-input'},derivation:{request:{id:'child'}},handoff:{report:'submitted',preparation:'original'},review:{decision:'existing-reviewed'},receipts:[{principalId:'original'}],instanceIdentity:{attempts:1,loopBudget:{consumed:1}},definition:{id:'reviewed'},source:'original YAML',principal:{id:'original',revision:1},preview:{ready:true,validationDigest:'preview',compilation:{sourceDigest:'source',semanticDigest:'semantic'},bindings:{stamp:'stable'}}};check(before,structuredClone(before));
 for(const key of ['request','derivation','handoff','review','receipts','instanceIdentity','definition','source','principal']){const after=structuredClone(before);delete after[key];assert.throws(()=>check(before,after));}
 for(const change of [v=>v.request.authorityRef='new',v=>v.request.deadlineAt='extended',v=>v.request.inputDigest='changed',v=>v.source='new YAML',v=>v.preview.validationDigest='new',v=>v.preview.bindings.stamp='new',v=>v.preview.ready=false,v=>v.preview.compilation.sourceDigest='new',v=>v.principal.revision=2]){const after=structuredClone(before);change(after);assert.throws(()=>check(before,after));}
});
test('LC07 actual store CAS refusal has no receipt/effect and original actor isolation survives',async t=>{
 const {RuntimeStore}=await import('../../dist/server/store.js'),{assertLcProviderCas:check}=await import('../acceptance/v090/correction.test.mjs'),root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'lc07-cas-')),store=new RuntimeStore(root,'synthetic-workspace'),principal={id:'original',projects:['alpha'],permissions:['read','definition.activate'],revision:1,expiresAt:'2030-01-01T00:00:00Z'},input={revisionId:'original-reviewed',validationDigest:'original-preview'},request={projectId:'alpha',operation:'lifecycle.definition.activate',requestId:'lc07-synthetic',expectedRevision:0,input,permission:'definition.activate'};t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
 store.mutate(principal,{...request,requestId:'synthetic-async',operation:'synthetic-source-guard'},()=>({objects:[],value:{synthetic:true},event:{type:'synthetic-only',data:{}}}));let calls=0;assert.throws(()=>store.mutate(principal,request,()=>{calls++;throw Error('must not execute');}),e=>e.code==='REVISION_CONFLICT');assert.equal(calls,0);assert.equal(store.revision('alpha'),1);assert.equal(store.findReceipt(principal,'alpha',request.requestId),null);check({status:409,body:{error:{code:'REVISION_CONFLICT'}}},{status:404,body:{error:{code:'NOT_FOUND'}}});
 for(const reply of [{status:0,body:{}},{status:409,body:{error:{code:'EXECUTOR_BUSY'}}},{status:200,body:{result:{status:'BLOCKED'}}}])assert.throws(()=>check(reply,{status:404,body:{error:{code:'NOT_FOUND'}}}));
 const actual=store.mutate(principal,{...request,expectedRevision:1},()=>({objects:[],value:{status:'ACTIVE'},event:{type:'synthetic-restoration-only',data:{}}}));assert.equal(actual.requestId,request.requestId);assert.equal(store.findReceipt({...principal,id:'wrong'},'alpha',request.requestId),null);assert.deepEqual(store.receipt(principal,'alpha',request.requestId),actual);assert.throws(()=>check({status:409,body:{error:{code:'REVISION_CONFLICT'}}},{status:200,body:{result:actual}}));
});
function lc06SyntheticFault(){
 const request={id:'original',instanceId:'instance',deadlineAt:'2030-01-01T00:00:00Z'},config={candidateDigest:'current-candidate',serviceId:'service',projectId:'project'},source={ref:'/synthetic-only/platforms.js',sha256:'source-digest',boundary:'GITHUB_DISPATCH_HEADERS_BEFORE_BODY'},binding={repositoryId:'1',repository:'owner/repo',workflowPath:'.github/workflows/test.yml'},ci={runtime_request_id:'original-child'},sourceRef='evopilot-runtime/original-child',common={caseInstanceId:'LC06',candidateDigest:config.candidateDigest,serviceId:config.serviceId},safeLocals={repositoryId:'1',repository:binding.repository,workflowPath:binding.workflowPath,suffix:'/actions/workflows/test.yml/dispatches',response:{ok:true,status:200,bodyUsed:false,hasBody:true,url:'https://api.github.com/repos/owner/repo/actions/workflows/test.yml/dispatches'},payload:{ref:sourceRef,inputs:ci,return_run_details:true}},pause={...common,pid:123,processIdentity:'owned-start-time',originalRequest:request,source,at:'2029-01-01T00:00:01Z',lineNumber:100,safeLocals,workerWitness:{at:'2029-01-01T00:00:00Z',status:{revision:1,observationWorker:{inFlight:1,automaticRedispatch:false}},original:{request},pending:[{instanceId:'instance',stageId:'implementation'}],inventory:{projectId:'project',revision:1,instances:[{id:'instance',stages:{implementation:{status:'RUNNING',requestId:'original'}}}]},projectPages:[{projectId:'project'}]}},chain={restored:{...common,instanceId:'instance',stageId:'implementation',newOwnerWrites:0,newProviderDispatches:0},fault:{...common,signal:'SIGKILL',businessRollbackClaim:false,originalStageRequestId:'original',pid:123,processIdentity:'owned-start-time',at:'2029-01-01T00:00:02Z'},pause,protocol:{pid:123,processIdentity:'owned-start-time',serviceId:'service',source,events:[{direction:'request',method:'Debugger.evaluateOnCallFrame',id:1},{direction:'response',id:1,result:{result:{value:JSON.stringify(safeLocals)}}},{direction:'event',method:'Debugger.paused',topFrame:{location:{lineNumber:100}}}]},stopped:{operation:'stop',service:{running:false}},started:{operation:'start',service:{running:true,identity:{serviceId:'service'}},hostRegistered:false}};return{chain,context:{config,request,source,ci,binding,sourceRef,runTitle:'original-title'}};
}
test('LC06 raw fault chain rejects other case old candidate changed PID source payload and fake successful headers',async()=>{
 const {assertLc06Fault:check}=await import('../acceptance/v090/correction.test.mjs'),f=lc06SyntheticFault();assert(check(f.chain,f.context));
 for(const change of [v=>v.chain.fault.caseInstanceId='E13.variant.04',v=>v.chain.pause.candidateDigest='old-candidate',v=>v.chain.fault.pid=456,v=>v.chain.protocol.processIdentity='changed',v=>v.chain.pause.originalRequest.id='replacement',v=>v.chain.pause.source.sha256='changed',v=>v.chain.pause.safeLocals.response.status=204,v=>v.chain.pause.safeLocals.response.ok=false,v=>v.chain.pause.safeLocals.response.bodyUsed=true,v=>v.chain.pause.safeLocals.response.hasBody=false,v=>v.chain.pause.safeLocals.payload.inputs.runtime_request_id='other',v=>v.chain.started.hostRegistered=true,v=>v.chain.pause.workerWitness.status.observationWorker.inFlight=0,v=>v.chain.protocol.events=[]]){const bad={chain:structuredClone(f.chain),context:structuredClone(f.context)};change(bad);assert.throws(()=>check(bad.chain,bad.context));}
});
test('LC06 LC07 real pinInstance projection survives protected JSON roundtrip',async()=>{
 const {lcProviderInstanceIdentity:project}=await import('../acceptance/v090/correction.test.mjs'),{pinInstance,requiredChecksDigest}=await import('../../dist/lifecycle/instance.js'),{compileLifecycle}=await import('../../dist/lifecycle/compiler.js'),{valueDigest}=await import('../../dist/lifecycle/base.js'),{lifecycle,yaml}=await import('../fixtures/lifecycle-v090.mjs');
 const d=lifecycle();for(const stage of ['plan','verification'])d.config[stage].budget={timeoutSeconds:600,maxAttempts:2,maxConcurrency:2,maxLoops:1};const definition=compileLifecycle(yaml(d),'alpha').effective,revisionId=valueDigest({synthetic:true,source:yaml(d)}),now=Date.now(),authority={projectId:'alpha',instanceId:'lc-original',definitionRevisionId:revisionId,semanticDigest:definition.semanticDigest,goalRef:'synthetic:goal/one',targetRef:'synthetic:target/one',loopRef:'synthetic:loop/one',requirementsDigest:requiredChecksDigest(definition),budget:{timeoutSeconds:600,maxAttempts:2,maxConcurrency:2,maxLoops:1},evidenceRef:'synthetic:authority/one',revision:'1',expiresAt:new Date(now+3600000).toISOString()},instance=pinInstance('lc-original',revisionId,definition,authority,now),identity=project(instance);
 assert.equal(instance.definitionRevisionId,undefined);assert.equal(identity.definitionRevisionId,revisionId);assert.deepEqual(JSON.parse(JSON.stringify(identity)),identity);assert.deepEqual(project(JSON.parse(JSON.stringify(instance))),identity);assert.deepEqual(Object.keys(identity.stages),Object.keys(instance.stages));assert(Object.values(identity).every(v=>v!==undefined));for(const stage of Object.values(identity.stages))assert(Object.values(stage).every(v=>v!==undefined));
});
test('LC07 variable projection never returns unexpected values or parser excerpts',async()=>{
 const {projectLc07Variables:project}=await import('../acceptance/v090/correction.test.mjs'),expected={runtime_request_id:'original',runtime_input_digest:'known-input'},rows=Object.entries(expected).map(([key,value])=>({key,value,variable_type:'env_var'})),raw=JSON.stringify(rows),safe=project(raw,200,expected);assert.deepEqual(safe.rows,rows);assert.equal(safe.evidence.count,2);assert.equal('rawBody' in safe.evidence,false);
 for(const value of [[...rows,{key:'SECRET',value:'NEVER-RETAIN-THIS',variable_type:'env_var'}],[{...rows[0],value:'NEVER-RETAIN-THIS'},rows[1]],[rows[0],rows[0]],rows.map(v=>({...v,variable_type:'file'}))]){let error;try{project(JSON.stringify(value),200,expected);}catch(e){error=e;}assert(error);assert.equal(error.message,'NOT_READY: exact original CI variables unavailable');assert.equal(error.message.includes('NEVER-RETAIN-THIS'),false);}
 assert.throws(()=>project('NEVER-RETAIN-THIS',200,expected),{message:'NOT_READY: exact original CI variables unavailable'});assert.throws(()=>project(raw,403,expected),{message:'NOT_READY: exact original CI variables unavailable'});
});
test('LC06 LC07 provider fresh principal and original authority refuse revocation without requiring renewed execution',async()=>{
 const {assertLcProviderPrincipal:check,lcProviderAuthorityIdentity:authority}=await import('../acceptance/v090/correction.test.mjs'),{authorize}=await import('../../dist/server/security.js'),actor={id:'original',revision:1,projects:['alpha'],permissions:['read'],expiresAt:'2030-01-01T00:00:00Z'};assert.equal(check(actor,actor,authorize,'alpha'),actor);
 for(const changed of [null,{...actor,id:'other'},{...actor,revision:2},{...actor,projects:[]},{...actor,permissions:[]}])assert.throws(()=>check(actor,changed,authorize,'alpha'));assert.throws(()=>check({...actor,permissions:[]},{...actor,permissions:[]},authorize,'alpha'));
 const original={decision:{ref:'original',choice:'APPROVE',subject:{deadlineAt:'expired-original-deadline'}},revocation:null,usable:false,reason:'AUTHORITY_EXPIRED',projectRevision:10,executionDispatched:false},identity=authority(original,'original');assert.deepEqual(authority({...original,usable:true,reason:null,projectRevision:11},'original'),identity);assert.throws(()=>authority({...original,revocation:{reason:'revoked'}},'original'));assert.throws(()=>authority(original,'replacement'));assert.equal(identity.decision.subject.deadlineAt,'expired-original-deadline');
});
test('LC06 actual native runResult jobResult facts allow explicit FAILED and reject unknown or mismatched outcomes',async()=>{
 const {assertLc06Observation:check}=await import('../acceptance/v090/correction.test.mjs'),{runResult,jobResult,aggregateJobs}=await import('../../dist/adapters/platforms.js'),binding={provider:'github',projectId:'alpha',repositoryId:'1',repository:'owner/repo',host:'https://github.com'},ci={requestId:'original',inputDigest:'input',commit:'a'.repeat(40)},runId='10';
 for(const status of ['PASSED','FAILED']){const providerStatus=status==='PASSED'?'completed:success':'completed:failure',job=jobResult(binding,runId,'11',ci.commit,status,providerStatus,'12'),observation=runResult(binding,ci,runId,status,[job]),inventory={runId,status,jobs:[{id:'11',status,providerStatus,runnerId:'12'}]};assert.equal(check(observation,ci,binding,inventory).ciStatus,status);
  const unknown=runResult(binding,ci,runId,'UNKNOWN',[job]);assert.throws(()=>check(unknown,ci,binding,inventory));assert.throws(()=>check(runResult(binding,ci,runId,status,[jobResult(binding,runId,'11',ci.commit,'UNKNOWN','unknown',null)]),ci,binding,inventory));
  for(const change of [v=>v.factsDigest='forged',v=>v.inputDigest='replacement',v=>v.commit='different',v=>v.ref='other',v=>v.repositoryId='2',v=>v.jobs[0].factsDigest='forged',v=>v.jobs[0].runnerId='13',v=>v.jobs[0].status='UNKNOWN']){const changed=structuredClone(observation);change(changed);assert.throws(()=>check(changed,ci,binding,inventory));}
 }
 assert.equal(aggregateJobs([jobResult(binding,runId,'11',ci.commit,'UNKNOWN','unknown',null)],'success'),'UNKNOWN');
});
test('LC06 retained startup UNKNOWN remains valid after current COMPLETE or RUNNING and rejects unrelated history',async()=>{
 const {assertLc06RestartObservation:check}=await import('../acceptance/v090/correction.test.mjs'),{valueDigest}=await import('../../dist/lifecycle/base.js'),request={id:'original',instanceId:'instance',stageId:'implementation',inputDigest:'original-input',plan:{adapterDigest:'original-adapter'},deadlineAt:'2030-01-01T00:00:00Z'},reason='SERVICE_RESTART_RECONCILE',evidence={schema:'runtime-stage-observation/v1',requestId:request.id,reason,observedAt:'2029-01-01T00:00:03Z',observation:{requestId:request.id,inputDigest:request.inputDigest,adapterDigest:request.plan.adapterDigest,phase:'UNKNOWN',handle:{original:'retained-handle'},outcome:{requestId:request.id,inputDigest:request.inputDigest,receiptRef:'runtime:stage/'+request.id,status:'UNKNOWN',expiresAt:request.deadlineAt,checks:[]}}},retained={observationRef:valueDigest(evidence),evidence,historical:true},event={type:'stage-observed',at:'2029-01-01T00:00:03.001Z',data:{stageRequestId:request.id,instanceId:request.instanceId,stageId:request.stageId,phase:'UNKNOWN',reason,observationRef:retained.observationRef}},chain={fault:{at:'2029-01-01T00:00:01Z'},stopped:{at:'2029-01-01T00:00:02Z'},started:{at:'2029-01-01T00:00:04Z'}};
 for(const phase of ['COMPLETE','RUNNING','FAILED','UNKNOWN'])assert.equal(check(event,retained,request,chain,phase).currentPhase,phase);
 for(const mutate of [v=>v.event.data.stageRequestId='replacement',v=>v.event.data.instanceId='replacement',v=>v.event.data.reason='UNRELATED_FAILURE',v=>v.retained.evidence.reason='UNRELATED_FAILURE',v=>v.retained.evidence.observation.inputDigest='changed',v=>v.retained.evidence.observation.adapterDigest='changed',v=>v.retained.evidence.observation.outcome.expiresAt='extended',v=>v.retained.historical=false,v=>v.retained.evidence.observedAt='2029-01-01T00:00:00Z',v=>v.event.at='2029-01-01T00:00:05Z',v=>v.chain.started.at='2029-01-01T00:00:02Z',v=>v.chain.stopped.at='not-a-time']){const bad=structuredClone({event,retained,chain});mutate(bad);bad.retained.observationRef=valueDigest(bad.retained.evidence);bad.event.data.observationRef=bad.retained.observationRef;assert.throws(()=>check(bad.event,bad.retained,request,bad.chain,'COMPLETE'));}
});
