# Independent lifecycle API

This is the implemented v0.9 development API, distinct from the retained
[native owner API](service.md). Start with the [operator guide](runtime-v090.md).
The package version and final acceptance status must be read from the selected
candidate; this reference does not announce a v0.9 release.

## Transport and envelopes

The local service binds loopback. Clients send authenticated JSON to
`POST /api/v1/request`; `/mcp` exposes `runtime_read` and `runtime_write` over
Streamable HTTP. MCP does not bypass the same dispatcher, permissions or revision
checks. The declared MCP versions are `2025-06-18` and `2025-11-25`; its responses
are JSON, without MCP SSE sessions. Lifecycle event streaming is a separate API.
The independent CLI forwards protected envelopes using `request --request-ref`.

A read envelope contains exactly:

```json
{"operation":"lifecycle.definition.inspect","projectId":"example","input":{}}
```

A mutation additionally contains a stable `requestId` and the current project
`expectedRevision`. These are illustrative fields, not an authorized request:

```json
{"operation":"lifecycle.draft.save","projectId":"example","input":{"yaml":"projectId: example\n"},"requestId":"save-draft-1","expectedRevision":0}
```

This deliberately incomplete YAML can only become a draft. Initialization is not
complete until all required fields and referenced dependencies validate. Raw
secrets are rejected rather than stored in YAML. Keep credentials in protected
local files and authorization headers. Query parameters must not carry secrets.

Responses wrap `requestId` and `result`, or a safe `error` with `code` and
`message`. Successful mutation results contain the retained receipt, including
its revision and nested operation result. HTTP success does not imply activation:
inspect the nested `DRAFT`, `BLOCKED` or `ACTIVE` status and issues. Node's SQLite
warning is stderr, not a service result.

## Definition and instance operations

All operations require current project `read` permission. Additional permissions
and immutable input contracts are checked at the service boundary.

| Operation | `input` | Additional permission / result |
|---|---|---|
| `runtime.status` | `{}` | Service/workspace/version and project revision |
| `runtime.projects.list` | Optional `cursor`, `limit` | Only scoped projects; limit at most 50 |
| `runtime.events.read` | Optional `cursor` | Bounded events or a recovery snapshot |
| `runtime.receipt.read` | `requestId` | The original retained receipt |
| `lifecycle.base.inspect` | `{}` | Publisher pin, fields, stages, slots and exact registered actions |
| `lifecycle.definition.inspect` | `{}` | Draft/active summaries and current project revision |
| `lifecycle.definition.read` | `revisionId` | Exact revision summary and compilation |
| `lifecycle.definition.source.read` | `revisionId`, optional `offset` | Original YAML bytes, Base64 encoded and paged |
| `lifecycle.definition.validate` | `yaml` | Compilation, current bindings, `ready`, issues and validation digest |
| `lifecycle.draft.save` | `yaml` | `draft.write`; preserves original source and current active revision |
| `lifecycle.definition.activate` | `revisionId`, `validationDigest` | `definition.activate`; enables an existing exact revision |
| `lifecycle.definition.save-and-activate` | `yaml`, `validationDigest` | Both draft and activation permissions; atomic same-entry activation |
| `lifecycle.instance.create` | `instanceId`, `definitionRevisionId`, `authorityRef` | `execution.request`; exact active revision and current separate authority required; does not dispatch a stage |
| `lifecycle.instance.inspect` | `instanceId` | Pinned instance, current project revision and native recovery linkage when available |
| `lifecycle.correction.inspect` | `stageRequestId`, optional `correctionRef` | Original verified observation, separately retained hypothesis and available protected capture history |
| `lifecycle.correction.propose` | `stageRequestId`, `hypothesis`, `minimalVerification`, `proposedChanges`, optional `verification: {instanceId, stageId}` | `draft.write`; immutable proposal, optional pre-bound existing native check; no execution or release authority |
| `lifecycle.correction.admission` | `stageRequestId`, optional `correctionRef` | `execution.request`; read-only repair eligibility, original request and remaining gates |
| `lifecycle.stage.admission` | `instanceId`, `stageId` | `execution.request`, also `release.request` for publication; reads current admission without dispatch |
| `lifecycle.stage.request` | `instanceId`, `stageId`, optional `correctionRef` | `execution.request`, also `release.request` for publication; ordinary graph, authority and budget gates remain required; a correction reference binds only its previously selected native verification |

