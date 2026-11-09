import { canonical, exact, record, reject, string } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import { RuntimeStore, type StoredObject, type Receipt } from '../server/store.js';
import { isCurrentBase, loadPublisherBase, requireCurrentBase, valueDigest } from './base.js';
import { compileHistoricalRevision, compileLifecycle, containsInlineSecret, type Compilation, type Issue } from './compiler.js';
import { baseTransition, verifyHistoricalRecord, type BaseTransition, type VerifiedServiceUpgrade } from './base-upgrade.js';
import { validateBindings, type DefinitionBindingProvider, type BindingValidation } from './bindings.js';
import { pinInstance, inspectInstance, stageAdmission, resolveAuthority, type LifecycleInstance, type AuthorityResolver, type ExecutionAuthority, type ReleaseAuthority, type RecoveryLineageService } from './instance.js';
import type { EffectiveDefinition } from './compiler.js';

export const DEFINITION_READS=['lifecycle.base.inspect','lifecycle.definition.inspect','lifecycle.definition.read','lifecycle.definition.source.read','lifecycle.definition.validate','lifecycle.instance.inspect','lifecycle.stage.admission'] as const;
export const DEFINITION_WRITES=['lifecycle.draft.save','lifecycle.definition.activate','lifecycle.definition.save-and-activate','lifecycle.instance.create'] as const;
interface Revision { schema:'runtime-definition-revision/v1'; id:string; yaml:string; compilation:Compilation; createdBy:string; createdAt:string; }
export interface DefinitionValidation { compilation:Compilation; bindings:BindingValidation|null; ready:boolean; validationDigest:string|null; issues:Issue[]; baseTransition:BaseTransition|null; }
function yamlInput(value:unknown):string{if(typeof value!=='string'||Buffer.byteLength(value)>262144)reject('YAML_LIMIT','YAML must be at most 256 KiB',413);if(containsInlineSecret(value))reject('INLINE_SECRET','Use protected credential references; inline secrets cannot be stored');return value;}
const ref=(value:unknown):string=>{const v=string(value,128);if(!/^sha256:[a-f0-9]{64}$/.test(v))reject('INVALID_REFERENCE','An exact revision digest is required');return v;};

