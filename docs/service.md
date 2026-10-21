# Runtime service and native evidence — v0.6.0 Preview

Runtime coordinates exact project candidates, collection recipes, decisions, claims, receipts and completion. Ontology owns RDF/SHACL meaning and Harness owns Rego policy evaluation. The corrected `specifications/v1` flow uses the current shared native contract revision **1.1.0**, its content digest and each owner's exact standard/lock digests. A directory named `v1` is not sufficient identity.

Import `createRuntimeService` from `@evopilot-next/runtime/service`. Construction and `capabilities()` do not initialize a Workspace. Call `initialize()` explicitly before operations, and `close()` when done. Node 24.14.0 or later is required. Source maintainers run `npm ci --ignore-scripts`, `npm run build`, `npm run check`, then `npm test`. Package exports include strict TypeScript declarations; installed distributions contain compiled code and omit development tests/scripts.

## Workspace and trust

Construction takes `{workspaceRoot, workspaceId}`. The canonical absolute root must be outside source/Git trees, owned by the current uid and empty or contain the exact shared `evopilot-workspace/v1` identity. Private directories are 0700 and files 0600; symlinks, hard-linked files, foreign ownership and unexpected identities fail closed. Runtime owns SQLite WAL/FULL storage in `state/runtime/runtime.db` and protected collection files in `state/runtime-native/<claim-digest>/`.

Adapters are trusted code injected at construction, not request-supplied functions, executables selected by the model, or dynamically loaded URLs. This is a single OS-user trust boundary; it is not an OS sandbox against malicious code running as that user. The parent EvoPilot adapter owns shell-free subprocess launch, executable/toolchain integrity, process cancellation and declared network enforcement. A recipe's declaration alone does not prove network isolation.

## Current public API

Use `await service.native(request)` for new native work. Every request has `{operation, scope, input}`, where scope is exactly `{visibility:'public'|'private', projectId}`. Writes additionally require `requestId` and `expectedRevision`; reads cannot contain them. Native `workspace.inspect` supplies the native revision, separate from the preserved historical revision. Same-scope request replay returns the exact retained receipt; changed input under the same ID conflicts. New stale writes fail CAS. Write results are `{requestId,operation,scope,requestDigest,revision,result,timestamp}`.

| Operation | Input | Effect |
| --- | --- | --- |
| `workspace.inspect` | `{}` | Current native identity and revision |
| `receipt.inspect` | `{requestId}` | Retained native operation receipt |
| `project.prepare` | `{id,goalId,sourceScope,standardPins,requirements}` | Freeze project candidate and independently resolved denominator |
| `project.inspect`, `project.list` | `{id}` / `{}` | Scoped candidates |
| `collection.prepare` | `{id,projectId,recipe}` | Freeze prospective collection recipe; no future output digest is invented |
| `collection.decide` | `{id,reviewDigest,decision,humanEvidenceRef}` | Exact APPROVE/REJECT decision |
| `collection.execute` | `{id}` | Persist one claim, then call collector |
| `collection.reconcile` | `{id}` | Inspect original claim only |
| `collection.inspect`, `collection.list` | `{id}` / `{}` | Collection state; inspect verifies retained raw bytes |
| `run.prepare` | `{id,projectId,goalId,ontology,harness,input}` | Bind published native references, actual collection receipts and fixed configuration |
| `run.decide` | `{id,reviewDigest,decision,humanEvidenceRef}` | Exact Run decision |
| `run.dispatch`, `run.reconcile` | `{id}` | Execute once / inspect original claim |
| `run.inspect`, `run.list` | `{id}` / `{}` | Scoped immutable plans and outcomes |
| `project.validate` | `{id,runId}` | Recheck full evidence closure and return exact final review digest |
| `project.complete` | `{id,runId,reviewDigest,humanEvidenceRef}` | Record the decision on that exact validated candidate |

`project.validate` is a write because its result is retained as evidence. A successful validation returns `authority:false`; it does not authorize completion or software release. Human evidence references must identify the actual existing authorization, not a fabricated approval.

## Source, references and fixed requirements

