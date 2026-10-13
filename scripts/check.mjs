import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isBuiltin } from 'node:module';
import { spawnSync } from 'node:child_process';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PRODUCT = 'runtime';
const PIN = 'df4f7246ae35ef9114e2b93663d520e7ff4f44f14f886ac8ba43e9fc080ddc9a';
const expected = {
  "name": "@evopilot-next/runtime",
  "version": "0.1.1",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24.14.0"
  },
  "files": [
    "dist",
    "src",
    "vendor",
    "README.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CHANGELOG.md",
    "docs",
    "LICENSE",
    "NOTICE",
    "provenance"
  ],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./service": {
      "types": "./dist/service.d.ts",
      "import": "./dist/service.js"
    }
  },
  "scripts": {
    "build": "node scripts/build.mjs",
    "check": "node scripts/check.mjs",
    "test": "node --test tests/e2e/*.test.mjs"
  },
  "license": "Apache-2.0",
  "bin": {
    "evopilot-next-runtime": "dist/cli.js"
  },
  "devDependencies": {
    "typescript": "5.9.3",
    "@types/node": "24.19.2"
  },
  "dependencies": {}
};
const specifiers = source => [...source.matchAll(/^[\t ]*(?:import\s+(?:type\s+)?(?:(?:[\w$]+(?:\s*,\s*)?)?(?:\{[^}]*\}|\*\s+as\s+[\w$]+)?\s*from\s*)?|export\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?)\s+from\s*)['"]([^'"]+)['"]/gm)].map(match => match[1]);

async function files(directory) {
  assert((await lstat(directory)).isDirectory(), 'Owned tree must be a regular directory');
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    assert(!entry.isSymbolicLink(), 'Symlink forbidden: ' + path);
    if (entry.isDirectory()) result.push(...await files(path));
    else { assert(entry.isFile()); result.push(path); }
  }
  return result;
}

