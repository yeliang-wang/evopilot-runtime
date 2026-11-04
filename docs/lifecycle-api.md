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
| `lifecycle.instance.inspect` | `instanceId` | Pinned instance and current project revision |
| `lifecycle.stage.admission` | `instanceId`, `stageId` | `execution.request`, also `release.request` for publication; reads current admission without dispatch |

The authoritative definitions are in [definition service](../src/lifecycle/service.ts)
and [HTTP dispatcher](../src/server/http.ts). Stage requests, observations,
preparation, Agent claims and retained authority use their separately validated
operation families. The installed [Expert execution guide](../plugins/codex/skills/evopilot-runtime-expert/references/execution.md)
documents that governed workflow. A configuration-only client cannot obtain
execution or decision authority by selecting a write tool.

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
