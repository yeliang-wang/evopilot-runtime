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

The same read returns `nativeEvidence` for supported original extension and
verification requests. It rechecks protected action, receipt and terminal-outcome
links through the existing scoped readers, then summarizes the original native
criterion statuses. FAIL, ERROR, UNKNOWN and SKIPPED remain distinct. Missing,
detached or changed records return unavailable evidence. Even an original PASS
has `repairProof: false`: it does not bind a later minimal verification to the
failure, establish protected fault-relevant before/after inputs, classify the
engineering fault or prove cumulative repair rounds. These missing bindings remain
explicit; readback neither launches an owner validation nor grants a retry.

Engineering retry and cross-candidate evidence qualification have different
proof requirements. A retry needs authenticated original failure facts, the
inputs relevant to that particular fault, actual minimal verification and the
complete cumulative repair history within existing authority and bounds. It
does not require a separately published failure-classification asset or claim
complete cross-candidate dependency closure. An unclassified failure remains
ineligible; Runtime cannot reinterpret a Harness quality failure as an
engineering success. `PASS_REUSED` still requires the published Harness policy
and complete dependency closure described below.

`lifecycle.correction.propose` retains a hypothesis, minimal verification and
repository-relative change paths. It does not verify the hypothesis, run code,
approve a domain model or rewrite the original request. Stable mutation IDs
replay their existing receipt; changed input under the same ID is rejected.

For a non-source engineering repair, `proposedChanges` may be empty; do not
invent repository edits to describe restoring a declared tool. An optional
`verification: {instanceId, stageId}` selects an existing, unrequested native
check in the same recovery root. Passing the returned `correctionRef` to that
check's ordinary `lifecycle.stage.request` binds the original failed observation
and verification request before dispatch. It cannot attach verification to an
already executed check or add a node to the frozen graph.

The request claim and capture are committed together. A terminal native result
records a round with its original action, receipt and observation in the same
transaction as the stage outcome; unresolved actions do not create completed
rounds. Readback preserves failed rounds and completion order. Captured rounds
remain `repairVerified: false`: only the trusted adapter's separate examination
of the fault and actual verification can establish retry eligibility. The
capture also retains `completeInputClosure: false`; it is not a reuse certificate.

For a failed candidate-verification stage, the protected failure resource may
bind an exact published Harness `repairComparison` policy. Its separate actual
criteria assess comparability, regression and progress; an optional transient
criterion is required before treating a failure as transient. Error text alone
cannot establish that classification. This comparison binds every failed origin
in the original recovery root and the selected successor candidate before any
owner call. Private origin observations cannot be sent to a public policy scope.

A comparison whose required evidence is unavailable cannot authorize retry. If
the candidate itself passed but comparison input exceeds its supported bound,
Runtime preserves the candidate's real PASS and records comparison unavailability
separately. Refreshing policy registration metadata does not reset two completed
rounds without progress. A successor admission preview remains read-only and
must identify the exact retained correction proposal and recovery root.

An independent, predeclared sibling native check can run after its sibling
fails, subject to the existing graph and limits. A failed predecessor still
blocks its dependants. These APIs do not create a universal repair route for
every Base stage, and source fixture tests do not establish installed acceptance.

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

A separately reviewed successor that actually reruns a completed stage uses
its own bounded request window inside the unchanged original root window.
The prior successful request's one-shot cutoff does not expire this new
execution. Failed, unresolved and same-instance request cutoffs remain binding;
all cumulative attempts still count. This does not reuse the old PASS, renew an
expired root or alter any historical request or observation.

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
v1 release auditor accepts executed evidence only. The additive v2 native
qualification service prepares an exact assessment action, dispatches it once
under its original authority, and reads the actual published Harness receipt.
Uncertain dispatch requires inspection of that same request, never automatic
redispatch. Current credentials, grant, policy trust, complete history and input
inventories are checked again after asynchronous reads and synchronously before
single-result, batch-audit and review consumption.

The v2 release preflight distinguishes `EXECUTED` from `PASS_REUSED` and requires
all 698 PRE obligations. It produces review material, not release authority.
Registered service/API composition, formal collector integration and v2 release
authentication still require completion. The concrete closed-file fixture
producer exercises the protocol with actual inputs and retains failed attempts,
but is explicitly ineligible as formal acceptance evidence. Development tests
and native fixture experiments do not establish installed qualification support.

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
