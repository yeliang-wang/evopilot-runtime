# Runtime documentation

Start with the [v0.5.0 Preview quickstart](../README.md#quickstart) for prerequisites and source setup.

- [Service API](service.md): embed the durable service, configure trusted providers and recover uncertain execution.
- [Registered execution feedback](feedback.md): durable evidence delivery and exact reviewed owner dispositions.
- [Native decision evidence](native-decisions.md): review-bound human decisions and historical readback.
- [CLI guide](cli.md): discovery, explicit workspaces and project/goal requests.
- [Roadmap](roadmap.md) and [changelog](../CHANGELOG.md): released capabilities, version contents and future targets.
- [Contributing](../CONTRIBUTING.md) and [security](../SECURITY.md): source checks, repository workflow and local trust assumptions.

## Installation paths

For the standalone SDK and CLI, follow the [Runtime v0.5.0 tarball installation](../README.md#install-a-release-tarball). The package includes compiled JavaScript and declarations; its standalone CLI supplies no execution providers.

For the composed product and Codex installation, use the [parent EvoPilot instructions](https://github.com/yeliang-wang/evopilot#readme) and [parent release assets](https://github.com/yeliang-wang/evopilot/releases). Provider configuration and the Codex entry belong to that separate distribution.

## v0.5 online integration

[Repair candidate API](online-repair.md) retains trusted Harness findings and review boundaries.
