# Runtime v0.9 independence and lifecycle boundary

Status: user-approved direction; implementation in progress, acceptance not evaluated.

Runtime owns its version, release, deterministic service, lifecycle state/gates,
Expert Skill, HTTP MCP, CLI, installation and exactly two Dashboard pages. The
parent becomes a documentation/index site and issues no new product release.
Ontology and Harness remain separately versioned asset owners; this target uses
their published APIs and does not implement their next versions.

The versioned publisher Base defines eight required stages. Project YAML pins a
single Base and stores constrained configuration/extensions. Runtime derives the
effective definition. Instances pin immutable definitions and actual receipts;
editing YAML cannot fabricate decisions, results, or mutate an in-flight instance.
Project extensions use four declared slots and AND joins, never weaker gates.

Codex loads Runtime Expert, performs reasoning/coding, and calls standard HTTP
MCP. Runtime has no LLM Profile, embedded Agent loop or model credentials. A
single plugin provides Skill and MCP connection configuration. CLI and Dashboard
share the same authenticated, scoped service, with no second writer.

Configuration closes in the originating entry: Codex wizard can enable without
opening Dashboard; the existing editor can save a draft or save and enable an
exact revision without returning to Codex. The monitor is read-only. Activation
requires existing permission and all Base checks, records exact user intent,
and does not start a Run, approve assets or release software. Validation failure
leaves the draft recoverable and the previous active definition intact.

Compatibility and migration: preserve published native standards/vendor bytes,
old API/history/receipts and owner state. Thin stdio compatibility forwards to the
same service. Verify backup, isolated migration and rollback before daily cutover;
old binaries must not open newer incompatible stores. Preserve newly generated
evidence during recovery. Existing projects with missing configuration stay
uninitialized; no DataRig database/SSH or production E2E is implied.

Alternatives considered: retaining the parent runtime fails independence;
splitting all three owners now expands scope; requiring editor-to-chat approval
forces needless switching; a full approval portal exceeds the minimum unit.
Use one modular local service and the two existing page purposes instead.

This direction supersedes historical pre-v1.0 Dashboard exclusion and parent-only
integration ownership for this exact target. It does not rewrite historical
versions or authorize additional UI, cloud deployment, owner mutations or release.

Verification: the [acceptance catalog](../../governance/acceptance-v090.json)
retains 64 groups, 22 scenarios, 12 extension subcases, 6 closure variants and 8
audit additions. P04 belongs only to post-release E22. Exact M0 parameter bindings
and real platform/Host/browser evidence remain required. Governance validation
does not prove product functionality or authenticate human authority.

## Development service foundation

The development tree now supplies `evopilot-runtime` (compiled entry
`dist/server/cli.js`) alongside the historical compatibility CLI. Its metadata
retains the baseline package version until an exact v0.9 release candidate is
prepared; `developmentTarget: 0.9.0` does not claim a published version.

For an isolated local state directory, run `auth-init` with explicit
`--state-root`, `--workspace-id`, `--project`, `--principal` and
`--role reader|editor|activator`. This creates a private, expiring service
credential and prints only its `tokenRef`. It refuses to overwrite existing
credentials. Roles do not authorize business execution or software publication.
Then `serve --state-root <directory> --workspace-id <id> [--port <port>]`
starts a loopback listener. `status --url <origin> --token-ref <file>
--project <id>` reads it over authenticated HTTP. Never pass raw tokens in
command arguments, URLs or YAML. These development commands do not modify the
current Codex installation or migrate an existing workspace.

The `/api/v1/request` and `/mcp` surfaces share one scoped dispatcher.
`runtime_read` only accepts read operations; `runtime_write` requires the
corresponding current role, project revision and idempotency key.
`/api/v1/events` streams bounded, persistent project events and
closes on revoked credentials. An OS-managed exclusive SQLite lock prevents a
second writer; object changes, receipts, audit and events commit together.
Restart rejects incompatible schemas and inconsistent receipt/event digests.

## Development lifecycle definitions and instances

The package includes a publisher-pinned Base manifest under `lifecycle/base`.
The compiler enforces all 84 declared fields, the chosen provider branch, four
extension slots and mandatory AND joins. Unknown fields, duplicate YAML keys,
dynamic tags/aliases, inline secrets and mutable Base identities are rejected.
Comments and supported presentation fields have separate source/presentation
digests; they do not alter the execution-semantic digest.

