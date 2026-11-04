/** Passive material for binding bundled native dependencies to an installed
 * service. Applying the exact material is a separate stopped local operation.
 * A rendered document, digest or successful cache inspection grants no authority. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonical,canonicalEvidence,digest,exact,record,reject} from '../../server/errors.js';
import {readPrivateJson} from '../../server/security.js';
import {readRegular} from '../../compat/project/files.js';
import {readIntegrationConfiguration,type NativeToolchainRegistration} from '../../adapters/config.js';
import {readLegacyProviderConfiguration} from '../../compat/registered-providers.js';
import {readLegacyOwnerHostConfiguration} from '../../host/legacy-owners.js';
import {readWorkspaceOperatorConfiguration} from '../../host/workspace.js';
import {readWorkspaceSetupConfiguration} from '../../host/setup.js';
import {runtimePluginMaterial,type LegacyPluginSelection} from '../../host/plugin.js';
import {inspectInstalledServiceSelection,type InstalledServiceSelection} from '../service-control.js';
import {renderUserServicePlist,type UserServiceSpecification} from '../service.js';
import {inspectNativeToolchain} from './locked.js';
import type {NativeToolchain} from '../../../vendor/compatibility/v1/native.mjs';

export interface ToolchainRegistrationPatch {path:string;before:string|null;after:string;content:string;}
export interface ToolchainRegistrationMaterial {
  schema:'runtime-toolchain-registration-material/v1';selection:InstalledServiceSelection;
  registration:NativeToolchainRegistration;sourcePins:Record<string,string>;
  hostBefore:LegacyPluginSelection;hostAfter:LegacyPluginSelection;
  specification:UserServiceSpecification;patches:ToolchainRegistrationPatch[];
  dependenciesVerified:boolean;authority:false;filesWritten:false;serviceStarted:false;
  hostReconnectRequired:true;materialDigest:string;
}
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const changed=():never=>reject('TOOLCHAIN_BINDING_CHANGED','Current installed configuration differs from its selected package, scope or grants',409);
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const jsonBytes=(value:unknown)=>canonical(value)+'\n';
const hash=(value:unknown)=>{if(typeof value!=='string'||!/^sha256:[a-f0-9]{64}$/.test(value))changed();};

/** Rendering accepts a supplied description for review/testing only. It never
 * marks dependency bytes verified and cannot install or activate this material.
 * The production selector below derives it solely from the bundled locked cache. */
