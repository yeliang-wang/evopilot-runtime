# Runtime durable service

The current source targets the v0.1.1 repair under acceptance. The SDK behavior is unchanged; compiled JavaScript and declaration files are exposed through package exports. Source maintainers first run `npm ci --ignore-scripts` and `npm run build` with Node 24.14.0 and the locked TypeScript 5.9.3 compiler. Import `createRuntimeService` from `@evopilot-next/runtime/service`. Construction and `capabilities()` perform no filesystem operations. Call `initialize()` explicitly with `{workspaceRoot, workspaceId}` supplied at construction. The canonical absolute root must be outside source/Git trees, owned by the current OS uid, and empty or carry the exact shared `evopilot-workspace/v1` identity `{schema,id,canonicalRoot,ownerUid}`. Runtime owns `state/runtime/runtime.db`, SQLite WAL with FULL synchronization. Directories are 0700, files 0600; linked, foreign, unknown nonempty and mismatched identities are rejected.

This boundary assumes a non-malicious single OS uid and trusted code-injected adapters. It does not isolate state from hostile code running as that uid. Use Node 24.14.0 on a platform with OS uid support; SQLite is experimental. This is not a multi-user security boundary or a production-readiness statement.

To embed the service, supply an explicit workspace, construct the service, call `initialize()`, then create a scoped project and goal. With trusted providers configured, prepare a pinned plan, inspect its `reviewDigest`, record the human decision on that exact review, and dispatch only an approved run. Inspect retained receipts and run state after an uncertain response; reconcile the original claim rather than dispatching again. Close the service when finished. The [CLI guide](cli.md) provides concrete project/goal request envelopes.

