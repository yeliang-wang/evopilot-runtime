# Runtime v0.9 acceptance collectors / 验收入口

The current fixed acceptance denominator is **709 instances: 698 before release
and 11 after delivery**. HO01–HO03 are three separate handoff obligations.
Development regressions and a callable collector do not count as completed
acceptance. The original catalog contains 64 requirement groups, 22 scenarios and
664 instances (655 PRE, 9 POST). UT01–UT24 add 23 PRE and one POST; LC01–LC21
add 20 PRE and one POST. Neither addendum replaces an original scenario. The
678 PRE / 10 POST usage subtotal is not the final release denominator.
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

E03.EX01 requires an exact protected `principals.beta` connection for a different
project and principal on the same installed service. Both principals need current
`read`, `draft.write` and `definition.activate` permissions. Each project must
already have a usable active definition and an actually admitted, unstarted
instance. The collector does not create those prerequisites. Through the public
HTTP API it activates independent legal configurations, rejects foreign-project
writes and invalid Base inheritance, and repairs the invalid drafts. It checks
publisher Base bytes, original instances and authority, retained revisions and
the other project's state throughout. It does not dispatch lifecycle stages.
Selection checks and source tests are not evidence that EX01 has passed on an
installed service.

E03.EX02 requires `fieldClassification: {github: {yamlRef, yamlSha256},
gitlab: {yamlRef, yamlSha256}}` in its protected selection. Both files must be
distinct, canonical, private, owner-held regular files, nonempty and at most
256 KiB, with exact SHA-256 pins. This selection is rejected for other scenarios
or when EX02 is not selected. Each YAML must target the same selected project and
current Base, contain its provider's required fields and omit the other provider's
fields. The installed HTTP API, HTTP MCP and CLI must all return current, valid
binding readiness before any negative control is credited. The collector checks
unknown fields, duplicate keys, locked values, conditional required fields and
constrained/additive values; invalid activation retains the draft and leaves the
original active revision, history and publisher Base unchanged. Revalidation of
the exact legal input uses the same entry. The original input pins are checked
again at completion. Structural templates and local compiler tests cannot supply
positive provider or owner readiness. This case validates configuration; it does
not dispatch CI or activate a replacement lifecycle. Its implementation is not
evidence that the installed-service case has passed.

Other E03 journeys and entry cases remain required. Selecting one without its
implementation fails; it is not skipped or represented by a field test. A
bounded subset report retains the complete 448-instance E03 denominator and
lists every unexecuted ID. Complete product qualification still requires all
other scenarios, exact source CI, actual Codex/browser/platform journeys,
publication and current-host delivery evidence.

E14's five fixed cases use separate new installation roots and protected exact
plans with a non-null, version-pinned Codex selection. They exercise native plugin
registration, real App Server discovery and HTTP reads, service/plugin failure
recovery, occupied-port and duplicate-writer rejection, and native uninstall with
retained data, credentials and audit. Read-only discovery waits for the original
asynchronous Host startup; it does not reinstall or dispatch a tool to create
readiness. These cases have no model turn and do not satisfy Expert dialogue
obligations. `maintenance.casePlans` binds each selected case's plan reference,
SHA256 and isolated Codex home; the campaign root must not already exist.

E11's primary journey uses two real ephemeral Codex conversations with separate
project credentials against the same installed service. Its protected
`multiClient` fixture pins both generated plugin materials, exact Host executable
and a synthetic PENDING instance. Each conversation edits its own draft and
retains native cross-project refusals; closing one client must preserve the
service and the other client's access. A fresh conversation reads the server's
current state. Existing Host login is used without copying credentials or
changing global settings. The isolated Host process registers the existing
installed Skill directory through its process-local discovery API and verifies
the exact enabled Skill path before a model turn; plugin metadata alone is
insufficient. This fixture dispatches no CI and cannot satisfy the
separate CV05 requirement for an already dispatched task across exit/reentry.

