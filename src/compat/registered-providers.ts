import {lstatSync,realpathSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {canonical,digest,exact,record,reject,slug,string} from '../server/errors.js';
import {readPrivateJson,authorize} from '../server/security.js';
import {readLegacyBinding} from './gateway.js';
import type {LegacyProviderFactory,LegacyProviderContext} from './provider-context.js';
import {openPublishedOwner,openPublishedOwnerInspectors,type Owner,type PublishedOwnerAdapter,type OwnerIntentReader} from '../adapters/published-owners.js';
import {readRegisteredNativeToolchain,type NativeToolchainRegistration} from '../adapters/config.js';
import {createNativeProjectService} from './project/native-project.js';
import {canonicalPath,codeRoot,pinnedFile} from './project/files.js';
import {createLocalCollector} from './collection/local.js';
import {createLegacyNativeProviders} from './native-providers.js';
import type {NativeScope,ReadinessIntentRecord} from '../service.js';

interface Configuration {
 schema:'runtime-legacy-providers/v1';workspaceId:string;projects:string[];
 legacyBindingRef:string;projectRoot:string;expiresAt:string;
 owners:Record<Owner,{packageRoot:string}>;nativeToolchain:NativeToolchainRegistration;
 collection?:{kind:'node';executable:string;sha256:string};
}
export function readLegacyProviderConfiguration(ref:string):Configuration{
 canonicalPath(ref);const v=record(readPrivateJson(ref));exact(v,['schema','workspaceId','projects','legacyBindingRef','projectRoot','expiresAt','owners','nativeToolchain'],['collection']);
 if(v.schema!=='runtime-legacy-providers/v1')reject('LEGACY_PROVIDER_CONFIGURATION','Unknown original provider registration');slug(v.workspaceId);
 if(!Array.isArray(v.projects)||!v.projects.length||v.projects.length>1000||new Set(v.projects).size!==v.projects.length)reject('LEGACY_PROVIDER_CONFIGURATION','Exact registered projects required');v.projects.forEach(slug);
 // Installation may select this configuration before the migration binding
 // exists. Opening providers still requires readLegacyBinding's exact seal.
 const bindingRef=string(v.legacyBindingRef,4096);if(!isAbsolute(bindingRef)||resolve(bindingRef)!==bindingRef)reject('LEGACY_PROVIDER_CONFIGURATION','Canonical migration binding path required');
 canonicalPath(string(v.projectRoot,4096));const st=lstatSync(String(v.projectRoot));if(!st.isDirectory()||st.uid!==process.getuid!()||(st.mode&0o777)!==0o700)reject('LEGACY_PROVIDER_CONFIGURATION','Protected project root required');
 if(!Number.isFinite(Date.parse(string(v.expiresAt,128)))||Date.parse(String(v.expiresAt))<=Date.now())reject('LEGACY_PROVIDER_EXPIRED','Original provider registration has expired',403);
 const owners=record(v.owners);exact(owners,['ontology','harness']);for(const owner of Object.values(owners)){exact(record(owner),['packageRoot']);canonicalPath(string(record(owner).packageRoot,4096));}
 if(v.collection!==undefined){const c=record(v.collection);exact(c,['kind','executable','sha256']);if(c.kind!=='node'||canonicalPath(c.executable)!==realpathSync(process.execPath)||!/^[a-f0-9]{64}$/.test(string(c.sha256,64)))reject('LEGACY_COLLECTION_TOOLCHAIN','Only the exact current Node interpreter may be registered');pinnedFile(String(c.executable),String(c.sha256));}
 return v as unknown as Configuration;
}
/** Local process registration. It supplies original Runtime consumers only;
 * it does not expose owner authoring, choose a Run or approve a claim. */
export async function openRegisteredLegacyProviders(ref:string,expectedBindingRef:string,workspaceId:string,expectedDigest?:string):Promise<{bind:LegacyProviderFactory;close():void}>{
 const config=readLegacyProviderConfiguration(ref),original=canonical(config);
 if(expectedDigest!==undefined&&(!/^[a-f0-9]{64}$/.test(expectedDigest)||digest(config)!==expectedDigest))reject('LEGACY_PROVIDER_CHANGED','Original provider selection differs from the explicit startup pin',409);
 const binding=readLegacyBinding(config.legacyBindingRef),originalBinding=canonical(binding);
 if(config.legacyBindingRef!==expectedBindingRef||config.workspaceId!==workspaceId||binding.workspaceId!==workspaceId)reject('LEGACY_PROVIDER_SCOPE','Provider registration must bind this exact service migration',403);
 for(const other of [binding.workspaceRoot,codeRoot,...Object.values(config.owners).map(o=>o.packageRoot)])if(config.projectRoot===other||config.projectRoot.startsWith(other+'/')||other.startsWith(config.projectRoot+'/'))reject('LEGACY_PROVIDER_SCOPE','Project root overlaps service or product state');
 let context:LegacyProviderContext|undefined,closed=false;const owners={} as Record<Owner,PublishedOwnerAdapter>;
 const registeredToolchain=()=>readRegisteredNativeToolchain({schema:'runtime-integrations/v1',workspaceId,revision:1,platforms:[],credentials:[],owners:[],resources:[],nativeToolchain:config.nativeToolchain});
 function fresh(){
  if(closed)reject('CLOSED','Original provider composition is closed',503);
  // Node bytes are verified by the collector immediately before execution and
  // receipt readback; avoid rehashing an interpreter in every polling guard.
  const v=readPrivateJson(ref);if(canonical(v)!==original||canonical(readLegacyBinding(config.legacyBindingRef))!==originalBinding)reject('LEGACY_PROVIDER_CHANGED','Reconnect after an explicit original provider change',409);
  if(Date.parse(config.expiresAt)<=Date.now())reject('LEGACY_PROVIDER_EXPIRED','Original provider registration has expired',403);registeredToolchain();
  canonicalPath(config.projectRoot);const st=lstatSync(config.projectRoot),marker=record(readPrivateJson(join(config.projectRoot,'workspace-project.json')));if(!st.isDirectory()||st.uid!==process.getuid!()||(st.mode&0o777)!==0o700||marker.schema!=='evopilot-workspace-project/v1'||marker.id!==workspaceId)reject('LEGACY_PROVIDER_SCOPE','Project workspace identity changed',403);
 }
 function current(scope?:NativeScope){fresh();if(!context)reject('LEGACY_CONTEXT_REQUIRED','Provider access requires the original authenticated invocation',403);const c=context.current();if(!config.projects.includes(c.projectId)||scope&&(scope.projectId!==c.projectId||!['private','public'].includes(scope.visibility)))reject('LEGACY_PROVIDER_SCOPE','Provider access is outside registered project scope',403);return c;}
 try{
  fresh();const toolchain=registeredToolchain(),inspectors={ontology:await openPublishedOwnerInspectors('ontology',config.owners.ontology.packageRoot),harness:await openPublishedOwnerInspectors('harness',config.owners.harness.packageRoot)};
  const readIntent:OwnerIntentReader=async(actor,projectId,request)=>{const c=current(request.scope);if(request.workspaceId!==workspaceId||c.actor.id!==actor.id||c.actor.revision!==actor.revision||c.projectId!==projectId)reject('LEGACY_PROVIDER_SCOPE','Owner intent read differs from the authenticated call',403);const value=await context!.read('readiness',{operation:'readiness.intent.read',scope:request.scope,input:{standardVersion:'v2',digest:request.digest}});current(request.scope);return value as ReadinessIntentRecord&{current:boolean};};
  for(const owner of ['ontology','harness'] as const)owners[owner]=await openPublishedOwner({owner,packageRoot:config.owners[owner].packageRoot,workspaceRoot:binding.workspaceRoot,workspaceId,projects:config.projects},toolchain,owner==='harness'?owners.ontology:undefined,readIntent);
  return{bind(c){if(context)reject('LEGACY_PROVIDER_BOUND','A provider composition belongs to one service gateway');context=c;fresh();const project=createNativeProjectService({projectRoot:config.projectRoot,stateRoot:binding.workspaceRoot,workspaceId},{assertCurrent:()=>{current();}});
    const collector=config.collection?createLocalCollector({assertCurrent:()=>{const c=current();authorize(c.actor,c.projectId,'execution.request');},resolveExecution:claim=>{current(claim.scope);if(claim.workspace.id!==workspaceId||claim.workspace.canonicalRoot!==binding.workspaceRoot)reject('LEGACY_PROVIDER_SCOPE','Original collection workspace differs');const execution=project.resolveExecution(claim),allowed=config.collection!;if(execution.toolFiles.length!==1||execution.toolFiles[0].path!==allowed.executable||execution.toolFiles[0].sha256!==allowed.sha256||execution.readRoots.length)reject('LEGACY_COLLECTION_TOOLCHAIN','Collection differs from the explicitly registered Node closure');return execution;}}):undefined;
    return{...createLegacyNativeProviders({workspaceId,workspaceRoot:binding.workspaceRoot,expiresAt:config.expiresAt,toolchain,owners,standards:{ontology:inspectors.ontology.standardPins,harness:inspectors.harness.standardPins},parameters:inspectors.harness.parameters,current,context:c}),inspectSource:request=>{current(request.scope);return project.inspectSource(request);},resolveRequirements:request=>{current(request.scope);return project.resolveRequirements(request);},verifyProject:request=>{current(request.project.scope);return project.verifyProject(request);},...collector};
  },close(){if(closed)return;closed=true;for(const owner of Object.values(owners))owner.close();}};
 }catch(error){for(const owner of Object.values(owners))owner.close();throw error;}
}
