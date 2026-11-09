# Runtime v0.9 lifecycle correction and evidence applicability

Status: implementation approved by the current conversation review on 2026-11-09. Product acceptance and exact release authority remain separate.

This ADR replaces only the assumption in the earlier v0.9 acceptance design that every raw PASS must have been executed on the final candidate. Existing execution authority, raw stage states, Base stages, owner boundaries and historical receipts are unchanged.

## Decision

Use the existing deterministic Runtime service, object transactions, request/reconcile/advance paths and published Harness evaluation boundary. Do not add a separate workflow engine or a ninth stage. A correction proposal is a hypothesis, not an execution grant or a quality verdict.

Keep independent authorized validation branches running after unrelated failures. Failed dependencies block their dependants, serial stateful groups remain indivisible, and candidate identity, environment integrity, authority and resource failures stop all affected branches. A failed required check still prevents release.

A new versioned qualification distinguishes actual execution from `PASS_REUSED`. Raw executed evidence remains byte-identical and bound to its original candidate. Current applicability requires a complete dependency/input manifest, original execution receipt, current candidate, published Harness policy, validity and an assessment receipt. A label-only chain, missing dependency, revoked trust or unknown applicability cannot qualify. Reuse does not create environment state or erase failures and flaky history.

## Alternatives

Always rerun every case after any RC change: conservative but repeats unrelated expensive work and does not address fail-fast scheduling. A new generic workflow engine: unnecessarily changes execution and recovery ownership. The selected option adds bounded planning and separately verifiable qualifications to existing execution.

## Migration and compatibility

Read old raw execution records without assigning new qualification implicitly. New qualification schemas must be rejected by consumers that do not support them. The owner policy capability must be demonstrated before enabling formal reuse; Runtime may not invent Harness quality semantics. Existing stage statuses remain unchanged. Schema and installation guards must reject opening newer state with an older binary. Rollback uses a verified pre-upgrade snapshot, retaining subsequent evidence separately. Migration tests must exercise upgrade, rejection and rollback, not simply a JSON parse.

No automatic owner-source upgrade, business asset mutation, historical result rewrite or public release is authorized by this ADR. Ontology development moves to its exact named chat only after installed Runtime acceptance. Any required Harness interface change needs its own precise Target.

## Validation and replacement conditions

The separate correction contract freezes LC01–LC21 (20 PRE, one POST), all internal vectors required; the old 688 cases remain required. HO01–HO03 are separate post-delivery coordination acceptance. Qualification consumers and release auditors must reject unsupported or unproven qualifications until their contract and actual tests pass. A required new executor, owner API or permission boundary beyond this review returns to explicit review.
