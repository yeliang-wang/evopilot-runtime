/** Explicit local operator selection. References are identities, not new owner
 * permissions. Every project supplies its own existing protected connection. */
import {join,isAbsolute,resolve} from 'node:path';
import {canonical,digest,exact,record,reject,string} from '../../server/errors.js';
import {readHostConnection,readPrivateJson,hostHeaders} from '../../server/security.js';
import {readLegacyBinding} from '../../compat/gateway.js';
import {readLegacyOwnerHostConfiguration} from '../../host/legacy-owners.js';
import {readOnlineConfiguration,validateOnlineRegistration,type OnlineRegistration} from '../../host/online.js';
import {verifyOwnerDistribution} from '../../adapters/published-owners.js';
import {inspectInstalledServiceSelection,type InstalledServiceSelection} from '../service-control.js';

export interface OnlineHostSelection {connectionRef:string;ownerConfigRef:string;ownerConfigDigest:string;}
export interface OnlineWorkerInput {serviceRoot:string;configuration:OnlineRegistration;hosts:OnlineHostSelection[];}
export interface OnlineWorkerSelection {
  schema:'runtime-online-worker-selection/v1';installation:InstalledServiceSelection;
  configuration:OnlineRegistration;hosts:(OnlineHostSelection&{projectId:string;connectionDigest:string;credentialDigest:string})[];
  authority:false;workerStarted:false;selectionDigest:string;
}
const hash=(v:unknown)=>{if(!/^[a-f0-9]{64}$/.test(string(v,64)))reject('ONLINE_WORKER_SELECTION','An exact SHA256 pin is required');};
const absolute=(v:unknown)=>{const p=string(v,4096);if(!isAbsolute(p)||resolve(p)!==p)reject('ONLINE_WORKER_SELECTION','Use canonical absolute references');return p;};
const changed=():never=>reject('ONLINE_WORKER_SELECTION_CHANGED','The selected installation or scoped online configuration changed; inspect before choosing a new operation',409);
export function selectOnlineWorker(input:OnlineWorkerInput):OnlineWorkerSelection {
  exact(record(input),['serviceRoot','configuration','hosts']);absolute(input.serviceRoot);validateOnlineRegistration(input.configuration);
  if(!Array.isArray(input.hosts)||!input.hosts.length||input.hosts.length>64)reject('ONLINE_WORKER_SELECTION','Provide bounded explicit project connections');
  const installation=inspectInstalledServiceSelection(input.serviceRoot),binding=installation.binding;
  if(!binding)reject('ONLINE_WORKSPACE_REQUIRED','The online worker requires the exact bound owner Workspace');
  const configuration=readOnlineConfiguration(input.configuration,binding.workspaceId),main=readHostConnection(join(input.serviceRoot,'connection.json'));
  const scopes=new Set(configuration.settings.scopes.map(s=>s.projectId)),projects=new Set<string>();
  const hosts=input.hosts.map(raw=>{
    exact(record(raw),['connectionRef','ownerConfigRef','ownerConfigDigest']);absolute(raw.connectionRef);absolute(raw.ownerConfigRef);hash(raw.ownerConfigDigest);
    const connection=readHostConnection(raw.connectionRef),owner=readLegacyOwnerHostConfiguration(raw.ownerConfigRef),original=readLegacyBinding(owner.legacyBindingRef);
    if(digest(owner)!==raw.ownerConfigDigest||canonical(original)!==canonical(binding)||connection.serviceId!==installation.serviceId||connection.workspaceId!==installation.workspaceId||connection.origin!==main.origin||connection.version!==main.version||connection.projectId!==owner.projectId||owner.workspaceId!==installation.workspaceId||!owner.online||canonical(owner.online)!==canonical(input.configuration))changed();
    if(!scopes.has(owner.projectId)||projects.has(owner.projectId))reject('ONLINE_WORKER_SCOPE','Select exactly one current owner connection for each configured project',403);projects.add(owner.projectId);
    for(const call of ['native:online.inspect','native:online.tick','native:online.alert.ingest'])if(!owner.owners.harness.calls.includes(call))reject('ONLINE_WORKER_PERMISSION','The existing owner grant must explicitly include the worker online operations',403);
    for(const kind of ['ontology','harness'] as const)verifyOwnerDistribution(kind,owner.owners[kind].packageRoot);
    hostHeaders(connection); // Check the scoped credential without retaining its value.
    return{...raw,projectId:owner.projectId,connectionDigest:digest(connection),credentialDigest:digest(readPrivateJson(connection.tokenRef))};
  });
  if(projects.size!==scopes.size)reject('ONLINE_WORKER_SCOPE','Every configured project needs its own exact connection',403);
  const body={schema:'runtime-online-worker-selection/v1' as const,installation,configuration:structuredClone(input.configuration),hosts,authority:false as const,workerStarted:false as const};
  return{...body,selectionDigest:digest(body)};
}
/** Shape-only validation permits inspection and stopping of our retained job
 * after credentials/configuration expire. It never permits starting it. */
