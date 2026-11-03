import {AsyncLocalStorage} from 'node:async_hooks';
import {isAbsolute,resolve} from 'node:path';
import {realpathSync} from 'node:fs';
import {canonical,digest,exact,record,reject,ServiceError,slug,string} from '../server/errors.js';
import {authorize,readPrivateJson,type Principal} from '../server/security.js';
import type {RuntimeStore} from '../server/store.js';
import type {Providers,ReadinessIntentRecord,Scope} from '../service.js';
import {createManagedLegacyService} from './managed-service.js';
import type {ManagedLegacyBinding} from './managed-store.js';
import {LEGACY_CATALOG,LEGACY_READ,LEGACY_WRITE,legacyOperation,type LegacyPermission} from './catalog.js';
import type {LegacyProviderFactory,LegacyProviderContext} from './provider-context.js';

export function readLegacyBinding(ref:string):ManagedLegacyBinding {
  string(ref,4096);if(!isAbsolute(ref)||resolve(ref)!==ref||realpathSync(ref)!==ref)reject('UNSAFE_LEGACY_BINDING','Use the canonical private legacy binding reference');
  const value=record(readPrivateJson(ref));exact(value,['workspaceRoot','workspaceId','serviceId','migrationDigest']);
  string(value.workspaceRoot,4096);slug(value.workspaceId);string(value.serviceId,128);
  if(typeof value.migrationDigest!=='string'||!/^[a-f0-9]{64}$/.test(value.migrationDigest))reject('UNSAFE_LEGACY_BINDING','Invalid legacy adoption digest');
  return value as unknown as ManagedLegacyBinding;
}
interface Invocation {actor:Principal;projectId:string;permission:LegacyPermission;refresh:()=>Principal;}
export interface LegacyIntentSource {
  workspaceRoot:string;workspaceId:string;
  read:(actor:Principal,projectId:string,request:{workspaceId:string;scope:Scope;digest:string})=>Promise<ReadinessIntentRecord&{current:boolean}>;
}
/** One authenticated gateway, retaining all original revision namespaces. The
 * existing owner validators still check every domain input, decision and claim.
 * Providers are trusted process configuration, never request-supplied programs.
 * Owner authoring APIs are deliberately not routed through this server. */
