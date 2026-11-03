# Project contract v1

This is EvoPilot's project composition convention. RDF/Turtle and SHACL are
Ontology's native formats; Rego and Conftest are Harness's native formats.
The project contract does not replace either owner's standard or grant approval.

`base-requirements.json` fixes the project checks. `directory-layout.json` fixes
the editable project layout. Every file here participates in the project standard
digest. Same-name v1 content with a different digest requires a new review.

## Source and independent scope

Reverse onboarding inventories every tracked regular file of an exact clean Git
HEAD, verifies each blob identity and records all recognized build modules. Use
an isolated checkout for an earlier commit; never reset the business repository.
Symlinks and submodules are explicitly unsupported in this version. Forward
onboarding inventories every regular file in a dedicated requirements snapshot;
it does not imply implemented software or production readiness.

Freeze the requirements before generating assets. Each owner requirement has an
ID, a fixed nonempty set of case IDs, origin, description and source file IDs.
Every discovered module is included with requirements or excluded with a reason.
Capability and exclusion records are explicit. Public/private visibility uses the
same checks and does not authorize upload.

Each asset source binding identifies the actual inventory path, revision, full
file digest and packaged source bytes. Every mapping identifies its requirement,
target, source, observed/inferred status and a precise line range or JSON pointer.
The fragment digest is recomputed from actual source bytes. Inferred mappings
require rationale and must appear in the exact domain review.

For each owner requirement, the set of source paths reached by its mappings must
equal that requirement's frozen `sourceIds`. Including a file in the inventory
or package does not establish this link. Missing links and mappings to additional,
unreviewed sources fail with `PROJECT_SOURCE_COVERAGE`, even when all native
rule cases pass. Each mapping must identify a target, source fragment and modeling
rationale; creating arbitrary links to satisfy the set is not semantic acceptance.
Correcting these links changes the package and review digests and requires a new
candidate and domain review. Historical deliveries and decisions remain unchanged.

## Candidate isolation and validation

Before completion, each candidate lives at
`campaigns/native-v1/<candidateId>/project/`, using the same directory layout as a
current project. Preparation and materialization cannot replace the root README,
root project manifest, historical campaign or current assets. A second round has
a distinct candidate ID and immutable protected records. Changing a staged file
invalidates its validation; changing source requires a new source review.

Protected state retains the independent scope, native package bytes, source
bindings and domain decisions outside the editable workspace. Layout checks
compare every actual asset file with its native manifest and reject extra,
missing, substituted or stale bytes. Owner cases must exactly match the frozen
requirement case sets; one passing result cannot stand in for the whole set.

Project validation reports five checks: inventory, directory, manifest, bindings
and coverage. Domain acceptance is a separate required check. It remains UNKNOWN
until an actual ACCEPT decision binds the exact Runtime candidate, both package
digests, source bindings and all inferred mappings. A technical test, a draft
asset or an implementation authorization cannot supply that domain decision.

Only a verified Runtime completion may authorize a later current-delivery
transition. Candidate materialization is not that transition, publication or
production certification. Historical records retain their original standard
identity and cannot certify corrected-v1 conformance.
