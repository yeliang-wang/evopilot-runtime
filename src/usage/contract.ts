import {exact,record,reject,slug,string} from '../server/errors.js';

export const BASE_STAGES=['scope','plan','implementation','candidate','verification','release-decision','publication','closure'] as const;
export type BaseStage=typeof BASE_STAGES[number];
export const WORK_TYPES=['requirements-planning','design','coding','testing','review-repair','documentation-release','unclassified'] as const;
export const METRICS=['input','output','total','cachedInput','cacheWriteInput','reasoningOutput'] as const;
export type Metric=typeof METRICS[number];
export type Metrics=Record<Metric,number|null>;
export const unknownMetrics=():Metrics=>({input:null,output:null,total:null,cachedInput:null,cacheWriteInput:null,reasoningOutput:null});
export const zeroMetrics=():Metrics=>({input:0,output:0,total:0,cachedInput:0,cacheWriteInput:0,reasoningOutput:0});
export function metrics(value:unknown):Metrics{
  const v=record(value);exact(v,METRICS);
  for(const key of METRICS)if(v[key]!==null&&(!Number.isSafeInteger(v[key])||Number(v[key])<0))reject('USAGE_METRIC','Counts must be nonnegative safe integers or null');
  const result={...v} as Metrics;
  for(const [subset,parent] of [['cachedInput','input'],['cacheWriteInput','input'],['reasoningOutput','output']] as const)if(result[subset]!==null&&result[parent]!==null&&result[subset]!>result[parent]!)reject('USAGE_METRIC','A token subset exceeds its inclusive parent');
  if(result.input!==null&&result.output!==null){const total=result.input+result.output;if(!Number.isSafeInteger(total)||result.total!==null&&result.total!==total)reject('USAGE_METRIC','Inclusive total differs from input plus output');result.total=total;}
  return result;
}
export interface UsageObservation{
  sequence:number;eventId:string;observedAt:string;turnId:string|null;
  cumulative:Metrics;last:Metrics;model:string|null;provider:string|null;provenanceDigest:string;
}
export interface UsageSource{
  schema:'runtime-usage-source/v1';id:string;projectId:string;threadId:string;epoch:string;
  agentRole:'main'|'subagent'|'unknown';parentThreadId:string|null;
  baseline:Metrics;baselineEvidence:string|null;principalId:string;principalRevision:number;
  grantDigest:string;registeredAt:string;revoked:boolean;
}
export interface UsageAttribution{
  schema:'runtime-usage-attribution/v1';id:string;sourceId:string;afterSequence:number;throughSequence:number|null;
  projectId:string;targetVersion:string;targetRef:string;instanceId:string;instancePinsDigest:string;
  stageId:string;baseStage:BaseStage;taskId:string;attemptId:string;workType:typeof WORK_TYPES[number];
  recordedRevision:number;
}
export interface UsageRecord extends UsageObservation{schema:'runtime-usage-observation/v1';sourceId:string;epoch:string;recordedRevision:number;}
export function observation(value:unknown):UsageObservation{
  const v=record(value);exact(v,['sequence','eventId','observedAt','turnId','cumulative','last','model','provider','provenanceDigest']);
  if(!Number.isSafeInteger(v.sequence)||Number(v.sequence)<1)reject('USAGE_SEQUENCE','A positive source sequence is required');
  string(v.eventId,256);if(!Number.isFinite(Date.parse(string(v.observedAt,64))))reject('USAGE_TIMESTAMP','Invalid usage timestamp');
  for(const key of ['turnId','model','provider'] as const)if(v[key]!==null)string(v[key],256);
  if(!/^[a-f0-9]{64}$/.test(string(v.provenanceDigest)))reject('USAGE_PROVENANCE','Original source digest required');
  return {...v,cumulative:metrics(v.cumulative),last:metrics(v.last)} as unknown as UsageObservation;
}
export function attributionInput(value:unknown){
  const v=record(value);exact(v,['id','sourceId','afterSequence','throughSequence','targetVersion','targetRef','instanceId','stageId','baseStage','taskId','attemptId','workType']);
  for(const key of ['id','sourceId','instanceId'] as const)slug(v[key]);
  for(const key of ['targetVersion','targetRef','stageId','taskId','attemptId'] as const)string(v[key],256);
  if(!Number.isSafeInteger(v.afterSequence)||Number(v.afterSequence)<0||v.throughSequence!==null&&(!Number.isSafeInteger(v.throughSequence)||Number(v.throughSequence)<=Number(v.afterSequence)))reject('USAGE_RANGE','Use an explicit nonempty source sequence range');
  if(!BASE_STAGES.includes(v.baseStage as BaseStage)||!WORK_TYPES.includes(v.workType as typeof WORK_TYPES[number]))reject('USAGE_CLASSIFICATION','Unknown Base stage or work type');
  return v as unknown as Omit<UsageAttribution,'schema'|'projectId'|'instancePinsDigest'|'recordedRevision'>;
}
