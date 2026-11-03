/** Runtime-owned compatibility migrated from EvoPilot 0.8.3. See provenance/project-compatibility.json. */
import fs from 'node:fs';
import path from 'node:path';
import { nativeSha256, nativeBytesDigest, nativeRelativePath, nativeStableSerialize } from '../../../vendor/compatibility/v1/native.mjs';
import { canonicalPath, readRegular, fail } from './files.js';

interface FilePin { path: string; sha256: string }
interface TreePin { files: FilePin[]; directories: string[]; digest: string }
export interface PromotionPlan {
  schema: 'evopilot-project-promotion/v1'; id: string; candidateDigest: string;
  completionDigest: string; current: string; next: string; previous: string;
  before: TreePin; after: TreePin; candidate: string; candidatePin: TreePin; digest: string; authority: false;
}
const same = (a: unknown, b: unknown) => nativeStableSerialize(a) === nativeStableSerialize(b);
function exists(p: string): boolean { try { fs.lstatSync(p); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
function directory(p: string): void { canonicalPath(p); const st = fs.lstatSync(p); if (!st.isDirectory() || st.uid !== process.getuid!() || (st.mode & 0o777) !== 0o700) fail('PROJECT_PERMISSIONS'); }
function tree(root: string): TreePin {
  const files: FilePin[] = [], directories: string[] = []; let bytes = 0;
  function walk(p: string, rel: string, depth: number) {
    if (depth > 64 || files.length + directories.length > 30000) fail('PROJECT_PROMOTION_LIMIT');
    directory(p);
    for (const name of fs.readdirSync(p).sort()) {
      const child = rel ? rel + '/' + name : name, filename = path.join(p, name); nativeRelativePath(child);
      const st = fs.lstatSync(filename);
      if (st.isDirectory()) { directories.push(child); walk(filename, child, depth + 1); }
      else { const raw = readRegular(filename, 64 * 1024 * 1024, true); bytes += raw.length; if (bytes > 512 * 1024 * 1024) fail('PROJECT_PROMOTION_LIMIT'); files.push({ path: child, sha256: nativeBytesDigest(raw) }); }
    }
  }
  walk(root, '', 0); return treePin(files, directories);
}
function mkdir(root: string, rel: string): string {
  directory(root); nativeRelativePath(rel); let p = root;
  for (const name of rel.split('/')) { p = path.join(p, name); if (!exists(p)) fs.mkdirSync(p, { mode: 0o700 }); directory(p); }
  return p;
}
function flush(p: string): void { const fd = fs.openSync(p, fs.constants.O_RDONLY); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function put(p: string, bytes: Buffer): void {
  const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function treePin(files: FilePin[], directories: string[]): TreePin {
  files.sort((a,b) => a.path.localeCompare(b.path, 'en')); directories.sort((a,b) => a.localeCompare(b, 'en'));
  return { files, directories, digest: nativeSha256({ files, directories }) };
}
const replaced = new Set(['README.md', 'project-manifest.json', 'scope', 'sources', 'ontology', 'harness', 'acceptance']);
function fromCandidate(relative: string, before: TreePin): boolean {
  return replaced.has(relative.split('/')[0]) || (relative === 'project.json' && !before.files.some(f => f.path === relative));
}
/** Journal precedes staging. Only exact expected partial bytes may be resumed. */
function stage(plan: PromotionPlan): void {
  if (!same(tree(plan.current), plan.before) || !same(tree(plan.candidate), plan.candidatePin)) fail('PROJECT_PROMOTION_DRIFT');
  if (!exists(plan.next)) fs.mkdirSync(plan.next, { mode: 0o700 });
  const partial = tree(plan.next), expected = new Map(plan.after.files.map(f => [f.path, f.sha256]));
  if (partial.directories.some(d => !plan.after.directories.includes(d)) || partial.files.some(f => expected.get(f.path) !== f.sha256)) fail('PROJECT_PROMOTION_DRIFT');
  for (const name of plan.after.directories) mkdir(plan.next, name);
  const present = new Set(partial.files.map(f => f.path));
  for (const item of plan.after.files) {
    if (present.has(item.path)) continue;
    const source = fromCandidate(item.path, plan.before) ? plan.candidate : plan.current;
    const bytes = readRegular(path.join(source, item.path), 64 * 1024 * 1024, true);
    if (nativeBytesDigest(bytes) !== item.sha256) fail('PROJECT_PROMOTION_DRIFT');
    put(path.join(plan.next, item.path), bytes);
  }
  if (!same(tree(plan.current), plan.before) || !same(tree(plan.candidate), plan.candidatePin) || !same(tree(plan.next), plan.after)) fail('PROJECT_PROMOTION_DRIFT');
  flush(plan.next);
}
function planDigest(value: PromotionPlan): string { const { digest: _, ...body } = value; return nativeSha256(body); }

/** Call only after owner completion and exact domain/source checks, under the project lock. */
export function preparePromotion(options: { id: string; candidateDigest: string; completionDigest: string; current: string; candidate: string; archiveRoot: string; retained: string }): PromotionPlan {
  const journal = path.join(options.retained, 'promotion-' + options.id + '.json');
  if (exists(journal)) {
    const plan = JSON.parse(readRegular(journal, 32 * 1024 * 1024, true).toString()) as PromotionPlan;
    if (plan.digest !== planDigest(plan) || plan.id !== options.id || plan.candidateDigest !== options.candidateDigest || plan.completionDigest !== options.completionDigest || plan.current !== options.current || plan.next !== path.join(options.archiveRoot, 'next') || plan.previous !== path.join(options.archiveRoot, 'previous') || plan.candidate !== options.candidate) fail('PROJECT_PROMOTION_CONFLICT');
    if (!exists(plan.previous) && !exists(path.join(options.retained, 'promotion-' + options.id + '.receipt.json'))) stage(plan);
    return plan;
  }
  const before = tree(options.current), candidate = tree(options.candidate);
  directory(options.archiveRoot);
  const next = path.join(options.archiveRoot, 'next'), previous = path.join(options.archiveRoot, 'previous');
  if (exists(next) || exists(previous)) fail('PROJECT_PROMOTION_UNCERTAIN');
  // Derive the final inventory before creating anything in the staging directory.
  // Preserve every unmanaged file and the complete old tree in the archive.
  const files = before.files.filter(f => !replaced.has(f.path.split('/')[0])).concat(candidate.files.filter(f => fromCandidate(f.path, before)));
  const directories = [...new Set([...before.directories.filter(d => !replaced.has(d.split('/')[0])), ...candidate.directories.filter(d => replaced.has(d.split('/')[0]))])];
  const body = { schema: 'evopilot-project-promotion/v1' as const, id: options.id, candidateDigest: options.candidateDigest, completionDigest: options.completionDigest, current: options.current, next, previous, before, after: treePin(files, directories), candidate: options.candidate, candidatePin: candidate, authority: false as const };
  const plan = { ...body, digest: nativeSha256(body) }; put(journal, Buffer.from(nativeStableSerialize(plan) + '\n')); flush(options.retained);
  stage(plan); return plan;
}

/** Exact-journal recovery admits only old/current/new trees; never merges unknown bytes. */
export function finishPromotion(plan: PromotionPlan, retained: string): { completed: true; promotionDigest: string; previous: string; current: string } {
  if (plan.digest !== planDigest(plan)) fail('PROJECT_PROMOTION_CONFLICT');
  const receiptFile = path.join(retained, 'promotion-' + plan.id + '.receipt.json');
  const receipt = { completed: true as const, promotionDigest: plan.digest, previous: plan.previous, current: plan.current };
  if (exists(receiptFile)) {
    if (!same(JSON.parse(readRegular(receiptFile, 1024 * 1024, true).toString()), receipt)) fail('PROJECT_PROMOTION_CONFLICT');
    // Historical receipt only: subsequent editable changes do not rewrite it.
    return receipt;
  }
  const before = (p: string) => same(tree(p), plan.before), after = (p: string) => same(tree(p), plan.after);
  if (exists(plan.previous)) { if (!before(plan.previous)) fail('PROJECT_PROMOTION_DRIFT'); }
  else {
    if (!exists(plan.current) || !before(plan.current) || !exists(plan.next) || !after(plan.next)) fail('PROJECT_PROMOTION_DRIFT');
    fs.renameSync(plan.current, plan.previous); flush(path.dirname(plan.current)); flush(path.dirname(plan.previous));
  }
  if (exists(plan.current)) { if (!after(plan.current) || exists(plan.next)) fail('PROJECT_PROMOTION_DRIFT'); }
  else {
    if (!exists(plan.next) || !after(plan.next)) fail('PROJECT_PROMOTION_DRIFT');
    fs.renameSync(plan.next, plan.current); flush(path.dirname(plan.current)); flush(path.dirname(plan.next));
  }
  if (!before(plan.previous) || !after(plan.current)) fail('PROJECT_PROMOTION_DRIFT');
  put(receiptFile, Buffer.from(nativeStableSerialize(receipt) + '\n')); flush(retained); return receipt;
}
