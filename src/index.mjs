import { inspectReference } from '../vendor/compatibility/v1/reference.mjs';

// The durable M2 service is an explicit ./service subpath. This pure M1 API
// retains its original contract and never initializes persistent state.

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
