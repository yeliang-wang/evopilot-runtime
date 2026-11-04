import {digest,exact,record,reject,slug,string} from '../server/errors.js';
import {authorize,type Principal} from '../server/security.js';
import type {RuntimeStore} from '../server/store.js';
import {inspectInstance} from '../lifecycle/instance.js';
import type {LifecycleInstance} from '../lifecycle/instance.js';
import {isPreparationRef,readPreparationPacket} from '../lifecycle/preparation.js';
import {readUsageGrant} from './codex.js';
import {BASE_STAGES,attributionInput,type UsageSource,type UsageAttribution} from './contract.js';
import {usageObjects,attributionsAt,sourceRecords} from './ledger.js';
import {createUsageReport,parseUsageQuery,usageMarkdown,type UsageReport} from './reports.js';

export const USAGE_READS=['usage.sources.list','usage.attributions.list','usage.report.read','usage.snapshots.list','usage.snapshot.read'] as const;
export const USAGE_WRITES=['usage.source.register','usage.source.revoke','usage.attribution.bind','usage.attribution.close','usage.snapshot.create'] as const;
export interface UsageSnapshot{schema:'runtime-usage-snapshot/v1';id:string;kind:'on-demand'|'stage'|'publication'|'closure';trigger:unknown;report:UsageReport;}
export function createUsageService(store:RuntimeStore){
  function source(projectId:string,id:string):UsageSource{const found=store.object(projectId,'usage-source',id) as UsageSource|null;if(!found)reject('NOT_FOUND','Usage source not found',404);return found;}
  function read(actor:Principal,projectId:string,operation:string,input:Record<string,unknown>):unknown{
    authorize(actor,projectId,'read');
    if(operation==='usage.sources.list'){
      exact(input,[],['after']);const rows=store.objectsPage(projectId,'usage-source',input.after===undefined?'':string(input.after),50);return{sources:rows.map(({value})=>{const v=value as UsageSource,c=store.object(projectId,'usage-checkpoint',v.id) as {offset:number;latestSequence:number|null}|null;return{...v,cursor:c?{offset:c.offset,latestSequence:c.latestSequence}:null,health:store.object(projectId,'usage-health',v.id)};}),nextAfter:rows.length===50?rows.at(-1)!.id:null,coverage:'EXPLICIT_SOURCES_ONLY'};
    }
    if(operation==='usage.attributions.list'){
      exact(input,[],['after']);const rows=store.objectsPage(projectId,'usage-attribution',input.after===undefined?'':string(input.after),50);
      return{bindings:rows.map(r=>({binding:r.value,closure:store.object(projectId,'usage-attribution-close',r.id)})),nextAfter:rows.length===50?rows.at(-1)!.id:null};
    }
    if(operation==='usage.report.read'){
      exact(input,['targetVersion'],['instanceId','stageId','throughTime','format']);if(input.format!==undefined&&!['json','markdown'].includes(String(input.format)))reject('USAGE_FORMAT','Choose json or markdown');
      const report=createUsageReport(store,projectId,parseUsageQuery(input));return input.format==='markdown'?{report,markdown:usageMarkdown(report)}:report;
    }
    if(operation==='usage.snapshots.list'){
      exact(input,[],['after']);const rows=store.objectsPage(projectId,'usage-snapshot',input.after===undefined?'':string(input.after),50);
      return{snapshots:rows.map(r=>{const v=r.value as UsageSnapshot;return{id:v.id,kind:v.kind,trigger:v.trigger,reportDigest:v.report.digest,targetVersion:v.report.targetVersion,cutoffRevision:v.report.cutoffRevision};}),nextAfter:rows.length===50?rows.at(-1)!.id:null};
    }
    if(operation==='usage.snapshot.read'){
      exact(input,['id'],['format']);if(input.format!==undefined&&!['json','markdown'].includes(String(input.format)))reject('USAGE_FORMAT','Choose json or markdown');
      const saved=store.object(projectId,'usage-snapshot',string(input.id)) as UsageSnapshot|null;if(!saved)reject('NOT_FOUND','Usage snapshot not found',404);return input.format==='markdown'?{...saved,markdown:usageMarkdown(saved.report)}:saved;
    }
    return reject('UNKNOWN_OPERATION','Unsupported usage read',404);
  }
  function write(actor:Principal,projectId:string,operation:string,input:Record<string,unknown>,requestId:string,expectedRevision:number,reauthorize:()=>Principal){
    authorize(actor,projectId,'draft.write');
    return store.mutate(actor,{projectId,operation,requestId,expectedRevision,input,permission:'draft.write'},()=>{
      if(operation==='usage.source.register'){
        exact(input,['sourceId']);const id=slug(input.sourceId),g=readUsageGrant(store.root,store.workspaceId,projectId,id);
        if(g.principalId!==actor.id||g.principalRevision!==actor.revision)reject('USAGE_SCOPE','Local grant belongs to another current principal',403);
        if(store.object(projectId,'usage-source',id))reject('USAGE_SOURCE_EXISTS','Use the retained source; never reset its cursor',409);
        if(store.usageThreadOwner(g.identity.threadId,g.epoch))reject('USAGE_DUPLICATE_SOURCE','This thread epoch is already registered; use its retained source',409);
        const priorSources=store.usageThreadSources(g.identity.threadId);
        if(priorSources.length>=100)reject('USAGE_SOURCE_LIMIT','Thread epoch lineage exceeds the bounded profile',413);
        if(priorSources.length){
          if(!g.predecessorId||priorSources.some(p=>p.projectId!==projectId)||!priorSources.some(p=>p.id===g.predecessorId))reject('USAGE_EPOCH','Resume the original source or explicitly bind its next epoch',409);
          for(const p of priorSources)if(!source(projectId,p.id).revoked)reject('USAGE_EPOCH','Revoke the original epoch before selecting its replacement',409);
          const old=source(projectId,g.predecessorId),oldGrant=readUsageGrant(store.root,store.workspaceId,projectId,old.id),checkpoint=store.object(projectId,'usage-checkpoint',old.id) as {offset:number}|null;
          if(oldGrant.identity.dev===g.identity.dev&&oldGrant.identity.ino===g.identity.ino&&(!checkpoint||!g.initialCursor||g.initialCursor.offset<checkpoint.offset))reject('USAGE_EPOCH_OVERLAP','A new epoch cannot reread original consumed bytes',409);
        }else if(g.predecessorId)reject('USAGE_EPOCH','Original predecessor source does not exist',409);
        const saved:UsageSource={schema:'runtime-usage-source/v1',id,projectId,threadId:g.identity.threadId,epoch:g.epoch,agentRole:g.agentRole,parentThreadId:g.parentThreadId,baseline:g.baseline,baselineEvidence:g.baselineEvidence,principalId:actor.id,principalRevision:actor.revision,grantDigest:digest(g),registeredAt:new Date().toISOString(),revoked:false};
        return{objects:[{kind:'usage-source',id,value:saved}],value:saved,event:{type:'usage-source-registered',data:{sourceId:id}}};
      }
      if(operation==='usage.source.revoke'){
        exact(input,['sourceId']);const saved=source(projectId,slug(input.sourceId)),next={...saved,revoked:true};
        return{objects:[{kind:'usage-source',id:saved.id,value:next}],value:{sourceId:saved.id,revoked:true,historyRetained:true},event:{type:'usage-source-revoked',data:{sourceId:saved.id}}};
      }
      if(operation==='usage.attribution.bind'){
        const v=attributionInput(input),selected=source(projectId,v.sourceId);
        if(selected.revoked)reject('USAGE_REVOKED','Cannot bind a revoked source',403);
        const raw=store.object(projectId,'lifecycle-instance',v.instanceId);if(!raw)reject('NOT_FOUND','Bind usage to an actual lifecycle instance',404);
        const instance=inspectInstance(raw as LifecycleInstance),node=instance.definition.nodes.find(n=>n.id===v.stageId);
        if(instance.pins.projectId!==projectId||instance.pins.targetRef!==v.targetRef||!node)reject('USAGE_ATTRIBUTION_SCOPE','Usage must match the exact instance, Target and node');
        if(isPreparationRef(v.targetRef)&&readPreparationPacket(store,projectId,v.targetRef).input.target.version!==v.targetVersion)reject('USAGE_VERSION_DRIFT','Usage version differs from the retained exact Target',409);
        if(BASE_STAGES.includes(v.stageId as typeof BASE_STAGES[number])&&v.stageId!==v.baseStage)reject('USAGE_BASE_STAGE','A Base node cannot be reported as another Base stage');
        for(const old of attributionsAt(store,projectId,store.revision(projectId))){
          if(old.id===v.id)reject('USAGE_BINDING_EXISTS','Attribution history is immutable',409);
          if(old.instanceId===v.instanceId&&(old.targetVersion!==v.targetVersion||old.targetRef!==v.targetRef))reject('USAGE_VERSION_DRIFT','An instance cannot silently move to another version',409);
          if(old.sourceId===v.sourceId&&Math.max(old.afterSequence,v.afterSequence)<Math.min(old.throughSequence??Infinity,v.throughSequence??Infinity))reject('USAGE_RANGE_OVERLAP','A source event cannot belong to multiple tasks or versions',409);
          if(old.instanceId===v.instanceId&&old.stageId===v.stageId&&old.baseStage!==v.baseStage)reject('USAGE_BASE_STAGE','An extension must retain its explicit Base-stage mapping',409);
        }
        const saved:UsageAttribution={...v,schema:'runtime-usage-attribution/v1',projectId,instancePinsDigest:instance.pinsDigest,recordedRevision:store.revision(projectId)+1};
        return{objects:[{kind:'usage-attribution',id:v.id,value:saved}],value:saved,event:{type:'usage-attribution-bound',data:{sourceId:v.sourceId,bindingId:v.id,instanceId:v.instanceId}}};
      }
      if(operation==='usage.attribution.close'){
        exact(input,['bindingId','throughSequence']);const id=slug(input.bindingId),old=store.object(projectId,'usage-attribution',id) as UsageAttribution|null;
        if(!old)reject('NOT_FOUND','Original attribution not found',404);
        if(old.throughSequence!==null||store.object(projectId,'usage-attribution-close',id))reject('USAGE_RANGE_CLOSED','Original range is already closed',409);
        const end=input.throughSequence;if(!Number.isSafeInteger(end)||Number(end)<=old.afterSequence)reject('USAGE_RANGE','A nonempty range is required');
        const records=sourceRecords(store,projectId,old.sourceId,store.revision(projectId));
        if(records.some(r=>r.sequence>Number(end)))reject('USAGE_RANGE_HISTORY','Closing cannot move existing recorded usage to another task',409);
        const saved={bindingId:id,throughSequence:Number(end),recordedRevision:store.revision(projectId)+1};
        return{objects:[{kind:'usage-attribution-close',id,value:saved}],value:saved,event:{type:'usage-attribution-closed',data:{bindingId:id,throughSequence:Number(end)}}};
      }
      if(operation==='usage.snapshot.create'){
        exact(input,['targetVersion'],['instanceId','stageId','throughTime']);const report=createUsageReport(store,projectId,parseUsageQuery(input));
        const saved:UsageSnapshot={schema:'runtime-usage-snapshot/v1',id:digest({requestId,principalId:actor.id}),kind:'on-demand',trigger:{requestId,principalId:actor.id},report};
        return{objects:[{kind:'usage-snapshot',id:saved.id,value:saved}],value:{id:saved.id,digest:report.digest,cutoffRevision:report.cutoffRevision},event:{type:'usage-snapshot-created',data:{snapshotId:saved.id}}};
      }
      return reject('UNKNOWN_OPERATION','Unsupported usage write',404);
    },reauthorize);
  }
  return{read,write};
}
