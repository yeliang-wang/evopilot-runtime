/** Protected local operator selection and transport types only. No store,
 * launcher, backup or mutation implementation belongs in the HTTP/Host layer. */
import {isAbsolute,resolve,parse,join} from 'node:path';
import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import {exact,record,reject,slug,string} from '../server/errors.js';
import {readPrivateJson} from '../server/security.js';
import type {ManagedLegacyBinding} from '../compat/managed-store.js';

export const WORKSPACE_CALLS=['workspace_inspect','workspace_capacity','workspace_backup','workspace_backup_inspect','workspace_restore','workspace_migrate','toolchain_inspect','toolchain_prepare'] as const;
export type WorkspaceCall=typeof WORKSPACE_CALLS[number];
export interface WorkspaceOperatorGrant {
  projectRoot:string;referenceFiles:string[];owners:{ontology:string;harness:string};
  calls:WorkspaceCall[];expiresAt:string;
}
export interface WorkspaceOperatorConfiguration {
  schema:'runtime-workspace-operator/v1';
  selection:ManagedLegacyBinding&{projectRoot:string;serviceRoot:string;referenceFiles:string[]};
  specificationDigest:string;connectionRef:string;owners:WorkspaceOperatorGrant['owners'];
  ownerHost:{ownerConfigRef?:string;ownerConfigDigest?:string};calls:WorkspaceCall[];expiresAt:string;
}
export interface WorkspaceOperatorRoutes {
  readonly definitions:Tool[];
  has:(name:string)=>boolean;
  requiresActiveSession:(name:string,input:unknown)=>boolean;
  deactivatesSession:(name:string)=>boolean;
  call:(name:string,input:unknown,signal?:AbortSignal)=>Promise<unknown>;
  refreshesBinding?:(name:string)=>boolean;
}
export interface HostConnectionSelection {connectionRef:string;ownerConfigRef?:string;ownerConfigDigest?:string;}
const absolute=(value:unknown)=>{const path=string(value,4096);if(!isAbsolute(path)||resolve(path)!==path||path===parse(path).root)reject('WORKSPACE_OPERATOR_CONFIGURATION','Use canonical absolute selected paths');return path;};
const hash=(value:unknown)=>{if(!/^[a-f0-9]{64}$/.test(string(value,64)))reject('WORKSPACE_OPERATOR_CONFIGURATION','Expected a SHA256 binding');};
function selectionFields(value:Record<string,unknown>):void {
  absolute(value.projectRoot);
  if(!Array.isArray(value.referenceFiles)||value.referenceFiles.length>128||new Set(value.referenceFiles).size!==value.referenceFiles.length)reject('WORKSPACE_OPERATOR_CONFIGURATION','Invalid selected reference list');
  value.referenceFiles.forEach(absolute);
  const owners=record(value.owners);exact(owners,['ontology','harness']);absolute(owners.ontology);absolute(owners.harness);
  if(!Array.isArray(value.calls)||!value.calls.length||value.calls.length>WORKSPACE_CALLS.length||new Set(value.calls).size!==value.calls.length||value.calls.some(v=>!WORKSPACE_CALLS.includes(v as WorkspaceCall)))reject('WORKSPACE_OPERATOR_CONFIGURATION','Choose explicit supported workspace operations');
  if(!Number.isFinite(Date.parse(string(value.expiresAt))))reject('WORKSPACE_OPERATOR_CONFIGURATION','Expected an explicit operator expiry');
}
export function validateWorkspaceOperatorGrant(value:unknown):WorkspaceOperatorGrant {
  const grant=record(value);exact(grant,['projectRoot','referenceFiles','owners','calls','expiresAt']);selectionFields(grant);return structuredClone(grant) as unknown as WorkspaceOperatorGrant;
}
export function readWorkspaceOperatorConfiguration(ref:string):WorkspaceOperatorConfiguration {
  absolute(ref);const config=record(readPrivateJson(ref));exact(config,['schema','selection','specificationDigest','connectionRef','owners','ownerHost','calls','expiresAt']);
  if(config.schema!=='runtime-workspace-operator/v1')reject('WORKSPACE_OPERATOR_CONFIGURATION','Unsupported workspace operator schema');
  const selection=record(config.selection);exact(selection,['workspaceRoot','workspaceId','serviceRoot','serviceId','migrationDigest','projectRoot','referenceFiles']);
  selectionFields({...config,projectRoot:selection.projectRoot,referenceFiles:selection.referenceFiles});
  absolute(selection.workspaceRoot);absolute(selection.serviceRoot);slug(selection.workspaceId);string(selection.serviceId,128);hash(selection.migrationDigest);hash(config.specificationDigest);
  if(absolute(config.connectionRef)!==join(String(selection.serviceRoot),'connection.json'))reject('WORKSPACE_OPERATOR_CONFIGURATION','Connection must belong to this exact service root');
  const owner=record(config.ownerHost);exact(owner,[],['ownerConfigRef','ownerConfigDigest']);
  if((owner.ownerConfigRef===undefined)!==(owner.ownerConfigDigest===undefined))reject('WORKSPACE_OPERATOR_CONFIGURATION','Incomplete owner Host selection');
  if(owner.ownerConfigRef!==undefined){absolute(owner.ownerConfigRef);hash(owner.ownerConfigDigest);}
  return config as unknown as WorkspaceOperatorConfiguration;
}
