import { verifyDecisionEvidence, type DecisionSubject } from '../../vendor/compatibility/v1/decision-evidence.mjs';
import { canonical, exact, record, reject, slug, string } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import { RuntimeStore, type Receipt, type StoredObject } from '../server/store.js';
import { valueDigest } from '../lifecycle/base.js';
import { atPath, bindingPattern, containsInlineSecret, type EffectiveDefinition } from '../lifecycle/compiler.js';
import { inspectInstance, pinInstance, requiredChecksDigest, type AuthorityResolver, type ExecutionAuthority, type LifecycleInstance, type ReleaseAuthority } from '../lifecycle/instance.js';
import { readIntegrationConfiguration } from './config.js';
import { validateResourceDefinition } from './bindings.js';

export const AUTHORITY_READS=['lifecycle.authority.preview','lifecycle.authority.inspect'] as const;
export const AUTHORITY_WRITES=['lifecycle.authority.record','lifecycle.authority.revoke'] as const;
export interface AuthorityPolicy { digest:string; bindingContextDigest:string; principalIds:readonly string[]; expiresAt:string; }
export type AuthorityPolicyProvider=(definition:EffectiveDefinition,actor:Principal)=>AuthorityPolicy;
export type PrincipalLookup=(id:string)=>Principal|null;
type Kind='execution'|'release';
type Choice='APPROVE'|'REJECT';
interface DecisionRecord {
  schema:'runtime-authority-decision/v1'; ref:string; workspaceId:string; projectId:string;
  kind:Kind; subject:Record<string,unknown>; reviewDigest:string; policyDigest:string; bindingContextDigest:string;
  principalId:string; principalRevision:number; choice:Choice; evidenceRef:string; at:string;
}
interface Revocation { schema:'runtime-authority-revocation/v1'; authorityRef:string; revokedBy:string; principalRevision:number; reason:string; at:string; }
const hash=(v:unknown):string=>{const s=string(v,128);if(!/^sha256:[a-f0-9]{64}$/.test(s))reject('INVALID_REFERENCE','An exact content digest is required');return s;};
const reference=(v:unknown):string=>{const s=string(v,128);if(!/^authority:sha256:[a-f0-9]{64}$/.test(s))reject('INVALID_AUTHORITY_REF','An exact retained authority reference is required');return s;};
const kind=(v:unknown):Kind=>{if(v!=='execution'&&v!=='release')reject('INVALID_AUTHORITY_KIND','Choose execution or release');return v;};
function expiry(v:unknown):string{const s=string(v,128);if(!Number.isFinite(Date.parse(s))||Date.parse(s)<=Date.now())reject('AUTHORITY_EXPIRED','Authority needs a future explicit expiry');return s;}

/** Policy config does not contain decisions. Referenced configuration is pinned
 * independently from the decision policy. Credential bytes, remote branch head,
 * and unrelated projects/registrations are not execution scope changes. */
export function registeredAuthorityPolicy(configPath:string,workspaceId:string):AuthorityPolicyProvider {
  return(definition,actor)=>{
    authorize(actor,definition.projectId,'read');
    const config=readIntegrationConfiguration(configPath,workspaceId);
    const resources=['authorityPolicyRef','decisionSourceRef'].map(field=>{
      const role='config.release-decision.'+field,ref=atPath(definition.semantic,role);
      const resource=config.resources.find(r=>r.ref===ref&&r.projectId===definition.projectId&&r.role===role);
      if(!resource||Date.parse(resource.expiresAt)<=Date.now())reject('AUTHORITY_POLICY_UNAVAILABLE','Current scoped decision policy is required',409);
      validateResourceDefinition(resource);return resource;
    });
    const refs=new Set<string>();
    const collect=(value:unknown):void=>{if(typeof value==='string'&&bindingPattern.test(value))refs.add(value);else if(Array.isArray(value))value.forEach(collect);else if(value&&typeof value==='object')Object.values(value).forEach(collect);};
    collect(definition.semantic);
    const selected:Record<string,unknown>[]=[];
    // Shared native validators are part of execution scope, even though their
    // protected manifest is operator configuration rather than project YAML.
    if(config.nativeToolchain)selected.push({ref:'native-toolchain',...config.nativeToolchain});
    for(const ref of refs){
      const resource=config.resources.find(r=>r.ref===ref&&r.projectId===definition.projectId);
      const platform=config.platforms.find(p=>p.ref===ref&&p.projectId===definition.projectId);
      const owner=config.owners.find(o=>o.ref===ref&&o.projects.includes(definition.projectId));
      if(resource){const {revision:unusedRevision,expiresAt:unusedExpiry,...scope}=resource;selected.push(scope);collect(resource.definition);}
      else if(platform){const {revision:unusedRevision,expiresAt:unusedExpiry,...scope}=platform;selected.push(scope);}
      else if(owner){const {projects:unusedProjects,...scope}=owner;selected.push({...scope,projectId:definition.projectId});}
      else selected.push({ref,registration:null});
    }
    return{digest:valueDigest({workspaceId,projectId:definition.projectId,resources}),bindingContextDigest:valueDigest(selected.sort((a,b)=>String(a.ref).localeCompare(String(b.ref)))),principalIds:resources[0].definition.principalIds as string[],expiresAt:new Date(Math.min(...resources.map(r=>Date.parse(r.expiresAt)))).toISOString()};
  };
}

