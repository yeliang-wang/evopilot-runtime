/** Optional local Host compatibility, never a Runtime HTTP adapter. Owner
 * methods execute in their exact published packages and retain their own
 * decisions/receipts. The bridge neither opens Runtime state nor implements
 * owner authoring algorithms or grants their semantic/publication approval. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {lstatSync,realpathSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {canonical,canonicalEvidence,exact,record,reject,ServiceError,slug,string} from '../server/errors.js';
import {readPrivateJson} from '../server/security.js';
import {readLegacyBinding} from '../compat/gateway.js';
import {verifyOwnerDistribution,type Owner} from '../adapters/published-owners.js';
import {readRegisteredNativeToolchain,type NativeToolchainRegistration} from '../adapters/config.js';
import type {RuntimeHttpClient} from './client.js';
import {createLegacyOwnerProviders} from './legacy-owner-providers.js';

export type LegacyOwnerEntry='request'|'native';
interface Registration {packageRoot:string;calls:string[];}
interface Configuration {
  schema:'runtime-legacy-owner-host/v1';workspaceId:string;projectId:string;
  legacyBindingRef:string;expiresAt:string;owners:Record<Owner,Registration>;
  nativeToolchain?:NativeToolchainRegistration;
}
type Method='execute'|'classify'|'native'|'readiness'|'readable'|'feedback'|'response'|'online'|'usability';
interface OwnerService {
  initialize():unknown;close():void;capabilities():unknown;
  execute:(request:unknown)=>unknown;native:(request:unknown)=>Promise<unknown>;
  classify?:(request:unknown)=>Promise<unknown>;readiness?:(request:unknown)=>Promise<unknown>;
  readable?:(request:unknown)=>Promise<unknown>;feedback?:(request:unknown)=>Promise<unknown>;
  response?:(request:unknown)=>Promise<unknown>;online?:(request:unknown)=>Promise<unknown>;
  usability?:(request:unknown)=>Promise<unknown>;
}
interface Call {scope:{visibility:'public'|'private';projectId:string};signal?:AbortSignal;}
export interface LegacyOwnerRoutes {
  capabilities():unknown;
  call(owner:Owner,entry:LegacyOwnerEntry,envelope:unknown,signal?:AbortSignal):Promise<unknown>;
  close():Promise<void>;
}
function configuration(ref:string):Configuration {
  string(ref,4096);if(!isAbsolute(ref)||resolve(ref)!==ref||realpathSync(ref)!==ref)reject('OWNER_HOST_CONFIGURATION','Use an exact protected owner Host configuration');
  const value=record(readPrivateJson(ref));exact(value,['schema','workspaceId','projectId','legacyBindingRef','expiresAt','owners'],['nativeToolchain']);
  if(value.schema!=='runtime-legacy-owner-host/v1')reject('OWNER_HOST_CONFIGURATION','Unsupported owner Host configuration');
  slug(value.workspaceId);slug(value.projectId);string(value.legacyBindingRef,4096);
  const expires=Date.parse(string(value.expiresAt,128));if(!Number.isFinite(expires)||expires<=Date.now())reject('OWNER_HOST_EXPIRED','Owner Host registration has expired',403);
  const owners=record(value.owners);exact(owners,['ontology','harness']);
  for(const item of Object.values(owners)){
    const owner=record(item);exact(owner,['packageRoot','calls']);string(owner.packageRoot,4096);
    if(!Array.isArray(owner.calls)||!owner.calls.length||owner.calls.length>256||new Set(owner.calls).size!==owner.calls.length||owner.calls.some(call=>typeof call!=='string'||!/^(request|native):[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9_]*)+$/.test(call)))reject('OWNER_HOST_CONFIGURATION','Register exact historical owner calls, without wildcards');
  }
  return value as unknown as Configuration;
}
function route(owner:Owner,entry:LegacyOwnerEntry,operation:string):{method:Method;catalog:string} {
  if(entry==='request')return{method:owner==='ontology'&&['classification.start','classification.reanalyze'].includes(operation)?'classify':'execute',catalog:'operations'};
  const prefixes:Record<string,{method:Method;catalog:string}>={readiness:{method:'readiness',catalog:'readinessOperations'},readable:{method:'readable',catalog:'readableOperations'},feedback:{method:'feedback',catalog:'feedbackOperations'},response:{method:'response',catalog:'responseOperations'},online:{method:'online',catalog:'onlineOperations'},usability:{method:'usability',catalog:'usabilityOperations'}};
  return prefixes[operation.split('.')[0]]??{method:'native',catalog:'nativeOperations'};
}
export async function openLegacyOwnerRoutes(configRef:string,client:RuntimeHttpClient):Promise<LegacyOwnerRoutes>{
  const config=configuration(configRef),original=canonical(config),binding=readLegacyBinding(config.legacyBindingRef),bindingBytes=canonical(binding);
  if(config.workspaceId!==client.connection.workspaceId||config.projectId!==client.connection.projectId||binding.workspaceId!==config.workspaceId||binding.serviceId!==client.connection.serviceId)reject('OWNER_HOST_SCOPE','Owner Host and Runtime connection must share the exact migrated workspace/service/project',403);
  const services=new Map<Owner,OwnerService>(),capabilities=new Map<Owner,Record<string,unknown>>(),calls=new AsyncLocalStorage<Call>(),pending=new Set<Promise<unknown>>();let closing=false;
  function fresh():void {
    if(closing)reject('CLOSED','Owner Host compatibility is closing',503);
    if(canonical(configuration(configRef))!==original||canonical(readLegacyBinding(config.legacyBindingRef))!==bindingBytes)reject('OWNER_HOST_CHANGED','Reconnect after an explicit owner Host binding change',409);
  }
  async function connected(signal?:AbortSignal):Promise<void>{
    fresh();const identity=record((await client.status(signal)).result),legacy=record(identity.legacy);
    if(identity.serviceId!==binding.serviceId||identity.workspaceId!==binding.workspaceId||legacy.bound!==true||legacy.migrationDigest!==binding.migrationDigest)reject('OWNER_HOST_SCOPE','The selected Runtime migration is not currently connected',409);fresh();
  }
  function guardScope(scope:unknown):Call['scope'] {
    const value=record(scope);exact(value,['visibility','projectId']);
    if(!['private','public'].includes(String(value.visibility))||value.projectId!==config.projectId)reject('OWNER_HOST_SCOPE','Owner request must remain in its registered project',403);
    return value as unknown as Call['scope'];
  }
  async function invoke(owner:Owner,entry:LegacyOwnerEntry,envelope:Record<string,unknown>,dependency=false):Promise<unknown>{
    fresh();const context=calls.getStore();if(!context)reject('OWNER_HOST_SCOPE','An active scoped Host call is required',403);
    context.signal?.throwIfAborted();const scope=record(envelope.scope);
    if(dependency){if(scope.visibility!=='public'&&canonical(scope)!==canonical(context.scope)||scope.visibility==='public'&&scope.projectId!==config.projectId&&scope.projectId!=='shared')reject('OWNER_HOST_SCOPE','Dependency scope differs from the current owner call',403);}
    else guardScope(scope);
    verifyOwnerDistribution(owner,config.owners[owner].packageRoot);
    const operation=string(envelope.operation,128),selected=route(owner,entry,operation),service=services.get(owner),cap=capabilities.get(owner);
    const supported=cap?.[selected.catalog];if(!service||!Array.isArray(supported)||!supported.includes(operation)||typeof service[selected.method]!=='function')reject('OWNER_CAPABILITY','Selected published owner does not support this historical call',409);
    const value=await service[selected.method]!(envelope);fresh();context.signal?.throwIfAborted();return value;
  }
  try{
    await connected();
    const toolchain=config.nativeToolchain?readRegisteredNativeToolchain({schema:'runtime-integrations/v1',workspaceId:config.workspaceId,revision:1,platforms:[],credentials:[],owners:[],resources:[],nativeToolchain:config.nativeToolchain}):undefined;
    for(const owner of ['ontology','harness'] as const){
      const packageRoot=config.owners[owner].packageRoot,identity=verifyOwnerDistribution(owner,packageRoot);
      for(const path of [join(binding.workspaceRoot,'workspace.json'),join(binding.workspaceRoot,'state',owner,owner+'.db')]){
        const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||realpathSync(path)!==path)reject('OWNER_NOT_INITIALIZED','Prepare the owner through its own workflow before enabling this compatibility entry');
      }
      const module=await import(pathToFileURL(join(packageRoot,'dist/service.js')).href) as Record<string,unknown>;
      const factory=module[owner==='ontology'?'createOntologyService':'createHarnessService'];if(typeof factory!=='function')reject('OWNER_CAPABILITY','Published owner public factory is missing');
      const providers=createLegacyOwnerProviders({workspaceId:config.workspaceId,projectId:config.projectId,client,guard:()=>{fresh();const context=calls.getStore();if(!context)reject('OWNER_HOST_SCOPE','Provider access requires a current Host call',403);return context;},readOwner:(other,envelope)=>invoke(other,'native',envelope,true)},owner);
      const service=(factory as (options:{workspaceRoot:string;workspaceId:string},providers:Record<string,unknown>)=>OwnerService)({workspaceRoot:binding.workspaceRoot,workspaceId:config.workspaceId},{...providers,...(toolchain?{nativeToolchain:toolchain}:{})});services.set(owner,service);
      const cap=record(service.capabilities());if(cap.product!==owner||cap.version!==identity.version)reject('OWNER_CAPABILITY','Published owner API identity differs from its verified package');capabilities.set(owner,cap);
      for(const call of config.owners[owner].calls){const at=call.indexOf(':'),operation=call.slice(at+1),selected=route(owner,call.slice(0,at) as LegacyOwnerEntry,operation);if(!Array.isArray(cap[selected.catalog])||!(cap[selected.catalog] as unknown[]).includes(operation)||typeof service[selected.method]!=='function')reject('OWNER_CAPABILITY','A registered call is not supported by the selected published owner');}
      service.initialize();
    }
    return{capabilities(){fresh();return{schema:'runtime-legacy-owner-host-capabilities/v1',workspaceId:config.workspaceId,projectId:config.projectId,owners:Object.fromEntries((['ontology','harness'] as const).map(owner=>[owner,{version:capabilities.get(owner)!.version,calls:[...config.owners[owner].calls]}])),transport:'local-published-owner-api',runtimeHttpAuthoring:false,semanticApproval:false,softwareRelease:false};},
      async call(owner,entry,value,signal){
        if(!['ontology','harness'].includes(owner)||!['request','native'].includes(entry))reject('OWNER_HOST_SCOPE','Unknown historical owner entry');
        fresh();const envelope=JSON.parse(canonicalEvidence(value)) as Record<string,unknown>;exact(envelope,['operation','scope','input'],['requestId','expectedRevision']);record(envelope.input);const scope=guardScope(envelope.scope),operation=string(envelope.operation,128);
        if(!config.owners[owner].calls.includes(entry+':'+operation))reject('OWNER_HOST_CALL_FORBIDDEN','This owner call is not included in the protected Host registration',403);
        if(Object.hasOwn(envelope,'requestId')!==Object.hasOwn(envelope,'expectedRevision'))reject('INVALID_FIELDS','Owner writes retain both original request ID and owner revision');
        if(Object.hasOwn(envelope,'requestId')){string(envelope.requestId,128);if(!Number.isSafeInteger(envelope.expectedRevision)||Number(envelope.expectedRevision)<0)reject('INVALID_REVISION','Owner revision must be an original nonnegative integer');}
        const task=(async()=>{await connected(signal);return calls.run({scope,signal},()=>invoke(owner,entry,envelope));})();pending.add(task);
        try{return await task;}catch(error){if(error instanceof ServiceError)throw error;const code=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'&&/^[A-Z_]{1,64}$/.test(error.code)?error.code:'OWNER_CALL_OUTCOME_UNKNOWN';throw new ServiceError(code,'Inspect the original owner request/receipt before retrying; no automatic retry was made',409);}finally{pending.delete(task);}
      },async close(){if(closing)return;closing=true;await Promise.allSettled([...pending]);for(const service of services.values())service.close();},
    };
  }catch(error){for(const service of services.values())service.close();throw error;}
}
