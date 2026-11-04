/** Select a complete local online configuration transition. No files, network
 * requests, permission changes, service startup or monitoring selection. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonical,canonicalEvidence,digest,exact,record,reject,slug,string} from '../../server/errors.js';
import {hostHeaders,readHostConnection,readPrivateJson} from '../../server/security.js';
import {canonicalPath,readRegular} from '../../compat/project/files.js';
import {readLegacyBinding} from '../../compat/gateway.js';
import {verifyOwnerDistribution} from '../../adapters/published-owners.js';
import {readLegacyOwnerHostConfiguration} from '../../host/legacy-owners.js';
import {readOnlineConfiguration,validateOnlineSettings,validatePublishedOnlineSettings,type OnlineSettings,type OnlineRegistration,type OnlineConfiguration} from '../../host/online.js';
import type {LegacyPluginSelection} from '../../host/plugin.js';
import {nativeSha256} from '../../../vendor/compatibility/v1/native.mjs';
import {inspectInstalledServiceSelection,type InstalledServiceSelection} from '../service-control.js';
import {inspectInstalledHostSelection} from '../host-selection.js';
import {maintenanceLocation} from '../workspace/snapshot.js';
import type {OnlineHostSelection} from './selection.js';

export interface OnlineConfigurationInput {serviceRoot:string;settings:OnlineSettings;expectedDigest:string|null;requestId:string;hosts:OnlineHostSelection[];}
export interface OnlineConfigurationPatch {ref:string;before:string|null;after:string;content:string;}
export interface OnlineConfigurationMaterial {
  schema:'runtime-online-configuration-material/v1';input:OnlineConfigurationInput;selection:InstalledServiceSelection;
  configuration:OnlineConfiguration;registration:OnlineRegistration;sourcePins:Record<string,string>;
  hostsAfter:OnlineHostSelection[];hostBefore:LegacyPluginSelection;hostAfter:LegacyPluginSelection;
  patches:OnlineConfigurationPatch[];authority:false;filesWritten:false;serviceStarted:false;workerStarted:false;hostReconnectRequired:true;materialDigest:string;
}
const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const same=(a:unknown,b:unknown)=>canonicalEvidence(a)===canonicalEvidence(b);
const fail=():never=>reject('ONLINE_CONFIGURATION_SELECTION_CHANGED','The selected installation, Host grants or online configuration changed',409);
export const onlineConfigurationControl=(input:OnlineConfigurationInput)=>path.join(input.serviceRoot,'online-bindings',input.requestId);
/** Check every existing ancestor without creating the initial online directory.
 * lstat, rather than exists, also catches dangling symlinks in a missing tail. */
export function onlineOutputPath(ref:string):void{
  if(!path.isAbsolute(ref)||path.resolve(ref)!==ref)fail();let existing=ref;
  for(;;){try{fs.lstatSync(existing);break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const parent=path.dirname(existing);if(parent===existing)throw error;existing=parent;}}
  canonicalPath(existing);
}
export function validateOnlineConfigurationInput(input:unknown):asserts input is OnlineConfigurationInput {
  const v=record(input);exact(v,['serviceRoot','settings','expectedDigest','requestId','hosts']);
  const root=string(v.serviceRoot,4096);if(!path.isAbsolute(root)||path.resolve(root)!==root)fail();slug(v.requestId);validateOnlineSettings(v.settings);
  if(v.expectedDigest!==null&&(typeof v.expectedDigest!=='string'||!/^sha256:[a-f0-9]{64}$/.test(v.expectedDigest)))reject('ONLINE_CONFIGURATION_EXPECTATION','Use the original native configuration digest or null before initial configuration');
  if(!Array.isArray(v.hosts)||!v.hosts.length||v.hosts.length>64)reject('ONLINE_CONFIGURATION_SCOPE','Provide one explicit current Host for every configured project');
  for(const raw of v.hosts){const h=record(raw);exact(h,['connectionRef','ownerConfigRef','ownerConfigDigest']);for(const key of ['connectionRef','ownerConfigRef']){const ref=string(h[key],4096);if(!path.isAbsolute(ref)||path.resolve(ref)!==ref)fail();}if(!/^[a-f0-9]{64}$/.test(string(h.ownerConfigDigest,64)))fail();}
}
/** A repeated original selection may return its retained material even after a
 * partial publication. Application independently validates the original journal. */
