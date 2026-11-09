# Bounded lifecycle correction

First check the connected service's actual operations. Older installations may
not expose correction APIs; a newer Skill is not proof that they are available.
Use `lifecycle.correction.inspect` with the original `stageRequestId` to read
retained execution facts. Read only relevant detailed evidence on demand.

Propose one falsifiable cause, a minimal verification and a bounded change scope
through `lifecycle.correction.propose`. Its input is `stageRequestId`,
`hypothesis`, `minimalVerification`, and `proposedChanges` (repository-relative
`path` and `expectedEffect` for each change). Use the usual stable mutation
request and revision. The resulting `correctionRef` records a proposal, not a
verified cause, approved semantics, execution grant or quality PASS.

Use an empty `proposedChanges` array for a non-source repair instead of inventing
file edits. When the pinned graph already contains an appropriate unrequested
native check, `verification: {instanceId, stageId}` may pre-bind it to the current
confirmed failure within the same native recovery root. Request that exact check
through `lifecycle.stage.request` with the returned `correctionRef`; all ordinary
graph, authority and budget checks still apply. Do not attach a finished check,
create an arbitrary runner or bypass a failed predecessor. Captured rounds are
historical proof of the check's execution, not a retry approval by themselves.

Query `lifecycle.correction.admission` with the original `stageRequestId` and
the retained `correctionRef`. A response such as
`VERIFIED_REPAIR_ADMISSION_REQUIRED` means the trusted repair verification is
not available or not complete. Do not bypass it through direct CLI, a new
request, a new directory, another Host or another instance. Follow actual
registered execution routes only after the applicable admission succeeds;
there is no arbitrary `correction.execute` endpoint.

UNKNOWN and lost responses require observation of the original request and
receipt. They are not failed attempts that can be blindly resubmitted. A
deterministic failure with no verified change must not be dispatched again.
Two repair rounds with the same cause and no progress stop that path for
reassessment. Existing cumulative attempt and time limits still apply.

For an engineering retry, use protected original fault facts, relevant observed
inputs and actual minimal verification. Do not invent a requirement to publish
a new Harness failure-classification asset for every repair. Unknown causes
remain unknown, and engineering recovery cannot override the owner's quality
verdict. Complete dependency closure and a published qualification policy apply
separately to cross-candidate `PASS_REUSED`, as described below.

For a successor instance, read the original native recovery linkage through
`lifecycle.instance.inspect`. Include its exact `recoveryRootRef` in the new
execution authority subject for review; do not infer that the original decision
approved a different instance. A link preserves the original remaining bounds
and does not supply missing repair proof. If no historical native root exists,
do not invent or backfill one. Expired roots allow historical reads only.

A captured CI report is an original observation, not a reuse decision. Missing
collector review, complete history, input closure or a published Harness
assessment must remain unavailable; do not turn captured PASS text into a
current candidate qualification.

Keep a failed result. Block its dependent branches, but continue genuinely
independent authorized branches with clean inputs, fixtures and remaining
resources. Serial stateful groups cannot be split. Candidate identity, shared
environment integrity, authority or budget failures stop all affected work.
Continuing independent checks never makes a failed required release gate pass.

Collect independent faults on the fixed RC, make isolated batch repairs and
run targeted regressions before freezing the next RC. Never swap a package
under an active acceptance run. A reused result is a new current qualification
that references an original execution; it is not a new execution of that test.
Only a supported published Harness policy and a complete, current dependency
closure can establish `PASS_REUSED`. Missing evidence, unknown impact, expiry,
fixed final must-run checks and required live state must not be hidden by reuse.

Report the original request, verified facts, hypothesis, changed inputs,
remaining blockers and actual usage. Missing usage is unknown, not zero. Keep
full evidence and all earlier failures; the summary is only an index.
