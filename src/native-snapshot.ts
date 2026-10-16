import type { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { NATIVE_CONTRACT_DIGEST, nativeAssertJSON, nativeBytesDigest, nativeSha256, nativeStableSerialize } from '../vendor/compatibility/v1/native.mjs';
import { migrationFail, privatePath, pathStat } from './location-lineage.js';
import type { BlobInventory } from './location-lineage.js';
import type { NativeState, NativeOperationReceipt } from './native-types.js';
export interface NativeSnapshot {
  contractDigest: string; producer: string; revision: number; stateDigest: string;
  receiptsDigest: string; auditDigest: string; recordsDigest: string; receiptCount: number;
}
/** Does not open a service, upgrade the database or rewrite retained native records. */
export function inspectNativeSnapshot(db: DatabaseSync, root: string): { snapshot: NativeSnapshot; state: NativeState; blobs: BlobInventory[] } | null {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name='native_runtime_identity'").get()) return null;
  const identity = db.prepare('SELECT contract_digest,producer FROM native_runtime_identity WHERE singleton=1').get();
  if (identity?.contract_digest !== NATIVE_CONTRACT_DIGEST || identity.producer !== 'runtime@0.3.0') migrationFail('CONTRACT_MISMATCH', 'Unknown native identity');
  const row = db.prepare('SELECT revision,data FROM native_runtime_state WHERE singleton=1').get();
  if (!row || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 0 || typeof row.data !== 'string' || Buffer.byteLength(row.data) > 32 * 1024 * 1024) migrationFail('CORRUPT_STATE', 'Invalid native snapshot state');
  const state: NativeState = JSON.parse(row.data); nativeAssertJSON(state);
  if (!Array.isArray(state.projects) || !Array.isArray(state.collections) || !Array.isArray(state.runs)) migrationFail('CORRUPT_STATE', 'Native tables missing');
  const receipts = db.prepare('SELECT scope,request_id,digest,receipt FROM native_runtime_receipts ORDER BY scope,request_id').all();
  const audit = db.prepare('SELECT revision,request_digest,result_digest,state_digest FROM native_runtime_audit ORDER BY revision').all();
  if (receipts.length > 10000 || receipts.length !== row.revision || audit.length !== row.revision || row.revision && audit.at(-1)?.state_digest !== nativeSha256(state)) migrationFail('CORRUPT_STATE', 'Native snapshot audit differs');
  const revisions = new Set<number>();
  for (const saved of receipts) {
    if (typeof saved.receipt !== 'string') migrationFail('CORRUPT_STATE', 'Invalid native receipt');
    const receipt: NativeOperationReceipt = JSON.parse(saved.receipt); nativeAssertJSON(receipt);
    const entry = audit[receipt.revision - 1];
    if (revisions.has(receipt.revision) || !entry || entry.revision !== receipt.revision || saved.scope !== nativeStableSerialize(receipt.scope) || saved.request_id !== receipt.requestId || saved.digest !== receipt.requestDigest || entry.request_digest !== receipt.requestDigest || entry.result_digest !== nativeSha256(receipt.result)) migrationFail('CORRUPT_STATE', 'Native snapshot receipt differs');
    revisions.add(receipt.revision);
  }
  const blobs: BlobInventory[] = [], base = join(root, 'state', 'runtime-native'); let total = 0;
  function visit(directory: string, depth: number): void {
    if (depth > 32 || blobs.length > 10000) migrationFail('LIMIT', 'Native snapshot file bound');
    privatePath(directory, true);
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isDirectory()) { visit(path, depth + 1); continue; }
      privatePath(path, false);
      if (stat.size > 32 * 1024 * 1024 || (total += stat.size) > 512 * 1024 * 1024) migrationFail('LIMIT', 'Native snapshot byte bound');
      const bytes = readFileSync(path); blobs.push({ path: path.slice(root.length + 1), bytes: bytes.length, digest: nativeBytesDigest(bytes) });
    }
  }
  if (pathStat(base)) visit(base, 0);
  for (const collection of state.collections) if (collection.receipt) {
    const { digest, ...subject } = collection.receipt;
    if (digest !== nativeSha256(subject) || !collection.claim || collection.receipt.claimId !== collection.claim.claimId) migrationFail('CORRUPT_STATE', 'Native collection receipt differs');
    for (const raw of collection.receipt.raw) {
      const path = 'state/runtime-native/' + collection.claim.claimId.slice(7) + '/' + raw.path;
      if (!blobs.some(blob => blob.path === path && blob.bytes === raw.bytes && blob.digest === 'sha256:' + raw.sha256)) migrationFail('CORRUPT_BLOB', 'Native raw evidence missing or changed');
    }
  }
  const stateDigest = nativeSha256(row), receiptsDigest = nativeSha256(receipts), auditDigest = nativeSha256(audit);
  return { state, blobs, snapshot: { contractDigest: NATIVE_CONTRACT_DIGEST, producer: 'runtime@0.3.0', revision: row.revision, stateDigest, receiptsDigest, auditDigest, recordsDigest: nativeSha256({stateDigest,receiptsDigest,auditDigest}), receiptCount: receipts.length } };
}
