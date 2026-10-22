import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { operations } from '../../dist/operations.js';
import { LIMITS } from '../../dist/state.js';
import { createRuntimeService } from '../../dist/service.js';
import { main } from '../../dist/cli.js';

const digest = 'sha256:' + 'a'.repeat(64);
const reference = product => ({ product, id: product, version: '0.1.0', specVersion: 'v1', visibility: 'public', digest });
const composition = { schema: 'runtime-composition/v1', ontologyInstance: { entities: [], relations: [] }, harness: { mode: 'composed', evidence: {}, configuration: {} } };
const prepareInput = { id: 'run', goalId: 'goal', ontology: reference('ontology'), harness: reference('harness'), input: composition };

const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const scope = { visibility: 'public', projectId: 'alpha' };
const read = (operation, input = {}, selected = scope) => ({ operation, scope: selected, input });
const put = { ...read('project.create', { name: 'Alpha' }), requestId: 'first', expectedRevision: 0 };
function invoke(args, input = '', status = 0, flags = []) {
  const child = spawnSync(process.execPath, [...flags, cli, ...args], {
    input: typeof input === 'string' || Buffer.isBuffer(input) ? input : JSON.stringify(input),
    encoding: 'utf8', maxBuffer: 4 * LIMITS.requestBytes,
    env: { ...process.env, NODE_OPTIONS: '', OPENSSL_CONF: '/dev/null' },
  });
  assert.ifError(child.error);
  assert.equal(child.status, status, child.stderr + child.stdout);
  const envelope = JSON.parse(child.stdout);
  assert.equal(envelope.ok, status === 0);
  assert.equal(envelope.authority, false);
  assert.deepEqual(Object.keys(envelope).sort(), (status === 0 ? ['ok', 'product', 'version', 'result', 'authority'] : ['ok', 'error', 'authority']).sort());
  if (status === 0) { assert.equal(envelope.product, 'runtime'); assert.equal(envelope.version, '0.7.0'); }
  return status === 0 ? envelope.result : envelope.error;
}
function setup(t) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'runtime-cli-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const workspace = join(parent, 'workspace');
  const args = ['request', '--workspace', workspace, '--workspace-id', 'cli-test'];
  return { parent, workspace, args, request: (value, status = 0) => invoke(args, value, status) };
}

test('CLI discovery/help/version run without write permission or workspace', () => {
  const flags = ['--permission', '--allow-fs-read=' + root];
  const capabilities = invoke(['capabilities'], '', 0, flags);
  assert.deepEqual(capabilities.operations, operations.filter(op => !['run.prepare', 'run.decide'].includes(op)));
  assert.deepEqual(capabilities.asyncOperations, ['run.reconcile']);
  assert.deepEqual(capabilities.providers, { resolveOntology: false, resolveHarness: false, execute: false, inspectReceipt: false });
  assert(capabilities.historicalRunsReadOnly);
  for (const command of ['help', '--help', 'version', '--version']) invoke([command], '', 0, flags);
  for (const args of [[], ['unknown'], ['help', 'extra'], ['capabilities', '--workspace', '/unused'], ['request'], ['request', '--workspace', 'relative', '--workspace-id', 'test']]) {
    assert.equal(invoke(args, '', 2, flags).code, 'USAGE');
  }
});

test('CLI rejects malformed/bounded input and strict flags before initialization', () => {
  const workspace = join(root, 'invalid-input-must-not-create');
  const args = ['request', '--workspace', workspace, '--workspace-id', 'cli-test'];
  for (const value of ['{secret-value', '{}{}', 'null', '{}', ' '.repeat(LIMITS.requestBytes + 1), Buffer.from([0xff]), { ...read('workspace.inspect'), scope: { visibility: 'unknown', projectId: 'alpha' } }, read('shell.execute'), read('workspace.inspect', { extra: 'private-input' }), read('goal.create', { id: 'goal', description: 'x', extra: true }), { ...put, input: { name: '' } }, { ...put, expectedRevision: -1 }]) {
    const error = invoke(args, value, 2);
    assert(!JSON.stringify(error).includes('secret-value'));
    assert.equal(existsSync(workspace), false);
  }
  for (const suffix of [['--unknown', 'value'], ['--workspace-id', 'duplicate'], ['--request-file'], ['extra'], ['--request-file', 'relative.json']]) {
    assert.equal(invoke([...args, ...suffix], put, 2).code, 'USAGE');
    assert.equal(existsSync(workspace), false);
  }
});

