# Legacy Host entry on independent Runtime

`evopilot_v01_guide` remains an offline, read-only tool. The `v01` namespace is
historical; it does not identify the current Runtime version. Starting the
compatibility entry without a connection exposes only the guide. A missing or
unavailable connection cannot prevent a guide call. Service calls still require
the exact protected connection; the bridge never starts a daemon, creates a
Workspace, opens a Runtime database or grants permissions.

The guide preserves the original named scenarios and V02–V08 identifiers. V02
use cases and all original test paths describe historical provenance, not current
acceptance evidence. Guide text is not capability discovery: inspect advertised
tools and the selected service's current scoped capabilities before executing a
step. A missing provider, helper or permission remains a prerequisite failure.
Do not emulate missing product features with untracked temporary scripts.

Resolve `installedReferences` against this Runtime package root. Resolve an
`ownerReferences` entry against the explicitly registered, verified published
Ontology or Harness **0.8.3** package root. Do not resolve through an EvoPilot
parent installation, plugin cache, current directory or sibling source checkout.
Owner schemas, standards and native lifecycle remain authoritative.

## Current content and historical execution

New asset grading uses explicit readiness **v2**. Before formal source reverse,
document forward or asset composition modeling, retain purpose, complete scope,
exclusions, fixed inputs, independent requirements and the user's target level.
Reuse unambiguous decisions already received; resolve only missing choices.

L1 covers domain understanding; L2 adds the 13 behavior facets; L3 adds the nine
reconstruction specification closure categories. Native validation, concrete
semantic review and exact publication remain separate. L3 with optional
reconstruction `NOT_REQUESTED` is valid. Content grading does not require a
business database, SSH, actual software reconstruction or a business Run.
Historical v1 assessments retain their original obligations and evidence.
See [readiness v2](readiness-v2.md) and [decision evidence](native-decisions.md).

Optional collection, Run, response, feedback and reconstruction flows preserve
their original scope, owner revisions, immutable pins, concrete decisions,
claims and receipts. A response cancellation is only a request until a worker
receipt confirms it. After UNKNOWN, inspect and reconcile the original request;
do not refresh CAS or redispatch to remove uncertainty. Optional online telemetry
needs explicitly registered real providers and selected bindings; reading a
finding or a guide does not start a worker or establish service health.

## Definition and operation boundaries

Legacy project preparation, private Goal/Target/Loop records and content grades
never activate a new Project Lifecycle. The v0.9 lifecycle independently requires
all mandatory Base configuration, verified GitHub/GitLab bindings and same-entry
save-and-activate. Runtime's two Dashboard pages are the lifecycle editor and a
separate read-only instance monitor. Owner asset authoring stays in the configured
published owner entry; the Runtime HTTP service does not gain that authority.

The stdio bridge forwards legacy Runtime requests to the same independent HTTP
service. An explicit owner Host registration delegates only its allowed calls
to published owner APIs. Activation is session intent, not execution or release
permission. Deactivation affects that session, not a peer chat or the service.
Workspace maintenance must preserve the new service state, private project,
owner state, claims and evidence under one writer. A live capacity scan or the
Runtime-only migration backup is not a full consistent Workspace backup.

The independent operator helpers in `src/installation/workspace/` provide
managed schema-9 snapshots and resumable backups. The exact selected private
project, owner workspace and service installation are separate roots. The
operator must stop the selected Runtime and any separate online worker first;
the helpers retain the shared Host lease and both Runtime writer leases during
inspection and copying. They do not stop, restart or reconcile business work.
An installed helper can include its own exact `serviceRoot/package` distribution
when the protected specification matches; this does not permit a source checkout
or an arbitrary ancestor directory to become a maintenance root.

All database tables and selected payload files are preserved. SQLite validation
uses disposable copies, and the new service's receipt/audit/event ledger is
checked there. Business WAL/SHM/journal files block capture. Only the two temporary
journals created by the held, empty writer-lock files are excluded, with their
exact paths recorded in `transientExclusions`; the empty lock files are retained.
An unchanged workspace produces the same snapshot digest across acquisitions.

The backup includes service specification references and explicitly selected
additional reference files. External source trees, owner distributions,
toolchain caches and relocation signing keys are not recursively imported by
following JSON paths. Required lineage key identifiers remain in the manifest;
same-host key availability is still a recovery prerequisite. Coverage is stated
as `SELECTED_ROOTS_AND_REFERENCE_FILES`, not a claim to recreate the complete
external environment. Keep backup roots private and their expected digest in
the separate retained maintenance record. Verification checks that external
digest, every copied file and mode, internal relative links and reference bytes.
An interrupted copy resumes only the same request and verified prefix; source
drift or foreign partial content is rejected without overwriting it.

These helpers currently establish snapshot/backup preservation only. The Host
maintenance aliases, restore and location migration still require their own
integration and acceptance; neither this documentation nor a source test marks
the complete legacy maintenance path accepted.

## 中文说明

旧 `evopilot_v01_guide` 名称继续可用，但指南、历史场景编号和历史测试路径
都不代表当前功能已验收。指南可离线读取，不创建工作区、不启动服务、也不授权执行。
实际调用仍须检查当前连接、工具和权限；缺失能力不能由临时脚本冒充。

新版 L3 是本体资产内容与重建规格闭合等级，允许重建状态为 `NOT_REQUESTED`。
内容授级不要求数据库、SSH、实际重建或业务 Run。旧版证据保留原语义。
私有项目记录不自动激活 v0.9 Project Lifecycle；后者必须补齐 Base 的全部配置，
并通过当前入口的保存与激活门禁。日常安装、全量备份和发布仍须各自的精确证据。

独立服务的运维快照与备份现已覆盖明确选择的私有项目、两方资产和历史状态、
新服务安装目录及选定的外部配置文件。须先停止对应服务和独立在线 worker；
备份持有工作区与双写入锁，保留所有数据库表和业务文件。数据库校验只在临时
副本进行，发现业务 WAL 等残留时拒绝执行。仅持锁期间产生的两个临时锁日志
不复制，排除路径会记入清单；这不豁免任何业务数据。

外部源码、工具链缓存、两方发行包和迁移签名密钥不会因 JSON 中出现路径就被
递归导入。应保留对应依赖及密钥；清单只声明所选目录和文件的覆盖范围。
中断后只允许按原请求、原源数据及核对后的复制进度继续；摘要或文件变化会被
拒绝。备份校验通过不代表已完成恢复、搬迁、Host 运维入口或最终产品验收。
