# Independent Runtime v0.9 guide

English | [简体中文](zh-CN/runtime-v090.md)

This guide describes Runtime 0.9.0 Preview for local operators and Codex users.
Consult the [versioned Release page](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.9.0)
for publication status and downloads. Verify the selected package manifest, source
revision and acceptance records; documentation and source availability alone do
not establish release or completed acceptance. The [fixed acceptance catalog](acceptance-v090.md)
remains the completion rule.

## Responsibilities and prerequisites

Runtime owns the lifecycle definition, admission checks, durable instances,
requests and receipts. Codex loads Runtime Expert and uses Runtime's HTTP MCP
tools to configure a project and request permitted work. Codex supplies reasoning
and coding. Runtime does not require a model account, LLM Profile or a copy of
Codex login credentials, and does not start an autonomous model loop.

Use Node 24.14.0. The managed local installation uses macOS launchd; this does
not establish Windows or remote-production deployment support. Core source is
strict TypeScript, the UI uses React/TSX, and installed code is compiled
JavaScript with locked runtime dependencies. SeeCode is the pinned graph renderer.

Runtime consumes published Ontology/Harness packages through their public APIs.
The selected compatibility baseline uses their 0.8.3 releases; version equality
between components is unnecessary. Pins include package bytes, contracts and
capabilities. Owner authoring and publication retain their own entries and
authority. L3 content completeness, optional reconstruction, software E2E and
release permission remain separate. This evolution does not regrade real project
assets or require DataRig databases, SSH or Prometheus.

## Install and verify the selected candidate

The operator prepares a protected `runtime-install-plan/v1` with the exact
distribution and Node digests, private installation root, workspace/project,
principal, role, expiry, port, integration reference and selected Codex Host.
The [installer types](../src/installation/installer.ts) define the fields.
Do not reuse an example's paths or credentials as an actual plan.

Choose the role explicitly: `reader` can read, `editor` can also save drafts,
and `activator` can also activate valid definitions. `operator` additionally
permits execution requests and recording exact execution/release decisions.
It does not itself approve a task or release: the service still requires current,
scope-bound authority and original decision evidence before each applicable
operation. The local `auth-init --role operator` entry uses the same permission
set. Installation never upgrades an existing credential or changes an existing
installation plan to this role; existing installations retain their permissions.

```sh
node /absolute/downloads/unpacked/package/dist/installation/installer.js stage --plan-ref /absolute/private/installation-plan.json
node /absolute/downloads/unpacked/package/dist/installation/installer.js install --plan-ref /absolute/private/installation-plan.json
```

Staging prepares the verified package. Installation starts its service and, when
the plan selects Codex, registers one plugin containing both Expert and HTTP MCP
configuration. An `AWAITING_HOST_VERIFICATION` result means Host verification is
still outstanding. Inspect the actual service identity, selected Skill and live
HTTP MCP connection; writing configuration alone is not successful installation.
Keep the original operation journal after interruption and inspect before retry.

The independent service CLI is `evopilot-runtime`. The preserved
`evopilot-next-runtime` CLI is the older embedded/native entry, not a second
independent daemon. For a running installation:

```sh
node /absolute/installation/package/dist/server/cli.js help
node /absolute/installation/package/dist/server/cli.js status --url http://127.0.0.1:PORT \
  --token-ref /absolute/private/principal.json --project example
node /absolute/installation/package/dist/server/cli.js browser-code --connection-ref /absolute/installation/connection.json
```

Replace `PORT`, the project and paths with the selected installation values.
Protected files are owned by the OS user, regular files with mode 0600; state
directories use 0700. Pass credential references, never raw tokens. The browser
command emits a one-use code; enter it on `/lifecycle` or `/monitor`. Do not put
tokens or the code in a URL or project YAML.

The service can run without Codex or model credentials. Without valid published
owner, platform and authority bindings, configuration can be retained as a draft
but cannot become ready for execution. Runtime does not invent missing bindings.

## Configure one project in Codex

Select the Runtime plugin and describe the project, goal, loop and target,
including scope, exclusions and acceptance. Expert reads the current Base and
existing configuration, reuses applicable choices, and asks for unresolved
required settings in stage order:

| Base stage | Configuration to resolve |
|---|---|
| `scope` | Target input, source baseline, requirements mapping and delivery target |
| `plan` | Plan/ADR locations, review, compatibility, recovery and budget |
| `implementation` | GitHub or GitLab repository, branch, CI file, runner, checks, credentials and Agent binding |
| `candidate` | Build workflow, toolchain, version/artifact rules and retention |
| `verification` | Verification environment/workflow, evidence, required checks, failure policy and budget |
| `release-decision` | Decision authority/source, required evidence, checks and documentation |
| `publication` | Selected channel/workflow, credential reference, readback and recovery |
| `closure` | Delivery/smoke check, archive, follow-up, required checks and feedback owners |

The current `lifecycle.base.inspect` field policies are authoritative. All fields
required by the selected provider branch must be resolved. A reference must also
resolve to current scoped evidence; a plausible string is insufficient. Future
test reports are not initialization evidence. Incomplete configuration stays a
draft with a field, rule and remedy.

