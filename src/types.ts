import type { DatabaseSync } from 'node:sqlite';
import type { Reference, JSONValue } from '../vendor/compatibility/v1/reference.mjs';
export type { Reference, JSONValue } from '../vendor/compatibility/v1/reference.mjs';
export interface Scope { visibility: 'public' | 'private'; projectId: string }
export interface Workspace { schema: 'evopilot-workspace/v1'; id: string; canonicalRoot: string; ownerUid: number }
export interface Project { scope: Scope; name: string }
export interface Goal { scope: Scope; id: string; description: string; revision: number }
export interface Pins { ontology: Reference; harness: Reference }
export interface Material { reference: Reference; workspace: Workspace; scope: Scope; published: true; materialDigest: string; descriptor: {kind: string; digest: string} }
export interface Materials { ontology: Material; harness: Material }
export interface Plan { workspace: Workspace; scope: Scope; goal: Goal; pins: Pins; input: JSONValue | Composition; materials: Materials }
export interface Decision { id: string; reviewDigest: string; decision: 'APPROVE'|'REJECT'; humanEvidenceRef: string; uid: number; at: string }
export interface Claim { workspace: Workspace; scope: Scope; id: string; reviewDigest: string; decision: Decision; pins: Pins; inputDigest: string; claimId: string; idempotencyKey: string; input: Plan['input']; materials: Materials; attemptCount: 1 }
export type Evaluation = 'PASS'|'FAIL'|'ERROR'|'INDETERMINATE'|'N/A'|'NOT_CHECKED'|'NOT_EVALUATED';
export interface ProviderReceipt { claimId: string; inputDigest: string; pins: Pins; providerReceiptId: string; status: 'SUCCEEDED'|'FAILED'; result: {evaluation: Evaluation; evidenceDigest: string} }
export interface Outcome { status: 'UNKNOWN'|'SUCCEEDED'|'FAILED'; receipt: ProviderReceipt|null; reason: string|null }
export interface Run { scope: Scope; id: string; plan: Plan; reviewDigest: string; stage: 'PREPARED'|'APPROVED'|'REJECTED'|'RUNNING'|'UNKNOWN'|'SUCCEEDED'|'FAILED'|'CANCELLED'; decision: Decision|null; claim: Claim|null; attemptCount: number; outcome: Outcome|null; cancellation: {uid:number;at:string;reviewDigest:string;humanEvidenceRef:string;externalUnresolved:boolean}|null }
export interface State { projects: Project[]; goals: Goal[]; runs: Run[] }
export interface Store { db: DatabaseSync; uid: number; identity: Workspace; guard(): void; acceptsWorkspace(value: unknown, digest: string): boolean }
export type StoreIdentity = Pick<Store,'uid'|'identity'>;
export interface ResolveRequest {reference: Reference; scope: Scope; workspace: Workspace}
export type Executor = (claim: Readonly<Claim & {signal: AbortSignal}>) => unknown;
export interface Providers {resolveOntology?: (request: ResolveRequest)=>unknown; resolveHarness?: (request: ResolveRequest)=>unknown; execute?: Executor; inspectReceipt?: Executor; timeoutMs?: number}
export interface ServiceOptions {workspaceRoot: string; workspaceId: string}
export interface ExternalRequest {scope:Scope;id:string;requestId:string;expectedRevision:number}
export interface Evidence {id:string;version:string;source:{locator:string;revision:string;digest:string};values:Record<string,JSONValue>}
export interface Composition {schema:'runtime-composition/v1';ontologyInstance:{entities:{id:string;conceptRef:string;properties:Record<string,(string|number|boolean|null)[]>}[];relations:{id:string;relationRef:string;from:string;to:string}[]};harness:{mode:'component';evidence:Evidence;configuration:Record<string,JSONValue>}|{mode:'composed';evidence:Record<string,Evidence>;configuration:Record<string,JSONValue>}}
export interface InputMap {
 'workspace.inspect': Record<string,never>; 'receipt.inspect': {requestId:string};
 'project.create': {name:string}; 'project.inspect': Record<string,never>; 'project.list': Record<string,never>;
 'goal.create': {id:string;description:string}; 'goal.inspect': {id:string}; 'goal.list': Record<string,never>;
 'run.prepare': {id:string;goalId:string;ontology:Reference;harness:Reference;input:Composition};
 'run.decide': Pick<Decision,'id'|'reviewDigest'|'decision'|'humanEvidenceRef'>;
 'run.cancel': Pick<Decision,'id'|'reviewDigest'|'humanEvidenceRef'>;
 'run.inspect': {id:string}; 'run.list': Record<string,never>;
 'run.dispatch': {id:string;outcome?:Outcome}; 'run.reconcile': {id:string;outcome?:Outcome};
}
export type Operation = keyof InputMap;
export type WriteOperation = 'project.create'|'goal.create'|'run.prepare'|'run.decide'|'run.cancel'|'run.dispatch'|'run.reconcile';
export type SyncOperation = Exclude<Operation,'run.dispatch'|'run.reconcile'>;
export type Request<K extends Operation = Operation> = {[P in K]: {operation:P;scope:Scope;input:InputMap[P]} & (P extends WriteOperation ? {requestId:string;expectedRevision:number} : {requestId?:never;expectedRevision?:never})}[K];
export interface Receipt<T=unknown> {requestId:string;scope:Scope;operation:Operation;requestDigest:string;revision:number;uid:number;timestamp:string;result:T;unresolved?:boolean}
export interface WorkspaceInspection {workspaceId:string;revision:number;scope:Scope;authority:false}
export interface ResultMap {'workspace.inspect':WorkspaceInspection;'receipt.inspect':Receipt;'project.create':Project;'project.inspect':Project;'project.list':Project[];'goal.create':Goal;'goal.inspect':Goal;'goal.list':Goal[];'run.prepare':Run;'run.decide':Run;'run.cancel':Run;'run.inspect':Run;'run.list':Run[];'run.dispatch':Run;'run.reconcile':Run}
export type Response<K extends Operation> = K extends WriteOperation ? Receipt<ResultMap[K]> : ResultMap[K];
