# Contributing to Runtime

Keep changes within Runtime ownership and the agreed file scope. The v0.6.0 response scope preserves native v1 contracts and historical material while adding reviewed isolated execution and verification linkage; unrelated features need a separate reviewed scope.

## Source checks

Use Node 24.14.0 and the package lock's TypeScript 5.9.3:

```sh
npm ci --ignore-scripts
npm run build
npm run check
npm test
node dist/cli.js help
node dist/cli.js version
git diff --check
```

Build removes only generated `dist`, compiles strict TypeScript and sets the CLI executable bit. Check validates source types and a declaration consumer through the package's root and service exports, then verifies package metadata, owned imports and pinned vendor bytes. Build must precede check. Tests create isolated workspaces; do not point them at daily product state. A bounded task may reserve build/full tests for an operator when writes are restricted.

The release gate's focused tests are local and need no network:

```sh
node --test tests/e2e/release-gate.test.mjs
```

Installed release tarballs omit development scripts/tests; run these commands in a source checkout. Runtime has no runtime dependencies. Do not move compiler dependencies into runtime dependencies or add a Runtime dependency-lock release asset.

## Repository and parent workflow

Submit Runtime changes to [yeliang-wang/evopilot-runtime](https://github.com/yeliang-wang/evopilot-runtime). After the child commit passes its own source CI, a separately scoped change in [parent EvoPilot](https://github.com/yeliang-wang/evopilot) updates the `projects/evopilot-runtime` gitlink to that exact commit and runs parent integration/distribution checks. Do not copy sibling implementations into Runtime or use relative parent paths in public docs.

Preserve frozen vendor/specification bytes and provenance. Shared vendor regeneration belongs to the parent canonical generator. Release preparation binds a successful own-repository source CI run, exact commit and distribution digest. The parent consumes its exact CI ZIP without rebuilding. Tests, CI and PR review do not independently grant acceptance or publication authority.

Use your real Git identity, including your GitHub-provided noreply address when desired. Attribute actual contributions accurately; do not invent contributors or rewrite v0.1.0 history to alter attribution. Keep private evidence, credentials and daily data out of commits, issues and logs. See [SECURITY.md](SECURITY.md).

## Documentation consistency

`npm run check` includes `scripts/check-documentation.mjs`. Keep the README, documentation index, current changelog section and default installation examples aligned with `package.json`; retain explicitly historical version records. Run `node --test tests/e2e/documentation.test.mjs` for the gate regression cases. Source documentation updates do not replace existing tags or release archives.
