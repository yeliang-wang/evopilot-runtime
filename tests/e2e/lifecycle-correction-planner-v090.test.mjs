// Source-level deterministic regressions; these are not actual LC acceptance.
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
  const options = { cases, entries, expectedByPhase: { PRE_RELEASE: observed }, observationsByPhase: { PRE_RELEASE: profile } };
  return { root, profile, observed, calls, options, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
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
