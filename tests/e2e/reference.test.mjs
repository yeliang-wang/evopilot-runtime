import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../../dist/index.js';
import { CONTRACT_REVISION, inspectReference } from '../../vendor/compatibility/v1/reference.mjs';

const ref = (product = 'ontology') => ({ product, id: 'asset-a', version: '0.1.0', specVersion: 'v1', digest: 'sha256:' + 'a'.repeat(64), visibility: 'private' });
const inspect = (expected, observed) => api.inspectPinnedInputs({ ontology: expected, observedOntology: observed, harness: ref('harness'), observedHarness: ref('harness') });

test('package boundary: exact references are immutable and carry no authority', () => {
  const input = ref();
  const result = inspect(input, { ...input });
  assert.equal(result.authority, false);
  const inspection = result.ontology;
  assert.equal(inspection.exactMatch, true);
  assert.deepEqual(inspection.reference, input);
  input.id = 'changed';
  assert.equal(inspection.reference.id, 'asset-a');
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(inspection));
  assert(Object.isFrozen(inspection.reference));
  assert.throws(() => { inspection.reference.id = 'changed'; }, TypeError);
});

test('package boundary: changed bindings and unsupported input fail closed', () => {
  for (const patch of [
    { version: '0.2.0' }, { digest: 'sha256:' + 'b'.repeat(64) },
    { product: 'runtime' }, { id: 'other' }, { visibility: 'public' },
    { specVersion: '1.0.0' }, { specVersion: 'v2' }, { version: '01.0.0' }, { version: '1.00.0' },
    { version: '1.0.00' }, { version: '1.0' }, { version: '1.0.0-beta' },
    { extra: true },
  ]) assert.throws(() => inspect(ref(), { ...ref(), ...patch }));
  assert.throws(() => inspect({ ...ref(), product: 'runtime' }, { ...ref(), product: 'runtime' }));
  assert.throws(() => inspect(ref(), undefined));
  let accessed = false;
  const accessor = { ...ref(), get id() { accessed = true; return 'asset-a'; } };
  assert.throws(() => inspect(accessor, ref()));
  assert.equal(accessed, false);
});

test('package boundary: default capabilities are truthful immutable data', () => {
  assert.equal(api.VERSION, '0.2.0');
  assert.equal(api.PRODUCT, 'runtime');
  const capabilities = api.capabilities();
  assert.deepEqual(capabilities, {
    product: 'runtime',
    version: '0.2.0',
    implementationStage: "M2_OWNED_SERVICE",
    businessOperationsReady: true,
    persistentBusinessOperationsReady: true,
    serviceApi: "./service",
    hostIntegrationReady: false,
    acceptance: false,
    authority: false,
    softwareRelease: false,
    referenceApi: ['inspectPinnedInputs'],
  });
  assert(Object.isFrozen(capabilities));
  assert(Object.isFrozen(capabilities.referenceApi));
  assert.deepEqual(Object.keys(api).sort(), ['PRODUCT', 'VERSION', 'capabilities', 'inspectPinnedInputs'].sort());
});

test('package boundary: Harness input is independently bound', () => {
  for (const patch of [{ product: 'ontology' }, { version: '0.2.0' }, { digest: 'sha256:' + 'b'.repeat(64) }, { specVersion: '1.0.0' }, { specVersion: 'v2' }]) {
    assert.throws(() => api.inspectPinnedInputs({ ontology: ref(), observedOntology: ref(), harness: ref('harness'), observedHarness: { ...ref('harness'), ...patch } }));
  }
});

test('vendored v1 wire and public boundary are independent of implementation revision', () => {

  assert.equal(CONTRACT_REVISION, '1.0.0');
  for (const product of ['ontology', 'harness']) {
    for (const visibility of ['public', 'private']) {
      const input = { product, id: 'm0-asset', version: '0.1.0', specVersion: 'v1', digest: 'sha256:' + 'a'.repeat(64), visibility };
      const result = inspectReference(input, { ...input });
      assert.deepEqual(result.reference, input);
      assert.notEqual(result.reference, input);
      assert(Object.isFrozen(result.reference));
      assert(Object.isFrozen(result));
      assert.equal(result.exactMatch, true);
      assert.equal(result.authority, false);
      if (visibility === 'public') {
        assert.equal(inspectReference(input, { ...input }, { visibility: 'public' }).exactMatch, true);
      } else {
        assert.throws(() => inspectReference(input, { ...input }, { visibility: 'public' }), TypeError);
      }
      for (const patch of [{ specVersion: '1.0.0' }, { specVersion: 'v2' }, { product: 'runtime' }]) {
        const unsupported = { ...input, ...patch };
        assert.throws(() => inspectReference(unsupported, { ...unsupported }), TypeError);
      }
      for (const patch of [
        { product: product === 'ontology' ? 'harness' : 'ontology' },
        { version: '0.2.0' }, { digest: 'sha256:' + 'b'.repeat(64) },
      ]) assert.throws(() => inspectReference(input, { ...input, ...patch }), TypeError);
    }
  }
});
