# EvoPilot Runtime 0.1.0

Runtime currently exposes `inspectPinnedInputs({ ontology, harness, observedOntology, observedHarness })`, which verifies exact immutable Ontology and Harness references through its own pinned compatibility module. It never selects a latest version or executes work. See the [owned reference implementation](src/index.mjs), [vendor contract](vendor/compatibility/v1/reference.mjs), [pin manifest](vendor/compatibility/v1/manifest.json) and boundary tests (`tests/e2e/reference.test.mjs` in a source checkout).

The `./service` subpath now exposes `createRuntimeService({workspaceRoot,workspaceId}, trustedProviders)` for the M2 durable project/goal/run boundary. It supports explicit initialization, pinned preparation, human decisions, one durable execution claim, and receipt reconciliation. See the [service API and composition envelope](docs/service.md). Construction is pure; SQLite persistence starts only at initialization.

All root APIs also expose `PRODUCT`, `VERSION` and `capabilities()`. The original pure API remains unchanged. Readiness remains false and reports convey no acceptance or publication authority. Shared transport, actual product composition adapters, MCP and unified Expert/Codex delivery remain M3 work. Node SQLite is experimental; this service assumes one trusted OS user. This source is not stable 1.0 or production-ready and does not establish full acceptance.

The owned `evopilot-next-runtime` CLI exposes pure help/version/capabilities and one bounded JSON request against an explicit workspace and revision. Run `node src/cli.mjs help` from this checkout; see the [complete CLI contract](docs/cli.md). External providers remain pending parent M3 wiring. CLI results infer no authorization or acceptance.

Use Node 24.14.0. This source checkout has no dependencies and needs no install. Run:

```sh
npm run check
npm run build
npm test
```

Build verifies owned ESM sources and pinned vendor bytes; it needs no parent generator or sibling source. Only the parent canonical build regenerates vendor bytes. The same commands work in an unrelated standalone source copy. Installed tarballs omit development scripts/tests; these commands apply to source checkouts. Earlier specification guides describing a parent-first build refer to vendor regeneration, not a prerequisite for validating an existing pinned copy.

Read the [current roadmap](docs/roadmap.md). Final remote URL metadata and GitHub execution remain pending authorization. Local artifact rehearsal is technical evidence only. Licenses and provenance retain their existing ownership.
