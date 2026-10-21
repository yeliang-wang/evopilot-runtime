# Runtime documentation

Start with the [v0.6.0 Preview quickstart](../README.md#quickstart) for prerequisites and source setup.

- [Service API](service.md): embed the durable service, configure trusted providers and recover uncertain execution.
- [Reviewed response execution](response.md): exact runbook and source pins, one actual action, independent verification and reviewed closure.
- [Registered execution feedback](feedback.md): durable evidence delivery and exact reviewed owner dispositions.
- [Native decision evidence](native-decisions.md): review-bound human decisions and historical readback.
- [CLI guide](cli.md): discovery, explicit workspaces and project/goal requests.
- [Roadmap](roadmap.md) and [changelog](../CHANGELOG.md): released capabilities, version contents and future targets.
- [Contributing](../CONTRIBUTING.md) and [security](../SECURITY.md): source checks, repository workflow and local trust assumptions.

## Installation paths

For the standalone SDK and CLI, follow the [Runtime v0.6.0 tarball installation](../README.md#install-a-release-tarball). The package includes compiled JavaScript and declarations; its standalone CLI supplies no execution providers.

For the composed product and Codex installation, use the [parent EvoPilot instructions](https://github.com/yeliang-wang/evopilot#readme) and [parent release assets](https://github.com/yeliang-wang/evopilot/releases). Provider configuration and the Codex entry belong to that separate distribution.

## v0.5 online integration

[Repair candidate API](online-repair.md) retains trusted Harness findings and review boundaries.

## v0.6 response linkage

Read [reviewed response execution](response.md) for the supported pinned Node collection profile, independent verification, durable recovery and exact owner feedback. Response state uses database marker 5; retain a matching stopped-state backup for rollback. Native v1 specifications remain unchanged. Exact release assets are recorded on the [v0.6.0 Release page](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.6.0).
