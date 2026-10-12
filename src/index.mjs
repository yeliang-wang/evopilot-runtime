import { inspectReference } from '../vendor/compatibility/v1/reference.mjs';

export const VERSION = '0.1.0';
export const PRODUCT = 'runtime';

export function capabilities() {
  return Object.freeze({
    product: PRODUCT,
    version: VERSION,
    implementationStage: 'M1_FOUNDATION',
    businessOperationsReady: false,
    authority: false,
    referenceApi: Object.freeze(['inspectPinnedInputs']),
  });
}

export function inspectPinnedInputs({ ontology, harness, observedOntology, observedHarness }) {
  return Object.freeze({
    ontology: inspectReference(ontology, observedOntology, { product: 'ontology' }),
    harness: inspectReference(harness, observedHarness, { product: 'harness' }),
    authority: false,
  });
}
