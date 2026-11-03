# Runtime v0.9 independence and lifecycle boundary

Original native evidence, installation observations and release material have a bounded serialization profile: 8 MiB,
200,000 JSON nodes and depth 32. It applies only to fixed native-receipt,
verification-run, owner-feedback, release-material and three fixed closure record kinds
(`closure-evidence`, `closure-harness-input`, `closure-harness-action`) and the six explicit plan,
implementation, release, publication, closure and verification-feedback evidence
read operations, plus the full `lifecycle.authority.preview` review. HTTP and
Streamable MCP apply the same response bound. Ordinary
requests, YAML, other responses and monitor pages retain their 256 KiB limit;
the event payload limit remains 64 KiB. No caller selects the larger profile or
supplies a record kind. Original receipts retain their complete command output,
canonical digests and scope; no truncation creates a PASS. Exceeding the evidence
profile still blocks retention/readback and requires inspection of the original
owner receipt, without redispatch. Private archival uses the same bounded JSON
profile for each original receipt document, within its existing total bound.
An oversized HTTP or MCP request receives `413 INPUT_LIMIT` and closes its
connection without dispatch, including an unfinished chunked upload. Reading
the bounded body must not destroy the response socket before sending this error.

An explicit stage continuation checks worker availability again after asynchronous
permission verification. If an original observation acquired the worker in that
interval, the request returns `EXECUTOR_BUSY` before recording an acknowledgement.
The client may retry the same stage after inspection finishes; this does not
create another attempt, change its deadline or redispatch its retained action.

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

`runtime.projects.list` returns `projects`, `hasMore` and `nextCursor`. Its optional
`limit` is 1–100 (default 50); pass the returned cursor for the next page. Projects
are sorted by identifier and restricted to the current principal's scope, including
authorized projects not yet initialized (revision 0). Cursors bind the service,
principal revision and exact current scope; they survive service restart but are
rejected after scope/permission changes or when reused by another principal.
Project revisions are read at each page request, not frozen into a snapshot.

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
owner feedback delivery are implemented in development. Candidate/verification
CI stages now compose these clients with exact native owner validation through
the standalone CLI's registered executor. Immutable target/plan preparation and
the fixed scope and plan stages and external Codex task handoff are also
implemented. Reviewed implementation CI now composes the same native validators
and supplies its verified source to candidate and verification stages. A bounded
real GitLab probe has exercised scope through verification without seeded
predecessors. Registered CI preparation extensions now retain source-changing
outputs through native validation and candidate creation. Their actual workflow
qualification, independent Host integration and full lifecycle acceptance remain
M3–M5 work.
Unconfigured adapters fail closed; synthetic regression adapters are test
fixtures only and cannot certify real asset usability or final E2E. The two
Dashboard pages have development browser coverage. Independent installed
Expert/plugin, full migration and complete candidate acceptance remain unfinished.
These development features do not claim
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

For native candidate/verification execution, register `nativeToolchain` in this
same protected operator file as `{ "path": "<absolute manifest file>",
"digest": "sha256:<file bytes>", "lockDigest": "sha256:<native lock>" }`.
The manifest is a private regular owned file (0600), at most 2 MiB, with the
existing `evopilot-native-toolchain/v1` schema and explicit host platform,
architecture, four native tools and dependency pins. The published owners still
verify their actual installed tools/dependency bytes and standard versions;
reading this descriptor alone is not validator readiness. It registers no
arbitrary module or command. Project YAML cannot supply the manifest or tools.
Changing this descriptor changes the execution authority's bound context.
Lifecycle admission and native execution require this operator registration.
Drift blocks new work, while persisted history remains readable. Stage plans
also pin the manifest file digest, so a changed manifest with the same declared
lock cannot replace the original after restarting the service.

The CLI's fixed executor shares the existing service store and lazy owner
connections. It does not create a second writer or a separate execution engine.
Connection/manifest changes require a reviewed registration and service restart;
an in-flight original request cannot be retargeted to different owner packages or
validator configuration. Startup performs no CI dispatch or native validation.

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
`runtime_binding_digest` and `runtime_candidate_input`, and use the run title
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

For verification, `runtime_candidate_input` is bounded canonical JSON using
`runtime-ci-candidate-input/v1`: the original manifest and immutable archive
identity (`provider`, `repositoryId`, `runId`, `artifactId`, `jobId`,
`archiveDigest`, `archiveBytes`). It is at most 48 KiB, contains no credential or
arbitrary URL, and is `none` before a candidate exists. Runtime derives it from
the completed candidate's retained evidence, never from client-supplied metadata
or a "latest" artifact. A digest without the original archive identity cannot
start verification. Historical development workflows with seven inputs need this
eighth required string input before new runs; old receipts stay unchanged.

The registered verification workflow must download that exact provider artifact
using its own scoped CI credentials, verify the archive and original manifest
digests, and test the downloaded candidate. Its output includes
`candidateConsumption: {inputDigest, artifacts}`, where `inputDigest` hashes the
exact input and `artifacts` equals the original manifest's inventory. It retains
the consumed files under `candidate/<name>`. Runtime independently hashes every
file and rejects missing, rebuilt/different or substituted bytes. Matching bytes
and workflow evidence remain distinct from an independent proof of arbitrary
software behavior; full project checks and native owner results are still
required. Runtime neither sends its platform token to the job nor downloads
arbitrary URLs supplied by project YAML.

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
required checks, configured channel and the full material collected in its
original release-decision stage. That material includes exact candidate-source
release documentation and original verification evidence. All transitive
release-decision predecessors must currently pass. Preview does not grant either
authority. Recording requires the
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

## Development target and plan preparation

Project configuration selects input rules, plan/ADR directories and review
policies. It does not need future target outputs to activate. Before requesting
execution, `lifecycle.preparation.save` retains an immutable
`runtime-preparation/v1` packet for an active definition. It includes the exact
goal and loop references, target ID/version/scope/exclusions, repository and
baseline commit, compatibility impact, and file pins for the plan, impact,
verification and rollback documents. Migration impact additionally requires a
migration document. Plan/verification/rollback files must remain inside the
registered plan location; impact/migration files inside the ADR location.
Files are canonical regular non-writable-by-others documents, bounded to 1 MiB
each. Their actual bytes must match the supplied digests.

The packet's verification rows name every fixed stage/check exactly once,
including added checks, with a concrete procedure and the registered evidence
source. Missing, duplicate or substituted rows cannot reduce the denominator.
The version follows the configured `semver` or `immutable-build` rule. Saving
requires `draft.write`, exact CAS and idempotency; it neither approves the plan
nor creates an instance. A later change creates a different preparation
reference. `lifecycle.preparation.read` preserves the original packet and
separately reports whether its current files and registrations still verify.

Use the returned `preparation:sha256:…` as the execution subject's `targetRef`.
The existing authority preview includes that exact packet. The authenticated
decision principal must also be a configured plan reviewer. Its decision binds
the packet, definition, goal, loop, budget, policy and retained decision evidence;
material storage or a model's statement cannot replace it. Ordinary authorized
stages do not require another identical review. Changed documents, mappings,
reviewer policy or goal/loop identity invalidate dependent new work. Historical
development authority references remain readable; they cannot supply the
mandatory preparation to the new scope adapter.

The fixed `base.scope` action checks the reviewed preparation and current exact
source baseline through the registered read-only platform adapter. It durably
records those facts under the original stage request before returning COMPLETE.
`lifecycle.scope.evidence.read` reads the original source, document and mapping
evidence without granting authority. Restart inspection only reads retained
evidence; it cannot turn an absent action into PASS. Explicit continuation may
complete an interrupted local evidence commit under the same current authority
and deadline. Scope completion does not run CI or prefill later stage states.

The plan's attached material and review are bound; its fixed adapter executes
the configured native checks described below. The service does not mark them
PASS merely because documents exist. Candidate
collection also checks its version against the retained preparation; a valid CI
archive for a different version is retained as a known failure before native
owner validation. These are development behaviors, not final release evidence.

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
new execution blocked. The ordinary development CLI wires the fixed native
scope/candidate/verification executor when `--integrations-ref` is supplied;
the remaining actions and end-to-end closure are not yet complete. These regression results
are not final candidate acceptance.

## Development CI and native stage composition

