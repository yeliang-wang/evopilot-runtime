/** Bounded filesystem helpers for retained project compatibility only. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
export const codeRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
export const projectStandardRoot=path.join(codeRoot,'provenance/project-standard-v1');
const PROJECT_STANDARD_FILES:Record<string,string>={
  "README.md": "c1bddd9787537fc91e98c926b4072cbf1c890f78de25bc1ba6f9f83b1a0427ed",
  "base-requirements.json": "a1503b39d16ba7e67aae2458f21c6746125a4a22f27e1073ecc8b669b158e847",
  "directory-layout.json": "aec2a05e4b8e998a880e03d5ca29d47733c52873bf41675fa4e9249219588711"
};
export function fail(code: string, message = code): never { throw Object.assign(new Error(message), { code }); }
export const canonicalJSON = (value: unknown): string => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(v => JSON.parse(canonicalJSON(v))) : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonicalJSON((value as Record<string, unknown>)[k]))])) : value);
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function fields(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) fail('SCHEMA');
}
export function canonicalPath(value: unknown, missingFinal = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) fail('PATH');
  const parts = value.split(path.sep).filter(Boolean);
  let current = path.parse(value).root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let st;
    try { st = fs.lstatSync(current); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' && missingFinal && i === parts.length - 1) return value; throw e; }
    if (st.isSymbolicLink()) fail('SYMLINK');
    if (i < parts.length - 1 && !st.isDirectory()) fail('PATH');
  }
  if (fs.realpathSync(value) !== value) fail('PATH');
  return value;
}
export function readRegular(filename: string, max: number = 1048576, privateFile = false) {
  canonicalPath(filename);
  const before = fs.lstatSync(filename);
  if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid!() || (before.mode & 0o022) || (privateFile && (before.mode & 0o777) !== 0o600) || before.size > max) fail('UNSAFE_FILE');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (st.ino !== before.ino || st.dev !== before.dev || st.size !== before.size) fail('FILE_CHANGED');
    const bytes = fs.readFileSync(fd);
    if (bytes.length > max) fail('LIMIT');
    if(filename.startsWith(projectStandardRoot+path.sep)){const expected=PROJECT_STANDARD_FILES[path.basename(filename)];if(!expected||digest(bytes)!==expected)fail('PROJECT_STANDARD_CHANGED');}
    return bytes;
  } finally { fs.closeSync(fd); }
}
function present(filename: string) { try { fs.lstatSync(filename); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
export function outsideGit(root: string) {
  for (let p = root; ; p = path.dirname(p)) {
    if (present(path.join(p, '.git'))) fail('WORKSPACE_IN_GIT');
    if (path.dirname(p) === p) break;
  }
}

export interface CollectionFilePin {path:string;sha256:string;}
export interface CollectionExecutionBinding {cwd:string;sourceFiles:CollectionFilePin[];toolchainLockDigest:string;toolFiles:CollectionFilePin[];readRoots:string[];}
export function pinnedFile(filename:string,expected:string):void {
  canonicalPath(filename);const st=fs.lstatSync(filename);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>256*1024*1024||![0,process.getuid!()].includes(st.uid)||(st.mode&0o022)||digest(fs.readFileSync(filename))!==expected)fail('COLLECTION_BINDING','Unsafe or changed pinned tool bytes');
}
