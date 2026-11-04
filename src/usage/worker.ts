import {digest,record,ServiceError} from '../server/errors.js';
import {authorize,type Principal} from '../server/security.js';
import type {RuntimeStore,StoredObject} from '../server/store.js';
import {readUsageGrant} from './codex.js';
import {collectCodexUsage,type CodexCursor} from './codex.js';
import {retainObservations,usageObjects} from './ledger.js';
import type {UsageSource,UsageAttribution,UsageRecord} from './contract.js';
import {BASE_STAGES} from './contract.js';
import {createUsageReport} from './reports.js';
import type {UsageSnapshot} from './service.js';
import type {LifecycleInstance} from '../lifecycle/instance.js';

interface Trigger{instanceId:string;stageId:string;stageRequestId:string;eventRevision:number;completedAt:string;}
/** Independent observer: no execution adapter, stage mutation, CI dispatch or
 * authority decision is available here. Every error stays in usage health. */
export function createUsageWorker(store:RuntimeStore,principal:(id:string)=>Principal|null,intervalMs=1000){
  let after:{projectId:string;id:string}|undefined,closed=false;
  const errors=new Map<string,string>(),cursors=new Map<string,string>();
  function current(source:UsageSource):Principal{
    const actor=principal(source.principalId);
    if(!actor||actor.revision!==source.principalRevision)throw new ServiceError('USAGE_AUTHORITY_CHANGED','Usage source principal changed',403);
    authorize(actor,source.projectId,'draft.write');return actor;
  }
  function health(source:UsageSource,actor:Principal,status:string,code:string|null){
    const value={sourceId:source.id,status,code},old=store.object(source.projectId,'usage-health',source.id);
    if(old&&digest(old)===digest(value))return;
    store.mutate(actor,{projectId:source.projectId,operation:'usage.health.observed',requestId:'usage-health-'+digest({value,revision:store.revision(source.projectId)}),expectedRevision:store.revision(source.projectId),input:value,permission:'read'},()=>({objects:[{kind:'usage-health',id:source.id,value}],value,event:{type:'usage-health-observed',data:value}}),()=>current(source));
  }
  function collect(source:UsageSource,actor:Principal){
    if(source.revoked)return;
    const grant=readUsageGrant(store.root,store.workspaceId,source.projectId,source.id);
    if(digest(grant)!==source.grantDigest)throw new ServiceError('USAGE_GRANT_CHANGED','Original usage grant changed',409);
    const old=store.object(source.projectId,'usage-checkpoint',source.id) as CodexCursor|null,result=collectCodexUsage(grant.path,grant.identity,old??grant.initialCursor??null);
    if(!old||digest(old)!==digest(result.cursor))retainObservations(store,actor,source,result.observations,result.cursor,()=>current(source));
    health(source,actor,result.caughtUp?'CAUGHT_UP':'CATCHING_UP',null);
  }
  function observeCompletions(source:UsageSource,actor:Principal){
    const projectId=source.projectId,prior=cursors.get(projectId)??(store.object(projectId,'usage-event-cursor','stages') as {cursor:string}|null)?.cursor;
    const page=store.events(actor,projectId,prior),objects:StoredObject[]=[];
    let nonUsage=false;
    for(const value of page.events){
      const event=record(value);if(!String(event.type).startsWith('usage-'))nonUsage=true;
      if(event.type!=='stage-observed')continue;
      const data=record(event.data);if(data.phase!=='COMPLETE'||!BASE_STAGES.includes(data.stageId as typeof BASE_STAGES[number]))continue;
      const instance=store.object(projectId,'lifecycle-instance',String(data.instanceId)) as LifecycleInstance|null;
      if(!instance||instance.stages[String(data.stageId)]?.status!=='PASSED'||instance.stages[String(data.stageId)].requestId!==data.stageRequestId)continue;
      const trigger:Trigger={instanceId:instance.id,stageId:String(data.stageId),stageRequestId:String(data.stageRequestId),eventRevision:Number(event.revision),completedAt:String(event.at)},id=digest(trigger);
      if(!store.object(projectId,'usage-trigger',id))objects.push({kind:'usage-trigger',id,value:trigger});
    }
    if(nonUsage){
      objects.push({kind:'usage-event-cursor',id:'stages',value:{cursor:page.cursor}});
      const input={cursor:page.cursor,triggerIds:objects.filter(o=>o.kind==='usage-trigger').map(o=>o.id)};
      store.mutate(actor,{projectId,operation:'usage.stage.observed',requestId:'usage-stage-'+digest(input),expectedRevision:store.revision(projectId),input,permission:'read'},()=>({objects,value:{triggers:objects.length-1},event:{type:'usage-stage-observed',data:{triggers:objects.length-1}}}),()=>current(source));
    }
    cursors.set(projectId,page.cursor);
  }
  function snapshots(source:UsageSource,actor:Principal){
    const projectId=source.projectId,bindings=[...usageObjects<UsageAttribution>(store,projectId,'usage-attribution')];
    let watermark=0;for(const b of bindings)watermark=Math.max(watermark,b.recordedRevision);for(const r of usageObjects<UsageRecord>(store,projectId,'usage-observation'))watermark=Math.max(watermark,r.recordedRevision);for(const c of usageObjects<{recordedRevision:number}>(store,projectId,'usage-attribution-close'))watermark=Math.max(watermark,c.recordedRevision);
    const pending:{trigger:Trigger;targetVersion:string;id:string;progressId:string;previousWatermark:number}[]=[];
    for(const trigger of usageObjects<Trigger>(store,projectId,'usage-trigger')){
      const versions=[...new Set(bindings.filter(b=>b.instanceId===trigger.instanceId).map(b=>b.targetVersion))];
      for(const targetVersion of versions){
        const id=digest({trigger,targetVersion,watermark});if(store.object(projectId,'usage-snapshot',id))continue;
        const progressId=digest({trigger,targetVersion}),progress=store.object(projectId,'usage-trigger-progress',progressId) as {watermark:number}|null;
        pending.push({trigger,targetVersion,id,progressId,previousWatermark:progress?.watermark??-1});
      }
    }
    // Give unseen triggers priority, then refresh the oldest ledger cutoffs.
    // Starting at the first trigger for every new watermark would starve all
    // later stages while usage keeps arriving. Progress is committed with the
    // immutable report so restart and failed writes preserve fair recovery.
    pending.sort((a,b)=>a.previousWatermark-b.previousWatermark||a.trigger.eventRevision-b.trigger.eventRevision||a.id.localeCompare(b.id));
    for(const {trigger,targetVersion,id,progressId} of pending.slice(0,2)){
      const report=createUsageReport(store,projectId,{targetVersion,throughTime:trigger.completedAt});
      const saved:UsageSnapshot={schema:'runtime-usage-snapshot/v1',id,kind:trigger.stageId==='publication'?'publication':trigger.stageId==='closure'?'closure':'stage',trigger,report};
      const input={snapshotId:id,eventRevision:trigger.eventRevision,watermark};
      store.mutate(actor,{projectId,operation:'usage.snapshot.observed',requestId:'usage-snapshot-'+id,expectedRevision:store.revision(projectId),input,permission:'read'},()=>({objects:[{kind:'usage-snapshot',id,value:saved},{kind:'usage-trigger-progress',id:progressId,value:{watermark,snapshotId:id}}],value:{snapshotId:id,reportDigest:report.digest},event:{type:'usage-snapshot-created',data:{snapshotId:id,instanceId:trigger.instanceId,stageId:trigger.stageId}}}),()=>current(source));
    }
  }
  function tick(){
    if(closed)return;
    try{
      const rows=store.usageSourcePage(after);if(!rows.length){after=undefined;return;}
      // One bounded source batch per turn leaves the lifecycle executor free.
      const row=rows[0];after=row;const source=store.object(row.projectId,'usage-source',row.id) as UsageSource;
      // Revocation stops collection inside collect(); retained reports still
      // follow lifecycle events under the exact current principal authority.
      let actor:Principal;
      try{actor=current(source);}catch(error){errors.set(row.projectId,error instanceof ServiceError?error.code:'USAGE_AUTHORITY_UNAVAILABLE');return;}
      try{collect(source,actor);errors.delete(row.projectId);}catch(error){const code=error instanceof ServiceError?error.code:'USAGE_SOURCE_UNAVAILABLE';errors.set(row.projectId,code);try{health(source,actor,'INCOMPLETE',code);}catch{/* Usage health must not affect lifecycle. */}}
      try{observeCompletions(source,actor);snapshots(source,actor);}catch(error){errors.set(row.projectId,error instanceof ServiceError?error.code:'USAGE_REPORT_UNAVAILABLE');}
    }catch{/* A broken usage index cannot fail or restart business execution. */}
  }
  const timer=setInterval(tick,intervalMs);timer.unref();
  return{tick,health(projectId:string){return{enabled:true,error:errors.get(projectId)??null,blockingLifecycle:false,coverage:'EXPLICIT_SOURCES_ONLY'};},close(){closed=true;clearInterval(timer);}};
}
