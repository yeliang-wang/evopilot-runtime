# Runtime roadmap

The [v0.1.1 Preview](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.1.1) edition refines source delivery, packaging and documentation. [v0.1.0 Preview](https://github.com/yeliang-wang/evopilot-runtime/releases/tag/v0.1.0) is the historical baseline.

## Existing behavior

Runtime provides scoped projects, immutable goals, exact Ontology/Harness pins, reviewed plans, human decisions, SQLite WAL/FULL persistence, revision CAS, idempotent receipts and atomic audit. Dispatch commits one durable claim before invoking trusted code. Uncertain execution is inspected and reconciled without redispatch. See the [service API](service.md).

The [standalone CLI](cli.md) provides discovery, bounded JSON requests and explicit workspace initialization. Project/goal planning and inspection need no execution provider. Preparing a run requires trusted material resolvers; execution and receipt inspection require their respective callbacks. The standalone bin configures none of these providers. [Parent EvoPilot](https://github.com/yeliang-wang/evopilot) documents composition and the Codex entry separately.

## Current repair

v0.1.1 covers strict TypeScript, compiled JavaScript/declarations, source and release packaging, public documentation, repository links and factual contributor attribution. Public API behavior, frozen asset v1 contracts, vendor/provenance and historical code remain preserved. No new feature scope or daily-state migration is added.

## Future targets and limits

Collect reproducible feedback within the existing 0.1.x scope and use it to prioritize follow-up repairs. Broader features and daily-state migrations require a separate scope. Parent integration and Codex composition remain owned by [parent EvoPilot](https://github.com/yeliang-wang/evopilot).

Build, test, distribution and candidate-bound acceptance evidence is retained separately from this roadmap. Preview does not claim production readiness, GA, old 6.3 feature parity or arbitrary coding-agent support. Capability metadata carries no acceptance or release authority.

Return to the [documentation index](README.md) or [product entry](../README.md).