The fixed candidate/verification adapter derives its plan from the current
registered workflow, source commit, exact owner assets, native criterion/variant
inventories and toolchain lock. Its action remains `base.candidate` or
`base.verification`; YAML cannot choose executable code. The service constructs
the adapter against its own store, avoiding a second writer or a parallel state
database. Other lifecycle stages remain separate implementation obligations.

The original stage request pins the CI request, input, workflow and source.
Dispatch starts only that CI request. Reconciliation retains a stable provider
handle, original run ID, exact downloaded ZIP and verified manifest/evidence
digests. Archive bytes are stored privately under their content digest, without
extracting or executing them. Another run or changed artifact cannot substitute
for the original. A failed CI run remains failed even without a usable artifact.

After CI passes, read-only inspection leaves the stage running until the native
owner results exist. Codex may call `lifecycle.stage.advance` with only the
original `stageRequestId`. This is an explicit continuation of the retained
plan, not a new attempt or renewed budget. It requires the original current
execution principal, authority, bindings and original deadline; an exact API
replay does not repeat it. Background observation never calls `advance`.

The CI ZIP must declare `evidence/owner-values.json` in its evidence manifest:
`{"schema":"runtime-ci-owner-values/v1","values":{...}}`. These are actual
rule input values, not a client-submitted owner verdict. Runtime binds them to
the verified source, original stage request, candidate, configuration and fixed
requirements, using the existing native observation/context contract. It retains
each exact native request before calling the published owner's validation API.
Each call checks current permission again; a prior action whose result is
unknown is inspected, never blindly dispatched again.

Runtime independently reads both native receipts, checks their exact request,
asset, context, toolchain and report digests, and requires the complete native
criterion/variant inventory. Harness quality applies to the actual CI-derived
observation; Ontology validation remains its implemented model/constraint
validation and is not a proof of software equivalence. A stage completes only
when its fixed CI checks, artifact verification and both required owner results
pass. Verification retains the previously bound candidate and cannot rebuild or
follow a changed source commit. Only candidate completion introduces a manifest.

The development probe exercises real GitHub/GitLab CI and published 0.8.3 native
validators with synthetic assets and explicitly synthetic predecessor evidence.
It does not establish full eight-stage admission, actual project semantic
approval, publication, closure or any of the frozen final acceptance instances.

## Development external Codex handoff

The registered `base.implementation` adapter requires the completed original
scope/plan evidence and reviewed preparation. It pins the registered Codex
executable/version, Host identifier, canonical workspace, fixed capabilities,
original authority, request and deadline. Runtime retains a handoff and enters
`WAITING_AGENT`; it never launches a coding process, selects a model or configures
LLM credentials. Codex remains responsible for its own execution permissions.

`lifecycle.agent.handoff.read {stageRequestId}` returns the original handoff,
claim and latest report. The original authenticated execution principal calls
`lifecycle.agent.claim` with that request, handoff digest and exact configured
Host/version/capabilities plus its session ID and `host-managed` permission mode.
Claiming requires the current original execution permit. A second claim is
rejected; exact request replay returns its original receipt.

`lifecycle.agent.report` takes `stageRequestId`, `claimDigest`,
`previousReportDigest`, `state`, `summary`, `result` and `measurement`.
`WORKING` requires current execution authority and the original unexpired budget.
Without a fresh report within 30 seconds, observation returns `WAITING_AGENT`;
that is an observation threshold, not a new attempt or timeout allowance.
`WAITING`, `UNKNOWN`, `FAILED` and `SUBMITTED` may retain historical observations
after execution authority expires or is revoked, but still require the original
current authenticated principal. They never authorize more work. Late results
are explicitly marked. Reports form an immutable chain; submitted results and
known failures cannot be replaced. Replays and restart never redispatch coding.

A submitted result identifies one exact commit, provider-matching PR/MR number
and bounded output inventory. Runtime hashes owned regular files in the
registered workspace, rejects links/escapes and changed bytes, and records
digests and sizes. These hashes do not establish source review, CI success or
functional acceptance. `lifecycle.agent.report.read` exposes the latest report
or a prior `reportDigest` belonging to the same original request.

Host session metadata is authenticated client testimony, not process attestation.
Usage is `null` when unavailable. Optional provider/model/token/cost measurements
need a source reference and digest and remain Host-reported. Runtime neither
fetches an arbitrary evidence URL nor invents zero usage. Every report is
`independentlyVerified:false`; the current implementation deliberately cannot
complete the stage from a report alone. Exact source review and the independently
observed CI/native verification described below are also required.

The development probe used the actual standalone CLI, published native owners
and current Codex to write two isolated files, pass three local tests and create
one real private GitLab draft MR. Original claim/results survived service restart.
The probe retained its driver interruption and recovery evidence, revoked its
synthetic authority and did not dispatch CI, merge, release or change the daily
installation. It is handoff evidence, not full lifecycle acceptance.

## Development exact source observations

Both fixed platform clients expose a trusted internal `source` reader. Its input
pins the preparation's baseline commit, submitted commit, PR/MR number and output
inventory. It observes only the registered repository, checks the current target
branch against the reviewed baseline, verifies exact base/head relationships,
reads the complete changed-file inventory and hashes the declared remote outputs.
The inventory includes deletions and changes beyond the reported output subset;
subsequent review must cover the whole change. Metadata is read again afterward
to reject drift. Forks, linked/submodule outputs and incomplete inventories fail
closed. No provider account is inferred to be a Runtime review principal.

The bounded profile supports 1,000 changed paths, 128 declared output files,
1 MiB per remotely verified output and 64 MiB total. GitHub file inventories are
paged; its comparison route accepts only exact commit hashes. GitLab uses the
changes endpoint available in the verified 15.0 installation and requires an
explicit false overflow flag and exact file count. Oversized, collapsed or
truncated responses are not partial success. This API compatibility choice does
not claim support for every later GitLab version.

Results retain source facts, status, draft flag and content digest, with
`sourceReviewApproved:false`, `ciVerified:false` and `releaseAuthorized:false`.
The actual GitLab development readback verified the current Codex probe's exact
two-file MR without any remote mutation. Both-provider regression tests exercise
wrong base/head, byte mismatches, pagination and incomplete evidence; actual
GitHub source-review and full lifecycle acceptance remain separate obligations.

## Development project extension checks

The registered executor implements `runtime.check.ontology`,
`runtime.check.harness` and `runtime.check.artifact` in all four publisher-defined
extension slots. Each check
uses the exact published owner asset, native criterion/variant pairs, project
requirement and evidence mappings, reviewed preparation, original passing
predecessors and current execution authority. Local and global evidence mappings
must agree at definition admission and execution; even a consistently renamed criterion is rejected when it is absent
from the published asset. These checks consume owner APIs and do not author or
publish assets.

After-plan checks bind the reviewed preparation source. Later slots bind the
verified completed implementation source; checks after candidate creation also
bind the original candidate manifest and archive identity. Harness receives a
`runtime-extension-observation/v1` containing this evidence under
`values.runtimeExtension`. Ontology validates the exact published model in the
same scoped native context. A successful baseline or registration alone cannot
complete an extension. The native receipt must satisfy the fixed owner criteria
with matching source, input, toolchain and configuration digests.

The artifact action binds published Harness rules with `owner-receipt` mappings.
Before native evaluation, Runtime independently verifies its fixed inputs:
after-plan uses all exact reviewed preparation documents; before-candidate uses
the original completed implementation CI archive; subsequent slots use the
original candidate archive. Archive bytes, producer request, complete CI check
set and all declared files must match. Runtime rehashes and parses the retained
archive without extracting or executing files. It neither rebuilds nor dispatches
another CI run. The exact observation reaches Harness as
`runtimeExtension.artifacts`; missing inputs cannot become a passing rule result.

Runtime retains each original native action before invoking its owner. If the
response is lost, reconciliation reads that request's receipt and never submits
a replacement validation. Running receipts are retained as immutable observations
separately from the eventual terminal receipt, so restart can reconcile the same
request through completion. Source, configuration, permission or toolchain drift
prevents continuation. Every extension remains a required AND branch: unrun,
unknown and failed branches block the successor base stage.

