# Recovery and maintenance

Inspect the selected service identity and project before acting. If the service
or owner is unavailable, preserve the original request and explain which
dependency is waiting. Do not start a second store, replace published assets,
switch credentials silently or copy a live database to make the view look ready.

For an uncertain tool response, use `runtime.receipt.read` with the original
request ID, then inspect its exact instance/stage. Missing response is not failed
execution. Resume only the original permitted action; do not change request ID,
expected revision, deadline, instance ID or budget to force another attempt.
Known terminal failure remains in history. A newly authorized attempt must be
distinct and stay within the configured limits.

Host offline/`WAITING_AGENT`, CI pending/running, native validation pending,
unknown external outcome and failed checks are different states. Runtime's
observation worker may retain actual provider progress, but cannot start a new
goal or wake Codex. Reconnect and use the retained handoff/claim; preserve any
unknown resource usage and the actual Host permission outcome.

Definition edits produce new immutable revisions. Existing instances retain
their original Base, definition, requirements, source and candidate pins. Read
current reference validity before new effects; a historical PASS does not
certify changed assets, credentials, review policy or environment.

Use Runtime's supported installer/maintenance entry for its own service and one
Expert+HTTP plugin. A written config, plugin cache entry or background PID is not
connection acceptance: verify service identity, actual Skill version and real
HTTP MCP calls after a Host refresh. Routine maintenance authorization does not
grant business execution or software release authority.

Before real upgrade/cutover, require the applicable stopped-state backup,
isolated migration and rollback evidence. Preserve user data, credentials, all
failed/unknown receipts and evidence produced after the backup. Never point an
old binary at an incompatible newer store. Stop only the owned verified service;
uninstalling a client does not authorize deleting project data or other plugins.

The stdio bridge forwards supported calls to the same HTTP service and holds no
execution state. It does not substitute for actual HTTP plugin qualification.
Published 0.8.3 Ontology/Harness workflows remain their own entries; unsupported
legacy Runtime calls need an explicit migration mapping, not an invented
translation or a second background Runtime writer.

For a verified adopted store, `runtime.legacy.read` and `runtime.legacy.write`
take `{family, envelope:{operation, scope, input}}`; write identity fields remain
on the outer transport envelope. Use the **original family** revision and request
ID, never `runtime.status.revision`. Look up an uncertain legacy result through
that family's original receipt/Run/attempt operation. `runtime.receipt.read`
contains the new service's transport admission audit, not the old business
receipt; admission alone proves no domain operation succeeded.

The optional stdio bridge exposes the supported `evopilot_v01_request`/`native`
and session aliases only when the same service has a verified legacy binding.
Activation does not start a daemon. The legacy CLI can use `--connection-ref`
instead of direct workspace flags; it never falls back to local writing after a
connection failure. Inspect the returned migration mapping and original error
code. Missing provider bindings remain blocking; do not invent replacement
executors or translate legacy asset verification into lifecycle stage completion.

Do not leave the old combined daemon running against an adopted Runtime store:
its startup also opens Runtime, even for owner requests. Confirm the independent
owner entry transition and exact supported-tool mapping before real cutover.
