# Runtime v0.9.0 限定 Preview API

[English](../runtime-v090-preview-api.md) | 简体中文 · [中文目录](README.md)

本参考适用于已安装的 `limited-preview` 包。启动本地服务的步骤见[安装和 Dashboard 指南](runtime-v090-preview.md)。

## 本地 HTTP 与 CLI

使用 `http://127.0.0.1:<port>` 作为源地址，通过 `Authorization: Bearer <token>` 认证。安装器将限定范围的凭据写入 `<root>/client.json`，并将连接描述写入 `<root>/connection.json`。请保护这两个文件。向 CLI 传入凭据文件引用，勿将令牌写入 URL 或 YAML。

| 方法和路径 | 用途 |
| --- | --- |
| `GET /api/v1/status?projectId=demo` | 读取服务身份、发行配置、声明的操作和项目当前修订 |
| `POST /api/v1/request` | 提交操作请求，使用 `Content-Type: application/json` |
| `GET /api/v1/events?projectId=demo` | 认证后通过 Server-Sent Events 读取项目事件。恢复事件流时，将返回的 `cursor` 作为查询参数。 |
| `POST /mcp` | 通过无状态 Streamable HTTP MCP 调用同一个请求分发器 |

已安装的 CLI 接收以下参数。将 `PORT`、项目及路径替换为实际安装值。

```sh
node /absolute/install-root/package/dist/server/cli.js status --url http://127.0.0.1:PORT --token-ref /absolute/install-root/client.json --project demo
node /absolute/install-root/package/dist/server/cli.js request --url http://127.0.0.1:PORT --token-ref /absolute/install-root/client.json --project demo --request-ref /absolute/path/request.json
```

将以下读请求写入权限为 `0600` 的私有普通文件，并使用安装计划中的 `projectId`。

```json
{"operation":"lifecycle.definition.inspect","projectId":"demo","input":{}}
```

保存草稿时，使用上次查询返回的修订号，并为本次编辑选择唯一的请求 ID。示例使用新项目的初始修订号零。

```json
{"operation":"lifecycle.draft.save","projectId":"demo","input":{"yaml":"projectId: demo\n"},"requestId":"save-draft-1","expectedRevision":0}
```

HTTP 响应包含服务侧用于关联的 `requestId`，以及 `result` 或 `error`。保存成功时，外层 `result` 是回执，其中包含调用方的请求 ID、提交后的修订号，以及带有 `status: "DRAFT"` 和已保存 `revisionId` 的内层结果。读取受当前凭据的项目范围限制。`editor` 还具有 `draft.write` 权限。使用过期修订号会收到 `REVISION_CONFLICT`，应重新读取当前修订后再合并修改。如果响应丢失，用原身份和原调用方请求 ID 执行 `runtime.receipt.read`。CLI 遇到传输结果不确定时会报告 `REQUEST_OUTCOME_UNKNOWN`，且不会自动重试。

## 支持的操作

| 操作 | `input` | 结果 |
| --- | --- | --- |
| `runtime.status` | `{}` | 运行中的服务身份和项目当前修订 |
| `runtime.projects.list` | 可选 `cursor` 和 `limit` | 当前凭据范围内的项目。每页默认 50 条，最多 100 条。 |
| `runtime.events.read` | 可选 `cursor` | 有大小上限的项目事件分页 |
| `runtime.receipt.read` | `requestId` | 同一身份及项目的原请求回执 |
| `lifecycle.base.inspect` | `{}` | Publisher Base 的精确绑定、字段、阶段、槽位和动作 |
| `lifecycle.definition.inspect` | `{}` | 项目当前修订、草稿与生效版本指针。全新安装中两者都为空。 |
| `lifecycle.definition.read` | `revisionId` | 指定修订的摘要和编译结果 |
| `lifecycle.definition.source.read` | `revisionId`、可选字节偏移 `offset` | 每页最多 32 KiB 的 Base64 源码，包含 `nextOffset` |
| `lifecycle.definition.validate` | `yaml` | 编译结果、可用的流程图和校验问题 |
| `lifecycle.draft.save` | `yaml` | 草稿回执。需要 `editor`、`requestId` 和 `expectedRevision`。 |

修订 ID 使用 `sha256:<64 lowercase hex digits>` 格式。请求体和 YAML 的大小上限均为 256 KiB，JSON 封装计入请求体大小。YAML 接受受保护的引用语法并拒绝内联密钥。草稿可保留不完整配置及其诊断，结构校验与外部绑定就绪状态分别报告。

## MCP 与 Dashboard 连接

MCP 声明 `runtime_read` 和 `runtime_write`，工具参数使用上面的读写请求结构。唯一写操作是 `lifecycle.draft.save`。支持的协议版本为 `2025-06-18` 和 `2025-11-25`。POST 请求须声明 `Accept: application/json, text/event-stream`。先用认证 POST 初始化，再在后续 POST 的 `MCP-Protocol-Version` 请求头中传入协商版本。MCP 返回 JSON，事件端点使用独立的 SSE 连接。提交到分发器的越界生命周期操作会收到 `LIMITED_PREVIEW`，HTTP 状态为 403，MCP 返回工具错误。

Dashboard 使用 `browser-code` 生成的一次性代码建立限定项目和同源的会话。浏览器写入须提供当前会话的 CSRF 校验值。`GET /api/v1/dashboard/monitor` 返回只读快照。`GET /api/v1/dashboard/events` 输出包含序号、修订、类型和时间的事件流。浏览器事件流从项目当前最新位置开始，页面另行读取快照。浏览器事件流最多回放项目最近的 1,000 个事件。超出窗口的旧游标会收到带 `CURSOR_EXPIRED` 的 `reset`，监控页会刷新快照以覆盖报告的水位。该回放上限适用于 Dashboard 浏览器事件流。认证后仍可通过 `runtime.events.read` 分页读取项目事件历史。