`lifecycle.draft.save` preserves the original non-secret YAML, including an
incomplete draft. `lifecycle.definition.validate` returns field-level diagnostics
and an exact preview digest only when current trusted references pass.
`lifecycle.definition.activate` and `lifecycle.definition.save-and-activate`
require that exact preview and existing activation permission. Failed admission
keeps the draft and old active pointer; an exact replay returns its original
receipt. `lifecycle.definition.source.read` retrieves bounded source chunks.
The CLI `request --url <origin> --token-ref <file> --project <id>
--request-ref <protected-json-envelope>` uses the same HTTP checks and never
retries an uncertain write automatically.

`lifecycle.instance.create` additionally requires `execution.request` permission
and a separately resolved exact authority record. It persists an inert instance
with its definition, Base, requirements, goal/target/loop references and budget
pinned. Definition activation alone creates no instance. The development
`lifecycle.instance.inspect` and `lifecycle.stage.admission` operations read this
state; admission itself dispatches no work. The deterministic stage reducer
checks all predecessors, candidate identities, bounded attempts and unknown
outcome reconciliation. It cannot manufacture owner evidence or release authority.

The protected owner/platform binding composition, retained exact authority and
durable stage execution core, fixed CI dispatch clients, artifact verifier and
owner feedback delivery are implemented in development. Native stage composition,
Codex task handoff and their default CLI
wiring remain M3 work.
Unconfigured adapters fail closed; synthetic regression adapters are test
fixtures only and cannot certify real asset usability or final E2E. The two
Dashboard pages, independent installed Expert/plugin, migration and complete
candidate acceptance remain unfinished. These development features do not claim
that the frozen 664 acceptance instances have passed.

## Development integration admission

`serve` accepts `--integrations-ref <protected-json-file>`. This operator file
uses `runtime-integrations/v1`, with workspace identity, revision and scoped
`owners`, `platforms`, `credentials` and `resources`. It contains credential
references, never raw tokens. A resource binds its exact lifecycle field role,
revision, expiry and typed definition: documents, locations, policies, workflows,
toolchains, delivery targets, required checks, standards and asset mappings.
An absent registration or a document supplied in place of a workflow blocks
admission. A valid configuration does not supply future candidate evidence.

Owner consumers verify the complete published 0.8.3 distributions and dependency
files before importing their public APIs. They check exact scope, asset identity,
standards, Ontology dependencies or published compatibility declarations, and
mandatory criterion/variant mappings. Content grade comes from Harness's current
v2 assessment view and the current Runtime modeling intent; historical grades,
stale references and a synthetic review presented as actual evidence cannot
satisfy that binding. A content grade does not prove reconstructed software.

GitHub.com registrations include an exact workflow path and concrete runner
label; the adapter checks that label in the workflow and observed job. GitLab
registrations include the pipeline path and a numeric project runner ID, checked
for current availability. Both adapters pin repository identity, default branch,
source commit and workflow bytes. Unknown, skipped and neutral job results cannot
be treated as passing verification. Readiness and observation calls do not trigger CI.

The separate fixed CI `dispatch` operation requires a retained request containing
the exact platform registration, commit, workflow digest, stage input digest and
original deadline, plus a fresh execution permit before each write. It creates a
request-owned lightweight tag (`evopilot-runtime/<requestId>`) and dispatches only
the registered workflow against that commit. These tags are CI source pins, not
product releases; the client never force-updates or deletes them. GitHub workflows
must expose the required string inputs `runtime_request_id`,
`runtime_input_digest`, `runtime_source_commit`, `runtime_stage` and
`runtime_candidate_digest`, `runtime_workflow_digest` and
`runtime_binding_digest`, and use the run title
`evopilot:${{ inputs.runtime_request_id }}:${{ inputs.runtime_input_digest }}`;
GitLab pipelines receive the same correlation through pipeline variables, using
the v4 API compatible with the selected 15.0 test environment. Workflow trigger
guards must prevent tag creation from starting an additional automatic pipeline.
All GitHub workflows at the pinned commit are checked for `create` and tag-push
triggers. A push workflow must select branches only or exclude
`evopilot-runtime/**` through `tags-ignore`. GitLab's first two local workflow
rules are fixed to suppress non-API request-tag events and then allow API runs:

```yaml
workflow:
  rules:
    - if: '$CI_COMMIT_TAG =~ /^evopilot-runtime\// && $CI_PIPELINE_SOURCE != "api"'
      when: never
    - if: '$CI_PIPELINE_SOURCE == "api"'
      when: always
    # Existing project rules may follow these two guards.
```

