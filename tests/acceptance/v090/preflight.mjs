// Acceptance infrastructure only. No automatic discovery, dynamic import,
// command evaluation, native execution grant, or acceptance verdict.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { preflightCorrection } from '../../../dist/lifecycle/correction-planner.js';

const categories = ['source', 'candidate', 'toolchain', 'fixture', 'collector', 'permission'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message, issues) => { const error = new Error(message); error.code = code; if (issues) error.issues = issues; throw error; };
const exact = (value, names) => {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...names].sort());
};
const profilePhase = value => {
  if (!['PRE_RELEASE', 'POST_RELEASE'].includes(value)) fail('COLLECTOR_PHASE', 'Explicit acceptance phase required');
  return value;
};

/** Observe actual file bytes and access metadata, never a caller's claimed
 * observed hashes. The trusted collector chooses these inputs; expected hashes
 * come from its reviewed selection. File existence does not prove domain fixture
 * readiness, and permission configuration bytes do not replace live service RBAC.
 * No POST profile is read when PRE is selected. */
export function observeAcceptanceBindings(profile) {
  exact(profile, categories);
  let total = 0;
  const observed = {};
  for (const category of categories) {
    const files = profile[category];
    assert(Array.isArray(files) && files.length > 0 && files.length <= 64, 'Bounded nonempty binding file list required');
    assert.equal(new Set(files).size, files.length, 'Duplicate observation file');
    const facts = [...files].sort().map(filename => {
      assert(typeof filename === 'string' && path.isAbsolute(filename) && path.resolve(filename) === filename);
      assert.equal(fs.realpathSync(filename), filename, 'Observation paths must not traverse symlinks');
      const before = fs.lstatSync(filename);
      assert(before.isFile() && before.nlink === 1 && before.size <= 16777216, 'Regular bounded observation file required');
      total += before.size; assert(total <= 67108864, 'Observation byte budget exceeded');
      if (category === 'permission') assert(before.uid === process.getuid() && (before.mode & 0o077) === 0, 'Permission evidence must be private and owned by this operator');
      const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(fd);
        const unchanged = stat => { for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(stat[key], before[key], 'Binding file changed during observation'); };
        unchanged(opened);
        const buffer = Buffer.alloc(before.size + 1); let length = 0;
        while (length < buffer.length) { const count = fs.readSync(fd, buffer, length, buffer.length - length, null); if (!count) break; length += count; }
        assert.equal(length, before.size, 'Binding file length changed');
        const bytes = buffer.subarray(0, length); unchanged(fs.fstatSync(fd)); unchanged(fs.lstatSync(filename));
        return { filename, sha256: sha(bytes), bytes: bytes.length, uid: before.uid, gid: before.gid, mode: before.mode & 0o777 };
      } finally { fs.closeSync(fd); }
    });
    observed[category] = 'sha256:' + sha(JSON.stringify(category === 'toolchain' ? { nodeVersion: process.version, files: facts } : facts));
  }
  observed.platform = 'sha256:' + sha(JSON.stringify({ platform: process.platform, arch: process.arch, nodeVersion: process.version }));
  return observed;
}

/** Trusted collector code supplies the entire fixed catalog and actual callback
 * objects before setup/actions. This is not a registry loader from selection
 * JSON. Existing scenario collectors need explicit registration refactoring;
 * this module does not claim that their inline branches are already registered.
 * Every callback retains its own existing service/authority guards. */
