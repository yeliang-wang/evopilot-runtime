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

Real owner/platform authority adapters and external stage dispatch remain M3
work. Unconfigured adapters fail closed; synthetic regression adapters are test
fixtures only and cannot certify real asset usability or final E2E. The two
Dashboard pages, independent installed Expert/plugin, migration and complete
candidate acceptance remain unfinished. These development features do not claim
that the frozen 664 acceptance instances have passed.
