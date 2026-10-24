# Controlled reconstruction API

Use `createRuntimeService` from `@evopilot-next/runtime/service`, call `initialize()`, then use its typed `reconstruction(request)` API. The standalone CLI has no reconstruction providers. An installation configures trusted providers; request JSON cannot do so.

| Operation | Input | Meaning |
| --- | --- | --- |
| `reconstruction.inspect` | `{}` | Current owner extension revision |
| `reconstruction.review` | `plan` | Validate scope, accepted planning revision and exact plan digest |
| `reconstruction.freeze` | `plan`, `humanEvidenceRef` | Retain exact reviewed plan |
| `reconstruction.plan` | `digest` | Read retained plan |
| `reconstruction.dispatch` | `planDigest` | Claim once, then invoke the configured adapter |
| `reconstruction.attempt` | `id` | Read current attempt and original claim |
| `reconstruction.list` | `planDigest` | All attempts, including failed ones |
| `reconstruction.reconcile` | `id` | Inspect the original execution; never redispatch |
| `reconstruction.cancel` | `id` | Retain cancellation and ask the adapter to stop |
| `reconstruction.evidence` | `id` | Verify current pins, recheck receipt/output, then return trusted observations |

Freeze, dispatch, reconcile and cancel require `requestId` and `expectedRevision`. Read the revision using `reconstruction.inspect`; it shares the Runtime extension store with planning and feedback. Exact request retries preserve the original receipt. Use a new request identity for a later explicit reconciliation. Reads do not accept mutation fields.

Configure `verifyReconstructionPlan`, `executeReconstruction`, `inspectReconstruction` and `cancelReconstruction`. Evidence also requires `observeReconstruction`. Providers receive the original claim and an AbortSignal. A verifier must consult authoritative frozen inventories/specifications/current pins; a constant affirmative callback is suitable only for explicitly synthetic tests. The observation reader must run or inspect actual independent behavior observations bound to the protected output; it must not return expected oracle values as observations.

Supported budgets are at most four attempts, 3600000 ms total wall time, 8 MiB output per attempt, one concurrent builder, one million tokens and 100 million cost micro-units. Providers must enforce their declared lower limits and record usage. Runtime validates terminal receipts against the remaining budget. An unknown execution retains its reservation and blocks another builder. No automatic fallback to another executor, model or source-assisted mode is allowed.

Receipt wall time records the actual safe-integer measurement, including cleanup after a deadline. It is not truncated to the 3600000 ms admission limit. An overrun cannot support success, and its full duration is deducted before any later dispatch. Missing cleanup evidence remains UNKNOWN rather than producing a terminal receipt.

`reconstruction.evidence` revalidates the original successful adapter receipt and observation, then seals `execution: {planDigest, claimId, cleanWorkspaceId, receiptDigest}` from Runtime's protected records. An observer-supplied conflicting identity is rejected. The final observation digest covers this identity. Harness uses it to distinguish independent clean attempts; an execution receipt still does not certify semantic equivalence or authorize release.

`maxCostMicros: null` explicitly requests no monetary ceiling when the selected provider cannot measure charges. It is not a zero-cost budget. Receipt `usage.costMicros` and `usage.tokens` preserve unavailable measurements as `null`. Success always requires known token usage; a numeric monetary ceiling also requires known cost. A terminal failed or cancelled attempt with unknown tokens blocks subsequent dispatch under that plan because the remaining token budget cannot be established. Unknown cost similarly blocks subsequent dispatch when the ceiling is numeric. Restart and reconciliation do not turn unknown usage into zero.

`SUCCEEDED` means the configured generation/build/run stages completed with a valid receipt. It is not a behavior equivalence verdict. `UNKNOWN` requires original-receipt reconciliation. Old results remain readable after planning or asset drift, but current evidence consumption fails closed. Synthetic, source-assisted or non-independent evidence cannot establish real L3.

State marker 7 prevents older writers from changing reconstruction records. Close all services before using the supported workspace backup/restore APIs. Do not copy a live database or reset an unresolved claim to repeat execution.
