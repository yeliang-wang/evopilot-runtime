# Runtime CLI

The `evopilot-next-runtime` bin targets `dist/cli.js`. In a source checkout use `node dist/cli.js`; first run `npm ci --ignore-scripts` and `npm run build` to compile the TypeScript source. Use Node 24.14.0 on a platform with OS uid support. The CLI needs no network or credentials and does not select a workspace from the current directory or environment.

Start with `node dist/cli.js help` or `node dist/cli.js capabilities`; these do not create state. For project and goal operations, choose an explicit owned workspace outside source/Git trees. For native quality or business validation, use the separately distributed [parent EvoPilot Preview product entry](https://github.com/yeliang-wang/evopilot): it supplies published Ontology/Harness resolvers and execution/receipt inspection. The standalone CLI supplies none of those providers. No arbitrary coding agent, new LLM or credential adapter is configured in Preview.

```text
evopilot-next-runtime help
evopilot-next-runtime version
evopilot-next-runtime capabilities
evopilot-next-runtime request --workspace <canonicalAbsoluteRoot> --workspace-id <slug> [--request-file <absoluteJSONpath>]
```

`--help` and `--version` are aliases. Discovery commands and module imports are read-only and need no workspace. Unknown commands, extra arguments, duplicate/unknown flags, missing values and relative workspace/file paths are rejected. Workspace IDs and request IDs are lowercase slugs of at most 64 characters. The workspace root must be explicit, canonical, outside source/Git trees, and satisfy the existing service ownership/identity rules. Its parent must exist. Symlink workspace ancestors are rejected by the service. There is no default workspace or automatic revision refresh.

`request` consumes exactly one UTF-8 JSON value from stdin, or from the explicit regular file when `--request-file` is supplied (stdin is then ignored). The byte limit is 524288, depth limit 48 and node limit 20000, as reported by capabilities. Files are checked before and after a no-follow, nonblocking open; symlinks, directories, missing files, file replacement and oversized input fail. Data must contain no accessors or non-JSON values. Known operation, exact envelope, scope and closed input validation precede service initialization. Valid requests, including inspections, explicitly initialize the workspace; discovery commands do not.

Read envelope:

```json
{"operation":"workspace.inspect","scope":{"visibility":"public","projectId":"alpha"},"input":{}}
```

Write envelope (first request in a new workspace):

```json
{"operation":"project.create","scope":{"visibility":"public","projectId":"alpha"},"input":{"name":"Alpha"},"requestId":"create-project","expectedRevision":0}
```

Submit that JSON on stdin using the installed bin or, in this checkout:

```sh
node dist/cli.js request --workspace /absolute/owned/workspace --workspace-id example <<'JSON'
{"operation":"project.create","scope":{"visibility":"public","projectId":"alpha"},"input":{"name":"Alpha"},"requestId":"create-project","expectedRevision":0}
JSON
```

Replace the illustrative path with a canonical owned workspace whose parent exists. This command explicitly initializes storage. If the workspace already exists, inspect its revision before a new write. After this fresh workspace reaches revision 1, create a goal by submitting:

```json
{"operation":"goal.create","scope":{"visibility":"public","projectId":"alpha"},"input":{"id":"goal","description":"Evaluate a synthetic instance"},"requestId":"create-goal","expectedRevision":1}
```

All envelopes are closed: writes require exactly `operation`, `scope`, `input`, `requestId`, `expectedRevision`; reads require exactly the first three. Revisions are nonnegative safe integers. Scope is exactly `{visibility,projectId}`, with `visibility` public/private and the existing Runtime project slug rules unchanged. No operation grants cross-scope access.

| Operation | Exact input fields | Write |
| --- | --- | --- |
| `workspace.inspect` | none | no |
| `receipt.inspect` | `requestId` | no |
| `project.create` | `name` | yes |
| `project.inspect`, `project.list` | none | no |
| `goal.create` | `id`, `description` | yes |
| `goal.inspect` | `id` | no |
| `goal.list`, `run.list` | none | no |
| `run.prepare` | `id`, `goalId`, `ontology`, `harness`, `input` | yes |
| `run.inspect` | `id` | no |
| `run.decide` | `id`, `reviewDigest`, `humanEvidenceRef`, `decision` | yes |
| `run.cancel` | `id`, `reviewDigest`, `humanEvidenceRef` | yes |
| `run.dispatch`, `run.reconcile` | `id` | yes |

Names, descriptions and human evidence references are nonempty trimmed text. IDs are slugs. Review digests are exact `sha256:` plus 64 lowercase hex digits. Decisions are explicitly `APPROVE` or `REJECT`. Prepare requires exact six-field immutable Ontology/Harness references and the closed native `runtime-composition/v1` payload documented in the [service contract](service.md): `ontologyInstance` contains entity/relation arrays; `harness` contains `mode`, `evidence`, `configuration`. CLI validation does not broaden the service API or supply missing authorization.

Async dispatch uses the same closed envelope:

```json
{"operation":"run.dispatch","scope":{"visibility":"public","projectId":"alpha"},"input":{"id":"run"},"requestId":"dispatch-run","expectedRevision":4}
```

Use `run.reconcile` with its own explicit request ID and observed revision to inspect an existing claim. The CLI maps these two operations to the existing async service methods with exactly `{scope,id,requestId,expectedRevision}`; all other operations use `execute(request)`. It never automatically prepares, approves, cancels, retries, refreshes revisions or redispatches an uncertain response. Preserve exact requests and receipts. An identical scoped request ID/input returns the retained receipt; altered input conflicts; stale new writes fail CAS. Consult `receipt.inspect` and `run.inspect` before choosing an explicit next request. Service-owned async completion behavior remains unchanged.

The standalone CLI configures no resolvers, executor or receipt inspector. A valid prepare needing material resolution returns `MISSING_RESOLVER`; dispatch needing an executor returns `MISSING_EXECUTOR`. Earlier state/scope/CAS failures still apply. Reconciliation never invokes an executor; an unresolved existing claim without a receipt provider remains unknown under the service contract. There is no global fallback, provider flag or request-configurable callback. Parent Preview composition supplies its own trusted providers; it does not inject them into this standalone bin. The CLI's static `pending` capability labels describe its standalone integration limits, not the current parent technical verification status.

Every response is one JSON line on stdout. Success is `{ok:true,product:"runtime",version:"0.1.1",result,authority:false}`. Errors are `{ok:false,error:{code,message},authority:false}` with a fixed safe code allowlist and generic text; original exception messages, paths and request excerpts are never echoed in errors. Successful service data follows its existing contract. Exit status is 0 for success, 2 for argument/input failure, 1 for service failure. Node may emit its experimental SQLite warning on stderr.

Validation, schema correctness, provider registration and successful commands establish no approval, acceptance, release authority, production readiness or Host PASS. Final Desktop E01–E19 acceptance remains separate in the candidate-bound report. See the [service verification scope](service.md) for validation limits. Source developers run `npm ci --ignore-scripts`, `npm run build`, `npm run check` and `npm test` in that order; full tests create isolated service workspaces. These development commands are unavailable in installed tarballs, which omit scripts and tests.

Return to the [product entry](../README.md) or read the [approved roadmap](roadmap.md).