test('CLI stdin persists project/goal/receipts across processes with exact CAS and scope', t => {
  const { request } = setup(t);
  const receipt = request(put);
  assert.equal(receipt.revision, 1);
  assert.deepEqual(request({ ...put, expectedRevision: 999 }), receipt);
  assert.equal(request({ ...put, requestId: 'stale' }, 1).code, 'REVISION_CONFLICT');
  assert.equal(request({ ...put, input: { name: 'Changed' } }, 1).code, 'REQUEST_CONFLICT');
  const goal = { ...read('goal.create', { id: 'goal', description: 'Synthetic goal' }), requestId: 'goal', expectedRevision: 1 };
  const saved = request(goal);
  assert.equal(saved.revision, 2);
  assert.deepEqual(request(goal), saved);
  assert.deepEqual(request(read('receipt.inspect', { requestId: 'first' })), receipt);
  assert.deepEqual(request(read('receipt.inspect', { requestId: 'goal' })), saved);
  assert.deepEqual(request(read('goal.inspect', { id: 'goal' })), saved.result);
  assert.equal(request(read('project.inspect')).name, 'Alpha');
  assert.equal(request(read('project.list')).length, 1);
  assert.equal(request(read('goal.list')).length, 1);
  assert.deepEqual(request(read('run.list')), []);
  assert.equal(request(read('receipt.inspect', { requestId: 'first' }, { ...scope, projectId: 'other' }), 1).code, 'NOT_FOUND');
  for (const operation of ['run.dispatch', 'run.reconcile']) {
    assert.equal(request({ ...read(operation, { id: 'missing' }), requestId: 'explicit', expectedRevision: 2 }, 1).code, operation==='run.dispatch'?'HISTORICAL_READ_ONLY':'NOT_FOUND');
  }
  assert.equal(request(read('workspace.inspect')).revision, 2);
});

test('CLI explicit file accepts regular JSON and rejects missing/directory/symlink/oversize files', t => {
  const { parent, workspace, args } = setup(t);
  const file = join(parent, 'request.json'), link = join(parent, 'linked.json');
  writeFileSync(file, '{bad-secret'); symlinkSync(file, link);
  for (const candidate of [join(parent, 'missing'), parent, link]) {
    assert.equal(invoke([...args, '--request-file', candidate], '', 2).code, 'INPUT_FILE');
    assert.equal(existsSync(workspace), false);
  }
  assert.equal(invoke([...args, '--request-file', file], '', 2).code, 'INVALID_REQUEST');
  assert.equal(existsSync(workspace), false);
  writeFileSync(file, ' '.repeat(LIMITS.requestBytes + 1));
  assert.equal(invoke([...args, '--request-file', file], '', 2).code, 'LIMIT');
  assert.equal(existsSync(workspace), false);
  writeFileSync(file, JSON.stringify(put));
  assert.equal(invoke([...args, '--request-file', file], 'ignored malformed stdin').revision, 1);
  const bin = join(parent, 'evopilot-next-runtime'); symlinkSync(cli, bin);
  const child = spawnSync(process.execPath, [bin, 'version'], { encoding: 'utf8', env: { ...process.env, OPENSSL_CONF: '/dev/null', NODE_OPTIONS: '' } });
  assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).ok, true);
});

test('CLI rejects every operation extra field and malformed composition before initialization', () => {
  const args = ['request', '--workspace', join(root, 'invalid-cli-workspace'), '--workspace-id', 'test'];
  const writes = ['project.create','goal.create','run.prepare','run.decide','run.cancel','run.dispatch','run.reconcile'];
  for (const operation of [...operations, 'run.dispatch', 'run.reconcile']) {
    const value = { ...read(operation, { unexpected: 'private-input' }), ...(writes.includes(operation) ? { requestId: 'test', expectedRevision: 0 } : {}) };
    const error = invoke(args, value, 2, ['--permission', '--allow-fs-read=' + root]);
    assert(!JSON.stringify(error).includes('private-input'));
  }
  for (const change of [v => { v.input.command = 'secret'; }, v => { v.input.ontologyInstance.entities = {}; }, v => { v.ontology.extra = true; }, v => { v.input.harness.configuration = []; }, v => { v.input.harness.mode = 'unknown'; }]) {
    const input = structuredClone(prepareInput); change(input);
    invoke(args, { ...read('run.prepare', input), requestId: 'test', expectedRevision: 0 }, 2, ['--permission', '--allow-fs-read=' + root]);
  }
});

test('CLI rejects unknown exception codes without exposing messages, paths or input', async () => {
  let output = '';
  const stdin = { async *[Symbol.asyncIterator]() { throw Object.assign(Error('/private/caller-secret'), { code: 'caller-secret' }); } };
  const status = await main(['request', '--workspace', join(root, 'invalid-cli-workspace'), '--workspace-id', 'test'], { stdin, stdout: { write: value => { output += value; } } });
  assert.equal(status, 2);
  assert.equal(JSON.parse(output).error.code, 'INVALID_REQUEST');
  assert(!output.includes('caller-secret')); assert(!output.includes('/private/'));
});

test('CLI does not enable retired validator writes or implicit execution', t => {
  const { request } = setup(t);
  request(put);
  request({ ...read('goal.create', {id:'goal',description:'Synthetic'}),requestId:'goal',expectedRevision:1 });
  assert.equal(request({...read('run.prepare',prepareInput),requestId:'prepare',expectedRevision:2},1).code,'HISTORICAL_READ_ONLY');
  assert.equal(request({...read('run.dispatch',{id:'run'}),requestId:'dispatch',expectedRevision:2},1).code,'HISTORICAL_READ_ONLY');
  assert.equal(request(read('workspace.inspect')).revision,2);
});
