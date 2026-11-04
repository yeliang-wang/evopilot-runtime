# Recorded token consumption in Runtime v0.9

[简体中文](zh-CN/token-usage-v090.md)

This candidate feature belongs to Runtime. It continuously reads explicitly
registered Codex usage, retains provenance and attribution, and provides JSON
and Markdown reports. Its acceptance is tracked separately in
`governance/token-usage-v090.json`; this document is not a release claim.
It adds no Dashboard page, LLM profile, cost estimate, Harness rule or lifecycle
gate. Parent, Ontology and Harness implementations remain unchanged.

## Select a source

Run the installed CLI with a specific owned Codex rollout JSONL file:

```sh
evopilot-runtime usage-inspect --source /absolute/selected-rollout.jsonl
```

Codex-created 0644 input files are supported; other-user writable files, symlinks and non-owned files are rejected. Runtime grants and stored data remain private. This reads only that file and returns its thread, original metadata digest,
device/inode, observed Codex version and provider. It does not register it or
return prompts. The current adapter accepts uncompressed Codex rollout JSONL
with `session_meta`, optional `turn_context`, and `event_msg/token_count` records.
Unknown metrics stay null. It does not claim to support every Host build,
compressed archive, remote chat or other Agent. A changed format is reported as
incomplete, not guessed. Official [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server)
also describes `thread/tokenUsage/updated`; its actual cumulative/last counters
are an independent reference for installed Host acceptance, not a second ledger
to add to rollout counters.

Create a mode-0600 grant JSON file outside the repository. Use the identity from
the command above and the exact current principal revision:

```json
{
  "schema": "runtime-codex-usage-grant/v1",
  "id": "selected-source", "workspaceId": "selected-workspace",
  "projectId": "selected-project", "principalId": "selected-principal",
  "principalRevision": 1,
  "path": "/absolute/selected-rollout.jsonl",
  "identity": {
    "dev": 0, "ino": 0, "metadataDigest": "<native inspected digest>",
    "threadId": "<native thread id>", "codexVersion": "<observed version>",
    "provider": null
  },
  "epoch": "initial", "agentRole": "main", "parentThreadId": null,
  "baseline": {
    "input": null, "output": null, "total": null,
    "cachedInput": null, "cacheWriteInput": null, "reasoningOutput": null
  },
  "baselineEvidence": null, "expiresAt": "<selected expiry>"
}
```

The values above are placeholders, not a runnable grant. Use `main`, `subagent`
or `unknown` for agent role; a subagent requires its parent thread. A known
baseline needs the original evidence reference. Do not substitute zero for
unavailable inherited history. With unknown baseline, the first observed
`last_token_usage` can contribute only that recorded increment, with partial
history explicitly reported.

```sh
evopilot-runtime usage-grant --state-root /absolute/runtime/data \
  --workspace-id selected-workspace --grant-ref /absolute/private/grant.json
```

This local operator command fixes a read-only grant under the selected Runtime
state. It does not execute models or broaden credentials. The HTTP operation
`usage.source.register` accepts only its opaque `sourceId`. It requires current
project `draft.write` permission and the exact granted principal revision.
Existing thread epochs and grant ids cannot be silently reset or overwritten.
Reconnection continues the retained cursor. On source rotation/reset, revoke
the predecessor and explicitly select a new epoch with `predecessorId` and an
`initialCursor` returned by `usage-inspect --after-offset <complete byte offset>`.
On the same file, the boundary cannot precede the old consumed offset.

## Attribute and report

The [Runtime Expert usage guide](../plugins/codex/skills/evopilot-runtime-expert/references/usage.md)
gives exact HTTP MCP inputs for registration, explicit event-range attribution,
range closure and snapshots. The generic installed `request` command uses the
same authenticated service; no CLI path bypasses project scope or current roles.

Attribution pins project → Target version → actual lifecycle instance → node →
task/attempt. The retained Target version is checked when the instance uses a
native preparation reference. Other supported external Target references keep
the explicitly provided version binding. The native source sequence is the original record byte position plus one; the Host ordinal is retained in the event id. `usage.sources.list` exposes the latest collected sequence and offset for exact handoff. Parallel ranges cannot overlap.
Extensions retain their own node and an explicit Base reporting stage. Closing
an open range retains its original binding and cannot move already recorded
events to another task. Future-version work requires a distinct actual instance.

Save a mode-0600 report query such as `{"targetVersion":"0.9.0"}`. Optional
`instanceId`, `stageId` and `throughTime` narrow the selected view:

```sh
evopilot-runtime usage-report --connection-ref /absolute/connection.json \
  --query-ref /absolute/query.json --format markdown
```

`--format json` returns the same ledger projection. Reports say **已记录消耗**
(recorded consumption), retain null unknowns, expose unclassified records and
declare registered-source coverage. They never assert a complete version total.
`input + output = total`; cached input and reasoning output are inclusive
subsets, not additional tokens. Every breakdown is a view of this one ledger.
Each view shows up to 24 named groups plus an explicit remaining-group aggregate;
the counts still reconcile. More than 100 contributing source epochs requires
a narrower query instead of silently dropping sources.

## Lifecycle snapshots and durability

A separate bounded observer follows committed completion events from the eight
existing Base stages. It retains stage snapshots, a publication-time cumulative
report and a closure report including post-publication work. Every snapshot pins
the source-ledger revision and optional event-time cutoff. Late-arriving source
data creates another immutable snapshot, never rewrites the old report and never
sums cumulative snapshots. On-demand reports work during execution.

Counters, explicit bindings, cursor anchors and report history live in Runtime's
existing audited SQLite object/receipt ledger. Protected local grants live under
the same service state tree. Stopped-service backups preserve these bytes; source
logs remain external read-only inputs. Collection resumes only when the same
granted source and current principal still match. Errors are reported through
`runtime.status.usageWorker` and `usage.sources.list`. A statistics error does not
change stage outcomes, authorize a release, reset an execution budget or
redispatch CI. No source path is accepted through HTTP and no model credentials
are read by this adapter.