An existing request tag causes inspection only, even when no matching run is
found. An ambiguous response, duplicate matching runs, changed source tag,
provider retry, incomplete bounded lookup or unverified downstream pipeline
cannot authorize redispatch or establish a passing lifecycle stage. Original-run
inspection uses the exact repository, workflow/ref, commit and correlation;
known handles are checked again. A provider job's success remains
`artifactsVerified: false` and `lifecycleAcceptance: false` until the separate
candidate/owner acceptance collector verifies the required evidence. Dedicated
test-project probes exercise actual GitHub and GitLab dispatch/recovery; they do
not stand in for the frozen v0.9 final acceptance catalog.

The CI output contract is a single artifact named `runtime-ci` (GitLab archive
filename `runtime-ci.zip`). The collector observes the exact terminal run first,
downloads by immutable artifact/job ID, checks current metadata again and
rechecks the original run. GitHub's published archive SHA-256 and byte length
must match; GitLab binds the original non-retried job and archive byte length,
then computes a local archive digest. No "latest successful" artifact is used.
GitHub's authenticated API may redirect once to its signed Actions/Azure storage
URL; Runtime follows it without forwarding credentials. Other redirects fail
closed. Signed URLs and provider error bodies never enter receipts.

An archive contains `runtime-result.json`, declared check evidence and, for the
candidate stage, `artifacts/<manifest name>` files. `runtime-ci/v1` results pin
request/input, provider/repository/run, source commit, workflow digest, stage and
existing candidate digest. Checks contain exact required IDs, PASS/FAIL/UNKNOWN
and nonempty `{path,digest,bytes}` evidence lists. Every evidence byte is verified;
missing, skipped, duplicate or extra checks and undeclared files are rejected.
A candidate manifest may appear only during candidate creation. Its source
digest is the canonical SHA-256 of `{provider,repositoryId,commit}`; build digest
is the canonical SHA-256 of `{requestId,inputDigest,bindingDigest,workflowDigest,runId}`.
Each manifest artifact is read and hashed. Later stages keep the same candidate
identity. Owner evaluations and publication authority remain independently
required; a verified CI archive does not grant them.

The pinned ZIP reader validates in memory only, with 128 MiB compressed,
256 MiB expanded and 512-entry bounds. Traversal, links, special/encrypted files,
case collisions, inconsistent sizes and corrupt CRCs fail closed. It never
extracts or executes archive contents. These are transport/evidence checks,
not evidence that the project's software requirements have passed.

The Codex binding pins the selected local executable bytes, version, host
identity and workspace. Admission issues only a fixed `--version` query. It does
not invoke a model or introduce Runtime model credentials. Owner connections
are initialized lazily: unavailable dependencies block validation while retained
definitions and receipts remain readable. Changed owner connection registrations
require a service restart; active instances are never silently retargeted.

## Development execution and release decisions

The shared HTTP/MCP/CLI dispatcher offers `lifecycle.authority.preview`,
`lifecycle.authority.record`, `lifecycle.authority.inspect` and
`lifecycle.authority.revoke`. These use the configured scoped authority policy and
the existing `decision.record` capability. They add no approval page or second
approval workflow. `auth-init` still creates only its explicitly selected
reader/editor/activator role; installation does not silently grant decision,
execution or publication permissions.

An execution preview binds an explicit instance ID, active definition revision,
semantics, required checks, goal/target/loop references, exact budget and expiry.
It also pins referenced resource, owner and platform configuration so keeping
the same reference name cannot retarget an existing instance. Unrelated project
registrations, credential bytes and changing remote branch heads are excluded
from that static configuration digest; their applicable scope/freshness checks
still apply at admission and dispatch. Old development authority records without
this binding remain historical and cannot silently acquire new permissions.
A release preview binds a separately verified instance, its immutable candidate,
required checks and configured channel. The release-decision predecessors must
currently pass. Preview does not grant either authority. Recording requires the
exact preview digest and existing pinned `evopilot-decision-evidence/v1` evidence
for that decision and its retained source. File integrity alone does not
authenticate a human; the current authenticated project capability and explicit
policy remain mandatory. Expert must not invent a human decision or replace it
with model output. Tests label their synthetic decisions explicitly.

Decisions and withdrawals retain immutable receipts and audit. The latest exact
decision for an instance supersedes its predecessor, including a rejection;
revocation never falls back to an older approval. Inspection distinguishes a
historical APPROVE from current usability. The service rechecks policy, deciding
principal, scope, expiry, evidence bytes and revocation before using a grant and
again before instance commit. An old request replay returns its original receipt,
not renewed authority or a replenished budget. An authority cannot be used to
create a different instance, and an existing instance cannot be reset by recording
an amended decision. Publication additionally needs `release.request` and the
separate exact instance/candidate/channel grant. None of these operations dispatch
external work. The separate stage request operation below may dispatch only
through a configured fixed adapter and fresh authority.