export function createLegacyGateway(store:RuntimeStore,binding:ManagedLegacyBinding,providers:Providers|LegacyProviderFactory={}) {
  if(binding.workspaceId!==store.workspaceId||binding.serviceId!==store.serviceId)reject('LEGACY_SERVICE_MISMATCH','Legacy adoption belongs to another service',409);
  const invocations=new AsyncLocalStorage<Invocation>();let initializing=true,closing=false;
  const guard=()=>{
    if(initializing)return;
    const invocation=invocations.getStore();if(!invocation)reject('LEGACY_CONTEXT_REQUIRED','Legacy access requires an authenticated service invocation',403);
    const current=invocation.refresh();
    if(current.id!==invocation.actor.id||current.revision!==invocation.actor.revision)reject('AUTHORITY_CHANGED','Reauthenticate the original principal before further work',403);
    authorize(current,invocation.projectId,'read');authorize(current,invocation.projectId,invocation.permission);
    return current;
  };
  let legacy:ReturnType<typeof createManagedLegacyService>;
  const providerContext:LegacyProviderContext={
    current(){const actor=guard(),invocation=invocations.getStore();if(!actor||!invocation)reject('LEGACY_CONTEXT_REQUIRED','Provider access requires an authenticated invocation',403);return{actor,projectId:invocation.projectId,permission:invocation.permission};},
    async read(family,request){
      const current=providerContext.current(),op=legacyOperation(family,request.operation);
      if(!op||op.write||!['native','feedback','readiness','response','online','reconstruction'].includes(family))reject('LEGACY_PROVIDER_READ','Providers may only read original Runtime evidence',403);
      if(request.scope.projectId!==current.projectId)reject('LEGACY_SCOPE','Provider evidence belongs to another project',403);
      const result=await (legacy[family] as (input:unknown)=>Promise<unknown>)(request);providerContext.current();return result;
    },
  };
  const resolved=typeof providers==='function'?providers(providerContext):providers;
  legacy=createManagedLegacyService(binding,resolved,guard);initializing=false;
  const pending=new Set<Promise<unknown>>();
  function inspect(){return{schema:'runtime-legacy-gateway/v1',workspaceId:binding.workspaceId,serviceId:binding.serviceId,migrationDigest:binding.migrationDigest,revisionNamespace:'original-family',families:LEGACY_CATALOG,ownerAuthoring:false,softwareLifecycleAuthority:false};}
  async function invoke(actor:Principal,projectId:string,operation:string,input:Record<string,unknown>,requestId:string|undefined,expectedRevision:number|undefined,refresh:()=>Principal):Promise<unknown> {
    if(closing)reject('CLOSED','Legacy gateway is closing',503);
    authorize(actor,projectId,'read');
    if(operation===LEGACY_READ&&Object.keys(input).length===1&&input.inspect===true)return inspect();
    exact(input,['family','envelope']);
    const family=string(input.family),envelope=record(input.envelope),op=string(envelope.operation,128);
    const classification=legacyOperation(family,op);
    if(!classification)reject('LEGACY_OPERATION','Unsupported Runtime legacy operation',404);
    const write=classification.write;
    if(operation!==(write?LEGACY_WRITE:LEGACY_READ))reject('LEGACY_OPERATION_MODE','Use the exact legacy read or write transport');
    exact(envelope,['operation','scope','input']);record(envelope.input);
    const scope=record(envelope.scope);exact(scope,['visibility','projectId']);
    if(scope.projectId!==projectId||!['public','private'].includes(String(scope.visibility)))reject('LEGACY_SCOPE','Original legacy scope must match the authenticated project',403);
    authorize(actor,projectId,classification.permission);
    if(write&&(typeof requestId!=='string'||!requestId.length||!Number.isSafeInteger(expectedRevision)||Number(expectedRevision)<0))reject('INVALID_REVISION','Retain the original family revision and request id');
    if(!write&&(requestId!==undefined||expectedRevision!==undefined))reject('LEGACY_READ_FIELDS','Legacy reads do not accept write identity fields');
    // Copy JSON once; subsequent caller mutation cannot alter the retained request.
    const original=JSON.parse(canonical({...envelope,...(write?{requestId,expectedRevision}:{})})) as Record<string,unknown>;
    const invocation:Invocation={actor,projectId,permission:classification.permission,refresh};
    if(write){
      const admission={family,scope,operation:op,originalRequestId:requestId,originalIntentDigest:'sha256:'+digest(envelope),migrationDigest:binding.migrationDigest};
      // This is transport admission audit, never a second domain state machine
      // or a successful business receipt. The original family remains canonical.
      store.mutate(actor,{projectId,operation:'runtime.legacy.admit',requestId:'legacy-admit-'+digest({family,scope,requestId}),expectedRevision:store.revision(projectId),input:admission,permission:classification.permission},()=>({value:{...admission,originalExpectedRevision:expectedRevision,meaning:'TRANSPORT_ADMISSION_ONLY'},event:{type:'legacy-call-admitted',data:{...admission,originalExpectedRevision:expectedRevision}}}),refresh);
    }
    const action=invocations.run(invocation,async()=>{
      guard();
      try {
        switch(classification.family){
          case'request':{
            if(op==='run.dispatch'||op==='run.reconcile'){
              const value=record(original.input);exact(value,['id']);
              const args={scope:original.scope as Parameters<typeof legacy.dispatch>[0]['scope'],id:string(value.id),requestId:string(requestId),expectedRevision:Number(expectedRevision)};
              return await (op==='run.dispatch'?legacy.dispatch(args):legacy.reconcile(args));
            }
            return legacy.execute(original as unknown as Parameters<typeof legacy.execute>[0]);
          }
          case'native':return await legacy.native(original as unknown as Parameters<typeof legacy.native>[0]);
          case'planning':return await legacy.planning(original as unknown as Parameters<typeof legacy.planning>[0]);
          case'readiness':return await legacy.readiness(original as unknown as Parameters<typeof legacy.readiness>[0]);
          case'readable':return await legacy.readable(original as unknown as Parameters<typeof legacy.readable>[0]);
          case'feedback':return await legacy.feedback(original as unknown as Parameters<typeof legacy.feedback>[0]);
          case'online':return await legacy.online(original as unknown as Parameters<typeof legacy.online>[0]);
          case'response':return await legacy.response(original as unknown as Parameters<typeof legacy.response>[0]);
          case'reconstruction':return await legacy.reconstruction(original as unknown as Parameters<typeof legacy.reconstruction>[0]);
        }
      } catch(error) {
        if(error instanceof ServiceError)throw error;
        const code=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'&&/^[A-Z][A-Z0-9_]{1,79}$/.test(error.code)?error.code:'LEGACY_OPERATION_FAILED';
        // Preserve the domain error code without leaking filesystem/provider text.
        throw new ServiceError(code,'Original Runtime operation did not complete; inspect its existing receipt before retrying.',code.includes('NOT_FOUND')?404:409);
      }
    });
    pending.add(action);
    try {const result=await action;guardAfter(invocation);return result;}finally{pending.delete(action);}
  }
  function guardAfter(invocation:Invocation){invocations.run(invocation,guard);}
  return{inspect,intentSource(refresh:(actor:Principal)=>Principal):LegacyIntentSource{return{workspaceRoot:binding.workspaceRoot,workspaceId:binding.workspaceId,read:async(actor,projectId,request)=>{
    if(request.workspaceId!==binding.workspaceId||request.scope.projectId!==projectId)reject('LEGACY_SCOPE','Owner intent read belongs to another workspace/project',403);
    return await invoke(actor,projectId,LEGACY_READ,{family:'readiness',envelope:{operation:'readiness.intent.read',scope:request.scope,input:{standardVersion:'v2',digest:request.digest}}},undefined,undefined,()=>refresh(actor)) as ReadinessIntentRecord&{current:boolean};
  }};},read:(actor:Principal,projectId:string,input:Record<string,unknown>,refresh:()=>Principal)=>invoke(actor,projectId,LEGACY_READ,input,undefined,undefined,refresh),write:(actor:Principal,projectId:string,input:Record<string,unknown>,requestId:string,revision:number,refresh:()=>Principal)=>invoke(actor,projectId,LEGACY_WRITE,input,requestId,revision,refresh),async close(){closing=true;await Promise.allSettled([...pending]);legacy.close();}};
}
