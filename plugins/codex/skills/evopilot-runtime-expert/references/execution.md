# Governed execution

Inspect the current active definition, exact project source and existing target
context. A goal/loop/target is not an execution permit. Save a complete immutable
`lifecycle.preparation.save` packet: exact definition revision, goal/target/loop,
target version/scope/exclusions, source baseline, plan/impact/verification/rollback
documents, applicable migration document and every fixed verification row.
Read `lifecycle.preparation.read` for the original packet when resuming.

Use `lifecycle.authority.preview` for an exact execution subject. Show concrete
scope, budget, resources and unresolved issues where a real user decision is
missing. Record only the actual applicable decision through
`lifecycle.authority.record` and its configured evidence reference. Broad product
implementation authorization is not a domain semantic or software release
decision. Never author synthetic decision evidence for a real project.

With current execution authority, create the pinned `lifecycle.instance.create`
instance once. Inspect `lifecycle.stage.admission` and request eligible stages
through `lifecycle.stage.request`. The service chooses registered adapters;
Codex cannot supply an arbitrary executable. Keep original request IDs, input
digests, deadlines, artifact identities and attempt counts.

The eight stages are scope, plan, implementation, candidate, verification,
release-decision, publication and closure, with configured extensions joined by
AND. Scope/plan do not require fabricated future CI or candidate results.
Verification consumes the exact produced candidate; it cannot rebuild a different
one and call it accepted. Preparation operations may update source only in their
allowed slot; the next candidate must bind the resulting verified source.

When implementation is `WAITING_AGENT`, read `lifecycle.agent.handoff.read`.
Use this actual Codex Host to claim the exact task, inspect permitted workspace
and capabilities, report progress, implement the approved scope, and submit the
real output/source-change/artifact identities through `lifecycle.agent.report`.
Do not substitute model text for committed output or impersonate another Host.
Record provider/model/usage only when actually available; unknown is not zero.
Runtime does not launch Codex, borrow its login or relax Host permissions.

Use `lifecycle.implementation.review.preview` and `.record` for the exact source
review when required. Configured project scope reviews use
`lifecycle.extension.review.preview` / `.record`. Read the service's concrete
subject and evidence before any real decision; later source or configuration
drift requires currentness checks, not historical approval reuse by name.

Inspect `lifecycle.stage.request.inspect` while CI or the Agent is pending.
Use `lifecycle.stage.advance` only when it resumes the original authorized work,
such as native validation after original CI completes. A retained unknown native
request is inspected, never silently sent again. Respect exhausted or revoked
authority, original stage budgets and explicit stop conditions. Independent
branches may proceed only where the actual DAG and authority permit them.

For release, inspect `lifecycle.release.evidence.read` and exact candidate-bound
material. Obtain/record the applicable separate release decision through the
authority workflow. Publication then uses the configured reviewed CI workflow
and reads back actual channel/artifact identities. Never claim a product release
from a fixture, generated release notes or a green source test.

Closure requires selected delivery acceptance, original evidence/archive and
both owners' required feedback dispositions. Keep Ontology/Harness REUSE or
DELIVER decisions in their owning workflow; observations do not approve them.
Report actual lifecycle status, incomplete checks, exact receipts and remaining
conditions. Completion cannot omit a required skipped/unknown/failed item.