[Parent EvoPilot Preview](https://github.com/yeliang-wang/evopilot) supplies actual native published Ontology/Harness resolvers and `execute`/`inspectReceipt` for representative quality and business validation. Its shared service and installed two-MCP-adapter integration have passing technical evidence. The parent Preview product entry is distributed separately. No arbitrary coding agent, new LLM or credential adapter is configured. Embedding this package yourself requires supplying the trusted callbacks below; standalone CLI requests do not configure them.

`execute({operation,scope,input,requestId,expectedRevision})` is synchronous. Every scope is exactly `{visibility:'public'|'private',projectId}`. Reads omit requestId and expectedRevision. `workspace.inspect` with `{}` returns the global Runtime revision. Writes use that revision for CAS. A request id is immutable within its exact scope; retries return its retained receipt before checking CAS. `receipt.inspect` takes `{requestId}`. Receipts carry the actual uid, timestamp, digest and revision. Run receipts include claim and immutable pin correlation. There is no logging of input or provider error text.

Operations:

- `project.create {name}`, `project.inspect {}`, `project.list {}`: exact scope only.
- `goal.create {id,description}`, `goal.inspect {id}`, `goal.list {}`: immutable goals in an existing project.
- `run.prepare {id,goalId,ontology,harness,input}`: exact six-field frozen reference contract, published material resolution and immutable PREPARED review; no execution.
- `run.decide {id,reviewDigest,decision:'APPROVE'|'REJECT',humanEvidenceRef}`: immutable local-uid decision on that exact review.
- `run.cancel {id,reviewDigest,humanEvidenceRef}`: records cancellation, retains the claim and unresolved external-work information; it does not assert external execution stopped.
- `run.inspect {id}`, `run.list {}`: exact scoped stage, plan, pins, review, decision, claim and outcome.

Each immutable reference has exactly `product`, `id`, `version`, `specVersion`, `digest` and `visibility`. Product is `ontology` or `harness` as appropriate, version is strict SemVer core, specVersion is `v1`, digest is `sha256:` plus 64 lowercase hex digits, and visibility is `public` or `private`. Obtain actual references from published material; do not substitute a latest-version selector or illustrative digest.

New composition input has exactly these fields:

```json
{
  "schema": "runtime-composition/v1",
  "ontologyInstance": {
    "entities": [{"id":"Asset:1","conceptRef":"domain/Asset@1","properties":{"quality.score":[0.75],"Lifecycle":["READY"]}}],
    "relations": [{"id":"Relation:1","relationRef":"domain/related@1","from":"Asset:1","to":"Asset:1"}]
  },
  "harness": {
    "mode": "component",
    "evidence": {
      "id": "evidence:1",
      "version": "1.0.0",
      "source": {"locator":"urn:evidence:1","revision":"revision:1","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
      "values": {"score":0.75}
    },
    "configuration": {"threshold":0.5}
  }
}
```

Runtime checks exact outer, entity, relation, evidence and source fields, bounded plain JSON, and entity/relation arrays of at most 1000 entries each. Entity properties map property identifiers to arrays of JSON primitives (strings, finite numbers including fractions, booleans, null); concept/property identifiers are not restricted to slugs. The owning Ontology adapter checks actual concepts, property types, enum membership and relation semantics against the pinned model.

Harness `mode` is required and exactly `component` or `composed`. Component evidence is one exact `{id,version,source:{locator,revision,digest},values:{}}` envelope. Composed evidence is an object keyed by exact component references, each containing that envelope. Component configuration is a plain JSON object of actual Harness parameters; composed configuration is the parameter dictionary keyed by exact component references. Reference keys, required leaf formats and evidence/configuration semantics belong to the trusted Harness adapter and pinned product API. The example parameter names illustrate a matching model, not built-in Runtime parameters. Runtime does not implement the core evaluator or infer missing evidence as PASS.

All strings, including source locators, remain inert descriptors; Runtime never opens paths, fetches URLs or executes commands from them. Unknown envelope fields such as `command` or `providerUrl`, functions and non-JSON values are refused. Existing persisted synthetic `facts` input remains readable and immutable under the existing state validator; it cannot be newly prepared under this changed pre-stable contract. No historical records are rewritten or claimed as migrated.

Pass trusted callbacks as the second construction argument. This code-injection boundary accepts only a plain or null-prototype object with the optional keys `resolveOntology`, `resolveHarness`, `execute`, `inspectReceipt`, `timeoutMs`. Present callbacks must be functions, and timeout must be an integer from 1 to 30000. Unknown keys, symbols, accessors, non-enumerable fields and proxies are rejected; descriptors are checked without calling getters (Node's proxy detection precedes reflection). Construction and capabilities do not invoke callbacks or initialize storage.

`resolveOntology` and `resolveHarness` synchronously receive frozen `{reference,scope,workspace}` and return exactly `{reference,scope,workspace,published:true,materialDigest,descriptor:{kind,digest}}`. Kind is `ontology-composition/v1` or `harness-composition/v1`; descriptor digest equals materialDigest. The callback attests verified immutable published material; caller flags cannot do so. Reference equality is checked by the preserved `inspectPinnedInputs` API. Workspace identity must match exactly. Public material must belong to the consuming project or the explicit `shared` project; private material must match the exact private project scope. Public runs cannot consume private material. Ambiguous resolution remains the explicit provider's responsibility. Promise resolvers are refused and late rejection consumed. No automatic latest resolution occurs. Scope and pin failures precede any claim and roll back revision/receipt changes.

`await service.dispatch({scope,id,requestId,expectedRevision})` requires approval and code-injected `execute`. It rechecks providers, materials and goal before committing one durable RUNNING claim with attemptCount 1. The transaction ends before invocation. The adapter receives a frozen argument object containing the deeply frozen claim data and a native `AbortSignal` in `signal`. The signal retains its native behavior; it is not cloned or recursively frozen. Code-only `timeoutMs` is an integer from 1 to 30000 milliseconds, default 30000, and applies to execution and receipt inspection. Timeout or close aborts local waiting; adapters must cooperate with the signal, and abort does not prove external work stopped. No caller-supplied closure or result enters this API.

The adapter returns exactly `{claimId,inputDigest,pins,providerReceiptId,status,result:{evaluation,evidenceDigest}}`. Status is explicit SUCCEEDED or FAILED; evaluation is the closed enum PASS, FAIL, ERROR, INDETERMINATE, N/A, NOT_CHECKED or NOT_EVALUATED, preserved independently of execution status. Outcome SUCCEEDED means adapter execution completed, never business acceptance: FAIL and INDETERMINATE remain those outcomes. Missing evidence never defaults to PASS. Result has exactly two fields, with no optional additions; providerReceiptId, exact pins, claimId, inputDigest and the SHA256 evidenceDigest bind external retained evidence. No released flag or action execution is provided. Empty, malformed or mismatched results, exceptions, interrupted calls and timeouts become UNKNOWN. State, completion receipt and audit are committed together. The initial request receipt records the durable claim; inspect the run for its latest outcome. Duplicate dispatch never invokes again, including after restart. Retained RUNNING is unresolved, never automatically replayed.

`await service.reconcile({scope,id,requestId,expectedRevision})` calls only trusted `inspectReceipt` with the original claim and signal. It accepts the same exact receipt shape. Unavailability leaves UNKNOWN. It creates no claim or attempt. Late original responses cannot overwrite a reconciled/terminal state. `close()` aborts local waiting and rejects further access; open an independent service to inspect durable state after restart. A close during execution retains unresolved RUNNING.

All JSON, state collections and receipts are bounded. Material stays in immutable bounded database JSON; Runtime does not load producer files or external blobs. Provenance records the read-only verified storage patterns adapted into owned code, with no runtime reference imports.

The standalone [CLI](cli.md) implements closed JSON validation, explicit workspace/revision requests and dispatch/reconcile routing. It supplies no external providers. Root capability metadata describes implemented generic service support and does not establish configured business readiness. Execution `status`, business validation and quality evaluation must be read independently: Runtime retains the closed aggregate `evaluation` and evidence binding, while detailed product results belong to the provider's retained evidence.

## Verification scope

Source checks cover strict TypeScript, consumer declarations resolved through the package root and service exports, package metadata, owned imports and pinned vendor bytes. Runtime tests cover discovery, workspace identity, exact scopes, revisions, immutable pins and decisions, CLI validation, absent providers, durable claims and reconciliation. These checks provide technical evidence independently of acceptance. Historical test counts do not establish the status of the current repair candidate.

For source development, run `npm ci --ignore-scripts`, `npm run build`, `npm run check`, then `npm test`. Build cleans generated dist and emits JavaScript/declarations; check verifies them. Full tests create isolated workspaces. The focused release check is `node --test tests/e2e/release-gate.test.mjs`. Installed tarballs contain compiled dist and declarations but omit development scripts/tests; package.json scripts are for source maintainers.

Current Desktop E01–E19 acceptance status comes from a separate exact-candidate-bound acceptance report; without that report, no Host acceptance claim may be made. Consult the separate candidate-bound acceptance report; technical composition and transport results do not establish Host PASS, old 6.3 feature parity, production readiness or release authority. Remaining work stays within the [approved 0.1.x roadmap](roadmap.md). Return to the [product entry](../README.md).
