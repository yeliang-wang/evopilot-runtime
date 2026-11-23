# Runtime v0.9.0 limited Preview API

English | [简体中文](zh-CN/runtime-v090-preview-api.md) · [Documentation index](README.md)

This reference applies to the installed `limited-preview` package. Use the [installation and Dashboard guide](runtime-v090-preview.md) to start a local service.

## Local HTTP and CLI

Use the `http://127.0.0.1:<port>` origin and authenticate with `Authorization: Bearer <token>`. The installer writes the scoped credential to `<root>/client.json` and the connection descriptor to `<root>/connection.json`. Keep both files private. Pass credential file references to the CLI and keep bearer tokens out of URLs and YAML.

| Method and path | Purpose |
| --- | --- |
| `GET /api/v1/status?projectId=demo` | Read the service identity, profile, advertised operations and current project revision |
| `POST /api/v1/request` | Send an operation envelope with `Content-Type: application/json` |
| `GET /api/v1/events?projectId=demo` | Read authenticated project events using Server-Sent Events. To resume, pass the returned `cursor` as a query parameter. |
| `POST /mcp` | Call the same request dispatcher through stateless Streamable HTTP MCP |

The installed CLI accepts the following arguments. Replace `PORT`, the project and paths with the actual installation values.

```sh
node /absolute/install-root/package/dist/server/cli.js status --url http://127.0.0.1:PORT --token-ref /absolute/install-root/client.json --project demo
node /absolute/install-root/package/dist/server/cli.js request --url http://127.0.0.1:PORT --token-ref /absolute/install-root/client.json --project demo --request-ref /absolute/path/request.json
```

Save the following read envelope as a private regular file with mode `0600`, using your installation's `projectId`.

```json
{"operation":"lifecycle.definition.inspect","projectId":"demo","input":{}}
```

For a save, use the revision returned by the last inspection and choose a unique request ID for that edit. The example assumes a new project at revision zero.

```json
{"operation":"lifecycle.draft.save","projectId":"demo","input":{"yaml":"projectId: demo\n"},"requestId":"save-draft-1","expectedRevision":0}
```

HTTP responses carry a service correlation `requestId` plus `result` or `error`. A successful save's outer `result` is a receipt that contains the caller's request ID, committed revision, and a nested result with `status: "DRAFT"` and the saved `revisionId`. Read access is restricted to the credential's current project scope. The `editor` role adds `draft.write`. A stale revision returns `REVISION_CONFLICT`, so reread the latest revision before reconciling. If the response is lost, use `runtime.receipt.read` with the original caller request ID and identity. The CLI reports `REQUEST_OUTCOME_UNKNOWN` on uncertain request transport and performs no automatic retry.

## Supported operations

| Operation | `input` | Result |
| --- | --- | --- |
| `runtime.status` | `{}` | Running service identity and current project revision |
| `runtime.projects.list` | Optional `cursor` and `limit` | Projects in the current credential scope. The default page size is 50 and the maximum is 100. |
| `runtime.events.read` | Optional `cursor` | Bounded project event page |
| `runtime.receipt.read` | `requestId` | Original receipt for the same principal and project |
| `lifecycle.base.inspect` | `{}` | Publisher Base pin, fields, stages, slots and actions |
| `lifecycle.definition.inspect` | `{}` | Current project revision and draft and active pointers. A fresh installation has neither pointer. |
| `lifecycle.definition.read` | `revisionId` | Exact revision summary and compilation |
| `lifecycle.definition.source.read` | `revisionId`, optional byte `offset` | Base64 source page of up to 32 KiB with `nextOffset` |
| `lifecycle.definition.validate` | `yaml` | Compilation, graph when available, and validation issues |
| `lifecycle.draft.save` | `yaml` | Draft receipt. Requires `editor`, `requestId` and `expectedRevision`. |

Revision IDs use `sha256:<64 lowercase hex digits>`. The request body and the YAML each have a 256 KiB limit. JSON framing counts toward the body limit. YAML supports protected reference syntax and rejects inline secrets. A draft can retain incomplete configuration and its diagnostics. Structural validation and external binding readiness are reported independently.

## MCP and Dashboard connections

MCP advertises `runtime_read` and `runtime_write`, whose arguments use the read and write envelopes above. The only write operation is `lifecycle.draft.save`. Supported protocol versions are `2025-06-18` and `2025-11-25`. Include `Accept: application/json, text/event-stream` on POST requests. Initialize with an authenticated POST, then send the negotiated version as `MCP-Protocol-Version` on subsequent POSTs. MCP returns JSON. The event endpoints use a separate SSE connection. Unsupported lifecycle operations submitted to the dispatcher are rejected with `LIMITED_PREVIEW` (HTTP 403, or a tool error through MCP).

The Dashboard uses the one-time code from `browser-code` to establish a same-origin, project-scoped session. Browser changes require the session's CSRF proof. `GET /api/v1/dashboard/monitor` returns a read-only snapshot. `GET /api/v1/dashboard/events` streams projected events with sequence, revision, type and timestamp. The browser stream starts at the project tip and the page fetches its snapshot independently. It replays up to the latest 1,000 project events. An older cursor outside that window receives a `reset` with `CURSOR_EXPIRED`. The monitor refreshes its snapshot to cover the reported watermark. The Dashboard replay cap applies to the browser stream. Authenticated project history remains paginated through `runtime.events.read`.