E13's protected
`interruptionFixture` selects original native instances and records; it cannot
supply stage outcomes or Host reports. The two interruption cases require actual
native scope and plan completion and distinct PENDING implementation stages.
They disconnect before the complete request body or after response headers,
recover the original receipt, reject conflicting/duplicate requests, restart the
owned installed service and check the original Agent handoff and prerequisite
evidence. They do not start a model turn or submit a Host report. The
unsupported-limit case verifies schema refusal without a new budget engine.
The two concurrency branches each execute new actual browser sessions: a stale
revision is refused, editing invalidates an earlier preview, and a committed
activation response is deliberately lost. Both clients must read the same
recovered active definition. Exact request replay, changed-content refusal,
one activation event, unchanged historical sources and unchanged instances are
verified independently. No result from another scenario is reused as a pass.
Variant 05 needs original real Host availability evidence correlated with the exact
report, task and Target version; an authenticated report containing null alone
does not establish unavailability. An actual unsupported or unavailable source
can qualify once evidenced; a manufactured collection failure is not required.
Both the collector and its `execution.mjs` helper are pinned and rechecked; none
of these branches substitutes for the complete interruption journey or two-client
acceptance.

The E13 primary journey selects a fresh case on one original implementation
request. It combines both request-channel interruptions, an owned observing Host
that exits, a second owned coding Host with exact claim/edit/validation/report
phases, and the first derived GitHub CI dispatch whose response is lost. The
same native request and provider run must survive Host exit, event-stream
cancellation and exhausted attempt, concurrency, loop and time budgets. After
the deadline, only observation of that original execution is permitted. Separate
passing variant reports cannot be stitched into this journey.

The source-review decision belongs to an independent reviewer and must bind the
actual submitted report. A protected reviewer connection reads that principal's
original receipt; the coding connection cannot read or create it. The collector
uses no Runtime LLM profile, grants no broad command permissions, and must stop
its own Host processes on failure. Exact installed Host/protocol identity,
reviewed fixture bindings, existing authority and the original budget remain
actual-execution prerequisites. Generated protocol definitions and local guards
prove implementation properties, not a real Host or CI journey.

E18's provider journeys also require original credential-loss observations from
real CI. The `forkCredential` selector binds the original fork and upstream
`stageRequestId`, `runId` and `jobId`, plus one dedicated `credentialName`.
Both repositories must have an authenticated fork relationship, the same source
commit and exact workflow bytes, and distinct native requests. The committed
probe records only whether that credential is available: upstream PRESENT with
exit 0, fork ABSENT with exit 78. Original job outcomes, the fixed probe source,
stdout/stderr and downloaded artifact bytes must agree. A generic API 403, an
invented variable name or a caller-supplied absence flag is insufficient.
The dedicated GitHub workflow must not inherit top-level `env` or `defaults`;
the GitLab source must not use unverified `include` merging. Checking only the
literal job body would allow inherited configuration to alter the probe before
it measures the credential.

This collector reads existing provider/job/artifact records; it neither starts
those pipelines nor reads secret values or variable-management APIs. The
observation proves availability in the two actual executions, not an unread
provider configuration flag. Missing producer workflows, original runs or
artifacts remain NOT_READY. Those prerequisites cannot be replaced by local
probe unit tests, and CV03 budget coverage does not satisfy this obligation.
For GitLab, an advertised artifact expiry is not proof of deletion: retained
artifacts still require an actual bounded download and stable original metadata.

E15 binds a separate installed migrated workspace and explicit synthetic assets
from the published Ontology/Harness 0.8.3 packages. Its actual Codex plugin exposes
one HTTP service and its stdio compatibility route. The collector verifies the
same project, one new synthetic goal, original receipt and exact replay through
both entries. Each owner performs one new native validation with original receipt
readback; the published owners commit a RUNNING claim and completion separately,
so the exact revision increment is two. Readback and replay must not advance it
again. Harness readiness reads the original Ontology projection and Runtime
intent. This is technical validation of isolated assets, not semantic approval,
business execution, asset publication or actual Expert dialogue.

E16's scope-mismatch branch requires both existing synthetic owner bindings to
validate through the installed service before testing refusals. It checks private
project, visibility and adapter-owner mismatches plus cross-project reads and
writes. Blocked activation retains an invalid draft as the product specifies;
the collector then saves a separate repaired draft and revalidates it. The
original active definition, immutable source records and every existing PENDING
instance must remain unchanged. Expired instance grants are historical evidence
only and are never used for admission. This branch does not satisfy the other
six E16 cases, owner feedback recovery, business acceptance or an L3 assessment.

