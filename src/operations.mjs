import { exactFields, frozenClone, sha256, stableSerialize, textField, validateReference } from '../vendor/compatibility/v1/reference.mjs';
import { inspectPinnedInputs } from './index.mjs';
import { bounded, fail, slug, scopeCheck } from './state.mjs';

export const operations = ['workspace.inspect','receipt.inspect','project.create','project.inspect','project.list','goal.create','goal.inspect','goal.list','run.prepare','run.decide','run.cancel','run.inspect','run.list'];
export const same = (a,b) => stableSerialize(a) === stableSerialize(b);
export function validateRequest(r) {
  const write = ['project.create','goal.create','run.prepare','run.decide','run.cancel','run.dispatch','run.reconcile'].includes(r.operation);
  exactFields(r, ['operation','scope','input', ...(write ? ['requestId','expectedRevision'] : [])]); scopeCheck(r.scope);
  if (write) { slug(r.requestId); if (!Number.isSafeInteger(r.expectedRevision) || r.expectedRevision < 0) fail('INVALID_REQUEST','Invalid revision'); }
  return write;
}
export function resolveMaterials(providers, plan) {
  const materials = {};
  for (const product of ['ontology','harness']) {
    const fn = providers[product === 'ontology' ? 'resolveOntology' : 'resolveHarness'];
    if (typeof fn !== 'function') fail('MISSING_RESOLVER','Trusted resolver required');
    const value = fn(frozenClone({ reference: plan.pins[product], scope: plan.scope, workspace: plan.workspace }));
    if (value && typeof value.then === 'function') { Promise.resolve(value).catch(() => {}); fail('ASYNC_RESOLVER','Resolver must be synchronous'); }
    bounded(value); exactFields(value, ['reference','workspace','scope','published','materialDigest','descriptor']);
    scopeCheck(value.scope); exactFields(value.descriptor, ['kind','digest']);
    if (value.published !== true || !same(value.workspace,plan.workspace) || value.scope.visibility !== value.reference.visibility || (value.scope.visibility === 'public' && ![plan.scope.projectId,'shared'].includes(value.scope.projectId)) || (value.scope.visibility === 'private' && !same(value.scope,plan.scope)) || (plan.scope.visibility === 'public' && value.scope.visibility === 'private')) fail('MATERIAL_SCOPE','Published workspace material required');
    if (!/^sha256:[a-f0-9]{64}$/.test(value.materialDigest) || value.descriptor.digest !== value.materialDigest || value.descriptor.kind !== product + '-composition/v1') fail('INVALID_MATERIAL','Invalid immutable material descriptor');
    materials[product] = frozenClone(value);
  }
  inspectPinnedInputs({ ...plan.pins, observedOntology: materials.ontology.reference, observedHarness: materials.harness.reference });
  return materials;
}
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT','Expected JSON object');
}
function evidence(value) {
  exactFields(value,['id','version','source','values']);
  textField(value.id); textField(value.version);
  exactFields(value.source,['locator','revision','digest']);
  for (const key of ['locator','revision','digest']) textField(value.source[key]);
  object(value.values);
}
function composition(input) {
  bounded(input);
  exactFields(input,['schema','ontologyInstance','harness']);
  if (input.schema !== 'runtime-composition/v1') fail('INVALID_INPUT','Unsupported composition');
  exactFields(input.ontologyInstance,['entities','relations']);
  for (const key of ['entities','relations']) {
    if (!Array.isArray(input.ontologyInstance[key]) || input.ontologyInstance[key].length > 1000) fail('INVALID_INPUT','Expected bounded entity/relation arrays');
  }
  for (const entity of input.ontologyInstance.entities) {
    exactFields(entity,['id','conceptRef','properties']);
    textField(entity.id); textField(entity.conceptRef); object(entity.properties);
    for (const [key,values] of Object.entries(entity.properties)) {
      textField(key);
      if (!Array.isArray(values) || values.some(v => v !== null && !['string','boolean','number'].includes(typeof v))) fail('INVALID_INPUT','Expected JSON primitive property values');
    }
  }
  for (const relation of input.ontologyInstance.relations) {
    exactFields(relation,['id','relationRef','from','to']);
    for (const key of ['id','relationRef','from','to']) textField(relation[key]);
  }
  exactFields(input.harness,['mode','evidence','configuration']);
  object(input.harness.configuration);
  if (input.harness.mode === 'component') evidence(input.harness.evidence);
  else if (input.harness.mode === 'composed') {
    object(input.harness.evidence);
    for (const [reference,value] of Object.entries(input.harness.evidence)) { textField(reference); evidence(value); }
  } else fail('INVALID_INPUT','Expected component or composed Harness mode');
  // Product adapters own reference resolution, model semantics and evidence rules.
  // All strings (including source locators) remain inert JSON descriptors.
}
export function findRun(state,r) { const run = state.runs.find(x => same(x.scope,r.scope) && x.id === r.input.id); if (!run) fail('NOT_FOUND','Run not found'); return run; }
export function operate(store,state,r,providers,revision) {
  const { operation: op, input: i, scope } = r;
  const projects = state.projects.filter(x => same(x.scope,scope));
  if (op === 'project.create') { exactFields(i,['name']); textField(i.name); if (projects.length) fail('EXISTS','Project exists'); const p = {scope,name:i.name}; state.projects.push(p); return p; }
  if (op === 'project.list' || op === 'project.inspect') { exactFields(i,[]); if (op.endsWith('list')) return projects; if (!projects.length) fail('NOT_FOUND','Project required'); return projects[0]; }
  if (!projects.length) fail('NOT_FOUND','Project required');
  if (op === 'goal.create') { exactFields(i,['id','description']); slug(i.id); textField(i.description); if (state.goals.some(x => same(x.scope,scope) && x.id === i.id)) fail('EXISTS','Goal immutable'); const goal = {scope,...i,revision:revision+1}; state.goals.push(goal); return goal; }
  if (op === 'goal.list' || op === 'run.list') { exactFields(i,[]); return state[op.startsWith('goal')?'goals':'runs'].filter(x=>same(x.scope,scope)); }
  if (op === 'goal.inspect') { exactFields(i,['id']); const g=state.goals.find(x=>same(x.scope,scope)&&x.id===i.id); if (!g) fail('NOT_FOUND','Goal required'); return g; }
  if (op === 'run.prepare') {
    exactFields(i,['id','goalId','ontology','harness','input']); slug(i.id); slug(i.goalId); composition(i.input);
    if (state.runs.some(x=>same(x.scope,scope)&&x.id===i.id)) fail('EXISTS','Run immutable');
    const goal=state.goals.find(x=>same(x.scope,scope)&&x.id===i.goalId); if (!goal) fail('NOT_FOUND','Goal required');
    for (const product of ['ontology','harness']) validateReference(i[product],{product,visibility:scope.visibility});
    const plan={workspace:store.identity,scope,goal,pins:{ontology:i.ontology,harness:i.harness},input:i.input};
    plan.materials=resolveMaterials(providers,plan);
    const run={scope,id:i.id,plan,reviewDigest:sha256(plan),stage:'PREPARED',decision:null,claim:null,attemptCount:0,outcome:null,cancellation:null}; state.runs.push(run); return run;
  }
  const run=findRun(state,r);
  if (op === 'run.inspect') { exactFields(i,['id']); return run; }
  if (op === 'run.decide' || op === 'run.cancel') {
    exactFields(i,['id','reviewDigest','humanEvidenceRef',...(op==='run.decide'?['decision']:[])]); textField(i.humanEvidenceRef);
    if (i.reviewDigest !== run.reviewDigest) fail('REVIEW_MISMATCH','Exact review required');
    if (op === 'run.cancel') { if (['SUCCEEDED','FAILED','CANCELLED'].includes(run.stage)) fail('TERMINAL','Run terminal'); run.cancellation={uid:store.uid,at:new Date().toISOString(),reviewDigest:i.reviewDigest,humanEvidenceRef:i.humanEvidenceRef,externalUnresolved:!!run.claim}; run.stage='CANCELLED'; return run; }
    if (run.stage !== 'PREPARED' || !['APPROVE','REJECT'].includes(i.decision)) fail('DECISION_CONFLICT','Decision is immutable');
    run.decision={...i,uid:store.uid,at:new Date().toISOString()}; run.stage=i.decision==='APPROVE'?'APPROVED':'REJECTED'; return run;
  }
  fail('INVALID_OPERATION','Unsupported operation');
}
