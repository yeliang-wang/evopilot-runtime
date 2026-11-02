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
