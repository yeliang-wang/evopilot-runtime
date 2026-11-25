# Runtime v0.10.0 Preview feedback loop

English | [简体中文](zh-CN/runtime-v010-preview.md)

This guide is for operators and project owners preparing the 0.10.0 Preview journey in a dedicated project. The [accepted plan](runtime-v010-preview-plan.md) and [fixed acceptance inventory](../governance/acceptance-v010.json) define the required observations. The [architecture decision](architecture/runtime-v010-feedback-loop.md) records the authority and migration boundaries.

## Prepare the environment

Use a fresh private root and a dedicated project. For a published macOS arm64 package, follow the [download and identity checks](../README.md#install-a-release-tarball) with Node 24.14.0. Use an operator-prepared protected installation plan bound to the exact archive, executable, manifest, workspace, project and principal. An installed service, a registered plugin and an actual Codex Desktop session using the selected Expert and HTTP MCP are separate observations.

Use a build that advertises the feedback project operations and a service with protected bindings registered for the selected project. The project needs an active Project Lifecycle and references for feedback intake and reply, review notification and actions, the Linear team, the GitHub repository, the Cursor Agent, a published Harness rule and the merge policy. The two channel references can resolve to one connection with all four capabilities. Keep credential material in the operator's protected configuration. Use the [feedback configuration reference](../plugins/codex/skills/evopilot-runtime-expert/references/configuration.md#feedback-driven-lifecycle-configuration) for the exact operations.

Slack Socket Mode is the first platform adapter. The live Slack case `CHANNEL-REAL` is deferred. The representative live journey uses the authenticated callback reference channel together with the selected Linear, Cursor Cloud and GitHub services. Protocol tests exercise Slack separately.

For the timed merge case, bind project preauthorization to the repository, branch, low-risk paths, reviewer audience, required evidence and expiry. Use the approved GitHub installation and preserve the branch protection configured for the target branch. The representative journey includes Runtime worker continuation after closing Codex.

## Save and activate the configuration

1. In `/lifecycle`, open the feedback configuration. The graph is above the YAML editor. Edit the permitted inputs from a node or the YAML source. The editor accepts a single flat YAML 1.2 document up to 16 KiB.
2. Validate and save a draft. Read back the retained source and draft revision. On a lost response, inspect the original save receipt before deciding whether to retry.
3. In the Runtime Expert, inspect the saved draft and have the named owner review the exact activation preview. The service checks the seven binding roles against current observations. The preview binds the draft, active lifecycle, binding and policy revisions and expiry. Submit the owner's recorded approval for that exact candidate. If those inputs change, request a fresh preview and decision. Read back the activation receipt.

Draft validation checks structure. Saving retains the draft. Activation applies the reviewed configuration. Execution and release each require their own authority.

## Follow one case in the monitor

1. Send authorized feedback through the registered intake route. Record the original message, issue and instance identities. An incomplete report waits for a reply so that the original Linear issue and instance can continue.
2. Track reproduction and repair by Cursor Cloud. Review the original run and PR receipts. Independent verification binds to the exact head and base. A repair changes the candidate and requires fresh verification of the same PR.
3. Check the acknowledged review notice and its deadline. Runtime uses a full 60-minute window. A valid veto blocks the exact head. Expiry permits rechecking the candidate, current policy, review coverage, verification and GitHub protections. An eligible rebase merge requires exact GitHub confirmation before closing the issue and reporting success.
4. In the read-only `/monitor`, inspect the current node, visited path, actual return edge and reason, event details and review countdown. The countdown reflects the recorded deadline. Reconnect from the original event cursor or use the verified snapshot after a gap.

If a provider call has an unknown outcome, inspect the retained intent and reconcile with the original provider operation. Preserve the exact request, issue, run or PR identity. Keep dispatch paused while the outcome is unresolved. For rollback, stop intake and outbound dispatch and retain the isolated state for reconciliation. Upgrading an existing installation requires a separate migration decision and stopped-state backup.

## Read the acceptance and release status

Treat live Expert, real provider, independent verifier, 60-minute merge, recovery and both real browser journeys as candidate-bound evidence. The README image is an external example. Dashboard acceptance uses the approved design references, actual browser captures and matching event receipts. The package publication decision is separate from code merge and technical validation. Public readback and fresh replay are post-publication cases.