The private EX10 predecessor can be built with
`node scripts/package-base-qualification.mjs /absolute/private/new-output` from
clean committed source. Its fixed profile produces version `0.9.0-ex10-a`, marks
it as qualification-only, and records every source transformation. It is not a
historical public Release. It is compiled before packaging; neither the final
Base nor installed package bytes are patched. Its purpose is the real A-to-B
upgrade, difference/denial/correction and rollback journey. Source regressions,
synthetic UI presentation and this package's construction do not themselves
satisfy E05.EX10 or E17.EX10; those collectors still need the exact installed
candidate, native migration and original browser/recovery evidence.

The installed EX10 collectors select one independent `serviceUpgrade` campaign
per scenario. Protected references pin both installation plans, the original and
corrected YAML, and the predecessor qualification record. An explicit synthetic
operator creates an active definition and a PENDING instance through native
APIs; no lifecycle stage runs. The collector stops A, migrates with B's installer,
checks all four incompatibility classes in the actual browser, explicitly fixes
and activates the new definition, and rolls back after preserving B's new
evidence. Original pins, receipts, source bytes and extensions must remain intact.
E17's historical-format migration and all-entry coverage are separate cases;
passing EX10 does not close them. Use the standalone archive's exact bytes and
file modes for the installer bootstrap, rather than an unverified packing tree.

E17.journey and E17.CV01 select a private, SHA-256-pinned
`initializationMigration: {ref, sha256}` fixture. CV01 covers all six actual
configuration producers: HTTP API, HTTP MCP, CLI, Expert, Dashboard YAML and
Dashboard graph properties. Each uses a separately prepared exact authority
reference and creates its own unstarted instance; the collector does not invent
decisions or dispatch business stages.

The historical-format journey binds the fixed official v0.8.3 archive, a canonical
isolated legacy copy and original public readbacks containing literal PENDING,
NOT_RUN and retained pins. It also binds owner/decision files, the exact new
installation plan, original backup and complete current preservation backup.
Its explicit `allowServiceControl: true` permits the isolated installer to start
for adoption and then stop before managed inspection and rollback. Merely staging
files does not perform adoption. Unknown stop results retain the original state
and fail without retry. The public rollback restores exact old database bytes,
retains new receipts separately and keeps additive evidence; whole-workspace
snapshot equality is not claimed. These inputs and source guards do not establish
that the actual installed E17 journey has passed.

E01.variant.04 and E02.variant.03 use a separate singleton
`stageAdmission: {ref, sha256}` fixture and a preprovisioned `principals.monitor`
with only `read` permission on the same project and service. The eight positive
stage requests must come from an exact current-source/candidate original journey,
with native, Host and provider facts independently read back. The collector then
issues 24 fresh invalid-input, insufficient-permission and missing-prerequisite
requests. It verifies unchanged native events/attempts and provider run/job
inventories. It neither creates decisions nor substitutes an old PASS label for
current proof; the separate CV03 resource-boundary matrix remains required.

E19 uses a separate synthetic project with 51 or more native-authorized PENDING
instances, an empty-project reader and a dedicated initially valid reader whose
access is removed by the isolated test operator. Its collector writes 1,000
distinct revisions and 10,000 original events through serial native API calls;
bounded batches retain every original request and response without direct
database seeding. Twenty samples each measure first-summary and event-to-page
latency, retaining the fixed p95 limits of 2 and 5 seconds, the 15-second
disconnect indication and 50-item/256-KiB page limits. Synthetic inventory and
controlled UI faults are labeled; missing fixtures, unknown writes and failed
thresholds cannot qualify the scenario.

EX10 每个场景使用独立的新目录和精确安装计划，通过原生 API 建立合成 PENDING
实例，再执行迁移、实际页面校验／修正及回退。它不执行业务阶段，也不能代替 E17
的其他固定用例。E19 的库存、授权实例与权限变化同样限定在独立合成项目中；
采样保留原始请求、响应与浏览器观测，不能以直接写库、模拟响应或放宽阈值算通过。