`lifecycle.extension.evidence.read {stageRequestId}` returns scoped historical
action, receipt and content-addressed evidence through both HTTP and MCP. This
read creates no authority. Closure archives all three original records and
rejects missing or altered records. Regression fixtures exercise four-slot
joins, owner failures, response loss, restart, mapping/source drift, project
isolation and archive integrity; their synthetic providers and owner decisions
are not final-candidate acceptance evidence.

The publisher-registered action `runtime.operation.ci-prepare` uses the separate
CI preparation path described below. Its workflow purpose, complete requirement
mapping and both native owner evaluations are mandatory. Unsupported actions
still fail closed; compiler registration alone does not establish an executor.

## Development project scope review

`runtime.review.scope` uses the configured `extension.review` resource in any
of the four extension slots. Every additional requirement must identify an
existing published owner criterion/variant and map to `decision` evidence.
Runtime checks the complete local and global mappings during admission and
execution. An eligible reviewer approves or rejects the entire fixed scope;
multiple required reviewer gates can be represented by separate required review
nodes. The existing `reviewerIds` list identifies eligible reviewers, not a
quorum or automatic approval.

The original stage first waits for a decision. The same HTTP/MCP entry provides:

- `lifecycle.extension.review.preview {stageRequestId}` returns the exact subject,
  its digest, published assets and criteria, preparation documents, source tree,
  original predecessor outcomes and original candidate, where applicable.
- `lifecycle.extension.review.record` accepts `stageRequestId`, `reviewDigest`,
  `decision` (`APPROVE` or `REJECT`) and `evidenceRef`. The authenticated principal
  must have `decision.record`, belong to the current configured reviewer list,
  and supply retained decision evidence for the Runtime operation
  `lifecycle.extension.review` and that exact subject digest. The request uses the
  ordinary request ID and CAS revision. A response loss replays the same receipt.
- `lifecycle.extension.review.inspect {reviewRef}` retains the original decision
  and separately reports current usability and any revocation.
- `lifecycle.extension.review.revoke {reviewRef, reason}` records a new revocation
  under the current reviewer policy; it does not erase the original decision.

An approval completes only this required scope-review node. Rejection blocks its
AND successor. Neither choice approves a new domain model, publishes an owner
asset or grants software-release authority. New decisions require the original
pending, unexpired request; a completed or failed review cannot be overwritten.

Before a successor request, dispatch or successful outcome is committed, Runtime
checks all completed scope reviews. Their original reviewer, policy, decision
evidence and complete subject must still be valid. Source observations are
rechecked independently; a final synchronous check prevents revocation during an
asynchronous observation from granting later execution. Historical stage results
remain intact when a decision becomes unusable. A pre-candidate scope decision
retains its original source subject after a later candidate appears; it does not
become candidate approval.

The general `lifecycle.extension.evidence.read` also reads original scope-review
evidence. Closure archives the exact decision, attestation, source evidence and
matching stage outcome. Missing or revoked decisions block closure. Development
tests cover all four slots, explicit approve/reject, reviewer and project scope,
forged/stale input, response replay, restart, revocation, source drift, HTTP/MCP
equivalence and complete archive readback. Fixture decisions are explicitly
synthetic and do not establish final product acceptance.

## Development implementation review decisions

The standalone CLI now wires the configured implementation review policy and
exact source reader into the same HTTP/MCP service. The policy's `reviewerIds`
are Runtime principal IDs, not GitHub/GitLab account names. Read-only callers
can inspect the exact source, but recording a decision requires both the current
`decision.record` capability and membership in that project's configured policy.
No additional reviewer quorum or automatic provider-to-principal mapping exists.

`lifecycle.implementation.review.preview {stageRequestId}` reads the original
claimed/submitted Agent result, independently observes the exact provider change,
and returns its full changed-file inventory, policy, deadline and review digest.
The digest binds workspace/project, original request and instance pins, report,
source facts, policy and reviewer identity/revision. Repeated observation times
do not change identical source facts. Source or policy movement rejects a stale
preview. A draft PR/MR may be reviewed; the review does not merge it or release
anything.

`lifecycle.implementation.review.record` takes `stageRequestId`, `reviewDigest`,
`decision` (`APPROVE` or `REJECT`) and `evidenceRef`, with normal CAS/idempotency.
It re-reads the exact source and requires retained decision evidence for operation
`lifecycle.implementation.review`, the same digest and actual decision. This is
the existing evidence mechanism; evidence-file integrity alone does not
authenticate a human or grant a client missing review permissions. A new decision
requires the source change to remain open and the original task unexpired.

`lifecycle.implementation.review.inspect {reviewRef}` preserves the original
decision and reports current usability. Revoked/expired reviewer credentials,
changed policy/source, rejection, supersession or an exhausted task block reuse.
`lifecycle.implementation.review.revoke {reviewRef, reason}` records a separate
revocation under the configured review authority. Historical decisions remain
unchanged; an exact replay returns its old receipt without re-deciding or dispatch.
Neither approval nor revocation renews execution authority, completes a stage,
starts CI or grants publication. Explicit stage continuation is required to
begin the separately observed CI/native work described below.

The development CLI/HTTP/MCP probe read the same real GitLab MR and produced the
same review digest from both transports. It reused the original isolated state,
with its execution authority already revoked, and recorded no review decision.
Separate regression tests use explicitly synthetic decisions to exercise write,
replay, current permission, drift, revocation and recovery boundaries.

## Development implementation CI and verified source

After a submitted Codex result has an exact current source approval,
`lifecycle.stage.advance` may continue its original implementation request.
Runtime retains an immutable derived CI request before dispatch. It binds the
original report, review, source facts, principal, authority, input and deadline;
it is not a new stage attempt or renewed budget. Restart and lost responses
inspect that same CI request. Even an interrupted dispatch with no discoverable
provider run remains unknown and cannot be automatically sent again.

Both platform clients verify the workflow at the selected exact commit. They
retain the current branch head separately and never replace the selected commit
with that head. The implementation stage uses its configured implementation
workflow; candidate and verification use their own configured workflows with
the completed implementation's source. Current execution bindings and permissions
are still checked: independently selecting an exact revision does not exempt a
stage from those gates.

The implementation stage completes only when independently observed CI,
verified artifact/check evidence and both native owner reports pass the complete
fixed criteria. Before each new owner action, Runtime rechecks the exact source
approval and current execution permit. A lost owner response is reconciled from
its original receipt; explicit continuation may start only the remaining action.
`lifecycle.implementation.evidence.read {stageRequestId}` exposes the derived
request, original CI observation/artifact and owner actions/receipts to a scoped
reader. Reading evidence cannot dispatch work or grant authority.

Candidate and verification stages require the persisted passing implementation
outcome and content-addressed source proof. They recheck the retained review,
current reviewer permission and policy, and reject revocation or changed proof.
They do not require an already completed coding task to receive a fresh deadline
or silently select new source. This does not yet implement source changes from
the separately planned before-candidate extensions.

Development regressions cover the composed implementation/candidate/verification
chain, restart, changed branch head, missing review, response loss, revoked review
and failed CI/native validation. Their assets, decisions and external effects are
explicitly synthetic. A real GitLab read independently verified an older exact
commit and its workflow while retaining the newer branch head.

The subsequent isolated CLI probe ran scope, plan, current-Codex implementation,
candidate and verification with real GitLab CI and released 0.8.3 native owners.
It seeded no predecessor outcomes. Independent readback confirmed exactly three
CI pipelines for one reviewed commit, all owner criteria passing, and verification
downloading and testing the original candidate archive with identical artifact
bytes. Service restart preserved the completed implementation and source pins.
The probe retained its earlier fixture/configuration failures and driver recovery
records and revoked its synthetic execution authority on completion. Assets and
decisions remain explicitly synthetic; release-decision, publication and closure
were not executed. This is development integration evidence, not full lifecycle
or final candidate acceptance, a product release or a daily installation change.

## Development release admission

`base.release-decision` uses the existing stage request and existing authority
review operations. After verification, request this stage to collect reviewable
material. It remains `RUNNING` until a distinct current release decision approves
that material. No extra approval page or caller-supplied PASS endpoint exists.
Collecting documents cannot dispatch publication, CI, an Agent or owner mutation.

