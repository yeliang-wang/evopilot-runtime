# Online repair candidates

Introduced in v0.5 and retained in the v0.7.0 Preview, the Runtime public service exposes `.online(envelope)`. A trusted `readOnlineFinding` provider reads the immutable record from Harness; caller-authored finding bodies or approval flags are not accepted.

| Operation | Input | Result |
|---|---|---|
| `online.inspect` | `{}` | Online revision and retained scoped repair candidates |
| `online.repair.ingest` | `{id}` (Harness finding ID) | Idempotent receipt binding the candidate ID and digest |
| `online.repair.inspect` | `{id}` (incident/candidate ID) | Candidate or `null` |
| `online.receipt.inspect` | `{requestId}` | Original mutation receipt |

Every envelope includes explicit `scope`. Ingest additionally requires `requestId` and current online `expectedRevision`. The parent supplies the trusted provider and reconciles a lost response by owner readback before retrying delivery. Standalone CLI operation configures no online providers.

A candidate has `status: REVIEW_REQUIRED`, `requestedVersion: null`, `softwareRelease: false` and `ontologyMutation: false`. Its immutable finding history is ordered by event time, retaining failure and recovery; a late older firing event cannot overwrite a newer resolved state. A candidate is review context, not an approved Target or Run. The user must decide the scope and change through the existing Runtime workflow. Warning alone never selects a patch version or starts a repair. In v0.6, [reviewed response execution](response.md) can bind this candidate to a published runbook and independently approved collection; ingestion itself still does not execute it.

Online records share protected owner SQLite state and snapshot integrity, using database marker 4. Feedback/native writes cannot downgrade it. Older readers must reject it. Stop the independent online worker before backup, relocation or rollback; preserve credentials separately if their files are outside protected state. See [the parent operation guide](https://github.com/yeliang-wang/evopilot/blob/main/docs/online-harness.md).
