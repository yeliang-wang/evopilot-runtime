/** Canonical v0.2 Expert use cases. This describes evidence requirements, never an acceptance verdict. */
export type ScenarioId = `V02-${'A' | 'B' | 'C' | 'D'}${string}`;
export type GuideName = 'onboarding' | 'ontology-forward' | 'ontology-reverse' | 'harness-quality' | 'runtime-handoff' | 'recovery' | 'retained-ontology';
export interface ExpertScenario {
  id: ScenarioId;
  title: string;
  guide: GuideName;
  preconditions: readonly string[];
  prompts: readonly string[];
  operations: readonly string[];
  expectedOutputs: readonly string[];
  unchanged: readonly string[];
  automatedTests: readonly string[];
  requiredBranches: readonly string[];
  desktopEvidence: {
    required: true;
    observations: readonly string[];
    configuredProviderPositive?: 'synthetic-automated-only';
  };
}

const integration = (name: string): string => `integration/e2e/${name}.test.mjs`;
const owner = (name: string, file: string): string => `projects/evopilot-${name}/tests/e2e/${file}.test.mjs`;
const nativeTests = [integration('expert-products'), owner('ontology', 'service'), owner('harness', 'service')];
const retained = (file: string): readonly string[] => [owner('ontology', file)];
const scenario = (
  id: ScenarioId, title: string, guide: GuideName, preconditions: string[], prompts: string[],
  operations: string[], expectedOutputs: string[], unchanged: string[], automatedTests: readonly string[],
  requiredBranches: string[], desktop: string[], configuredProviderPositive?: 'synthetic-automated-only',
): ExpertScenario => ({ id, title, guide, preconditions, prompts, operations, expectedOutputs, unchanged,
  automatedTests, requiredBranches, desktopEvidence: { required: true, observations: desktop,
    ...(configuredProviderPositive ? { configuredProviderPositive } : {}) } });

