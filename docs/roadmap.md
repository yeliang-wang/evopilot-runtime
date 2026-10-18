# Runtime roadmap

Runtime owns project execution, decisions, durable claims, receipts and audit. Ontology and Harness own their respective assets and validation; the parent composes their public package APIs and provides the Expert and Codex entry. The [parent roadmap](https://github.com/yeliang-wang/evopilot/blob/main/docs/roadmap.md) coordinates product evolution and v1.0 readiness.

This document distinguishes existing behavior, historical repair, proposed work and deferred targets. A roadmap entry is not an implementation, acceptance result or release decision. Exact verification and project-specific evidence remain private and candidate-bound.

## Existing behavior

Runtime provides scoped projects, immutable goals, exact Ontology/Harness pins, reviewed plans, human decisions, SQLite WAL/FULL persistence, revision CAS, idempotent receipts and atomic audit. Dispatch commits one durable claim before invoking trusted code. Uncertain execution is inspected and reconciled without redispatch. See the [service API](service.md).

The [standalone CLI](cli.md) provides discovery, bounded JSON requests and explicit workspace initialization. Project/goal planning and inspection need no execution provider. Preparing a run requires trusted material resolvers; execution and receipt inspection require their respective callbacks. The standalone bin configures none of these providers. [Parent EvoPilot](https://github.com/yeliang-wang/evopilot) documents composition and the Codex entry separately.

## Historical v0.1.1 repair

The [v0.1.1 Preview](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.1.1) repair covered strict TypeScript, compiled JavaScript/declarations, source and release packaging, public documentation, repository links and factual contributor attribution. Its scope preserved public API behavior, asset v1 contracts, vendor/provenance and historical code; it did not add feature scope or daily-state migration. [v0.1.0 Preview](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.1.0) remains the historical baseline. These historical scope statements do not restrict a separately approved later Target.

## v0.2.0 Workspace identity and recovery

The current source includes owner-scoped Workspace snapshot and same-host relocation APIs, described in [the service reference](service.md#same-host-workspace-snapshots-and-relocation). The parent coordinates quiescence, consistent copying and connection changes. Runtime verifies exact identity and snapshot digests and appends location lineage without rewriting historical business records, decisions, claims, receipts or audit.

Unresolved execution is inspected and reconciled without redispatch. Recovery must retain same-host key prerequisites and work written after cutover. Cross-machine recovery is outside this scope. This section records scope and source behavior, not a new claim that an installation, migration or release has passed acceptance.

## v0.3.0 Preview: corrected v1 contracts and project conformance

**Status: IMPLEMENTING.** The user-approved parent `governance/standards-v03.json` Target supplies bounded implementation authority. The native candidate is under verification; this Roadmap does not certify acceptance, installed cutover or publication.

- Correct the shared contracts consumed with the owners' corrected `specifications/v1`. Do not create an asset `specifications/v2` merely to preserve the earlier incomplete standard. Preserve historical bytes and receipts; distinguish corrected material through explicit contract identity and the actual standard digest, not the `v1` string alone. The parent remains the canonical shared-contract producer.
- Bind prepared work, decisions, claims and results to exact source revisions, project scope, asset delivery references, applicable standard digests, effective configuration, tool identity and acceptance requirements. Drift invalidates reuse; old approval and old reports do not become evidence for a different candidate.
- Add controlled local collection recipes through the public provider boundary. Before execution, bind the executable, arguments, source snapshot, working directory, permitted outputs and applicable authority. After execution, retain exit status, raw output, tool/environment identity and a durable collection receipt. Only then can validation bind those actual observations. A user-editable JSON assertion is not proof that a command ran.
- Coordinate complete project acceptance against the fixed union of product and reviewed project requirements. Owners retain model and rule semantics; Runtime checks the required result identities, provenance and receipts. Missing, skipped, stale, unknown or conflicting results cannot become complete through an aggregate `passed` flag.
- Preserve bounded execution, timeout and cancellation handling, durable identity, idempotency, inspection and recovery. An uncertain or `UNKNOWN` outcome requires reconciliation before any dispatch decision; a retry must not silently repeat external work.
- Verify historical readback, isolated recovery and package/installed-entry identity before real-data cutover. The parent coordinates private project re-extraction and user journeys; public Roadmaps contain neither their content nor their progress.

The fixed acceptance must exercise stale source and configuration, changed standard digests, forged/imported observations, missing requirement IDs, partial output, timeout, cancellation, restart and uncertain results. Exact candidate evidence is required for both successful and correctly rejected cases. These baseline controls belong in v0.3.0 and are not deferred to the future targets below.

## Deferred targets

These are product-direction records, not scheduled versions. `CANDIDATE` records a follow-up direction; `CONDITIONAL_RESEARCH` first requires a concrete need and feasibility review. No v0.4 date or automatic v1.0 requirement is assigned. Each entry needs a demonstrated use case, bounded Target, compatibility review and concrete acceptance before implementation. They do not alter the parent's existing v1.0 readiness criteria.

### RUN-F01: external executor adapters

- **Status:** `CONDITIONAL_RESEARCH`; not scheduled.
- **Trigger:** A supported project needs repeatable execution through an existing CI system or a module executor such as [Dagger](https://docs.dagger.io/reference/modules/), beyond the bounded local collection recipe.
- **Scope and boundary:** Add explicit adapters through Runtime's public provider interface. Bind the authorized operation to the exact source, environment, command, inputs, asset/standard identity and receipt. Reuse the executor's build/test capabilities; do not build a competing CI platform or grant an arbitrary agent unlimited authority. Remote production deployment is not implied.
- **Acceptance:** Compare equivalent local/provider runs with pinned inputs; retain actual external run and artifact identities. Exercise authorization rejection, source/configuration drift, duplicate requests, timeout, cancellation, partial completion, lost responses, restart and reconciliation. Uncertain submission must be inspected, not resubmitted blindly. Secret references must remain references, with no secret bytes in public reports.

### RUN-F02: sustained reliability and scale budgets

- **Status:** `CANDIDATE`; not scheduled.
- **Trigger:** Multiple real projects or measured workload growth exposes limits beyond the current bounded asset and execution cases.
- **Scope and boundary:** Establish reproducible budgets for large asset packages, long-running execution, concurrency, storage growth and resource use, with candidate-bound benchmarks and recovery records. This is Runtime reliability work, not continuous monitoring of a project's production business service. Existing v0.3.0 timeout, bounded-resource and recovery requirements remain mandatory now.
- **Acceptance:** Define workload sizes and pass/fail thresholds before execution; record tool, hardware and environment identity. Test resource exhaustion, output limits, interrupted persistence, concurrent requests and recovery under load. Verify bounded failure without fabricated PASS results, duplicate execution, lost receipts or changes to immutable history. Publish synthetic reproducible fixtures and measurements without private project data.

### RUN-F03: explicitly selected source-drift checks

- **Status:** `CONDITIONAL_RESEARCH`; evaluate only when explicitly requested.
- **Trigger:** A user needs opt-in notifications or periodic/on-demand checks because project sources change outside an EvoPilot-guided session.
- **Scope and boundary:** Inspect the selected source scope against its bound revision and report changes with affected assets and recommended review or revalidation. Selection must identify scope, cadence if any, delivery destination and stop behavior. Do not promise real-time background synchronization; do not automatically rewrite assets, approve changes or publish software.
- **Acceptance:** With no selection, perform no scheduled checks or notifications. With explicit selection, detect covered source changes, report unresolved impact honestly, avoid repeated unchanged notifications, and support cancellation. Verify that changed files produce suggestions while asset deliveries, approval state and release state remain unchanged until their normal workflows run. Exclude secrets and unrelated private paths from notifications.

## Product limits

Runtime is not a production SRE platform, a general CI replacement, a mechanism for granting arbitrary agents unlimited authority, or an automatic remote production deployment service. Ontology reasoning and Harness policy semantics remain owned by those products. Parent integration and Codex composition remain owned by [parent EvoPilot](https://github.com/yeliang-wang/evopilot).

Build, test, distribution and candidate-bound acceptance evidence is retained separately from this roadmap. Preview does not claim production readiness, GA, old 6.3 feature parity or arbitrary coding-agent support. Capability metadata carries no acceptance or release authority.

Return to the [documentation index](README.md) or [product entry](../README.md).

## Approved v0.4 execution feedback

Status: implementing the parent [36-variant Target](https://github.com/yeliang-wang/evopilot/blob/main/governance/feedback-v04.json). Add this owner's capture/delivery or impact-review responsibilities through public APIs, preserve native v0.3 standards and historical records, and verify real Host, restart, upgrade, source CI and release readback. v0.5 online Harness work remains a separate target; neither authorizes v1.0.

## Approved v0.5: online Harness

The fixed [36-variant parent Target](https://github.com/yeliang-wang/evopilot/blob/main/governance/online-harness-v05.json) follows the published v0.4 Preview. This checkout is implementing that scope; exact candidate acceptance and release receipts remain external.

Harness owns immutable service/environment/deployment/SLO/policy bindings, actual Prometheus measurements, authenticated Alertmanager findings, native Rego evaluation, retained incidents and reviewable regression comparisons. Runtime receives trusted repair candidates; it does not infer a software version or dispatch an autonomous repair. Ontology standards and reviewed semantic evolution remain unchanged. The parent provides the explicitly enabled independent local worker and Expert journeys, with actual installed Codex acceptance.

The delivered scope is a bounded OpenSLO v1 RatioTimeslices profile and macOS arm64/launchd supervision. It does not establish full OpenSLO/Sloth compatibility, production business-SLO acceptance or v1.0 readiness. No second real project, WorkBuddy or original project mutation is included.

### Deferred online follow-ups

| Target candidate | Trigger | Required future evidence / boundary |
|---|---|---|
| Online retention and scale | Real projects reach bounded history/backlog limits | Reviewed retention/export semantics, immutable historical evidence, restart/load tests and explicit no-loss acceptance; no silent pruning |
| Additional supervisors/providers | A concrete project requires another platform or telemetry source | Pinned supported subset, real provider/Host E2E, credentials/network isolation and owned stop/recovery; no blanket compatibility claim |
| Reviewed repair execution linkage | Real users need repair candidates connected to a concrete approved Target | Explicit candidate/Target/source/version mapping, reviewed authority, real executor receipts, failure/recovery tests; never automatic patch release from Warning |
| Additional SLO semantics | Several projects need calendar/composite/other budgeting methods | Versioned profile compatibility, upstream field/calculation comparisons, negative cases and preserved earlier approvals |

These candidates are not uncompleted v0.5 criteria and have no assigned release date. They require their own reviewed Target. Existing v1.0 readiness conditions remain unchanged.
