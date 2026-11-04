# Runtime v0.9 acceptance collectors / 验收入口

The fixed catalog contains 64 requirement groups, 22 scenarios and 664 instances
(655 before release, 9 after delivery). Development regressions are separate.
The E03 collector, `tests/acceptance/v090/e03.test.mjs`, executes the 332
required-field HTTP instances and 48 fixed HTTP/MCP/CLI stage-entry instances
against an explicitly selected installed package
and an existing activated isolated project. It checks field/rule/remedy errors,
retained drafts, the original active revision and historical source bytes.
It never inserts state directly or supplies a synthetic binding provider. MCP
cases use actual initialization and tool calls; CLI cases execute the installed
CLI with protected credential/envelope references. Each case independently reads
back the service state and confirms only draft/blocked-activation events occurred.

Other E03 journeys and entry cases remain required. Selecting one without its
implementation fails; it is not skipped or represented by a field test. A
bounded subset report retains the complete 448-instance E03 denominator and
lists every unexecuted ID. Complete product qualification still requires all
other scenarios, exact source CI, actual Codex/browser/platform journeys,
publication and current-host delivery evidence.

Set `EVOPILOT_V090_ACCEPTANCE_SELECTION` to a protected JSON file containing
`schema: runtime-v090-acceptance-selection/v1`, `installedRoot`,
`expectedManifestDigest`, `connectionRef`, `workspaceId`, `projectId`, `runId`,
`outputRoot`, and `qualification: DEVELOPMENT | FINAL_CANDIDATE`.
An optional nonempty `caseIds` array explicitly selects a development subcampaign;
omit it for the complete scenario. The output root must be new. The installed
manifest and all package bytes are verified before and after execution. Final
candidate mode requires version `0.9.0`; this alone does not establish release
eligibility or replace E20 source/evidence qualification.

```sh
EVOPILOT_V090_ACCEPTANCE_SELECTION=/absolute/private/selection.json \
  node --test tests/acceptance/v090/e03.test.mjs
```

Retain the selection, raw requests/responses, per-case assertions and report.
Authorization headers and token values are not recorded. A transport failure
after a mutation preserves the original request and stops further writes;
inspect its actual receipt before another action. No collector starts a service,
changes current Codex configuration, dispatches CI, or authorizes publication.

`tests/acceptance/v090/e09.test.mjs` collects all six fixed E09 protocol instances.
It sends independent wire requests for both `2025-06-18` and `2025-11-25`, and
uses the locked official SDK against the selected installed HTTP service. Raw
traffic is retained without authentication values. The collector checks
initialization, discovery, scoped calls, invalid metadata/input, JSON responses,
late cancellation and the declared absence of MCP SSE/session IDs. MCP transport
is separate from Runtime's lifecycle event stream. The normative references are
the [June transport specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
and [November transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
Protocol checks never register an execution provider or perform business writes.
They do not replace E10's actual Codex/Expert journey or E20's complete coverage
qualification. CV07 in E09 requires every fixed E09 instance in the same campaign.

固定验收分母为 664，开发回归与正式验收分别记账。E03 对真实安装包执行 332 个
字段缺项／非法值检查，以及 HTTP、MCP、CLI 三个入口的 48 个阶段配置检查，
要求已有通过服务正常启用的隔离项目作为基线；
检查准确字段与规则、草稿保留、原生效版本及历史源码不变，不直接写库或伪造依赖就绪。

其余 E03 场景、Expert／Dashboard 等入口仍必须实现。未实现用例会失败；选择部分用例
只生成明确的部分报告，保留完整分母及未执行 ID。开发版本不能声明最终候选验收通过。
结果不替代完整源代码 CI、真实 Host／浏览器／平台流程、发行及当前 Codex 安装终验。

E09 对两个已声明协议版本执行独立 HTTP 交互，并使用锁定的官方 SDK 连接同一安装包。
六个固定实例包括发现、初始化、工具读取、错误拒绝与无副作用检查；每次交互保留
脱敏原始记录。这里没有真实模型调用，不能当作 E10 的 Codex 对话验收。
