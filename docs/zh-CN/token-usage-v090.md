# Runtime v0.9 已记录 Token 消耗

[English](../token-usage-v090.md)

本功能由 Runtime 独立负责：从明确登记的 Codex 来源持续采集计数，保存归属与原始证据摘要，
输出 JSON／Markdown。当前是候选功能，验收以 `governance/token-usage-v090.json` 为准；
本文不代表已发布或已通过全部验收。它不增加 Dashboard、LLM Profile、金额估算、Harness 规则或业务发布门禁。

安装后的 `evopilot-runtime usage-inspect --source /绝对路径/selected-rollout.jsonl`
只检查指定且归当前用户所有的 Codex JSONL 文件，返回实际线程、版本、文件身份和摘要，不返回对话正文。兼容 Codex 生成的 0644 日志，拒绝其他用户可写、符号链接或非当前用户所有的文件；Runtime 授权与账本仍保持私有。
当前适配器支持未压缩 rollout 的 `session_meta`、`turn_context` 和 `event_msg/token_count`；
不自动扫描其他会话，也不把不支持的 Host／压缩记录当成可采集。具体格式、保护要求和完整授权文件字段见
[英文操作参考](../token-usage-v090.md#select-a-source)。

使用原生检查结果准备 mode-0600 的明确来源授权文件，再运行：

```sh
evopilot-runtime usage-grant --state-root /绝对路径/runtime/data \
  --workspace-id selected-workspace --grant-ref /绝对路径/private/grant.json
```

随后通过 HTTP MCP 的 `usage.source.register` 登记其 `sourceId`。
HTTP 不能直接提供任意文件路径；登记和归属需要当前项目的 `draft.write` 权限。
重连继续原来的游标，不重新从零累计。分叉应扣除有证据的继承基线；没有基线时保留未知。
计数重置或文件轮换必须明确连接已撤销的旧来源和新的原始字节边界，不能重读已消耗的字节。

归属沿用项目 → Target 版本 → 真实 Lifecycle 实例 → 节点 → 任务／尝试。
通过 `usage.attribution.bind` 指定源事件序号区间；并行任务的区间不能重叠，不能按时间接近或当前阶段猜测。
同一来源切换任务时，先用 `usage.attribution.close` 关闭原区间，再登记新范围。
已记录事件不能因此移给另一任务。扩展节点保留自己的节点 ID，并明确映射到既有 Base 阶段。
原生准备包的版本必须与归属一致；已有外部 Target 引用使用明确提供的版本绑定。
完整 MCP 参数和 Expert 流程见[统计指引](../../plugins/codex/skills/evopilot-runtime-expert/references/usage.md)。

将 `{"targetVersion":"0.9.0"}` 存为私有查询文件，然后查看报告：

```sh
evopilot-runtime usage-report --connection-ref /绝对路径/connection.json \
  --query-ref /绝对路径/query.json --format markdown
```

`--format json` 使用同一份账本。报告明确标注 **已记录消耗**，不承诺覆盖整个版本的所有会话。
未知值保持 null；未归属记录单独列出。输入包含缓存输入，输出包含推理输出，子项不得再次相加。
阶段、节点、Target、任务／尝试、实例、模型及主／子 Agent 都是同一账本的不同视图，不能跨视图求和。
每个视图最多显示 24 个具名分组，剩余部分明确合并，合计不丢失。来源过多时要求缩小查询，不静默截断。

八个既有 Base 阶段实际完成后，独立观察器生成累计快照；publication 保存发布截点，closure 包含后续收尾工作。
执行中也可随时查询或保存快照。报告固定账本与时间截点，迟到数据形成新修订，旧报告不改写，累计报告之间不相加。
失败、重试和修复的已记录消耗都保留。

计数、归属、游标与报告保存在 Runtime 现有审计账本；来源授权位于同一服务状态目录，随停止后的服务备份保留。
外部会话日志保持只读。恢复后仍须匹配原文件身份与当前权限。
统计错误通过 `runtime.status.usageWorker` 和 `usage.sources.list` 显示，可恢复；它不会修改阶段结果、
阻断业务发布、重置执行预算、触发 CI 重跑或变成 Harness 质量结论。