Set `EVOPILOT_V090_ACCEPTANCE_SELECTION` to a protected JSON file containing
`schema: runtime-v090-acceptance-selection/v1`, `installedRoot`,
`expectedManifestDigest`, `connectionRef`, `workspaceId`, `projectId`, `runId`,
`outputRoot`, and `qualification: DEVELOPMENT | FINAL_CANDIDATE`.
An optional nonempty `caseIds` array explicitly selects a development subcampaign;
omit it for the complete scenario. The output root must be new. The installed
manifest and all package bytes are verified before and after execution. Final
candidate mode requires version `0.9.0`; this alone does not establish release
eligibility or replace E20 source/evidence qualification.

E20 requires a clean exact source commit, authenticated readback of its successful
GitHub CI and original six artifact files, complete E01–E19 results and the 23
pre-release usage cases. The fixed prerequisite audit covers 652 original cases;
the three E20 cases then verify qualification, extension-entry evidence and
denominator rejection guards. The full release preflight still requires all 655
original pre-release cases and cannot accept the 652-case prerequisite audit.
Concrete documentation locations are bound to original behavior evidence.
Missing actual campaigns, CI or extension observations remain failures; source
regressions and file hashes alone do not prove authentic execution or authorize
publication. Select the protected fixture through `releaseQualification`.

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
inspect its actual receipt before another action. Configuration/protocol
collectors do not start services, dispatch CI or authorize publication. E02's
explicit isolated lifecycle selection separately permits its test-only execution
chain and service restart; no collector changes daily Codex configuration or
authorizes an EvoPilot product release.

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

原 E01–E20 验收目录为 664 项；与 UT、LC 增补合并后的固定分母为 709 项，
开发回归与正式验收分别记账。E03 对真实安装包执行 332 个
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

E02 starts from a fresh installed service with an explicitly selected `operator`
role, real published owner packages, synthetic isolated assets and a real GitLab
test repository. It obtains configuration through the actual installed Expert,
then waits for the current external Codex to claim and complete the retained
coding handoff. The collector must not manufacture an Agent result. Exact
source/MR, CI, candidate, native owner validation, test-only release/download,
owner feedback and restarted archive are read from their original services.
Both browser pages and the monitor trace bind the same service and instance.
Decision fixtures are expressly synthetic and cannot approve business assets or
an EvoPilot product release. A preparation selection may choose `E02.journey`;
all other fixed variants remain unexecuted until separately implemented. An
unknown mutation stops this attempt without redispatch or changing its budget.

E02 使用全新隔离安装、明确的 `operator` 角色、已发布 owner 包和真实 GitLab 测试项目。
真实 Expert 完成配置；编码结果必须由实际外部 Codex 的原 handoff 返回，不能由驱动器
伪造。源码／MR、CI、候选、双方验证、测试发布／下载、反馈与归档均保留原回执。
两页浏览器与监控 trace 绑定同一实例。测试决定明确标为合成证据，不批准业务资产或
产品发布。仅选择主路径时，其余固定变体仍未执行；未知写入不自动重发或重置预算。

The E10 collector uses the actual installed Expert in an ephemeral Codex Host:
one dialogue asks for the eight stages' required inputs, the next supplies a
protected exact synthetic configuration, and only its single matching activation
request can receive the test's scoped tool permission. Runtime still performs
live validation and activation. CLI and browser read back the same definition;
a new Host connection must read current server state without another write.
The `E10.variant.01` and `E10.MC01` aliases bind that original dialogue's case and
transcript hashes. They are not additional independent runs. CV05's active-CI,
changed-scope/permission and authority-reuse requirements remain separate and
cannot pass merely because a configuration-only Host reconnects. Preparatory
selections must leave CV05 explicitly unexecuted until that collector exists.

E08 separately collects installed package behavior and static prerequisites.
Its protected `packageCompatibility` selection binds a published-owner synthetic
fixture, the exact distribution source revision and a read-only parent navigation
checkout. The main journey uses a standalone service without Codex or integrations,
the compiled CLI/HTTP API and shipped pages; missing lifecycle configuration must
remain blocked. Source compilation/classification and navigation checks are
explicitly static evidence. Compatibility uses the installed Runtime's real
published-owner adapters and immutable asset readback. A changed version label in
an isolated owner-package copy must fail before import; original packages remain
unchanged. Synthetic assets/decisions and pure package inspection are never
reported as domain approval, new native-validation receipts or Host conversations.
Actual conversational journeys have their separate frozen scenarios.

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

