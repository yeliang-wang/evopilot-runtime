# Project lifecycle configuration

For a first-use installation with Workspace setup tools, inspect the protected
selection using `evopilot_v01_workspace_inspect`. Initialization uses
`evopilot_v01_workspace_initialize` with a stable `requestId`; omitted roots use
the explicit installation selection. To attach existing data, use
`evopilot_v01_workspace_attach` with `projectRoot`, `stateRoot`, `workspaceId` and
`requestId`. The roots must match that selection; a different location requires
an actual operator configuration, not a guessed path or edited connection file.

The local operator stops the selected service, preserves the original backup,
prepares and binds the Workspace, then applies the installation's selected
running/stopped state. It never activates this session or starts business work.
After a running result, discover the refreshed tools and call
`evopilot_v01_activate` before original owner calls. The same Host session can
continue without reopening Dashboard or installing a second plugin. A stopped
result requires explicit operator startup before activation. Keep the original
request after interruption; do not replace its ID or reset its journal. A
completed replay is historical and does not prove fresh environment validity.

Continue below for Project Lifecycle configuration; Workspace binding does not
supply missing lifecycle fields, asset decisions or execution authority.

Read `lifecycle.base.inspect` and `lifecycle.definition.inspect` for the selected
project. The returned publisher pin, field policies, stages, slots and registered
action digests are authoritative. Read an existing exact revision with
`lifecycle.definition.read` and its complete paged YAML with
`lifecycle.definition.source.read`. Preserve custom values and presentation.

Before formal execution, establish the user's project, goal, loop and target:
purpose, intended version, scope, exclusions, source baseline and acceptance.
Reuse clear retained choices. Source code, PDF/design documents and published
assets can inform a proposal, but do not invent a human purpose or an approval.

Guide the user through unresolved settings in stage order. Explain what each
missing item controls. The server's current Base fields and validation issues
determine the complete list; this summary is not a substitute for that list:

| Stage | Information to resolve |
| --- | --- |
| scope | Project/scope and source bindings, published Ontology/Harness assets and mappings |
| plan | Preparation documents, requirements, review policy and bounded execution budget |
| implementation | GitHub or GitLab repository, branch, CI workflow/pipeline, runner, credential reference, exact Codex/Host/workspace binding and required checks |
| candidate | Build workflow and immutable candidate/artifact contract |
| verification | Candidate verification workflow, required checks, complete evidence mappings and native evaluations |
| release-decision | Exact reviewer/evidence policy and required release/technical/migration documents |
| publication | Controlled publication workflow, release channel and credential reference |
| closure | Delivery mode, original artifact readback, acceptance/smoke policy, feedback and retained archive |

Only GitHub and GitLab are supported. Required fields are mandatory for an active
definition. Missing, placeholder, unsupported, expired or inaccessible bindings
leave it a draft. Ask for connection/configuration names or credential references,
never raw secrets in chat or YAML. Protected operator registration supplies real
provider/owner/Agent capabilities; inventing a reference string does not create
one. No Runtime model account is needed.

Project customizations stay within Base policies: allowed values, stricter
budgets/checks and registered actions in the four slots. Dependencies inside a
slot form an acyclic graph and all required branches join. Project-to-project
inheritance, multiple Bases, arbitrary commands/providers, skipped core gates and
cross-slot reordering are unavailable. Graph layout belongs to presentation;
moving a node visually cannot change a protected dependency.

Use `lifecycle.definition.validate` with `{yaml}`. Present the proposed effective
configuration and unresolved field/node issues. To retain an incomplete edit,
use `lifecycle.draft.save`. Once the user's actual configuration intent is clear
and the current validation returns `ready: true`, call
`lifecycle.definition.save-and-activate` with the exact `{yaml, validationDigest}`
and a fresh mutation envelope. Alternatively activate a saved exact revision
using its supported revision/digest fields. On a genuine conflict, read current
state and preserve the draft; do not overwrite another client's changes.

Read back `lifecycle.definition.inspect`, the active revision and its compiled
definition. Activation changes only the project definition. It does not create
an instance, start coding/CI, approve assets or authorize a software release.
The user can complete this same unit in Dashboard's graph/YAML editor; do not
force them back to Codex for a second definition approval. The monitor is
read-only and does not expose editing or business action controls.

An imported legacy project/goal/asset-validation Run is historical domain data;
it does not supply missing lifecycle settings or become an active definition.
If the service reports a legacy binding, its original records can inform the
wizard. Keep their scopes, IDs and receipt meanings intact. The separate
`runtime.legacy.*` transport uses its original family revision; new lifecycle
mutations continue using the current project revision from this service.
