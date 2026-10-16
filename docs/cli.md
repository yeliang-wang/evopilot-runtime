# Runtime CLI

Use Node 24.14.0 or later. The installed executable is `evopilot-next-runtime`; from a source checkout run `npm ci --ignore-scripts`, `npm run build`, then `node dist/cli.js`. Discovery commands do not initialize storage:

```text
evopilot-next-runtime help
evopilot-next-runtime version
evopilot-next-runtime capabilities
evopilot-next-runtime native-request --workspace <canonicalAbsoluteRoot> --workspace-id <slug> [--request-file <absoluteJSONpath>]
evopilot-next-runtime request --workspace <canonicalAbsoluteRoot> --workspace-id <slug> [--request-file <absoluteJSONpath>]
```

`--help` and `--version` are aliases. Unknown commands, duplicate/unknown flags, extra arguments and relative paths fail. There is no implicit Workspace from the cwd or environment and no automatic revision refresh.

## Native requests

Use `native-request` for the corrected native API. Submit one UTF-8 JSON value on stdin, or an explicit regular file using `--request-file`. The CLI input limit is 524288 bytes, even though the embedded native service supports a larger 2 MiB envelope. Files are checked around a no-follow open. Missing, linked, replaced, nonregular and oversized input fails. Explicit valid requests initialize the Workspace; discovery does not.

```sh
node dist/cli.js native-request --workspace /absolute/owned/workspace --workspace-id example <<'JSON'
{"operation":"workspace.inspect","scope":{"visibility":"private","projectId":"example"},"input":{}}
JSON
```

Replace the path with an owned canonical Workspace outside all source/Git trees. Native initialization creates its database identity and returns its own revision. Read envelopes have exactly `operation`, `scope`, `input`. Native writes additionally require an explicit immutable `requestId` and the observed `expectedRevision`:

```json
{"operation":"collection.execute","scope":{"visibility":"private","projectId":"example"},"input":{"id":"collection-1"},"requestId":"execute-collection-1","expectedRevision":3}
```

This illustrates the envelope only: the exact candidate must already exist and be approved, and a trusted collector must be configured. IDs use lowercase slugs; scope is exactly `{visibility:'public'|'private',projectId}`. [The service operation table](service.md#current-public-api) lists every native request and its fields. Public TypeScript exports provide `NativeRequest`, recipes, source scope, references, provider callbacks and receipt types.

The standalone CLI supplies **no** native standard pins, source/requirement readers, collector, owner resolver or executor. It can inspect existing native state, but it cannot perform the full collection and validation workflow by itself. Missing trusted providers fail closed. Use the parent EvoPilot integration or embed `createRuntimeService` with trusted construction-time providers. There is no request-configurable callback or arbitrary provider URL.

Preserve request IDs and receipts. An identical request returns its retained receipt; altered input conflicts. After an interrupted call, inspect `collection.inspect` or `run.inspect`. Reconcile the existing claim instead of launching again. An unavailable receipt stays UNKNOWN. Never replace an UNKNOWN claim with a new request intended to repeat the same work.

## Historical requests

`request` remains the historical synchronous envelope/async reconciliation adapter. It can inspect retained state and receipts and retains existing project/goal administration and original-claim recovery. New historical `run.prepare`, `run.decide` and `run.dispatch` return `HISTORICAL_READ_ONLY`; use the current native API. Six-field historical references and old JSON validation results do not meet the corrected native standard. Historical and native revision counters are separate: use the corresponding `workspace.inspect` command.

## Output and verification

Every response is one JSON line on stdout. Success is `{ok:true,product:'runtime',version:<installed version>,result,authority:false}`. Errors use `{ok:false,error:{code,message},authority:false}` with a safe code and generic message; original exception text, paths and request excerpts are not echoed. Exit status is 0 for success, 2 for input/usage failure and 1 for service failure. Node can emit its experimental SQLite warning on stderr.

A successful command or execution does not imply owner quality PASS, project completion, Desktop acceptance or release authority. These checks are separate in the [service contract](service.md). Source maintainers verify with `npm run build`, `npm run check` and `npm test`; installed tarballs omit tests and build scripts.

Return to the [product entry](../README.md) or the [approved roadmap](roadmap.md).