export function renderInstalledToolchainRegistration(serviceRoot:string,toolchain:NativeToolchain):ToolchainRegistrationMaterial {
  const selection=inspectInstalledServiceSelection(serviceRoot),binding=selection.binding;
  if(!binding)reject('TOOLCHAIN_BINDING_UNBOUND','Bind the installed service to its Workspace before selecting native validators',409);
  const pins={...selection.configurationPins};
  const read=<T>(ref:string,reader:(ref:string)=>T):T=>{
    const before=sha(readRegular(ref,8388608,true));if(pins[ref]&&pins[ref]!==before)changed();
    const value=reader(ref);if(sha(readRegular(ref,8388608,true))!==before)changed();pins[ref]=before;return value;
  };
  const json=(ref:string)=>read(ref,readPrivateJson);
  const spec=json(path.join(serviceRoot,'service-specification.json')) as UserServiceSpecification;
  const plugin=record(json(path.join(serviceRoot,'plugin/.mcp.json'))),servers=record(plugin.mcpServers),legacy=record(servers.evopilot_runtime_legacy);
  exact(legacy,['type','command','args']);
  if(legacy.type!=='stdio'||legacy.command!==spec.nodeExecutable||!Array.isArray(legacy.args)||legacy.args.some(v=>typeof v!=='string'))changed();
  const args=legacy.args as string[],options:Record<string,string>={};
  for(let i=1;i<args.length;i++){
    const key=args[i];if(Object.hasOwn(options,key))changed();
    if(key==='--legacy-only')options[key]='true';else{if(!args[i+1]||args[i+1].startsWith('--'))changed();options[key]=args[++i];}
  }
  if(options['--connection-ref']!==path.join(serviceRoot,'connection.json')||options['--legacy-only']!=='true')changed();
  const before:LegacyPluginSelection={};
  for(const [flag,refKey,digestKey] of [['owner','ownerConfigRef','ownerConfigDigest'],['operator','workspaceConfigRef','workspaceConfigDigest'],['setup','setupConfigRef','setupConfigDigest']] as const){
    const ref=options['--'+flag+'-config-ref'],pin=options['--'+flag+'-config-digest'];
    if(Boolean(ref)!==Boolean(pin))changed();if(ref){before[refKey]=ref;before[digestKey]=pin;}
  }
  if(before.setupConfigRef){
    if(before.ownerConfigRef||before.workspaceConfigRef)changed();
    const setup=read(before.setupConfigRef,readWorkspaceSetupConfiguration);
    if(digest(setup)!==before.setupConfigDigest||setup.installationPlanDigest!==selection.installationPlanDigest||setup.connectionDigest!==selection.connectionDigest||setup.serviceRoot!==serviceRoot||setup.workspaceRoot!==binding.workspaceRoot||setup.workspaceId!==binding.workspaceId||setup.serviceId!==binding.serviceId||Date.parse(setup.expiresAt)<=Date.now())changed();
    if(setup.ownerHost){before.ownerConfigRef=setup.ownerHost.ref;before.ownerConfigDigest=setup.ownerHost.digest;}
    if(setup.workspaceOperator){
      const ref=path.join(serviceRoot,'workspace-operator.json'),operator=read(ref,readWorkspaceOperatorConfiguration);
      const grant={projectRoot:operator.selection.projectRoot,referenceFiles:operator.selection.referenceFiles,owners:operator.owners,calls:operator.calls,expiresAt:operator.expiresAt};
      if(!same(grant,setup.workspaceOperator))changed();before.workspaceConfigRef=ref;before.workspaceConfigDigest=digest(operator);
    }
  }
  const owner=before.ownerConfigRef?read(before.ownerConfigRef,readLegacyOwnerHostConfiguration):null;
  const operator=before.workspaceConfigRef?read(before.workspaceConfigRef,readWorkspaceOperatorConfiguration):null;
  if(owner&&(digest(owner)!==before.ownerConfigDigest||owner.legacyBindingRef!==spec.legacyRef||owner.workspaceId!==spec.workspaceId||owner.projectId!==spec.projectId))changed();
  if(operator&&(digest(operator)!==before.workspaceConfigDigest||operator.specificationDigest!==digest(spec)||Date.parse(operator.expiresAt)<=Date.now()||operator.selection.workspaceRoot!==binding.workspaceRoot||operator.selection.migrationDigest!==binding.migrationDigest))changed();
  // Regeneration validates all recognized arguments and static plugin bytes;
  // extra flags/changed HTTP helper/foreign wrapper paths are never inherited.
  const original=runtimePluginMaterial(spec.packageRoot,path.join(serviceRoot,'connection.json'),spec.nodeExecutable,before);
  for(const [relative,bytes] of original.files)if(sha(read(path.join(serviceRoot,'plugin',relative),p=>readRegular(p,65536,true)))!==sha(bytes))changed();
  const cache=path.join(binding.workspaceRoot,'native-toolchain');
  hash(toolchain.lockDigest);hash(toolchain.dependencyLockDigest);
  const environmentRoot=toolchain.environmentRoot,dependencyFiles=toolchain.dependencyFiles;
  if(toolchain.schema!=='evopilot-native-toolchain/v1'||toolchain.platform!==process.platform||toolchain.arch!==process.arch||typeof environmentRoot!=='string'||!environmentRoot.startsWith(cache+'/')||!Array.isArray(dependencyFiles)||!dependencyFiles.length)return changed();
  for(const ref of [...Object.values(toolchain.tools).map(t=>t.executable),...dependencyFiles.map(f=>f.path)])if(!path.isAbsolute(ref)||path.resolve(ref)!==ref||!ref.startsWith(environmentRoot+'/'))changed();
  const patches:ToolchainRegistrationPatch[]=[];
  const add=(relative:string,content:string)=>{
    const ref=path.join(serviceRoot,relative),after=sha(content),previous=fs.existsSync(ref)?read(ref,p=>sha(readRegular(p,8388608,true))):null;
    if(previous!==null&&!['plugin/.mcp.json','service.plist','service-specification.json'].includes(relative)&&previous!==after)changed();
    patches.push({path:relative,before:previous,after,content});return ref;
  };
  const document=(kind:string,value:unknown)=>{
    // Native manifests are local protected files, not public request bodies.
    // Preserve the existing owner reader's 2 MiB bound and the 256 KiB public
    // request/configuration profile; never raise the shared request limit.
    const text=kind==='toolchain'?canonicalEvidence(value):canonical(value),content=text+'\n';
    if(kind==='toolchain'&&Buffer.byteLength(content)>2097152)reject('TOOLCHAIN_BINDING_LIMIT','Native manifest exceeds the existing owner reader profile',413);
    return add('native-'+kind+'-'+sha(text)+'.json',content);
  };
  const manifest=document('toolchain',toolchain),registration={path:manifest,digest:'sha256:'+sha(canonicalEvidence(toolchain)+'\n'),lockDigest:toolchain.lockDigest};
  const specification={...spec},after:LegacyPluginSelection={};
  if(spec.integrationsRef!==null){
    const config=read(spec.integrationsRef,ref=>readIntegrationConfiguration(ref,spec.workspaceId));
    if(!Number.isSafeInteger(config.revision+1))changed();
    specification.integrationsRef=document('integrations',{...config,revision:config.revision+1,nativeToolchain:registration});
  }
  if(spec.legacyProviders){
    const config=read(spec.legacyProviders.ref,readLegacyProviderConfiguration);
    if(digest(config)!==spec.legacyProviders.digest||config.legacyBindingRef!==spec.legacyRef||config.workspaceId!==spec.workspaceId||!config.projects.includes(spec.projectId))changed();
    const next={...config,nativeToolchain:registration};specification.legacyProviders={ref:document('providers',next),digest:digest(next)};
  }
  if(owner){const next={...owner,nativeToolchain:registration};after.ownerConfigRef=document('owner-host',next);after.ownerConfigDigest=digest(next);}
  if(operator){
    const next={...operator,specificationDigest:digest(specification),ownerHost:{...after}};
    after.workspaceConfigRef=document('workspace-operator',next);after.workspaceConfigDigest=digest(next);
  }
  if(!owner&&!spec.legacyProviders&&spec.integrationsRef===null)reject('TOOLCHAIN_BINDING_UNUSED','Select an existing owner or service integration before registering validators',409);
  const nextArgs=[path.join(spec.packageRoot,after.workspaceConfigRef?'dist/installation/workspace-host.js':'dist/host/bridge.js'),'--connection-ref',path.join(serviceRoot,'connection.json'),'--legacy-only'];
  if(after.ownerConfigRef)nextArgs.push('--owner-config-ref',after.ownerConfigRef,'--owner-config-digest',after.ownerConfigDigest!);
  if(after.workspaceConfigRef)nextArgs.push('--operator-config-ref',after.workspaceConfigRef,'--operator-config-digest',after.workspaceConfigDigest!);
  add('plugin/.mcp.json',jsonBytes({mcpServers:{evopilot_runtime:servers.evopilot_runtime,evopilot_runtime_legacy:{type:'stdio',command:spec.nodeExecutable,args:nextArgs}}}));
  add('service.plist',renderUserServicePlist(specification));add('service-specification.json',jsonBytes(specification));
  for(const [ref,pin] of Object.entries(pins))if(sha(readRegular(ref,8388608,true))!==pin)changed();
  if(!same(inspectInstalledServiceSelection(serviceRoot),selection))changed();
  const body={schema:'runtime-toolchain-registration-material/v1' as const,selection,registration,sourcePins:pins,hostBefore:before,hostAfter:after,specification,patches,dependenciesVerified:false,authority:false as const,filesWritten:false as const,serviceStarted:false as const,hostReconnectRequired:true as const};
  return{...body,materialDigest:sha(canonicalEvidence(body))};
}

/** No caller-supplied executable, manifest, URL or lock can replace the bundled
 * inspection. Cache readiness does not apply configuration or start anything. */
export function prepareInstalledToolchainRegistration(serviceRoot:string):ToolchainRegistrationMaterial {
  const selected=inspectInstalledServiceSelection(serviceRoot);
  if(!selected.binding)reject('TOOLCHAIN_BINDING_UNBOUND','Bind the installed Workspace first',409);
  const toolchain=inspectNativeToolchain({cacheRoot:path.join(selected.binding.workspaceRoot,'native-toolchain')});
  const {materialDigest:unused,...material}=renderInstalledToolchainRegistration(serviceRoot,toolchain);
  if(!same(material.selection,selected))changed();
  const body={...material,dependenciesVerified:true};return{...body,materialDigest:sha(canonicalEvidence(body))};
}
