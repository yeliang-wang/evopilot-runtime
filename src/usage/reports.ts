import {digest,record,reject,string} from '../server/errors.js';
import type {RuntimeStore} from '../server/store.js';
import {METRICS,type Metric,type UsageAttribution,type UsageSource,type UsageRecord} from './contract.js';
import {usageObjects,deriveDeltas,sourceRecords,attributionsAt,type UsageDelta} from './ledger.js';

export interface UsageQuery{targetVersion:string;instanceId?:string;stageId?:string;throughTime?:string;}
export interface CounterSummary{recorded:number|null;unknownRecords:number;}
type Totals=Record<Metric,CounterSummary>;
export interface ReportRow{key:string;records:number;counts:Totals;shareOfRecordedTotal:number|null;}
export interface UsageReport{
  schema:'runtime-token-report/v1';projectId:string;targetVersion:string;instanceId:string|null;stageId:string|null;
  cutoffRevision:number;throughTime:string|null;createdAt:string;label:'已记录消耗';
  coverage:'REGISTERED_SOURCES_ONLY';completeVersionTotal:false;records:number;counts:Totals;
  unclassified:{records:number;counts:Totals};issues:{code:string;records:number}[];
  sources:{id:string;threadId:string;epoch:string;agentRole:string;parentThreadId:string|null;revoked:boolean;records:number}[];
  views:Record<'stage'|'node'|'target'|'task'|'workType'|'model'|'agent'|'instance',ReportRow[]>;
  truncatedViews:string[];digest:string;
}
function summary(rows:UsageDelta[]):Totals{
  return Object.fromEntries(METRICS.map(key=>{
    const values=rows.map(r=>r.metrics[key]).filter((v):v is number=>v!==null),sum=values.reduce((n,v)=>n+v,0);
    if(!Number.isSafeInteger(sum))reject('USAGE_OVERFLOW','Recorded count exceeds exact integer range');
    return[key,{recorded:values.length?sum:null,unknownRecords:rows.length-values.length}];
  })) as Totals;
}
export function createUsageReport(store:RuntimeStore,projectId:string,query:UsageQuery,cutoff=store.revision(projectId)):UsageReport{
  string(query.targetVersion,256);if(!Number.isSafeInteger(cutoff)||cutoff<0||cutoff>store.revision(projectId))reject('USAGE_CUTOFF','Invalid ledger cutoff');
  if(query.throughTime!==undefined&&!Number.isFinite(Date.parse(query.throughTime)))reject('USAGE_CUTOFF','Invalid timestamp cutoff');
  const bindings=attributionsAt(store,projectId,cutoff);
  const selected:UsageDelta[]=[],unclassified:UsageDelta[]=[],sources:UsageReport['sources']=[],issueCounts=new Map<string,number>();
  for(const source of usageObjects<UsageSource>(store,projectId,'usage-source')){
    const rows=sourceRecords(store,projectId,source.id,cutoff),deltas=deriveDeltas(source,rows,bindings);
    let count=0;
    for(const delta of deltas){
      if(query.throughTime!==undefined&&Date.parse(delta.record.observedAt)>Date.parse(query.throughTime))continue;
      const b=delta.binding;
      if(!b){unclassified.push(delta);continue;}
      if(b.targetVersion!==query.targetVersion||query.instanceId!==undefined&&b.instanceId!==query.instanceId||query.stageId!==undefined&&b.stageId!==query.stageId)continue;
      selected.push(delta);count++;for(const code of new Set(delta.issues))issueCounts.set(code,(issueCounts.get(code)??0)+1);
    }
    if(count||bindings.some(b=>b.sourceId===source.id&&b.targetVersion===query.targetVersion))sources.push({id:source.id,threadId:source.threadId,epoch:source.epoch,agentRole:source.agentRole,parentThreadId:source.parentThreadId,revoked:source.revoked,records:count});
  }
  const counts=summary(selected),truncatedViews:string[]=[],bySource=new Map(sources.map(s=>[s.id,s]));
  const keys={stage:(r:UsageDelta)=>r.binding!.baseStage,node:(r:UsageDelta)=>r.binding!.stageId,target:(r:UsageDelta)=>r.binding!.targetRef,task:(r:UsageDelta)=>r.binding!.taskId+'/'+r.binding!.attemptId,workType:(r:UsageDelta)=>r.binding!.workType,model:(r:UsageDelta)=>(r.record.provider??'unknown')+'/'+(r.record.model??'unknown'),agent:(r:UsageDelta)=>(bySource.get(r.record.sourceId)?.agentRole??'unknown')+'/'+(bySource.get(r.record.sourceId)?.threadId??'unknown'),instance:(r:UsageDelta)=>r.binding!.instanceId};
  const views=Object.fromEntries(Object.entries(keys).map(([view,key])=>{
    const groups=new Map<string,UsageDelta[]>();for(const row of selected){const k=key(row),group=groups.get(k)??[];group.push(row);groups.set(k,group);}
    const entries=[...groups].sort(([a],[b])=>a.localeCompare(b));
    if(entries.length>25){const rest=entries.splice(24);entries.push(['[remaining groups]',rest.flatMap(([,rows])=>rows)]);truncatedViews.push(view);}
    return[view,entries.map(([key,rows])=>{const own=summary(rows);return{key,records:rows.length,counts:own,shareOfRecordedTotal:counts.total.recorded!==null&&counts.total.recorded>0&&own.total.recorded!==null?own.total.recorded/counts.total.recorded:null};})];
  })) as UsageReport['views'];
  if(sources.length>100)reject('USAGE_REPORT_SCOPE','Narrow the report scope when more than 100 source epochs contribute',413);
  const content={schema:'runtime-token-report/v1' as const,projectId,targetVersion:query.targetVersion,instanceId:query.instanceId??null,stageId:query.stageId??null,cutoffRevision:cutoff,throughTime:query.throughTime??null,createdAt:new Date().toISOString(),label:'已记录消耗' as const,coverage:'REGISTERED_SOURCES_ONLY' as const,completeVersionTotal:false as const,records:selected.length,counts,unclassified:{records:unclassified.length,counts:summary(unclassified)},issues:[...issueCounts].sort(([a],[b])=>a.localeCompare(b)).map(([code,records])=>({code,records})),sources,views,truncatedViews};
  return{...content,digest:digest(content)};
}
export function usageMarkdown(report:UsageReport):string{
  const cell=(v:string)=>v.replace(/[|\r\n<>]/g,' '),count=(v:CounterSummary)=>v.recorded===null?'未知':String(v.recorded)+(v.unknownRecords?'（另有 '+v.unknownRecords+' 条未知）':'');
  const lines=['# '+cell(report.projectId)+' / '+cell(report.targetVersion)+' — 已记录消耗','','仅覆盖显式登记的来源，不代表整个版本的完整总量。','',`账本截点：${report.cutoffRevision}；记录数：${report.records}；未归属记录：${report.unclassified.records}。`,'',`输入：${count(report.counts.input)}；输出：${count(report.counts.output)}；合计：${count(report.counts.total)}。`,'','缓存输入是输入子项，推理输出是输出子项，不再次相加。各视图来自同一份账本，不能相加。'];
  for(const [name,rows] of Object.entries(report.views)){lines.push('','## '+name,'','| 分组 | 已记录 Token | 占已记录合计 |','| --- | ---: | ---: |');for(const row of rows)lines.push('| '+cell(row.key)+' | '+count(row.counts.total)+' | '+(row.shareOfRecordedTotal===null?'未知':(row.shareOfRecordedTotal*100).toFixed(2)+'%')+' |');}
  if(report.issues.length)lines.push('','统计缺口：'+report.issues.map(i=>i.code+' × '+i.records).join('；'));
  return lines.join('\n')+'\n';
}
export function parseUsageQuery(input:Record<string,unknown>):UsageQuery{
  return{targetVersion:string(input.targetVersion,256),...(input.instanceId!==undefined?{instanceId:string(input.instanceId,256)}:{}),...(input.stageId!==undefined?{stageId:string(input.stageId,256)}:{}),...(input.throughTime!==undefined?{throughTime:string(input.throughTime,64)}:{})};
}
