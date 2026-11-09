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
