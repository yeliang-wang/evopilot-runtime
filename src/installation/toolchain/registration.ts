/** Passive material for binding bundled native dependencies to an installed
 * service. Applying the exact material is a separate stopped local operation.
 * A rendered document, digest or successful cache inspection grants no authority. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonical,canonicalEvidence,digest,exact,record,reject} from '../../server/errors.js';
import {readRegular} from '../../compat/project/files.js';
import {readIntegrationConfiguration,type NativeToolchainRegistration} from '../../adapters/config.js';
import {readLegacyProviderConfiguration} from '../../compat/registered-providers.js';
import type {LegacyPluginSelection} from '../../host/plugin.js';
import {inspectInstalledHostSelection} from '../host-selection.js';
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
  const {pins,read,spec,servers,before,owner,operator}=inspectInstalledHostSelection(selection,'TOOLCHAIN_BINDING_CHANGED');
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
