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
predecessors. Project review and CI preparation extensions, independent Host
integration and full lifecycle acceptance remain M3 work.
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

The other publisher-registered actions (`runtime.review.scope`,
`runtime.operation.ci-prepare`) and preparation-generated
source propagation remain implementation obligations. Unsupported actions fail
closed; their presence in the compiler registry does not establish an executor.

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