`NativeSourceScope` is `{direction,locator,revision,treeDigest,inventoryDigest,requirementsDigest}`; direction is `forward` or `reverse`. A trusted independent reader verifies it. `resolveRequirements` returns the frozen requirements independently of the submission: each has `{criterionId,variantIds,origin}`, with nonempty criteria/variants and unique `(criterionId, variantId)` identities. A case ID may serve different criteria; the same pair cannot occur twice. Origins are `execution-result`, `source-declaration` or `design-declaration`. The caller cannot shrink the denominator to match available results. Source-only and design-only evidence cannot satisfy an execution-result requirement.

Native references contain the six historical identity fields plus `standardDigest`, `standardLockDigest`, `producer` and `contractDigest`. Only current, published, exact material is accepted; no latest selector or silent fallback exists. Private material belongs to the exact project. Public material must belong to the project or explicit `shared` scope. Runtime checks references and owner material readback; it does not publish Ontology or Harness packages.

Native composition is exactly `{schema:'runtime-composition/v1',contractDigest,projectCandidateDigest,standardPins,sourceScope,requirements,effectiveConfig,nativeInputs:{ontology,harness},collectionReceipts}`. Collection references are `{id,digest}`. The current execution-result path uses **one** explicitly normalized collection receipt. Harness input must include an `evopilot-observation/v1` whose source identity, receipt ID/digest/claim, source-scope digest and values equal Runtime's protected raw-derived observations. Arbitrary JSON labeled `execution-result` is insufficient.

## Controlled collection

`CollectionRecipe` freezes the source scope, absolute executable and digest, argv array, canonical cwd, environment allowlist, toolchain lock digest, timeout, output byte bound, exact relative output allowlist, network declaration and selectors. Every selector has `{id,output,kind,pointer}`. Runtime's bounds are 600000 ms per recipe, 32 MiB total output, 256 output paths and 256 arguments. The public types are authoritative for exact fields.

| Selector | Fixed semantics |
| --- | --- |
| `json-pointer` | RFC 6901 pointer into one UTF-8 JSON document; missing paths fail |
| `exit-code` | Actual collector exit code, with empty pointer |
| `junit-total` | Count actual JUnit testcase elements |
| `junit-failures`, `junit-errors`, `junit-skipped` | Count corresponding testcase outcomes |
| `json-lines-count` | Count nonempty UTF-8 JSON-object log records |

All selectors except JSON Pointer require an empty pointer. JUnit supports a `testsuites` or `testsuite` root containing `testsuite`, `testcase`, properties, failure/error/skipped, system-out and system-err; suite totals, when declared, must agree with actual cases. Nested `testsuite` is supported. XML is bounded to 64 levels and 250000 tokens. DTD, external entities, arbitrary processing instructions, XPath, ambiguous testcase outcomes, malformed XML and unknown dialects fail closed. JSON Lines is bounded to 100000 records. Original XML/JSONL remains in the receipt's raw-file inventory; no external author supplies replacement counters.

The collector receives `{claim,artifactRoot,signal}` after durable claim persistence. It writes private files under that root and returns only claim/recipe/source identity, start/end times, exit code, signal, timeout/interruption/error and `{path,mediaType,sha256}` raw references. Runtime reads, hashes and parses the bytes itself, then stores the receipt. Parse errors, nonzero exit, missing outputs and timeouts preserve available raw evidence with a FAILED outcome. Malformed receipts or unavailable adapters remain UNKNOWN.

`collect` invokes external work; `inspectCollection` only reads its previously retained receipt. The same claim has `attemptCount:1`. Duplicate execution, restart and reconciliation never silently launch a second process. An adapter must honor the recipe timeout; Runtime also bounds its wait to the recipe timeout plus 2000 ms. Aborting a wait is not proof external work stopped. The adapter must retain its receipt independently so an interrupted Runtime can reconcile it.

## Trusted owner providers and completion

`NativeRuntimeProviders` exports the exact callback types: `nativeStandards`, `inspectSource`, `resolveRequirements`, `collect`, `inspectCollection`, `resolveNative`, `executeNative`, `inspectNative`, `readOwnerReceipt`. Providers are fixed at construction. The native owner executor receives `{claim,signal}`; its claim includes exact source/configuration/requirements digests and immutable owner references. Runtime waits at most 60000 ms for an owner execution or inspection response.

