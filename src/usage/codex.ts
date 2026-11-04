import {constants,openSync,closeSync,fstatSync,readSync,realpathSync,lstatSync} from 'node:fs';
import {isAbsolute,resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {digest,exact,record,reject,string,slug} from '../server/errors.js';
import {readPrivateJson} from '../server/security.js';
import {metrics,unknownMetrics,type Metrics,type UsageObservation} from './contract.js';

export interface CodexFileIdentity{dev:number;ino:number;metadataDigest:string;threadId:string;codexVersion:string;provider:string|null;}
export interface CodexCursor{offset:number;tailDigest:string;model:string|null;provider:string|null;turnId:string|null;latestSequence:number|null;}
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const BATCH_BYTES=4*1024*1024;
function openSource(path:string):number{
  if(!isAbsolute(path)||resolve(path)!==path||realpathSync(path)!==path||!path.endsWith('.jsonl'))reject('UNSAFE_USAGE_SOURCE','Select one canonical regular Codex JSONL file');
  const st=lstatSync(path);
  // Codex may create 0644 rollout files. They are read-only external inputs,
  // never Runtime credentials. Require exact owner/identity and reject writes
  // by other OS principals; Runtime grants and retained statistics stay 0600.
  if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||st.nlink!==1||(st.mode&0o022)!==0)reject('UNSAFE_USAGE_SOURCE','Codex source must be owned by this OS user and not writable by other principals');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),opened=fstatSync(fd);
  if(opened.dev!==st.dev||opened.ino!==st.ino||!opened.isFile()||opened.nlink!==1||opened.uid!==process.getuid?.()||(opened.mode&0o022)!==0){closeSync(fd);reject('UNSAFE_USAGE_SOURCE','Selected source changed during open');}return fd;
}
function metadata(fd:number):{identity:CodexFileIdentity;end:number}{
  const buf=Buffer.alloc(1024*1024),n=readSync(fd,buf,0,buf.length,0),end=buf.subarray(0,n).indexOf(10);
  if(end<0)reject('USAGE_SOURCE_FORMAT','A bounded complete Codex session metadata line is required');
  let row:Record<string,unknown>;try{row=record(JSON.parse(buf.subarray(0,end).toString('utf8')));}catch{return reject('USAGE_SOURCE_FORMAT','Invalid Codex session metadata');}
  if(row.type!=='session_meta')reject('USAGE_SOURCE_FORMAT','Only explicitly selected Codex rollout sources are supported');
  const p=record(row.payload),st=fstatSync(fd),threadId=string(p.id,128),codexVersion=string(p.cli_version,128);
  // No cwd, instructions, prompts, keys or account metadata leave this reader.
  const identity={dev:st.dev,ino:st.ino,metadataDigest:sha(buf.subarray(0,end+1)),threadId,codexVersion,provider:p.model_provider==null?null:string(p.model_provider,128)};
  return{identity,end:end+1};
}
export function inspectCodexSource(path:string):CodexFileIdentity{const fd=openSource(path);try{return metadata(fd).identity;}finally{closeSync(fd);}}
export function inspectCodexCursor(path:string,offset:number):CodexCursor{
  const fd=openSource(path);try{
    const selected=metadata(fd),position=offset===0?selected.end:offset;
    if(!Number.isSafeInteger(position)||position<selected.end||position>fstatSync(fd).size)reject('USAGE_SOURCE_OFFSET','Select a complete source boundary');
    const byte=Buffer.alloc(1);if(readSync(fd,byte,0,1,position-1)!==1||byte[0]!==10)reject('USAGE_SOURCE_OFFSET','Offset must follow a complete original record');
    return{offset:position,tailDigest:tail(fd,position),model:null,provider:selected.identity.provider,turnId:null,latestSequence:null};
  }finally{closeSync(fd);}
}
function counter(value:unknown):Metrics{
  if(value==null)return unknownMetrics();const v=record(value);
  const take=(key:string):number|null=>v[key]===undefined||v[key]===null?null:v[key] as number;
  return metrics({input:take('input_tokens'),output:take('output_tokens'),total:take('total_tokens'),cachedInput:take('cached_input_tokens'),cacheWriteInput:take('cache_write_input_tokens'),reasoningOutput:take('reasoning_output_tokens')});
}
function tail(fd:number,offset:number):string{const len=Math.min(256,offset),buf=Buffer.alloc(len);if(readSync(fd,buf,0,len,offset-len)!==len)reject('USAGE_SOURCE_CHANGED','Source was truncated');return sha(buf);}
export function collectCodexUsage(path:string,expected:CodexFileIdentity,cursor:CodexCursor|null):{observations:UsageObservation[];cursor:CodexCursor;caughtUp:boolean}{
  const fd=openSource(path);
  try{
    const selected=metadata(fd);if(digest(selected.identity)!==digest(expected))reject('USAGE_SOURCE_CHANGED','Original Codex file identity changed; explicitly register the replacement');
    const prior=cursor??{offset:selected.end,tailDigest:tail(fd,selected.end),model:null,provider:expected.provider,turnId:null,latestSequence:null};
    if(!Number.isSafeInteger(prior.offset)||prior.offset<selected.end||prior.offset>fstatSync(fd).size||tail(fd,prior.offset)!==prior.tailDigest)reject('USAGE_SOURCE_CHANGED','Retained source offset no longer matches original bytes');
    const buf=Buffer.alloc(BATCH_BYTES),n=readSync(fd,buf,0,buf.length,prior.offset),bytes=buf.subarray(0,n),next={...prior},observations:UsageObservation[]=[];
    let start=0;
    while(observations.length<32){
      const end=bytes.indexOf(10,start);if(end<0)break;
      const line=bytes.subarray(start,end),position=prior.offset+start;start=end+1;next.offset=prior.offset+start;
      // Parse only metadata needed for model/turn attribution and token events.
      // Content is never persisted or returned, even for malformed source rows.
      if(!line.includes(Buffer.from('"turn_context"'))&&!line.includes(Buffer.from('"token_count"')))continue;
      let row:Record<string,unknown>;try{row=record(JSON.parse(line.toString('utf8')));}catch{return reject('USAGE_SOURCE_FORMAT','Selected Codex record is malformed');}
      if(row.type==='turn_context'){
        const p=record(row.payload);next.model=p.model==null?null:string(p.model,128);next.turnId=p.turn_id==null?null:string(p.turn_id,128);if(p.model_provider!=null)next.provider=string(p.model_provider,128);continue;
      }
      if(row.type!=='event_msg')continue;const p=record(row.payload);if(p.type!=='token_count'||p.info==null)continue;
      const info=record(p.info),sequence=position+1,originalId=Number.isSafeInteger(row.ordinal)&&Number(row.ordinal)>0?'ordinal:'+row.ordinal:'offset:'+position;
      observations.push({sequence,eventId:expected.threadId+':'+originalId,observedAt:string(row.timestamp,64),turnId:next.turnId,cumulative:counter(info.total_token_usage),last:counter(info.last_token_usage),model:next.model,provider:next.provider,provenanceDigest:sha(line)});next.latestSequence=sequence;
    }
    if(start===0&&n===BATCH_BYTES)reject('USAGE_SOURCE_LINE_LIMIT','Selected source has a record beyond the 4 MiB adapter profile; statistics are incomplete');
    next.tailDigest=tail(fd,next.offset);
    return{observations,cursor:next,caughtUp:next.offset===fstatSync(fd).size};
  }finally{closeSync(fd);}
}
export function validateFileIdentity(value:unknown):CodexFileIdentity{
  const v=record(value);exact(v,['dev','ino','metadataDigest','threadId','codexVersion','provider']);
  if(!Number.isSafeInteger(v.dev)||!Number.isSafeInteger(v.ino)||!/^[a-f0-9]{64}$/.test(string(v.metadataDigest)))reject('USAGE_SOURCE_IDENTITY','Invalid source identity');
  string(v.threadId,128);string(v.codexVersion,128);if(v.provider!==null)string(v.provider,128);return v as unknown as CodexFileIdentity;
}

