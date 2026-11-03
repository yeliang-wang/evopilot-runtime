/** Optional local Host compatibility, never a Runtime HTTP adapter. Owner
 * methods execute in their exact published packages and retain their own
 * decisions/receipts. The bridge neither opens Runtime state nor implements
 * owner authoring algorithms or grants their semantic/publication approval. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {lstatSync,realpathSync,readFileSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {canonical,canonicalEvidence,digest,exact,record,reject,ServiceError,slug,string} from '../server/errors.js';
import {readPrivateJson} from '../server/security.js';
import {readLegacyBinding} from '../compat/gateway.js';
import {verifyOwnerDistribution,type Owner} from '../adapters/published-owners.js';
import {readRegisteredNativeToolchain,type NativeToolchainRegistration} from '../adapters/config.js';
import type {RuntimeHttpClient} from './client.js';
import {createLegacyOwnerProviders} from './legacy-owner-providers.js';
import {createProjectHostRoutes,PROJECT_CALLS,type ProjectHostSelection,type ProjectHostRoutes} from './project/routes.js';
import {canonicalPath,codeRoot} from '../compat/project/files.js';
import type {ProjectOwnerValidation} from '../compat/project/native-project.js';
import type {NativeProject} from '../native-types.js';
import {forwardLegacyRuntime} from './legacy-tools.js';
import {nativeBytesDigest,nativeSha256} from '../../vendor/compatibility/v1/native.mjs';
import {randomUUID} from 'node:crypto';
import {withWorkspaceLease} from '../compat/workspace-lease.js';

export type LegacyOwnerEntry='request'|'native';
interface Registration {packageRoot:string;calls:string[];}
interface Configuration {
  schema:'runtime-legacy-owner-host/v1';workspaceId:string;projectId:string;
  legacyBindingRef:string;expiresAt:string;owners:Record<Owner,Registration>;
  nativeToolchain?:NativeToolchainRegistration;
  project?:ProjectHostSelection;
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
  project?:{calls:string[];call(family:'native'|'workspace',operation:string,input:unknown,requestId?:string,signal?:AbortSignal):Promise<unknown>};
  close():Promise<void>;
}
export function readLegacyOwnerHostConfiguration(ref:string):Configuration {
  string(ref,4096);if(!isAbsolute(ref)||resolve(ref)!==ref||realpathSync(ref)!==ref)reject('OWNER_HOST_CONFIGURATION','Use an exact protected owner Host configuration');
  const value=record(readPrivateJson(ref));exact(value,['schema','workspaceId','projectId','legacyBindingRef','expiresAt','owners'],['nativeToolchain','project']);
  if(value.schema!=='runtime-legacy-owner-host/v1')reject('OWNER_HOST_CONFIGURATION','Unsupported owner Host configuration');
  slug(value.workspaceId);slug(value.projectId);string(value.legacyBindingRef,4096);
  const expires=Date.parse(string(value.expiresAt,128));if(!Number.isFinite(expires)||expires<=Date.now())reject('OWNER_HOST_EXPIRED','Owner Host registration has expired',403);
  const owners=record(value.owners);exact(owners,['ontology','harness']);
  for(const item of Object.values(owners)){
    const owner=record(item);exact(owner,['packageRoot','calls']);string(owner.packageRoot,4096);
    if(!Array.isArray(owner.calls)||!owner.calls.length||owner.calls.length>256||new Set(owner.calls).size!==owner.calls.length||owner.calls.some(call=>typeof call!=='string'||!/^(request|native):[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9_]*)+$/.test(call)))reject('OWNER_HOST_CONFIGURATION','Register exact historical owner calls, without wildcards');
  }
  if(value.project!==undefined){const project=record(value.project);exact(project,['root','calls']);canonicalPath(string(project.root,4096));const st=lstatSync(String(project.root));if(!st.isDirectory()||st.uid!==process.getuid!()||(st.mode&0o777)!==0o700)reject('OWNER_HOST_CONFIGURATION','Protected canonical project root required');if(!Array.isArray(project.calls)||!project.calls.length||new Set(project.calls).size!==project.calls.length||project.calls.some(v=>!PROJECT_CALLS.includes(String(v))))reject('OWNER_HOST_CONFIGURATION','Register exact historical project helper calls');}
  return value as unknown as Configuration;
}
function route(owner:Owner,entry:LegacyOwnerEntry,operation:string):{method:Method;catalog:string} {
  if(entry==='request')return{method:owner==='ontology'&&['classification.start','classification.reanalyze'].includes(operation)?'classify':'execute',catalog:'operations'};
  const prefixes:Record<string,{method:Method;catalog:string}>={readiness:{method:'readiness',catalog:'readinessOperations'},readable:{method:'readable',catalog:'readableOperations'},feedback:{method:'feedback',catalog:'feedbackOperations'},response:{method:'response',catalog:'responseOperations'},online:{method:'online',catalog:'onlineOperations'},usability:{method:'usability',catalog:'usabilityOperations'}};
  return prefixes[operation.split('.')[0]]??{method:'native',catalog:'nativeOperations'};
}
export async function openLegacyOwnerRoutes(configRef:string,client:RuntimeHttpClient,expectedDigest?:string):Promise<LegacyOwnerRoutes>{
  const config=readLegacyOwnerHostConfiguration(configRef),original=canonical(config),binding=readLegacyBinding(config.legacyBindingRef),bindingBytes=canonical(binding);
  if(expectedDigest!==undefined&&digest(config)!==expectedDigest)reject('OWNER_HOST_CHANGED','Owner Host configuration differs from the installed permission selection',409);
  if(config.workspaceId!==client.connection.workspaceId||config.projectId!==client.connection.projectId||binding.workspaceId!==config.workspaceId||binding.serviceId!==client.connection.serviceId)reject('OWNER_HOST_SCOPE','Owner Host and Runtime connection must share the exact migrated workspace/service/project',403);
  const services=new Map<Owner,OwnerService>(),factories=new Map<Owner,()=>OwnerService>(),capabilities=new Map<Owner,Record<string,unknown>>(),calls=new AsyncLocalStorage<Call>(),pending=new Set<Promise<unknown>>();let closing=false;
  let projectRoutes:ProjectHostRoutes|undefined;
  const validatorModules=new Map<Owner,Record<string,unknown>>();
  const currentToolchain=()=>config.nativeToolchain?readRegisteredNativeToolchain({schema:'runtime-integrations/v1',workspaceId:config.workspaceId,revision:1,platforms:[],credentials:[],owners:[],resources:[],nativeToolchain:config.nativeToolchain}):undefined;
  function hostError(error:unknown):ServiceError {if(error instanceof ServiceError)return error;const code=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'&&/^[A-Z_]{1,64}$/.test(error.code)?error.code:'OWNER_CALL_OUTCOME_UNKNOWN';return new ServiceError(code,'Inspect the original owner/project request before retrying; no automatic retry was made',409);}
  function fresh():void {
    if(closing)reject('CLOSED','Owner Host compatibility is closing',503);
    if(canonical(readLegacyOwnerHostConfiguration(configRef))!==original||canonical(readLegacyBinding(config.legacyBindingRef))!==bindingBytes)reject('OWNER_HOST_CHANGED','Reconnect after an explicit owner Host binding change',409);
    currentToolchain();
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
  function closeServices():void {let failure:unknown;for(const service of services.values())try{service.close();}catch(error){failure??=error;}services.clear();if(failure)throw failure;}
  async function scopedCall<T>(scope:Call['scope'],signal:AbortSignal|undefined,action:()=>Promise<T>|T):Promise<T>{
    return withWorkspaceLease({workspaceRoot:binding.workspaceRoot,workspaceId:config.workspaceId},'host-'+randomUUID(),async()=>{
      // A call queued behind maintenance must recheck the live service and
      // configuration before opening owners or performing any project write.
      await connected(signal);
      try{for(const [owner,factory]of factories){const service=factory();services.set(owner,service);service.initialize();}return await calls.run({scope,signal},action);}
      finally{closeServices();}
    },signal);
  }
  try{
    await connected();
    const toolchain=currentToolchain();
    if(config.project){
      const root=config.project.root;for(const other of [binding.workspaceRoot,codeRoot,...Object.values(config.owners).map(o=>o.packageRoot)])if(root===other||root.startsWith(other+'/')||other.startsWith(root+'/'))reject('OWNER_HOST_SCOPE','Project files must be separate from state and installation roots');
      const marker=record(readPrivateJson(join(root,'workspace-project.json')));if(marker.schema!=='evopilot-workspace-project/v1'||marker.id!==config.workspaceId)reject('OWNER_HOST_SCOPE','Project workspace identity differs from the selected migration');
    }
    for(const owner of ['ontology','harness'] as const){
      const packageRoot=config.owners[owner].packageRoot,identity=verifyOwnerDistribution(owner,packageRoot);
      for(const path of [join(binding.workspaceRoot,'workspace.json'),join(binding.workspaceRoot,'state',owner,owner+'.db')]){
        const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||realpathSync(path)!==path)reject('OWNER_NOT_INITIALIZED','Prepare the owner through its own workflow before enabling this compatibility entry');
      }
      const module=await import(pathToFileURL(join(packageRoot,'dist/service.js')).href) as Record<string,unknown>;
      if(config.project)validatorModules.set(owner,await import(pathToFileURL(join(packageRoot,'dist/index.js')).href) as Record<string,unknown>);
      const factory=module[owner==='ontology'?'createOntologyService':'createHarnessService'];if(typeof factory!=='function')reject('OWNER_CAPABILITY','Published owner public factory is missing');
      const providers=createLegacyOwnerProviders({workspaceId:config.workspaceId,projectId:config.projectId,client,guard:()=>{fresh();const context=calls.getStore();if(!context)reject('OWNER_HOST_SCOPE','Provider access requires a current Host call',403);return context;},readOwner:(other,envelope)=>invoke(other,'native',envelope,true),...(config.project?{readWorkspaceEvidence:(request:Parameters<ProjectHostRoutes['readWorkspaceEvidence']>[0])=>{if(!projectRoutes)reject('OWNER_HOST_SCOPE','Current project preparation required');return projectRoutes.readWorkspaceEvidence(request);}}:{})},owner);
      const admission=config.project?{resolveNativeAuthoring:(request:Parameters<ProjectHostRoutes['providers']['resolveNativeAuthoring']>[0])=>{fresh();if(!calls.getStore()||!projectRoutes||canonical(request.scope)!==canonical(calls.getStore()!.scope))reject('OWNER_HOST_SCOPE','Current project preparation required');return projectRoutes.providers.resolveNativeAuthoring(request);},resolveReadinessAuthoring:(request:Parameters<ProjectHostRoutes['providers']['resolveReadinessAuthoring']>[0])=>{fresh();if(!calls.getStore()||!projectRoutes||canonical(request.scope)!==canonical(calls.getStore()!.scope))reject('OWNER_HOST_SCOPE','Current project preparation required');return projectRoutes.providers.resolveReadinessAuthoring(request);}}:{};
      const make=()=>(factory as (options:{workspaceRoot:string;workspaceId:string},providers:Record<string,unknown>)=>OwnerService)({workspaceRoot:binding.workspaceRoot,workspaceId:config.workspaceId},{...providers,...admission,...(toolchain?{nativeToolchain:toolchain}:{})});factories.set(owner,make);
      const service=make();services.set(owner,service);
      const cap=record(service.capabilities());if(cap.product!==owner||cap.version!==identity.version)reject('OWNER_CAPABILITY','Published owner API identity differs from its verified package');capabilities.set(owner,cap);
      for(const call of config.owners[owner].calls){const at=call.indexOf(':'),operation=call.slice(at+1),selected=route(owner,call.slice(0,at) as LegacyOwnerEntry,operation);if(!Array.isArray(cap[selected.catalog])||!(cap[selected.catalog] as unknown[]).includes(operation)||typeof service[selected.method]!=='function')reject('OWNER_CAPABILITY','A registered call is not supported by the selected published owner');}
      // Construction/capability discovery is pure in these exact published
      // owners. Persist only inside a leased call and close before releasing it.
      service.close();services.delete(owner);
    }
    if(config.project){
      const current=()=>{fresh();const call=calls.getStore();if(!call)reject('OWNER_HOST_SCOPE','Current scoped project helper required');call.signal?.throwIfAborted();for(const owner of ['ontology','harness'] as const)verifyOwnerDistribution(owner,config.owners[owner].packageRoot);};
      function validator(owner:Owner,name:string):(...args:unknown[])=>unknown {const method=validatorModules.get(owner)?.[name];if(typeof method!=='function')reject('OWNER_CAPABILITY','Published owner validation API missing');return(...args)=>{current();return method(...args);};}
      const ownerValidation={validateOntologyPackage:validator('ontology','validateOntologyPackage'),inspectHarnessPackage:validator('harness','inspectHarnessPackage'),validateNativeOntology:validator('ontology','validateNativeOntology')} as ProjectOwnerValidation;
      // Preserve the original fixed local Node preparation. This only pins the
      // current interpreter and copies reviewed source; it dispatches no work.
      const executable=realpathSync(process.execPath),toolFiles=[{path:executable,sha256:nativeBytesDigest(readFileSync(executable)).slice(7)}];
      const toolchains={node:{toolchainLockDigest:nativeSha256(toolFiles),toolFiles,readRoots:[]}};
      projectRoutes=createProjectHostRoutes({projectRoot:config.project.root,stateRoot:binding.workspaceRoot,workspaceId:config.workspaceId},config.projectId,config.project,{ownerValidation,toolchains,...(toolchain?{nativeToolchain:()=>toolchain}:{}),readCompletedProject:async(scope,id)=>{current();const result=await forwardLegacyRuntime(client,'native',{operation:'project.inspect',scope,input:{id}},calls.getStore()?.signal);current();return result.result as NativeProject;}},current);
    }
    return{...(projectRoutes?{project:{calls:[...config.project!.calls],async call(family:'native'|'workspace',operation:string,value:unknown,requestId?:string,signal?:AbortSignal){
      fresh();const input=JSON.parse(canonicalEvidence(value)) as Record<string,unknown>,scope=family==='native'?guardScope(operation==='preflight'?record(input.project).scope:input.scope):guardScope({projectId:input.projectId,visibility:'private'});
      const task=scopedCall(scope,signal,()=>family==='native'?projectRoutes!.native(operation,input):projectRoutes!.workspace(operation,input,string(requestId,64)));pending.add(task);try{return await task;}catch(error){throw hostError(error);}finally{pending.delete(task);}
    }}}:{}),capabilities(){fresh();return{schema:'runtime-legacy-owner-host-capabilities/v1',workspaceId:config.workspaceId,projectId:config.projectId,owners:Object.fromEntries((['ontology','harness'] as const).map(owner=>[owner,{version:capabilities.get(owner)!.version,calls:[...config.owners[owner].calls]}])),projectCalls:config.project?.calls??[],transport:'local-published-owner-api',runtimeHttpAuthoring:false,semanticApproval:false,softwareRelease:false};},
      async call(owner,entry,value,signal){
        if(!['ontology','harness'].includes(owner)||!['request','native'].includes(entry))reject('OWNER_HOST_SCOPE','Unknown historical owner entry');
        fresh();const envelope=JSON.parse(canonicalEvidence(value)) as Record<string,unknown>;exact(envelope,['operation','scope','input'],['requestId','expectedRevision']);record(envelope.input);const scope=guardScope(envelope.scope),operation=string(envelope.operation,128);
        if(!config.owners[owner].calls.includes(entry+':'+operation))reject('OWNER_HOST_CALL_FORBIDDEN','This owner call is not included in the protected Host registration',403);
        if(Object.hasOwn(envelope,'requestId')!==Object.hasOwn(envelope,'expectedRevision'))reject('INVALID_FIELDS','Owner writes retain both original request ID and owner revision');
        if(Object.hasOwn(envelope,'requestId')){string(envelope.requestId,128);if(!Number.isSafeInteger(envelope.expectedRevision)||Number(envelope.expectedRevision)<0)reject('INVALID_REVISION','Owner revision must be an original nonnegative integer');}
        const task=scopedCall(scope,signal,()=>invoke(owner,entry,envelope));pending.add(task);
        try{return await task;}catch(error){throw hostError(error);}finally{pending.delete(task);}
      },async close(){if(closing)return;closing=true;await Promise.allSettled([...pending]);closeServices();},
    };
  }catch(error){closeServices();throw error;}
}