Expert saves the exact YAML, previews its differences and validates it. With
applicable configuration authority, it enables that exact revision in the same
conversation and reads back the result. Dashboard is not required, and an
existing applicable decision is not requested again. Definition activation
neither creates a business instance nor grants execution or release authority.

## Inherit and extend the publisher Base

A Project Lifecycle is YAML with an exact single `extends` pin and its own
project identity. Users configure schema-open fields and supported extensions.
Only a publisher release changes Base bytes. `latest`, multiple Bases, another
project as a Base, unknown fields and overrides of protected rules are rejected.

The Base exposes four named extension slots and registered actions through
`lifecycle.base.inspect`. A supported extension uses an exact registered action,
project scope and bounded parameters. Slot-local dependencies must be acyclic;
the successor waits for all required branches. Extensions cannot remove Base
stages/checks, turn required checks optional, inject arbitrary shell code,
increase authority/budgets or bypass candidate evidence before verification.
See the [accepted architecture](architecture/runtime-v090-independence.md).

Base changes use an explicit stopped-service upgrade into a new installation.
The `evopilot-runtime-install service-upgrade` operator accepts `inspect
--selection-ref`, `migrate --plan-ref` and `rollback --plan-ref`. Inspection binds
the exact source installation and snapshot; migration requires a fresh backup
directory and exact destination installation plan. A running source, pending
request or unresolved execution blocks migration. It does not start the new
service or register its Codex plugin automatically.

The backup seals the original publisher Base, definitions, instances, receipts,
events and audit. The new service may read these exact historical records; only
its current publisher Base can admit activation, new instances or new execution.
An old YAML file does not gain historical authority merely by being saved. While
the new service runs, it holds the original service's writer lease to prevent
both installations from writing under the same identity.

Validation returns `baseTransition` for a retained old definition. The existing
Dashboard difference preview shows added required fields, removed slots,
tightened constraints, schema changes and original extension IDs. YAML remains
unchanged until the user edits it. Correct the configuration and preview again
before activating; changing the original revision invalidates the old preview.
Rollback first preserves the complete new installation and its evidence, then
verifies the original installation/backup. It never overwrites new evidence with
an old database or makes the older Base selectable in the new service.

## Use the two Dashboard pages

`/lifecycle` shows the SeeCode graph above the YAML editor. Select a node to edit
permitted properties, or edit YAML directly. Preserve comments and source bytes;
unsupported or invalid changes show errors. Save an incomplete draft without
changing the active revision. Preview the exact difference and use **保存并启用**
to validate and activate in this same page. No return to Codex is required.
Concurrent or stale revisions require rereading and a fresh preview.

`/monitor` shows instances, their pinned definition graphs, stage evidence,
blockers, Agent waiting, CI state and connection freshness. It contains no YAML
editor, configuration activation, business execution or release controls.
Editing a definition does not rewrite an in-flight instance. New instances bind
the explicitly selected active revision and separate execution authority.

The Dashboard event stream replays at most the latest 1,000 events **per project**;
this is a count window, not a time limit or audit-retention policy. A new stream
starts at the current project tip and the page independently reads its current
snapshot. A valid older cursor outside the window receives an explicit `reset`
with `gap.code: CURSOR_EXPIRED`, the old position, current watermark and new tip
cursor. The page keeps its last checked state until a same-project snapshot covers
that watermark, then retains a notice identifying the revisions not replayed
individually. Authentication failures are rejected rather than treated as gaps.
Every replay page remains bounded to 50 events and the existing payload limit.
Immutable events, receipts and audit are not deleted. `runtime.events.read`, the
Agent event stream and internal usage recovery retain their complete paginated
history. This Dashboard window does not change MCP transport behavior.

## Execute, observe and recover

Codex requests a governed stage using the exact instance and authority. Runtime
checks prerequisites, current bindings, candidate identity and remaining budget
before any permitted adapter side effect. CI observations and durable receipt
reconciliation can continue while Codex is closed. Work needing Agent reasoning
waits for the Host; closing a chat does not imply completion or cancellation.

Keep original request IDs after a timeout. Read `runtime.receipt.read` and the
original instance/stage request; an unknown result is not permission to dispatch
again. A successful old receipt is historical, not fresh dependency validation.
Follow the [lifecycle API](lifecycle-api.md) for envelopes and readback.

Use the [current service operator](legacy-host.md#control-the-current-installed-service)
after binding or relocation. Preserve the immutable original installation plan.
Backup/restore/relocation must coordinate the current service and owner writers,
verify all protected bytes and keep original evidence. Never copy a live database
or run an older writer against an adopted newer database. The
[compatibility and migration guide](legacy-host.md) covers the original owner
entries, Workspace bootstrap, toolchain preparation and stopped maintenance.

Runtime, Ontology and Harness evolve and release independently. The parent
EvoPilot provides navigation; it receives no new product SemVer from this target.
Source checks, development probes and a running service do not replace all
655 pre-release and nine post-delivery acceptance instances. The approved usage
addendum adds 23 pre-release and one post-delivery case: 688 in total, with 678
before release and 10 after delivery.