const definitions: ExpertScenario[] = [
  scenario('V02-A01', 'Passive ordinary chat and help', 'onboarding',
    ['No active session; Workspace may be absent.'], ['Explain EvoPilot without starting it.', 'Only reply OK; do not call tools.'],
    ['evopilot_v01_guide'], ['Guide available without a configured Workspace.', 'Ordinary chat has no product calls.'],
    ['No Workspace, daemon or service state is created.'], [integration('plugin'), integration('expert-catalogue')],
    ['passive-help', 'ordinary-chat'], ['Actual unselected ordinary chat and selected informational request stay passive.']),
  scenario('V02-A02', 'Initialize a personal Workspace', 'onboarding',
    ['Installed product; no bound Workspace; no GitHub account required.'], ['Start using EvoPilot and create my Workspace.'],
    ['evopilot_v01_workspace_inspect', 'evopilot_v01_workspace_initialize', 'evopilot_v01_activate'],
    ['User project with README, synthetic examples and private folders.', 'Separate protected state and durable installation binding.'],
    ['Installation inventory and existing user data are not overwritten.'], [integration('workspace-bootstrap')],
    ['default-path', 'explicit-path', 'idempotent-request', 'concurrent-request', 'occupied-path'],
    ['Unbound installation initializes through dialogue, then activates the same session.']),
  scenario('V02-A03', 'Attach an existing Workspace', 'onboarding',
    ['An initialized project and matching state exist.'], ['Connect my existing EvoPilot Workspace.'],
    ['evopilot_v01_workspace_inspect', 'evopilot_v01_workspace_attach', 'evopilot_v01_activate', 'workspace.inspect'],
    ['Verified original identity and readable project/history.'], ['Existing assets, receipts and workspace identity remain unchanged.'],
    [integration('workspace-bootstrap')], ['existing-binding', 'identity-mismatch', 'incompatible-format', 'no-hot-switch'],
    ['Reconnect in a fresh session and read retained state.']),
  scenario('V02-A04', 'Activate, reuse and deactivate a chat', 'onboarding',
    ['Workspace is bound.'], ['Open EvoPilot in this chat.', 'Stop using EvoPilot in this chat.'],
    ['evopilot_v01_inspect', 'evopilot_v01_activate', 'evopilot_v01_deactivate'],
    ['Verified shared connection; separate session activation.'], ['Deactivating or closing one chat does not terminate peer sessions or daemon.'],
    [integration('connection-products'), integration('plugin')], ['start', 'reuse', 'session-isolation', 'deactivate'],
    ['Two real chats share a verified connection but retain independent activation.']),
  scenario('V02-A05', 'Run first-user forward and reverse examples', 'onboarding',
    ['Workspace initialized; examples explicitly identified as synthetic.'], ['Run the forward example.', 'Run the reverse example without changing its source.'],
    ['asset.put', 'asset.review', 'asset.decide', 'asset.publish', 'run.prepare', 'evopilot_v01_dispatch'],
    ['Documented expected outputs, source bindings, published assets and retained results.'],
    ['Real projects remain isolated; synthetic decisions confer no business authority.'],
    [integration('expert-products'), integration('workspace-bootstrap')], ['forward-example', 'reverse-example', 'example-isolation'],
    ['Follow only installed README and example instructions to inspect actual resulting artifacts.']),
  scenario('V02-A06', 'Choose project and public/private assets', 'onboarding',
    ['Active capabilities and exact project scope are known.'], ['Use this public asset in my private project; keep other projects separate.'],
    ['project.list', 'project.inspect', 'asset.list', 'asset.inspect'],
    ['Exact project scope and immutable references; unsupported required extensions refused.'],
    ['No automatic upload or foreign private-material consumption.'],
    [integration('expert-products'), integration('composition-products'), owner('ontology', 'specification')],
    ['public-consumption', 'private-isolation', 'required-extension-refusal'], ['Read the selected project and show a refused foreign private reference.']),
  scenario('V02-A07', 'Explain active versions, locations and results', 'onboarding',
    ['Workspace may be unbound, inactive or active.'], ['Which Workspace, product versions, asset versions and last Run am I using?'],
    ['evopilot_v01_workspace_inspect', 'evopilot_v01_inspect', 'evopilot_v01_capabilities', 'asset.inspect', 'run.inspect'],
    ['Exact installation and Workspace locations; drafts distinguished from published pins; separate result dimensions.'],
    ['No credentials, inferred latest pins, mutation or activation for passive identity inspection.'],
    [integration('workspace-bootstrap'), integration('expert-products')], ['unbound', 'inactive', 'active-readback'],
    ['Compare explanation against current identity and retained owner-returned records.']),
  scenario('V02-B01', 'Model forward from requirements', 'ontology-forward',
    ['Authorized requirements with confirmed and unresolved semantics separated.'], ['Model these requirements and show unresolved business questions before publication.'],
    ['asset.put', 'asset.review', 'asset.inspect'], ['Native v1 draft with forward provenance and pending required semantics.'],
    ['No invented source facts or approval.'], nativeTests, ['resolved-draft', 'pending-business-gap'],
    ['Inspect forward draft and evidence of a blocked unresolved publication.']),
  scenario('V02-B02', 'Extract from an existing project revision', 'ontology-reverse',
    ['User grants read access to an exact source revision and file scope.'], ['Extract Ontology and Harness from this revision without editing the project.'],
    ['asset.put', 'asset.review', 'asset.inspect'], ['Reverse provenance with source locators, revision/digests and observed versus inferred mappings.'],
    ['Source bytes, HEAD and tags; production meaning is not inferred as confirmed.'],
    [integration('expert-products'), owner('ontology', 'specification'), owner('harness', 'specification')],
    ['source-observed', 'inferred-gap', 'source-read-only'], ['Actual authorized source read, preserved baseline and reviewed extraction.']),
  scenario('V02-B03', 'Review, decide and publish an asset', 'ontology-forward',
    ['Exact current owner review and actual human decision evidence.'], ['Review this draft, record my decision, then publish the approved version.'],
    ['asset.review', 'asset.decide', 'asset.publish', 'asset.inspect'], ['Immutable delivery tied to the current review and decision.'],
    ['Changed drafts cannot reuse approval; rejected or undecided assets cannot publish.'], nativeTests,
    ['approve', 'reject', 'review-invalidated', 'immutable-version'], ['Human decision and publication are distinct, with owner receipts.']),
  scenario('V02-B04', 'Evaluate real supplied quality evidence', 'harness-quality',
    ['Rules, applicability, inputs and available reports are explicit.'], ['Evaluate this evidence and show missing reports and warnings.'],
    ['asset.evaluate', 'evaluation.inspect'], ['Rule-level results; missing evidence INDETERMINATE with Warning.'],
    ['No automatic action, software version bump or publication from Warning.'],
    [integration('expert-products'), owner('harness', 'specification'), owner('harness', 'composed-service')],
    ['pass', 'fail', 'warning', 'missing-report'], ['Read actual report with missing or failing evidence and unchanged versions.']),
  scenario('V02-B05', 'Hand exact deliveries to Runtime', 'runtime-handoff',
    ['Published Ontology/Harness pins and project goal; exact review decision.'], ['Prepare the goal with these exact pins, show the review and dispatch after my decision.'],
    ['project.create', 'goal.create', 'run.prepare', 'run.inspect', 'run.decide', 'evopilot_v01_dispatch'],
    ['Immutable inputs and pins; execution, quality and business results shown separately.'],
    ['Prepare does not dispatch; Runtime does not perform arbitrary coding or deployment.'],
    [integration('composition-products'), owner('runtime', 'execution')], ['prepare-only', 'decision-required', 'dispatch', 'separate-outcomes'],
    ['Actual prepared Run, human decision, dispatch and separate result readback.']),
  scenario('V02-B06', 'Reconcile a changed source baseline', 'ontology-reverse',
    ['Previous source manifest and delivery association; newly authorized source revision.'], ['The project changed. Compare the baseline and update or justify reuse of its assets.'],
    ['evopilot_v01_workspace_project', 'asset.inspect', 'asset.put', 'asset.review', 'asset.decide', 'asset.publish', 'run.prepare'],
    ['Checkpoint drift classification and explicit impact/reuse decision; new deliveries when needed.'],
    ['Old pins and Runs remain unchanged; no background real-time synchronization claim.'],
    [integration('expert-products'), integration('workspace-project')], ['unchanged-baseline', 'changed-baseline', 'new-version', 'retained-old-run'],
    ['Compare two source revisions, record impact and verify previous delivery remains readable.']),
  scenario('V02-B07', 'Resume and close private Goal/Target/Loop work', 'runtime-handoff',
    ['Private campaign ledger identifies native project/Goal/Run and documentary Target/Loop.'], ['Continue this Target from its last Loop; close it only when every required check has evidence.'],
    ['evopilot_v01_workspace_project', 'project.inspect', 'goal.inspect', 'run.inspect', 'receipt.inspect'],
    ['Private progress ledger linked to owner receipts; incomplete work remains open.'],
    ['No invented native Target/Loop completion API; product repository remains unchanged.'],
    [integration('workspace-project')], ['resume', 'incomplete-evidence', 'complete-evidence', 'product-source-unchanged'],
    ['Fresh chat resumes retained private ledger and checks evidence before closure.']),
  scenario('V02-C01', 'Import structured assets and derive native drafts', 'retained-ontology',
    ['Explicitly authorized supported JSON/YAML input, not arbitrary repository source.'], ['Import this structured asset and show its raw source before deriving a draft.'],
    ['legacy.import', 'source.inspect', 'legacy.derive'], ['Raw material and provenance retained; unsupported documents quarantined.'],
    ['Historical approval and lifecycle labels do not become current authority.'], retained('import-service'),
    ['supported-import', 'quarantine', 'derived-pending-draft'], ['Import a synthetic structured asset and read source plus derived draft.']),
  scenario('V02-C02', 'Inspect, validate and compare stored sources', 'retained-ontology',
    ['Scoped stored source IDs.'], ['Validate these stored Ontology sources and show their structural differences.'],
    ['ontology.inspect', 'ontology.validate', 'ontology.diff', 'source.inspect'], ['Verified scoped stored sources and diagnostic structural differences.'],
    ['No filesystem enumeration, state mutation or semantic-equivalence claim.'], retained('legacy-service'),
    ['source-readback', 'diff', 'foreign-scope-refusal', 'tamper-refusal'], ['Actual query results and no owner revision advance.']),
  scenario('V02-C03', 'Manage Pack dependencies and lifecycle records', 'retained-ontology',
    ['Ontology Pack inputs and explicit target scope.'], ['Resolve these Packs and inspect conflicts before recording a lifecycle change.'],
    ['pack.scaffold.inspect', 'pack.inspect', 'pack.resolve.inspect', 'pack.benchmark.inspect', 'pack.gold-case.inspect', 'pack.certification.inspect', 'producer.prepare', 'producer.decide', 'pack.lifecycle.create', 'pack.lifecycle.transition'],
    ['Dependency/conflict results and current decided-plan receipt.'],
    ['Local lifecycle record is not installation into another product.'], retained('producer-service'),
    ['dependency-resolution', 'conflict', 'plan-decision', 'lifecycle-record'], ['Inspect actual plan, decision and recorded transition.']),
  scenario('V02-C04', 'Produce Proposal, Snapshot, projections and delivery', 'retained-ontology',
    ['Exact scoped materials and currently approved producer plan.'], ['Prepare a Snapshot and its projection artifacts for my review.'],
    ['producer.prepare', 'producer.inspect', 'producer.decide', 'project-ontology.proposal.create', 'project-ontology.proposal.transition', 'project-ontology.projections.inspect', 'project-ontology.artifact.publish'],
    ['Owner-computed derivatives bound to their immutable sources and decided plan.'],
    ['Model-supplied artifacts or old decisions do not replace owner verification.'], retained('producer-service'),
    ['proposal', 'snapshot', 'projection', 'skill-artifact', 'decision-required'], ['Read producer results and immutable artifact bindings.']),
  scenario('V02-C05', 'Inspect semantic reasoning and closure', 'retained-ontology',
    ['Bound Snapshot, profile, index and declared source facts.'], ['Compare incremental and full reasoning, then inspect round-trip and closure results.'],
    ['semantic.foundation.inspect', 'semantic.index.inspect', 'semantic.affected-subgraph.inspect', 'semantic.compute.inspect', 'semantic.compute.compare', 'semantic.round-trip.inspect', 'semantic.closure.inspect', 'semantic.closure.slice'],
    ['Deterministic semantic results with exact input bindings.'], ['Queries do not write state or grant publication rights.'],
    retained('legacy-service'), ['index', 'incremental-full', 'round-trip', 'closure', 'query-no-write'],
    ['Actual owner query chain and before/after revision.']),
  scenario('V02-C06', 'Publish and recover a Catalog', 'retained-ontology',
    ['Verified materials; external Harness resolution requires configured resolveLegacyHarness.'], ['Inspect Catalog prerequisites; prepare the requested transition only when configured.'],
    ['semantic.catalog.preview', 'semantic.catalog.transition-preview', 'producer.prepare', 'producer.decide', 'semantic.catalog.publish', 'semantic.catalog.rollback', 'semantic.catalog.revoke', 'semantic.catalog.inspect', 'semantic.catalog.recover', 'semantic.catalog.recovery-readback'],
    ['Verified transition receipts; revocation survives rollback; recovery reads original intent.'],
    ['No guessed external material or replay publication when provider is absent.'], [...retained('catalog-service'), integration('expert-retained')],
    ['missing-provider', 'configured-synthetic-publication', 'rollback', 'revoke', 'recovery'],
    ['Default installation reports provider prerequisite accurately; inspect remains available.'], 'synthetic-automated-only'),
  scenario('V02-C07', 'Classify, reanalyze, inspect and resume', 'retained-ontology',
    ['Trusted resolveClassificationSource, classificationAdvisor and explicit classificationModel binding for execution.'], ['Classify this source, or explain precisely which provider configuration is missing.'],
    ['classification.start', 'classification.reanalyze', 'classification.inspect', 'classification.resume', 'classification.list', 'classification.close'],
    ['Explicit missing-provider diagnostic or retained configured result; timeout stays UNKNOWN.'],
    ['No inherited Host credentials/model or automatic retry.'], [...retained('classification-service'), integration('expert-retained')],
    ['missing-provider', 'configured-synthetic-result', 'reanalyze', 'timeout', 'restart-no-retry'],
    ['Default installation accurately reports absent providers without claiming a classification result.'], 'synthetic-automated-only'),
  scenario('V02-C08', 'Record human classification handoff to Harness', 'retained-ontology',
    ['Completed configured classification, exact current decision token and real human decision.'], ['Review this classification and record my decision to hand it to Harness.'],
    ['classification.inspect', 'classification.continue_to_harness'], ['Decision and source/result digest bound to the handoff record.'],
    ['Handoff neither creates a native Harness asset nor starts execution.'], [...retained('classification-service'), integration('expert-retained')],
    ['human-handoff', 'wrong-token', 'no-automatic-harness-execution'],
    ['Explain default provider prerequisite and the separate human handoff boundary.'], 'synthetic-automated-only'),
  scenario('V02-D01', 'Recover lost responses and restarted processes', 'recovery',
    ['Retained owner, scope, requestId and Run/session identity.'], ['Inspect this exact receipt and reconcile without redispatch.'],
    ['receipt.inspect', 'run.inspect', 'evaluation.inspect', 'evopilot_v01_reconcile', 'classification.resume'],
    ['Original retained result or explicit uncertainty; execution count unchanged.'], ['No new requestId, automatic CAS refresh or repeat execution.'],
    [integration('composition-products'), integration('connection-products'), owner('runtime', 'execution')],
    ['lost-response', 'restart', 'uncertain-result', 'no-redispatch'], ['Inspect original receipt after connection restart and compare attempt count.']),
  scenario('V02-D02', 'Back up and restore a complete Workspace', 'recovery',
    ['Consistent service shutdown/checkpoint; backup location outside product/source/active state.'], ['Back up my Workspace and verify it can be restored.'],
    ['evopilot_v01_workspace_backup', 'evopilot_v01_workspace_backup_inspect', 'evopilot_v01_workspace_restore', 'workspace.inspect'],
    ['Consistent user files plus service state and verified restoration inventory.'], ['Corrupted backup is rejected before destination replacement; secrets never enter public packages.'],
    [integration('workspace-maintenance')], ['consistent-backup', 'restore', 'corrupt-backup-refusal'], ['Use real maintenance entry, reconnect and compare retained asset/receipt/audit bindings.']),
  scenario('V02-D03', 'Relocate v0.1.1 state safely', 'recovery',
    ['Immutable old identity, consistent backup, no unresolved in-flight operation and approved migration scope.'], ['Migrate my existing Workspace while preserving all historical deliveries and Runs.'],
    ['evopilot_v01_workspace_migrate', 'evopilot_v01_workspace_attach', 'workspace.inspect', 'run.inspect', 'receipt.inspect'],
    ['Migration provenance associates new location with original identity; historical bytes and digests preserved. Attach through a fresh verified installation; the old installation binding does not hot-switch.'],
    ['No rewriting old decisions/claims or replaying Runs; new post-cutover records cannot be discarded by rollback.'],
    [integration('workspace-maintenance'), integration('workspace-cutover')], ['relocation', 'interrupted-migration', 'history-readback', 'post-cutover-preservation'],
    ['Fresh installed connection reads exact original historical deliveries and Run results.']),
  scenario('V02-D04', 'Upgrade product/templates while preserving user files', 'recovery',
    ['Known installed version, template version, Workspace format and backup.'], ['Check upgrade compatibility and keep my customized Workspace files.'],
    ['evopilot_v01_workspace_project', 'evopilot_v01_workspace_attach', 'evopilot_v01_workspace_inspect'],
    ['Separate version compatibility results; explicit conflict records for customized files.'], ['No blind overwrite of user customization or change to specifications/v1.'],
    [integration('workspace-upgrade'), integration('workspace-bootstrap')], ['compatible-upgrade', 'customization-conflict', 'incompatible-version'],
    ['Read exact new installation identity and preserved user customization.']),
  scenario('V02-D05', 'Diagnose unsafe paths, identity and unsupported capabilities', 'recovery',
    ['A concrete connection/Workspace/request failure.'], ['Explain this failure and the supported recovery without changing my data.'],
    ['evopilot_v01_workspace_inspect', 'evopilot_v01_inspect', 'evopilot_v01_capabilities'],
    ['Safe error code, precise prerequisite and bounded recovery guidance.'], ['No secrets, bypass, fake completion or destructive repair.'],
    [integration('workspace-bootstrap'), integration('plugin'), owner('runtime', 'service')],
    ['unsafe-path', 'wrong-identity', 'unsupported-capability', 'data-preserved'], ['Observed failure and unchanged user data; no workaround that bypasses validation.']),
];

function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
export const scenarioCatalogue: readonly ExpertScenario[] = freeze(definitions);
export const scenarioIds: readonly ScenarioId[] = Object.freeze(definitions.map(item => item.id));
export const guideNames: readonly GuideName[] = Object.freeze([...new Set(definitions.map(item => item.guide))]);
export function getScenario(id: string): ExpertScenario {
  const found = scenarioCatalogue.find(item => item.id === id);
  if (!found) throw Object.assign(new Error('Unknown Expert scenario'), { code: 'INVALID_REQUEST' });
  return structuredClone(found);
}
