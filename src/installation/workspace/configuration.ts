/** Read-only assembly of a relocated installation's operational configuration.
 * The operator owns leases, exact copying, journaling and applying these bytes.
 * This module never moves files, renews credentials, starts jobs or enables a Host. */
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {isDeepStrictEqual as equal} from 'node:util';
import {canonical,digest,exact,record,reject} from '../../server/errors.js';
import {readHostConnection,readPrivateJson} from '../../server/security.js';
import {readWorkspaceOperatorConfiguration} from '../../host/workspace.js';
import {readLegacyBinding} from '../../compat/gateway.js';
import {resolvedManagedBinding,type ManagedLegacyBinding} from '../../compat/managed-store.js';
import {readIdentity} from '../../location-lineage.js';
import {RuntimeStore} from '../../server/store.js';
import {readLegacyProviderConfiguration} from '../../compat/registered-providers.js';
import {readLegacyOwnerHostConfiguration} from '../../host/legacy-owners.js';
import {readIntegrationConfiguration} from '../../adapters/config.js';
import {runtimePluginMaterial,quoteHelperArgument,type LegacyPluginSelection} from '../../host/plugin.js';
import {userServicePlist,renderUserServicePlist,type UserServiceSpecification} from '../service.js';
import {hashMaintenanceFile,inspectMaintenanceTree,maintenanceJSONDigest} from './stream.js';
import {separateRoots,validateSelection,type WorkspaceSelection} from './snapshot.js';

export interface RelocationConfigurationPatch {path:string;previousSha256:string|null;sha256:string;bytes:Buffer;}
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
  const mappedFile=(file:string):string=>{const to=map(file);if(to!==file){const before=pin(file),after=hashMaintenanceFile(to);if(before.sha256!==after.sha256||before.bytes!==after.bytes||before.mode!==after.mode)fail();}return to;};
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
  addJSON('legacy-binding.json',binding(destination));
  if(original.integrationsRef!==null){
    const current=structuredClone(json(original.integrationsRef,file=>readIntegrationConfiguration(file,source.workspaceId)));
    // Only declared operational path fields change. Resource definitions and
    // their review/registration revisions remain exact historical selections.
    const config={...current,credentials:current.credentials.map(c=>({...c,tokenFile:mappedFile(c.tokenFile)})),owners:current.owners.map(o=>({...o,packageRoot:map(o.packageRoot),workspaceRoot:map(o.workspaceRoot)})),...(current.nativeToolchain?{nativeToolchain:{...current.nativeToolchain,path:mappedFile(current.nativeToolchain.path)}}:{})};
    const name='relocated-integrations.json';addJSON(name,config);specification.integrationsRef=path.join(destination.serviceRoot,name);
  }
  if(original.legacyProviders){
    const config=structuredClone(json(original.legacyProviders.ref,readLegacyProviderConfiguration));
    if(digest(config)!==original.legacyProviders.digest||config.legacyBindingRef!==original.legacyRef||config.projectRoot!==source.projectRoot||config.workspaceId!==source.workspaceId||!config.projects.includes(original.projectId))fail();
    config.legacyBindingRef=specification.legacyRef!;config.projectRoot=destination.projectRoot;
    for(const owner of Object.values(config.owners))owner.packageRoot=map(owner.packageRoot);
    config.nativeToolchain={...config.nativeToolchain,path:mappedFile(config.nativeToolchain.path)};
    const name='relocated-providers.json';addJSON(name,config);specification.legacyProviders={ref:path.join(destination.serviceRoot,name),digest:digest(config)};
  }
  let relocatedHost:LegacyPluginSelection={};
  if(ownerHost.ownerConfigRef){
    const config=structuredClone(json(ownerHost.ownerConfigRef,readLegacyOwnerHostConfiguration));
    if(digest(config)!==ownerHost.ownerConfigDigest||config.legacyBindingRef!==original.legacyRef||config.workspaceId!==source.workspaceId||config.projectId!==original.projectId||config.project&&config.project.root!==source.projectRoot)fail();
    config.legacyBindingRef=specification.legacyRef!;if(config.project)config.project.root=destination.projectRoot;
    for(const owner of Object.values(config.owners))owner.packageRoot=map(owner.packageRoot);
    if(config.nativeToolchain)config.nativeToolchain={...config.nativeToolchain,path:mappedFile(config.nativeToolchain.path)};
    const name='relocated-owner-host.json';addJSON(name,config);relocatedHost={ownerConfigRef:path.join(destination.serviceRoot,name),ownerConfigDigest:digest(config)};
  }
  if(ownerHost.workspaceConfigRef){
    const config=json(ownerHost.workspaceConfigRef,readWorkspaceOperatorConfiguration);
    if(digest(config)!==ownerHost.workspaceConfigDigest||!equal(config.selection,source)||config.specificationDigest!==digest(original)||!equal(config.ownerHost,ownerHost.ownerConfigRef?{ownerConfigRef:ownerHost.ownerConfigRef,ownerConfigDigest:ownerHost.ownerConfigDigest}:{}))fail();
    const moved={...config,selection:destination,specificationDigest:digest(specification),connectionRef:path.join(destination.serviceRoot,'connection.json'),owners:{ontology:map(config.owners.ontology),harness:map(config.owners.harness)},ownerHost:{...relocatedHost}};
    const name='relocated-workspace-operator.json';addJSON(name,moved);relocatedHost={...relocatedHost,workspaceConfigRef:path.join(destination.serviceRoot,name),workspaceConfigDigest:digest(moved)};
  }
  const connection=json(path.join(source.serviceRoot,'connection.json'),readHostConnection);
  if(connection.workspaceId!==source.workspaceId||connection.projectId!==original.projectId||connection.principalId!==original.principalId||connection.serviceId!==source.serviceId||connection.version!==original.version||connection.tokenRef!==original.tokenRef||connection.origin!=='http://127.0.0.1:'+original.port)fail();
  addJSON('connection.json',{...connection,tokenRef:specification.tokenRef});
  const oldPlugin=runtimePluginMaterial(original.packageRoot,path.join(source.serviceRoot,'connection.json'),original.nodeExecutable,ownerHost);
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
