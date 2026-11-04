import {digest,reject} from '../server/errors.js';
import type {RuntimeStore,StoredObject} from '../server/store.js';
import type {Principal} from '../server/security.js';
import {authorize} from '../server/security.js';
import {METRICS,unknownMetrics,observation,type Metrics,type UsageObservation,type UsageRecord,type UsageSource,type UsageAttribution} from './contract.js';

export function* usageObjects<T>(store:RuntimeStore,projectId:string,kind:string):Generator<T>{
  let after='';for(;;){const rows=store.objectsPage(projectId,kind,after);for(const row of rows)yield row.value as T;if(rows.length<100)return;after=rows.at(-1)!.id;}
}
export function sourceRecords(store:RuntimeStore,projectId:string,sourceId:string,cutoff:number):UsageRecord[]{
  return [...usageObjects<UsageRecord>(store,projectId,'usage-observation')].filter(v=>v.sourceId===sourceId&&v.recordedRevision<=cutoff).sort((a,b)=>a.sequence-b.sequence);
}
export function attributionsAt(store:RuntimeStore,projectId:string,cutoff:number):UsageAttribution[]{
  const closed=new Map([...usageObjects<{bindingId:string;throughSequence:number;recordedRevision:number}>(store,projectId,'usage-attribution-close')].filter(v=>v.recordedRevision<=cutoff).map(v=>[v.bindingId,v.throughSequence]));
  return [...usageObjects<UsageAttribution>(store,projectId,'usage-attribution')].filter(v=>v.recordedRevision<=cutoff).map(v=>closed.has(v.id)?{...v,throughSequence:closed.get(v.id)!}:v);
}
/** Native adapter is the only writer of counters. HTTP can bind or read usage,
 * but cannot claim arbitrary token measurements or forge Host provenance. */
export function retainObservations(store:RuntimeStore,actor:Principal,source:UsageSource,values:UsageObservation[],checkpoint:unknown,reauthorize:()=>Principal):void{
  authorize(actor,source.projectId,'draft.write');if(source.revoked)reject('USAGE_REVOKED','Source was revoked',403);
  if(values.length>32)reject('USAGE_BATCH','Usage batches are bounded');
  const objects:StoredObject[]=[],seen=new Map<string,string>(),revision=store.revision(source.projectId)+1;
  for(const value of values){
    const v=observation(value),id=digest({sourceId:source.id,epoch:source.epoch,sequence:v.sequence});
    const old=store.object(source.projectId,'usage-observation',id) as UsageRecord|null;
    const content={...v,schema:'runtime-usage-observation/v1' as const,sourceId:source.id,epoch:source.epoch};
    if(old){const{recordedRevision:unused,...prior}=old;if(digest(prior)!==digest(content))reject('USAGE_SOURCE_CORRECTION','Original sequence changed; retain source and register an explicit new epoch',409);continue;}
    if(seen.has(id)){if(seen.get(id)!==digest(content))reject('USAGE_SOURCE_CORRECTION','Batch contains conflicting source sequence',409);continue;}
    seen.set(id,digest(content));objects.push({kind:'usage-observation',id,value:{...content,recordedRevision:revision}});
  }
  objects.push({kind:'usage-checkpoint',id:source.id,value:checkpoint});
  const input={sourceId:source.id,observationDigests:values.map(digest),checkpoint};
  store.mutate(actor,{projectId:source.projectId,operation:'usage.source.observed',requestId:'usage-'+digest(input),expectedRevision:revision-1,input,permission:'draft.write'},()=>({objects,value:{sourceId:source.id,retained:objects.length-1},event:{type:'usage-observed',data:{sourceId:source.id,count:objects.length-1}}}),reauthorize);
}
export interface UsageDelta{record:UsageRecord;metrics:Metrics;issues:string[];binding:UsageAttribution|null;}
/** Recompute from ordered original observations at a fixed durable cutoff.
 * This admits late observations without overwriting previous report revisions. */
export function deriveDeltas(source:UsageSource,records:UsageRecord[],bindings:UsageAttribution[]):UsageDelta[]{
  const high={...source.baseline},result:UsageDelta[]=[];
  for(const entry of records){
    const counts=unknownMetrics(),issues:string[]=[];
    for(const key of METRICS){
      const current=entry.cumulative[key],previous=high[key];
      if(current===null){issues.push('MISSING_'+key);continue;}
      if(previous===null){
        // A fork can inherit the parent's last counter as well as its total.
        // Without its original baseline, exclude that first observation rather
        // than attributing inherited work to the child.
        if(source.parentThreadId!==null){counts[key]=null;issues.push('UNKNOWN_FORK_BASELINE_'+key);}
        else{counts[key]=entry.last[key];if(entry.last[key]===null)issues.push('UNKNOWN_BASELINE_'+key);else issues.push('PARTIAL_HISTORY_'+key);}
        high[key]=current;continue;
      }
      if(current<previous){issues.push('RESET_OR_CORRECTION_'+key);continue;}
      counts[key]=current-previous;high[key]=current;
    }
    if(counts.input!==null&&counts.output!==null){const sum=counts.input+counts.output;if(counts.total!==null&&counts.total!==sum){issues.push('INCONSISTENT_DELTA');counts.total=null;}else counts.total=sum;}
    for(const [subset,parent] of [['cachedInput','input'],['cacheWriteInput','input'],['reasoningOutput','output']] as const)if(counts[subset]!==null&&counts[parent]!==null&&counts[subset]!>counts[parent]!){counts[subset]=null;issues.push('INCONSISTENT_SUBSET_'+subset);}
    const matches=bindings.filter(b=>b.sourceId===source.id&&entry.sequence>b.afterSequence&&(b.throughSequence===null||entry.sequence<=b.throughSequence));
    if(matches.length>1)reject('CORRUPT_USAGE_BINDING','Source event is attributed twice',503);
    result.push({record:entry,metrics:counts,issues,binding:matches[0]??null});
  }
  return result;
}
