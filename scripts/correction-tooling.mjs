// Bounded developer tooling. No Runtime execution, acceptance, or release authority.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const modules = ['correction', 'correction-contract', 'correction-planner', 'evidence-qualification'].map(n => `src/lifecycle/${n}.ts`);
const pins = { 'dependency-cruiser': '18.7.2', '@stryker-mutator/core': '10.1.1', '@stryker-mutator/tap-runner': '10.1.1', typescript: '5.9.3' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const started = performance.now();
const result = { schema: 'runtime-correction-tooling-result/v1', tool: process.argv[2] ?? null, status: 'FAILED', toolIdentity: {}, sourceHashes: {}, elapsedMs: null, tokenUsage: null, monetaryCost: null, costStatus: 'UNKNOWN', artifactDirectory: null, acceptance: 'NOT_EVALUATED' };
function fail(message, incomplete = false) { const error = new Error(message); error.incomplete = incomplete; throw error; }
async function identity(name) {
  const pkg = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'));
  if (pkg.version !== pins[name]) fail(`Unexpected ${name} version`);
  result.toolIdentity[name] = pkg.version;
}
async function execute(command, args, { cwd = root, timeout = 60000, maxBytes = 2097152 } = {}) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, detached: true, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, exceeded = null;
    const stop = reason => {
      if (exceeded) return;
      exceeded = reason;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
    };
    const timer = setTimeout(() => stop('TIME_LIMIT'), timeout);
    for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { stop('OUTPUT_LIMIT'); return; }
      if (name === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    });
    child.once('error', error => { clearTimeout(timer); rejectRun(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr, exceeded });
    });
  });
}
async function checked(command, args, settings, label) {
  const outcome = await execute(command, args, settings);
  await writeFile(join(result.artifactDirectory, `${label}.json`), JSON.stringify(outcome, null, 2));
  if (outcome.exceeded) fail(`${label}: ${outcome.exceeded}`, true);
  if (outcome.code !== 0) fail(`${label} exited ${outcome.code}: ${outcome.stderr.slice(-2000)}`);
  return outcome;
}
async function graph() {
  await identity('dependency-cruiser');
  const outcome = await checked(process.execPath, [join(root, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs'), '--config', 'dependency-cruiser.correction.config.cjs', '--output-type', 'json', ...modules], {}, 'graph');
  const report = JSON.parse(outcome.stdout);
  if (!Array.isArray(report.modules) || !report.summary) fail('Invalid dependency graph protocol');
  const edges = report.modules.reduce((count, m) => count + m.dependencies.length, 0);
  if (report.modules.length > 64 || edges > 256) fail('Graph size limit exceeded', true);
  if (report.summary.error > 0 || report.summary.violations?.length) fail('Dependency graph contains violations');
  const missing = modules.filter(path => !report.modules.some(m => m.source === path));
  if (missing.length) fail('Graph omitted an entry module', true);
  const cutoffs = report.modules.filter(m => m.matchesDepth);
  if (cutoffs.length) fail('Dependency graph reached depth cutoff', true);
  result.graph = { modules: report.modules.length, edges, entryModules: modules, closureComplete: false, scope: 'Four correction modules with direct leaves; never evidence reuse eligibility', report: join(result.artifactDirectory, 'graph.json') };
  result.status = 'COMPLETED';
}
async function mutation(dryOnly) {
  await identity('@stryker-mutator/core'); await identity('@stryker-mutator/tap-runner'); await identity('typescript');
  const sandbox = join(result.artifactDirectory, 'pilot'); await mkdir(sandbox);
  const files = ['package.json', 'tsconfig.json', 'tsconfig.correction-pilot.json', 'stryker.correction.config.mjs', 'src/lifecycle/correction-planner.ts', 'src/server/errors.ts', 'tests/e2e/lifecycle-correction-planner-v090.test.mjs', 'tests/acceptance/v090/preflight.mjs'];
  for (const file of files) { const target = join(sandbox, file); await mkdir(dirname(target), { recursive: true }); await copyFile(join(root, file), target); }
  await symlink(join(root, 'node_modules'), join(sandbox, 'node_modules'), 'dir');
  const launcher = join(root, 'node_modules/@stryker-mutator/core/bin/stryker.js');
  const deadline = performance.now() + 900000;
  const settings = () => ({ cwd: sandbox, timeout: Math.max(1, deadline - performance.now()), maxBytes: 2097152 });
  await checked(process.execPath, [launcher, 'run', 'stryker.correction.config.mjs', '--dryRunOnly'], settings(), 'mutation-dry-run');
  if (dryOnly) { result.status = 'DRY_RUN_COMPLETED'; result.mutation = { executed: false, sourceScope: 'Single binding comparison', sandbox }; return; }
  await checked(process.execPath, [launcher, 'run', 'stryker.correction.config.mjs'], settings(), 'mutation');
  const reportPath = join(sandbox, 'reports/correction-mutation.json'), raw = await readFile(reportPath);
  if (raw.length > 2097152) fail('Mutation report exceeds size budget', true);
  const report = JSON.parse(raw.toString()), mutants = Object.values(report.files ?? {}).flatMap(f => f.mutants ?? []);
  const active = mutants.filter(m => m.status !== 'Ignored');
  if (mutants.length > 128 || active.length !== 1) fail('Expected exactly one active comparison mutant in bounded pilot', true);
  const killedComparison = mutants.some(m => m.mutatorName === 'EqualityOperator' && m.status === 'Killed');
  if (!killedComparison) fail('Known binding equality mutant was not killed');
  if (mutants.some(m => !['Killed', 'Survived', 'Timeout', 'NoCoverage', 'CompileError', 'Ignored'].includes(m.status))) fail('Mutation results incomplete', true);
  result.mutation = { executed: true, mutants: mutants.length, activeMutants: active.length, knownComparisonKilled: true, statuses: Object.fromEntries([...new Set(mutants.map(m => m.status))].map(status => [status, mutants.filter(m => m.status === status).length])), reportPath, fullModuleCoverage: false };
  result.status = 'COMPLETED';
}
async function actionlint() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') fail('Only verified darwin-arm64 actionlint archive is enabled');
  const name = 'actionlint_1.7.12_darwin_arm64.tar.gz';
  const expected = 'aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f';
  const response = await fetch(`https://github.com/rhysd/actionlint/releases/download/v1.7.12/${name}`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) fail('actionlint archive download failed');
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 16777216) fail('Archive size limit exceeded', true); chunks.push(chunk); }
  const archive = Buffer.concat(chunks); if (hash(archive) !== expected) fail('actionlint archive digest mismatch');
  const path = join(result.artifactDirectory, name); await writeFile(path, archive);
  await checked('/usr/bin/tar', ['-xzf', path, '-C', result.artifactDirectory, 'actionlint'], {}, 'actionlint-extract');
  const executable = join(result.artifactDirectory, 'actionlint');
  const version = await checked(executable, ['-version'], {}, 'actionlint-version');
  if (!/^1\.7\.12(?:\r?\n|$)/.test(version.stdout)) fail('actionlint binary version mismatch');
  result.toolIdentity.actionlint = { version: '1.7.12', archiveSha256: expected, platform: 'darwin-arm64' };
  await checked(executable, ['-shellcheck=', '-pyflakes=', '.github/workflows/ci.yml', '.github/workflows/release.yml'], {}, 'actionlint-check');
  result.status = 'COMPLETED';
}
try {
  if (process.version !== 'v24.14.0') fail('Tooling profile requires Node v24.14.0');
  const command = process.argv[2], mode = process.argv[3];
  if (!['graph', 'mutation', 'actionlint'].includes(command) || process.argv.length > 4 || (mode && !(command === 'mutation' && mode === '--dry-run'))) fail('Usage: correction-tooling.mjs graph|mutation [--dry-run]|actionlint');
  result.artifactDirectory = await mkdtemp(join(tmpdir(), 'runtime-correction-tooling-'));
  const sourcePaths = [...modules, 'package-lock.json', 'eslint.correction.config.mjs', 'dependency-cruiser.correction.config.cjs', 'stryker.correction.config.mjs', 'tsconfig.correction-pilot.json', 'scripts/correction-tooling.mjs', 'tests/e2e/lifecycle-correction-planner-v090.test.mjs', 'tests/e2e/lifecycle-correction-properties-v090.test.mjs', 'tests/acceptance/v090/preflight.mjs'];
  if (command === 'actionlint') sourcePaths.push('.github/workflows/ci.yml', '.github/workflows/release.yml');
  for (const file of sourcePaths) result.sourceHashes[file] = hash(await readFile(resolve(root, file)));
  result.toolIdentity.node = process.version;
  if (command === 'graph') await graph();
  else if (command === 'mutation') await mutation(mode === '--dry-run');
  else await actionlint();
} catch (error) {
  result.status = error.incomplete ? 'INCOMPLETE' : 'FAILED'; result.error = error.message; process.exitCode = 1;
} finally {
  result.elapsedMs = Math.round(performance.now() - started);
  if (result.artifactDirectory) await writeFile(join(result.artifactDirectory, 'result.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