The provider receipt binds the native contract, Runtime producer, claim, input, project candidate, owner references and standards. Both owner receipts carry the exact `NativeValidationContext`, execution and quality statuses, report digest and individual criterion/variant results. Runtime reads each receipt back through `readOwnerReceipt` and requires exact equality. Returned text saying PASS is not sufficient.

Completion requires fresh source, untampered raw files, current standard pins, both owners' execution SUCCEEDED and quality PASS, and every frozen criterion/variant appearing exactly once with PASS. Missing, duplicate, skipped, failed, unknown, unsupported and extra variants block completion. Successful subprocess or owner execution alone is not business acceptance.

## Historical compatibility

The original revision-1.0.0 `reference.mjs` bytes remain unchanged for historical reads. Existing legacy JSON state and receipt rows are not rewritten into native evidence. `execute()` still exposes historical inspection and existing project/goal administration; new legacy `run.prepare`, `run.decide` and `dispatch()` reject with `HISTORICAL_READ_ONLY`. Original legacy claims may be inspected/reconciled; existing cancellation records do not prove external work stopped.

First explicit native use adds separate native tables and marks SQLite `user_version=2`. Unknown native contract/producer markers are rejected. Older version-1-only readers reject this newer database rather than writing through it. Do not downgrade an active native Workspace; restore only a verified pre-upgrade backup at its original location, with services stopped and later writes preserved separately.

## Workspace snapshots and relocation

`@evopilot-next/runtime/workspace-migration` exports `inspectWorkspaceSnapshot` and `relocateWorkspaceSnapshot`. Snapshot reads existing state without initialization. It covers legacy and native state/receipt/audit digests, all protected native collection files, unresolved work and same-host relocation key identities. Missing or changed native raw evidence fails inspection.

The parent must quiesce services and make a complete private copy. Relocation checks both the source and copied destination against the supplied snapshot, then adds signed same-host location lineage. It never rewrites business records, candidates, decisions, original claims or receipts. Existing original-location bindings remain readable only through that lineage. Pending old-location work requires new preparation and review; original claims may only reconcile. Retain local keys in `~/.local/share/evopilot/relocation-keys/`; cross-machine key import is not supported.

## Evidence and acceptance

The Runtime tests exercise its public API using synthetic owner receipts and real isolated child processes. They verify native parsing, immutable decisions, raw integrity, fixed completion requirements, crash/restart and relocation. Historical fixture tests are explicitly labeled and do not prove current native behavior. Full product acceptance additionally requires real Ontology/Harness validators, parent integration, independently frozen acceptance instances and the exact Desktop candidate. Passing this repository's tests does not establish complete product acceptance or release authority. The parent [v0.6 response Target](https://github.com/yeliang-wang/evopilot/blob/main/governance/response-v06.json) defines 36 fixed variants for the current response, transport and language scope; the historical v0.3 standards-correction denominator remains separate.

See [CLI usage](cli.md), [the approved roadmap](roadmap.md) and the [product entry](../README.md).

### Same-machine hostname changes

On macOS, relocation records bind the configured `LocalHostName.local` when the
system supplies a valid local name. Readback recognizes that configured name or
the current OS hostname, so a network-assigned hostname does not invalidate the
same machine's signed records. Other platforms retain exact current-hostname
binding. Home directory, uid, private local key, HMAC, source/destination chain,
and historical receipt digests must still verify. A foreign configured/current
name or missing key is rejected; caller-provided host overrides are unsupported.
Existing signed records and business data are never rewritten. This does not
provide cross-machine restore.

## Additive v0.4–v0.6 APIs

The public `feedback(envelope)`, `online(envelope)` and `response(envelope)` APIs each have their own revision, read through `feedback.inspect`, `online.inspect` or `response.inspect`. Do not reuse the native workspace revision for these mutations. See [feedback contract and workflow](feedback.md), [online repair candidates](online-repair.md) and [reviewed response execution](response.md). Trusted providers are configured by the parent composition, never through caller payloads.

Response writes advance the owner database marker to 5. Native, feedback and online historical records retain their original identities. Use supported stopped-state backup/restore and matching readers; a prior-version installation must not write newer response state.
