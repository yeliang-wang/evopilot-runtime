import type { Reference } from './types.js';
export type * from './types.js';
import { inspectReference } from '../vendor/compatibility/v1/reference.mjs';

// The native durable service is an explicit ./service subpath. Root metadata describes
// implemented service support, not configured providers or Host acceptance.
// This pure API never initializes persistent state.

export const VERSION = '0.3.0';
export const PRODUCT = 'runtime';

export function capabilities() {
  return Object.freeze({
    product: PRODUCT,
    version: VERSION,
    implementationStage: "NATIVE_STANDARDS",
    businessOperationsReady: true,
    persistentBusinessOperationsReady: true,
    serviceApi: "./service",
    hostIntegrationReady: false,
    acceptance: false,
    authority: false,
    softwareRelease: false,
    referenceApi: Object.freeze(['inspectPinnedInputs']),
  });
}

export function inspectPinnedInputs({ ontology, harness, observedOntology, observedHarness }: {ontology: Reference; harness: Reference; observedOntology: Reference; observedHarness: Reference}) {
  return Object.freeze({
    ontology: inspectReference(ontology, observedOntology, { product: 'ontology' }),
    harness: inspectReference(harness, observedHarness, { product: 'harness' }),
    authority: false,
  });
}
