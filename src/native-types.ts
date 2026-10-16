import type { NativeReference, StandardPins, NativeScope, NativeJSON, NativeValidationContext, NativeCriterionResult } from '../vendor/compatibility/v1/native.mjs';
import type { Workspace } from './types.js';
export type { NativeReference, StandardPins, NativeScope, NativeJSON, NativeValidationContext, NativeCriterionResult } from '../vendor/compatibility/v1/native.mjs';

export interface NativeSourceScope { direction: 'forward' | 'reverse'; locator: string; revision: string; treeDigest: string; inventoryDigest: string; requirementsDigest: string }
export interface NativeRequirement { criterionId: string; variantIds: string[]; origin: 'execution-result' | 'design-declaration' | 'source-declaration' }
export interface CollectionSelector { id: string; output: string; kind: 'json-pointer' | 'exit-code' | 'junit-total' | 'junit-failures' | 'junit-errors' | 'junit-skipped' | 'json-lines-count'; pointer: string }
export interface CollectionRecipe {
  schema: 'evopilot-collection-recipe/v1'; sourceScope: NativeSourceScope;
  executable: string; executableDigest: string; argv: string[]; cwd: string; environment: Record<string,string>;
  toolchainLockDigest: string; timeoutMs: number; maxOutputBytes: number;
  allowedOutputs: string[]; network: { mode: 'none' | 'declared'; hosts: string[] }; selectors: CollectionSelector[];
}
export interface NativeDecision { reviewDigest: string; decision: 'APPROVE' | 'REJECT'; humanEvidenceRef: string; uid: number; at: string }
export interface CollectionClaim {
  schema: 'evopilot-collection-claim/v1'; id: string; claimId: string; idempotencyKey: string;
  workspace: Workspace; scope: NativeScope; projectCandidateDigest: string;
  recipe: CollectionRecipe; recipeDigest: string; decision: NativeDecision; attemptCount: 1;
}
export interface CollectionRawRef { path: string; mediaType: string; sha256: string; bytes: number }
/** Adapter writes only into artifactRoot. Runtime reads bytes, verifies and owns the receipt. */
export interface CollectionProviderResult {
  claimId: string; recipeDigest: string; sourceDigest: string;
  startedAt: string; endedAt: string; exitCode: number | null; signal: string | null;
  timedOut: boolean; interrupted: boolean; error: string | null;
  outputs: { path: string; mediaType: string; sha256: string }[];
}
export interface CollectionContext { claim: Readonly<CollectionClaim>; artifactRoot: string; signal: AbortSignal }
export interface CollectionReceipt {
  schema: 'evopilot-collection-receipt/v1'; id: string; digest: string; claimId: string;
  workspace: Workspace; scope: NativeScope; projectCandidateDigest: string; recipeDigest: string;
  sourceScopeDigest: string; result: CollectionProviderResult; raw: CollectionRawRef[];
  observations: Record<string,NativeJSON>; origin: 'execution-result';
}
export interface CollectionRecord {
  id: string; workspace: Workspace; scope: NativeScope; projectId: string; projectCandidateDigest: string; recipe: CollectionRecipe;
  reviewDigest: string; decision: NativeDecision | null; claim: CollectionClaim | null;
  stage: 'PREPARED' | 'APPROVED' | 'REJECTED' | 'RUNNING' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED';
  receipt: CollectionReceipt | null; reason: string | null;
}
export interface NativeMaterial { reference: NativeReference; workspace: Workspace; scope: NativeScope; published: true; materialDigest: string; descriptor: {kind: 'ontology-composition/v1' | 'harness-composition/v1'; digest: string} }
export interface NativeComposition {
  schema: 'runtime-composition/v1'; contractDigest: string; projectCandidateDigest: string;
  standardPins: { ontology: StandardPins; harness: StandardPins };
  sourceScope: NativeSourceScope; requirements: NativeRequirement[];
  effectiveConfig: NativeJSON; nativeInputs: { ontology: NativeJSON; harness: NativeJSON };
  collectionReceipts: { id: string; digest: string }[];
}
export interface NativeRunPlan { workspace: Workspace; scope: NativeScope; id: string; projectId: string; goalId: string; pins: {ontology: NativeReference; harness: NativeReference}; input: NativeComposition; materials: {ontology: NativeMaterial; harness: NativeMaterial} }
export interface NativeRunClaim extends NativeRunPlan {
  claimId: string; idempotencyKey: string; reviewDigest: string; inputDigest: string;
  decision: NativeDecision; attemptCount: 1; context: NativeValidationContext;
}
export interface NativeOwnerReceipt {
  owner: 'ontology' | 'harness'; requestId: string; receiptDigest: string;
  reference: NativeReference; context: NativeValidationContext;
  executionStatus: 'SUCCEEDED' | 'FAILED' | 'ERROR' | 'UNKNOWN';
  qualityStatus: 'PASS' | 'FAIL' | 'ERROR' | 'UNSUPPORTED' | 'INDETERMINATE';
  reportDigest: string; criteria: NativeCriterionResult[];
}
export interface NativeProviderReceipt {
  schema: 'runtime-receipt/v1'; contractDigest: string; producer: {product:'runtime';version:'0.3.0'};
  claimId: string; inputDigest: string; projectCandidateDigest: string;
  pins: {ontology:NativeReference;harness:NativeReference};
  standardPins: {ontology:StandardPins;harness:StandardPins};
  ownerReceipts: {ontology:NativeOwnerReceipt;harness:NativeOwnerReceipt};
}
export interface NativeRun {
  plan: NativeRunPlan; reviewDigest: string; decision: NativeDecision|null; claim: NativeRunClaim|null;
  stage: 'PREPARED'|'APPROVED'|'REJECTED'|'RUNNING'|'UNKNOWN'|'SUCCEEDED'|'FAILED';
  receipt: NativeProviderReceipt|null; reason: string|null;
}
export interface NativeProjectCheckReceipt {
  schema:'evopilot-project-check/v1'; context:NativeValidationContext; runReviewDigest:string;
  assetDigests:{ontology:string;harness:string}; criteria:NativeCriterionResult[]; details:NativeJSON; reportDigest:string;
}
export interface NativeProject {
  id: string; goalId: string; scope: NativeScope; sourceScope: NativeSourceScope;
  standardPins: {ontology:StandardPins;harness:StandardPins}; requirements: NativeRequirement[];
  candidateDigest: string; complete: {runId:string;runDigest:string;projectCheck:NativeProjectCheckReceipt|null;decision:NativeDecision;at:string}|null;
}
export interface NativeRuntimeProviders {
  verifyProject?: (request:{project:Readonly<NativeProject>;run:Readonly<NativeRun>}) => Promise<NativeProjectCheckReceipt> | NativeProjectCheckReceipt;
  nativeStandards?: {ontology:StandardPins;harness:StandardPins};
  collect?: (context: CollectionContext) => Promise<CollectionProviderResult> | CollectionProviderResult;
  inspectCollection?: (context: CollectionContext) => Promise<CollectionProviderResult | null> | CollectionProviderResult | null;
  resolveNative?: (request: {reference:NativeReference;workspace:Workspace;scope:NativeScope}) => Promise<NativeMaterial> | NativeMaterial;
  executeNative?: (context: {claim:Readonly<NativeRunClaim>;signal:AbortSignal}) => Promise<NativeProviderReceipt> | NativeProviderReceipt;
  inspectNative?: (context: {claim:Readonly<NativeRunClaim>;signal:AbortSignal}) => Promise<NativeProviderReceipt|null> | NativeProviderReceipt|null;
  readOwnerReceipt?: (request: {owner:'ontology'|'harness';requestId:string;scope:NativeScope;claim:Readonly<NativeRunClaim>}) => Promise<NativeOwnerReceipt> | NativeOwnerReceipt;
  inspectSource?: (request: {sourceScope:NativeSourceScope;scope:NativeScope}) => Promise<NativeSourceScope> | NativeSourceScope;
  resolveRequirements?: (request: {sourceScope:NativeSourceScope;scope:NativeScope}) => Promise<NativeRequirement[]> | NativeRequirement[];
}
export interface NativeInputMap {
  'workspace.inspect': Record<string,never>;
  'receipt.inspect': {requestId:string};
  'project.prepare': {id:string;goalId:string;sourceScope:NativeSourceScope;standardPins:{ontology:StandardPins;harness:StandardPins};requirements:NativeRequirement[]};
  'project.inspect': {id:string}; 'project.list':Record<string,never>;
  'project.validate': {id:string;runId:string};
  'project.complete': {id:string;runId:string;reviewDigest:string;humanEvidenceRef:string};
  'collection.prepare': {id:string;projectId:string;recipe:CollectionRecipe};
  'collection.decide': {id:string;reviewDigest:string;decision:'APPROVE'|'REJECT';humanEvidenceRef:string};
  'collection.execute': {id:string}; 'collection.reconcile': {id:string};
  'collection.inspect': {id:string}; 'collection.list': Record<string,never>;
  'run.prepare': {id:string;projectId:string;goalId:string;ontology:NativeReference;harness:NativeReference;input:NativeComposition};
  'run.decide': {id:string;reviewDigest:string;decision:'APPROVE'|'REJECT';humanEvidenceRef:string};
  'run.dispatch': {id:string}; 'run.reconcile': {id:string}; 'run.inspect': {id:string}; 'run.list': Record<string,never>;
}
export type NativeOperation = keyof NativeInputMap;
export type NativeReadOperation = 'workspace.inspect'|'receipt.inspect'|'project.inspect'|'project.list'|'collection.inspect'|'collection.list'|'run.inspect'|'run.list';
export type NativeRequest<K extends NativeOperation = NativeOperation> = {[P in K]:{operation:P;scope:NativeScope;input:NativeInputMap[P]} & (P extends NativeReadOperation ? {requestId?:never;expectedRevision?:never} : {requestId:string;expectedRevision:number})}[K];
export interface NativeOperationReceipt<T = unknown> { requestId:string;operation:NativeOperation;scope:NativeScope;requestDigest:string;revision:number;result:T;timestamp:string }
export interface NativeState {projects:NativeProject[];collections:CollectionRecord[];runs:NativeRun[]}