`src/release/source-ci.ts` checks original source-CI records separately: repository,
commit, workflow, job attempt, frozen runner, successful required steps, nonempty
test counts with no failures/skips, the job's exact upload ID/digest, downloaded
ZIP bytes and all six distribution assets. Its manifest/archive must match the
selected installed candidate. This pure record verifier does not authenticate
arbitrary local JSON: the caller must retain authenticated provider reads. Its
result does not authorize publication, and it is not a replacement for E01–E20.

原 E01–E20 发布前记录核验要求全部 655 项，逐项绑定候选、收集器、选择文件、
原用例结果及请求／响应／附件原始摘要。开发子集、遗漏、跳过、错误候选或修改后的
原始记录不能通过。旧报告保留原样，不补写缺失证据；原目录的后置 9 项仍须实际
交付验证。合并 UT、LC 后，最终门禁要求全部 698 项发布前和 11 项发布后验收。
核验记录完整性不等于产品验收、源码 CI 或真实发布决定，更不能用合成守卫测试
替代真实软件流程。

## Additive usage collection

`tests/acceptance/v090/usage.test.mjs` uses the selected installed package's
helpers, CLI and authenticated HTTP service. It never writes Runtime's database
directly. Set `EVOPILOT_V090_USAGE_SELECTION` to a private
`runtime-v090-usage-selection/v1` JSON object with `installedRoot`,
`expectedManifestDigest`, `sourceRevision: {ref, sha256}`, `connectionRef`,
`workspaceId`, `projectId`, `runId`, `outputRoot`, `qualification`, explicit
`caseIds`, an existing `instanceId`, its `targetVersion`, and the current
`principalRevision`. The source revision file and output root must be protected;
the output root must not already exist. `FINAL_CANDIDATE` also requires the exact
clean source commit. Installed-source inspection and local grant creation apply
only to controlled files created in this isolated campaign.

The implemented branches are UT01, UT02, UT04–UT06, UT09–UT12, UT17, UT18,
UT20 and UT21. They retain controlled Codex-format counter events, native grant
and HTTP receipts, exact assertions and immutable snapshot readbacks. These
fixtures are expressly synthetic, not actual model work. UT10 requires an actual
project extension in the selected instance; UT12 requires an actually running
implementation stage. Cases needing complete lifecycle transitions, actual Host
usage/Expert dialogue, multi-instance recovery or current-host delivery remain
independently required. Selecting a branch without its live driver fails;
partial reports list every unexecuted pre-release UT ID and cannot qualify.

```sh
EVOPILOT_V090_USAGE_SELECTION=/absolute/private/usage-selection.json \
  node --test tests/acceptance/v090/usage.test.mjs
```

`src/release/usage-evidence.ts` separately inspects all 23 pre-release UT records
against the exact source, collector, addendum and candidate. It rejects missing,
partial, repeated, mismatched or changed records and preserves the original 664
obligations plus UT24. Byte integrity cannot authenticate execution or turn a
synthetic Host fixture into a real Host observation. The result remains
`productAcceptance: NOT_EVALUATED`, `releaseAuthorized: false`; final review must
inspect the actual execution provenance and independent original acceptance.

新增统计验收固定为 UT01–UT24，与原 664 项分别记账，原目录加用量为 688 项。统计采集器通过
精确安装包的 CLI／HTTP 运行，不直接写库。受控计数输入明确标为合成格式样本，不能
冒充真实 Codex 用量；真实 Host、八阶段完成、恢复及当前安装仍需要各自执行证据。
选择部分用例只产生部分报告。记录摘要一致仅证明字节完整，不能授予产品验收或发布权限。

## Base constraints, revision isolation and browser editing