export async function prepareOnlineConfiguration(raw:OnlineConfigurationInput):Promise<OnlineConfigurationMaterial> {
  validateOnlineConfigurationInput(raw);const input=structuredClone(raw);maintenanceLocation(input.serviceRoot,false,true);
  const retained=path.join(onlineConfigurationControl(input),'material.json');
  if(fs.existsSync(retained)){
    const m=readPrivateJson(retained) as OnlineConfigurationMaterial,{materialDigest,...body}=m;
    if(m.schema!=='runtime-online-configuration-material/v1'||sha(canonicalEvidence(body))!==materialDigest||!same(m.input,input))reject('REQUEST_CONFLICT','The original requestId belongs to different online configuration',409);
    return m;
  }
  const selection=inspectInstalledServiceSelection(input.serviceRoot),binding=selection.binding;
  if(!binding)reject('ONLINE_WORKSPACE_REQUIRED','Bind the installed service to its Workspace before configuring online monitoring');
  const current=inspectInstalledHostSelection(selection),{read,pins,spec,servers,before,owner,operator}=current;
  if(!owner||!before.ownerConfigRef)reject('ONLINE_OWNER_REQUIRED','The installed plugin must select an existing scoped owner Host');
  if(!input.hosts.some(h=>h.ownerConfigRef===before.ownerConfigRef&&h.ownerConfigDigest===before.ownerConfigDigest&&h.connectionRef===path.join(input.serviceRoot,'connection.json')))reject('ONLINE_CONFIGURATION_SCOPE','Include the exact installed primary Host');
  const projects=new Set<string>(),required=new Set(input.settings.scopes.map(s=>s.projectId));
  let previous:OnlineConfiguration|null=null,previousRegistration:OnlineRegistration|null=null;
  const selected=input.hosts.map(h=>{
    const connection=read(h.connectionRef,readHostConnection),config=read(h.ownerConfigRef,readLegacyOwnerHostConfiguration),actual=read(config.legacyBindingRef,readLegacyBinding);
    if(digest(config)!==h.ownerConfigDigest||!same(actual,binding)||connection.serviceId!==selection.serviceId||connection.workspaceId!==selection.workspaceId||connection.origin!=='http://127.0.0.1:'+spec.port||connection.version!==spec.version||connection.projectId!==config.projectId||config.workspaceId!==binding.workspaceId)fail();
    if(!required.has(config.projectId)||projects.has(config.projectId))reject('ONLINE_CONFIGURATION_SCOPE','Select exactly one existing Host grant for each configured project',403);projects.add(config.projectId);
    hostHeaders(connection);read(connection.tokenRef,readPrivateJson);
    for(const kind of ['ontology','harness'] as const)verifyOwnerDistribution(kind,config.owners[kind].packageRoot);
    if(config.online){
      const value=read(config.online.ref,()=>readOnlineConfiguration(config.online!,binding.workspaceId));
      if(previousRegistration&&!same(previousRegistration,config.online))reject('ONLINE_CONFIGURATION_SCOPE','Selected projects currently use different configurations; do not merge them implicitly',409);
      previousRegistration=config.online;previous=value;
    }
    return{host:h,config};
  });
  if(projects.size!==required.size)reject('ONLINE_CONFIGURATION_SCOPE','Every configured project needs an explicit Host grant',403);
  // An explicitly selected native expectedDigest can bind the original
  // canonical v0.8 Workspace configuration during standalone onboarding.
  // Merely finding a file, or an initial null expectation, cannot adopt it.
  const canonicalRef=path.join(binding.workspaceRoot,'online/configuration.json');
  if(!previousRegistration&&fs.existsSync(canonicalRef)){
    const value=read(canonicalRef,readPrivateJson),registration={ref:canonicalRef,digest:digest(value)};
    previous=readOnlineConfiguration(registration,binding.workspaceId);previousRegistration=registration;
  }
  const previousValue=previous as OnlineConfiguration|null,previousPin=previousRegistration as OnlineRegistration|null;
  if((previousValue?.digest??null)!==input.expectedDigest)reject('REVISION_CONFLICT','The original expectedDigest differs from the current online configuration',409);
  const configurationRef=previousPin?.ref??canonicalRef;onlineOutputPath(configurationRef);
  for(const {config} of selected)await validatePublishedOnlineSettings(config.owners.harness.packageRoot,input.settings);
  // Secret bytes are never retained. Their hashes bind the exact configuration
  // review and are rechecked before a partial transition can finish.
  for(const ref of [...input.settings.prometheus.map(p=>p.bearerTokenFile),...input.settings.alertmanager.map(p=>p.bearerTokenFile)])if(ref!==null)read(ref,p=>readRegular(p,1048576,true));
  const subject={schema:'evopilot-online-configuration/v1' as const,workspaceId:binding.workspaceId,settings:input.settings},configuration={...subject,digest:nativeSha256(subject)},registration={ref:configurationRef,digest:digest(configuration)};
  const patches:OnlineConfigurationPatch[]=[];
  const add=(ref:string,value:unknown,mutable=false)=>{
    onlineOutputPath(ref);const content=canonical(value)+'\n',after=sha(content),original=fs.existsSync(ref)?read(ref,p=>sha(readRegular(p,8388608,true))):null;
    if(original!==null&&!mutable&&original!==after)fail();patches.push({ref,before:original,after,content});return ref;
  };
  add(configurationRef,configuration,true);
  const document=(kind:string,value:unknown)=>add(path.join(input.serviceRoot,'online-'+kind+'-'+sha(canonical(value))+'.json'),value);
  const hostsAfter=selected.map(({host,config})=>{const next={...config,online:registration};return{connectionRef:host.connectionRef,ownerConfigRef:document('owner-host',next),ownerConfigDigest:digest(next)};});
  const primary=hostsAfter.find(h=>h.connectionRef===path.join(input.serviceRoot,'connection.json'))!;
  const after:LegacyPluginSelection={ownerConfigRef:primary.ownerConfigRef,ownerConfigDigest:primary.ownerConfigDigest};
  if(operator){
    const online=operator.online?{hosts:operator.online.hosts.map(h=>{const index=input.hosts.findIndex(old=>same(old,h));return index<0?h:hostsAfter[index];})}:undefined;
    const next={...operator,ownerHost:{...after},...(online?{online}:{})};after.workspaceConfigRef=document('workspace-operator',next);after.workspaceConfigDigest=digest(next);
  }
  const args=[path.join(spec.packageRoot,after.workspaceConfigRef?'dist/installation/workspace-host.js':'dist/host/bridge.js'),'--connection-ref',path.join(input.serviceRoot,'connection.json'),'--legacy-only','--owner-config-ref',after.ownerConfigRef!,'--owner-config-digest',after.ownerConfigDigest!];
  if(after.workspaceConfigRef)args.push('--operator-config-ref',after.workspaceConfigRef,'--operator-config-digest',after.workspaceConfigDigest!);
  add(path.join(input.serviceRoot,'plugin/.mcp.json'),{mcpServers:{evopilot_runtime:servers.evopilot_runtime,evopilot_runtime_legacy:{type:'stdio',command:spec.nodeExecutable,args}}},true);
  for(const [ref,pin] of Object.entries(pins))if(sha(readRegular(ref,8388608,true))!==pin)fail();
  if(!same(inspectInstalledServiceSelection(input.serviceRoot),selection))fail();
  const body={schema:'runtime-online-configuration-material/v1' as const,input,selection,configuration,registration,sourcePins:pins,hostsAfter,hostBefore:before,hostAfter:after,patches,authority:false as const,filesWritten:false as const,serviceStarted:false as const,workerStarted:false as const,hostReconnectRequired:true as const};
  return{...body,materialDigest:sha(canonicalEvidence(body))};
}
