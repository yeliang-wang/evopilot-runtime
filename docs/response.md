# Reviewed response execution

Runtime v0.6 adds a durable link between a Harness problem assessment, a published runbook, an existing private Target/Loop, a Goal and a native collection. The collection performs the actual bounded action. A separate collection and native Run verify the result. A successful action alone does not resolve a problem or approve a release.

The supported action is one reviewed `isolated-collection` step using the existing pinned local collector. It may change generated state in its isolated copied execution directory or contact explicitly permitted loopback endpoints. Original project source and production services are outside this profile. Java/Maven, remote executors and automatic rollback are not added by this API.

## Public API and ownership

Use `createRuntimeService(...).response(envelope)` from `@evopilot-next/runtime/service`. The parent plugin routes these operations through the same public API; callers cannot supply executable providers or forged owner records in an envelope. `service.capabilities().responseOperations` lists the supported operations.

| Operation | Input / result |
|---|---|
| `response.inspect` | Empty input; scoped revision, records, operation list and explicit execution boundary |
| `response.list` | Empty input; retained scoped plans |
| `response.read` | `{id}`; exact plan, decisions, admission, outcome and verification |
| `response.execution.inspect` | `{id}`; a Runtime-owned projection for Harness closure, including its exact problem and recovery references |
| `response.receipt.inspect` | `{requestId}`; retained idempotent operation receipt |
| `response.prepare` | Bind the fields below and return the complete plan with `reviewDigest` |
| `response.decide` | `{id,reviewDigest,decision,humanEvidenceRef}`; exact `APPROVE` or `REJECT` |
| `response.execute` | `{id}`; admit once and dispatch the existing collection with the pinned native revision |
| `response.reconcile` | `{id}`; inspect the original claim; never dispatch an unclaimed action |
| `response.cancel.review` | `{id}`; read the exact cancellation subject, digest, current stage and effect without changing state |
| `response.cancel` | `{id,reviewDigest,humanEvidenceRef}`; cancel an unclaimed plan or request cancellation of its own claimed collection |
| `response.verify` | `{id,runId,recovery}`; verify independent evidence and reviewed asset dispositions |
| `response.close` | `{id,reviewDigest,humanEvidenceRef}`; accept the exact verified result |

Envelopes contain `operation`, private `scope` and `input`. Writes also require a fresh `requestId` and the scoped `expectedRevision` from `response.inspect`. Reusing an ID with different input is rejected. A repeated request may return its original admission receipt; use `response.read` and reconciliation for the latest outcome.

`response.prepare` requires:

- `id`, `actor`, the current `repairId`/`repairDigest`, and the Harness `problemId`/`problemDigest`.
- A `runbook` pin containing its published Harness package `reference`, relative `path` and digest of the canonical parsed JSON. Package integrity protects the original file bytes.
- Existing native `projectId`, existing `goalId`, `collectionId`, and exact runbook `parameters`. Runtime derives the source, project candidate, collection review and recipe digests from its own records.
- `target` and `loop` Workspace references. Each reference has `owner`, `id` and `digest`. The Target ID is the retained campaign file path; the Loop ID must be that same path followed by `#loop=<id>`. The parent resolves the existing `evopilot-private-campaign/v1` file and the selected loop. Structural validity establishes a link, not approval or live operational evidence.

The action collection must already have its own exact `collection.decide` approval. A `response.decide` record cannot impersonate that decision because evidence binds the operation, scope and review digest. The plan pins the operator-declared actor. Evidence checking verifies integrity and binding; it does not authenticate a human identity.

## Guidance profile and stop conditions

The additive `evopilot-response-runbook/v1` profile contains service, environment and source-revision applicability; exact parameters; at least one owner-backed operational prerequisite; one isolated action step; expiry; and an evidence freshness limit of 1–86,400 seconds. Workspace governance files cannot satisfy operational prerequisites. All timestamps are Unix seconds.

Every runbook declares the fixed stop conditions `SOURCE_DRIFT`, `PREREQUISITE_FAILED`, `GUIDANCE_WITHDRAWN`, `EXPIRED`, `TIMEOUT` and `UNKNOWN`. Runtime and the collection boundary enforce them: changed source or guidance cannot dispatch; stale, failed or missing prerequisites reject the plan; timeout and uncertain outcomes remain unresolved until their original receipts can be inspected. The runbook contains guidance, not shell commands or execution authority. Its description is never interpreted as an instruction to the host.

The shared response module is generated by the parent from TypeScript. It is additive to the frozen native v1 contract. Harness owns guidance publication, problem assessments, disposition history and recovery comparisons; Ontology owns optional domain semantics. Runtime owns execution identity and decisions.

## One admission, one original claim

Runtime captures the native revision before asynchronous preflight checks. It persists the response admission and then passes that exact revision to `collection.execute`. It does not refresh the revision to work around a conflict.

The retained native admission receipt must match the original request ID, operation, scope, input digest, native revision and collection claim. If another client executes the collection during preflight, this response remains `UNKNOWN` and cannot adopt, cancel or verify the competing claim. Reconciliation with no original admission receipt reports `RESPONSE_CLAIM_UNOWNED`; it cannot submit a replacement action.

Cancellation before admission is terminal without invoking the collector. Cancellation after admission is a request to the trusted collector and remains `CANCEL_REQUESTED` until a real interrupted receipt is retained. A cancellation request does not prove interruption. A repair requiring compensation needs its own separately reviewed plan; no rollback is inferred from failure.

## Recovery and asset learning

Verification requires all of the following:

1. The response's own successful action claim and protected raw receipt remain intact.
2. A trusted Harness recovery comparison matches the incident, binding, service, environment and deployment. The fault predates the action and the recovery follows it within the runbook freshness bound.
3. A separate, later collection supplies observations to a registered native Run bound to the exact native project, source and Goal. The action collection cannot serve as its own independent recovery evidence.
4. Existing `project.validate` confirms complete required results and retained owner receipts. Registered feedback must be enabled, delivered and given exact reviewed Harness and Ontology dispositions. A new asset delivery requires a Run evaluating the final pins.
5. `response.close` rechecks the verified references and requires a separately bound final decision.

Telemetry recovery alone does not prove a root cause or preventive fix. `response.execution.inspect` exposes a derived proof for Harness; Harness owns the decision to close its problem. A Runtime closure does not rewrite a Harness outcome, an Ontology assertion, a previous decision or a software-release state.

## Recovery compatibility and evidence

Response records share the owner's durable SQLite/audit storage and require schema-5 readers. Upgrade and rollback use the supported Workspace backup/restore flow; an older reader must not silently mutate newer response state. Historical native packages, claims, observations and decisions retain their original identities.

The source-checkout service tests at `tests/e2e/response.test.mjs` exercise real local action processes with explicitly synthetic owner callbacks and decision attestations. Tests are development files and are not included in the installed product package. They cover review rejection, stale guidance and prerequisites, source drift, concurrent foreign claims, lost responses, restart, cancellation, incomplete feedback and exact closure. Parent integration separately exercises real owners, the sandbox collector, native validators and recovery. These tests do not themselves constitute customer approval, production acceptance or release authority.

See the [Roadmap](roadmap.md), [service API](service.md) and [documentation index](README.md).