The mandatory resource referenced by
`config.release-decision.evidencePolicyRef` contains
`{kind: "evidence-policy", requireAll: true, requireCurrent: true,
allowSkipped: false, documentation: [...]}`. `documentation` maps 4–16 required
documents as `{role, path}`. All four roles are required: `release-notes`,
`migration`, `readme`, and `technical`. Map applicable language editions explicitly.
A document may serve multiple roles; duplicate role/path pairs are rejected.
Paths are bounded repository-relative `.md`, `.markdown` or `.txt` files, not
URLs. Historical development configurations without these mappings cannot gain
new release admission automatically.

Runtime reads each file from the exact verified candidate commit through the
registered GitHub/GitLab provider. It verifies complete bounded Git trees,
regular-file modes, Git blob identity, content hashes, nonempty UTF-8 text and
transfer limits (1 MiB per file, 8 MiB total). Links, submodules, incomplete trees,
missing files, mismatched bytes and detected inline credentials fail closed.
Full document observations, retained release material and authority reviews also
fit the 8 MiB encoded evidence profile, including JSON escaping and repeated
role mappings. Transfer capacity does not exempt an encoded result from that
bound. Runtime rejects an oversized result; it never truncates document text or
substitutes a digest-only preview. Requests and decision records remain small
references, and the review digest binds every original document byte.
The independently re-observed original verification must still match its complete
CI/native outcome, including consumption of the original candidate archive.

`lifecycle.release.evidence.read {stageRequestId}` exposes the retained full
material to a scoped reader. This is a historical evidence read, not a current
release grant. The existing `lifecycle.authority.preview` for `kind: "release"`
includes that material and its digest, along with exact instance/candidate/channel
and current configuration pins. The decision evidence must bind this preview.
Document presence proves availability and integrity; the explicit review decides
whether their content is acceptable for the proposed release.

The adapter rechecks original verification and exact release authority before
completing. Policy changes, stale dependencies, revoked decisions or changed
verification cannot produce PASS. Restart inspects the original request and
preserves its material, deadline, attempt and receipts. If collection ended before
material was retained, explicit `lifecycle.stage.advance` may finish read-only
collection on that same request; background inspection does not recollect it.
Publication retains its separate execution capability and exact release grant.

Development HTTP/MCP regressions cover material visibility, missing approval,
restart, interrupted collection, configuration drift, changed verification and
revocation. Read-only probes verified exact document bytes from both real test
providers; their one-file/four-role fixture tests transport, not release-document
adequacy. The prior five-stage GitLab probe remains ended and unchanged. A complete
real release-admission/publication/closure chain and the frozen final acceptance
are still required; these development checks confer no product release authority.

## Publication workflow and channel readback

`base.publication` uses the configured `purpose: publish` workflow at the exact
reviewed candidate commit. Its channel resource additionally binds
`publication: {tagPrefix, prerelease, packageName}`: the tag prefix is empty or
`v`, the prerelease flag is explicit, and the package name is null for GitHub or
a fixed Generic Package name for GitLab. These fields cannot be inferred from a
moving latest release. Historical development resources must be reviewed again
when their configured content changes.

The eight existing CI inputs remain unchanged. Publication requires the ninth
string input `runtime_publication_input`, with schema
`runtime-publication-input/v1`, the exact channel target/tag, release material
digest, release authority reference, and pinned release-note paths/digests/sizes.
The workflow consumes the original `runtime_candidate_input` archive and manifest
and returns the normal `runtime-ci/v1` report with candidate consumption and both
publication checks. It must not rebuild the package. Read each pinned note from
the exact commit, verify its bytes, join notes with two newlines, then append
the marker generated by `publicationDescription` in
`src/adapters/distribution.ts`. The marker binds the original request, stage
input, commit, candidate and publication input. Combined public notes are limited
to 64 KiB; exact CI inputs are also bounded to 64 KiB. Oversized notes fail during
preparation rather than being truncated or implicitly approved.

Runtime retains a durable action before dispatch, rechecks current execution and
release authority before every provider mutation, and never dispatches that
action again. A lost response or restart only inspects the original correlated
workflow. Explicit continuation may start a retained stage request that has no
action yet; passive inspection cannot start it. The completed release-admission
outcome, material, destination resources and grant remain pinned.

Independent channel readback verifies the release, exact tag commit, reviewed
description, complete unique artifact inventory and every downloaded candidate
byte. GitHub permits bounded annotated tags and uploaded release assets; asset
redirects use only its release-asset storage host with credentials removed.
GitLab uses the configured same-project Generic Package version and fixed API
download routes, compatible with the selected 15.0.2 test instance. Release links
must equal those derived routes; arbitrary external links are not fetched.
Duplicate package versions/files, changed metadata, wrong bytes, missing assets
or failed transfers cannot establish complete delivery. Inventory order alone
does not change identity. A second metadata read detects changes during download.

`lifecycle.publication.evidence.read {stageRequestId}` exposes scoped historical
CI, artifact and channel observations, including partial release facts. A passing
channel readback alone cannot complete publication: the original CI contract and
candidate consumption must pass and the exact release grant must remain current.
The pinned published Harness must also evaluate the independent channel evidence.
Its `evopilot-observation/v1` input has `values.runtimePublication` with schema
`runtime-publication-observation/v1`, the original request/plan, candidate and
release material digests, verified CI artifact and distribution facts. A complete
native criterion/variant inventory, exact context, configuration, toolchain and
observation digest are verified against the original owner receipt. CI success
cannot substitute for that native quality result.

After the original CI and channel readback pass, explicit
`lifecycle.stage.advance` requests the already planned native evaluation under
current authority. Passive inspection never starts it. Runtime records the exact
owner action before calling it; lost responses only inspect that original receipt.
Changed channel evidence cannot reuse an older Harness PASS, and changed owner
registrations or toolchains cannot replace the pinned evaluation. The historical
publication evidence read includes the retained native input, action and receipt.
Failures retain evidence without automatic deletion, upload retry or rollback.
This implements publication mechanics; final delivery closure and all frozen
product acceptance cases remain independently required.

The dedicated GitLab 15.0.2 development probe completed candidate, original-byte
verification and publication pipelines, followed by independent Runtime release
and Generic Package readback. These are explicit synthetic test artifacts, not a
product Release. An isolated real Harness 0.8.3 integration evaluated that channel
readback using explicit synthetic rules: all 12 native criteria passed, and
restart/continuation preserved its receipt without another owner mutation.
The registered closure implementation below consumes terminal owner feedback.
Actual complete CI/released-owner closure journeys remain required before final
acceptance.

## Development installation readback

Protected `local-install` and `approved-deployment` delivery resources require an
existing canonical directory and a `manifestArtifact` name. Distribution resources
continue to identify their publication platform. The selected manifest must be an
exact artifact of the same candidate, use `runtime-installation-manifest/v1`, and
bind that candidate's version and original package digests. Its inventory contains
regular files (digest, size and executable flag) and exact relative symbolic links.
This format does not grant installer or deployment execution authority.

The read-only verifier inventories the actual directory before and after reading,
checks ownership, permissions, file identity and contents, and rejects missing,
extra, hard-linked, substituted or changed files. Links must resolve within the
declared tree; dangling, cyclic and escaping links fail. Inventory, byte and time
bounds apply. The result distinguishes absent, partial, mismatching and matching
installations. It neither extracts packages nor executes software, and a matching
inventory alone cannot establish startup, deployment or lifecycle completion.
Original candidate manifests, before/after filesystem snapshots and complete
installation observations use the bounded evidence profile above, rather than
the smaller public-request profile. The same complete facts flow through smoke
verification, the exact native-validation permit, retained closure evidence and
private archival. Each encoded record must satisfy both byte and structure bounds;
the inventory entry ceiling is not a guarantee that every layout below it fits.
Native owner limits remain authoritative, and oversized evidence fails without
truncation or a replacement validation request. Small-record canonical hashes,
HTTP/MCP input limits, YAML and monitor-page limits remain unchanged.
The manifest verifier is now connected to the registered closure adapter; actual
selected-target delivery journeys remain required.

Development validation includes exact-layout and fault tests plus independent
readback of fresh copies of the published Ontology/Harness 0.8.3 package payloads.
Those copies contain 312 and 260 regular payload files; deliberate same-length
corruption fails, and restoring the original bytes passes. Dependencies, startup,
the daily installation and the final delivery acceptance are outside that probe.

## Development plan execution

