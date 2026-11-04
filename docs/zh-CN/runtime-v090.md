# 独立 Runtime v0.9 使用指南

[English](../runtime-v090.md) | 简体中文

本指南面向本机运维人员和 Codex 用户，描述已实现的 v0.9 开发目标。
当前分支的包版本已设为 0.9.0，用于候选验证；尚未发布，也不表示完整验收通过。
使用时核对准确制品摘要、源码提交和验收报告；完成标准以[固定验收清单](../acceptance-v090.md)为准。

## 职责与前提

Runtime 管理生命周期定义、准入门禁、持久化实例、请求和回执。Codex 加载 Runtime
Expert，通过 HTTP MCP 配置项目、请求允许的工作，并承担推理和编码。Runtime 不需要
独立模型账号、LLM Profile 或复制 Codex 登录凭据，也不启动自主模型循环。

使用 Node 24.14.0。受管本机安装使用 macOS launchd，不代表支持 Windows 或远程生产部署。
核心源码采用严格 TypeScript，页面使用 React/TSX；安装包运行编译后的 JavaScript 和
锁定的运行时依赖。SeeCode 是固定版本的图形渲染器。

Runtime 通过公开 API 消费 Ontology/Harness 的已发布包；本次选择的兼容基线是两方的
0.8.3 发行版。组件版本无需相同，兼容依据包括制品摘要、契约与能力。两方的资产创作、
发布仍保留各自入口与权限。L3 内容完备、可选重建、软件 E2E 和发布权分别记录。
本轮不自动升级真实项目资产，不要求 DataRig 数据库、SSH 或 Prometheus。

## 安装并核验准确候选

运维人员准备受保护的 `runtime-install-plan/v1`，绑定发行物与 Node 摘要、私有安装位置、
工作区/项目、身份、角色、有效期、端口、集成配置引用和所选 Codex Host。
[安装器类型定义](../../src/installation/installer.ts)列出准确字段。
示例路径和凭据不能直接当作真实安装计划。

角色必须明确选择：`reader` 可读取，`editor` 还可保存草稿，`activator` 还可启用
有效定义。`operator` 另有执行请求和记录执行／发布决定的权限，但角色本身不是任务或
发布批准；服务仍核对准确范围、有效授权和原始决定证据。本地
`auth-init --role operator` 使用同一权限集合。安装器不会把现有凭据静默提升为
此角色，也不会覆盖原安装计划；已有安装的权限保持原样。

```sh
node /absolute/downloads/unpacked/package/dist/installation/installer.js stage --plan-ref /absolute/private/installation-plan.json
node /absolute/downloads/unpacked/package/dist/installation/installer.js install --plan-ref /absolute/private/installation-plan.json
```

准备步骤核对并展开包；安装步骤启动服务，且在计划选择 Codex 时注册一个同时包含
Expert 与 HTTP MCP 配置的插件。返回 `AWAITING_HOST_VERIFICATION` 表示 Host 尚待验收。
必须分别读回实际服务身份、所选 Skill 和实时 HTTP MCP 连接；仅写入配置不能算安装成功。
中断后保留原操作日志，先核对再决定恢复动作。

独立服务 CLI 是 `evopilot-runtime`；保留的 `evopilot-next-runtime` 属于原嵌入式/native
入口，不是第二个独立 daemon。服务运行后可以执行：

```sh
node /absolute/installation/package/dist/server/cli.js help
node /absolute/installation/package/dist/server/cli.js status --url http://127.0.0.1:PORT \
  --token-ref /absolute/private/principal.json --project example
node /absolute/installation/package/dist/server/cli.js browser-code --connection-ref /absolute/installation/connection.json
```

端口、项目和路径必须替换为当前选择。受保护文件归当前 OS 用户所有、权限为 0600，
状态目录为 0700。传递凭据引用，不在命令中传原始 token。浏览器命令返回一次性连接码，
在 `/lifecycle` 或 `/monitor` 输入；token 和连接码不放在 URL 或项目 YAML 中。

没有 Codex 或模型账号，服务仍可运行。缺少有效 owner、平台或授权绑定时，可以保存草稿，
但不能声称已具备执行条件；Runtime 不会虚构配置。

## 在 Codex 内完成项目配置

选择 Runtime 插件，说明项目、goal、loop、target，以及范围、排除项和验收要求。
Expert 读取当前 Base 和已有配置，复用适用选择，按阶段补齐尚未解决的必填项：

