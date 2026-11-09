# Lifecycle correction in Runtime v0.9

This is a development implementation of the approved correction addendum. Its
presence is not a statement that the 709 Runtime acceptance cases have passed or
that Runtime v0.9 has been published. The [ADR](architecture/runtime-v090-correction.md)
defines the boundaries and migration requirements.

## Original facts and a proposed repair

Use the authenticated HTTP, HTTP MCP or CLI request envelope described in the
[API reference](lifecycle-api.md). Read `lifecycle.correction.inspect` for an
original stage request. It verifies the request and the immutable observation
envelope before presenting the failure. Mutable progress cannot substitute
another outcome, phase or reason.

`lifecycle.correction.propose` retains a hypothesis, minimal verification and
repository-relative change paths. It does not verify the hypothesis, run code,
approve a domain model or rewrite the original request. Stable mutation IDs
replay their existing receipt; changed input under the same ID is rejected.

`lifecycle.correction.admission` can inspect a retained proposal and perform
read-only trusted repair preparation. An eligible preview never grants execution:
the existing `lifecycle.stage.request` path repeats authority, semantic repair,
deadline and cumulative attempt checks before committing a new request. Each
external side effect must recheck them. Unknown outcomes require reconciliation
of the original request. A registered adapter may accept `stage.advance` to
inspect its original receipts first. If the outcome remains unknown, it stops
without side effects; only a resolved outcome and a fresh permission check can
allow the original request's remaining actions. This never creates another
attempt or redispatches an action already recorded.

No trusted verifier means `REPAIR_VERIFIER_UNAVAILABLE`; proposal text or a
changed plan timestamp cannot fill this gap. Native adapter integration and its
actual provider acceptance must be completed before claiming an installed
repair capability. A stage that has completed returns a completed/read-only
action; an expired request never suggests that its old execution window can be
renewed.

Native execution authority can link a successor instance through an explicit
`recoveryRootRef` in its reviewed authority subject. Read the original linkage
through `lifecycle.instance.inspect`; do not construct a replacement root from a
new directory, Host or request ID. The successor has its own exact decision and
retains the original lineage's remaining per-stage attempts, concurrency limits
and deadline. It cannot expand those limits, replace an unresolved original
action or bypass missing repair evidence. Legacy and injected authorities do
not acquire invented historical accounting. This linkage is separate from the
immutable original instance and its recorded outcomes.

## Independent checks and evidence

The deterministic branch planner preserves actual FAIL results, blocks their
dependants and permits planning of independent authorized branches. Serial
stateful groups stay together. Candidate identity, shared environment integrity,
authority and budget invalidations stop all affected branches. The planner
does not dispatch work and cannot make a failed required release gate pass.

Qualification is a separate versioned record. `PASS_REUSED` refers to an actual
original execution; it never relabels that execution with a new candidate.
Declared input closure includes direct and transitive source, tests, assertions,
generated/build inputs, locks, toolchain, configuration, environment, collector,
fixture, prestate, policy and validity. Unknown closure requires conservative
execution. Mandatory final execution and failure history cannot be hidden.

A trusted read-only verifier must check a separately retained native Harness
assessment and the current policy/trust state. A generic Harness PASS alone is
insufficient. Missing or unsupported owner policy blocks qualification. Neither
qualification nor a reused PASS establishes current environment state. The
current LC release auditor accepts executed evidence only; formal reuse needs
the separately integrated owner-policy and qualification consumption path.

Original CI artifact capture is also separate from qualification. A report
downloaded from an identified provider run can establish where those bytes came
from. It does not establish independent review of the collector, complete
history or a complete input closure. Captured PASS text therefore cannot grant
`PASS_REUSED`; missing report, provenance or policy facts remain explicit gaps.

The first capture profile recognizes the optional ZIP entry
`evidence/acceptance-report.json` with schema `runtime-ci-acceptance-report/v1`.
It must be declared in the original `runtime-ci/v1` check evidence alongside its
raw receipt and source-file proofs. The profile binds the original CI request,
source, workflow, candidate, requirements and producer job; it accepts at most
64 reported cases and 128 KiB per report or referenced file. Exact fields are
validated by [`inspectCiAcceptanceReport`](../src/adapters/artifacts.ts).
Report absence does not change the existing required CI artifact contract.

Protected `ci-acceptance-capture` records reference retained ZIP bytes and
preserve the original Runtime and derived CI request identities separately.
Pending, unknown, failed and later report observations are append-only and
deduplicated by content. A failed provider run retains unavailable case coverage
without making another artifact request. This profile preserves reported
outcomes; it does not yet produce an eligible `OriginalEvidenceExecution` or a
complete cross-attempt case history.

## Storage and rollback

Ordinary service state remains schema 1. The first committed correction,
recovery, qualification or CI acceptance capture record upgrades the state marker to schema 2 in the
same transaction. Failed writes do not upgrade it, and reopening cannot downgrade
it. Old readers that support only schema 1 reject newer state. Current snapshot
and restore preserve both schemas and original receipts. Downgrade recovery uses
a verified pre-upgrade snapshot and retains subsequent evidence separately;
never point an older binary at newer data.

## Acceptance

Original E01–E22 and UT01–UT24 remain 688 required cases. LC01–LC21 add 20 PRE
and one POST (LC12), for 709 required Runtime cases: 698 PRE and 11 POST. Every
declared vector in a composite LC is mandatory. Source regressions and byte
integrity checks do not establish actual Host/provider acceptance.

HO01–HO03 are a separate post-delivery handoff to the exact
`EvoPilot-ontology v0.9.0 Preview` chat. They verify installed identity, transfer
source/patches/evidence without reviving expired budgets, and exercise an actual
subsequent Ontology correction through the delivered Runtime. They do not add
three cases to the Runtime product denominator or require Ontology release
before Runtime release.