The authoritative definitions are in [definition service](../src/lifecycle/service.ts)
and [HTTP dispatcher](../src/server/http.ts). Stage requests, observations,
preparation, Agent claims and retained authority use their separately validated
operation families. The installed [Expert execution guide](../plugins/codex/skills/evopilot-runtime-expert/references/execution.md)
documents that governed workflow. A configuration-only client cannot obtain
execution or decision authority by selecting a write tool.

## Native Loop budget accounting

For a prepared Target, execution authority binds a native budget window to the
workspace, project, Goal and exact Target ID/version. `maxLoops` remains an
integer from 1 through 4. The window uses the minimum of the reviewed execution,
plan and verification limits; a stage's lower limit can further restrict its
admission. `maxAttempts` separately limits attempts within a Loop.

The execution authority subject accepts these illustrative selections:

```json
{"loopWindow":{"mode":"NEW","predecessorRef":null}}
```

```json
{"loopWindow":{"mode":"EXISTING","ref":"loop-window:sha256:<exact-original-digest>"}}
```

These fragments are not complete requests or approvals. For the first authority
only, omission is normalized to a visible `NEW` selection if no prior window or
authority history exists. Once history exists, select the exact existing window
or explicitly review a later `NEW` window with its actual `predecessorRef`.
A new window cannot refill an active window before its fixed deadline.

The window starts when its founding decision is committed, not when an instance
is created. Its deadline is the earlier of the reviewed timeout and authority
expiry. `lifecycle.authority.record` returns the committed window reference,
digest, deadline and limit. The first retained `lifecycle.stage.request` charges
one distinct `loopRef` atomically with the request, receipt and event; its result
contains `loopCharge`. Creating instances, previews, replays, restarts and
reconciliation do not create fresh capacity. Successor instances for the same
Loop retain its original charge and recovery limits.

`lifecycle.instance.inspect` exposes `loopBudget`: native identity, window
reference/digest, deadline, `maxLoops`, `consumed`, `remaining`, current-window
status and the selected Loop's ordinal/original request. This is observation,
not execution authority; an expired or revoked window may still have a retained
unused count. Admission checks current permissions, deadline, stage limits and
remaining capacity again. Missing legacy accounting is `UNAVAILABLE` with null
counts, never an invented zero; such history remains readable/reconcilable but
cannot authorize a new native dispatch. `LOOP_WINDOW_SELECTION_REQUIRED`,
`LOOP_WINDOW_ACTIVE`, `LOOP_BUDGET_EXHAUSTED` and `LOOP_BUDGET_UNAVAILABLE` require
inspection of the existing window, not an automatic retry with new identifiers.

## Exact activation and recovery

Read the current definition, save a draft if desired, and validate the exact YAML
under the same principal. The returned `validationDigest` binds source, semantic
definition, current dependency stamp, project and principal revision. When
`ready` is false, correct the reported field/rule/remedy; do not substitute an
invented successful digest. A fresh preview is required after applicable changes.

Submit the exact definition and digest with the current project revision.
`ACTIVE` switches the pointer atomically and retains an audit event. `BLOCKED`
keeps the previous active definition; save-and-activate also retains the attempted
draft. Authorization, stale CAS and malformed-request failures may reject before
any mutation, so inspect the actual receipt and state. Activation does not change
in-flight instance pins, start work or authorize software publication.

Identical replay of a retained request returns its original result without a new
side effect, subject to current access checks. Changed content under that ID is
rejected. `REVISION_CONFLICT` requires inspection; do not refresh revisions and
blindly repeat. After transport timeout, read the original receipt/claim before
another write. A missing or unknown outcome is not success or cancellation.

## Pages, authentication and limits

`/lifecycle` and `/monitor` are the two UI routes. Obtain a single-use connection
code with the installed CLI. The browser establishes its scoped protected
session; mutations require same-origin checks and CSRF protection. The monitor
projection does not return YAML/editor payloads or grant write capabilities.
Credentials expire and permissions are rechecked; old previews cannot revive
revoked authority. No member-management or public-cloud service is implied.