export function validateOnlineWorkerSelection(value:unknown):asserts value is OnlineWorkerSelection {
  const s=record(value);exact(s,['schema','installation','configuration','hosts','authority','workerStarted','selectionDigest']);hash(s.selectionDigest);
  const {selectionDigest,...body}=s;if(s.schema!=='runtime-online-worker-selection/v1'||s.authority!==false||s.workerStarted!==false||digest(body)!==selectionDigest)reject('ONLINE_WORKER_SELECTION','Select a retained exact online worker descriptor');
  const i=record(s.installation),b=record(i.binding);
  exact(i,['schema','serviceRoot','serviceId','workspaceId','installationPlanDigest','distributionManifestDigest','specificationDigest','connectionDigest','configurationPins','binding','authority','selectionDigest']);
  exact(b,['workspaceRoot','workspaceId','serviceId','migrationDigest']);
  if(i.schema!=='runtime-installed-service-selection/v1'||i.authority!==false)reject('ONLINE_WORKER_SELECTION','Retain the original installed service selection');
  absolute(i.serviceRoot);absolute(b.workspaceRoot);string(i.workspaceId,128);string(i.serviceId,128);hash(i.selectionDigest);hash(b.migrationDigest);
  for(const key of ['installationPlanDigest','distributionManifestDigest','specificationDigest','connectionDigest'])hash(i[key]);
  for(const [ref,pin] of Object.entries(record(i.configurationPins))){absolute(ref);hash(pin);}
  if(b.workspaceId!==i.workspaceId||b.serviceId!==i.serviceId)reject('ONLINE_WORKER_SELECTION','Worker installation scope differs');
  const {selectionDigest:pin,...installed}=i;if(digest(installed)!==pin)reject('ONLINE_WORKER_SELECTION','Installation selection integrity differs');
  const c=record(s.configuration);exact(c,['ref','digest']);absolute(c.ref);hash(c.digest);
  if(!Array.isArray(s.hosts)||!s.hosts.length||s.hosts.length>64)reject('ONLINE_WORKER_SELECTION','Retain the exact project connection list');
  const projects=new Set<string>();
  for(const raw of s.hosts){const h=record(raw);exact(h,['connectionRef','ownerConfigRef','ownerConfigDigest','projectId','connectionDigest','credentialDigest']);absolute(h.connectionRef);absolute(h.ownerConfigRef);const project=string(h.projectId,128);if(projects.has(project))reject('ONLINE_WORKER_SELECTION','Retain one connection for each selected project');projects.add(project);for(const key of ['ownerConfigDigest','connectionDigest','credentialDigest'])hash(h[key]);}
}
export function requireCurrentOnlineWorkerSelection(input:OnlineWorkerSelection):void {
  validateOnlineWorkerSelection(input);
  const current=selectOnlineWorker({serviceRoot:input.installation.serviceRoot,configuration:input.configuration,hosts:input.hosts.map(({connectionRef,ownerConfigRef,ownerConfigDigest})=>({connectionRef,ownerConfigRef,ownerConfigDigest}))});
  if(canonical(current)!==canonical(input))changed();
}
