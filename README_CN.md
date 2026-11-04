# EvoPilot Runtime · v0.9.0 Preview

[English](README.md) | 简体中文

**开发状态：** 包版本 0.9.0 已用于候选验证，完整验收与发布尚未完成。[计划中的 Release 地址](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.9.0)不代表当前已有可下载发行包。

Runtime 是独立生命周期服务，负责项目定义、目标、Target、实例、执行门禁、回执与审计。Codex 通过一个 Runtime Expert/HTTP MCP 插件承担推理与编码。Runtime 不需要 LLM Profile，也不运行自主模型循环。

[使用指南](docs/zh-CN/runtime-v090.md) · [生命周期 API（英文）](docs/lifecycle-api.md) · [中文文档](docs/zh-CN/README.md) · [固定验收](docs/acceptance-v090.md)

## 能力

| 能力 | 行为 |
|---|---|
| Base 与项目生命周期 | 发布者维护不可变 Base；八阶段强制配置；YAML 与受限扩展 |
| 统一服务 | HTTP API、Streamable HTTP MCP 和 CLI 使用相同的服务端权限与状态 |
| 两个 Dashboard 页面 | 生命周期图形/YAML 编辑与同页启用；独立的只读实例监控 |
| Agent 与 CI | Codex 执行已授权工作；核验 GitHub Actions/GitLab CI 身份、制品和回执 |
| 组件交互 | 消费已发布 Ontology/Harness API、固定资产与评定，保留反馈与恢复 |
| 发行 | 严格 TypeScript 核心；编译 JavaScript、声明、静态页面、锁定生产依赖与一个插件 |

[Ontology](https://github.com/yeliang-wang/evopilot-ontology/blob/main/README_CN.md) 管理语义资产；[Harness](https://github.com/yeliang-wang/evopilot-harness/blob/main/README_CN.md) 管理验证资产与证据评定；[EvoPilot](https://github.com/yeliang-wang/evopilot/blob/main/README_CN.md) 提供导航。它们无需与 Runtime 使用相同版本。定义启用不批准 Target、不执行 Run，也不授权发布。

## 快速开始

### 安装发行包

发布后，使用 **macOS arm64 和 Node 24.14.0**，从本组件 Release 获取全部六份制品：`evopilot-runtime-0.9.0-darwin-arm64.tar.gz`、`evopilot-next-runtime-0.9.0.tgz`、`distribution-manifest.json`、`runtime-dependency-lock.json`、`source-revision.txt` 和 `SHA256SUMS`。在新的私有下载目录执行：

```sh
shasum -a 256 -c SHA256SUMS
cat source-revision.txt
mkdir unpacked
tar -xzf evopilot-runtime-0.9.0-darwin-arm64.tar.gz -C unpacked
chmod 600 distribution-manifest.json
node unpacked/package/dist/server/cli.js help
```

独立归档包含运行依赖，无需父项目源码、开发编译器或联网安装依赖。npm tarball 是编译后的 SDK 包，附带准确依赖锁。发行渠道为 GitHub Releases，不向 npm registry 发布。

按照[使用指南](docs/zh-CN/runtime-v090.md)准备受保护的精确安装计划。安装器在准备包或启动服务前核验归档、完整文件清单、可执行文件身份及选定范围。一次安装同时注册 Runtime Skill 与 HTTP MCP 连接；仍需当前 Host 实际回读，写入配置不等于部署完成。迁移前保留已核验的停止状态备份；结果不明时先检查原回执。

### 从源码开发

使用锁定的 TypeScript 5.9.3 工具链：

```sh
npm ci --ignore-scripts
npm run build
npm run check
npm test
node dist/server/cli.js help
```

源码测试属于隔离技术证据，不能替代固定验收、真实 Host 流程、发布及安装验证。候选制品准备只使用已提交且无修改的源码。

## 内容等级与信任

保留的 `readiness.*` API 使用 `standardVersion: "v2"`：L1 为领域理解，L2 为实现规格，L3 为重建规格内容完备。`assetAssessment` 和 `reconstructionVerification` 独立，`L3 / NOT_REQUESTED` 有效，不证明生成软件功能等价，也不授予发布权限。参阅 [v2 API（英文）](docs/readiness-v2.md)。

秘密保存在受保护引用中，不进入 YAML 或普通日志。服务管理的操作校验范围、权限和精确证据；Runtime 不控制用户在纳管路径之外执行的无关操作。本机信任边界假定 OS 用户非恶意。Preview 不代表 GA 或生产部署支持。历史记录和 [v0.8.3 文档](https://github.com/yeliang-wang/evopilot-runtime/blob/v0.8.3/README_CN.md)保持原义。

## 文档与贡献

- [中文文档入口](docs/zh-CN/README.md)、[CLI（英文）](docs/cli.md)、[规划（英文）](docs/planning-api.md)和[可读 API（英文）](docs/readable-api.md)。
- [兼容与迁移（英文）](docs/legacy-host.md)、[反馈（英文）](docs/feedback.md)和[经审阅响应（英文）](docs/response.md)。
- [更新记录](CHANGELOG.md)、[Roadmap](docs/roadmap.md)、[贡献指南](CONTRIBUTING.md)和[双语维护](docs/zh-CN/documentation-languages.md)。
- [安全](SECURITY.md)、[Apache-2.0 许可证](LICENSE)、[声明](NOTICE)和[来源](provenance/)。