export function createDefinitionService(store:RuntimeStore,bindings?:DefinitionBindingProvider,authorities?:AuthorityResolver,verifyAuthority?:(grant:ExecutionAuthority,definition:EffectiveDefinition,actor:Principal)=>void,releaseAuthority?:(instance:LifecycleInstance,actor:Principal)=>ReleaseAuthority|undefined,history?:VerifiedServiceUpgrade|null,recovery?:RecoveryLineageService){
  function revision(projectId:string,id:string):Revision{
    const stored=store.object(projectId,'definition-revision',ref(id)) as Revision|null;
    if(!stored)reject('NOT_FOUND','Definition revision not found',404);
    if(stored.id!==id||valueDigest({yaml:stored.yaml,compilation:stored.compilation})!==id)reject('CORRUPT_DEFINITION','Stored definition integrity mismatch',503);
    const historical=history?verifyHistoricalRecord(history,projectId,'definition-revision',id,stored):false;
    if(stored.compilation.effective&&!isCurrentBase(stored.compilation.effective.base)){
      if(!historical||!history)reject('UNVERIFIED_HISTORICAL_BASE','Historical definition has no native migration evidence',409);
      if(canonical(compileHistoricalRevision(history,projectId,id,stored))!==canonical(stored.compilation))reject('CORRUPT_DEFINITION','Historical compilation differs from its exact source Base',503);
    }
    return stored;
  }
  const pointer=(projectId:string,which:'draft'|'active')=>store.object(projectId,'definition-pointer',which) as {revisionId:string}|null;
  const revisionBinding=(projectId:string)=>({draft:pointer(projectId,'draft')?.revisionId??null,active:pointer(projectId,'active')?.revisionId??null});
  const previewDigest=(projectId:string,actor:Principal,compilation:Compilation,checked:BindingValidation,transition:BaseTransition|null,pointers:ReturnType<typeof revisionBinding>)=>valueDigest({sourceDigest:compilation.sourceDigest,semanticDigest:compilation.effective!.semanticDigest,bindings:checked.stamp,projectId,principalId:actor.id,principalRevision:actor.revision,revisionBinding:pointers,baseTransitionDigest:transition?.previewDigest??null});
  function snapshot(projectId:string,yaml:string,actor:Principal):Revision{
    const compilation=compileLifecycle(yaml,projectId),id=valueDigest({yaml,compilation});
    const existing=store.object(projectId,'definition-revision',id);
    if(existing)return revision(projectId,id);
    return{schema:'runtime-definition-revision/v1',id,yaml,compilation,createdBy:actor.id,createdAt:new Date().toISOString()};
  }
  async function validate(projectId:string,yaml:string,actor:Principal):Promise<DefinitionValidation>{
    const compilation=compileLifecycle(yaml,projectId);
    const pointers=revisionBinding(projectId);
    let transition:BaseTransition|null=null;
    if(history)for(const id of [pointers.draft,pointers.active]){
      if(!id)continue;const source=revision(projectId,id);
      if(verifyHistoricalRecord(history,projectId,'definition-revision',id,source)){transition=baseTransition(history,projectId,id,source,compilation);if(transition)break;}
    }
    const checked=compilation.effective?await validateBindings(compilation.effective,actor,bindings):null;
    const ready=compilation.valid&&checked?.ready===true;
    return{compilation,bindings:checked,ready,validationDigest:ready?previewDigest(projectId,actor,compilation,checked!,transition,pointers):null,issues:[...compilation.issues,...(checked?.issues??[])],baseTransition:transition};
  }
  function summary(value:Revision|null){return value?{id:value.id,sourceDigest:value.compilation.sourceDigest,semanticDigest:value.compilation.effective?.semanticDigest??null,presentationDigest:value.compilation.presentationDigest,structurallyValid:value.compilation.valid,issues:value.compilation.issues,createdAt:value.createdAt}:null;}
  function instance(projectId:string,id:string):LifecycleInstance{
    const saved=store.object(projectId,'lifecycle-instance',id) as LifecycleInstance|null;
    if(!saved)reject('NOT_FOUND','Lifecycle instance not found',404);
    if(saved.pins.projectId!==projectId||saved.id!==id)reject('CORRUPT_INSTANCE','Instance scope does not match storage',503);
    const historical=history?verifyHistoricalRecord(history,projectId,'lifecycle-instance',id,saved):false;
    if(!isCurrentBase(saved.pins.base)&&!historical)reject('UNVERIFIED_HISTORICAL_BASE','Historical instance has no native migration evidence',409);
    return inspectInstance(saved);
  }
  async function read(actor:Principal,projectId:string,operation:string,input:Record<string,unknown>):Promise<unknown>{
    authorize(actor,projectId,'read');
    if(operation==='lifecycle.instance.inspect'){
      exact(input,['instanceId']);const saved=instance(projectId,string(input.instanceId));
      const lineage=recovery?.inspect(saved),loopBudget=lineage&&typeof lineage==='object'&&'loopBudget'in lineage?lineage.loopBudget:{accounting:'UNAVAILABLE',ref:null,digest:null,identity:null,deadlineAt:null,maxLoops:null,consumed:null,remaining:null,currentForNewLoops:false,selectedLoop:null,executionAuthorized:false};
      return{instance:saved,...(recovery?{recovery:lineage,loopBudget}:{}),projectRevision:store.revision(projectId)};
    }
    if(operation==='lifecycle.stage.admission'){
      exact(input,['instanceId','stageId']);authorize(actor,projectId,'execution.request');
      const saved=instance(projectId,string(input.instanceId));
      requireCurrentBase(saved.pins.base);
      const authorityBinding=store.object(projectId,'instance-authority',saved.id) as {evidenceRef:string}|null;
      if(!authorityBinding)reject('CORRUPT_INSTANCE','Instance authority reference is missing',503);
      const authority=await resolveAuthority(authorities,string(authorityBinding.evidenceRef,512),saved.definition,actor);
      const checked=await validateBindings(saved.definition,actor,bindings);
      verifyAuthority?.(authority,saved.definition,actor);
      const stageId=string(input.stageId);
      if(stageId==='publication')authorize(actor,projectId,'release.request');
      const admitted=stageAdmission(saved,stageId,{authority,bindingsCurrent:checked.ready,releaseAuthority:stageId==='publication'?releaseAuthority?.(saved,actor):undefined}),lineage=recovery?.admission(saved,authority,stageId,actor);
      return{...admitted,allowed:admitted.allowed&&(lineage?.allowed??true),reasons:[...admitted.reasons,...(lineage?.reasons??[])],...(lineage?{recovery:lineage}:{}),executionDispatched:false};
    }
    if(operation==='lifecycle.base.inspect'){
      exact(input,[]);const {pin,base}=loadPublisherBase();return{pin,fields:base.fields,stages:base.stages,slots:base.slots,actions:base.actions.map(a=>({...a,digest:valueDigest(a)})),projectMutationAllowed:false};
    }
    if(operation==='lifecycle.definition.inspect'){
      exact(input,[]);const draft=pointer(projectId,'draft'),active=pointer(projectId,'active');
      return{projectId,revision:store.revision(projectId),draft:summary(draft?revision(projectId,draft.revisionId):null),active:summary(active?revision(projectId,active.revisionId):null)};
    }
    if(operation==='lifecycle.definition.read'){
      exact(input,['revisionId']);const value=revision(projectId,ref(input.revisionId));return{...summary(value),compilation:value.compilation};
    }
    if(operation==='lifecycle.definition.source.read'){
      exact(input,['revisionId'],['offset']);const value=revision(projectId,ref(input.revisionId)),offset=input.offset??0;
      if(!Number.isSafeInteger(offset)||Number(offset)<0)reject('INVALID_OFFSET','Expected a nonnegative byte offset');
      const bytes=Buffer.from(value.yaml);if(Number(offset)>bytes.length)reject('INVALID_OFFSET','Offset exceeds the fixed source');
      const end=Math.min(Number(offset)+32768,bytes.length);
      return{revisionId:value.id,sourceDigest:value.compilation.sourceDigest,encoding:'base64',data:bytes.subarray(Number(offset),end).toString('base64'),nextOffset:end<bytes.length?end:null,totalBytes:bytes.length};
    }
    if(operation==='lifecycle.definition.validate'){
      exact(input,['yaml']);return validate(projectId,yamlInput(input.yaml),actor);
    }
    reject('UNKNOWN_OPERATION','Unsupported definition operation',404);
  }
  async function write(actor:Principal,projectId:string,operation:string,input:Record<string,unknown>,requestId:string,expectedRevision:number,reauthorize:()=>Principal):Promise<Receipt>{
    if(operation==='lifecycle.instance.create'){
      authorize(actor,projectId,'execution.request');exact(input,['instanceId','definitionRevisionId','authorityRef']);
      const id=string(input.instanceId),definitionRevisionId=ref(input.definitionRevisionId),authorityRef=string(input.authorityRef,512);
      const mutation={projectId,operation,requestId,expectedRevision,input,permission:'execution.request' as const};
      if(store.findReceipt(actor,projectId,requestId))return store.mutate(actor,mutation,()=>{throw new Error('Unreachable replay callback');},reauthorize);
      const selected=revision(projectId,definitionRevisionId);
      if(pointer(projectId,'active')?.revisionId!==definitionRevisionId||!selected.compilation.effective)reject('DEFINITION_NOT_ACTIVE','New instances require the exact active definition',409);
      requireCurrentBase(selected.compilation.effective.base);
      const authority=await resolveAuthority(authorities,authorityRef,selected.compilation.effective,actor);
      const checked=await validateBindings(selected.compilation.effective,actor,bindings);
      if(!checked.ready)reject('BINDINGS_NOT_CURRENT','Repair current scoped references before creating an instance',409);
      return store.mutate(actor,mutation,()=>{
        if(store.object(projectId,'lifecycle-instance',id))reject('INSTANCE_EXISTS','An instance cannot be overwritten or reset',409);
        if(Date.parse(checked.expiresAt!)<=Date.now())reject('BINDINGS_NOT_CURRENT','Reference evidence expired before commit',409);
        verifyAuthority?.(authority,selected.compilation.effective!,reauthorize());
        const created=pinInstance(id,definitionRevisionId,selected.compilation.effective!,authority);
        if(!recovery&&authority.recoveryRootRef)reject('RECOVERY_BINDING_UNAVAILABLE','Only native reviewed authority can link recovery instances',409);
        const recoveryObjects=recovery?.create(created,authority,reauthorize())??[];
        return{objects:[{kind:'lifecycle-instance',id,value:created},{kind:'instance-authority',id,value:{evidenceRef:authorityRef}},...recoveryObjects],value:{instanceId:id,pinsDigest:created.pinsDigest,definitionRevisionId,status:'PENDING',executionDispatched:false,releaseAuthorized:false},event:{type:'lifecycle-instance-created',data:{instanceId:id,pinsDigest:created.pinsDigest,definitionRevisionId,authorityRef,executionDispatched:false}}};
      },reauthorize);
    }
    const activating=operation!=='lifecycle.draft.save';
    if(!DEFINITION_WRITES.includes(operation as typeof DEFINITION_WRITES[number]))reject('UNKNOWN_OPERATION','Unsupported definition operation',404);
    authorize(actor,projectId,activating?'definition.activate':'draft.write');
    if(operation==='lifecycle.definition.save-and-activate')authorize(actor,projectId,'draft.write');
    const activationOnly=operation==='lifecycle.definition.activate';
    exact(input,activationOnly?['revisionId','validationDigest']:activating?['yaml','validationDigest']:['yaml']);
    const yaml=activationOnly?revision(projectId,ref(input.revisionId)).yaml:yamlInput(input.yaml);
    if(activating&&input.validationDigest!==null)ref(input.validationDigest);
    const snap=activationOnly?revision(projectId,ref(input.revisionId)):snapshot(projectId,yaml,actor);
    // An exact idempotent replay returns the retained outcome, not a new owner
    // verification or business action. Current role is still required.
    const prior=store.findReceipt(actor,projectId,requestId);
    if(prior)return store.mutate(actor,{projectId,operation,requestId,expectedRevision,input,permission:activating?'definition.activate':'draft.write'},()=>{throw new Error('Unreachable replay callback');},reauthorize);
    const validation=activating?await validate(projectId,yaml,actor):null;
    return store.mutate(actor,{projectId,operation,requestId,expectedRevision,input,permission:activating?'definition.activate':'draft.write'},()=>{
      const current=reauthorize();authorize(current,projectId,activating?'definition.activate':'draft.write');
      if(operation==='lifecycle.definition.save-and-activate')authorize(current,projectId,'draft.write');
      const active=pointer(projectId,'active');
      const objects:StoredObject[]=activationOnly?[]:[{kind:'definition-revision',id:snap.id,value:snap},{kind:'definition-pointer',id:'draft',value:{revisionId:snap.id}}];
      const issues=[...(validation?.issues??[])];
      const ready=validation?.ready===true&&canonical(snap.compilation)===canonical(validation.compilation)&&validation.validationDigest===input.validationDigest&&validation.validationDigest===previewDigest(projectId,current,validation.compilation,validation.bindings!,validation.baseTransition,revisionBinding(projectId))&&current.id===actor.id&&current.revision===actor.revision&&Date.parse(validation.bindings!.expiresAt!)>Date.now();
      if(activating&&validation?.ready&&!ready)issues.push({code:'VALIDATION_STALE',path:'validationDigest',rule:'activation.exact-current-preview',message:'The preview, bindings or authority changed',remedy:'Validate this exact YAML and current references again in the same entry.'});
      if(activating&&ready)objects.push({kind:'definition-pointer',id:'active',value:{revisionId:snap.id,semanticDigest:snap.compilation.effective!.semanticDigest,validationDigest:validation!.validationDigest,bindingStamp:validation!.bindings!.stamp,activatedBy:current.id,principalRevision:current.revision}});
      const status=activating?(ready?'ACTIVE':'BLOCKED'):'DRAFT';
      return{objects,value:{status,revisionId:snap.id,activeRevisionId:ready?snap.id:active?.revisionId??null,issues:activating?issues:snap.compilation.issues,semanticDigest:snap.compilation.effective?.semanticDigest??null,executionAuthorized:false,releaseAuthorized:false},event:{type:status==='ACTIVE'?'definition-activated':status==='BLOCKED'?'definition-activation-blocked':'definition-draft-saved',data:{revisionId:snap.id,sourceDigest:snap.compilation.sourceDigest,semanticDigest:snap.compilation.effective?.semanticDigest??null,actorId:current.id,issueCodes:issues.map(x=>x.code),executionAuthorized:false,releaseAuthorized:false}}};
    },reauthorize);
  }
  return{read,write};
}
