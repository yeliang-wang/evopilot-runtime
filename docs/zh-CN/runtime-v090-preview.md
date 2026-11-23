# Runtime v0.9.0 限定 Preview

使用 Apple 芯片 Mac 和 Node 24.14.0，在全新本地工作区试用 Project Lifecycle YAML 编辑、流程图预览和只读监控。运行服务无需连接 Codex 或外部服务。

## 校验并解包

从 [Runtime v0.9.0 GitHub 预发行页](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.9.0) 下载全部六份附件，在私有下载目录中运行以下命令。

```sh
shasum -a 256 -c SHA256SUMS
cat source-revision.txt
mkdir -m 700 unpacked
tar -xzf evopilot-runtime-0.9.0-darwin-arm64.tar.gz -C unpacked
chmod 600 distribution-manifest.json evopilot-runtime-0.9.0-darwin-arm64.tar.gz
```

全部摘要应校验通过。发行提交为 `81777f07e856ba5a3615b373de5f6709dc3b3e9b`。独立归档包含运行依赖。

## 启动服务

将 JSON 安装计划写入权限为 `0600` 的私有文件，并使用无符号链接的规范绝对路径。

| 字段 | 取值 |
| --- | --- |
| `schema` | `runtime-install-plan/v1` |
| `root` | 新建或空的私有安装目录 |
| `distribution` | 将 `packageRoot` 指向解包后的 `unpacked/package`，`manifestRef` 和 `archiveRef` 指向下载文件，`manifestDigest` 和 `archiveDigest` 填入相应文件的 SHA-256 十六进制摘要。 |
| `nodeExecutable`、`nodeSha256` | Node 24.14.0 的解析后路径及其 SHA-256 十六进制摘要 |
| `workspaceId`、`projectId`、`principalId` | 本地标识，例如 `preview`、`demo` 和 `preview-editor` |
| `role` | 使用 `editor` 保存草稿，或用 `reader` 只读访问 |
| `credentialExpiresAt`、`port` | 尚未到期的 ISO 8601 UTC 时间戳，以及 1024 至 65535 范围内可用的本地端口 |
| `integrationsRef`、`codex` | 均为 `null` |

将以下命令中的示例路径替换为实际计划路径和安装目录。

```sh
node unpacked/package/dist/installation/installer.js stage --plan-ref /absolute/path/install-plan.json
node unpacked/package/dist/installation/installer.js start --plan-ref /absolute/path/install-plan.json
node unpacked/package/dist/installation/installer.js inspect --plan-ref /absolute/path/install-plan.json
node /absolute/install-root/package/dist/server/cli.js browser-code --connection-ref /absolute/install-root/connection.json
```

使用 `inspect` 确认 `0.9.0` 服务正在运行，且发行配置为 `limited-preview`。在 `http://127.0.0.1:<port>/lifecycle` 输入一次性代码，校验 YAML 并查看流程图。使用 `editor` 可保存并重新打开草稿。`/monitor` 提供只读状态，初次安装的实例列表为空。

使用 `node unpacked/package/dist/installation/installer.js stop --plan-ref /absolute/path/install-plan.json` 停止服务，保留本地安装和状态。此发行配置禁用激活、业务执行、外部服务接入、远端 CI、迁移和 Codex Desktop 注册。[验收规范](https://github.com/yeliang-wang/evopilot-runtime/blob/v0.9.0/docs/acceptance-v090.md#limited-public-preview-acceptance)
