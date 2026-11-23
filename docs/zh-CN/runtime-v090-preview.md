# Runtime v0.9.0 限定 Preview

[English](../runtime-v090-preview.md) | 简体中文 · [中文目录](README.md)

使用 Apple 芯片 Mac 和 Node 24.14.0，在全新本地工作区试用 Project Lifecycle YAML 编辑、流程图预览和只读监控。安装器使用绑定到 `127.0.0.1` 的 macOS 用户级 launchd 服务，可独立运行，无需 Codex 或外部服务凭据。[HTTP、MCP 与 CLI 参考](runtime-v090-preview-api.md)

## 校验并解包

将以下六份发行附件下载到私有目录。GitHub 页面另列有两份自动生成的源码归档。[Runtime v0.9.0 GitHub 预发行页](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.9.0)

| 文件 | 用途 |
| --- | --- |
| `evopilot-runtime-0.9.0-darwin-arm64.tar.gz` | 自带运行依赖的独立安装归档 |
| `distribution-manifest.json` | 绑定归档与解包文件的安装清单 |
| `SHA256SUMS` | 其余五份附件的 SHA-256 摘要 |
| `source-revision.txt` | 与发行包绑定的源码提交 |
| `runtime-dependency-lock.json` | 运行依赖清单 |
| `evopilot-next-runtime-0.9.0.tgz` | npm 格式的包产物 |

在私有下载目录中运行下列命令。五份文件的摘要全部通过且源码提交为 `81777f07e856ba5a3615b373de5f6709dc3b3e9b` 后继续。

```sh
shasum -a 256 -c SHA256SUMS
cat source-revision.txt
mkdir -m 700 unpacked
tar -xzf evopilot-runtime-0.9.0-darwin-arm64.tar.gz -C unpacked
chmod 600 distribution-manifest.json evopilot-runtime-0.9.0-darwin-arm64.tar.gz
```

## 启动服务

从已校验的独立归档安装。解析 Node 可执行文件的实际路径，使用 `node --version` 核对版本，并用 `shasum -a 256` 计算该文件摘要。以下命令应使用同一个 Node 可执行文件。

将 JSON 安装计划写入权限为 `0600` 的私有普通文件，使用经过解析的规范绝对路径。已有私有文件须归当前用户所有。如果安装目录不存在，安装器会按 `0700` 创建。

| 字段 | 取值 |
| --- | --- |
| `schema` | `runtime-install-plan/v1` |
| `root` | 与下载目录分开的全新或空白私有安装目录 |
| `distribution` | 将 `packageRoot` 指向解包后的 `unpacked/package`，`manifestRef` 和 `archiveRef` 指向下载文件，`manifestDigest` 和 `archiveDigest` 填入对应的小写 SHA-256 十六进制摘要。 |
| `nodeExecutable`、`nodeSha256` | Node 24.14.0 可执行文件的解析后路径及其小写 SHA-256 十六进制摘要 |
| `workspaceId`、`projectId`、`principalId` | 本地标识，例如 `preview`、`demo` 和 `preview-editor` |
| `role` | `editor` 有 `read` 和 `draft.write` 权限，`reader` 有 `read` 权限。 |
| `credentialExpiresAt`、`port` | 未来 30 天内的 ISO 8601 UTC 时间戳，以及 1024 至 65535 范围内可用的本地端口 |
| `integrationsRef`、`codex` | 均为 `null` |

将以下命令中的示例路径替换为实际计划路径和安装目录。后续管理此安装时继续使用同一份计划。

```sh
node unpacked/package/dist/installation/installer.js stage --plan-ref /absolute/path/install-plan.json
node unpacked/package/dist/installation/installer.js start --plan-ref /absolute/path/install-plan.json
node unpacked/package/dist/installation/installer.js inspect --plan-ref /absolute/path/install-plan.json
node /absolute/install-root/package/dist/server/cli.js browser-code --connection-ref /absolute/install-root/connection.json
```

`stage` 应返回 `STAGED`。运行 `start` 后，用 `inspect` 确认 `service.running: true`、`service.identity.version: "0.9.0"` 和 `service.identity.distributionProfile: "limited-preview"`，同时核对工作区和项目。`start` 回执使用通用安装阶段 `AWAITING_HOST_VERIFICATION`。限定版计划使用 `codex: null`，`inspect` 显示 `hostRegistered: false`。

## 校验并保存草稿

打开 `http://127.0.0.1:<port>/lifecycle`，在页面输入 `browser-code` 打印的一次性代码。代码最长有效五分钟，只能使用一次。勿将其写入 URL 或日志。服务重启或会话到期后，生成新代码重新连接。

使用 `editor` 计划时，将以下内容粘贴到初始为空的 YAML 编辑器，并将 `demo` 替换为安装计划的 `projectId`。

```yaml
# Isolated Preview draft
projectId: demo
```

点击**校验与差异预览**查看缺项。这个示例有意保留缺项，流程图以 Publisher Base 为参考预览草稿。草稿通过结构校验后，流程图会采用编译结果。点击**保存草稿**，重新进入页面，确认 YAML 和注释均已留存。`reader` 可查看已保存草稿，并通过 API 提交校验请求。[Preview API](runtime-v090-preview-api.md)

打开 `/monitor` 查看项目快照和连接状态。初始实例列表为空，限定版不提供创建实例的操作。保存草稿会生成项目事件，监控页可观察到该事件。

## 停止、重启与恢复

```sh
node unpacked/package/dist/installation/installer.js stop --plan-ref /absolute/path/install-plan.json
```

停止服务会保留安装和已保存的草稿。用同一份计划启动服务，核对运行状态，获取新的浏览器代码后即可再次打开草稿。启动中断时，先检查实际状态，并保留 `installation-audit/` 中的记录。草稿保存超时后，应通过 Dashboard 回执查询或 API 查询原请求回执，再提交新的保存请求。发生版本冲突时，先保留本地 YAML、重新读取服务端修订，再合并修改。

此发行配置支持隔离草稿和状态观察。定义激活、实例创建、业务执行、外部服务接入、远端 CI、发布授权和发布、工作区迁移、Codex Desktop 注册均禁用。

## 发行验证

发行提交的源码 CI 中，1,716 项测试全部通过。限定版验收 LP01–LP08 全部通过，其中包括无需 GitHub 凭据下载六份附件、校验摘要，以及用下载归档在全新隔离目录重装并核对实际服务。完整 v0.9 验收和桌面端验证延期。[源码 CI（英文）](https://github.com/yeliang-wang/evopilot-runtime/actions/runs/45109539220) · [限定 Preview 验收规范（英文）](https://github.com/yeliang-wang/evopilot-runtime/blob/v0.9.0/docs/acceptance-v090.md#limited-public-preview-acceptance)
