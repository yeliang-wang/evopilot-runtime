# Runtime roadmap

Current edition: [RUN-F05 / v0.7 explainable workflow state and maintenance](#run-f05-v07-explainable-workflow-state-and-maintenance). Implemented for the v0.7 edition; exact publication and download records remain on the versioned Release page.

Runtime owns project execution, decisions, durable claims, receipts and audit. Ontology and Harness own their respective assets and validation; the parent composes their public package APIs and provides the Expert and Codex entry. The [parent roadmap](https://github.com/yeliang-wang/evopilot/blob/main/docs/roadmap.md) coordinates product evolution and v1.0 readiness.

This document distinguishes existing behavior, historical repair, proposed work and deferred targets. A roadmap entry is not an implementation, acceptance result or release decision. Exact verification and project-specific evidence remain private and candidate-bound.

## Existing behavior

Runtime provides scoped projects, immutable goals, exact Ontology/Harness pins, reviewed plans, human decisions, SQLite WAL/FULL persistence, revision CAS, idempotent receipts and atomic audit. Dispatch commits one durable claim before invoking trusted code. Uncertain execution is inspected and reconciled without redispatch. See the [service API](service.md).

The [standalone CLI](cli.md) provides discovery, bounded JSON requests and explicit workspace initialization. Project/goal planning and inspection need no execution provider. Preparing a run requires trusted material resolvers; execution and receipt inspection require their respective callbacks. The standalone bin configures none of these providers. [Parent EvoPilot](https://github.com/yeliang-wang/evopilot) documents composition and the Codex entry separately.

## Historical v0.1.1 repair

The [v0.1.1 Preview](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.1.1) repair covered strict TypeScript, compiled JavaScript/declarations, source and release packaging, public documentation, repository links and factual contributor attribution. Its scope preserved public API behavior, asset v1 contracts, vendor/provenance and historical code; it did not add feature scope or daily-state migration. [v0.1.0 Preview](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.1.0) remains the historical baseline. These historical scope statements do not restrict a separately approved later Target.

## v0.2.0 Workspace identity and recovery

The current source includes owner-scoped Workspace snapshot and same-host relocation APIs, described in [the service reference](service.md#workspace-snapshots-and-relocation). The parent coordinates quiescence, consistent copying and connection changes. Runtime verifies exact identity and snapshot digests and appends location lineage without rewriting historical business records, decisions, claims, receipts or audit.

Unresolved execution is inspected and reconciled without redispatch. Recovery must retain same-host key prerequisites and work written after cutover. Cross-machine recovery is outside this scope. This section records scope and source behavior, not a new claim that an installation, migration or release has passed acceptance.

## v0.3.0 Preview: corrected v1 contracts and project conformance

Published in the v0.3.0 Preview under the approved parent `governance/standards-v03.json` Target. This section retains that bounded standards-correction scope. Publication does not imply daily installation cutover, business-project acceptance or v1.0 readiness.

- Correct the shared contracts consumed with the owners' corrected `specifications/v1`. Do not create an asset `specifications/v2` merely to preserve the earlier incomplete standard. Preserve historical bytes and receipts; distinguish corrected material through explicit contract identity and the actual standard digest, not the `v1` string alone. The parent remains the canonical shared-contract producer.
- Bind prepared work, decisions, claims and results to exact source revisions, project scope, asset delivery references, applicable standard digests, effective configuration, tool identity and acceptance requirements. Drift invalidates reuse; old approval and old reports do not become evidence for a different candidate.
- Add controlled local collection recipes through the public provider boundary. Before execution, bind the executable, arguments, source snapshot, working directory, permitted outputs and applicable authority. After execution, retain exit status, raw output, tool/environment identity and a durable collection receipt. Only then can validation bind those actual observations. A user-editable JSON assertion is not proof that a command ran.
- Coordinate complete project acceptance against the fixed union of product and reviewed project requirements. Owners retain model and rule semantics; Runtime checks the required result identities, provenance and receipts. Missing, skipped, stale, unknown or conflicting results cannot become complete through an aggregate `passed` flag.
- Preserve bounded execution, timeout and cancellation handling, durable identity, idempotency, inspection and recovery. An uncertain or `UNKNOWN` outcome requires reconciliation before any dispatch decision; a retry must not silently repeat external work.
- Verify historical readback, isolated recovery and package/installed-entry identity before real-data cutover. The parent coordinates private project re-extraction and user journeys; public Roadmaps contain neither their content nor their progress.

The fixed acceptance must exercise stale source and configuration, changed standard digests, forged/imported observations, missing requirement IDs, partial output, timeout, cancellation, restart and uncertain results. Exact candidate evidence is required for both successful and correctly rejected cases. These baseline controls belong in v0.3.0 and are not deferred to the future targets below.

## Evolution targets

RUN-F01–F03 remain deferred product directions. `CANDIDATE` records a follow-up direction; `CONDITIONAL_RESEARCH` first requires a concrete need and feasibility review. Their versions and dates are not assigned. RUN-F04 has the bounded v0.6 implementation described below. Future extensions still require a demonstrated use case, bounded Target, compatibility review and concrete acceptance; these entries do not alter the parent's v1.0 readiness criteria.

### RUN-F01: external executor adapters

- **Status:** `CONDITIONAL_RESEARCH`; not scheduled.
- **Trigger:** A supported project needs repeatable execution through an existing CI system or a module executor such as [Dagger](https://docs.dagger.io/reference/modules/), beyond the bounded local collection recipe.
- **Scope and boundary:** Add explicit adapters through Runtime's public provider interface. Bind the authorized operation to the exact source, environment, command, inputs, asset/standard identity and receipt. Reuse the executor's build/test capabilities; do not build a competing CI platform or grant an arbitrary agent unlimited authority. Remote production deployment is not implied.
- **Acceptance:** Compare equivalent local/provider runs with pinned inputs; retain actual external run and artifact identities. Exercise authorization rejection, source/configuration drift, duplicate requests, timeout, cancellation, partial completion, lost responses, restart and reconciliation. Uncertain submission must be inspected, not resubmitted blindly. Secret references must remain references, with no secret bytes in public reports.

### RUN-F02: sustained reliability and scale budgets

- **Status:** `CANDIDATE`; broader reliability/scale work is not scheduled. Bounded Workspace maintenance and explanatory state are included in RUN-F05's accepted v0.7 plan below; implementation is isolated.
- **Trigger:** Multiple real projects or measured workload growth exposes limits beyond the current bounded asset and execution cases.
- **Scope and boundary:** Establish reproducible budgets for large asset packages, long-running execution, concurrency, storage growth and resource use, with candidate-bound benchmarks and recovery records. This is Runtime reliability work, not continuous monitoring of a project's production business service. Existing v0.3.0 timeout, bounded-resource and recovery requirements remain mandatory now.
- **Acceptance:** Define workload sizes and pass/fail thresholds before execution; record tool, hardware and environment identity. Test resource exhaustion, output limits, interrupted persistence, concurrent requests and recovery under load. Verify bounded failure without fabricated PASS results, duplicate execution, lost receipts or changes to immutable history. Publish synthetic reproducible fixtures and measurements without private project data.

### RUN-F03: explicitly selected source-drift checks

- **Status:** `CONDITIONAL_RESEARCH`; evaluate only when explicitly requested.
- **Trigger:** A user needs opt-in notifications or periodic/on-demand checks because project sources change outside an EvoPilot-guided session.
- **Scope and boundary:** Inspect the selected source scope against its bound revision and report changes with affected assets and recommended review or revalidation. Selection must identify scope, cadence if any, delivery destination and stop behavior. Do not promise real-time background synchronization; do not automatically rewrite assets, approve changes or publish software.
- **Acceptance:** With no selection, perform no scheduled checks or notifications. With explicit selection, detect covered source changes, report unresolved impact honestly, avoid repeated unchanged notifications, and support cancellation. Verify that changed files produce suggestions while asset deliveries, approval state and release state remain unchanged until their normal workflows run. Exclude secrets and unrelated private paths from notifications.

### RUN-F04: reviewed repair and runbook execution linkage

- **Status:** implemented for **v0.6.0 Preview** under the [parent response Target](https://github.com/yeliang-wang/evopilot/blob/main/governance/response-v06.json). This is Runtime's part of [EVO-F04](https://github.com/yeliang-wang/evopilot/blob/main/docs/roadmap.md#evo-f04--incident-response-and-asset-learning). Exact published commits and assets are recorded on the [Release page](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.6.0); this entry adds no v1.0 requirement.
- **Trigger:** a real project needs an online repair candidate connected to an approved action and verifiable outcome, beyond the v0.5 review-only ingestion flow.
- **Scope:** resolve the immutable Harness finding and selected guidance through public owner APIs; bind Workspace/project, incident/candidate, private Target/Loop ledger, existing Goal/Run, source revision, runbook revision/digest, environment, parameters, prerequisites, allowed operations and decision evidence. Target/Loop remain governance records unless a separately reviewed contract explicitly changes that model. Preserve the distinction between guidance, an executable plan and authority to dispatch it.
- **Execution:** retain claims and actual executor receipts, including failures, cancellations and partial actions. Read uncertain outcomes before any dispatch decision. Rollback/compensation requires a defined, authorized plan and its own receipts. Reuse the bounded provider boundary; adopt RUN-F01 only if the project demonstrates an additional executor need. No alert, runbook annotation or model recommendation authorizes an automatic patch release or production mutation.
- **Closure and feedback:** reference Harness recovery/regression evidence independently of command exit status. Link postmortem-derived proposals to the original observation and Run; reuse existing feedback delivery and exact owner REUSE/DELIVER decisions. Changed asset pins require re-evaluation; telemetry recovery alone cannot close the repair or establish root-cause removal.
- **Fixed acceptance:** own execution/linkage assertions for EVO-F04-E01–E05 and E08–E10; participate in E06–E07 scope and disposition checks. Test changed source/runbook/environment/parameters, forged or cross-project owner references, missing permission, timeout, cancellation, response loss, duplicate delivery, restart and retained historical readback. Prove no duplicate dispatch after uncertainty and no success inferred from a caller-supplied report. The owning cases live under `tests/e2e`; parent integration and actual Codex journeys independently verify the complete chain. Actual evidence remains private and exact-candidate-bound.
- **Compatibility:** v0.6 adds the response contract and database marker 5 while preserving native v1 specifications and immutable earlier records. Old readers reject newer state; supported backup/restore preserves response claims and cross-owner references. The supported action remains a pinned Node collector in an isolated copied directory. Java/Maven, remote executors and production remediation remain outside this scope.

## Product limits

Runtime is not a production SRE platform, a general CI replacement, a mechanism for granting arbitrary agents unlimited authority, or an automatic remote production deployment service. Ontology reasoning and Harness policy semantics remain owned by those products. Parent integration and Codex composition remain owned by [parent EvoPilot](https://github.com/yeliang-wang/evopilot).

Build, test, distribution and candidate-bound acceptance evidence is retained separately from this roadmap. Preview does not claim production readiness, GA, old 6.3 feature parity or arbitrary coding-agent support. Capability metadata carries no acceptance or release authority.

Return to the [documentation index](README.md) or [product entry](../README.md).

## Approved v0.4 execution feedback

Published in the v0.4 Preview under the parent [36-variant Target](https://github.com/yeliang-wang/evopilot/blob/main/governance/feedback-v04.json). This owner participates in registered execution feedback through its public APIs while preserving native v0.3 standards and historical records. Candidate-specific Host, recovery and release evidence remain private. v0.5 online Harness has the separate scope below; neither version authorizes v1.0.

## Approved v0.5: online Harness

The fixed [36-variant parent Target](https://github.com/yeliang-wang/evopilot/blob/main/governance/online-harness-v05.json) follows the published v0.4 Preview. This checkout implements that scope; exact candidate acceptance and release receipts remain external.

Harness owns immutable service/environment/deployment/SLO/policy bindings, actual Prometheus measurements, authenticated Alertmanager findings, native Rego evaluation, retained incidents and reviewable regression comparisons. Runtime receives trusted repair candidates; it does not infer a software version or dispatch an autonomous repair. Ontology standards and reviewed semantic evolution remain unchanged. The parent provides the explicitly enabled independent local worker and Expert journeys, with actual installed Codex acceptance.

The delivered scope is a bounded OpenSLO v1 RatioTimeslices profile and macOS arm64/launchd supervision. It does not establish full OpenSLO/Sloth compatibility, production business-SLO acceptance or v1.0 readiness. No second real project, WorkBuddy or original project mutation is included.

### Deferred online follow-ups

| Target candidate | Trigger | Required future evidence / boundary |
|---|---|---|
| Online retention and scale | Real projects reach bounded history/backlog limits | Reviewed retention/export semantics, immutable historical evidence, restart/load tests and explicit no-loss acceptance; no silent pruning |
| Additional supervisors/providers | A concrete project requires another platform or telemetry source | Pinned supported subset, real provider/Host E2E, credentials/network isolation and owned stop/recovery; no blanket compatibility claim |
| Additional SLO semantics | Several projects need calendar/composite/other budgeting methods | Versioned profile compatibility, upstream field/calculation comparisons, negative cases and preserved earlier approvals |

These remaining candidates are not uncompleted v0.5 or v0.6 criteria and have no assigned release date. They require their own reviewed Target. Reviewed response linkage moved into RUN-F04 for v0.6; existing v1.0 readiness conditions remain unchanged.

## v0.6.0 response implementation

RUN-F04 implements the approved parent [v0.6 response Target](https://github.com/yeliang-wang/evopilot/blob/main/governance/response-v06.json), including its execution and recovery portion of the 36 fixed variants. See [response execution](response.md) for the supported profile and API. Technical evidence and published artifacts are distinct; use the [Release page](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.6.0) to identify an actual distribution. Maintained core source uses strict TypeScript; native standards and historical records stay intact.

## RUN-F05: v0.7 explainable workflow state and maintenance

**Status:** `IMPLEMENTED` for v0.7.0 Preview. The parent execution Target fixes 50 acceptance variants. Actual source, installed Host, recovery and release evidence remain private and candidate-bound; this roadmap does not itself grant authority.

**Scope:** own the Runtime contribution to V07-T1–T3. Preserve safe typed prerequisites/errors through parent MCP; expose scoped execution/decision/receipt timelines, incomplete dependencies, already accepted decisions and permitted next steps. Separate asset-stage conformance from product E2E and release readiness. Parent Expert can explain which already authorized tasks remain actionable without treating a local dependency failure as a total project halt. This is not an autonomous Target/coding scheduler or a change to approval policy.

Support parent-coordinated capacity preflight and consistent larger-Workspace maintenance through owned snapshot/recovery APIs. The implementation Target must pin workload, file/byte limits, link/cache handling and time/memory budgets before code changes. Preserve audit, claims, decisions, cross-owner references and uncertain outcomes; interruption, resumed copying or restored state must not redispatch external work. No evidence deletion, live database copying, unbounded limit removal or silent backup exclusions are permitted shortcuts.

**Acceptance mapping:** V07-E01 distinguish owner prerequisites, validation failure, disconnection and uncertainty with safe correlation and retained receipts; E02 surface complete requirements before freeze; E04 show actionable versus blocked work and exact stage/product/release scope without deriving authority from a count; E05 reject stale dependent pins; E06 deterministic scoped queries and explicit cross-owner snapshot freshness; E07 representative-volume backup/isolated restore/interruption/corruption and upgrade recovery with immutable identities; E08 read-only local/Host journeys and current documentation. Cover owned behavior in `tests/e2e`, with parent `integration/e2e` and actual Codex evidence. Exact-candidate acceptance is recorded independently of this scope document.

The parent owns Codex report composition; Dashboard implementation is excluded. Rebuildable indexes cannot become another execution database; page views cannot dispatch or decide. Future Java/Maven and CI adapters stay in RUN-F01 and require real installed collection/Run/recovery evidence; isolated provider tests alone do not complete that direction. Autonomous scheduling and approval-policy changes need their own Targets and supported external-Agent interfaces. No extra LLM profile, general CI platform, WorkBuddy implementation or production automation is introduced by this plan. Existing v1.0 criteria remain unchanged; a release never silently switches an installation.

### v0.7 project planning addition

The approved parent V07-T0 adds project-scoped conversation provenance, immutable planning revisions and Runtime-owned Roadmap decisions/execution bindings. Ontology and Harness assets retain independent native validation and review. User planning stays private; native specifications/v1 remain unchanged. Installation changes follow the separately authorized stopped-state backup, recovery and Host verification procedure. See the parent [planning decision](https://github.com/yeliang-wang/evopilot/blob/main/docs/adr-planning.md).

## v0.8.2 Preview: transport documentation correction

This synchronized patch supports the parent transport guide and immutable content-specification correction. No owner operations, state markers, native standards or business behavior change. The parent correction Target retains the v0.8.1 acceptance obligations and requires new exact release/install verification. Existing releases and private records remain preserved.

## v0.8.3 Preview documentation closure

This synchronized maintenance release follows the accepted parent v0.8.1 plan and its 72 fixed variants. It corrects current-versus-historical guidance and installation routing, retains all original APIs and state semantics, and requires exact source, package, publication and installed readback evidence. No new product capability or execution authority is introduced.
