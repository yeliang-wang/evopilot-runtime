/** Read-only assembly of a relocated installation's operational configuration.
 * The operator owns leases, exact copying, journaling and applying these bytes.
 * This module never moves files, renews credentials, starts jobs or enables a Host. */
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {isDeepStrictEqual as equal} from 'node:util';
import {canonical,canonicalEvidence,digest,exact,record,reject} from '../../server/errors.js';
import {readHostConnection,readPrivateJson} from '../../server/security.js';
import {readWorkspaceOperatorConfiguration} from '../../host/workspace.js';
import {readWorkspaceSetupConfiguration} from '../../host/setup.js';
import {readLegacyBinding} from '../../compat/gateway.js';
import {readRegular} from '../../compat/project/files.js';
import {resolvedManagedBinding,type ManagedLegacyBinding} from '../../compat/managed-store.js';
import {readIdentity} from '../../location-lineage.js';
import {RuntimeStore} from '../../server/store.js';
import {readLegacyProviderConfiguration} from '../../compat/registered-providers.js';
import {readLegacyOwnerHostConfiguration} from '../../host/legacy-owners.js';
import {readOnlineConfiguration,type OnlineRegistration} from '../../host/online.js';
import {nativeSha256} from '../../../vendor/compatibility/v1/native.mjs';
import {readIntegrationConfiguration,readRegisteredNativeToolchain,type NativeToolchainRegistration} from '../../adapters/config.js';
import {prepareNativeToolchainRelocation} from '../toolchain/locked.js';
import {prepareToolchainHistoryDigest} from '../toolchain/preparation.js';
import {runtimePluginMaterial,quoteHelperArgument,type LegacyPluginSelection} from '../../host/plugin.js';
import {userServicePlist,renderUserServicePlist,type UserServiceSpecification} from '../service.js';
import {hashMaintenanceFile,inspectMaintenanceTree,maintenanceJSONDigest} from './stream.js';
import {separateRoots,validateSelection,type WorkspaceSelection} from './snapshot.js';

export interface RelocationConfigurationPatch {path:string;previousSha256:string|null;sha256:string;bytes:Buffer;role?:'workspace';mode?:number;}
export interface RelocationConfigurationMaterial {
  schema:'runtime-relocation-configuration/v1';source:WorkspaceSelection;destination:WorkspaceSelection;
  specification:UserServiceSpecification;ownerHost:LegacyPluginSelection;
  patches:RelocationConfigurationPatch[];sourcePins:{path:string;sha256:string;bytes:number;mode:number}[];
  materialDigest:string;authority:false;filesWritten:false;serviceStarted:false;hostRegistered:false;
}
const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const binding=(s:WorkspaceSelection):ManagedLegacyBinding=>({workspaceRoot:s.workspaceRoot,workspaceId:s.workspaceId,serviceId:s.serviceId,migrationDigest:s.migrationDigest});
const selectedRoots=(s:WorkspaceSelection)=>[s.projectRoot,s.workspaceRoot,s.serviceRoot];
const marketplace=(root:string)=>'evopilot-runtime-'+sha(root).slice(0,16);
function fail():never {return reject('RELOCATION_CONFIGURATION_CHANGED','The exact copied installation or its selected configuration differs',409);}
function stoppedDatabase(file:string):void {for(const suffix of ['-wal','-shm','-journal'])if(fs.existsSync(file+suffix))reject('MAINTENANCE_NOT_QUIESCENT','Close business databases before preparing relocation');}
/** Do not open an original WAL database merely to inspect it: even a read-only
 * SQLite connection may create sidecars. Validate identity/ledger on copies. */
