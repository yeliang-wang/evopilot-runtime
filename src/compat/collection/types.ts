/** Retained Runtime collector from EvoPilot 0.8.3; see provenance/legacy-execution.json. */
import type { CollectionClaim } from '../../native-types.js';
export interface CollectionFilePin { path: string; sha256: string }
/** Created from retained project scope and a reviewed local tool environment, not from request JSON. */
export interface CollectionExecutionBinding {
  cwd: string;
  sourceFiles: CollectionFilePin[];
  toolchainLockDigest: string;
  toolFiles: CollectionFilePin[];
  readRoots: string[];
}
export interface CollectionWorkerRequest {
  schema: 'evopilot-collection-worker/v1';
  claim: CollectionClaim;
  artifactRoot: string;
  binding: CollectionExecutionBinding;
}
