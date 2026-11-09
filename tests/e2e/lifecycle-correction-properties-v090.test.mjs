// Generated source regressions, never actual LC/Host acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { planCorrectionBranches, preflightCorrection } from '../../dist/lifecycle/correction-planner.js';
const options = { seed: 20261109, numRuns: 100, interruptAfterTimeLimit: 10000, markInterruptAsFailure: true };
const keys = ['source', 'candidate', 'toolchain', 'fixture', 'collector', 'platform', 'permission'];
const node = (id, dependsOn = [], status = 'NOT_RUN') => ({ id, phase: 'PRE_RELEASE', dependsOn, status, authorized: true, originalRequestId: status === 'UNKNOWN' ? `request-${id}` : null });
const input = nodes => ({ phase: 'PRE_RELEASE', nodes, serialGroups: [], invalidations: [] });
const graph = fc.array(fc.array(fc.nat(15), { maxLength: 2 }), { minLength: 1, maxLength: 16 }).map(rows => rows.map((deps, index) => node(`n${index}`, [...new Set(deps.filter(i => i < index).map(i => `n${i}`))])));
const decisions = plan => new Map(plan.decisions.map(d => [d.id, d]));

test('generated DAG readiness matches independent direct-prerequisite oracle and unrelated failures preserve readiness', { timeout: 15000 }, () => {
  fc.assert(fc.property(graph, nodes => {
    const request = input(nodes), before = JSON.stringify(request);
    const result = planCorrectionBranches(request);
    for (const d of result.decisions) assert.equal(d.action, nodes.find(n => n.id === d.id).dependsOn.length ? 'WAITING' : 'READY');
    const extended = planCorrectionBranches(input([...nodes, node('independent-failure', [], 'FAIL')]));
    assert.deepEqual(extended.decisions.slice(0, nodes.length), result.decisions);
    assert.deepEqual(extended.requiredFailures, ['independent-failure']);
    assert.equal(JSON.stringify(request), before);
    assert.equal(result.dispatchAuthorized, false);
  }), options);
});
test('generated invalidation blocks the independently traversed descendant closure', { timeout: 15000 }, () => {
  fc.assert(fc.property(graph, fc.nat(15), (nodes, selection) => {
    const target = nodes[selection % nodes.length].id;
    const descendants = new Set([target]), queue = [target];
    for (let i = 0; i < queue.length; i++) for (const n of nodes) if (n.dependsOn.includes(queue[i]) && !descendants.has(n.id)) { descendants.add(n.id); queue.push(n.id); }
    const request = input(nodes); request.invalidations = [{ kind: 'AUTHORITY', nodeIds: [target] }];
    const result = decisions(planCorrectionBranches(request));
    for (const id of descendants) assert.equal(result.get(id).action, 'BLOCKED');
    for (const n of nodes) if (!descendants.has(n.id)) assert.equal(result.get(n.id).action, n.dependsOn.length ? 'WAITING' : 'READY');
  }), options);
});
test('generated UNKNOWN identity and raw history survive global stops and serial group invalidation', { timeout: 15000 }, () => {
  fc.assert(fc.property(fc.constantFrom('CANDIDATE', 'SHARED_ENVIRONMENT', 'AUTHORITY', 'BUDGET'), fc.nat(100000), (kind, suffix) => {
    const request = input([node(`unknown-${suffix}`, [], 'UNKNOWN'), node('pass', [], 'PASS'), node('failed', [], 'FAIL'), node('c1'), node('c2', ['c1'])]);
    request.serialGroups = [['c1', 'c2']]; request.invalidations = [{ kind, nodeIds: ['c2'] }];
    let result = decisions(planCorrectionBranches(request));
    assert.equal(result.get('c1').action, 'BLOCKED'); assert.equal(result.get('c2').action, 'BLOCKED');
    request.invalidations = [{ kind, nodeIds: null }]; const before = JSON.stringify(request);
    result = decisions(planCorrectionBranches(request));
    assert.equal(result.get(`unknown-${suffix}`).action, 'OBSERVE_ONLY');
    assert.equal(result.get(`unknown-${suffix}`).originalRequestId, `request-unknown-${suffix}`);
    assert.equal(result.get('pass').rawStatus, 'PASS'); assert.equal(result.get('failed').rawStatus, 'FAIL');
    assert.equal(JSON.stringify(request), before);
  }), options);
});
test('all seven binding dimensions reject generated mismatches and PRE rejects POST dependencies', { timeout: 15000 }, () => {
  fc.assert(fc.property(fc.nat(100000), seed => {
    const expected = Object.fromEntries(keys.map(key => [key, `binding-${seed}-${key}`]));
    const cases = [{ id: 'pre', entry: 'pre', phase: 'PRE_RELEASE', dependsOn: [] }, { id: 'post', entry: 'post', phase: 'POST_RELEASE', dependsOn: ['pre'] }];
    const entries = new Map(cases.map(c => [c.entry, () => { throw Error('must never execute'); }]));
    for (const key of keys) {
      const result = preflightCorrection({ phase: 'PRE_RELEASE', expected, observed: { ...expected, [key]: `changed-${seed}` }, cases }, entries);
      assert.equal(result.ready, false); assert.deepEqual(result.issues, [{ code: 'BINDING_MISMATCH', id: key }]);
    }
    cases[0].dependsOn = ['post'];
    assert.throws(() => preflightCorrection({ phase: 'PRE_RELEASE', expected, observed: expected, cases }, entries), e => e.code === 'CORRECTION_PHASE_DEPENDENCY');
  }), options);
});
