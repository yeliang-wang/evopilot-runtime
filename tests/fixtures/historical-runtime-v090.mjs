import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const publishedRevision = '81777f07e856ba5a3615b373de5f6709dc3b3e9b';
const git = args => execFileSync('git', args, {cwd:root});
const bytes = new Map();

export function historicalRuntimeFile(relativePath) {
  if (!bytes.has(relativePath)) bytes.set(relativePath, git(['show', publishedRevision + ':' + relativePath]));
  return Buffer.from(bytes.get(relativePath));
}

export function historicalRuntimePaths(directory) {
  return git(['ls-tree', '-r', '--name-only', '-z', publishedRevision, directory]).toString().split('\0').filter(Boolean);
}
