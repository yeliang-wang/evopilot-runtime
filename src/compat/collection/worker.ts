/** Retained Runtime collector from EvoPilot 0.8.3; see provenance/legacy-execution.json. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { nativeSha256, nativeBytesDigest, nativeStableSerialize, nativeRelativePath } from '../../../vendor/compatibility/v1/native.mjs';
import type { CollectionProviderResult } from '../../native-types.js';
import type { CollectionWorkerRequest, CollectionFilePin } from './types.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const fail = (message: string): never => { throw new Error('COLLECTION_BINDING: ' + message); };
export function checkDirectory(directory: string, allowSystemOwner = false) {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) fail('absolute directory required');
  let current = path.parse(directory).root;
  for (const segment of directory.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment); const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('directory link');
  }
  const stat = fs.statSync(directory);
  if ((stat.uid !== process.getuid!() && !(allowSystemOwner && stat.uid === 0)) || stat.mode & 0o022) fail('uncontrolled directory');
}
export function pinnedFile(filename: string, digest: string) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024 * 1024 || ![0,process.getuid!()].includes(stat.uid) || (stat.mode & 0o022)) fail('unsafe pinned file');
  if (sha(fs.readFileSync(filename)) !== digest) fail('changed pinned bytes');
}
export function verifyBinding(request: CollectionWorkerRequest) {
  const { claim, artifactRoot, binding } = request, recipe = claim.recipe;
  if (process.platform !== 'darwin') fail('native collection sandbox currently requires macOS');
  if (request.schema !== 'evopilot-collection-worker/v1' || recipe.cwd !== binding.cwd || nativeSha256(recipe) !== claim.recipeDigest || recipe.toolchainLockDigest !== binding.toolchainLockDigest)
    fail('recipe or toolchain mismatch');
  checkDirectory(binding.cwd); checkDirectory(artifactRoot);
  if (artifactRoot.startsWith(binding.cwd + path.sep) || binding.cwd.startsWith(artifactRoot + path.sep) || artifactRoot === binding.cwd) fail('writable source overlaps protected evidence');
  if (!binding.sourceFiles.length || !binding.toolFiles.length) fail('source and tool closures required');
  for (const file of binding.sourceFiles) { nativeRelativePath(file.path); pinnedFile(path.join(binding.cwd, file.path), file.sha256); }
  for (const file of binding.toolFiles) { if (!path.isAbsolute(file.path) || file.path === binding.cwd || file.path.startsWith(binding.cwd + path.sep)) fail('tool pin must be outside the writable source'); pinnedFile(file.path, file.sha256); }
  if (!binding.toolFiles.some(f => f.path === recipe.executable && 'sha256:' + f.sha256 === recipe.executableDigest)) fail('executable is outside the reviewed toolchain');
  for (const root of binding.readRoots) checkDirectory(root, true);
  if (!recipe.allowedOutputs.includes('stdout.txt') || !recipe.allowedOutputs.includes('stderr.txt') || recipe.allowedOutputs.some(p => p.startsWith('.collector/') || p === '.collector')) fail('stdout/stderr and separate journal required');
  if (Object.keys(recipe.environment).some(k => !/^[A-Z_][A-Z_0-9]*$/.test(k) || /^(DYLD_|LD_|NODE_OPTIONS$|PYTHONPATH$|PYTHONHOME$|BASH_ENV$|ENV$)/.test(k))) fail('ambient code injection environment');
}
function sandboxProfile(request: CollectionWorkerRequest) {
  const { binding, claim } = request;
  const quote = (v: string) => JSON.stringify(v);
  const network: string[] = [];
  if (claim.recipe.network.mode === 'declared') {
    // SBPL supports only loopback/wildcard addresses. Never silently allow every remote host.
    for (const host of claim.recipe.network.hosts) {
      if (!/^(localhost|127\.0\.0\.1):[1-9][0-9]{0,4}$/.test(host) || Number(host.split(':')[1]) > 65535) fail('remote host collection is unsupported by this sandbox; use a verified offline dependency cache');
      network.push(`(allow network-outbound (remote tcp ${quote('localhost:' + host.split(':')[1])}))`);
    }
  }
  // Reviewed build tools retain ordinary host read access. This boundary protects
  // writes and network; it is not advertised as an untrusted-code confidentiality sandbox.
  // Pins include inert SDK/dependency bytes as well as executables. Only pinned
  // executable files can be child processes; large dependency closures stay out of SBPL.
  const executables = binding.toolFiles.filter(file => fs.statSync(file.path).mode & 0o111).map(file => `(literal ${quote(file.path)})`).join(' ');
  return `(version 1)\n(deny default)\n(allow process-fork process-info* signal sysctl-read mach-lookup file-read*)\n(allow process-exec ${executables})\n(allow file-write* (subpath ${quote(binding.cwd)}))\n(allow file-write-data (literal "/dev/null"))\n${network.join('\n')}\n`;
}
function durable(filename: string, value: unknown) {
  const temp = filename + '.tmp'; const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, nativeStableSerialize(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, filename);
  const dir = fs.openSync(path.dirname(filename), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
export async function runCollectionWorker(request: CollectionWorkerRequest): Promise<CollectionProviderResult> {
  const { claim, artifactRoot, binding } = request, recipe = claim.recipe;
  const result: CollectionProviderResult = { claimId: claim.claimId, recipeDigest: claim.recipeDigest, sourceDigest: recipe.sourceScope.treeDigest,
    startedAt: new Date().toISOString(), endedAt: '', exitCode: null, signal: null, timedOut: false, interrupted: false, error: null, outputs: [] };
  const journal = path.join(artifactRoot, '.collector');
  try {
    verifyBinding(request); const profile = sandboxProfile(request);
    const home = path.join(binding.cwd, '.evopilot-execution-home'); fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const env = { ...recipe.environment, HOME: home, TMPDIR: home, LANG: recipe.environment.LANG ?? 'C.UTF-8' };
    const stdout = fs.openSync(path.join(artifactRoot, 'stdout.txt'), 'wx', 0o600), stderr = fs.openSync(path.join(artifactRoot, 'stderr.txt'), 'wx', 0o600);
    let total = 0;
    try {
      const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, recipe.executable, ...recipe.argv], { cwd: binding.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      durable(path.join(journal, 'process.json'), { pid: child.pid ?? null, claimId: claim.claimId, requestDigest: nativeSha256(request), executable: recipe.executable, argv: recipe.argv, profileDigest: nativeSha256(profile), environment: env });
      let terminationRequested=false;
      const terminate = () => {
        if(!child.pid||terminationRequested)return;
        terminationRequested=true;
        try { process.kill(-child.pid,'SIGKILL'); }
        catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')result.error=(result.error?result.error+':':'')+'TERMINATION_'+((error as NodeJS.ErrnoException).code??'UNKNOWN');}
      };
      const stream = (fd: number, bytes: Buffer) => {
        const room = Math.max(0, recipe.maxOutputBytes - total), chunk = bytes.subarray(0, room); total += bytes.length;
        if (chunk.length) fs.writeSync(fd, chunk);
        if (total > recipe.maxOutputBytes) { result.error ??= 'OUTPUT_LIMIT'; terminate(); }
      };
      child.stdout.on('data', b => stream(stdout, b)); child.stderr.on('data', b => stream(stderr, b));
      const timeout = setTimeout(() => { result.timedOut = true; terminate(); }, recipe.timeoutMs);
      const cancel = setInterval(() => { if (fs.existsSync(path.join(journal, 'cancel'))) { result.interrupted = true; terminate(); } }, 50);
      await new Promise<void>(resolve => {
        child.on('error', e => { result.error = (e as NodeJS.ErrnoException).code ?? 'SPAWN_ERROR'; });
        child.on('close', (code, signal) => { result.exitCode = code; result.signal = signal; clearTimeout(timeout); clearInterval(cancel); resolve(); });
      });
      fs.fsyncSync(stdout); fs.fsyncSync(stderr);
    } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
    verifyBinding(request);
    let rawTotal = 0;
    for (const output of recipe.allowedOutputs) {
      nativeRelativePath(output);
      const isStream = ['stdout.txt', 'stderr.txt'].includes(output), from = path.join(isStream ? artifactRoot : binding.cwd, output);
      if (!fs.existsSync(from)) { result.error ??= 'PARTIAL_OUTPUT'; continue; }
      checkDirectory(path.dirname(from)); const stat = fs.lstatSync(from);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > recipe.maxOutputBytes || (rawTotal += stat.size) > recipe.maxOutputBytes) { result.error ??= 'OUTPUT_LIMIT_OR_UNSAFE'; continue; }
      const bytes = fs.readFileSync(from);
      if (!isStream) { const dest = path.join(artifactRoot, output); fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 }); fs.writeFileSync(dest, bytes, { flag: 'wx', mode: 0o600 }); }
      result.outputs.push({ path: output, mediaType: output.endsWith('.xml') ? 'application/xml' : /\.jsonl?$/.test(output) ? 'application/json' : 'text/plain', sha256: nativeBytesDigest(bytes).slice(7) });
    }
  } catch (error) { result.error = error instanceof Error ? error.message : 'COLLECTOR_ERROR'; }
  result.endedAt = new Date().toISOString();
  durable(path.join(journal, 'result.json'), { requestDigest: nativeSha256(request), result });
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const filename = process.argv[2];
  if (!filename || !path.isAbsolute(filename)) throw new Error('Worker request path required');
  const raw = fs.readFileSync(filename), request = JSON.parse(raw.toString()) as CollectionWorkerRequest;
  if (path.join(request.artifactRoot, '.collector/request.json') !== filename) throw new Error('Worker request identity mismatch');
  await runCollectionWorker(request);
}