E04 collects installed Base/extension constraints through API, CLI, MCP and the
actual graph/YAML pages. Positive extension activation requires a current,
registered configuration, supplied to E03 and E04 as optional protected
`extensionConfiguration: {yamlRef, yamlSha256}` or already present in the active
definition. Compiler-only structural controls are labeled as such; unresolved
synthetic references never establish a usable extension. Actual parallel joins,
frozen execution budgets and owner outcomes keep their separate fixed variants.

E04 registers its implemented case callbacks before reading the installation or
starting a browser. Selecting a missing callback fails with
`COLLECTOR_MAPPING_INCOMPLETE` at that preflight; it does not run a placeholder
and does not skip the requirement. The retained callable report covers the full
fixed E04 catalog even when a subset is selected. All 15 E04 callbacks are
implemented; this proves callable coverage only, not environment readiness or
acceptance.

E04.EX11 and E05.EX11 require a protected `extensionExecution` fixture with an
exact entry for the selected case (`casePlans["E04.EX11"]` or
`casePlans["E05.EX11"]`) before installation or browser access. Their shared
execution helper retains the same complete native-owner obligations. The
`baseline` and `extended` YAML pins must differ only by the appended Harness
extension. `ownerConnection` pins the actual published owner connection, while
`passed` and `failed` each bind an original instance, Target and definition
revision that actually executed that same extended definition. The collector
checks the original native reports against the declared criteria and variants;
an unrelated failure cannot stand in for the added requirement. `stageId` and
`successorId` identify the exact frozen dependency.

The case then appends and activates the extension through the browser, rejects
`latest` and forged PASS inputs through real service requests, removes the check
from the draft, and verifies that the original failed Target still cannot enter
its dependent stage. It preserves the failed request and owner assets. Preparing
these fixtures or passing source regressions does not establish that the installed
case has passed; each final-candidate case must collect its own actual evidence.
An EX11-only E05 run does not require the unrelated `revisionEvolution` fixture;
a live case-campaign coordinator still validates each child's exact EX11 fixture.

The paired E03.EX12 and E04.EX12 cases use the same exact legal YAML and a single
extension-scope change as the illegal input. E03 exercises HTTP, MCP, CLI and a
real Expert conversation; E04 exercises the installed graph property editor and
YAML editor. Each entry retains its actual validation response and source digest.
Browser validation must fall within the recorded edit action and carry its exact
request identity; a later unrelated validation cannot establish that edit's
result. These cases save isolated drafts but do not activate a definition or
dispatch execution. E20 independently checks all six original entries and their
matching inputs; implementing the collectors alone does not pass these cases.

E05 accepts `revisionEvolution: {instanceId, allowSyntheticDecisions: true}` only
for its isolated test campaign. It reads an actual unfinished instance and
preserves its original pins while changing the definition. Explicitly labeled
fixture decisions create new PENDING instances through the native authority API;
they do not execute stages or approve business assets/releases. Reading an old
non-RC candidate is development evidence until its original execution is bound
to the same qualified candidate. Base upgrades, changed candidate revalidation
and REUSE/DELIVER remain independently required.

E06 opens the installed SeeCode graph/YAML editor and separate read-only monitor.
The browser helper records actual actions, sanitized request/response bodies and
screenshots. Graph/keyboard changes, raw YAML/comment preservation, same-page
activation, stale-client rejection and a response lost after an actual commit
are exercised at their real UI entry. The response-loss probe inspects the
original request rather than submitting another activation. Restart cases require
`browserConfiguration: {allowServiceRestart: true}` on the selected isolated
installation and use its native current-selection service-control API. They do
not replay a historical installer plan or require a Codex conversation.

E04, E05 and E06 pin `browser.mjs` in addition to their own collector and
`support.mjs`; E04 and E05 also pin the shared `execution.mjs` helper. The release
evidence audit rejects missing or changed helper pins. The browser helper
omits authentication headers, cookies, CSRF values, session responses and one-use
connection codes. Exact variants requiring live extension execution, current
permission revocation, in-flight instances or transaction fault points fail
explicitly until their own conditions and evidence are supplied.

E04／E05／E06 的采集器分别验证 Base 约束、版本与实例隔离、真实浏览器编辑。定义
校验、真实启用、阶段执行分别记录，不能互相替代。浏览器重启仅操作明确选择的隔离
安装，保留当前安装标识与原回执；涉及真实运行、权限撤销和事务故障的未实现变体
继续列为未完成，不用已通过的页面或字段测试替代。

