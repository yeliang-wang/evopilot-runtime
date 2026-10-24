# Runtime documentation

Start with the [v0.8.0 Preview quickstart](../README.md#quickstart) for prerequisites and source setup.

- [Conversation-driven planning](planning-api.md): scoped revisions, exact human decisions and immutable execution bindings.
- [Service API](service.md): embed the durable service, configure trusted providers and recover uncertain execution.
- [Reviewed response execution](response.md): exact runbook and source pins, one actual action, independent verification and reviewed closure.
- [Registered execution feedback](feedback.md): durable evidence delivery and exact reviewed owner dispositions.
- [Native decision evidence](native-decisions.md): review-bound human decisions and historical readback.
- [CLI guide](cli.md): discovery, explicit workspaces and project/goal requests.
- [Roadmap](roadmap.md) and [changelog](../CHANGELOG.md): released capabilities, version contents and future targets.
- [Contributing](../CONTRIBUTING.md) and [security](../SECURITY.md): source checks, repository workflow and local trust assumptions.

## Installation paths

For the standalone SDK and CLI, follow the [published Runtime tarball installation](../README.md#install-a-release-tarball). The package includes compiled JavaScript and declarations; its standalone CLI supplies no execution providers.

For the composed product and Codex installation, use the [parent EvoPilot instructions](https://github.com/yeliang-wang/evopilot#readme) and [parent release assets](https://github.com/yeliang-wang/evopilot/releases). Provider configuration and the Codex entry belong to that separate distribution.

## v0.5 online integration

[Repair candidate API](online-repair.md) retains trusted Harness findings and review boundaries.

## v0.6 response linkage

Read [reviewed response execution](response.md) for the supported pinned Node collection profile, independent verification, durable recovery and exact owner feedback. Response state uses database marker 5; retain a matching stopped-state backup for rollback. Native v1 specifications remain unchanged. Exact release assets are recorded on the [v0.6.0 Release page](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.6.0).

## v0.7.0 Preview

Read [owner-readable API](readable-api.md) for exact snapshots, table-first reports and bounded comparisons. Native v1 formats and validators remain unchanged. The [v0.7.0 Preview release](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.7.0) records publication. Installing it and accepting a business project remain separate operations.

## Documentation maintenance

This default branch includes post-release documentation corrections for v0.7.0. Original tagged archives are immutable. See the [documentation correction policy](https://github.com/yeliang-wang/evopilot/blob/main/docs/github-release.md#documentation-corrections-after-publication).


## v0.8.0 Preview

v0.8 adds independent asset consumption, explicit L1/L2/L3 usability assessment, mandatory purpose/scope/level admission before reverse modeling, and controlled reconstruction with an independent fixed oracle. Verified L3 is limited to the reviewed functional slice and requires two clean complete reconstructions; it does not mean byte-identical source, whole-project coverage, production readiness or automatic release. Read [the current workflow/API](reconstruction.md). Publication and project acceptance retain separate evidence.
