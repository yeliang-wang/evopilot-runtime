import { readRelocations, acceptsWorkspace as acceptRelocatedWorkspace } from './location-lineage.js';
import type { State, Scope, Workspace, Project, Goal, Run } from './types.js';
import { DatabaseSync } from 'node:sqlite';
import { constants, lstatSync, mkdirSync, readdirSync, readFileSync, openSync, closeSync, writeFileSync, fsyncSync } from 'node:fs';
import { resolve, dirname, join, isAbsolute, parse, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { assertJSON, stableSerialize, exactFields, textField, sha256, validateReference } from '../vendor/compatibility/v1/reference.mjs';
import { NATIVE_CONTRACT_DIGEST } from '../vendor/compatibility/v1/native.mjs';

export function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
export const LIMITS = Object.freeze({ requestBytes: 524288, nodes: 20000, depth: 48, projects: 1000, goals: 1000, runs: 1000, receipts: 10000, stateBytes: 8388608, receiptBytes: 33554432 });
export function validateState(value: unknown): State {
  exactFields(value, (['projects','goals','runs'] as const));
  if (Buffer.byteLength(stableSerialize(value)) > LIMITS.stateBytes) fail('CORRUPT_STATE','State byte limit');
  for (const key of (['projects','goals','runs'] as const)) if (!Array.isArray(value[key]) || value[key].length > 1000) fail('CORRUPT_STATE','Invalid collection');
  for (const p of value.projects as unknown[]) { exactFields(p,['scope','name']); scopeCheck(p.scope); textField(p.name); }
  for (const g of value.goals as unknown[]) { exactFields(g,['scope','id','description','revision']); scopeCheck(g.scope); slug(g.id); textField(g.description); }
  for (const r of value.runs as unknown[]) {
    bounded(r);
    exactFields(r,['scope','id','plan','reviewDigest','stage','decision','claim','attemptCount','outcome','cancellation']); scopeCheck(r.scope); slug(r.id);
    if (sha256(r.plan) !== r.reviewDigest || !['PREPARED','APPROVED','REJECTED','RUNNING','UNKNOWN','SUCCEEDED','FAILED','CANCELLED'].includes(r.stage as string) || r.attemptCount !== (r.claim ? 1 : 0)) fail('CORRUPT_STATE','Invalid run');
    exactFields(r.plan,['workspace','scope','goal','pins','input','materials']);
    const plan = r.plan;
    exactFields(r.plan.workspace,['schema','id','canonicalRoot','ownerUid']);
    exactFields(r.plan.pins,(['ontology','harness'] as const)); exactFields(r.plan.materials,(['ontology','harness'] as const));
    if (stableSerialize(r.scope)!==stableSerialize(r.plan.scope) || !(value.goals as unknown[]).some(g=>stableSerialize(g)===stableSerialize(plan.goal))) fail('CORRUPT_STATE','Goal/scope binding changed');
    for (const product of (['ontology','harness'] as const)) {
      validateReference(r.plan.pins[product],{product,visibility:r.scope.visibility});
      const m: unknown=r.plan.materials[product]; exactFields(m,['reference','workspace','scope','published','materialDigest','descriptor']);
      scopeCheck(m.scope); exactFields(m.descriptor,['kind','digest']);
      if (m.published!==true || stableSerialize(m.reference)!==stableSerialize(r.plan.pins[product]) || stableSerialize(m.workspace)!==stableSerialize(r.plan.workspace) || m.scope.visibility!==(m.reference as {visibility: unknown}).visibility || (m.scope.visibility==='private' && stableSerialize(m.scope)!==stableSerialize(r.scope)) || m.descriptor.digest!==m.materialDigest || !/^sha256:[a-f0-9]{64}$/.test(m.materialDigest as string) || m.descriptor.kind!==product+'-composition/v1') fail('CORRUPT_STATE','Material binding changed');
    }
    if (r.decision) { exactFields(r.decision,['id','reviewDigest','decision','humanEvidenceRef','uid','at']); if(r.decision.reviewDigest!==r.reviewDigest || r.decision.id!==r.id || !['APPROVE','REJECT'].includes(r.decision.decision as string)) fail('CORRUPT_STATE','Decision binding changed'); }
    if (r.claim) {
      exactFields(r.claim,['workspace','scope','id','reviewDigest','decision','pins','inputDigest','claimId','idempotencyKey','input','materials','attemptCount']);
      const subject={workspace:r.plan.workspace,scope:r.scope,id:r.id,reviewDigest:r.reviewDigest,decision:r.decision,pins:r.plan.pins,inputDigest:sha256(r.plan.input)};
      if (r.claim.claimId!==sha256(subject) || r.claim.idempotencyKey!==r.claim.claimId || r.claim.attemptCount!==1 || (r.decision as {decision?: unknown} | null)?.decision!=='APPROVE') fail('CORRUPT_STATE','Claim binding changed');
      for(const key of (Object.keys(subject) as (keyof typeof subject)[])) if(stableSerialize(r.claim[key])!==stableSerialize(subject[key])) fail('CORRUPT_STATE','Claim subject changed');
      if(stableSerialize(r.claim.input)!==stableSerialize(r.plan.input)||stableSerialize(r.claim.materials)!==stableSerialize(r.plan.materials)) fail('CORRUPT_STATE','Claim input changed');
    }
    if (r.outcome) {
      exactFields(r.outcome,['status','receipt','reason']);
      if(!['UNKNOWN','SUCCEEDED','FAILED'].includes(r.outcome.status as string)) fail('CORRUPT_STATE','Outcome status');
      if(r.outcome.receipt) { const p=r.outcome.receipt; exactFields(p,['claimId','inputDigest','pins','providerReceiptId','status','result']); exactFields(p.result,['evaluation','evidenceDigest']); if(!r.claim||p.claimId!==(r.claim as {claimId: unknown}).claimId||p.inputDigest!==(r.claim as {inputDigest: unknown}).inputDigest||stableSerialize(p.pins)!==stableSerialize(r.plan.pins)||p.status!==r.outcome.status) fail('CORRUPT_STATE','Outcome binding changed'); }
    }
    if(r.cancellation) exactFields(r.cancellation,['uid','at','reviewDigest','humanEvidenceRef','externalUnresolved']);
  }
  // Collections and bindings above have been checked before exposing domain types.
  const state = value as unknown as State;
  for(const key of (['projects','goals','runs'] as const)) { const ids=state[key].map(x=>stableSerialize(x.scope)+':'+('id' in x ? x.id : '')); if(new Set(ids).size!==ids.length) fail('CORRUPT_STATE','Duplicate identity'); }
  for(const g of state.goals) if(!Number.isSafeInteger(g.revision)||g.revision<1||!state.projects.some(p=>stableSerialize(p.scope)===stableSerialize(g.scope))) fail('CORRUPT_STATE','Orphan goal');
  return state;
}
export function scopeCheck(scope: unknown): asserts scope is Scope { exactFields(scope,['visibility','projectId']); slug(scope.projectId); if (!['public','private'].includes(scope.visibility as string)) fail('INVALID_SCOPE','Invalid visibility'); }
export function bounded(value: unknown): void {
  let nodes = 0, bytes = 0;
  const ancestors = new Set<object>();
  function visit(v: unknown, depth: number) {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth) fail('LIMIT', 'JSON structure limit');
    if (typeof v === 'string') bytes += Buffer.byteLength(v);
    if (bytes > LIMITS.requestBytes) fail('LIMIT', 'JSON byte limit');
    if (!v || typeof v !== 'object') return;
    if (ancestors.has(v)) fail('INVALID_REQUEST', 'Cyclic JSON');
    ancestors.add(v);
    const ds = Object.getOwnPropertyDescriptors(v);
    for (const k of Reflect.ownKeys(ds)) {
      const d = Reflect.get(ds, k) as PropertyDescriptor;
      if (!Object.hasOwn(d, 'value')) fail('INVALID_REQUEST', 'Accessors forbidden');
      bytes += typeof k === 'string' ? Buffer.byteLength(k) : 0;
      visit(d.value, depth + 1);
    }
    ancestors.delete(v);
  }
  visit(value, 0); assertJSON(value);
  if (Buffer.byteLength(stableSerialize(value)) > LIMITS.requestBytes) fail('LIMIT', 'Request too large');
}
export function slug(v: unknown): asserts v is string { if (typeof v !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(v)) fail('INVALID_REQUEST', 'Expected slug'); }
const sourceRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
function stat(path: string) { try { return lstatSync(path); } catch (e) { if (errorCode(e) === 'ENOENT') return null; throw e; } }
function ancestors(path: string) {
  const paths = []; for (let p = path; ; p = dirname(p)) { paths.unshift(p); if (p === dirname(p)) break; }
  for (const p of paths) {
    const s = stat(p);
    if (s && (!s.isDirectory() || s.isSymbolicLink())) fail('UNSAFE_WORKSPACE', 'Non-directory or linked ancestor');
    if (stat(join(p, '.git'))) fail('UNSAFE_WORKSPACE', 'Git workspace forbidden');
  }
}
function checked(path: string, uid: number, directory: boolean, optional = false) {
  const s = stat(path);
  if (!s && optional) return false;
  if (!s || s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) || s.uid !== uid || (s.mode & 0o777) !== (directory ? 0o700 : 0o600) || (!directory && (s.nlink !== 1 || s.size > LIMITS.stateBytes + LIMITS.receiptBytes + 16777216))) fail('UNSAFE_WORKSPACE', 'Owned private regular path required');
  return true;
}
function syncDir(path: string) { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY); try { fsyncSync(fd); } finally { closeSync(fd); } }
function createFile(path: string, bytes: string) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  syncDir(dirname(path));
}
export function openState(root: string, id: string) {
  if (typeof process.getuid !== 'function') fail('UNSUPPORTED_PLATFORM', 'OS uid required');
  const uid = process.getuid();
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root || root === parse(root).root) fail('UNSAFE_WORKSPACE', 'Explicit canonical absolute root required');
  slug(id);
  if (root === sourceRoot || root.startsWith(sourceRoot + sep) || sourceRoot.startsWith(root + sep)) fail('UNSAFE_WORKSPACE', 'Source workspace forbidden');
  ancestors(root);
  const marker = join(root, 'workspace.json');
  const identity: Workspace = { schema: 'evopilot-workspace/v1', id, canonicalRoot: root, ownerUid: uid };
  const existing = stat(root);
  if (existing) {
    checked(root, uid, true);
    if (!stat(marker) && readdirSync(root).length) fail('UNKNOWN_WORKSPACE', 'Nonempty root lacks identity');
  } else if (!stat(dirname(root))) fail('UNSAFE_WORKSPACE', 'Parent must already exist');
  if (stat(marker)) {
    checked(marker, uid, false);
    if (stat(marker)!.size > 4096) fail('IDENTITY_MISMATCH','Oversized workspace identity');
    let actual; try { actual = JSON.parse(readFileSync(marker, 'utf8')); } catch { fail('IDENTITY_MISMATCH', 'Malformed workspace identity'); }
    if (stableSerialize(actual) !== stableSerialize(identity)) fail('IDENTITY_MISMATCH', 'Workspace identity mismatch');
  }
  const dirs = [join(root, 'state'), join(root, 'state/runtime')];
  const dbPath = join(root, 'state/runtime/runtime.db');
  for (const d of dirs) checked(d, uid, true, true);
  for (const p of [dbPath, dbPath + '-wal', dbPath + '-shm', dbPath + '-journal']) checked(p, uid, false, true);
  const existed = !!stat(dbPath);
  if (stat(dirs[1]) && readdirSync(dirs[1]).some(n => !['runtime.db','runtime.db-wal','runtime.db-shm','runtime.db-journal'].includes(n))) fail('UNKNOWN_WORKSPACE','Unknown Runtime state file');
  if (!existed && stat(dirs[1]) && readdirSync(dirs[1]).length) fail('CORRUPT_STATE', 'Missing database in nonempty product state');
  if (!existing) { mkdirSync(root, { mode: 0o700 }); syncDir(dirname(root)); }
  if (!stat(marker)) createFile(marker, stableSerialize(identity));
  for (const d of dirs) if (!stat(d)) { mkdirSync(d, { mode: 0o700 }); syncDir(dirname(d)); }
  if (!existed) createFile(dbPath, '');
  let db: DatabaseSync | undefined;
  function guard() {
    ancestors(root); checked(root, uid, true); checked(marker, uid, false);
    if (stat(marker)!.size > 4096) fail('IDENTITY_MISMATCH','Oversized workspace identity');
    let value; try { value = JSON.parse(readFileSync(marker, 'utf8')); } catch { fail('IDENTITY_MISMATCH', 'Malformed identity'); }
    if (stableSerialize(value) !== stableSerialize(identity)) fail('IDENTITY_MISMATCH', 'Workspace identity changed');
    for (const d of dirs) checked(d, uid, true);
    for (const p of [dbPath, dbPath + '-wal', dbPath + '-shm', dbPath + '-journal']) checked(p, uid, false, true);
    checked(dbPath, uid, false);
    if (db) readRelocations(db, identity, 'runtime');
  }
  try {
    db = new DatabaseSync(dbPath, { timeout: 1000, allowExtension: false });
    db.enableDefensive(true);
    if (existed) {
      if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') fail('CORRUPT_STATE', 'SQLite integrity check failed');
      const version=db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5 && version !== 6 && version !== 7) fail('CORRUPT_STATE', 'Unknown state schema');
      if(version===2 || version===3 || version===4 || version===5 || version===6 || version===7){const identity=db.prepare('SELECT contract_digest,producer FROM native_runtime_identity WHERE singleton=1').get();if(identity?.contract_digest!==NATIVE_CONTRACT_DIGEST||identity?.producer!=='runtime@0.3.0')fail('CORRUPT_STATE','Unknown corrected native state identity');}
      const row = db.prepare('SELECT revision, data FROM state WHERE singleton = 1').get();
      if (!row || typeof row.revision !== 'number' || typeof row.data !== 'string' || !Number.isSafeInteger(row.revision) || row.revision < 0 || Buffer.byteLength(row.data)>LIMITS.stateBytes || !validateState(JSON.parse(row.data))) fail('CORRUPT_STATE', 'Invalid state');
      db.prepare('SELECT scope, request_id, digest, receipt FROM receipts LIMIT 1').all();
      db.prepare('SELECT revision, uid, operation, request_digest, result_digest FROM audit LIMIT 1').all();
    }
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if (!existed) db.exec("BEGIN IMMEDIATE; CREATE TABLE state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL, data TEXT NOT NULL); INSERT INTO state VALUES(1,0,'{\"projects\":[],\"goals\":[],\"runs\":[]}'); CREATE TABLE receipts (scope TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(scope,request_id)); CREATE TABLE audit (revision INTEGER PRIMARY KEY, uid INTEGER NOT NULL, operation TEXT NOT NULL, request_digest TEXT NOT NULL, result_digest TEXT NOT NULL); PRAGMA user_version=1; COMMIT;");
    readRelocations(db, identity, 'runtime');
    guard();
  } catch (e) { if (db) db.close(); if (['INVALID_LINEAGE','MISSING_RELOCATION_KEY'].includes(errorCode(e) ?? '')) throw e; fail('CORRUPT_STATE', 'Cannot open verified Runtime state: ' + (errorCode(e) || 'invalid database')); }
  return {db,uid,identity,guard,acceptsWorkspace: (value: unknown, digest: string) => acceptRelocatedWorkspace(db, identity, 'runtime', value, digest)};
}

export function errorCode(error: unknown): string | undefined { return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined; }