function validateCopiedState(source:WorkspaceSelection,destination:WorkspaceSelection):void {
  const scratch=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'runtime-relocation-config-'));
  try{
    const legacy=path.join(destination.workspaceRoot,'state/runtime/runtime.db');stoppedDatabase(legacy);
    const copy=path.join(scratch,'legacy.db');fs.copyFileSync(legacy,copy);
    const db=new DatabaseSync(copy,{readOnly:true,allowExtension:false});
    try{if(!equal(resolvedManagedBinding(db,readIdentity(destination.workspaceRoot,destination.workspaceId)),binding(destination)))fail();}finally{db.close();}
    const original=path.join(source.serviceRoot,'data/service.sqlite'),target=path.join(destination.serviceRoot,'data/service.sqlite');
    stoppedDatabase(original);stoppedDatabase(target);
    if(!equal(hashMaintenanceFile(original),hashMaintenanceFile(target)))fail();
    const state=path.join(scratch,'state');fs.mkdirSync(state,{mode:0o700});fs.copyFileSync(target,path.join(state,'service.sqlite'));
    const store=new RuntimeStore(state,destination.workspaceId);try{if(store.serviceId!==destination.serviceId)fail();}finally{store.close();}
  }finally{fs.rmSync(scratch,{recursive:true,force:true});}
}
/** Exact paths are operational bindings. Definition/resource text, historical
 * installation plans, receipts, claims and the adoption record are never rewritten. */
