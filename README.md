# EvoPilot Runtime 0.1.0

Runtime manages scoped projects, immutable goals, reviewed plans with exact Ontology/Harness pins, human decisions and durable execution receipts. One durable claim binds each run; uncertain execution is inspected and reconciled without redispatch. Execution status and business or quality evaluation remain distinct.

Choose the entry that matches your task:

- Use the [standalone CLI guide](docs/cli.md) to create and inspect projects, goals and receipts in an explicit workspace. This CLI supplies no external providers.
- Use the [service API guide](docs/service.md) to embed the durable service and inject trusted material resolvers, execution and receipt inspection callbacks.
- Use the parent EvoPilot Preview product entry for the composed experience. Preview provides actual native published Ontology/Harness resolvers and `execute`/`inspectReceipt` for representative quality and business validation. Shared-service and installed two-MCP-adapter integration have passing technical evidence. No arbitrary coding agent, new LLM or credential adapter is configured. The parent entry is distributed separately from this standalone package.

Use Node 24.14.0 on a platform with OS uid support. Node SQLite is experimental. Storage and adapters assume a non-malicious single OS uid; they do not provide isolation from hostile code running as that uid. Choose a canonical, explicitly owned workspace outside source/Git trees, with an existing parent. Imports and service construction perform no filesystem operations; initialization is explicit.

The package root exposes the pure `inspectPinnedInputs({ ontology, harness, observedOntology, observedHarness })` reference checker, `PRODUCT`, `VERSION` and immutable, I/O-free `capabilities()` metadata. It checks exact references through the [pinned compatibility contract](vendor/compatibility/v1/reference.mjs), never selects a latest version or executes work. See the [root API](src/index.mjs) and [pin manifest](vendor/compatibility/v1/manifest.json). The durable API is the separate `@evopilot-next/runtime/service` export.

Capability fields `M2_OWNED_SERVICE`, `businessOperationsReady: true` and `persistentBusinessOperationsReady: true` describe implemented generic service support. They do not prove that providers are configured. `hostIntegrationReady`, `acceptance`, `authority` and `softwareRelease` remain false. Parent Preview integration does not change those standalone API declarations.

From a source checkout, inspect the CLI without creating a workspace:

```sh
node src/cli.mjs help
node src/cli.mjs capabilities
```

Source development needs no dependency installation:

```sh
npm run check
npm run build
npm test
```

Check and build run the same owned ESM and pinned-vendor verifier. An existing source copy needs no parent generator; vendor regeneration belongs to the parent canonical build. Installed tarballs omit development scripts and tests. Full tests create isolated workspaces and exercise persistence and recovery.

The operator-reported baseline is 29 Runtime tests passing plus check/build, and 394 parent tests passing with zero skipped. Actual three-product composition and installed two-MCP-adapter shared-service, lost-response, restart and uninstall-preservation checks also passed as technical evidence. See the [verification scope](docs/service.md). These are retained results, not tests newly run for this documentation update.

Current Desktop E01–E19 acceptance status comes from a separate exact-candidate-bound acceptance report; without that report, no Host acceptance claim may be made. Consult the separate candidate-bound acceptance report for that status. This package claims neither old 6.3 feature parity, production readiness, Host PASS nor release authority. Read the [approved 0.1.x roadmap](docs/roadmap.md) for remaining work.

## Source and preview-release distribution

Source: [yeliang-wang/evopilot-runtime](https://github.com/yeliang-wang/evopilot-runtime). The [v0.1.0 preview release](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.1.0) is pending until published. See the parent [common release mechanics](https://github.com/yeliang-wang/evopilot/blob/main/docs/github-release.md) and [Codex plugin composition](https://github.com/yeliang-wang/evopilot).

CI and release preparation use Node 24.14.0. For this repository, `expected_digest` is the component tarball SHA256 from parent verified CI. Preparation defaults to `publish=false`, so publication is disabled by default. Publication requires external M5 target validation and an explicit user decision. Code, scripts, tests and CI provide technical evidence only; they do not establish Host acceptance or release authority, and existing feature metadata remains unchanged.
