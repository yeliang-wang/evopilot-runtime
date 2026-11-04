import {exact,record,reject,string} from './errors.js';
import {authorize,type Principal} from './security.js';
import type {RuntimeStore,DashboardEventPage} from './store.js';
import {inspectInstance,type LifecycleInstance} from '../lifecycle/instance.js';

// Browser access is a deliberately smaller surface than the Agent HTTP API.
// No execution, approval, release, owner mutation or legacy operation is routed.
export const DASHBOARD_READS=['runtime.status','runtime.receipt.read','lifecycle.base.inspect','lifecycle.definition.inspect','lifecycle.definition.read','lifecycle.definition.source.read','lifecycle.definition.validate'] as const;
export const DASHBOARD_WRITES=['lifecycle.draft.save','lifecycle.definition.save-and-activate'] as const;
export function dashboardEnvelope(value:unknown,projectId:string):Record<string,unknown>{
  const envelope=record(value),operation=string(envelope.operation);
  if(![...DASHBOARD_READS,...DASHBOARD_WRITES].includes(operation as never))reject('DASHBOARD_OPERATION','This operation is not available in the Dashboard',403);
  exact(envelope,(DASHBOARD_WRITES as readonly string[]).includes(operation)?['operation','projectId','input','requestId','expectedRevision']:['operation','projectId','input']);
  if(envelope.projectId!==projectId)reject('FORBIDDEN','Browser request belongs to another project',403);record(envelope.input);return envelope;
}
/** Monitor payload contains the pinned graph and observed stage facts only.
 * It never includes YAML, semantic configuration, credentials or editor payload.
 * The instance retains its original definition even after active changes. */
export function monitorSnapshot(store:RuntimeStore,actor:Principal,projectId:string,input:Record<string,unknown>){
  authorize(actor,projectId,'read');exact(input,[],['after','revision']);
  const revision=store.revision(projectId);
  if(input.revision!==undefined&&input.revision!==revision)reject('MONITOR_REVISION_CHANGED','Refresh the monitor snapshot before continuing pagination',409);
  if(input.after!==undefined&&input.revision===undefined)reject('MONITOR_REVISION_REQUIRED','Pagination must retain its original project revision');
  const after=input.after===undefined?undefined:string(input.after),page=store.monitorInstances(actor,projectId,after);
  const projected=page.rows.map(row=>{
    const instance=inspectInstance(row as LifecycleInstance);
    if(instance.pins.projectId!==projectId)reject('CORRUPT_INSTANCE','Stored monitor instance belongs to another project',503);
    return{id:instance.id,createdAt:instance.createdAt,definitionRevisionId:instance.pins.definitionRevisionId,base:instance.pins.base,goalRef:instance.pins.goalRef,targetRef:instance.pins.targetRef,loopRef:instance.pins.loopRef,candidateDigest:instance.candidateDigest,graph:instance.definition.nodes.map(n=>({id:n.id,source:n.source,stage:n.stage,dependsOn:n.dependsOn,checks:n.checks})),stages:instance.stages};
  });
  const instances:typeof projected=[];let bytes=2048;
  for(const instance of projected){const size=Buffer.byteLength(JSON.stringify(instance));if(bytes+size>200000)break;instances.push(instance);bytes+=size;}
  if(projected.length&&!instances.length)reject('MONITOR_LIMIT','One instance exceeds the supported monitor page',413);
  return{projectId,revision,instances,nextAfter:instances.length<projected.length?instances.at(-1)!.id:page.nextAfter,observedAt:new Date().toISOString(),readOnly:true};
}
export function monitorEvents(value:DashboardEventPage){
  // Keep the authenticated cursor/gap semantics, redact every event data body.
  return{projectId:value.projectId,cursor:value.cursor,watermark:value.watermark,gap:value.gap,events:value.events.map(value=>{const event=record(value);return{seq:event.seq,revision:event.revision,type:event.type,at:event.at};})};
}
