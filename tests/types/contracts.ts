import { createRuntimeService, type Scope, type Run, type Project } from '@evopilot-next/runtime/service';
import { inspectPinnedInputs, type Reference } from '@evopilot-next/runtime';

const scope: Scope = { visibility: 'private', projectId: 'alpha' };
const service = createRuntimeService({workspaceRoot: '/inert/workspace', workspaceId: 'test'}, {
  resolveOntology(request) { return {reference: request.reference, workspace: request.workspace, scope: request.scope, published: true}; },
  execute(claim) { const signal: AbortSignal = claim.signal; return signal.aborted ? null : {claimId: claim.claimId}; },
});
const project: Project = service.execute({operation:'project.create',scope,input:{name:'Alpha'},requestId:'create',expectedRevision:0}).result;
const run: Run = service.execute({operation:'run.inspect',scope,input:{id:'run'}});
const revision: number = service.execute({operation:'workspace.inspect',scope,input:{}}).revision;
const pending: Promise<Run> = service.dispatch({scope,id:'run',requestId:'dispatch',expectedRevision:revision}).then(receipt => receipt.result);
const reference: Reference = {product:'ontology',id:'asset',version:'0.1.0',specVersion:'v1',digest:'sha256:'+'a'.repeat(64),visibility:'public'};
inspectPinnedInputs({ontology:reference,harness:{...reference,product:'harness'},observedOntology:reference,observedHarness:{...reference,product:'harness'}});
// @ts-expect-error Scope visibility is a closed domain.
const invalidScope: Scope = {visibility:'shared',projectId:'alpha'};
// @ts-expect-error Project creation requires its write identity and revision.
service.execute({operation:'project.create',scope,input:{name:'Alpha'}});
// @ts-expect-error Inspect requests cannot supply unrelated request fields.
service.execute({operation:'run.inspect',scope,input:{id:'run',command:'execute'}});
// @ts-expect-error Async dispatch requires an explicit revision.
service.dispatch({scope,id:'run',requestId:'dispatch'});
void [project,run,pending,invalidScope];