export function prepareRelocationConfiguration(sourceInput:WorkspaceSelection,destinationInput:WorkspaceSelection,ownerHost:LegacyPluginSelection={}):RelocationConfigurationMaterial {
  const source=structuredClone(sourceInput),destination=structuredClone(destinationInput);
  validateSelection(source);validateSelection(destination);
  if(source.workspaceId!==destination.workspaceId||source.serviceId!==destination.serviceId||source.migrationDigest===destination.migrationDigest)fail();
  separateRoots([...selectedRoots(source),...selectedRoots(destination)]);
  exact(record(ownerHost),[],['ownerConfigRef','ownerConfigDigest','workspaceConfigRef','workspaceConfigDigest']);
  if((ownerHost.ownerConfigRef===undefined)!==(ownerHost.ownerConfigDigest===undefined)||(ownerHost.workspaceConfigRef===undefined)!==(ownerHost.workspaceConfigDigest===undefined))fail();
  validateCopiedState(source,destination);
  const pins=new Map<string,{path:string;sha256:string;bytes:number;mode:number}>();
  const pin=(file:string)=>{const p={path:file,...hashMaintenanceFile(file)};const previous=pins.get(file);if(previous&&!equal(previous,p))fail();pins.set(file,p);return p;};
  const json=<T>(file:string,reader:(file:string)=>T):T=>{const before=pin(file),v=reader(file);if(!equal(before,pin(file)))fail();return v;};
  const read=(relative:string)=>json(path.join(source.serviceRoot,relative),readPrivateJson);
  const original=read('service-specification.json') as UserServiceSpecification;
  if(original.schema!=='runtime-user-service/v1'||original.root!==source.serviceRoot||original.packageRoot!==path.join(source.serviceRoot,'package')||original.workspaceId!==source.workspaceId||original.legacyRef!==path.join(source.serviceRoot,'legacy-binding.json')||original.tokenRef!==path.join(source.serviceRoot,'client.json'))fail();
  if(!equal(json(original.legacyRef,readLegacyBinding),binding(source)))fail();
  const map=(file:string):string=>{for(const role of ['projectRoot','workspaceRoot','serviceRoot'] as const)if(file===source[role]||file.startsWith(source[role]+path.sep))return destination[role]+file.slice(source[role].length);return file;};
  const mappedFile=(file:string):string=>{const to=map(file),before=pin(file);if(to!==file){const after=hashMaintenanceFile(to);if(before.sha256!==after.sha256||before.bytes!==after.bytes||before.mode!==after.mode)fail();}return to;};
  const patches:RelocationConfigurationPatch[]=[];
  const add=(relative:string,bytes:Buffer|string)=>{
    if(path.isAbsolute(relative)||relative.split('/').some(s=>!s||s==='.'||s==='..')||patches.some(p=>p.path===relative))fail();
    const content=Buffer.from(bytes),old=path.join(source.serviceRoot,relative),target=path.join(destination.serviceRoot,relative),previousSha256=fs.existsSync(old)?pin(old).sha256:null;
    const sha256=sha(content);
    if(fs.existsSync(target)){const retained=hashMaintenanceFile(target);if(retained.sha256!==previousSha256&&retained.sha256!==sha256)fail();}
    else if(previousSha256!==null)fail();
    patches.push({path:relative,previousSha256,sha256,bytes:content});
  };
  const addJSON=(relative:string,value:unknown)=>add(relative,canonical(value)+'\n');
  // Retain the complete package and scoped credentials. New material contains
  // only credential references; it never copies credential values into a plan.
  for(const name of ['client.json','data/auth.json']){
    const a=pin(path.join(source.serviceRoot,name)),b=hashMaintenanceFile(path.join(destination.serviceRoot,name));
    if(a.sha256!==b.sha256||a.bytes!==b.bytes||a.mode!==b.mode)fail();
  }
  if(!equal(inspectMaintenanceTree(original.packageRoot),inspectMaintenanceTree(path.join(destination.serviceRoot,'package'))))fail();
  const specification:UserServiceSpecification={...original,root:destination.serviceRoot,packageRoot:path.join(destination.serviceRoot,'package'),tokenRef:path.join(destination.serviceRoot,'client.json'),legacyRef:path.join(destination.serviceRoot,'legacy-binding.json')};
  const registrations=new Map<string,NativeToolchainRegistration>();
  const native=(registration:NativeToolchainRegistration):NativeToolchainRegistration=>{
    const key=canonical(registration),existing=registrations.get(key);if(existing)return existing;
    const descriptor=json(registration.path,()=>readRegisteredNativeToolchain({schema:'runtime-integrations/v1',workspaceId:source.workspaceId,revision:1,platforms:[],credentials:[],owners:[],resources:[],nativeToolchain:registration}));
    if(map(descriptor.environmentRoot!)===descriptor.environmentRoot)return{...registration,path:mappedFile(registration.path)};
    const cache=path.join(source.workspaceRoot,'native-toolchain');
    if(!descriptor.environmentRoot!.startsWith(cache+path.sep))fail();
    const material=prepareNativeToolchainRelocation(cache,path.join(destination.workspaceRoot,'native-toolchain'));
    if(!equal(descriptor,material.original))fail();
    const patch={...material.patch,path:'native-toolchain/'+material.patch.path,role:'workspace' as const};
    pin(path.join(source.workspaceRoot,patch.path));
    const prior=patches.find(p=>p.role==='workspace'&&p.path===patch.path);
    if(prior&&!equal(prior,patch))fail();if(!prior)patches.push(patch);
    const content=canonicalEvidence(material.relocated)+'\n',name='relocated-native-toolchain-'+sha(content)+'.json';
    if(!patches.some(p=>p.path===name&&!p.role))add(name,content);
    const moved={path:path.join(destination.serviceRoot,name),digest:'sha256:'+sha(content),lockDigest:registration.lockDigest};
    registrations.set(key,moved);return moved;
  };
  const onlineRegistrations=new Map<string,OnlineRegistration>();
  const online=(registration:OnlineRegistration):OnlineRegistration=>{
    const key=canonical(registration),existing=onlineRegistrations.get(key);if(existing)return existing;
    const current=json(registration.ref,()=>readOnlineConfiguration(registration,source.workspaceId));
    const secret=(ref:string)=>{readRegular(ref,1048576,true);return mappedFile(ref);};
    const settings={...current.settings,prometheus:current.settings.prometheus.map(c=>({...c,bearerTokenFile:c.bearerTokenFile===null?null:secret(c.bearerTokenFile)})),alertmanager:current.settings.alertmanager.map(c=>({...c,bearerTokenFile:secret(c.bearerTokenFile)}))};
    const subject={schema:current.schema,workspaceId:current.workspaceId,settings},moved={...subject,digest:nativeSha256(subject)};
    let ref:string;
    if(registration.ref===path.join(source.workspaceRoot,'online/configuration.json')){
      const bytes=Buffer.from(canonical(moved)+'\n'),previous=pin(registration.ref),target=path.join(destination.workspaceRoot,'online/configuration.json'),after=hashMaintenanceFile(target),sha256=sha(bytes);
      if(previous.mode!==0o600||after.mode!==0o600||![previous.sha256,sha256].includes(after.sha256))fail();
      patches.push({path:'online/configuration.json',role:'workspace',previousSha256:previous.sha256,sha256,bytes,mode:0o600});ref=target;
    }else{
      // An external or content-addressed configuration remains immutable at
      // its old location. The moved Host selects a new operational document.
      const name='relocated-online-'+digest(moved)+'.json';if(!patches.some(p=>p.path===name&&!p.role))addJSON(name,moved);ref=path.join(destination.serviceRoot,name);
    }
    const result={ref,digest:digest(moved)};onlineRegistrations.set(key,result);return result;
  };
  const movedOwner=(ref:string,pinDigest:string,projectId:string,name?:string)=>{
    const config=structuredClone(json(ref,readLegacyOwnerHostConfiguration));
    if(digest(config)!==pinDigest||config.legacyBindingRef!==original.legacyRef||config.workspaceId!==source.workspaceId||config.projectId!==projectId)fail();
    config.legacyBindingRef=specification.legacyRef!;if(config.project)config.project.root=map(config.project.root);
    for(const owner of Object.values(config.owners))owner.packageRoot=map(owner.packageRoot);
    if(config.nativeToolchain)config.nativeToolchain=native(config.nativeToolchain);
    if(config.online)config.online=online(config.online);
    const filename=name??'relocated-online-owner-'+digest(config)+'.json';addJSON(filename,config);
    return{ownerConfigRef:path.join(destination.serviceRoot,filename),ownerConfigDigest:digest(config)};
  };
  addJSON('legacy-binding.json',binding(destination));
  if(original.integrationsRef!==null){
    const current=structuredClone(json(original.integrationsRef,file=>readIntegrationConfiguration(file,source.workspaceId)));
    // Only declared operational path fields change. Resource definitions and
    // their review/registration revisions remain exact historical selections.
    const config={...current,credentials:current.credentials.map(c=>({...c,tokenFile:mappedFile(c.tokenFile)})),owners:current.owners.map(o=>({...o,packageRoot:map(o.packageRoot),workspaceRoot:map(o.workspaceRoot)})),...(current.nativeToolchain?{nativeToolchain:native(current.nativeToolchain)}:{})};
    const name='relocated-integrations.json';addJSON(name,config);specification.integrationsRef=path.join(destination.serviceRoot,name);
  }
  if(original.legacyProviders){
    const config=structuredClone(json(original.legacyProviders.ref,readLegacyProviderConfiguration));
    if(digest(config)!==original.legacyProviders.digest||config.legacyBindingRef!==original.legacyRef||config.projectRoot!==source.projectRoot||config.workspaceId!==source.workspaceId||!config.projects.includes(original.projectId))fail();
    config.legacyBindingRef=specification.legacyRef!;config.projectRoot=destination.projectRoot;
    for(const owner of Object.values(config.owners))owner.packageRoot=map(owner.packageRoot);
    config.nativeToolchain=native(config.nativeToolchain);
    const name='relocated-providers.json';addJSON(name,config);specification.legacyProviders={ref:path.join(destination.serviceRoot,name),digest:digest(config)};
  }
  let relocatedHost:LegacyPluginSelection={};
  if(ownerHost.ownerConfigRef){
    const config=json(ownerHost.ownerConfigRef,readLegacyOwnerHostConfiguration);
    if(config.project&&config.project.root!==source.projectRoot)fail();
    relocatedHost=movedOwner(ownerHost.ownerConfigRef,ownerHost.ownerConfigDigest!,original.projectId,'relocated-owner-host.json');
  }
  if(ownerHost.workspaceConfigRef){
    const config=json(ownerHost.workspaceConfigRef,readWorkspaceOperatorConfiguration);
    if(digest(config)!==ownerHost.workspaceConfigDigest||!equal(config.selection,source)||config.specificationDigest!==digest(original)||!equal(config.ownerHost,ownerHost.ownerConfigRef?{ownerConfigRef:ownerHost.ownerConfigRef,ownerConfigDigest:ownerHost.ownerConfigDigest}:{}))fail();
    const history=prepareToolchainHistoryDigest({workspaceRoot:source.workspaceRoot,workspaceId:source.workspaceId,installationDigest:digest({specificationDigest:config.specificationDigest,configurationDigest:ownerHost.workspaceConfigDigest}),...(config.toolchainPreparationHistoryDigest?{historicalRecordsDigest:config.toolchainPreparationHistoryDigest}:{})});
    const movedOnline=config.online?{hosts:config.online.hosts.map(h=>{
      const connection=json(h.connectionRef,readHostConnection);
      if(connection.workspaceId!==source.workspaceId||connection.serviceId!==source.serviceId||connection.origin!=='http://127.0.0.1:'+original.port||connection.version!==original.version)fail();
      const credential=json(connection.tokenRef,readPrivateJson) as {schema:string;workspaceId:string;projectId:string;principalId:string};
      if(credential.schema!=='runtime-client-credential/v1'||credential.workspaceId!==source.workspaceId||credential.projectId!==connection.projectId||credential.principalId!==connection.principalId)fail();
      const movedConnection={...connection,tokenRef:mappedFile(connection.tokenRef)};
      if(h.connectionRef===path.join(source.serviceRoot,'connection.json')){
        if(h.ownerConfigRef!==ownerHost.ownerConfigRef||h.ownerConfigDigest!==ownerHost.ownerConfigDigest||!relocatedHost.ownerConfigRef)fail();
        return{connectionRef:path.join(destination.serviceRoot,'connection.json'),ownerConfigRef:relocatedHost.ownerConfigRef,ownerConfigDigest:relocatedHost.ownerConfigDigest!};
      }
      const name='relocated-online-connection-'+digest(movedConnection)+'.json';addJSON(name,movedConnection);
      return{connectionRef:path.join(destination.serviceRoot,name),...movedOwner(h.ownerConfigRef,h.ownerConfigDigest,connection.projectId)};
    })}:undefined;
    const moved={...config,selection:destination,specificationDigest:digest(specification),connectionRef:path.join(destination.serviceRoot,'connection.json'),owners:{ontology:map(config.owners.ontology),harness:map(config.owners.harness)},ownerHost:{...relocatedHost},...(history?{toolchainPreparationHistoryDigest:history}:{}),...(movedOnline?{online:movedOnline}:{})};
    const name='relocated-workspace-operator.json';addJSON(name,moved);relocatedHost={...relocatedHost,workspaceConfigRef:path.join(destination.serviceRoot,name),workspaceConfigDigest:digest(moved)};
  }
  const canonicalOnline=path.join(source.workspaceRoot,'online/configuration.json');
  if(!onlineRegistrations.size&&fs.existsSync(canonicalOnline))online({ref:canonicalOnline,digest:digest(json(canonicalOnline,readPrivateJson))});
  const connection=json(path.join(source.serviceRoot,'connection.json'),readHostConnection);
  if(connection.workspaceId!==source.workspaceId||connection.projectId!==original.projectId||connection.principalId!==original.principalId||connection.serviceId!==source.serviceId||connection.version!==original.version||connection.tokenRef!==original.tokenRef||connection.origin!=='http://127.0.0.1:'+original.port)fail();
  addJSON('connection.json',{...connection,tokenRef:specification.tokenRef});
  // A completed first-use installation still runs its setup bootstrap, which
  // delegates to this exact bound maintenance grant. Verify that original
  // wrapper and retain its bytes as history; the relocated installation is
  // already bound and uses the normal current maintenance entry.
  let sourceHost={...ownerHost};
  const installedServers=record(record(read('plugin/.mcp.json')).mcpServers),installedLegacy=record(installedServers.evopilot_runtime_legacy);
  if(Array.isArray(installedLegacy.args)&&installedLegacy.args[0]===path.join(original.packageRoot,'dist/installation/setup-host.js')){
    const ref=path.join(source.serviceRoot,'workspace-setup.json'),setup=json(ref,readWorkspaceSetupConfiguration);
    if(setup.serviceRoot!==source.serviceRoot||setup.workspaceRoot!==source.workspaceRoot||setup.projectRoot!==source.projectRoot||setup.workspaceId!==source.workspaceId||setup.serviceId!==source.serviceId||setup.connectionRef!==path.join(source.serviceRoot,'connection.json')||!equal(setup.ownerHost,ownerHost.ownerConfigRef?{ref:ownerHost.ownerConfigRef,digest:ownerHost.ownerConfigDigest}:null))fail();
    if(ownerHost.workspaceConfigRef){
      const current=json(ownerHost.workspaceConfigRef,readWorkspaceOperatorConfiguration);
      const grant={projectRoot:current.selection.projectRoot,referenceFiles:current.selection.referenceFiles,owners:current.owners,calls:current.calls,expiresAt:current.expiresAt,...(current.online?{online:current.online}:{})};
      if(!equal(setup.workspaceOperator,grant))fail();
    }else if(setup.workspaceOperator!==null)fail();
    sourceHost={...sourceHost,setupConfigRef:ref,setupConfigDigest:digest(setup)};
  }
  const oldPlugin=runtimePluginMaterial(original.packageRoot,path.join(source.serviceRoot,'connection.json'),original.nodeExecutable,sourceHost);
  for(const [name,bytes] of oldPlugin.files){const file=path.join(source.serviceRoot,'plugin',name);if(pin(file).sha256!==sha(bytes))fail();}
  const helper=path.join(specification.packageRoot,'dist/host/header-helper.js'),args=[path.join(specification.packageRoot,relocatedHost.workspaceConfigRef?'dist/installation/workspace-host.js':'dist/host/bridge.js'),'--connection-ref',path.join(destination.serviceRoot,'connection.json'),'--legacy-only'];
  if(relocatedHost.ownerConfigRef)args.push('--owner-config-ref',relocatedHost.ownerConfigRef,'--owner-config-digest',relocatedHost.ownerConfigDigest!);
  if(relocatedHost.workspaceConfigRef)args.push('--operator-config-ref',relocatedHost.workspaceConfigRef,'--operator-config-digest',relocatedHost.workspaceConfigDigest!);
  addJSON('plugin/.mcp.json',{mcpServers:{evopilot_runtime:{type:'http',url:connection.origin+'/mcp',http_headers_helper:[original.nodeExecutable,helper,'--connection-ref',path.join(destination.serviceRoot,'connection.json')].map(quoteHelperArgument).join(' ')},evopilot_runtime_legacy:{type:'stdio',command:original.nodeExecutable,args}}});
  const catalog=(root:string)=>({name:marketplace(root),plugins:[{name:'evopilot-runtime',source:{source:'local',path:'./plugin'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'}}]});
  if(!equal(read('.agents/plugins/marketplace.json'),catalog(source.serviceRoot)))fail();
  addJSON('.agents/plugins/marketplace.json',catalog(destination.serviceRoot));
  addJSON('service-specification.json',specification);
  // Validate the original live contract before rendering its exact operational
  // path transition. Destination configuration files have not been written yet.
  // Startup later performs the ordinary full validation of the destination.
  userServicePlist(original);add('service.plist',renderUserServicePlist(specification));
  for(const p of pins.values())if(!equal(p,{path:p.path,...hashMaintenanceFile(p.path)}))fail();
  const sourcePins=[...pins.values()].sort((a,b)=>a.path.localeCompare(b.path));
  const body={schema:'runtime-relocation-configuration/v1' as const,source,destination,specification,ownerHost:relocatedHost,patches:patches.map(({bytes,...p})=>({...p,bytes:bytes.length})),sourcePins};
  return{...body,patches,materialDigest:maintenanceJSONDigest(body),authority:false,filesWritten:false,serviceStarted:false,hostRegistered:false};
}
