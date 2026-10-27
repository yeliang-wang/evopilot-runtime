# EvoPilot Runtime · v0.8.3 Preview

[English](README.md) | 简体中文

Runtime 是 [EvoPilot](https://github.com/yeliang-wang/evopilot/blob/main/README_CN.md) 的持久化执行层，负责项目、目标、经审阅的计划、决定、执行声明、回执与审计。[Ontology](https://github.com/yeliang-wang/evopilot-ontology/blob/main/README_CN.md) 管理语义模型，[Harness](https://github.com/yeliang-wang/evopilot-harness/blob/main/README_CN.md) 管理质量策略与证据评估。

[快速开始](#快速开始) · [服务 API（英文）](docs/service.md) · [CLI（英文）](docs/cli.md) · [中文文档入口](docs/zh-CN/README.md) · [发行版](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.8.3)

## 能力

| 能力 | 行为 |
|---|---|
| 规划 | 有范围的项目、不可变目标、经审阅的修订与精确执行绑定 |
| 资产引用 | 固定 Ontology/Harness 版本与摘要，不隐式选择最新版本 |
| 执行 | 可信解析器准备固定计划，已配置执行器接收一次已提交的执行声明 |
| 恢复 | 使用原请求与保留回执检查、核对不确定结果 |
| 反馈与响应 | 保留已登记证据、经审阅的 runbook 绑定、独立验证与两方处置 |
| 在线发现 | 将可信 Harness 发现读入 `REVIEW_REQUIRED` 修复候选，不派发修复 |
| SDK 与 CLI | 严格 TypeScript 源码、编译后的 ESM 和声明文件，无运行时依赖 |

独立 CLI 不提供解析器、执行器或回执检查器。发现、项目/目标规划和状态检查无需执行 provider；准备与派发 Run 则需要相应可信 provider。安装 Runtime 不会自动配置任意编码或部署能力。

## 快速开始

在 Codex 中使用组合产品，请阅读[总项目安装指南](https://github.com/yeliang-wang/evopilot/blob/main/docs/zh-CN/installation.md)。Runtime 没有独立的 Codex 插件。

### 安装发行包

使用 **Node 24.14.0** 和支持 OS uid 的平台。SQLite 仍属实验性特性。从 [v0.8.3 Preview](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.8.3) 下载全部三个文件：`evopilot-next-runtime-0.8.3.tgz`、`source-revision.txt`、`SHA256SUMS`。在下载目录中先校验、检查，再安装到使用该包的项目：

```sh
shasum -a 256 -c SHA256SUMS
cat source-revision.txt
npm install --ignore-scripts /absolute/downloads/evopilot-next-runtime-0.8.3.tgz
npx --no-install evopilot-next-runtime help
```

发行渠道是 GitHub Releases，不是 npm registry；Runtime 没有 dependency-lock 发行文件。包内包含编译入口、声明、源码与文档，不包含开发脚本和测试。参阅[服务示例（英文）](docs/service.md)和 [CLI 示例（英文）](docs/cli.md)。

### 从源码开发

在使用锁定 TypeScript 5.9.3 工具的源码检出目录中运行：

```sh
npm ci --ignore-scripts
npm run build
npm run check
npm test
node dist/cli.js help
node dist/cli.js version
node dist/cli.js capabilities
```

构建只重新生成 `dist`；检查覆盖类型、公共导出与 vendor 完整性。测试使用隔离工作区。发现命令不创建 Workspace。持久化操作需要明确拥有的规范路径，该路径应在源码/Git 目录之外，且父目录已存在。

## 内容等级与信任边界

当前 `readiness.*` 操作显式指定 `standardVersion: "v2"`。L1 表示领域理解，L2 表示实现规格，L3 表示完整重建规格。Runtime 记录建模用途与 `ASSET_CONTENT_ONLY` 完成状态，Harness 负责内容评定。参阅 [v2 API（英文）](docs/readiness-v2.md)。

L3 不要求实际重建软件。`assetAssessment` 与 `reconstructionVerification` 独立记录，`L3 / NOT_REQUESTED` 是有效结果。它不证明生成软件功能等价、源码相同、生产就绪或获得发布授权。历史 usability v1 记录保留原有含义。

Runtime 信任非恶意的单一 OS uid 和注入的适配器，不隔离同一 uid 下的恶意代码。不确定结果必须保留精确回执。元数据不证明 provider 已配置或验收已通过。Preview 不代表 GA。组合产品的响应采集器支持在隔离复制目录中执行固定 Node 工作；该配置不覆盖 Java/Maven、远程执行或生产修复。

## 文档与贡献

- [中文文档入口](docs/zh-CN/README.md)、[规划（英文）](docs/planning-api.md)、[可读 API（英文）](docs/readable-api.md)、[决定证据（英文）](docs/native-decisions.md)。
- [已登记反馈（英文）](docs/feedback.md)、[在线修复候选（英文）](docs/online-repair.md)、[经审阅的响应（英文）](docs/response.md)。
- [变更记录（英文）](CHANGELOG.md)、[Roadmap（英文）](docs/roadmap.md)、[贡献指南（英文）](CONTRIBUTING.md)、[双语维护规则](docs/zh-CN/documentation-languages.md)。
- [安全政策（英文）](SECURITY.md)、[Apache-2.0 许可证（英文）](LICENSE)、[归属声明（英文）](NOTICE)、[来源记录（英文）](provenance/)。

文档导航参考了 [OpenHands（英文）](https://github.com/OpenHands/OpenHands)，正文独立编写，不表示存在关联关系。

这些源码文档包含 v0.8.3 发布后的文档改进。既有 tag 归档保留原始文档，后续发行包将包含更新后的页面。
