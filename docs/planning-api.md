# Planning API — v0.7 candidate

Call `service.planning(envelope)` through the public service package. Codex forwards the same envelope using `evopilot_v01_native` with `owner: runtime`. The session must be active. All operations require an exact project scope `{visibility, projectId}`; private material never enters another project or a public consumer implicitly.

Read envelopes contain `operation`, `scope`, `input`. Mutations also require `requestId` and the current `expectedRevision` returned by `planning.inspect`. Planning shares the owner transactional record revision with feedback/online/response records. No blind revision refresh is permitted. A repeated exact request returns its retained receipt, even after subsequent revisions; reuse with different intent fails.

| Operation | Input | Result |
|---|---|---|
| `planning.inspect` | `{}` | Owner revision, supported operations, no execution/release authority |
| `planning.list` | `{}` | Scoped plan heads |
| `planning.read`, `planning.review` | `id`, optional `digest` | Immutable revision, exact decision, blockers, source limitations |
| `planning.revise` | `id`, `parentDigest` (null only initially), `draft` | New immutable revision and digest |
| `planning.decide` | `id`, `digest`, `decision`, `actor`, `humanEvidenceRef` | Exact APPROVE/REJECT decision |
| `planning.bind` | `id`, `planDigest`, `milestoneId`, `goalId`, `projectId`, `assets`, `requirements` | Immutable project execution binding |
| `planning.binding.inspect` | `projectId` | Binding, freshness and explicit blocker |
| `planning.export` | `id`, optional `digest` | Accepted baseline Markdown and structured view with export digest |
| `planning.export.verify` | `export` | Whether exact current owner export matches supplied bytes/fields |
| `planning.receipt.inspect` | `requestId` | Original scoped receipt or null |

The exported `PlanningDraft`, `PlanningSource`, `PlanningItem`, `PlanningMilestone`, `PlanningCandidate`, `PlanningRevision`, `PlanningDecision` and `PlanningBinding` types are available from `@evopilot-next/runtime/service`. Unknown fields are rejected.

## Draft fields

- `title`, `objective`, `sourceRevision`, `sourceDigest`: source digest is the native source tree digest (including for forward requirement snapshots).
- `sources`: id, kind (`conversation`, `document`, `code`), reference, representation (`excerpt`, `summary`, `reference-only`), content/contentDigest, attributedRole. Excerpt/summary bytes must match their SHA-256 digest. Reference-only sources require both content fields null. Attribution is a declaration, not identity authentication. URLs are retained as data and are not fetched by Runtime.
- `items`: id, kind (`requirement`, `assumption`, `question`, `option`, `decision`), text, disposition (`proposed`, `included`, `rejected`, `unresolved`), sourceIds, dependsOn, ownerImpact and acceptance strings.
- `milestones`: id, title, targetVersion, priority (0–1000), requirementIds and dependsOn. Dependencies must exist and be acyclic.
- `exclusions`: explicit out-of-scope statements.
- `candidates`: owner, id, version, digest and itemIds. These are planning declarations; they do not prove native validation/publication.

Approval rejects unresolved/proposed items, included unanswered questions, missing sources, missing acceptance for included requirements, invalid dependencies and missing/invalid milestones. Rejected alternatives remain in history. A human may accept explicitly stated assumptions; they remain assumptions rather than observed facts.

## Bindings and execution

`assets` contains exact published native `ontology` and `harness` references resolved through trusted owner APIs. `requirements` contains `{itemId, criterionIds}` for every requirement in the selected milestone. It must cover the fixed native business requirements; project/domain structural checks stay independent. The actual project's Goal and source revision/tree digest must match. A project can bind once; a replacement requires a new project candidate. Native collection and Run claim admission check binding freshness in the same transaction. Run pins must match bound assets. Inspection/reconciliation of old claims remains available.

Limits: 1 MiB request, 100 revisions per plan, 200 sources/items/candidates, 50 milestones, 16,384 characters per excerpt. The existing owner record/receipt store bounds also apply. Oversize input is rejected. No automatic global chat capture, source-code write, asset acceptance, execution or release is provided.

## Recovery and compatibility

Planning writes mark Runtime schema 6. v0.6 readers cannot open it. Source scope and immutable digests are preserved during supported isolated relocation, while owner snapshots include planning records/receipts. Read a retained receipt after uncertainty; never create a different execution to hide an unknown result. `PLANNING_REVISION_CONFLICT`, `PLANNING_REVIEW_REQUIRED`, `PLANNING_SOURCE_DRIFT`, `PLANNING_REQUIREMENTS`, `PLANNING_ASSET_DRIFT` and `PLANNING_STALE_BINDING` identify different prerequisites.
