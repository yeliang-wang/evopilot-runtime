# EvoPilot Runtime · v0.9.0 Preview

English | [简体中文](README_CN.md)

**Development status:** package version 0.9.0 is prepared for candidate qualification. Full acceptance and publication are pending. The [planned Release location](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.9.0) is not evidence that downloads are available.

Runtime is an independent lifecycle service. It owns project definitions, goals, targets, instances, execution gates, receipts and audit. Codex supplies reasoning and coding through one Runtime Expert/HTTP MCP plugin. Runtime requires no LLM Profile and runs no autonomous model loop.

[Operator guide](docs/runtime-v090.md) · [Lifecycle API](docs/lifecycle-api.md) · [Documentation](docs/README.md) · [Fixed acceptance](docs/acceptance-v090.md)

## Capabilities

| Capability | Behavior |
|---|---|
| Base and project lifecycle | Publisher-owned immutable Base; mandatory eight-stage configuration; YAML and bounded extensions |
| One service | HTTP API, Streamable HTTP MCP and CLI share server-side authorization and state |
| Two Dashboard pages | Lifecycle graph/YAML editing with same-page activation; separate read-only instance monitoring |
| Agent and CI | Codex executes authorized work; GitHub Actions/GitLab CI identities, artifacts and receipts are verified |
| Owner integration | Consume published Ontology/Harness APIs, fixed assets and evaluations; retain feedback and recovery |
| Distribution | Strict TypeScript core; compiled JavaScript, declarations, static UI, locked production dependencies and one plugin |

[Ontology](https://github.com/yeliang-wang/evopilot-ontology/blob/main/README.md) owns semantic assets. [Harness](https://github.com/yeliang-wang/evopilot-harness/blob/main/README.md) owns validation assets and evidence evaluation. [EvoPilot](https://github.com/yeliang-wang/evopilot/blob/main/README.md) supplies navigation. Their versions need not match Runtime. Definition activation does not approve a Target, execute a Run or authorize publication.

## Quickstart

### Install a release tarball

After publication, use **Node 24.14.0 on macOS arm64** and obtain all six assets from the owning Release: `evopilot-runtime-0.9.0-darwin-arm64.tar.gz`, `evopilot-next-runtime-0.9.0.tgz`, `distribution-manifest.json`, `runtime-dependency-lock.json`, `source-revision.txt` and `SHA256SUMS`. In a new private download directory:

```sh
shasum -a 256 -c SHA256SUMS
cat source-revision.txt
mkdir unpacked
tar -xzf evopilot-runtime-0.9.0-darwin-arm64.tar.gz -C unpacked
chmod 600 distribution-manifest.json
node unpacked/package/dist/server/cli.js help
```

The standalone archive contains its runtime dependencies; it needs no parent source, development compiler or network dependency installation. The npm tarball is the compiled SDK package, accompanied by the exact dependency lock. GitHub Releases are the distribution channel; there is no npm registry publication.

Prepare a protected exact installation plan using the [operator guide](docs/runtime-v090.md). The installer verifies the archive, complete file inventory, executable identity and selected scope before staging or starting the service. One installation registers the Runtime Skill and HTTP MCP connection together. Current Host readback remains required; a written configuration is not completed deployment. Preserve a verified stopped backup before migration and inspect original receipts after uncertainty.

### Develop from source

Use the locked TypeScript 5.9.3 toolchain:

```sh
npm ci --ignore-scripts
npm run build
npm run check
npm test
node dist/server/cli.js help
```

Source tests are isolated technical evidence. They do not replace the fixed acceptance, real Host journeys, publication or installed verification. Candidate distribution preparation runs only from clean committed source.

## Content levels and trust

Retained `readiness.*` APIs use `standardVersion: "v2"`: L1 is domain understanding, L2 implementation specification and L3 reconstruction specification completeness. `assetAssessment` and `reconstructionVerification` are independent; `L3 / NOT_REQUESTED` is valid. It does not prove generated functional equivalence or grant release authority. See the [v2 API](docs/readiness-v2.md).

Secrets stay in protected references, outside YAML and ordinary logs. Service-managed operations enforce scope, authority and exact evidence; Runtime does not control unrelated work performed outside its managed paths. The local trust boundary assumes a non-malicious OS user. Preview does not establish GA or production deployment support. Historical records and the [v0.8.3 documentation](https://github.com/yeliang-wang/evopilot-runtime/blob/v0.8.3/README.md) retain their original meaning.

## Documentation and contribution

- [Documentation index](docs/README.md), [CLI](docs/cli.md), [planning](docs/planning-api.md) and [readable API](docs/readable-api.md).
- [Compatibility and migration](docs/legacy-host.md), [feedback](docs/feedback.md) and [reviewed response](docs/response.md).
- [Changelog](CHANGELOG.md), [Roadmap](docs/roadmap.md), [contributing](CONTRIBUTING.md) and [bilingual maintenance](docs/documentation-languages.md).
- [Security](SECURITY.md), [Apache-2.0 license](LICENSE), [notices](NOTICE) and [provenance](provenance/).
