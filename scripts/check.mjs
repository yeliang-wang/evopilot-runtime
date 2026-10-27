import { checkDocumentation } from './check-documentation.mjs';
import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isBuiltin } from 'node:module';
import { spawnSync } from 'node:child_process';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PRODUCT = 'runtime';
const PIN = 'c613b972cee9aa5638797880fab6a48839e74ee79545fdfb74ebe9b2b23c9a11';
const LEGACY_PIN = 'df4f7246ae35ef9114e2b93663d520e7ff4f44f14f886ac8ba43e9fc080ddc9a';
const expected = {
  "name": "@evopilot-next/runtime",
  "version": "0.8.3",
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
expected.exports['./workspace-migration'] = { types: './dist/workspace-migration.d.ts', import: './dist/workspace-migration.js' };
expected.exports['./online'] = { types: './dist/online.d.ts', import: './dist/online.js' };
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
  await checkDocumentation();
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
    contractRevision: '1.1.0', module: 'native.mjs', sha256: PIN,
    sourceSha256: '2e8d69e167f017d9ad54c747f94381f3310903d6b1248f5f1d1777490b46db66',
    decisionEvidenceSourceSha256: '561035d699e5606ee465500f09eccbaf57d4c8e463c70cc5fa37ff2ee9845e7b',
    legacyModule: 'reference.mjs', legacySha256: LEGACY_PIN,
    files: {'reference.d.mts':'c83de0e77269bff05faade1471cc337cedcdee009b52bc084f48a1987846f765','native.d.mts':'94e8e3a40c0fcc68a66a21f92e617452d9399e84f249b3188ae6b54a79a42454','decision-evidence.mjs':'6b8bb7a48215b586faa82198b34b7c479f5ab828db1965196c09249997eb9b51','decision-evidence.d.mts':'d6edf07733b577f6abd34b1952f5bf1579d1e6d3625dbed1867d0e6fc6f8ba63'},
    children: ['projects/evopilot-runtime', 'projects/evopilot-harness', 'projects/evopilot-ontology'],
  });
  const bytes = await readFile(resolve(vendor, manifest.module));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), PIN);
  assert.equal(createHash('sha256').update(await readFile(resolve(vendor,'reference.mjs'))).digest('hex'),LEGACY_PIN);
  for(const [name,digest] of Object.entries(manifest.files)) assert.equal(createHash('sha256').update(await readFile(resolve(vendor,name))).digest('hex'),digest);
  const feedbackRoot=resolve(ROOT,'vendor/compatibility/feedback/v1');
  const feedbackManifest=JSON.parse(await readFile(resolve(feedbackRoot,'manifest.json'),'utf8'));
  assert.equal(feedbackManifest.schema,'evopilot-feedback-distribution/v1');
  assert.deepEqual(Object.keys(feedbackManifest.files).sort(),['feedback.d.mts','feedback.mjs','owner.d.mts','owner.mjs']);
  for(const [name,digest] of Object.entries(feedbackManifest.files))assert.equal(createHash('sha256').update(await readFile(resolve(feedbackRoot,name))).digest('hex'),digest);
  const feedbackImports=['feedback.mjs','owner.mjs'].map(n=>resolve(feedbackRoot,n));
  const onlineRoot=resolve(ROOT,'vendor/compatibility/online/v1');
  const onlineManifest=JSON.parse(await readFile(resolve(onlineRoot,'manifest.json'),'utf8'));
  assert.equal(onlineManifest.schema,'evopilot-online-distribution/v1');
  assert.equal(onlineManifest.nativeContractUnchanged,true);
  assert.deepEqual(Object.keys(onlineManifest.files).sort(),['online.d.mts','online.mjs']);
  for(const [name,digest] of Object.entries(onlineManifest.files))assert.equal(createHash('sha256').update(await readFile(resolve(onlineRoot,name))).digest('hex'),digest);
  const onlineImports=[resolve(onlineRoot,'online.mjs')];
  const responseRoot=resolve(ROOT,'vendor/compatibility/response/v1');
  const responseManifest=JSON.parse(await readFile(resolve(responseRoot,'manifest.json'),'utf8'));
  assert.equal(responseManifest.schema,'evopilot-response-distribution/v1');
  assert.deepEqual(Object.keys(responseManifest.files).sort(),['response.d.mts','response.mjs']);
  for(const [file,digest] of Object.entries(responseManifest.files))assert.equal(createHash('sha256').update(await readFile(resolve(responseRoot,file))).digest('hex'),digest,'Response vendor changed');
  const responseImports=[resolve(responseRoot,'response.mjs')];
  const readabilityRoot=resolve(ROOT,'vendor/readability/v1');
  const readabilityManifest=JSON.parse(await readFile(resolve(readabilityRoot,'manifest.json'),'utf8'));
  assert.equal(readabilityManifest.schema,'evopilot-readability-distribution/v1');
  assert.deepEqual(Object.keys(readabilityManifest.files).sort(),['presentation.d.mts','presentation.mjs','readability.d.mts','readability.mjs']);
  for(const [name,hash] of Object.entries(readabilityManifest.files))assert.equal(createHash('sha256').update(await readFile(resolve(readabilityRoot,name))).digest('hex'),hash);
  const readabilityImports=['readability.mjs','presentation.mjs'].map(name=>resolve(readabilityRoot,name));


  const readinessRoot=resolve(ROOT,'vendor/compatibility/usability/v2');
  const readinessManifest=JSON.parse(await readFile(resolve(readinessRoot,'manifest.json'),'utf8'));
  assert.equal(readinessManifest.schema,'evopilot-usability-distribution/v2');
  assert.equal(readinessManifest.nativeContractUnchanged,true);
  assert.deepEqual(Object.keys(readinessManifest.files).sort(),['authoring.d.mts','authoring.mjs','contract.d.mts','contract.mjs']);
  for(const [name,digest] of Object.entries(readinessManifest.files))assert.equal(createHash('sha256').update(await readFile(resolve(readinessRoot,name))).digest('hex'),digest,'Readiness vendor changed');
  const readinessImports=['authoring.mjs','contract.mjs'].map(name=>resolve(readinessRoot,name));
  const usabilityRoot=resolve(ROOT,'vendor/usability/v1');
  const usabilityManifest=JSON.parse(await readFile(resolve(usabilityRoot,'manifest.json'),'utf8'));
  assert.equal(usabilityManifest.schema,'evopilot-usability-distribution/v1');
  assert.equal(usabilityManifest.nativeContractUnchanged,true);
  assert.deepEqual(Object.keys(usabilityManifest.files).sort(),['assessment.d.mts','assessment.mjs','authoring.d.mts','authoring.mjs','contract.d.mts','contract.mjs','oracle.d.mts','oracle.mjs']);
  for(const [name,hash] of Object.entries(usabilityManifest.files))assert.equal(createHash('sha256').update(await readFile(resolve(usabilityRoot,name))).digest('hex'),hash);
  const usabilityImports=['contract.mjs','authoring.mjs','assessment.mjs','oracle.mjs'].map(name=>resolve(usabilityRoot,name));

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
      assert(target.startsWith(resolve(ROOT, 'src') + sep) || feedbackImports.includes(target) || onlineImports.includes(target) || responseImports.includes(target) || readabilityImports.includes(target) || readinessImports.includes(target) || usabilityImports.includes(target) || [resolve(vendor, 'reference.mjs'),resolve(vendor,'native.mjs'),resolve(vendor,'decision-evidence.mjs')].includes(target), 'Foreign source import');
      assert((await lstat(target)).isFile(), 'Import must be an owned regular file');
    }
  }
  const code = [
    "import assert from 'node:assert/strict';",
    'const api = await import(' + JSON.stringify(pathToFileURL(resolve(ROOT, 'dist/index.js')).href) + ');',
    'assert.equal(api.PRODUCT, ' + JSON.stringify(PRODUCT) + ');',
    "assert.equal(api.VERSION, '0.8.3');",
    'assert.equal(api.capabilities().authority, false);',
    "assert.equal(api.capabilities().implementationStage, \"NATIVE_STANDARDS\");",
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