/** Existing local operator evidence + authenticated capability, not an approval
 * portal or an assertion that a file hash authenticates a human. No YAML, LLM
 * output, content grade or successful activation creates a grant. */
export function createAuthorityService(store:RuntimeStore,policies:AuthorityPolicyProvider|undefined,principals:PrincipalLookup){
  function definition(projectId:string,id:unknown):EffectiveDefinition{
    const digest=hash(id),saved=store.object(projectId,'definition-revision',digest);
    if(!saved)reject('NOT_FOUND','Definition revision not found',404);
    const r=record(saved),c=record(r.compilation);
    if(r.id!==digest||valueDigest({yaml:r.yaml,compilation:r.compilation})!==digest||c.valid!==true||!c.effective)reject('CORRUPT_DEFINITION','Authority requires an intact valid definition',409);
    const effective=c.effective as EffectiveDefinition;
    if(effective.projectId!==projectId||valueDigest(effective.semantic)!==effective.semanticDigest)reject('CORRUPT_DEFINITION','Definition scope or semantics changed',503);
    return effective;
  }
  function instance(projectId:string,id:unknown):LifecycleInstance{
    const instanceId=slug(id),saved=store.object(projectId,'lifecycle-instance',instanceId);
    if(!saved)reject('NOT_FOUND','Lifecycle instance not found',404);
    const checked=inspectInstance(saved as LifecycleInstance);
    if(checked.id!==instanceId||checked.pins.projectId!==projectId)reject('CORRUPT_INSTANCE','Instance scope changed',503);
    return checked;
  }
  function releaseEvidence(saved:LifecycleInstance):void{
    const required=new Set<string>(),pending=[...saved.definition.nodes.find(n=>n.id==='release-decision')!.dependsOn];
    while(pending.length){const id=pending.pop()!;if(required.has(id))continue;required.add(id);pending.push(...saved.definition.nodes.find(n=>n.id===id)!.dependsOn);}
    if([...required].some(id=>saved.stages[id].status!=='PASSED'||!saved.stages[id].expiresAt||Date.parse(saved.stages[id].expiresAt!)<=Date.now()))reject('RELEASE_EVIDENCE_REQUIRED','Every fixed release predecessor and its dependencies must currently pass',409);
  }
  function policy(definition:EffectiveDefinition,actor:Principal,deciding=false):AuthorityPolicy{
    if(!policies)reject('AUTHORITY_POLICY_UNAVAILABLE','No current authority policy adapter is configured',409);
    const p=policies(definition,actor);hash(p.digest);hash(p.bindingContextDigest);
    if(!Array.isArray(p.principalIds)||!p.principalIds.length||p.principalIds.some(id=>typeof id!=='string')||Date.parse(p.expiresAt)<=Date.now()||!Number.isFinite(Date.parse(p.expiresAt)))reject('AUTHORITY_POLICY_UNAVAILABLE','Current explicit authority policy is required',409);
    if(deciding){authorize(actor,definition.projectId,'decision.record');if(!p.principalIds.includes(actor.id))reject('DECISION_PRINCIPAL','Principal is not allowed by this exact project policy',403);}
    return p;
  }
  function verifyEvidence(d:DecisionRecord):void{
    const expected:DecisionSubject={owner:'runtime',operation:'lifecycle.authority.'+d.kind,workspaceId:store.workspaceId,scope:{visibility:'private',projectId:d.projectId},reviewDigest:d.reviewDigest,decision:d.choice};
    try{verifyDecisionEvidence(d.evidenceRef,expected);}catch{reject('DECISION_EVIDENCE_REQUIRED','Pinned evidence must match this exact reviewed decision and retained source',409);}
  }
  function savedDecision(projectId:string,ref:unknown):DecisionRecord{
    const key=reference(ref),saved=store.object(projectId,'authority-decision',key);
    if(!saved)reject('NOT_FOUND','Authority decision not found',404);
    const d=saved as DecisionRecord,{ref:unused,...content}=d;
    if(d.schema!=='runtime-authority-decision/v1'||d.workspaceId!==store.workspaceId||d.projectId!==projectId||d.ref!==key||'authority:'+valueDigest(content)!==key)reject('CORRUPT_AUTHORITY','Decision content or scope changed',503);
    return d;
  }
  function selectedDefinition(d:DecisionRecord):EffectiveDefinition{return definition(d.projectId,d.subject.definitionRevisionId);}
  function current(d:DecisionRecord,actor:Principal):void{
    authorize(actor,d.projectId,'read');
    if(d.choice!=='APPROVE'||store.object(d.projectId,'authority-revocation',d.ref))reject('AUTHORITY_REVOKED','This decision is not an active approval',403);
    const selected=store.object(d.projectId,d.kind==='execution'?'instance-execution':'instance-release',String(d.subject.instanceId)) as {authorityRef:string}|null;
    if(selected?.authorityRef!==d.ref)reject('AUTHORITY_SUPERSEDED','A subsequent exact decision replaced this instance authority',409);
    expiry(d.subject.expiresAt);
    const effective=selectedDefinition(d),p=policy(effective,actor);
    if(p.digest!==d.policyDigest)reject('AUTHORITY_POLICY_CHANGED','The exact authority policy changed; prior approval cannot be reused',409);
    if(p.bindingContextDigest!==d.bindingContextDigest)reject('AUTHORITY_BINDINGS_CHANGED','Referenced execution configuration changed; an existing instance cannot be retargeted',409);
    const grantor=principals(d.principalId);
    if(!grantor||grantor.revision!==d.principalRevision||!p.principalIds.includes(grantor.id))reject('AUTHORITY_PRINCIPAL_CHANGED','The deciding principal changed or was removed',403);
    authorize(grantor,d.projectId,'decision.record');verifyEvidence(d);
    if(d.kind==='release'){
      const saved=instance(d.projectId,d.subject.instanceId);
      if(saved.pinsDigest!==d.subject.pinsDigest||saved.candidateDigest!==d.subject.candidateDigest)reject('AUTHORITY_MISMATCH','Release instance or candidate changed',409);
      releaseEvidence(saved);
    }
  }
  function execution(d:DecisionRecord):ExecutionAuthority{
    if(d.kind!=='execution')reject('AUTHORITY_KIND_MISMATCH','An execution decision is required',403);
    const s=d.subject;
    return{projectId:d.projectId,instanceId:String(s.instanceId),definitionRevisionId:String(s.definitionRevisionId),semanticDigest:String(s.semanticDigest),requirementsDigest:String(s.requirementsDigest),goalRef:String(s.goalRef),targetRef:String(s.targetRef),loopRef:String(s.loopRef),budget:s.budget as ExecutionAuthority['budget'],evidenceRef:d.ref,revision:d.reviewDigest,expiresAt:String(s.expiresAt)};
  }
  function release(d:DecisionRecord):ReleaseAuthority{
    if(d.kind!=='release')reject('AUTHORITY_KIND_MISMATCH','A separate release decision is required',403);
    const s=d.subject;
    return{projectId:d.projectId,instanceId:String(s.instanceId),pinsDigest:String(s.pinsDigest),definitionRevisionId:String(s.definitionRevisionId),semanticDigest:String(s.semanticDigest),requirementsDigest:String(s.requirementsDigest),candidateDigest:String(s.candidateDigest),channel:String(s.channel),decisionRef:d.ref,expiresAt:String(s.expiresAt)};
  }
  function prepare(actor:Principal,projectId:string,input:Record<string,unknown>){
    exact(input,['kind','subject']);const type=kind(input.kind),source=record(input.subject);
    if(containsInlineSecret(canonical(source)))reject('INLINE_SECRET','Authority subjects use references, not raw credentials');
    let effective:EffectiveDefinition,subject:Record<string,unknown>;
    if(type==='execution'){
      exact(source,['instanceId','definitionRevisionId','goalRef','targetRef','loopRef','budget','expiresAt']);
      const instanceId=slug(source.instanceId),revisionId=hash(source.definitionRevisionId);
      if(store.object(projectId,'lifecycle-instance',instanceId))reject('INSTANCE_EXISTS','An authority amendment cannot reset an existing instance',409);
      const pointer=store.object(projectId,'definition-pointer','active') as {revisionId:string}|null;
      if(pointer?.revisionId!==revisionId)reject('DEFINITION_NOT_ACTIVE','New execution authority requires the exact active definition',409);
      effective=definition(projectId,revisionId);
      subject={instanceId,definitionRevisionId:revisionId,semanticDigest:effective.semanticDigest,requirementsDigest:requiredChecksDigest(effective),goalRef:string(source.goalRef,512),targetRef:string(source.targetRef,512),loopRef:string(source.loopRef,512),budget:source.budget,expiresAt:expiry(source.expiresAt)};
      // Reuse publisher budget/pin verification without persisting or dispatching.
      pinInstance(instanceId,revisionId,effective,execution({kind:type,projectId,subject,ref:'preview',reviewDigest:'preview'} as DecisionRecord));
    }else{
      exact(source,['instanceId','candidateDigest','expiresAt']);const saved=instance(projectId,source.instanceId);
      if(!saved.candidateDigest||hash(source.candidateDigest)!==saved.candidateDigest)reject('CANDIDATE_REQUIRED','Release authority requires the exact immutable candidate',409);
      effective=saved.definition;
      releaseEvidence(saved);
      subject={instanceId:saved.id,pinsDigest:saved.pinsDigest,definitionRevisionId:saved.pins.definitionRevisionId,semanticDigest:saved.pins.semanticDigest,requirementsDigest:saved.pins.requirementsDigest,candidateDigest:saved.candidateDigest,channel:atPath(effective.semantic,'config.publication.channel'),expiresAt:expiry(source.expiresAt)};
    }
    const p=policy(effective,actor,true);
    if(Date.parse(String(subject.expiresAt))>Math.min(Date.parse(p.expiresAt),Date.parse(actor.expiresAt)))reject('AUTHORITY_EXPIRY_BOUND','Decision expiry must fit the current policy and deciding credential');
    const review={schema:'runtime-authority-review/v1',workspaceId:store.workspaceId,projectId,kind:type,subject,policyDigest:p.digest,bindingContextDigest:p.bindingContextDigest,principalId:actor.id,principalRevision:actor.revision};
    return{...review,reviewDigest:valueDigest(review)};
  }
  const resolveExecution:AuthorityResolver=async(ref,effective,actor,signal)=>{
    signal.throwIfAborted();const d=savedDecision(effective.projectId,ref);current(d,actor);
    const grant=execution(d);if(grant.semanticDigest!==effective.semanticDigest||grant.requirementsDigest!==requiredChecksDigest(effective))reject('AUTHORITY_MISMATCH','Authority does not match these exact semantics',403);return grant;
  };
  function verifyExecution(grant:ExecutionAuthority,effective:EffectiveDefinition,actor:Principal):void{
    const d=savedDecision(effective.projectId,grant.evidenceRef);current(d,actor);
    if(canonical(execution(d))!==canonical(grant)||grant.semanticDigest!==effective.semanticDigest)reject('AUTHORITY_CHANGED','Authority changed before transaction commit',409);
  }
  function resolveRelease(saved:LifecycleInstance,actor:Principal):ReleaseAuthority|undefined{
    const selected=store.object(saved.pins.projectId,'instance-release',saved.id) as {authorityRef:string}|null;
    if(!selected)return undefined;
    const d=savedDecision(saved.pins.projectId,selected.authorityRef);current(d,actor);const grant=release(d);
    if(grant.instanceId!==saved.id||grant.pinsDigest!==saved.pinsDigest||grant.candidateDigest!==saved.candidateDigest)reject('AUTHORITY_MISMATCH','Release decision does not cover this exact instance/candidate',403);return grant;
  }
  function read(actor:Principal,projectId:string,operation:string,input:Record<string,unknown>):unknown{
    authorize(actor,projectId,'read');
    if(operation==='lifecycle.authority.preview')return{...prepare(actor,projectId,input),authorityGranted:false,executionDispatched:false};
    if(operation!=='lifecycle.authority.inspect')reject('UNKNOWN_OPERATION','Unsupported authority operation',404);
    exact(input,['authorityRef']);const d=savedDecision(projectId,input.authorityRef);
    let usable=false,reason:string|null=null;
    try{current(d,actor);usable=true;}catch(e){reason=e&&typeof e==='object'&&'code'in e?String(e.code):'AUTHORITY_UNKNOWN';}
    return{decision:d,revocation:store.object(projectId,'authority-revocation',d.ref),usable,reason,projectRevision:store.revision(projectId),executionDispatched:false};
  }
  function write(actor:Principal,projectId:string,operation:string,input:Record<string,unknown>,requestId:string,expectedRevision:number,reauthorize:()=>Principal):Receipt{
    authorize(actor,projectId,'decision.record');
    if(!AUTHORITY_WRITES.includes(operation as typeof AUTHORITY_WRITES[number]))reject('UNKNOWN_OPERATION','Unsupported authority operation',404);
    exact(input,operation==='lifecycle.authority.record'?['kind','subject','reviewDigest','decision','evidenceRef']:['authorityRef','reason']);
    const mutation={projectId,operation,requestId,expectedRevision,input,permission:'decision.record' as const};
    // Replays are historical receipts, never an assertion of current usability.
    if(store.findReceipt(actor,projectId,requestId))return store.mutate(actor,mutation,()=>{throw new Error('Unreachable replay callback');},reauthorize);
    return store.mutate(actor,mutation,()=>{
      const fresh=reauthorize();authorize(fresh,projectId,'decision.record');
      if(operation==='lifecycle.authority.revoke'){
        const d=savedDecision(projectId,input.authorityRef);policy(selectedDefinition(d),fresh,true);
        if(store.object(projectId,'authority-revocation',d.ref))reject('AUTHORITY_REVOKED','Revocation is already retained',409);
        const reason=string(input.reason,2048);if(containsInlineSecret(reason))reject('INLINE_SECRET','Revocation reasons must not contain secrets');
        const revocation:Revocation={schema:'runtime-authority-revocation/v1',authorityRef:d.ref,revokedBy:fresh.id,principalRevision:fresh.revision,reason,at:new Date().toISOString()};
        return{objects:[{kind:'authority-revocation',id:d.ref,value:revocation}],value:{authorityRef:d.ref,status:'REVOKED',executionDispatched:false},event:{type:'authority-revoked',data:{authorityRef:d.ref,kind:d.kind,instanceId:d.subject.instanceId,revokedBy:fresh.id}}};
      }
      const review=prepare(fresh,projectId,{kind:input.kind,subject:input.subject});
      if(hash(input.reviewDigest)!==review.reviewDigest)reject('AUTHORITY_REVIEW_STALE','Exact subject, policy or principal changed after review',409);
      if(input.decision!=='APPROVE'&&input.decision!=='REJECT')reject('INVALID_DECISION','An explicit APPROVE or REJECT decision is required');
      const content:Omit<DecisionRecord,'ref'>={schema:'runtime-authority-decision/v1',workspaceId:store.workspaceId,projectId,kind:review.kind,subject:review.subject,reviewDigest:review.reviewDigest,policyDigest:review.policyDigest,bindingContextDigest:review.bindingContextDigest,principalId:fresh.id,principalRevision:fresh.revision,choice:input.decision,evidenceRef:string(input.evidenceRef,8192),at:new Date().toISOString()};
      const d:DecisionRecord={...content,ref:'authority:'+valueDigest(content)};verifyEvidence(d);
      const objects:StoredObject[]=[{kind:'authority-decision',id:d.ref,value:d}];
      objects.push({kind:d.kind==='release'?'instance-release':'instance-execution',id:String(d.subject.instanceId),value:{authorityRef:d.ref}});
      return{objects,value:{authorityRef:d.ref,status:d.choice==='APPROVE'?'APPROVED':'REJECTED',kind:d.kind,reviewDigest:d.reviewDigest,instanceId:d.subject.instanceId,executionDispatched:false},event:{type:'authority-recorded',data:{authorityRef:d.ref,kind:d.kind,reviewDigest:d.reviewDigest,instanceId:d.subject.instanceId,choice:d.choice,principalId:fresh.id,executionDispatched:false}}};
    },reauthorize);
  }
  return{read,write,resolveExecution,verifyExecution,resolveRelease};
}