export interface UsageGrant{
  schema:'runtime-codex-usage-grant/v1';id:string;workspaceId:string;projectId:string;principalId:string;principalRevision:number;
  path:string;identity:CodexFileIdentity;epoch:string;agentRole:'main'|'subagent'|'unknown';parentThreadId:string|null;
  baseline:Metrics;baselineEvidence:string|null;expiresAt:string;
  predecessorId?:string;initialCursor?:CodexCursor;
}
export function validateUsageGrant(value:unknown):UsageGrant{
  const v=record(value);exact(v,['schema','id','workspaceId','projectId','principalId','principalRevision','path','identity','epoch','agentRole','parentThreadId','baseline','baselineEvidence','expiresAt'],['predecessorId','initialCursor']);
  if(v.schema!=='runtime-codex-usage-grant/v1')reject('USAGE_GRANT','Unsupported usage grant');
  for(const key of ['id','workspaceId','projectId','principalId','epoch'] as const)slug(v[key]);
  string(v.path,4096);validateFileIdentity(v.identity);
  if(!Number.isSafeInteger(v.principalRevision)||Number(v.principalRevision)<1||!Number.isFinite(Date.parse(string(v.expiresAt,64))))reject('USAGE_GRANT','Invalid principal or expiry');
  if(!['main','subagent','unknown'].includes(String(v.agentRole)))reject('USAGE_GRANT','Invalid agent role');
  if(v.parentThreadId!==null)string(v.parentThreadId,128);
  const baseline=metrics(v.baseline);if(v.baselineEvidence!==null)string(v.baselineEvidence,256);
  if(Object.values(baseline).some(n=>n!==null)&&v.baselineEvidence===null)reject('USAGE_BASELINE','A known baseline must retain its evidence reference');
  if(v.agentRole==='subagent'&&v.parentThreadId===null)reject('USAGE_LINEAGE','Explicit subagent parent is required');
  if(v.predecessorId!==undefined){slug(v.predecessorId);if(v.initialCursor===undefined)reject('USAGE_EPOCH','A replacement epoch requires an explicit original source boundary');}
  if(v.initialCursor!==undefined){const c=record(v.initialCursor);exact(c,['offset','tailDigest','model','provider','turnId','latestSequence']);if(!Number.isSafeInteger(c.offset)||Number(c.offset)<1||!/^[a-f0-9]{64}$/.test(string(c.tailDigest))||c.model!==null||c.turnId!==null||c.latestSequence!==null||c.provider!==(v.identity as CodexFileIdentity).provider)reject('USAGE_SOURCE_OFFSET','Use the native inspected source boundary');}
  return {...v,baseline} as unknown as UsageGrant;
}
/** Read retained identity for historical lineage checks only. Callers must
 * verify the original grant digest; this never authorizes source collection. */
export function readUsageGrantIdentity(stateRoot:string,workspaceId:string,projectId:string,id:string):UsageGrant{
  slug(id);const value=validateUsageGrant(readPrivateJson(join(stateRoot,'usage-grants',id+'.json')));
  if(value.id!==id||value.workspaceId!==workspaceId||value.projectId!==projectId)reject('USAGE_SCOPE','Source grant belongs to another scope',403);
  return value;
}
export function readUsageGrant(stateRoot:string,workspaceId:string,projectId:string,id:string):UsageGrant{
  const value=readUsageGrantIdentity(stateRoot,workspaceId,projectId,id);
  if(Date.parse(value.expiresAt)<=Date.now())reject('USAGE_EXPIRED','Source grant expired',403);return value;
}
