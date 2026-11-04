/** Shared passive inspection of the exact installed plugin and existing grants.
 * Reads only current protected configuration; never invokes owner work. */
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonical,digest,exact,record,reject} from '../server/errors.js';
import {readPrivateJson} from '../server/security.js';
import {readRegular} from '../compat/project/files.js';
import {readLegacyOwnerHostConfiguration} from '../host/legacy-owners.js';
import {readWorkspaceOperatorConfiguration} from '../host/workspace.js';
import {readWorkspaceSetupConfiguration} from '../host/setup.js';
import {runtimePluginMaterial,type LegacyPluginSelection} from '../host/plugin.js';
import type {InstalledServiceSelection} from './service-control.js';
import type {UserServiceSpecification} from './service.js';
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
export interface InstalledHostSelection {
  pins:Record<string,string>;read:<T>(ref:string,reader:(ref:string)=>T)=>T;
  json:(ref:string)=>unknown;spec:UserServiceSpecification;servers:Record<string,unknown>;
  before:LegacyPluginSelection;owner:ReturnType<typeof readLegacyOwnerHostConfiguration>|null;
  operator:ReturnType<typeof readWorkspaceOperatorConfiguration>|null;
}
export function inspectInstalledHostSelection(selection:InstalledServiceSelection,changedCode='INSTALLED_HOST_CHANGED'):InstalledHostSelection{
  const changed=():never=>reject(changedCode,'Current installed plugin, scope or grants differ from their selected identity',409);
  if(!selection.binding)reject('INSTALLED_HOST_UNBOUND','Bind the installed Workspace before configuring owner integrations');
  const binding=selection.binding!,serviceRoot=selection.serviceRoot,pins={...selection.configurationPins};
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
  return{pins,read,json,spec,servers,before,owner,operator};
}
