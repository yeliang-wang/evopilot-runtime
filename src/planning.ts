import {planningPresentation} from './planning-presentation.js';
import { nativeAssertJSON, nativeExact, nativeText, nativeDigest, nativeSha256, nativeBytesDigest, nativeStableSerialize, nativeFrozenClone, validateNativeReference } from '../vendor/compatibility/v1/native.mjs';
import type { NativeScope, NativeReference } from '../vendor/compatibility/v1/native.mjs';
import { verifyDecisionEvidence } from '../vendor/compatibility/v1/decision-evidence.mjs';
import { createFeedbackStore, feedbackScope } from '../vendor/compatibility/feedback/v1/feedback.mjs';
import type { FeedbackEnvelope } from '../vendor/compatibility/feedback/v1/feedback.mjs';
import { fail as stateFail } from './state.js';
function fail(code:string):never {return stateFail(code,code);}
import type { Store, Providers } from './types.js';
import type { NativeProject, NativeRequest } from './native-types.js';

export type PlanningEnvelope = FeedbackEnvelope;
export interface PlanningSource {
  id: string; kind: 'conversation' | 'document' | 'code'; reference: string;
  representation: 'excerpt' | 'summary' | 'reference-only'; content: string | null;
  contentDigest: string | null; attributedRole: 'user' | 'assistant' | 'document' | 'unknown';
}
export interface PlanningItem {
  id: string; kind: 'requirement' | 'assumption' | 'question' | 'option' | 'decision';
  text: string; disposition: 'proposed' | 'included' | 'rejected' | 'unresolved';
  sourceIds: string[]; dependsOn: string[]; ownerImpact: ('runtime' | 'ontology' | 'harness')[]; acceptance: string[];
}
export interface PlanningMilestone { id: string; title: string; targetVersion: string; priority: number; requirementIds: string[]; dependsOn: string[] }
export interface PlanningCandidate { owner: 'ontology' | 'harness'; id: string; version: string; digest: string; itemIds: string[] }
export interface PlanningDraft {
  title: string; objective: string; sourceRevision: string; sourceDigest: string;
  sources: PlanningSource[]; items: PlanningItem[]; milestones: PlanningMilestone[];
  exclusions: string[]; candidates: PlanningCandidate[];
}
export interface PlanningRevision {
  schema: 'evopilot-planning-revision/v1'; workspaceId: string; scope: NativeScope;
  id: string; revision: number; parentDigest: string | null; draft: PlanningDraft;
  createdAt: string; digest: string; authority: false;
}
export interface PlanningDecision { revisionDigest: string; decision: 'APPROVE' | 'REJECT'; actor: string; humanEvidenceRef: string; at: string }
interface PlanningHead { id: string; latestDigest: string; revision: number; acceptedDigest: string | null }
export interface PlanningBinding {
  schema: 'evopilot-planning-binding/v1'; workspaceId: string; scope: NativeScope;
  planId: string; planDigest: string; milestoneId: string; goalId: string; goalDigest: string;
  projectId: string; projectCandidateDigest: string; sourceRevision: string; sourceDigest: string;
  assets: { ontology: NativeReference; harness: NativeReference };
  requirements: { itemId: string; criterionIds: string[] }[]; createdAt: string; digest: string; authority: false;
}
export const PLANNING_OPERATIONS = ['planning.inspect','planning.list','planning.read','planning.review','planning.revise','planning.decide','planning.bind','planning.binding.inspect','planning.export','planning.export.verify','planning.receipt.inspect'] as const;
const same = (a: unknown,b: unknown) => nativeStableSerialize(a) === nativeStableSerialize(b);
function slug(v: unknown): asserts v is string { if(typeof v!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(v)) fail('PLANNING_ID'); }
function text(v: unknown, max=8192): asserts v is string { nativeText(v); if(v.length>max) fail('PLANNING_LIMIT'); }
function prose(v:unknown,max=8192):asserts v is string {if(typeof v==='string'&&v.length>max)fail('PLANNING_LIMIT');if(typeof v!=='string'||!v.trim()||v.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v))fail('PLANNING_TEXT');}
function array(v: unknown, max: number): asserts v is unknown[] { if(!Array.isArray(v)||v.length>max) fail('PLANNING_LIMIT'); }
function strings(v: unknown,max=200): asserts v is string[] { array(v,max);v.forEach(x=>text(x));if(new Set(v).size!==v.length)fail('PLANNING_DUPLICATE'); }
function acyclic(items: {id:string;dependsOn:string[]}[]) {
  const byId=new Map(items.map(x=>[x.id,x])),done=new Set<string>();
  function visit(id:string,trail:Set<string>):void { if(done.has(id))return;if(!byId.has(id)||trail.has(id))fail('PLANNING_DEPENDENCY');const next=new Set(trail).add(id);byId.get(id)!.dependsOn.forEach(x=>visit(x,next));done.add(id); }
  items.forEach(x=>visit(x.id,new Set()));
}
export function validatePlanningDraft(value: unknown): asserts value is PlanningDraft {
  nativeAssertJSON(value);nativeExact(value,['title','objective','sourceRevision','sourceDigest','sources','items','milestones','exclusions','candidates']);
  text(value.title,512);prose(value.objective);text(value.sourceRevision,1024);nativeDigest(value.sourceDigest);
  array(value.sources,200);array(value.items,200);array(value.milestones,50);array(value.candidates,200);strings(value.exclusions);
  const sourceIds=new Set<string>(),itemIds=new Set<string>(),milestones=new Set<string>();
  for(const s of value.sources){nativeExact(s,['id','kind','reference','representation','content','contentDigest','attributedRole']);slug(s.id);text(s.reference,4096);
    if(sourceIds.has(s.id)||!['conversation','document','code'].includes(String(s.kind))||!['excerpt','summary','reference-only'].includes(String(s.representation))||!['user','assistant','document','unknown'].includes(String(s.attributedRole)))fail('PLANNING_SOURCE');
    if(s.representation==='reference-only'){if(s.content!==null||s.contentDigest!==null)fail('PLANNING_SOURCE');}
    else {prose(s.content,16384);nativeDigest(s.contentDigest);if(s.contentDigest!==nativeBytesDigest(s.content))fail('PLANNING_SOURCE_DIGEST');}
    sourceIds.add(s.id);
  }
  for(const i of value.items){nativeExact(i,['id','kind','text','disposition','sourceIds','dependsOn','ownerImpact','acceptance']);slug(i.id);prose(i.text);strings(i.sourceIds);strings(i.dependsOn);strings(i.ownerImpact,3);strings(i.acceptance,100);
    if(itemIds.has(i.id)||!['requirement','assumption','question','option','decision'].includes(String(i.kind))||!['proposed','included','rejected','unresolved'].includes(String(i.disposition))||i.sourceIds.some(x=>!sourceIds.has(x))||i.ownerImpact.some(x=>!['runtime','ontology','harness'].includes(x)))fail('PLANNING_ITEM');itemIds.add(i.id);
  }
  for(const m of value.milestones){nativeExact(m,['id','title','targetVersion','priority','requirementIds','dependsOn']);slug(m.id);text(m.title,512);text(m.targetVersion,128);strings(m.requirementIds);strings(m.dependsOn,50);
    if(milestones.has(m.id)||!Number.isSafeInteger(m.priority)||Number(m.priority)<0||Number(m.priority)>1000||m.requirementIds.some(x=>!itemIds.has(x)))fail('PLANNING_MILESTONE');milestones.add(m.id);
  }
  for(const c of value.candidates){nativeExact(c,['owner','id','version','digest','itemIds']);slug(c.id);text(c.version,128);nativeDigest(c.digest);strings(c.itemIds);if(!['ontology','harness'].includes(String(c.owner))||c.itemIds.some(x=>!itemIds.has(x)))fail('PLANNING_CANDIDATE');}
  const typed=value as unknown as PlanningDraft;acyclic(typed.items);acyclic(typed.milestones);
}
function recordsFor(store:Store){return createFeedbackStore(store,'runtime',5);}
function head(records:ReturnType<typeof recordsFor>,scope:NativeScope,id:string):PlanningHead { const h=records.get<PlanningHead>(scope,'planning-head',id);if(!h)fail('PLANNING_NOT_FOUND');return h; }
function revision(records:ReturnType<typeof recordsFor>,store:Store,scope:NativeScope,digest:string):PlanningRevision {
  const r=records.get<PlanningRevision>(scope,'planning-revision',digest);if(!r)fail('PLANNING_NOT_FOUND');
  const {digest:actual,...body}=r;if(actual!==digest||actual!==nativeSha256(body)||r.workspaceId!==store.identity.id||!same(scope,r.scope))fail('PLANNING_INTEGRITY');validatePlanningDraft(r.draft);return r;
}
function decision(records:ReturnType<typeof recordsFor>,scope:NativeScope,digest:string){return records.get<PlanningDecision>(scope,'planning-decision',digest);}
function reviewBlockers(draft:PlanningDraft):string[]{
  const blockers:string[]=[];const included=draft.items.filter(i=>i.disposition==='included');
  if(!included.some(i=>i.kind==='requirement')||!draft.milestones.length)blockers.push('NO_SCOPED_REQUIREMENTS');
  for(const i of draft.items){if(i.disposition==='unresolved'||i.disposition==='proposed')blockers.push('UNRESOLVED:'+i.id);if(i.disposition==='included'){
    if(i.kind==='question')blockers.push('UNANSWERED:'+i.id);
    if(!i.sourceIds.length)blockers.push('MISSING_SOURCE:'+i.id);
    if(i.kind==='requirement'&&!i.acceptance.length)blockers.push('MISSING_ACCEPTANCE:'+i.id);
    if(i.dependsOn.some(id=>!included.some(x=>x.id===id)))blockers.push('DEPENDENCY_NOT_INCLUDED:'+i.id);
    if(i.kind==='requirement'&&!draft.milestones.some(m=>m.requirementIds.includes(i.id)))blockers.push('MISSING_MILESTONE:'+i.id);
  }}
  for(const m of draft.milestones)if(!m.requirementIds.length||m.requirementIds.some(id=>!included.some(i=>i.kind==='requirement'&&i.id===id)))blockers.push('INVALID_MILESTONE:'+m.id);
  return blockers;
}
/** Synchronous admission check is invoked inside the native claim transaction. Reconciliation never calls it. */
export function assertPlanningAdmission(store:Store,scope:NativeScope,project:NativeProject,pins?:{ontology:NativeReference;harness:NativeReference}):void {
  const records=recordsFor(store);const binding=records.get<PlanningBinding>(scope,'planning-binding',project.id);if(!binding)return;
  const {digest,...body}=binding;if(digest!==nativeSha256(body)||binding.workspaceId!==store.identity.id||!same(binding.scope,scope))fail('PLANNING_INTEGRITY');
  const h=head(records,scope,binding.planId),latestDecision=decision(records,scope,h.latestDigest),accepted=decision(records,scope,binding.planDigest);
  if(!latestDecision||h.acceptedDigest!==binding.planDigest||accepted?.decision!=='APPROVE')fail('PLANNING_STALE_BINDING');
  verifyDecisionEvidence(accepted.humanEvidenceRef,{owner:'runtime',operation:'planning.decide',workspaceId:store.identity.id,scope,reviewDigest:binding.planDigest,decision:'APPROVE'});
  if(project.candidateDigest!==binding.projectCandidateDigest||project.goalId!==binding.goalId||project.sourceScope.revision!==binding.sourceRevision||project.sourceScope.treeDigest!==binding.sourceDigest)fail('PLANNING_SOURCE_DRIFT');
  if(pins&&!same(pins,binding.assets))fail('PLANNING_ASSET_DRIFT');
}
export function createPlanningRuntime(store:Store,providers:Readonly<Providers>,access:{native(request:NativeRequest):Promise<unknown>;goal(scope:NativeScope,id:string):unknown}) {
  const records=recordsFor(store);
  async function planning(request:PlanningEnvelope):Promise<unknown>{
    nativeAssertJSON(request);request=nativeFrozenClone(request);if(Buffer.byteLength(nativeStableSerialize(request))>1048576)fail('PLANNING_LIMIT');
    const read=['planning.inspect','planning.list','planning.read','planning.review','planning.binding.inspect','planning.export','planning.export.verify','planning.receipt.inspect'].includes(request.operation);
    nativeExact(request,['operation','scope','input',...(read?[]:['requestId','expectedRevision'])]);feedbackScope(request.scope);
    if(!PLANNING_OPERATIONS.includes(request.operation as typeof PLANNING_OPERATIONS[number]))fail('PLANNING_OPERATION');
    const {operation,scope,input}=request;
    if(!read && request.requestId && records.receipt(scope,request.requestId)) return records.mutate(request,()=>{fail('PLANNING_RECEIPT_STATE');});
    const mutate=<T>(fn:()=>T)=>records.mutate(request,()=>{const value=fn();if(Number(store.db.prepare('PRAGMA user_version').get()!.user_version)<6)store.db.exec('PRAGMA user_version=6');return value;});
    if(operation==='planning.inspect'){nativeExact(input,[]);return {...records.inspect(scope),operations:PLANNING_OPERATIONS,softwareRelease:false,executionAuthorized:false};}
    if(operation==='planning.list'){nativeExact(input,[]);return records.list<PlanningHead>(scope,'planning-head');}
    if(operation==='planning.receipt.inspect'){nativeExact(input,['requestId']);text(input.requestId);return records.receipt(scope,input.requestId);}
    if(operation==='planning.binding.inspect'){nativeExact(input,['projectId']);slug(input.projectId);const binding=records.get<PlanningBinding>(scope,'planning-binding',input.projectId);if(!binding)fail('PLANNING_NOT_FOUND');let blocker:string|null=null;try{const project=await access.native({operation:'project.inspect',scope,input:{id:input.projectId}}) as NativeProject;assertPlanningAdmission(store,scope,project);}catch(e){blocker=(e as {code:string}).code;}return {binding,current:blocker===null,blocker,authority:false};}
    if(operation==='planning.revise'){
      nativeExact(input,['id','parentDigest','draft']);slug(input.id);if(input.parentDigest!==null)nativeDigest(input.parentDigest);validatePlanningDraft(input.draft);
      return mutate(()=>{const previous=records.get<PlanningHead>(scope,'planning-head',input.id as string);if((previous?.latestDigest??null)!==input.parentDigest)fail('PLANNING_REVISION_CONFLICT');if((previous?.revision??0)>=100)fail('PLANNING_LIMIT');
        const body={schema:'evopilot-planning-revision/v1' as const,workspaceId:store.identity.id,scope,id:input.id as string,revision:(previous?.revision??0)+1,parentDigest:input.parentDigest as string|null,draft:input.draft as unknown as PlanningDraft,createdAt:new Date().toISOString(),authority:false as const};
        const result={...body,digest:nativeSha256(body)};records.put(scope,'planning-revision',result.digest,result);records.put(scope,'planning-head',result.id,{id:result.id,latestDigest:result.digest,revision:result.revision,acceptedDigest:previous?.acceptedDigest??null});return result;
      });
    }
    if(operation==='planning.read'||operation==='planning.review'||operation==='planning.export'){
      nativeExact(input,['id'],['digest']);slug(input.id);if(input.digest!==undefined)nativeDigest(input.digest);const h=head(records,scope,input.id),r=revision(records,store,scope,input.digest as string??h.latestDigest),d=decision(records,scope,r.digest);
      if(r.id!==input.id)fail('PLANNING_SCOPE');
      const view={readable:planningPresentation(r,d,h.acceptedDigest===r.digest,reviewBlockers(r.draft)),revision:r,decision:d,status:d?.decision??'DRAFT',currentAccepted:h.acceptedDigest===r.digest,blockers:reviewBlockers(r.draft),sourceWarnings:r.draft.sources.filter(s=>s.representation!=='excerpt').map(s=>({id:s.id,representation:s.representation,originalVerified:false})),candidateAuthority:false,executionAuthorized:false,softwareRelease:false};
      if(operation!=='planning.export')return nativeFrozenClone(view);
      if(!view.currentAccepted||d?.decision!=='APPROVE')fail('PLANNING_REVIEW_REQUIRED');
      const md=view.readable.markdown;
      const body={schema:'evopilot-planning-export/v1',workspaceId:store.identity.id,scope,id:r.id,planDigest:r.digest,markdown:md,view};return {...body,exportDigest:nativeSha256(body)};
    }
    if(operation==='planning.export.verify'){
      nativeExact(input,['export']);nativeExact(input.export,['schema','workspaceId','scope','id','planDigest','markdown','view','exportDigest']);const e=input.export;
      nativeDigest(e.planDigest);nativeDigest(e.exportDigest);const {exportDigest,...body}=e;
      if(e.workspaceId!==store.identity.id||!same(e.scope,scope))fail('PLANNING_SCOPE');
      const expected=await planning({operation:'planning.export',scope,input:{id:e.id,digest:e.planDigest}}) as Record<string,unknown>;
      return {matches:exportDigest===nativeSha256(body)&&same(expected,e),planDigest:e.planDigest,authority:false};
    }
    if(operation==='planning.decide'){
      nativeExact(input,['id','digest','decision','actor','humanEvidenceRef']);slug(input.id);nativeDigest(input.digest);text(input.actor,256);text(input.humanEvidenceRef,4096);if(!['APPROVE','REJECT'].includes(String(input.decision)))fail('PLANNING_DECISION');
      return mutate(()=>{const h=head(records,scope,input.id as string),r=revision(records,store,scope,input.digest as string);if(h.latestDigest!==r.digest||r.id!==input.id||decision(records,scope,r.digest))fail('PLANNING_REVISION_CONFLICT');
        if(input.decision==='APPROVE'&&reviewBlockers(r.draft).length)fail('PLANNING_REVIEW_REQUIRED');
        verifyDecisionEvidence(input.humanEvidenceRef as string,{owner:'runtime',operation,workspaceId:store.identity.id,scope,reviewDigest:r.digest,decision:input.decision as 'APPROVE'|'REJECT'});
        const d:PlanningDecision={revisionDigest:r.digest,decision:input.decision as 'APPROVE'|'REJECT',actor:input.actor as string,humanEvidenceRef:input.humanEvidenceRef as string,at:new Date().toISOString()};records.put(scope,'planning-decision',r.digest,d);if(d.decision==='APPROVE')records.put(scope,'planning-head',h.id,{...h,acceptedDigest:r.digest});return d;
      });
    }
    if(operation==='planning.bind'){
      nativeExact(input,['id','planDigest','milestoneId','goalId','projectId','assets','requirements']);[input.id,input.milestoneId,input.goalId,input.projectId].forEach(x=>slug(x));nativeDigest(input.planDigest);nativeExact(input.assets,['ontology','harness']);array(input.requirements,200);
      const r=revision(records,store,scope,input.planDigest as string),h=head(records,scope,input.id as string);if(r.id!==input.id||h.acceptedDigest!==r.digest||h.latestDigest!==r.digest||decision(records,scope,r.digest)?.decision!=='APPROVE')fail('PLANNING_REVIEW_REQUIRED');
      const milestone=r.draft.milestones.find(m=>m.id===input.milestoneId);if(!milestone)fail('PLANNING_MILESTONE');
      const project=await access.native({operation:'project.inspect',scope,input:{id:input.projectId as string}}) as NativeProject,goal=access.goal(scope,input.goalId as string);
      if(project.goalId!==input.goalId||project.sourceScope.revision!==r.draft.sourceRevision||project.sourceScope.treeDigest!==r.draft.sourceDigest)fail('PLANNING_SOURCE_DRIFT');
      const maps:PlanningBinding['requirements']=[];
      for(const m of input.requirements){nativeExact(m,['itemId','criterionIds']);slug(m.itemId);strings(m.criterionIds);if(!m.criterionIds.length||m.criterionIds.some(id=>!project.requirements.some(x=>x.criterionId===id)))fail('PLANNING_REQUIREMENTS');maps.push({itemId:m.itemId,criterionIds:m.criterionIds});}
      if(!same(maps.map(m=>m.itemId).sort(),[...milestone.requirementIds].sort()))fail('PLANNING_REQUIREMENTS');
      // All fixed business owner requirements must be represented; project/domain structural checks remain independent.
      if(project.requirements.filter(q=>!q.criterionId.startsWith('project:')&&!q.criterionId.startsWith('domain:')).some(q=>!maps.some(m=>m.criterionIds.includes(q.criterionId))))fail('PLANNING_REQUIREMENTS');
      for(const owner of ['ontology','harness'] as const){const reference=validateNativeReference(input.assets[owner],{product:owner,visibility:scope.visibility});if(!providers.resolveNative)fail('PLANNING_ASSET_UNAVAILABLE');const resolved=await providers.resolveNative({reference,scope,workspace:store.identity});if(!resolved.published||!same(resolved.reference,reference)||resolved.materialDigest!==reference.digest||!same(resolved.workspace,store.identity)||resolved.scope.visibility==='private'&&!same(resolved.scope,scope))fail('PLANNING_ASSET_DRIFT');}
      return mutate(()=>{const latest=head(records,scope,r.id);if(!same(latest,h))fail('PLANNING_REVISION_CONFLICT');if(records.list<PlanningBinding>(scope,'planning-binding').filter(b=>b.planId===r.id).length>=200)fail('PLANNING_LIMIT');const old=records.get<PlanningBinding>(scope,'planning-binding',project.id);if(old)fail('PLANNING_BINDING_EXISTS');
        const body={schema:'evopilot-planning-binding/v1' as const,workspaceId:store.identity.id,scope,planId:r.id,planDigest:r.digest,milestoneId:milestone.id,goalId:project.goalId,goalDigest:nativeSha256(goal),projectId:project.id,projectCandidateDigest:project.candidateDigest,sourceRevision:project.sourceScope.revision,sourceDigest:project.sourceScope.treeDigest,assets:input.assets as unknown as PlanningBinding['assets'],requirements:maps,createdAt:new Date().toISOString(),authority:false as const};const binding={...body,digest:nativeSha256(body)};records.put(scope,'planning-binding',project.id,binding);return binding;});
    }
    fail('PLANNING_OPERATION');
  }
  return {planning};
}