Ordinary JSON input is limited to 256 KiB. YAML has its own 256 KiB limit; JSON
envelope overhead also counts toward the request limit. Source reads return at
most 32 KiB of decoded source per page. Follow `nextOffset` until null for the
same revision, concatenate decoded bytes, then decode UTF-8. Do not decode each
partial byte page independently. List/event pages are bounded to 50 items and
256 KiB. Exact large native evidence reads have their separately declared bounded
profile; they are not permission to enlarge ordinary requests.

Retain `requestId`, exact source/revision digests and the original error. Common
failures include `UNAUTHENTICATED`, `FORBIDDEN`, `REVISION_CONFLICT`,
`VALIDATION_STALE`, `BINDINGS_NOT_CURRENT`, `INLINE_SECRET` and `INPUT_LIMIT`.
Structural issue codes may appear inside an HTTP-successful `BLOCKED` result.
Do not log raw tokens, browser codes, cookies or private credential files.

### Registered evidence qualification (v2)

The optional `runtime.qualification` resource in the protected integrations file
selects an existing published Harness policy, its original publication request,
allowed assessment decision principals, and explicitly registered closed probes.
`serve --integrations-ref` connects the same implementation to HTTP, MCP, and the
CLI request adapter. Registration does not grant permission to run a native
assessment. API inputs never accept facts, a verifier, a permit, an input-closure
claim, a passing observation, or a policy verdict.

The policy package supplies `sources/runtime-profile.json` and
`data/qualification.json`. Their exact published inventory must contain 709 cases,
698 PRE and 11 POST, with 681 always-execute and 28 conditional cases. Current
registration, original publication receipt, owner registration, profile digest,
phase and policy bounds are checked again at consumption. This capability does
not publish or activate the pending Runtime policy proposal.

Authenticated `runtime_read` operations:

- `lifecycle.qualification.origin.inspect`: `{registrationRef, caseId}` reads
  retained closed-probe attempts; optional `afterRequestId` and `limit` (1–50)
  page the public summary. Internal qualification still checks every attempt.
  `{registrationRef, caseId, originRef}` reads an original registered CI capture.
  Unknown closure/history remain `EXECUTION_REQUIRED`, with `fallback: FULL`.
- `lifecycle.qualification.assessment.preview` and `.inspect`: `{planRef}`.
- `lifecycle.qualification.inspect`: `{actionRef}` reads the original owner
  receipt and returns a fresh applicability record without dispatching or writing.
- `lifecycle.qualification.execution.inspect`: `{captureRef}` reads a typed
  current execution. It is not cross-candidate reuse.

All writes use the ordinary `requestId` and `expectedRevision` envelope:

1. `lifecycle.qualification.probe.execute` takes
   `{registrationRef,caseId,candidateDigest,expiresAt}`. It runs the fixed closed
   JSON evaluator against registered original files, with a durable start before
   evaluation. Probe results always have `formalAcceptanceEligible: false`.
2. `lifecycle.qualification.plan` takes
   `{registrationRef,caseId,currentCandidateDigest,originalExecutionDigest,phase,deadlineAt}`.
   It retains exact protected inputs and an immutable native request identity.
   The deadline is at most ten minutes and cannot outlive the original evidence,
   credential or registration. No grant or native effect is created.
3. `.assessment.authorize` takes `{planRef,reviewDigest,evidenceRef}` after an
   exact preview. Existing authenticated decision-record policy and pinned
   decision evidence apply to the separate
   `lifecycle.qualification.assessment` decision subject. `.assessment.revoke`
   takes `{planRef,reason}`. A revoked grant cannot be revived or reset.
4. `.prepare` takes `{planRef}` and retains the exact native validation request.
   `.dispatch` takes `{actionRef}`. Dispatch retains its original marker and
   receipt before invoking the published owner. Current authorization is checked
   before and after that marker. Unknown outcomes require original receipt
   inspection; a different client request cannot redispatch that action.