| Base 阶段 | 需要确定的配置 |
|---|---|
| `scope` | 目标输入、源码基线、要求映射、交付目标 |
| `plan` | 计划/ADR 位置、审阅、兼容、恢复、预算 |
| `implementation` | GitHub 或 GitLab 仓库、分支、CI 文件、runner、检查项、凭据、Agent 绑定 |
| `candidate` | 构建 workflow、工具链、版本/制品规则、保留期 |
| `verification` | 验收环境与 workflow、证据、必需检查、失败策略、预算 |
| `release-decision` | 决定权限与来源、必需证据、检查项、文档 |
| `publication` | 发布渠道与 workflow、凭据引用、读回、恢复 |
| `closure` | 交付/smoke 检查、归档、后续处理、必需检查、反馈 owner |

准确字段以 `lifecycle.base.inspect` 返回的政策为准。所选平台分支的全部必填项均需补齐；
引用还必须解析为当前范围内的有效证据，填一个看似正确的字符串不够。不能用未来的测试
报告冒充初始化证据。缺项配置只能保存为草稿，并显示字段、规则和修正方法。

Expert 保存准确 YAML、预览差异并校验，在已有适用配置权限内于同一对话启用准确修订并
读回结果，不必打开 Dashboard，也不重复询问仍然适用的决定。定义启用不会自动创建业务
实例，不授予执行权或发布权。

## 继承及扩展发布者 Base

Project Lifecycle 是 YAML，绑定准确的单个 `extends` 和本项目身份。用户可配置 schema
开放字段及支持的扩展。只有发布者发行新版本才能改变 Base 字节。`latest`、多 Base、
继承另一个项目、未知字段和覆盖受保护规则均被拒绝。

`lifecycle.base.inspect` 提供四个命名扩展槽及已注册动作。扩展需绑定准确动作、项目范围
和受限参数；槽内依赖无环，后继等待全部必需分支。不能删除 Base 阶段/检查、把必需项改成
可选、注入任意 shell 代码、扩大权限/预算，或绕过进入验收所需的候选证据。
详见[已接受架构](../architecture/runtime-v090-independence.md)。

## 使用两个 Dashboard 页面

`/lifecycle` 上方显示 SeeCode 图，下方显示 YAML。选择节点修改允许的属性，或直接编辑
源码；保留注释与源码内容，不支持或非法修改显示错误。可以只保存不完整草稿，不改变生效版。
查看准确差异后，在同页点击**保存并启用**，由服务校验并启用，无需返回 Codex。
发生并发冲突或预览过期时，需要重读并重新校验。

`/monitor` 显示实例及其固定修订图、阶段证据、阻塞、Agent 等待、CI 状态和连接新鲜度。
它没有 YAML 编辑器、配置启用、业务执行或发布控件。修改定义不重写在途实例；新实例显式
绑定所选生效修订及独立执行授权。

Dashboard 事件流仅重放**每项目最近 1,000 条事件**；这是按条数计算的窗口，不是时间期限或
审计保留策略。新连接从当前项目末尾游标开始，页面独立读取当前快照。有效旧游标落在窗口
之外时，服务明确发送 `reset`，包含 `gap.code: CURSOR_EXPIRED`、旧位置、当前水位和新游标。
页面保留最后已核对状态，待同项目快照覆盖恢复水位后才确认恢复，并持续说明哪些修订没有
逐条重放。鉴权失败直接拒绝，不能冒充可恢复缺口。每页仍最多 50 条，沿用响应大小限制。
不可变事件、回执和审计不会删除；`runtime.events.read`、Agent 事件流和内部用量恢复仍可
分页读取完整历史。该 Dashboard 窗口不改变 MCP 传输契约。

## 执行、观察与恢复

Codex 使用准确实例和授权请求阶段动作。Runtime 在受管副作用发生前检查前置条件、当前
绑定、候选身份和剩余预算。Codex 关闭后，已有 CI 观察与持久回执核对可以继续；需要推理的
工作等待 Host。关闭聊天不代表完成，也不代表取消已派发任务。

超时后保留原 requestId，读取 `runtime.receipt.read` 和原实例/阶段请求，不把 UNKNOWN
当作重新派发许可。旧成功回执是历史事实，不能替代当前依赖校验。
[生命周期 API](../lifecycle-api.md)说明请求格式与读回流程。

绑定或迁移之后，使用[当前服务运维入口](../legacy-host.md#control-the-current-installed-service)，
保留原安装计划。备份、恢复和迁移需要协调服务及 owner 写入者，核对受保护字节并保留原证据。
不复制运行中的数据库，不让旧写入器打开已升级数据库。
[兼容及迁移指南](../legacy-host.md)覆盖旧 owner 入口、Workspace 初始化、工具链与停机维护。

Runtime、Ontology、Harness 独立演进和发布；父 EvoPilot 仅提供导航，本目标不新增父产品
SemVer。源码检查、开发探测或服务已运行，均不能替代 655 项发布前和 9 项交付后验收。
