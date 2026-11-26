# Runtime v0.10.0 Preview 反馈闭环

[English](../runtime-v010-preview.md) | 简体中文

本指南面向在专用项目准备 0.10.0 Preview 流程的操作人员和项目负责人。[已批准计划（英文）](../runtime-v010-preview-plan.md)与[固定验收清单](../../governance/acceptance-v010.json)规定需要观察的结果。[架构决策（英文）](../architecture/runtime-v010-feedback-loop.md)记录权限与迁移边界。

## 准备环境

使用新建私有根目录和专用项目。对于已发布的 macOS arm64 制品，使用 Node 24.14.0 并执行[下载与身份核验](../../README_CN.md#安装发行包)。由操作人员准备受保护的安装计划，将其绑定到准确的归档、可执行文件、清单、工作区、项目和操作身份。服务已安装、插件已注册和真实 Codex Desktop 会话使用所选 Expert 与 HTTP MCP，是三项独立的观察结果。

选择声明支持反馈项目操作的构建，并在服务中为所选项目登记受保护绑定。项目须有已启用的 Project Lifecycle，并登记反馈接收与回复、审阅通知与操作、Linear 团队、GitHub 仓库、Cursor Agent、已发布 Harness 规则和合并策略的引用。若同一连接具备四项渠道能力，两个渠道引用可指向同一连接。凭据由操作人员保存在受保护的配置中。具体操作见[反馈配置参考（英文）](../../plugins/codex/skills/evopilot-runtime-expert/references/configuration.md#feedback-driven-lifecycle-configuration)。

在 `serve --integrations-ref` 指定的受保护集成配置中，为每个项目登记一项 `feedback-activation-policy` 资源。其定义包含 `ownerId`、`ownerRevision`、由规范绝对路径 `path` 和文件字节的 `sha256:` 摘要 `digest` 组成的 `observations`，以及私有 `decisionDirectory`。操作人员提供与当前工作区及项目绑定的 `runtime-feedback-binding-observations/v1` 记录，每种绑定角色各一项。记录真实负责人的决定时，将原生决定记录和原始来源都放在已登记目录内。启用请求通过带 SHA-256 的本地文件 URI 引用该决定。

先登记策略和观测摘要，再启用 Project Lifecycle。集成配置文件变化后，在审阅反馈启用前重新核验生命周期绑定，并启用当前定义。受信操作人员将指定负责人作出的实际批准及其原始来源直接保存在已登记的决定目录中，文件仅对所有者开放。

真实使用验收通过实际登录的 Codex Desktop 会话完成。在该会话中调用已安装的 Runtime Expert，并连接实际运行的 Runtime HTTP MCP。将登录身份、会话实际使用的模型、制品身份和原始 HTTP 请求回执记录在私有验收证据中。启用检查使用隔离环境中的受保护测试绑定及 Provider 测试数据，由指定项目负责人为准确的启用候选记录实际决定。

Slack Socket Mode 是首个平台适配器。本地自动化测试覆盖 Slack 协议、经过身份验证的回调参考通道和 Provider 接口契约。真实 Slack 验收项 `CHANNEL-REAL` 已延期。本次发布的验收范围不包含真实 Linear、Cursor Cloud 和 GitHub App 操作。

实际执行限时合并时，项目预授权须绑定仓库、分支、低风险路径、指定审阅者、必要证据和有效期。使用已获批的 GitHub 安装，并保留目标分支的保护规则。本地自动化测试使用受控时钟检查合并规则，并验证客户端断开后 Runtime worker 继续运行。

## 保存并启用配置

1. 在 Runtime Expert 中通过 Runtime HTTP MCP 校验反馈配置，确认无效输入会被拒绝。提供一份不超过 16 KiB 的扁平 YAML 1.2 文档，并保存有效草稿。
2. 读回原保存回执、准确的 YAML 源码和草稿版本。重启隔离环境中的 Runtime，从已登录的 Codex Desktop 会话重新连接，再读回同一草稿和回执。若响应丢失，先检查原保存回执，再决定是否重试。
3. 由指定项目负责人审阅准确的启用预览。服务依据当前观测核验七类绑定。预览绑定草稿、已启用生命周期、绑定与策略版本及有效期。通过 Expert 提交负责人为该候选记录的明确批准。输入变化时重新获取预览和决定。启用后读回回执，并确认已启用的配置与审阅过的草稿一致。

草稿校验检查结构，保存操作保留草稿，启用操作应用已审阅的配置。执行与发布分别需要各自的授权。

## 在监控页查看同一个工单

1. 通过已登记的接收路由发送授权反馈。记录原消息、工单与实例标识。信息不足时等待回复，再继续原 Linear 工单和实例。
2. 跟踪 Cursor Cloud 的复现与修复。查看原 Run 与 PR 回执。独立验证绑定准确的 head 和 base。修复改变候选后，应重新验证同一个 PR。
3. 确认审阅通知已送达并检查截止时间。Runtime 使用完整的 60 分钟窗口。有效否决会阻止准确的 head 合并。到期后重新核验候选、当前策略、审阅渠道覆盖情况、验证结果和 GitHub 分支保护。满足条件后发起 rebase 合并，须取得准确的 GitHub 确认，才能关闭工单并报告成功。
4. 在只读 `/monitor` 查看当前节点、已走路径、实际回退边及原因、事件详情和审阅倒计时。倒计时反映已记录的截止时间。断线时从原事件游标恢复，发现缺口时刷新经核验的快照。

Provider 调用结果不确定时，检查留存的意图并与原 Provider 操作对账。保留准确的请求、工单、Run 或 PR 标识。在结果明确前暂停派发。回滚时停止接收和对外派发，保留隔离状态供对账。已有安装升级需要单独的迁移决定和停机备份。

## 查看验收与发布状态

`EXPERT-REAL` 是发布前的真实使用端到端验收。本地自动化用例覆盖完整反馈闭环、独立验证、60 分钟合并规则和恢复。Dashboard 的两项用例通过本地自动化浏览器按已批准的设计参考执行。保留 `/lifecycle` 中流程图位于 YAML 编辑器上方、`/monitor` 中运行视图为只读的截图及对应事件回执。README 图片用于说明外部示例。

准确候选的 GitHub CI 与双语文档核验在发布前完成。发布该制品需要单独批准。发布后，`PUBLIC-READBACK` 核验 GitHub 预发布、标签和匿名下载的文件摘要。`FRESH-REPLAY` 在全新私有根目录中安装准确的下载制品，通过已登录的 Codex Desktop 重做 Expert 与 Runtime HTTP MCP 流程，包括经项目负责人批准的启用。