export function createAcceptanceCollectorPreflight({ cases, entries, expectedByPhase, observationsByPhase }) {
  assert(Array.isArray(cases) && cases.length > 0 && cases.length <= 1024);
  assert(entries instanceof Map, 'An explicit in-process callable registry is required');
  const catalog = structuredClone(cases), registry = new Map(entries);
  const expected = structuredClone(expectedByPhase), profiles = structuredClone(observationsByPhase);
  const attempted = new Set();
  function mapping() {
    for (const c of catalog) {
      if (!registry.has(c.entry)) fail('MISSING_ENTRY', `Missing callable collector entry for ${c.id}`);
      if (typeof registry.get(c.entry) !== 'function') fail('UNCALLABLE_ENTRY', `Collector entry is not callable for ${c.id}`);
    }
  }
  function preflight(selectedPhase) {
    const phase = profilePhase(selectedPhase);
    mapping();
    if (!Object.hasOwn(expected, phase) || !Object.hasOwn(profiles, phase)) fail('COLLECTOR_PHASE_BINDING', 'The selected phase needs reviewed expected and observed input profiles');
    const observed = observeAcceptanceBindings(profiles[phase]);
    const result = preflightCorrection({ phase, expected: expected[phase], observed, cases: catalog }, registry);
    if (!result.ready) fail('COLLECTOR_PREFLIGHT_REJECTED', 'Collector bindings or fixed mapping failed preflight', result.issues);
    return { ...result, observed, productAcceptance: 'NOT_EVALUATED' };
  }
  return Object.freeze({
    preflight,
    async collect(selectedPhase, caseId) {
      const phase = profilePhase(selectedPhase), c = catalog.find(item => item.id === caseId);
      if (!c || c.phase !== phase) fail('COLLECTOR_CASE_PHASE', 'Case must belong to the selected fixed phase');
      if (attempted.has(caseId)) fail('COLLECTOR_ALREADY_ATTEMPTED', 'Inspect the original attempt; this collector never retries it');
      // Reobserve immediately before each callback. A previous check cannot
      // authorize later effects after file, toolchain, or permission drift.
      const assessment = preflight(phase);
      attempted.add(caseId);
      // A thrown callback remains a failure; no PASS label is fabricated here.
      return { assessment, result: await registry.get(c.entry)() };
    }
  });
}

/** Narrow early callable check for legacy collectors that have no reviewed
 * seven-binding preflight selection yet. Coverage is not fixture readiness. */
export function preflightCallableRegistry({ catalog, entries, selectedCaseIds, phase }) {
  profilePhase(phase);
  assert(Array.isArray(catalog) && catalog.length > 0 && catalog.length <= 1024);
  assert(entries instanceof Map);
  for (const c of catalog) profilePhase(c.phase);
  const ids = catalog.map(c => c.caseInstanceId);
  assert.equal(new Set(ids).size, ids.length, 'Duplicate fixed case IDs');
  assert(Array.isArray(selectedCaseIds) && selectedCaseIds.length > 0 && new Set(selectedCaseIds).size === selectedCaseIds.length);
  assert(selectedCaseIds.every(id => ids.includes(id)), 'Selection cannot invent cases');
  assert([...entries.keys()].every(id => ids.includes(id)), 'Registry cannot invent cases');
  const gaps = catalog.filter(c => typeof entries.get(c.caseInstanceId) !== 'function').map(c => ({ caseInstanceId: c.caseInstanceId, phase: profilePhase(c.phase), reason: entries.has(c.caseInstanceId) ? 'UNCALLABLE_ENTRY' : 'MISSING_ENTRY' }));
  const selectedGaps = gaps.filter(g => selectedCaseIds.includes(g.caseInstanceId));
  const selectedPhases = [...new Set(catalog.filter(c => selectedCaseIds.includes(c.caseInstanceId)).map(c => c.phase))];
  const phaseMismatches = catalog.filter(c => selectedCaseIds.includes(c.caseInstanceId) && c.phase !== phase).map(c => c.caseInstanceId);
  const report = { schema: 'runtime-collector-callable-preflight/v1', phase: selectedPhases.length === 1 ? selectedPhases[0] : null, requestedPhase: phase, phaseMismatches, fixedCases: ids.length, registeredCases: ids.length - gaps.length, selectedCaseIds: [...selectedCaseIds], selectedCallable: selectedGaps.length === 0 && phaseMismatches.length === 0, fullCatalogCallable: gaps.length === 0, gaps, bindingsVerified: false, productAcceptance: 'NOT_EVALUATED', dispatchAuthorized: false };
  if (selectedGaps.length || phaseMismatches.length) {
    const error = new Error('Selected collector cases lack callable phase-correct entries: ' + [...new Set([...selectedGaps.map(g => g.caseInstanceId), ...phaseMismatches])].join(', '));
    error.code = 'COLLECTOR_MAPPING_INCOMPLETE'; error.preflight = report; throw error;
  }
  return report;
}