`lifecycle.qualification.execution.capture` takes
`{registrationRef,caseId,originRef}`. This registered CI path requires an exact
completed original request, native owner evaluations, original archive and raw
case bytes, and a collector mapping in the published policy's optional
`sources/execution-producers.json`. The fixed mapping is
`{schema:"runtime-execution-producers/v1",cases:[{caseId,phase,collectorPath,collectorDigest,workflowDigest,catalogDigest,maxAgeSeconds}]}`;
`maxAgeSeconds` is 1–86400. The collector must emit
`runtime-case-execution-receipt/v2` with exact case/source/candidate/request/input,
actual start/completion timestamps, PASS outcome and nonempty assertions. An
unapproved collector, generic JSON PASS, missing native receipt or old UNKNOWN
capture is insufficient. Capture does not assert complete reuse dependencies.
The receipt's `candidateDigest` is the actual inner Runtime distribution manifest
digest; `lifecycleCandidateDigest` is the distinct outer artifact-set identity.
The original CI manifest must bind the real distribution manifest, tar archive
and source-revision file. Runtime checks every archived distribution entry.
Private source records use `runtime-current-execution-source/v3`; public captures
remain v2 and expose `origin.distributionIdentity`. Old source records are not
migrated or relabeled: history stays readable, but formal consumption requires
the original inner-byte proof. An echoed manifest alone cannot supply it.

The optional `sources/qualification-producers.json` in the published policy may
select one `runtime-lc20-producer-contract/v1`. It pins the complete LC20 collector,
EXECUTE/INVENTORY workflows, fixed input graph and
`runtime-lc20-local-installed/v1` protocol. The workflow registration's optional
`qualificationProducer: {registrationRef,caseId:"LC20",mode}` is copied into the
original stage plan before its request CAS. No legacy plan gains a default field.
Only `runtime:installed-code`, `runtime:environment`, `runtime:toolchain`,
`runtime:configuration` and `runtime:prestate` use `digest:null` in that contract:
their actual digests come from Runtime's protected pre-dispatch observation.
Every static source, collector and file input still requires an exact hash.
Null is neither a caller wildcard nor permission to ignore changed inputs.

For this producer, `.origin.inspect` accepts
`{registrationRef,caseId:"LC20",originRef:"stage-request:…",protocol:"runtime-lc20-local-installed/v1"}`.
It reads the original plan and actual current installed code, Node/shared objects,
registered owner/toolchain and complete closed-child history. It returns
`PROVEN_FIXED_INPUTS` or `FULL`, never execution authority. Source loaders,
unreadable dependencies, incomplete/failed child histories and changed inputs
stay unproven. This is a finite protocol, not an arbitrary OS sandbox verifier.
The versioned prestate projection requires every original child attempt to be
terminal PASS and sufficient remaining capacity for the fixed ten-attempt maximum
per child; complete original history digests are retained separately and rechecked.

The collector saves `evidence/lc20-input-snapshot.json` before its first child
action and `evidence/lc20-execution.json` only after all four vectors, all six
baseline/full child executions, actual selective executions, native child
assessments and before/after protocol observations agree. Child formal credit
remains zero. Missing assessment grants return `WAITING_FOR_GRANT`; an uncertain
write only reads its original receipt. The existing independent grant workflow
must authorize each actual native assessment.

For a complete original, `.plan` additionally accepts the paired selectors
`originalOriginRef` and `currentInputRef`. Both resolve original managed stage
requests and actual archives; current candidate identity is never caller evidence.
INVENTORY captures establish no case execution. History spans all managed LC20
claims across candidates and registrations, including FAILED/UNKNOWN claims.
Each later qualification selects the original EXECUTED A, including A→B→C.
Producer code support does not approve or publish the required semantic asset,
nor establish an actual installed LC20 execution.

Final consumers use the same service instance's synchronous `assertCurrent` or
`assertExecutionCurrent` after their final await. Copied API JSON is not that
capability. These checks reload current read permission, protected source bytes,
history, policy and expiry without native mutations or store writes. The reader
needs read permission; the original assessment grant and its initiator remain
independently current.

`lifecycle.qualification.action.inspect` takes `{actionRef}` and observes only
that action's original native receipt. It remains available after assessment
expiry or revocation when the observer still has read permission and the original
owner registration is intact. Its `observedStatus` is historical evidence;
`qualification: NOT_ASSESSED` grants no current applicability or permission.
An absent receipt stays UNKNOWN. This read never dispatches or writes.