The registered `base.plan` adapter requires the original completed scope
receipt and the exact preparation already included in the authenticated execution
review. It rechecks document bytes, fixed verification coverage, compatibility
material, configured reviewer policy and current execution budget before native
validation. Saving documents or declaring a status cannot complete this stage.

Harness receives `values.runtimePlan` with schema `runtime-plan-observation/v1`:
the target, compatibility classification, verified document paths/digests/sizes,
verification rows and requirement digest, pinned budget, preparation digest,
authority reference and original scope evidence digest. These are observed
materials and traceability facts, not invented test results or semantic approval.
The selected published Harness must contain rules appropriate to these plan
inputs. A software-test-only Harness does not automatically certify a plan;
missing inputs or failing rules remain failures. Ontology's native validation
checks the selected model/constraints. Both owners must return their full exact
criterion inventories under the pinned validator manifest and validation context.

Runtime retains the plan input and each native action before dispatch, checks
current permission and unchanged material before every owner mutation, and reads
the original owner receipts independently. `lifecycle.plan.evidence.read` exposes
the retained input, native requests and receipts to an authorized project reader.
An uncertain action is inspected without redispatch. After an independently
verified first result, an explicit `lifecycle.stage.advance` may execute the
remaining action under the original budget; the observation worker cannot do so.
Failed checks block implementation. Restart retains the original identities and
does not reset the attempt, authority or time budget.

The isolated development CLI probe completes scope and plan through real GitLab
source readback and released 0.8.3 native validators, with newly created synthetic
assets and synthetic decisions. It seeds no predecessor outcomes and starts no
implementation, CI, publication or daily installation. It is not final lifecycle
acceptance or a new grade for the original projects.

## Development owner feedback delivery

The fixed GitHub/GitLab source-tree reader obtains complete Git object metadata
at an exact commit. It preserves regular, executable, link and submodule entries
without reading their contents or following links/submodules. It reconstructs
each Git tree identity and rejects omitted, duplicated, truncated or inconsistent
entries. GitHub also exposes the root tree ID in its commit response; GitLab
15.0 selects the complete root inventory by exact commit, from which Runtime
reconstructs that ID. Limits are 16,384 entries, 256 directories, 1,000 entries
per directory, 512 API requests and 30 seconds; exceeding a bound never returns
a partial inventory as complete. The result has separate inventory, tree and
observed-facts digests. It is provenance evidence, not source approval.

Both existing dedicated test repositories passed actual read-only inventory
readback and stable repeated observation. New `runtime-ci-owner-stage-v2`
requests retain that complete inventory and a native source scope with exact
repository, commit, tree, inventory and requirements digests. Both original owner
validation contexts bind the source-scope digest; the Harness observation binds
the tree identity and its original CI collection receipt. Candidate manifests
continue to use their existing separate provider/repository/commit identity.
Historical v1 requests preserve their original adapter digest, context and
receipts; inspection does not add a missing inventory or promote their evidence.
After both original native validation receipts become terminal, Runtime retains
`runtime-stage-evaluation-run/v1` for verification. This record links the original
stage request, plan, execution authority, source scope, candidate, CI archive,
collection reference and both complete native receipts. It preserves success or
failure without constructing a historical legacy `NativeRun`. Its plan digest
fills the feedback protocol's `runReviewDigest`; this is the exact technical
evaluation plan, not a newly invented human decision. The original authenticated
execution authority remains separately linked in the Run record.

`lifecycle.verification.feedback.read` takes the original `stageRequestId` and
returns a private project event only after the execution core has committed the
matching terminal outcome. It recomputes the original Run and source/receipt
links and verifies the retained CI archive bytes. Missing, changed, unknown or
incomplete evidence blocks the read. A crash between native receipt retention
and the core's terminal commit cannot expose a completed Run. Public asset
references do not make private project feedback public. Historical v1 records
without source inventories do not silently acquire this new evidence.

The fixed internal feedback consumer accepts an event ID only from a trusted
registered terminal Run reader. It checks the workspace, project, event digest,
original claim/cause and exact asset pins, then retains the event in Runtime's
own service store. It does not turn an arbitrary CI report or client-provided
PASS into a registered Run. This internal component has no direct HTTP/YAML
capture entry point. Published owner adapters now have a scoped callback to the
registered verification event reader. The read endpoint does not deliver an
event or approve an owner disposition. The registered closure stage now delivers
that original event under its current execution permit and waits for both exact
owner dispositions; final real-environment qualification remains unfinished.

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

## Development delivery smoke and closure evidence

The registered closure adapter now composes delivery evidence, native Harness
validation, both owner feedback dispositions and immutable archival. Isolated
full-stage regression chains pass for distribution, local installation and
approved deployment, including restart readback. Their external CI, native owner
responses and decision attestations are explicitly synthetic. Actual registered
CI/released-owner journeys and the final acceptance catalog remain required;
these regressions are not final acceptance or a Runtime release claim.

A closure CI request adds `runtime_delivery_input`, containing the fixed
`runtime-delivery-input/v1` target and optional original candidate installation
manifest artifact. Distribution binds the exact published commit, version tag,
channel registration and release-description digest. Local installation and
approved deployment bind the protected canonical directory and original manifest
digest. Credentials and arbitrary commands are not input fields. The existing
original-candidate consumption contract remains mandatory.

The original downloaded CI archive must include `evidence/delivery-smoke.json`
and nonempty probe evidence bound by `base.closure.delivery-acceptance`.
`runtime-delivery-smoke/v1` identifies the original request, candidate, target,
procedure, result and evidence paths. A local target additionally binds the same
physical directory identity and installed-file facts independently observed by
Runtime. A runner without access to that actual target cannot satisfy the check
with a generic green build. Runtime neither installs the payload nor launches a
coding Agent or arbitrary smoke command; the configured external workflow/Host
performs its authorized work. This does not add remote production deployment.

Native delivery evaluation uses its own `runtimeClosure` observation, original
request and retained action/receipt. An earlier publication quality PASS cannot
stand in for delivery quality. Missing criteria, changed input, unknown receipt,
revoked permission or changed owner/toolchain bindings prevent a new PASS.
An uncertain mutation is inspected through its original receipt, never repeated.
The feedback reader now retains the independently validated original owner inbox
for subsequent archival; this does not create or approve an owner disposition.

The bounded private archive writer preserves original JSON records and CI ZIP
bytes with a manifest and completion seal. It verifies ownership, file type,
permissions, byte lengths and digests. Passive reads never create files. A partial,
foreign or changed archive is retained and cannot be silently repaired by another
write. Individual records are indexed separately rather than flattening a whole
lifecycle into one unbounded JSON value. Up to 512 original records and 32 ZIPs
remain bounded by 1 GiB and a 30-second operation limit. Each original preparation
or decision-source file retains the existing 1 MiB bound and is stored in exact
48 KiB byte chunks, so multiline and full-size documents do not violate the
service JSON envelope limit. The archive includes decision attestations and their
pinned source bytes, not only references to mutable locations. The delivery-ready archive precedes the
execution core's terminal commit; the marker
`DELIVERY_VERIFIED_CORE_COMMIT_PENDING` explicitly describes that ordering. A
sealed archive alone is not a completed lifecycle.

Development regressions cover all three smoke modes, target/candidate mismatch,
missing evidence, fixed CI input, native success/failure and response loss,
original receipt recovery, changed authority, archive readback, missing seal,
changed bytes, links, unsafe permissions and immutable document inventory.
The full-stage graph checks now require original core observations, scope/plan
records, Agent handoff and reports, source review, derived implementation CI,
candidate and verification archives, publication quality, release material and
both exact owner dispositions. Missing required records block archival. A failed
archive cannot report all closure duties as PASS. Rejected owner decisions and
required asset rebinding produce a reviewable followup with no execution grant.

`lifecycle.closure.evidence.read` is a scoped historical read through HTTP,
Streamable HTTP MCP and the common CLI request adapter. It exposes original CI,
Harness, feedback, archive and followup evidence without dispatching work. Local
HTTP/MCP regressions cover same-project access, cross-project denial and no new
external effects. Actual CI smoke, released-owner feedback dispositions, current
Host and selected installation/deployment journeys remain to be exercised before
these contracts can satisfy final checks.

### CI preparation source contract in development

