/** Protected first-use selection. Types/readers only; no installer or launcher
 * can be imported through the transport layer. */
import {isAbsolute,resolve,parse,join} from 'node:path';
import {canonical,exact,record,reject,slug,string} from '../server/errors.js';
import {readPrivateJson} from '../server/security.js';
import {validateWorkspaceOperatorGrant,type WorkspaceOperatorGrant} from './workspace.js';

export interface WorkspaceSetupGrant {
  projectRoot:string;workspaceRoot:string;owners:{ontology:string;harness:string};
  ownerHost:{ref:string;digest:string}|null;workspaceOperator:WorkspaceOperatorGrant|null;
  serviceAfterSetup:'running'|'stopped';expiresAt:string;
}
export interface WorkspaceSetupConfiguration extends WorkspaceSetupGrant {
  schema:'runtime-workspace-setup-operator/v1';serviceRoot:string;workspaceId:string;
  serviceId:string;connectionRef:string;installationPlanDigest:string;
  specificationDigest:string;connectionDigest:string;
}
const absolute=(v:unknown)=>{const p=string(v,4096);if(!isAbsolute(p)||resolve(p)!==p||p===parse(p).root)reject('SETUP_CONFIGURATION','Select canonical absolute locations');return p;};
const hash=(v:unknown)=>{if(!/^[a-f0-9]{64}$/.test(string(v,64)))reject('SETUP_CONFIGURATION','Expected an exact digest');};
export function validateWorkspaceSetupGrant(input:unknown):WorkspaceSetupGrant {
  const g=record(input);exact(g,['projectRoot','workspaceRoot','owners','ownerHost','workspaceOperator','serviceAfterSetup','expiresAt']);
  const a=absolute(g.projectRoot),b=absolute(g.workspaceRoot);if(a===b||a.startsWith(b+'/')||b.startsWith(a+'/'))reject('SETUP_CONFIGURATION','Project and owner state must be separate');
  const owners=record(g.owners);exact(owners,['ontology','harness']);absolute(owners.ontology);absolute(owners.harness);
  if(g.ownerHost!==null){const h=record(g.ownerHost);exact(h,['ref','digest']);absolute(h.ref);hash(h.digest);}
  if(g.workspaceOperator!==null){const m=validateWorkspaceOperatorGrant(g.workspaceOperator);if(m.projectRoot!==a||canonical(m.owners)!==canonical(owners))reject('SETUP_CONFIGURATION','Maintenance must select the same project and owners');}
  if(!['running','stopped'].includes(String(g.serviceAfterSetup))||!Number.isFinite(Date.parse(string(g.expiresAt))))reject('SETUP_CONFIGURATION','Select the post-setup service state and explicit expiry');
  return structuredClone(g) as unknown as WorkspaceSetupGrant;
}
export function readWorkspaceSetupConfiguration(ref:string):WorkspaceSetupConfiguration {
  absolute(ref);const c=record(readPrivateJson(ref));exact(c,['schema','serviceRoot','workspaceId','serviceId','connectionRef','installationPlanDigest','specificationDigest','connectionDigest','projectRoot','workspaceRoot','owners','ownerHost','workspaceOperator','serviceAfterSetup','expiresAt']);
  if(c.schema!=='runtime-workspace-setup-operator/v1')reject('SETUP_CONFIGURATION','Unsupported first-use configuration');
  const {schema,serviceRoot,workspaceId,serviceId,connectionRef,installationPlanDigest,specificationDigest,connectionDigest,...grant}=c;
  validateWorkspaceSetupGrant(grant);absolute(serviceRoot);slug(workspaceId);string(serviceId,128);
  if(absolute(connectionRef)!==join(String(serviceRoot),'connection.json'))reject('SETUP_CONFIGURATION','Connection must belong to the selected service');
  for(const value of [installationPlanDigest,specificationDigest,connectionDigest])hash(value);
  for(const root of [grant.projectRoot,grant.workspaceRoot] as string[])if(root===serviceRoot||root.startsWith(String(serviceRoot)+'/')||String(serviceRoot).startsWith(root+'/'))reject('SETUP_CONFIGURATION','Service, project and owner state must be separate');
  return c as unknown as WorkspaceSetupConfiguration;
}
