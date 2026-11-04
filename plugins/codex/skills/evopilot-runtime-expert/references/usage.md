# Recorded token usage

Use the connected Runtime HTTP MCP. `runtime_read` with operation
`usage.report.read`, the selected `projectId`, and input
`{"targetVersion":"0.9.0","format":"markdown"}` returns both the native report
and its Markdown. Optional `instanceId`, `stageId`, and `throughTime` narrow it.
Read `usage.sources.list` and `usage.attributions.list` to explain its coverage;
follow `nextAfter` using input `after`. Do not reconstruct totals from conversation
length, source file size, multiple cumulative reports or model guesses.

Say **已记录消耗**. This version reports registered sources only, never a proven
whole-version total. Null counts mean unknown. Input includes cached input;
output includes reasoning output. Never add those subsets again. Stage, node,
task/attempt, Target, instance, model and main/subagent are different views of
one ledger. Do not sum the views. Source/model fields can be unknown.

## Collection and attribution

The native read-only adapter supports explicitly selected owned, uncompressed
Codex rollout JSONL files. It does not silently scan every chat, read credentials,
copy prompts or start another Agent. Unsupported or unavailable Host sources
leave coverage incomplete. Use the installed `evopilot-runtime usage-inspect`
and `usage-grant` local commands documented in `docs/token-usage-v090.md` to
prepare a protected exact grant. HTTP accepts its opaque `sourceId`, not a file
path. Reuse an existing grant and retained cursor when reconnecting.

The authenticated `runtime_write` operation `usage.source.register` has input
`{"sourceId":"selected-source"}`. Bind explicit source event ranges with
`usage.attribution.bind`:

```json
{
  "id": "coding-attempt-one", "sourceId": "selected-source",
  "afterSequence": 0, "throughSequence": null,
  "targetVersion": "0.9.0", "targetRef": "<exact instance targetRef>",
  "instanceId": "<actual instance id>",
  "stageId": "implementation", "baseStage": "implementation",
  "taskId": "coding", "attemptId": "attempt-one", "workType": "coding"
}
```

Resolve these values from the actual instance and task. An open range belongs
to that task until explicitly closed. Before a new task/stage on the same source,
use `usage.attribution.close` with `bindingId` and the `latestSequence` read from the source cursor as
`throughSequence`, then bind the next nonoverlapping range. Never infer parallel
task ownership from time or the currently running stage. A project extension
needs its actual node id and an explicit Base aggregation stage. Supported work
types are `requirements-planning`, `design`, `coding`, `testing`, `review-repair`,
`documentation-release`, and `unclassified`.

Retain retries, failures, repairs and all selected chats; do not reset totals
after a failed attempt. A fork's known cumulative baseline needs its original
evidence. If unavailable, leave baseline metrics null and explain partial history.
Re-registering an existing thread epoch is rejected. A replacement epoch needs
an explicitly revoked predecessor and a native inspected byte boundary; it cannot
reread consumed bytes. A reset or changed source never authorizes blind replay.

## Reports and recovery

`usage.snapshot.create` takes the same query without `format` and retains an
on-demand cutoff. Read historical reports with `usage.snapshots.list` and
`usage.snapshot.read` (`id`, optional `format`). Each actual successful Base
stage completion creates an automatic cumulative snapshot. `publication` captures
the publication-time cutoff; `closure` includes the subsequent closure work.
Late measurements create another revision; old reports remain unchanged.

Use current revision/request IDs for writes and inspect the original receipt
after an uncertain response. `runtime.status.usageWorker` and source health
explain incomplete collection. Statistics errors are recoverable and never
approve, block, fail, retry or reset a lifecycle stage. Do not turn these reports
into Harness quality grades, currency estimates or budget gates.
