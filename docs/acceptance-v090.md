# Runtime v0.9 acceptance collectors / 验收入口

The fixed catalog contains 64 requirement groups, 22 scenarios and 664 instances
(655 before release, 9 after delivery). Development regressions are separate.
The E03 collector, `tests/acceptance/v090/e03.test.mjs`, executes the 332
required-field HTTP instances, 48 fixed HTTP/MCP/CLI stage-entry instances and
32 actual browser graph/YAML stage-entry instances and 16 actual Codex Expert
stage-entry instances
against an explicitly selected installed package
and an existing activated isolated project. It checks field/rule/remedy errors,
retained drafts, the original active revision and historical source bytes.
It never inserts state directly or supplies a synthetic binding provider. MCP
cases use actual initialization and tool calls; CLI cases execute the installed
CLI with protected credential/envelope references. Each case independently reads
back the service state and confirms only draft/blocked-activation events occurred.

The browser cases open the installed lifecycle page in the locked Playwright
Chromium, authenticate using an installed-CLI one-use code and edit the actual
SeeCode property form or YAML editor. They retain incomplete drafts, inspect
field-specific errors and verify that activation stays disabled and the existing
active revision is unchanged. Graph fields use their declared reference type's
empty/invalid string representations; YAML cases remove a key or submit null.
The report distinguishes these representations. Structural control setup is an
explicit API draft save; it is not counted as a UI action or dependency readiness.
Each case retains a screenshot and actual browser action/network transcript,
without authentication headers, cookies, session values or the one-use code.

Expert cases use an ephemeral instance of the selected actual Codex executable,
the installed plugin's own marketplace identity and its Host-reported qualified
skill name. A real model turn saves and validates each supplied configuration
through HTTP MCP; independent service reads verify the original request, exact
draft, validation issue and unchanged active/history. The fenced input declares
its single final LF; saved bytes are compared exactly without normalization.
Host-built-in read-only resource discovery is retained separately and never
counted as a Runtime call; discovery of an unrelated named server is rejected.
The installed configuration
reference is supplied through App Server application context. The driver records
the real model/provider, tool results, token usage and bounded dialogue transcript;
scripted tool calls alone cannot satisfy these cases. Other MCP/app capabilities
are disabled only for that test process. A precise synthetic draft permission
response reuses existing test authority; it never supplies a domain/release
decision or changes daily Codex configuration. Unexpected shell use or an
uncertain write fails the case and retains the original request for inspection.

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

Selecting Expert instances also requires `codexHost` with the canonical
`executable`, its `executableSha256`, and `timeoutSeconds` (60–600). The actual
Host version must match the frozen environment. This is the test watchdog, not
a change to any Runtime execution budget. Each turn's final status and original
service receipt are checked; timeout or a Host interruption is not a pass.

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
字段缺项／非法值检查，以及 HTTP、MCP、CLI 三个入口的 48 个阶段配置检查和
图形／YAML 两个实际浏览器入口的 32 个阶段配置检查，以及真实 Codex Expert 的
16 个阶段配置检查，
要求已有通过服务正常启用的隔离项目作为基线；
检查准确字段与规则、草稿保留、原生效版本及历史源码不变，不直接写库或伪造依赖就绪。

浏览器用例在真实安装页面操作 SeeCode 属性表单或 YAML 编辑器，保留草稿并确认
启用按钮不可用、原生效版本不变。图形入口测试空引用／非法引用字符串，YAML 入口
测试缺失键／null，分别记录，不能把 HTTP 注入冒充图形操作。每项保留实际截图和
动作／网络记录，连接码和认证材料不写入记录。

Expert 用例加载安装包实际插件标识和 Host 返回的完整技能名，由真实模型调用
HTTP MCP 保存／校验，再独立读回原请求和草稿。输入明确保留末尾一个换行，按原始字节
核对；Host 内置只读发现调用另行保留，不能当作 Runtime 调用或访问无关服务。
记录实际模型、提供方、token 用量及
对话／工具回执。临时测试进程关闭其他 MCP／应用，只复用本次准确合成草稿的已有
测试权限，不修改日常 Codex 配置、不生成领域或发布批准。固定 Host 版本和可执行文件
摘要必须匹配；异常、超时及未知写入均不能算通过。

其余 E03 完整流程仍必须实现。未实现用例会失败；选择部分用例
只生成明确的部分报告，保留完整分母及未执行 ID。开发版本不能声明最终候选验收通过。
结果不替代完整源代码 CI、真实 Host／浏览器／平台流程、发行及当前 Codex 安装终验。

E09 对两个已声明协议版本执行独立 HTTP 交互，并使用锁定的官方 SDK 连接同一安装包。
六个固定实例包括发现、初始化、工具读取、错误拒绝与无副作用检查；每次交互保留
脱敏原始记录。这里没有真实模型调用，不能当作 E10 的 Codex 对话验收。

## Pre-release record integrity

`src/release/evidence.ts` audits a protected `runtime-release-evidence-input/v1`
against clean committed source. The input pins the original archive, distribution
manifest, source revision and exactly twenty E01–E20 reports. Every one of the
655 pre-release case IDs must have a final-candidate PASS, nonempty assertions,
its original case file and original evidence. Partial campaigns, development
reports, skipped/foreign cases, changed collectors, changed candidate bytes and
missing records fail this audit. The remaining nine post-release instances stay
outstanding.

Collectors now bind the selection file and both original request and response
files by SHA256; artifacts and screenshots retain their own hashes. Existing
reports are preserved rather than edited to add missing evidence. An older
unbound request record cannot qualify a new final-candidate campaign.

This audit returns record integrity, **not product acceptance or publication
authority**. Independent source-CI/original-artifact verification, the precise
actual release decision and public delivery/current-Host checks are separate
remaining obligations. Synthetic tests of this auditor never count as actual
product journeys.

发布前记录核验固定要求 E01–E20 的全部 655 项，逐项绑定候选、收集器、选择文件、
原用例结果及请求／响应／附件原始摘要。开发子集、遗漏、跳过、错误候选或修改后的
原始记录不能通过。旧报告保留原样，不补写缺失证据；后置 9 项仍待实际交付完成。
核验记录完整性不等于产品验收、源码 CI 或真实发布决定，更不能用合成守卫测试
替代真实软件流程。