export async function checkSource() {
  for (const args of [['--noEmit'], ['--noEmit','--strict','--target','ES2023','--module','NodeNext','tests/types/contracts.ts']]) {
    const checked = spawnSync(process.execPath, [resolve(ROOT, 'node_modules/typescript/bin/tsc'), ...args], {cwd: ROOT, encoding: 'utf8'});
    assert.ifError(checked.error); assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  }
  const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(key === 'dependencies' ? pkg[key] ?? {} : pkg[key], value, key);
  for (const key of ['peerDependencies', 'optionalDependencies']) assert.deepEqual(pkg[key] ?? {}, {});
  assert.deepEqual(pkg.bin, { 'evopilot-next-runtime': 'dist/cli.js' });
  const cliPath = resolve(ROOT, pkg.bin['evopilot-next-runtime']);
  assert((await readFile(cliPath, 'utf8')).startsWith('#!/usr/bin/env node\n'), 'CLI must start with its Node shebang');
  const cliStat = await lstat(cliPath);
  assert(cliStat.isFile() && (cliStat.mode & 0o111) === 0o111, 'CLI must be an executable regular file');
  const lock = JSON.parse(await readFile(resolve(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.name, pkg.name); assert.equal(lock.version, pkg.version);
  assert.equal(lock.lockfileVersion, 3); assert.equal(lock.requires, true);
  assert.deepEqual(lock.packages[''], { name: pkg.name, version: pkg.version, license: pkg.license, bin: pkg.bin, engines: pkg.engines, devDependencies: pkg.devDependencies });
  for (const [name, version] of Object.entries(pkg.devDependencies)) assert.equal(lock.packages['node_modules/' + name].version, version);
  const adoption = JSON.parse(await readFile(resolve(ROOT, 'provenance/state-adoption.json'), 'utf8'));
  assert.deepEqual(adoption, {
    schema: 'runtime-state-adoption/v1',
    sourceCommit: '1a6c069eb8d19195687d20b19086c087e58927d6',
    sourceProduct: 'new-ontology',
    patterns: ['src/state.mjs', 'src/service.mjs', 'tests/e2e/service.test.mjs', 'tests/fixtures/service-worker.mjs'],
    adaptations: ['Shared exact workspace identity', 'Runtime-owned SQLite WAL FULL store', 'Scoped CAS receipts and atomic audit', 'Synthetic restart worker'],
    runtimeImports: false, sourceManifestIsFileDigest: false, authority: false,
  });
  const vendor = resolve(ROOT, 'vendor/compatibility/v1');
  const manifest = JSON.parse(await readFile(resolve(vendor, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest, {
    contractRevision: '1.0.0', module: 'reference.mjs', sha256: PIN,
    children: ['projects/evopilot-runtime', 'projects/evopilot-harness', 'projects/evopilot-ontology'],
  });
  const bytes = await readFile(resolve(vendor, manifest.module));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), PIN);
  const sources = [...await files(resolve(ROOT, 'src')), ...await files(resolve(ROOT, 'vendor'))];
  for (const path of sources) {
    if (!path.endsWith('.mjs') && !path.endsWith('.ts') && !path.endsWith('.mts')) continue;
    const source = await readFile(path, 'utf8');
    if (path.endsWith('.mjs')) {
    const syntax = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    assert.ifError(syntax.error); assert.equal(syntax.status, 0, syntax.stderr);
    }
    assert.doesNotMatch(source, /\bimport\s*\(|\brequire\s*\(|\beval\s*\(|\/Users\/|\/home\/|EVOPILOT_HARNESS_HOME|defaultHarnessHome|\.evopilot-harness|\bprocess\s*(?:\.\s*(?:env|cwd|chdir)|\[)|\bglobalThis\s*(?:\.|\[)|\bm0\//);
    for (const specifier of specifiers(source)) {
      if (isBuiltin(specifier)) continue;
      if (specifier === 'yaml' && (path.endsWith('/src/asset-sources.mjs') || PRODUCT === 'ontology' && path.includes('/src/compat/'))) continue;
      if (PRODUCT === 'ontology' && path.includes('/src/compat/') && specifier === 'ajv/dist/2020.js') continue;
      assert(specifier.startsWith('.'), 'Undeclared import: ' + specifier);
      const resolved = resolve(dirname(path), specifier);
      const target = path.endsWith('.ts') && resolved.endsWith('.js') ? resolved.slice(0, -3) + '.ts' : resolved;
      assert(target.startsWith(resolve(ROOT, 'src') + sep) || target === resolve(vendor, 'reference.mjs'), 'Foreign source import');
      assert((await lstat(target)).isFile(), 'Import must be an owned regular file');
    }
  }
  const code = [
    "import assert from 'node:assert/strict';",
    'const api = await import(' + JSON.stringify(pathToFileURL(resolve(ROOT, 'dist/index.js')).href) + ');',
    'assert.equal(api.PRODUCT, ' + JSON.stringify(PRODUCT) + ');',
    "assert.equal(api.VERSION, '0.1.1');",
    'assert.equal(api.capabilities().authority, false);',
    "assert.equal(api.capabilities().implementationStage, \"M2_OWNED_SERVICE\");",
    "assert.equal(api.capabilities().businessOperationsReady, true);",
    "assert.equal(api.capabilities().persistentBusinessOperationsReady, true);",
    "assert.equal(api.capabilities().serviceApi, \"./service\");",
    "assert.equal(api.capabilities().hostIntegrationReady, false);",
    "assert.equal(api.capabilities().acceptance, false);",
    "assert.equal(api.capabilities().authority, false);",
    "assert.equal(api.capabilities().softwareRelease, false);",
    'const serviceModule = await import(' + JSON.stringify(pathToFileURL(resolve(ROOT, 'dist/service.js')).href) + ');',
    "const service = serviceModule.createRuntimeService({workspaceRoot:'/nonexistent-runtime-smoke',workspaceId:'smoke'});",
    'assert.equal(service.capabilities().authority, false);',
    'service.close();',
    'const cli = await import(' + JSON.stringify(pathToFileURL(resolve(ROOT, 'dist/cli.js')).href) + ');',
    'assert.equal(typeof cli.main, "function");',
    'for (const command of ["help", "version", "capabilities"]) {',
    '  let output = "";',
    '  assert.equal(await cli.main([command], { stdout: { write: value => { output += value; } } }), 0);',
    '  assert.equal(JSON.parse(output).authority, false);',
    '}',

  ].join('\n');
  const result = spawnSync(process.execPath, ['--permission', '--allow-fs-read=' + ROOT, '--input-type=module', '-e', code], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', OPENSSL_CONF: '/dev/null' },
  });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 2, 'Usage: node scripts/check.mjs');
    await checkSource();
    console.log(PRODUCT + ': owned ESM sources and pinned vendor verified; no acceptance inferred');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