## Development durable stage requests and observations

`lifecycle.stage.request` takes only an instance ID and a stage ID, with the usual
project revision and idempotency key. The service checks exact authority, current
bindings, fixed predecessors, candidate/release identity and remaining budgets.
It stores the immutable request, action plan, instance transition, receipt, audit
and event before calling a trusted adapter. Repeating the original request
returns its original receipt. A later request cannot retry an UNKNOWN or RUNNING
attempt, overwrite its provider handle or reset its budget. API callers cannot
submit PASS or supply a stage outcome.

`lifecycle.stage.request.inspect` returns the fixed request and current progress.
Progress distinguishes DISPATCHING, WAITING_AGENT, CI_PENDING, CI_RUNNING,
RUNNING, UNKNOWN, COMPLETE and FAILED. Every observed response is retained as an
immutable object, including failures and uncertain outcomes;
`lifecycle.stage.observation.read` retrieves it by exact request and observation
reference. Later reconciliation does not erase an earlier receipt.

The service worker only inspects already retained requests. It has at most four
concurrent observation/dispatch calls, bounded provider calls and paged traversal.
A dispatch protocol has at most 60 seconds and never exceeds its already pinned
stage deadline; each read-only reconciliation has at most 30 seconds. Individual
CI HTTP calls remain capped at 10 seconds. These transport limits do not renew
stage attempts, execution authority or the instance's original budget.
The instance budget additionally bounds new actions. Client disconnection does
not cancel an already authorized external job. An explicit
`lifecycle.stage.reconcile` requests read-only inspection of the original request;
it grants no new external side effect. Revoked or expired execution authority
blocks new dispatch but does not prohibit retaining the actual outcome of an
already dispatched request. Service observations are audited as
`runtime:observer`, an internal identity that cannot be issued as a user
credential or record a human decision.

Shutdown bounds pending waits and retains uncertainty. Startup marks interrupted
requests for inspection; it never redispatches them, even when a crash occurred
between local commit and external dispatch. Both crash boundaries are exercised
with actual killed processes and clearly synthetic provider effects. Observation
storage/index failures are visible in request inspection and the scoped worker
health in `runtime.status`. Missing adapters leave historical state readable and
new execution blocked. The ordinary development CLI still has no fixed native
stage executor configured; the actual CI/Agent actions, artifact/owner result
evaluation and end-to-end closure are not yet complete. These regression results
are not final candidate acceptance.

## Development owner feedback delivery

The fixed internal feedback consumer accepts an event ID only from a trusted
registered terminal Run reader. It checks the workspace, project, event digest,
original claim/cause and exact asset pins, then retains the event in Runtime's
own service store. It does not turn an arbitrary CI report or client-provided
PASS into a registered Run. This internal component has no direct HTTP/YAML
capture entry point; its native lifecycle composition remains unfinished.

For each owner, Runtime first inspects the authoritative inbox. If delivery is
needed, it records the exact owner connection digest, request ID, event digest,
owner CAS revision and initiating principal before the external call. A fresh
trusted execution permit is required immediately before `feedback.ingest` and
is retained separately. Only the owner's public package API performs the write.
The owner obtains the event through Runtime's scoped trusted callback, not an
event supplied in the ingestion request. Neither `feedback.propose` nor
`feedback.decide` is exposed by this consumer.

Mutation responses are not completion evidence. Runtime independently reads
`feedback.read`, verifies the original event, receipt, candidate, review and
disposition digests, and checks the retained exact owner decision evidence.
`REVIEW_REQUIRED`, `REJECTED`, `REBIND_REQUIRED` and `REUSE_APPROVED` remain
distinct. An approved `DELIVER` requires a subsequent instance with the new asset
pins; it cannot complete the original pins. An approved `REUSE` is an owner
feedback result and never software release authority or full lifecycle acceptance.

Response loss, cancellation, partial owner delivery and process restart retain
the original request. Inspection cannot change the owner connection or repeat a
write whose outcome is uncertain, including a crash between local persistence
and dispatch. Late permit resolution after cancellation cannot start a write.
Each external call has a five-second bound; owner-local work that has already
started may still complete and must be reconciled through its original inbox.
The two owner transactions are independent. No cross-store atomicity is claimed.

Development validation uses actual published 0.8.3 owner services and independent
inbox/disposition readback with explicitly synthetic project assets, events and
owner decisions. Those observations and the durability/security regression tests
do not satisfy the frozen final-candidate E2E instances.
