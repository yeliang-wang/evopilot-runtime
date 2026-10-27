# EvoPilot Runtime · v0.8.3 Preview

English | [简体中文](README_CN.md)

Runtime is the durable execution layer of [EvoPilot](https://github.com/yeliang-wang/evopilot/blob/main/README.md). It owns projects, goals, reviewed plans, decisions, execution claims, receipts and audit. [Ontology](https://github.com/yeliang-wang/evopilot-ontology/blob/main/README.md) owns semantic models; [Harness](https://github.com/yeliang-wang/evopilot-harness/blob/main/README.md) owns quality policies and evidence evaluation.

[Quickstart](#quickstart) · [Service API](docs/service.md) · [CLI](docs/cli.md) · [Documentation](docs/README.md) · [Release](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.8.3)

## Capabilities

| Capability | Behavior |
|---|---|
| Planning | Scoped projects, immutable goals, reviewed revisions and exact execution bindings |
| Asset references | Fixed Ontology/Harness versions and digests; no implicit latest-version selection |
| Execution | Trusted resolvers prepare a pinned plan; a configured executor receives one committed claim |
| Recovery | Inspect and reconcile uncertain outcomes using the original request and retained receipt |
| Feedback and response | Retain registered evidence, reviewed runbook bindings, independent verification and both owners' dispositions |
| Online findings | Read trusted Harness findings into `REVIEW_REQUIRED` repair candidates without dispatching repairs |
| SDK and CLI | Strict TypeScript source, compiled ESM and declarations; no runtime dependencies |

The standalone CLI supplies no resolvers, executor or receipt inspector. Discovery, project/goal planning and state inspection work without an execution provider; preparing and dispatching Runs require the corresponding trusted providers. Installing Runtime does not configure arbitrary coding or deployment.

## Quickstart

For Codex and the composed product, use the [parent installation guide](https://github.com/yeliang-wang/evopilot/blob/main/docs/installation.md). Runtime has no separate Codex plugin.

### Install a release tarball

Use **Node 24.14.0** on a platform with OS uid support. SQLite is experimental. Download all three assets from [v0.8.3 Preview](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.8.3): `evopilot-next-runtime-0.8.3.tgz`, `source-revision.txt` and `SHA256SUMS`. In their directory, verify and inspect before installing into your consumer project:

```sh
shasum -a 256 -c SHA256SUMS
cat source-revision.txt
npm install --ignore-scripts /absolute/downloads/evopilot-next-runtime-0.8.3.tgz
npx --no-install evopilot-next-runtime help
```

Distribution uses GitHub Releases, not an npm registry. There is no Runtime dependency-lock asset. The package contains compiled entry points, declarations, source and documentation; development scripts and tests are excluded. See [service examples](docs/service.md) and [CLI examples](docs/cli.md).

### Develop from source

From a source checkout with locked TypeScript 5.9.3 tools:

```sh
npm ci --ignore-scripts
npm run build
npm run check
npm test
node dist/cli.js help
node dist/cli.js version
node dist/cli.js capabilities
```

Build regenerates only `dist`; checks verify types, public exports and vendor integrity. Tests use isolated workspaces. Discovery does not create a Workspace. Persisted operations require an explicitly owned canonical path outside source/Git trees and an existing parent directory.

## Content levels and trust

Current `readiness.*` operations explicitly select `standardVersion: "v2"`. L1 describes domain understanding, L2 implementation specifications and L3 complete reconstruction specifications. Runtime records modeling intent and `ASSET_CONTENT_ONLY` completion; Harness owns the content assessment. Read the [v2 API](docs/readiness-v2.md).

L3 does not require software reconstruction. `assetAssessment` and `reconstructionVerification` are independent; `L3 / NOT_REQUESTED` is valid. It does not establish generated functional equivalence, identical source, production readiness or release authority. Historical usability v1 records retain their original meaning.

Runtime trusts a non-malicious single OS uid and injected adapters; it does not isolate hostile code running as that uid. Preserve exact receipts after uncertainty. Metadata is not evidence of configured providers or acceptance. Preview is not GA. The composed response collector supports pinned Node work in an isolated copied directory; Java/Maven, remote execution and production remediation are outside that profile.

## Documentation and contribution

- [Documentation index](docs/README.md), [planning](docs/planning-api.md), [readable API](docs/readable-api.md) and [decision evidence](docs/native-decisions.md).
- [Registered feedback](docs/feedback.md), [online repair candidates](docs/online-repair.md) and [reviewed response](docs/response.md).
- [Changelog](CHANGELOG.md), [Roadmap](docs/roadmap.md), [contribution guide](CONTRIBUTING.md) and [bilingual maintenance](docs/documentation-languages.md).
- [Security](SECURITY.md), [Apache-2.0 license](LICENSE), [notices](NOTICE) and [provenance](provenance/).

Documentation navigation draws inspiration from [OpenHands](https://github.com/OpenHands/OpenHands); wording is independently written and no affiliation is implied.

These source pages include documentation improvements after v0.8.3. Existing tagged archives retain their original documentation; future releases package the updated pages.