The CI preparation contract carries the original reviewed branch baseline, the
exact immediate input commit, the project change reference and requirements
digest. A `runtime-ci/v1` archive may supply `preparationOutput` only for a request
with `preparationInput`; every declared output file must be present under
`prepared-source/` with matching size and SHA256. This preserves the existing
candidate contract: a preparation output cannot introduce or replace a candidate,
publish software or claim owner validation.

The source observer independently reads the same project's open change, complete
change inventory, declared file bytes and full Git tree. It retains the original
baseline and additionally verifies that the output descends from its immediate
input commit. Unchanged source is allowed, with its evidence still retained.
GitHub uses the existing [commit comparison API](https://docs.github.com/en/rest/commits/commits#compare-two-commits);
GitLab follows exact `parent_ids` from its [single-commit API](https://docs.gitlab.com/api/commits/#get-a-single-commit),
with at most 1,000 commit observations and the original call deadline. Missing,
truncated, mismatched or unrelated ancestry blocks use; a CI success field cannot
substitute for these observations.

The deterministic source reducer selects only a consumer's dependency ancestors.
Sequential operations must extend their exact predecessor evidence. Required
parallel branches with different resulting commits block the join; identical
commits combine every branch's evidence instead of choosing whichever finished
first. The following candidate must bind the resolved final source.

The registered executor is limited to the `before-candidate` slot. It fixes the
workflow, requirements, complete local/global CI evidence mapping, original
preparation and predecessor outcomes before dispatch. It retains the original CI
request, run, archive, independently observed output source and both native owner
actions/receipts. Harness receives Runtime's exact input/output/source facts;
CI cannot supply or replace that reserved observation. Native context binds the
resulting tree and original requirements. A passing CI run alone cannot advance
the lifecycle or create a candidate.

Lost responses reconcile the same original request and native actions. Completed
source proofs are usable only after the original stage outcome and every
required CI/native result pass. Later artifact checks inspect every consumed
preparation archive; configured scope reviews use their exact resulting source.
Closure retains the original run, source proof, archive and native receipts.
Missing or corrupt evidence blocks downstream use instead of falling back to
the original implementation commit. HTTP and MCP read the same retained evidence.

Source regressions cover changed/unchanged output, response loss, restart,
sequential/parallel preparation, native input mismatch and full closure with
downstream checks/reviews. Their synthetic providers and the separate read-only
GitLab probe do not establish actual source-changing workflow qualification or
final candidate acceptance.

## Independent Expert and Host transport development

The Runtime package includes one `evopilot-runtime` Codex plugin containing its
Expert Skill and HTTP MCP configuration. The Skill resolves the selected project,
guides the eight mandatory stages and completes configuration activation in the
same conversation. Existing applicable authorization persists across follow-ups.
The Skill cannot grant permissions or replace the service's checks. Ontology and
Harness authoring remain at their existing owner entries.

An operator-generated `runtime-host-connection/v1` fixes the loopback origin,
workspace, project, principal, service identity, package version and protected
credential reference. The HTTP helper reads that scoped credential directly for
Codex; no token appears in the public plugin, URL, arguments or project YAML.
Codex expects `http_headers_helper` to be a command string. Each fixed path and
argument is independently shell-quoted, including paths with apostrophes or
metacharacters. This configuration was loaded by the actual Codex plugin parser
and used for a real read over HTTP in an isolated development probe.

The stdio bridge forwards the same current `runtime_read` and `runtime_write`
tools to the independent service. It opens no Runtime database, starts no service
and grants no additional authority. Scope, CAS and original request IDs survive
forwarding. Lost, malformed or incomplete write responses remain unknown and are
not automatically retried. This transport test does **not** establish the full
0.8.3 legacy tool mapping or owner transition; those remain separate E15 work.

## Operator installer development

`evopilot-runtime-install <command> --plan-ref <protected-file>` is a separate
local operator executable. Commands are `stage`, `install`, `start`, `inspect`,
`stop` and `uninstall`. It is not an HTTP/MCP operation and is not reachable from
the Runtime execution dispatcher. Source guards preserve that boundary.

The exact `runtime-install-plan/v1` binds a private installation directory,
selected distribution and archive SHA256 values, a complete prepared-package
inventory including locked production dependencies, Node identity, workspace,
initial project and principal, explicit reader/editor/activator role, bounded
credential expiration, port and optional existing integration reference. A
`runtime-standalone-distribution/v1` manifest binds the original archive and all
prepared regular files/internal links. These operator-supplied pins must come
from the separately reviewed release material; matching hashes are not release
authority. The installer checks and copies this prepared distribution; it does
not download arbitrary dependencies or infer a trusted manifest from a directory.

Installation retains its original plan, credentials, distribution inventory and
append-only operation records. Exact local staging can resume missing package
files; changed files, foreign directories, different plans and another active
installer are rejected. Initial credentials grant only the explicit bootstrap
role, never execution, decision or release authority. Existing credentials are
not silently replaced. An omitted or null `legacyMigration` leaves all legacy
workspaces untouched. Explicit migration selects a separate `workspaceRoot`,
`expectedSnapshotDigest`, `backupRoot` and `expectedBackupDigest`; the original
workspace must have the installation's `workspaceId`. Prepare the closed-store
snapshot and verified Runtime-owned backup using the migration API below before
freezing this installation plan. Neither directories discovered on disk nor a
passing package check select migration implicitly.

`stage` verifies the selected backup and prepares the package/credentials without
adopting the old store or starting a service. `start`/`install` hold the new
store's writer lock while the existing migration API rechecks the source and
commits its adoption seal. The installer retains `legacy-adoption.json` and
`legacy-binding.json` before launching with that exact `--legacy-ref`. The
binding uses the new store's durable service ID, never a caller-invented ID.
Interrupted retention resumes from the committed seal under the same plan;
conflicting retained files require inspection and are never overwritten.
Newer records are not replaced by backup contents. An already-running service
is observed without opening another writer, and its live migration digest must
match the retained binding. Missing or corrupted binding material blocks startup
or readiness but does not prevent stopping the exact owned launchd process.

This operator integration migrates Runtime-owned state only. Before an actual
workspace cutover, stop and verify the old writers, retain the separately
verified complete workspace backup, and verify owner/provider dependencies and
Host entry transition. These additional delivery obligations are not certified
by this installation result. Stop/uninstall never downgrade or restore legacy
data and retain both the migration receipt and original backup.

A migrated installation adds a fixed `evopilot_runtime_legacy` stdio entry to the
same plugin beside its primary HTTP entry. This bridge uses `--legacy-only`:
it advertises original aliases, not another `runtime_read`/`runtime_write` pair.
An optional `legacyOwnerHost: {ref, digest}` in the immutable installation plan
selects the protected historical owner registration. Its digest is SHA256 of
canonical JSON. Stage verifies the exact project/workspace and this installation's
future `legacy-binding.json` path before adoption. The generated plugin passes
the same configuration digest to the bridge, so even a new Host process rejects
changed permission selections. No owner selector is enabled merely by migrating
Runtime. An expired or changed owner selection cannot prevent stopping the owned
service. Preparing these files is not current-chat or final installation acceptance.

The macOS service uses its own deterministic user `launchd` label, fixed argv,
private stdout/stderr and umask. It does not invoke a shell or kill another
process by port. A repeated start checks the existing label, executable, argv,
startup receipt and live identity. Stop removes that exact launchd item and
confirms the original process has exited. The plist is kept under the private
installation directory and explicitly bootstrapped; automatic login registration
is not inferred. Uninstall retains user data, packages, credentials and audit.

The optional exact Codex executable is digest/version checked. `install` uses
Codex's supported marketplace/plugin commands for this one installation and
reads back the installed identity; it reconciles an existing exact registration
before a retry. With no Codex registration selected, the plugin is only staged.
Both paths return `AWAITING_HOST_VERIFICATION`: file creation, registration and
HTTP readiness alone do not prove a current chat loaded the plugin. Actual Host
readback, isolated release-bundle installation, legacy migration and final
candidate qualification remain required before installation acceptance.

Development tests exercise actual own-label launchd start/stop/restart on macOS,
duplicate-writer protection, port-conflict recovery with a foreign listener,
retained draft receipts, staged-package corruption/recovery and scoped secrets.
On non-macOS the launchd cases assert the explicit unsupported-platform guard;
that result is not macOS process acceptance. These source and transport results
do not mark any final 664-instance acceptance result as passed.

## Managed legacy store development

The compatibility foundation retains Runtime's original domain representation
behind an internal managed service. Rewriting old records into lifecycle objects
would unnecessarily change revision and receipt semantics; a historical reader
alone would not meet the accepted ownership migration. The chosen incremental
path preserves the existing owned implementation and adds an explicit service
binding. It does not import the parent daemon or another owner's source.

The operator-only migration API inventories a closed legacy workspace, checks its
identity, retained ledger, native evidence and relocation lineage, and hashes all
original SQLite tables. To avoid the side effects of opening a WAL database even
with a read-only connection, original inspection opens a private scratch copy.
It checks source bytes again and requires a separate, digest-anchored backup
before adoption. Database files, Runtime blob roots, empty owned directories and
workspace identity are retained. Ontology/Harness data, credentials and external
evidence references are not copied by this owner-specific backup. A complete
workspace cutover still needs the separately verified full backup and dependencies.

Adoption adds one immutable migration record and schema version 9 without
rewriting original records, counters, decisions, budgets or receipt identities.
The seal binds the workspace, independent service identity, original snapshot and
verified backup. Current direct legacy entry points reject adopted databases;
managed calls require the matching internal context and one OS-held SQLite writer
lease. An exact adoption retry reads the original seal and cannot restore an old
snapshot over newer evidence. Readiness writes preserve the managed schema.

A new 0.8.x process rejects schema 9. This does not revoke an already-open old
binary: the operator must stop and verify original writers before cutover. Active
WAL sidecars reject original snapshot preparation; they are never deleted to make
a live database look quiescent. No in-place schema downgrade or automatic restore
is provided. Isolated rollback tests retain the entire newer managed directory
separately and restore the verified old backup at its original canonical identity.
Relocating a backup without the original lineage procedure is rejected.

This internal foundation grants no legacy HTTP mutation authority and does not
enable a project definition or turn a historical UNKNOWN Run into success. Old
tool/CLI routing, current permissions and applicable lifecycle admission, owner
entry transition and actual accurate-candidate
cutover remain required. The managed-store tests are development evidence, not
completion of E15 or the final acceptance catalog.

## Legacy Runtime transport development

An operator may start the independent service with `--legacy-ref` pointing to the
private, exact adoption binding. The binding must match that service's existing
workspace/service identity. The authenticated status indicates whether legacy
access is bound. A request cannot initialize, adopt, select or replace a legacy
store, install a provider, or register owner authoring operations.

`runtime.legacy.read` and `runtime.legacy.write` carry a fixed family and original
envelope. The explicit catalog covers request, native, planning, readiness,
readable, feedback, online, response and reconstruction. Input/domain validation,
human decision evidence, old reconstruction fields/budgets and retired JSON Run
restrictions remain in their original Runtime-owned implementations. The gateway
adds current project permissions and reauthentication at the existing managed
store guards, including after asynchronous provider reads. It does not create a
new software lifecycle instance or grant stage/release completion authority.

Write request IDs and expected revisions refer to the original family, not the
independent service's project counter. The new service separately records scoped
`legacy-call-admitted` audit events with principal, original IDs and intent hash.
These events are only transport admission, never successful business receipts.
Original receipts remain authoritative; a lost response is recovered with the
same family and original request/Run/attempt identity. No transport retries a
mutation automatically or converts an unknown result into success.

The optional stdio bridge advertises the original Runtime `request`, `native`,
`dispatch`, `reconcile`, `inspect`, `activate`, `deactivate` and `capabilities`
aliases when a legacy binding exists. It forwards to the same authenticated HTTP
service and opens no local store. Session activation merely verifies the existing
service. The legacy CLI's `request` and `native-request` support the protected
`--connection-ref` alternative to direct workspace arguments. Direct opening of
an adopted store remains rejected; connection failure never selects local mode.

An optional `--owner-config-ref` on that Host bridge preserves the historical
`request`/`native` owner selector. Its protected
`runtime-legacy-owner-host/v1` registration binds one workspace/project, the
exact `legacyBindingRef`, expiration, both publisher-verified 0.8.3 package roots,
and explicit `request:<operation>` / `native:<operation>` allowlists for each
owner. Optional `nativeToolchain` uses the existing pinned validator registration.
No wildcard, arbitrary import path or owner method name is accepted. Owner stores
must already exist and match the original workspace identity. The registration
selects allowed Host calls; it is not semantic approval or publication authority.
`--owner-config-digest` optionally pins this selection for manual bridge startup
and is mandatory in installer-generated owner entries. Capability output lists
the selected public routes, not proof that every required provider is ready.

These calls execute through the published owner public API in the Host process,
outside Runtime's HTTP operation dispatcher. Each owner retains its own input
validation, original request ID/revision, domain decisions and receipts. The
primary Runtime HTTP service still has no asset authoring/publication operation.
The protected registration and migration binding are reread before each call;
expiration, scope drift, unexpected package bytes or disconnected Runtime fail
closed. A lost/failed call is never automatically repeated. Inspect the original
owner receipt instead of substituting Runtime's project revision or a new ID.

Host provider wiring resolves published native dependencies, feedback material,
Ontology readiness projections and the original Runtime modeling intent.
Runtime intent/feedback/repair/execution/reconstruction reads use the same
authenticated HTTP compatibility gateway. This path never opens a legacy Runtime
database. Ontology receives only its exact public provider descriptors, distinct
from Harness callbacks. The bridge supplies no model profile or LLM loop.

Harness response prerequisites can read original `collection:<id>` and `run:<id>`
evidence through that same Runtime HTTP gateway, or delegate a Harness reference
to its own published `response.evidence.inspect`. Reads retain the exact scope,
workspace and reference digest. Collection raw bytes are checked by the original
Runtime reader; the Host checks its receipt/claim digest and original observation
time. Run projections require retained collection references and both owner
outcomes, using the oldest collection observation. `FAIL` and `UNKNOWN` are
preserved. No read dispatches collection or retries a Run. Workspace governance
references use the separately bound project-ledger reader described below;
unsupported owners do not become caller-asserted `PASS` evidence.

An optional `project` object in that same protected Host registration contains
the canonical private project `root` and exact helper `calls`. The root must be
owned by the current user, have mode 0700, match the migrated workspace marker
and remain separate from service state and installation roots. It adds the
historical `evopilot_v01_native_project` and `evopilot_v01_workspace_project`
tools to the optional local entry; they still require session activation.
Native helper calls use `native:<operation>` for `preflight`, `prepare`, `freeze`,
`materialize`, `review-domain`, `inspect`, `check-layout`, `candidate-location`,
`prepare-execution` or `promote`. Ledger calls use `workspace:<operation>` for
`bind`, `inspect`, `drift`, `baseline.accept`, `campaign.write` or
`campaign.inspect`. A selection grants only routing, never a domain decision.

Runtime now owns these retained source-inventory, frozen-candidate, editable
material and Target/Loop helpers. Their parent source attribution and unchanged
project standard bytes live under `provenance`; installed code imports no parent
implementation. The owning core is `src/compat/project`; local transport and
owner admission routing remain in `src/host/project/routes.ts`. This separation
allows registered Runtime provider composition to reuse its own project readers
without importing Host integration or exposing owner authoring in HTTP.
Native preflight delegates to exact published owner validation
exports. Every call rechecks the registered native-toolchain manifest; changed
bytes invalidate the original binding even in an already connected Host.
Source/fragment/requirement drift, revoked configuration, missing exact review
and changed material block admission. Owner authoring callbacks synchronously
check the actual frozen materials and reviewed source context. They do not use a
detached authoring cache. L1/L2/L3 intent and the current v2 content semantics are
preserved: preparing or freezing a candidate issues no grade, and v2 L3 content
grading does not require business reconstruction or database access.

Promotion still requires the original domain decision and a completed Runtime
project read through authenticated HTTP; custom files and original evidence are
retained. The Target/Loop ledger remains structural `authority:false` evidence.
Its optional response reader checks exact file/loop digests and preserves the
original observation sentinel `1`; a structural PASS cannot become a fresh
operational prerequisite. `prepare-execution` retains its original fixed `node`
toolchain: the current Host interpreter's canonical path and exact bytes are
pinned before copying reviewed source into a separate execution directory.
Unregistered toolchains, changed tool bytes or an altered existing copy are
rejected. This helper neither runs the copy nor registers a collection executor
in the HTTP service; original approved claims and execution-provider composition
remain separate prerequisites.

This transport implementation and isolated real-owner validation do not establish
the entire historical authoring or maintenance workflow. Online providers,
old Runtime execution-provider wiring, complete maintenance mapping, actual Codex journeys
and accurate-candidate migration remain required before N09/E15 can pass. No
unsupported owner capability is supplied by changing an owner product or importing
parent implementation modules. The original component split scope is unchanged.

Registered Ontology/Harness consumption uses the managed service's scoped intent
reader when `--legacy-ref` is present. It verifies the same workspace/root and
cannot fall back to another Runtime handle when that reader is unavailable.
Published owner API/version checks and native/asset-content semantics remain
unchanged. Trusted legacy external providers are still explicit process
integration; the gateway does not infer them from paths or client requests.

Owner authoring and the old workspace/native-project/toolchain maintenance
helpers are **not** silently redirected into Runtime HTTP mutations. The old
combined daemon initializes Runtime at startup, so keeping it configured cannot
prove owner compatibility after adoption. The dedicated owner-entry transition,
remaining maintenance mapping, installer cutover and accurate-candidate Host
qualification remain explicit M3/M5 work. Current transport tests and isolated
published-owner consumption evidence do not close E15/N09 by themselves.

### Registered original Runtime providers

The compiled development `serve` command accepts an optional
`--legacy-providers-ref <protected-json-file>` together with `--legacy-ref`.
Without that explicit registration, original execution providers remain absent.
The `runtime-legacy-providers/v1` file binds `workspaceId`, an exact `projects`
allowlist, `legacyBindingRef`, canonical private `projectRoot`, `expiresAt`,
both `owners.<ontology|harness>.packageRoot` values and the existing pinned
`nativeToolchain` registration. Optional `collection` has exactly
`kind: "node"`, the canonical current Node `executable` and its raw hexadecimal
`sha256`. No request may register programs, modules or owner methods.

This composition reuses the original Runtime project readers, fixed requirements
and project verifier. Native Run execution resolves the exact published 0.8.3
assets, validates them through the existing scoped owner consumer adapters and
reads both original owner receipts. Deterministic owner request IDs, validation
context, claim/input digests, standard pins and the original family revision
remain unchanged. Reconciliation reads existing receipts; it does not validate
again. New v2 content assessment reads remain separate from reconstruction.

Provider callbacks receive an authenticated invocation context and a read-only
view of the same managed Runtime. There is no ambient service principal, second
Runtime handle or caller-supplied PASS. Reads reject another project and all
write operations. Current principal revision/permission, operator registration,
workspace identity and native-toolchain manifest are rechecked across awaits.
Configuration changes require a deliberate reconnect, and grants still do not
replace original collection/Run decisions or project completion review.

The optional collector uses the original macOS isolation profile and durable
request/process/result journal. It pins the reviewed source and registered Node
bytes, denies writes outside the execution copy and permits only explicitly
reviewed loopback networking. Existing host file-read access is retained; this
is not a confidentiality sandbox for untrusted programs. Raw stdout/stderr and
declared output digests remain protected evidence. Timeout, cancellation,
changed pins and output limits cannot become success. Termination is requested
once per owned process group so buffered output cannot trigger a second signal
after exit and lose the final receipt. A failed signal is recorded as failure;
an unresolved result remains UNKNOWN. Revocation requests cancellation through
the same owned journal. An existing journal never authorizes another dispatch.

Compiled CLI, migrated HTTP and local stdio development probes exercise actual
published owner validation and isolated Node execution with explicitly synthetic
source, assets and decisions. They grant no real-project or product acceptance.
Installer registration, original feedback/response/online/reconstruction provider
composition, complete maintenance mapping and exact-candidate E15 qualification
remain separate unfinished work.

### Browser authentication and monitor transport development

The two-page Dashboard uses the same independent service, store and definition
validator. It does not run a second server-side definition state machine. The
browser surface is smaller than the Agent API: draft save and exact
save-and-activate are its only configuration writes. It has no execution,
decision, release, legacy or owner-authoring operations. Browser requests retain
the original request ID, revision, validator result and receipt; a rejected
activation keeps the draft and previous active version.

An authenticated local client can request a one-use connection code for one
authorized project. A same-origin browser POST exchanges that code within five
minutes for an HttpOnly, SameSite=Strict cookie scoped to the Dashboard API.
The service bearer never enters a URL, browser storage or cookie. The browser
session expires within one hour or at the original credential expiry, whichever
comes first. It rechecks the original credential and principal on requests and
stream polls. Rotation, revocation, changed permissions and service restart
require reconnecting. Cookie authentication cannot access the Agent API or MCP.
All Dashboard POSTs require the exact Origin; authenticated POSTs also require
their session's CSRF proof. This connection exchange is not a credential manager
or an additional product page.

The dedicated monitor snapshot returns each instance's pinned graph, original
Goal/Target/Loop references, candidate digest and observed stage facts. It omits
YAML, semantic configuration and editor payload. Pages are bounded and retain
the original project revision; a concurrent revision change requires a fresh
snapshot. The dedicated event stream retains authenticated cursor semantics but
omits every event data body. It prompts state readback instead of interpreting
events as completion or permission to dispatch. Credential revocation also ends
the stream. Unknown and pending instance facts remain unknown and pending.

### Two-page Dashboard development implementation

The packaged loopback service serves `/lifecycle` and `/monitor`, with no third
product page or development server. `evopilot-runtime browser-code
--connection-ref <protected connection>` verifies the selected service identity
and prints its local URL and a one-use connection code. Enter the code in either
page. A reader can browse; draft editing and activation require their separate
existing permissions. No long-lived token is placed in the browser.

The definition page presents the actual hash-pinned MIT SeeCode graph renderer,
node properties and the original YAML. The complete local renderer import closure
and provenance are checked during build; no remote fonts, scripts or renderer CLI
run in the browser. Click or keyboard-select a node to configure it; drag or arrow
keys change presentation coordinates only. Project extensions can be inserted in
the four publisher slots, configured and connected within the same slot. Base
dependencies and checks remain locked. AST edits preserve comments and unrelated
fields. Incomplete extensions remain selectable, and their graph is explicitly
labelled a draft preview until the shared service compiler validates that source.
An invalid or unsupported graph falls back to node selection without discarding
the YAML. Browser graph construction never supplies readiness or execution proof.

Saving a draft preserves its exact source. The same page can validate, show the
complete textual difference from the active revision, then save and activate using
that reviewed validation digest. A background preview cannot replace the digest
selected for activation. Concurrent writes preserve the local text and require
readback. An uncertain write retains only its original request identity in session
storage; the UI inspects its receipt and never submits a replacement automatically.
YAML and long-lived credentials are not stored in browser storage. Reauthentication
to the same project retains unsaved text in the open page's memory. Closing or
reloading the page still loses unsaved memory, with an unsaved-navigation warning.

The monitor only reads the dedicated snapshot/event endpoints. It displays pinned
instance definitions, stage status, request identity and retained receipt details;
it has no YAML, edit, dispatch or release controls. Events trigger complete state
readback, rather than becoming a PASS. Duplicates are ignored, gaps trigger a fresh
snapshot, and disconnects mark the last observed data as stale while bounded
read-only reconnect/polling continues. Revoked access requires a new connection.
Desktop and narrow layouts retain scrollable graphs, source and stage tables.

The real Chromium development suite runs against an isolated HTTP service and
durable store, with explicitly synthetic owner bindings and stage observations.
It checks graph/source editing, same-page activation, stale bindings, conflicts,
original-request recovery, permissions, service restart, live instance events,
fallback and narrow layouts. It is separate from all 664 frozen exact-candidate
acceptance instances and does not certify real owner/CI/Host integration, daily
installation or release. Run it after build using
`node node_modules/@playwright/test/cli.js test --config
tests/browser/dashboard-v090.config.mjs`; optional `EVOPILOT_BROWSER_OUTPUT` keeps
screenshots/traces in a private evidence directory.
