# Readable API in the v0.7.0 Preview

The public service adds `readable(request)` with explicit project scope. Operations are `readable.list`, `readable.snapshot`, `readable.query`, `readable.export` and (asset owners only) `readable.compare`. Construction remains pure; initialize private owner state explicitly. Reads do not grant mutation, semantic approval or software release authority.

Snapshot/query/export share exact digest-bound evidence and the original denominator. Missing evidence stays UNKNOWN or MISSING. Native standards/v1 and historical records are unchanged.

Runtime snapshots use native project `id` and optional `runId`; the completed Run is the default when available. Planning linkage is separate from execution approval. New planning writes use schema marker 6, which old readers reject.

Queries accept `limit` (1–200), `search`, `kind`, `verdict`, `expectedDigest` and a digest-bound `cursor`. Exports require `format` (json, markdown or html) and `expectedDigest`. Comparisons require exact `beforeVersion` and `afterVersion`; they never assert business semantic equivalence.

Asset comparisons accept optional `query.limit` (default 10, maximum 50) and `query.cursor`. Follow `nextCursor` to null, retaining `comparisonDigest`, both exact snapshot pins, fixed before/after denominators, `totalChanges`, `returnedChanges` and `offset`. The comparison body is at most 12 KiB before its small owner/transport envelope; fewer rows may be returned. Original rows remain complete in `changes`; verbose detail values appear as hashes in the table. A single oversized row raises `READABLE_LIMIT`, not a truncated success. A cursor for a changed snapshot pair raises `READABLE_SNAPSHOT_DRIFT`. Runtime does not support asset-version comparison.