## Monitor identities and original event evidence

E07/E12 can select up to eight named `principals`, each with exact
`connectionRef`, `connectionSha256`, `principalId`, `projectId` and
`expectedPermissions`. Protected connection files must point to the same selected
installed service, workspace, version and origin. Projects are explicit; aliases
never grant permissions. The default installed connection remains unchanged.
The browser session must return the selected identity and its declared browser
permissions. Identity setup is an operator-owned isolated test precondition,
not a collector mutation or a member-management product feature.

The shared helper retains original monitor JSON and Chromium CDP EventSource
frames separately from definition requests. It never waits for an endless SSE
response body or copies authentication headers. Before navigation, restart or
closing, outstanding finite response bodies are drained within a fixed timeout.
When the browser confirms `ERR_ABORTED` for a known Dashboard read without a
mutation request ID, the record retains the request, HTTP status and actual
terminal failure as `ABORTED_READ`; it has no successful response body. Writes
and the exact final validation used by the UI still require complete original
responses. Other missing bodies fail. Session HTTP failures discard underlying
exception messages and causes that may contain Cookie or CSRF headers.

E07 implements actual empty-project monitoring, original UNKNOWN inspection when
an instance is explicitly selected, and monitor identity/page denial checks.
The UNKNOWN case requires `monitorConfiguration.instanceId`; it cannot create
an UNKNOWN state directly. The expired replay-window case separately requires
`monitorConfiguration.allowReplayWindowExercise: true`: it retains a real signed
cursor, performs exactly 1001 native draft saves, restores the prior
draft, then reconnects with the original cursor and checks the server's actual
reset and current snapshot. It neither edits the database nor synthesizes an
SSE response. This branch needs the candidate's 1000-event replay profile.

The complete E07 journey and CV02 still require their original multi-project,
interruption/revocation/recovery conditions and are not credited from read-only
checks. MC06/CV08 candidate checks leave E22/P04 post-release obligations separate.
E07/E12 also pin `browser.mjs`; credential exposure checks compare selected
secrets internally against provided DOM/URL/traffic surfaces and the two exact
installed ordinary logs, returning only surface sizes and digests.

E07/E12 的命名连接仅选择现有受保护身份，不增加权限。监控 JSON、真实浏览器 SSE
帧、主动取消的过时只读请求分别留证；取消不计为成功响应。写入和页面使用的最终校验
仍必须保留完整原始响应。UNKNOWN 必须来自真实实例；游标窗口测试通过原生草稿事件
越过窗口后核对真实 reset，不直接写库或伪造事件。撤权与发布后安装验收继续独立要求。

## Lifecycle correction acceptance addition

The original catalog and usage addendum retain 688 required cases (678 PRE, 10 POST). LC01–LC21 add 20 PRE and one POST (LC12), giving **709 required Runtime cases (698 PRE, 11 POST)**. HO01–HO03 are separate post-delivery handoff checks. Each LC composite requires all its declared vectors; missing or unknown evidence cannot count as PASS.

原目录与用量补充方案的 688 项要求保持不变。LC01–LC21 新增 21 项，Runtime 合计 709 项；HO01–HO03 单独记账。原始执行回执不可改写；跨候选复用只能在已发布 Harness 政策兼容性得到验证后，形成新的当前 `PASS_REUSED` 资格，不能冒充当前候选重新执行。

See `governance/lifecycle-correction-v090.json` and the correction ADR. These are implementation obligations, not a statement that release acceptance has passed.

The LC01 singleton uses the correction collector's protected `lc01: {ref, sha256}`
selection. Its immutable descriptor is separate from expected bindings, avoiding
a self-referential fixture hash. The collector verifies the installed module
closure before importing product code, then observes source, candidate, toolchain,
fixture, collector, platform and actual authenticated permission bindings. Seven
controlled faults change only an expected binding; each must prevent the callback.
The positive callback performs one authenticated status read. Observations,
original responses and artifact pins use the correction report format consumed
by release auditing. A singleton PASS still reports 1 of 20 PRE cases and an
incomplete scenario; it grants no release authority or full-catalog completion.
