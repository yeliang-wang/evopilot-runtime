// Acceptance infrastructure only. No automatic discovery, dynamic import,
// command evaluation, native execution grant, or acceptance verdict.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {fileURLToPath} from 'node:url';

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
export function createAcceptanceCollectorPreflight({ cases, entries, expectedByPhase, observationsByPhase, preflightCorrection }) {
  // The trusted caller selects and verifies its installed implementation. File
  // observers must never load an unchecked source-tree dist as a side effect.
  assert.equal(typeof preflightCorrection, 'function', 'An explicitly verified preflight implementation is required');
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

// Trusted source registrations only. Constructing these objects performs no
// installation, fixture, credential or release read and never invokes a case.
export function registerFixedScenario({scenario,phase,catalog,routes,execute}) {
  profilePhase(phase);assert.equal(typeof execute,'function');assert(Array.isArray(catalog));
  const selected=catalog.filter(c=>(c.scenario??(c.id?.startsWith('UT')?'UT':c.id?.startsWith('LC')?'LC':null))===scenario);
  const entries=new Map();
  for(const c of selected){
    const id=c.caseInstanceId??c.id,route=routes[id];if(!route)continue;
    assert.equal(c.phase,phase);assert.equal(typeof route.handler,'string');assert(route.handler.length>0);
    const executionCaseIds=Object.freeze([...(route.executionCaseIds??[id])]),dependsOn=Object.freeze([...(route.dependsOn??[])]),evidenceDependsOn=Object.freeze([...(route.evidenceDependsOn??[])]);
    assert.equal(new Set(executionCaseIds).size,executionCaseIds.length);assert(executionCaseIds.includes(id));
    for(const other of executionCaseIds){assert(routes[other]);assert(selected.some(v=>(v.caseInstanceId??v.id)===other&&v.phase===phase));}
    const entry='tests/acceptance/v090/'+(scenario==='UT'?'usage':scenario==='LC'?'correction':scenario.toLowerCase())+'.test.mjs#'+id;
    const registration={caseInstanceId:id,phase,entry,handler:route.handler,executionCaseIds,dependsOn,evidenceDependsOn,
      async call(context){
        exact(context,['selectionRef','phase','signal']);assert.equal(context.phase,phase,'POST callbacks cannot run in a PRE context');assert(path.isAbsolute(context.selectionRef));assert(context.signal instanceof AbortSignal);context.signal.throwIfAborted();
        return execute(Object.freeze({...context,schema:'runtime-fixed-callable-context/v1',caseInstanceId:id,executionCaseIds}));
      }};
    entries.set(id,Object.freeze(registration));
  }
  assert(Object.keys(routes).every(id=>selected.some(c=>(c.caseInstanceId??c.id)===id)),'Source registry cannot invent catalog IDs');
  return entries;
}

// Must run immediately after reading the selected JSON, before any selected
// installedRoot, connection, fixture or authorization is opened.
export function assertCallableSelection(context,selection,catalog) {
  if(context?.schema!=='runtime-fixed-callable-context/v1')return;
  exact(context,['selectionRef','phase','signal','schema','caseInstanceId','executionCaseIds']);
  profilePhase(context.phase);assert(context.signal instanceof AbortSignal);context.signal.throwIfAborted();
  assert.deepEqual(selection.caseIds,context.executionCaseIds,'Actual execution selection differs from the registered native case closure');
  assert(!selection.caseCampaign,'Registered leaf calls cannot substitute a campaign or child selection');
  for(const id of context.executionCaseIds){const c=catalog.find(v=>(v.caseInstanceId??v.id)===id);assert(c,'Registered callback case absent from frozen catalog');assert.equal(c.phase,context.phase);}
  assert(context.executionCaseIds.includes(context.caseInstanceId));
  if(Object.hasOwn(selection,'phase'))assert.equal(selection.phase,context.phase);
}

export function fixedAcceptanceCatalog(root) {
  assert.equal(path.resolve(root),path.resolve(fileURLToPath(new URL('../../../',import.meta.url))),'Catalog must belong to this exact source registry');
  const read=name=>JSON.parse(fs.readFileSync(path.join(root,'governance',name),'utf8'));
  const matrix=read('parameter-matrix-v090.json').caseInstances,usage=read('token-usage-v090.json').acceptance.cases,correction=read('lifecycle-correction-v090.json').acceptance.cases;
  assert.equal(matrix.length,664);assert.equal(usage.length,24);assert.equal(correction.length,21);
  const rows=[...matrix,...usage.map(c=>({...c,scenario:'UT',caseInstanceId:c.id})),...correction.map(c=>({...c,scenario:'LC',caseInstanceId:c.id}))];
  assert.equal(new Set(rows.map(c=>c.caseInstanceId)).size,709);assert.equal(rows.filter(c=>c.phase==='PRE_RELEASE').length,698);assert.equal(rows.filter(c=>c.phase==='POST_RELEASE').length,11);return rows;
}

// Module specifiers and exports are fixed source code. No selection-supplied
// module, shell command or callback is loaded. POST exports are registered only.
export async function loadFixedAcceptanceRegistry(root) {
  const catalog=fixedAcceptanceCatalog(root),registrations=new Map();
  const modules=[
    [()=>import('./e01.test.mjs'),'registerE01CallableCases'],
    [()=>import('./e02.test.mjs'),'registerE02CallableCases'],
    [()=>import('./e03.test.mjs'),'registerE03CallableCases'],
    [()=>import('./e04.test.mjs'),'registerE04CallableCases'],
    [()=>import('./e05.test.mjs'),'registerE05CallableCases'],
    [()=>import('./e06.test.mjs'),'registerE06CallableCases'],
    [()=>import('./e07.test.mjs'),'registerE07CallableCases'],
    [()=>import('./e08.test.mjs'),'registerE08CallableCases'],
    [()=>import('./e09.test.mjs'),'registerE09CallableCases'],
    [()=>import('./e10.test.mjs'),'registerE10CallableCases'],
    [()=>import('./e11.test.mjs'),'registerE11CallableCases'],
    [()=>import('./e12.test.mjs'),'registerE12CallableCases'],
    [()=>import('./e13.test.mjs'),'registerE13CallableCases'],
    [()=>import('./e14.test.mjs'),'registerE14CallableCases'],
    [()=>import('./e15.test.mjs'),'registerE15CallableCases'],
    [()=>import('./e16.test.mjs'),'registerE16CallableCases'],
    [()=>import('./e17.test.mjs'),'registerE17CallableCases'],
    [()=>import('./e18.test.mjs'),'registerE18CallableCases'],
    [()=>import('./e19.test.mjs'),'registerE19CallableCases'],
    [()=>import('./e20.test.mjs'),'registerE20CallableCases'],
    [()=>import('./e21.test.mjs'),'registerE21CallableCases'],
    [()=>import('./e22.test.mjs'),'registerE22CallableCases'],
    [()=>import('./usage.test.mjs'),'registerUsageCallableCases'],
    [()=>import('./correction.test.mjs'),'registerCorrectionCallableCases']
  ];
  const missingExports=[];for(const [load,name] of modules){const module=await load();if(typeof module[name]!=='function'){missingExports.push(name);continue;}const rows=module[name](catalog);assert(rows instanceof Map);for(const [id,row] of rows){assert(!registrations.has(id));assert.equal(id,row.caseInstanceId);assert.equal(typeof row.call,'function');registrations.set(id,row);}}
  const gaps=catalog.filter(c=>!registrations.has(c.caseInstanceId)).map(c=>({caseInstanceId:c.caseInstanceId,phase:c.phase,reason:'MISSING_IMPLEMENTED_CALLBACK'}));
  const cases=catalog.map(c=>{const r=registrations.get(c.caseInstanceId);return{id:c.caseInstanceId,phase:c.phase,dependsOn:r?[...new Set([...r.dependsOn,...r.evidenceDependsOn])]:[],entry:r?.entry??(c.collector??('tests/acceptance/v090/'+(c.scenario==='UT'?'usage':'correction')+'.test.mjs'))+'#'+c.caseInstanceId};});
  const entries=new Map([...registrations.values()].map(r=>[r.entry,r.call]));
  return{catalog,cases,entries,registrations,gaps,missingExports,fullCatalogCallable:gaps.length===0,productAcceptance:'NOT_EVALUATED',dispatchAuthorized:false};
}

// LC02's four fixed observations. This exercises only the actual verified
// planner's preflight; the registry's business callbacks are never dispatched.
export function exerciseLc02Preflight({registry,expected,observations,preflightCorrection}) {
  assert.equal(registry.catalog.length,709);assert.equal(registry.cases.length,709);
  if(!registry.fullCatalogCallable||registry.gaps.length||registry.missingExports.length)fail('NOT_READY','Every fixed case needs its actual implemented callback before LC02',registry.gaps);
  assert.equal(registry.entries.size,709);assert.equal(registry.registrations.size,709);
  const pre=registry.cases.filter(c=>c.phase==='PRE_RELEASE'),post=registry.cases.filter(c=>c.phase==='POST_RELEASE');assert.equal(pre.length,698);assert.equal(post.length,11);
  for(const c of registry.cases){const r=registry.registrations.get(c.id);assert(r);assert.equal(r.entry,c.entry);assert.equal(registry.entries.get(c.entry),r.call);assert.equal(typeof r.call,'function');}
  const options={expectedByPhase:{PRE_RELEASE:expected},observationsByPhase:{PRE_RELEASE:observations},preflightCorrection};
  const assess=(cases,entries)=>createAcceptanceCollectorPreflight({...options,cases,entries}).preflight('PRE_RELEASE');
  // Establish the original valid source mapping before mutating any private copy.
  const valid=assess(registry.cases,registry.entries);assert.deepEqual([...valid.callableCaseIds].sort(),pre.map(c=>c.id).sort());assert(valid.callableCaseIds.every(id=>!post.some(c=>c.id===id)));
  const target=pre[0],other=pre[1],later=post[0],vectors=[];
  function reject(vector,cases,entries,code,id){let caught;try{assess(cases,entries);}catch(error){caught=error;}assert(caught,'The exact private mutation must be rejected');assert.equal(caught.code,code);if(id)assert(caught.message.includes(id));vectors.push({vector,code,...(id?{caseInstanceId:id}:{}),message:caught.message});}
  const missing=new Map(registry.entries);missing.delete(target.entry);reject('missing-entry',registry.cases,missing,'MISSING_ENTRY',target.id);
  const uncallable=new Map(registry.entries);uncallable.set(target.entry,null);reject('uncallable-entry',registry.cases,uncallable,'UNCALLABLE_ENTRY',target.id);
  const phaseCycle=structuredClone(registry.cases);phaseCycle.find(c=>c.id===target.id).dependsOn.push(later.id);const laterNode=phaseCycle.find(c=>c.id===later.id);if(!laterNode.dependsOn.includes(target.id))laterNode.dependsOn.push(target.id);reject('pre-post-cycle',phaseCycle,registry.entries,'CORRECTION_PHASE_DEPENDENCY');
  const preCycle=structuredClone(registry.cases);preCycle.find(c=>c.id===target.id).dependsOn.push(other.id);preCycle.find(c=>c.id===other.id).dependsOn.push(target.id);let cycle;try{assess(preCycle,registry.entries);}catch(error){cycle=error;}assert.equal(cycle?.code,'CORRECTION_CYCLE');
  const restored=assess(registry.cases,registry.entries);assert.deepEqual(restored,valid);vectors.push({vector:'valid-mapping',...restored});
  return{vectors,preOnlyCycleControl:{code:cycle.code},phase:'PRE_RELEASE',fixedCases:709,callablePreCases:698,registeredPostCases:11,observedFiles:Object.fromEntries(categories.map(k=>[k,[...observations[k]]])),postProfilesObserved:false,businessCallbacksInvoked:0,productAcceptance:'NOT_EVALUATED',dispatchAuthorized:false};
}
