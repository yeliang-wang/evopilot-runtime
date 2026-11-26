# Runtime v0.10.0 Preview feedback loop

English | [简体中文](zh-CN/runtime-v010-preview.md)

This guide is for operators and project owners preparing the 0.10.0 Preview journey in a dedicated project. The [accepted plan](runtime-v010-preview-plan.md) and [fixed acceptance inventory](../governance/acceptance-v010.json) define the required observations. The [architecture decision](architecture/runtime-v010-feedback-loop.md) records the authority and migration boundaries.

## Prepare the environment

Use a fresh private root and a dedicated project. For a published macOS arm64 package, follow the [download and identity checks](../README.md#install-a-release-tarball) with Node 24.14.0. Use an operator-prepared protected installation plan bound to the exact archive, executable, manifest, workspace, project and principal. An installed service, a registered plugin and an actual Codex Desktop session using the selected Expert and HTTP MCP are separate observations.

Use a build that advertises the feedback project operations and a service with protected bindings registered for the selected project. The project needs an active Project Lifecycle and references for feedback intake and reply, review notification and actions, the Linear team, the GitHub repository, the Cursor Agent, a published Harness rule and the merge policy. The two channel references can resolve to one connection with all four capabilities. Keep credential material in the operator's protected configuration. Use the [feedback configuration reference](../plugins/codex/skills/evopilot-runtime-expert/references/configuration.md#feedback-driven-lifecycle-configuration) for the exact operations.

In the protected integrations file selected by `serve --integrations-ref`, register one `feedback-activation-policy` resource for the project. Its definition holds `ownerId`, `ownerRevision`, an `observations` pin with the canonical `path` and `sha256:` byte `digest`, and a private `decisionDirectory`. The operator supplies the current `runtime-feedback-binding-observations/v1` record for that workspace and project, including one observation per binding role. When recording an actual owner decision, keep both the native decision record and its original source in the registered directory. The activation request references that decision by its SHA-256-pinned local file URI.

Set the policy and observation pin before activating the Project Lifecycle. If the integrations file changes, revalidate the lifecycle bindings and activate the current definition before reviewing feedback activation. The trusted operator retains the named owner's real approval and original source as owner-only files directly inside the registered decision directory.

For real-use acceptance, open an actual signed-in Codex Desktop conversation with the installed Runtime Expert connected to the Runtime HTTP MCP. Record the signed-in identity, observed conversation model, package identity and original HTTP request receipts in private evidence. Use isolated protected test bindings backed by fixture provider data for the activation check. The named project owner records the actual decision for the exact activation candidate.

Slack Socket Mode is the first platform adapter. Local automated tests cover the Slack protocol, authenticated callback reference and provider contracts. The live Slack case `CHANNEL-REAL` is deferred. Real Linear, Cursor Cloud and GitHub App operations are outside this release’s acceptance scope.

For an operational timed merge, bind project preauthorization to the repository, branch, low-risk paths, reviewer audience, required evidence and expiry. Use the approved GitHub installation and preserve the branch protection configured for the target branch. Local automated tests exercise the merge rule with a controlled clock and worker continuation after the client disconnects.

## Save and activate the configuration

1. In the Runtime Expert, validate the feedback configuration through Runtime HTTP MCP. Verify that invalid input is rejected. Supply a single flat YAML 1.2 document up to 16 KiB and save the valid draft.
2. Read back the original save receipt, exact YAML and draft revision. Restart the isolated Runtime, reconnect from the signed-in Codex Desktop session and read back the same draft and receipt. On a lost response, inspect the original save receipt before deciding whether to retry.
3. Have the named project owner review the exact activation preview. The service checks the seven binding roles against current observations. The preview binds the draft, active lifecycle, binding and policy revisions and expiry. Submit the owner's recorded approval for that exact candidate through the Expert. If those inputs change, request a fresh preview and decision. Read back the activation receipt and confirm the active configuration matches the reviewed draft.

Draft validation checks structure. Saving retains the draft. Activation applies the reviewed configuration. Execution and release each require their own authority.

## Follow one case in the monitor

1. Send authorized feedback through the registered intake route. Record the original message, issue and instance identities. An incomplete report waits for a reply so that the original Linear issue and instance can continue.
2. Track reproduction and repair by Cursor Cloud. Review the original run and PR receipts. Independent verification binds to the exact head and base. A repair changes the candidate and requires fresh verification of the same PR.
3. Check the acknowledged review notice and its deadline. Runtime uses a full 60-minute window. A valid veto blocks the exact head. Expiry permits rechecking the candidate, current policy, review coverage, verification and GitHub protections. An eligible rebase merge requires exact GitHub confirmation before closing the issue and reporting success.
4. In the read-only `/monitor`, inspect the current node, visited path, actual return edge and reason, event details and review countdown. The countdown reflects the recorded deadline. Reconnect from the original event cursor or use the verified snapshot after a gap.

If a provider call has an unknown outcome, inspect the retained intent and reconcile with the original provider operation. Preserve the exact request, issue, run or PR identity. Keep dispatch paused while the outcome is unresolved. For rollback, stop intake and outbound dispatch and retain the isolated state for reconciliation. Upgrading an existing installation requires a separate migration decision and stopped-state backup.

## Read the acceptance and release status

`EXPERT-REAL` is the pre-publication real-use E2E. Local automated cases cover the integrated feedback loop, independent verification, the 60-minute merge rule and recovery. The two Dashboard cases use local automated browser runs and the approved design references. Retain screenshots and matching event receipts for the graph above the YAML editor on `/lifecycle` and the read-only run projection on `/monitor`. The README image is an external example.

Exact candidate GitHub CI and bilingual documentation are pre-publication checks. Publishing the exact package requires a separate approval. After publication, `PUBLIC-READBACK` checks the GitHub prerelease, tag and anonymous download digests. `FRESH-REPLAY` installs the exact downloaded package into a fresh private root and repeats the signed-in Codex Desktop Expert and Runtime HTTP MCP journey, including the owner-approved activation.
