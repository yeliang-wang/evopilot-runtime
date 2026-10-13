# EvoPilot Runtime

[Quickstart](#quickstart) · [Documentation](docs/README.md) · [Service API](docs/service.md) · [CLI](docs/cli.md) · [Releases](https://github.com/yeliang-wang/evopilot-runtime/releases) · [Contributing](CONTRIBUTING.md)

Runtime is the durable execution layer of [EvoPilot](https://github.com/yeliang-wang/evopilot). It owns scoped projects, immutable goals, reviewed plans, human decisions, execution claims, receipts and audit. [Harness](https://github.com/yeliang-wang/evopilot-harness) owns quality assets and evaluation; [Ontology](https://github.com/yeliang-wang/evopilot-ontology) owns semantic models and validation.

**[v0.2.0 Preview](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.2.0)** provides strict TypeScript source, compiled JavaScript and declarations, and refined packaging and documentation. [v0.1.0](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.1.0) is the historical baseline. See the [changelog](CHANGELOG.md) and [roadmap](docs/roadmap.md).

## Capabilities

| Capability | Standalone behavior |
| --- | --- |
| Project and goal planning | Create and inspect scoped projects and immutable goals in an explicit workspace. |
| Reference inspection | Compare exact Ontology/Harness pins through the pure root API; no latest-version selection. |
| Reviewed run plans | Preparing a pinned plan requires trusted material resolvers. Decisions bind its exact review digest. |
| Durable execution | A configured trusted executor receives one committed claim; uncertain outcomes are inspected and reconciled without redispatch. |
| Receipts and audit | SQLite persistence, revision checks and scoped idempotency retain evidence independently of evaluation or acceptance. |
| SDK and CLI | Strict TypeScript source, compiled ESM JavaScript and declarations; no runtime dependencies. |

The standalone CLI supplies no resolvers, executor or receipt inspector. Discovery, project/goal planning and state inspection do not need an execution provider. Run preparation requires resolvers; dispatch requires an executor. Missing providers fail explicitly. Installing Runtime alone does not configure coding work.

For the composed product and Codex entry, use [parent EvoPilot](https://github.com/yeliang-wang/evopilot) and its [releases](https://github.com/yeliang-wang/evopilot/releases). Integration and provider configuration belong to that separate distribution.

## Quickstart

Use Node **24.14.0** on a platform with OS uid support. SQLite is experimental. Source development uses the locked **TypeScript 5.9.3** compiler:

```sh
npm ci --ignore-scripts
npm run build
npm run check
npm test
node dist/cli.js help
node dist/cli.js version
node dist/cli.js capabilities
```

Build cleans only generated `dist`, emits JavaScript and declarations, then makes the CLI executable. Check verifies strict source types, package-export declarations, owned imports and pinned vendor bytes. Full tests create isolated workspaces. Discovery commands create no workspace.

### Install a release tarball

For v0.2.0 Preview, download `evopilot-next-runtime-0.2.0.tgz`, `source-revision.txt` and `SHA256SUMS` from the [Runtime release](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.2.0). In that download directory, verify the checksums and inspect the revision before installing into your consumer project:

```sh
shasum -a 256 -c SHA256SUMS
cat source-revision.txt
npm install --ignore-scripts /absolute/downloads/evopilot-next-runtime-0.2.0.tgz
npx --no-install evopilot-next-runtime help
```

The tarball includes compiled `dist`, declarations, owned TypeScript source, docs and retained vendor/provenance. It excludes development scripts and tests. Its `package.json` scripts are source-maintainer commands; release consumers import the compiled package or use the installed CLI. Runtime has no installed runtime dependencies or Runtime dependency-lock release asset. There is no npm registry publication.

### Use the TypeScript SDK

From an ESM consumer with NodeNext module resolution:

```ts
import { capabilities, VERSION } from '@evopilot-next/runtime';
import { createRuntimeService, type Scope } from '@evopilot-next/runtime/service';

console.log(VERSION, capabilities());
const scope: Scope = { visibility: 'private', projectId: 'example' };
const service = createRuntimeService({
  workspaceRoot: '/absolute/owned/workspace',
  workspaceId: 'example',
});
console.log(scope, service.capabilities());
service.close();
```

This example only inspects metadata. Construction and imports perform no filesystem operations. To persist projects and goals, choose an explicitly owned canonical workspace outside source/Git trees with an existing parent, then call `initialize()`. The [service API reference](docs/service.md) explains requests, revisions, trusted callbacks and recovery; the [CLI guide](docs/cli.md) includes complete project/goal examples.

The root also exports `PRODUCT`, `inspectPinnedInputs` and the `Reference` type. The service subpath exports `createRuntimeService` and request/result types. Public API behavior and the frozen asset v1 contract are preserved by this repair.

## Trust and Preview scope

Runtime assumes a non-malicious single OS uid and trusted code-injected adapters. It does not isolate hostile code running as that uid. Keep exact requests and receipts; an uncertain response is not permission to dispatch again. Read the [security policy](SECURITY.md).

Capability metadata describes generic service support, not configured providers. `hostIntegrationReady`, `acceptance`, `authority` and `softwareRelease` remain false. Source checks and CI are technical evidence independent of candidate-bound acceptance and release authority. Preview does not claim production readiness, GA, old 6.3 feature parity or arbitrary coding-agent support.

## Contributing and attribution

See [Contributing](CONTRIBUTING.md) for source checks and the parent gitlink workflow. Runtime is Apache-2.0 licensed; retained attributions are in [NOTICE](NOTICE) and [provenance](provenance/). Documentation layout draws inspiration from OpenHands with independently written content.
