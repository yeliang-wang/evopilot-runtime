/** Passive preservation of selected online dependencies. These reads neither
 * renew an expired grant nor invoke a Host, a telemetry endpoint or a worker. */
import fs from 'node:fs';
import path from 'node:path';
import {canonical,digest,record,reject} from '../../server/errors.js';
import {readPrivateJson,readHostConnection} from '../../server/security.js';
import {readLegacyBinding} from '../../compat/gateway.js';
import {readRegular} from '../../compat/project/files.js';
import {readWorkspaceOperatorConfiguration} from '../../host/workspace.js';
import {readWorkspaceSetupConfiguration} from '../../host/setup.js';
import {readOnlineConfiguration,type OnlineRegistration} from '../../host/online.js';
import type {WorkspaceSelection} from '../workspace/snapshot.js';

export function onlinePreservationReferences(selection:WorkspaceSelection):string[] {
  const refs=new Set<string>(),configurations=new Set<string>();
  const fail=():never=>reject('ONLINE_PRESERVATION_BINDING','Selected online references differ from this installation',409);
  const add=(ref:string)=>{refs.add(ref);return ref;};
  const json=(ref:string)=>record(readPrivateJson(add(ref)));
  const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
  const binding={workspaceRoot:selection.workspaceRoot,workspaceId:selection.workspaceId,serviceId:selection.serviceId,migrationDigest:selection.migrationDigest};
  function online(registration:OnlineRegistration):void {
    const config=readOnlineConfiguration(registration,selection.workspaceId);add(registration.ref);configurations.add(registration.ref);
    for(const ref of [...config.settings.prometheus.map(p=>p.bearerTokenFile),...config.settings.alertmanager.map(p=>p.bearerTokenFile)])if(ref!==null){readRegular(ref,1048576,true);add(ref);}
  }
  function host(connectionRef:string,ownerConfigRef:string,ownerConfigDigest:string):void {
    const connection=readHostConnection(add(connectionRef)),owner=json(ownerConfigRef);
    // Preserve exact expired registrations too. Backup is not live admission.
    if(digest(owner)!==ownerConfigDigest||owner.schema!=='runtime-legacy-owner-host/v1'||owner.workspaceId!==selection.workspaceId||owner.projectId!==connection.projectId||connection.workspaceId!==selection.workspaceId||connection.serviceId!==selection.serviceId||typeof owner.legacyBindingRef!=='string'||!same(readLegacyBinding(add(owner.legacyBindingRef)),binding))fail();
    const credential=json(connection.tokenRef);
    if(credential.schema!=='runtime-client-credential/v1'||credential.workspaceId!==connection.workspaceId||credential.projectId!==connection.projectId||credential.principalId!==connection.principalId)fail();
    if(owner.online!==undefined)online(owner.online as OnlineRegistration);
  }
  const pluginRef=path.join(selection.serviceRoot,'plugin/.mcp.json');
  if(fs.existsSync(pluginRef)){
    const server=record(record(json(pluginRef).mcpServers).evopilot_runtime_legacy);
    if(server.type!=='stdio'||!Array.isArray(server.args)||server.args.some(v=>typeof v!=='string'))fail();
    const args=server.args as string[];
    const options:Record<string,string>={};
    for(let i=1;i<args.length;i++){
      const key=String(args[i]);if(Object.hasOwn(options,key))fail();
      if(key==='--legacy-only')options[key]='true';else {if(typeof args[i+1]!=='string'||String(args[i+1]).startsWith('--'))fail();options[key]=String(args[++i]);}
    }
    const primary=path.join(selection.serviceRoot,'connection.json');if(options['--connection-ref']!==primary)fail();
    let ownerRef=options['--owner-config-ref'],ownerDigest=options['--owner-config-digest'],operatorRef=options['--operator-config-ref'],operatorDigest=options['--operator-config-digest'];
    if(options['--setup-config-ref']){
      if(ownerRef||operatorRef)fail();const setup=readWorkspaceSetupConfiguration(add(options['--setup-config-ref']));
      if(digest(setup)!==options['--setup-config-digest']||setup.serviceRoot!==selection.serviceRoot||setup.workspaceRoot!==selection.workspaceRoot||setup.workspaceId!==selection.workspaceId||setup.serviceId!==selection.serviceId)fail();
      if(setup.ownerHost){ownerRef=setup.ownerHost.ref;ownerDigest=setup.ownerHost.digest;}
      if(setup.workspaceOperator){operatorRef=path.join(selection.serviceRoot,'workspace-operator.json');operatorDigest=digest(json(operatorRef));}
    }
    if(Boolean(ownerRef)!==Boolean(ownerDigest)||Boolean(operatorRef)!==Boolean(operatorDigest))fail();
    if(ownerRef)host(primary,ownerRef,ownerDigest);
    if(operatorRef){
      const operator=readWorkspaceOperatorConfiguration(add(operatorRef));
      const {referenceFiles:_selectedRefs,...selectedLocation}=selection,{referenceFiles:_operatorRefs,...operatorLocation}=operator.selection;
      if(digest(operator)!==operatorDigest||!same(operatorLocation,selectedLocation)||!same(operator.ownerHost,ownerRef?{ownerConfigRef:ownerRef,ownerConfigDigest:ownerDigest}:{}))fail();
      for(const h of operator.online?.hosts??[])host(h.connectionRef,h.ownerConfigRef,h.ownerConfigDigest);
    }
  }
  // Original v0.8 configuration can exist before any standalone online grant.
  // Once explicit registrations exist, other copied configuration is history.
  const canonicalRef=path.join(selection.workspaceRoot,'online/configuration.json');
  if(!configurations.size&&fs.existsSync(canonicalRef)){const v=json(canonicalRef);online({ref:canonicalRef,digest:digest(v)});}
  return [...refs].sort();
}
