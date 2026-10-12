# EvoPilot Runtime 0.1.0

Runtime currently exposes `inspectPinnedInputs({ ontology, harness, observedOntology, observedHarness })`, which verifies exact immutable Ontology and Harness references through its own pinned compatibility module. It never selects a latest version or executes work. See the [owned reference implementation](src/index.mjs), [vendor contract](vendor/compatibility/v1/reference.mjs), [pin manifest](vendor/compatibility/v1/manifest.json) and boundary tests (`tests/e2e/reference.test.mjs` in a source checkout).

All root APIs also expose `PRODUCT`, `VERSION` and `capabilities()`. Readiness remains false and reports convey no acceptance, execution or publication authority. Persistent lifecycle/services, workspace integration, CLI/MCP and unified Expert/plugin delivery remain under construction. This source is not stable 1.0 or production-ready, and does not establish M1 or full acceptance.

Use Node 24.14.0. This source checkout has no dependencies and needs no install. Run:

```sh
npm run check
npm run build
npm test
```

Build verifies owned ESM sources and pinned vendor bytes; it needs no parent generator or sibling source. Only the parent canonical build regenerates vendor bytes. The same commands work in an unrelated standalone source copy. Installed tarballs omit development scripts/tests; these commands apply to source checkouts. Earlier specification guides describing a parent-first build refer to vendor regeneration, not a prerequisite for validating an existing pinned copy.

Read the [current roadmap](docs/roadmap.md). Final remote URL metadata and GitHub execution remain pending authorization. Local artifact rehearsal is technical evidence only. Licenses and provenance retain their existing ownership.
