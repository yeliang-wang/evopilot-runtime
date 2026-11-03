import type {Session,MonitorPage,Pending} from './types';
export class ApiError extends Error {constructor(readonly code:string,message:string,readonly status=0){super(message);}}
export async function json<T>(path:string,options:RequestInit={}):Promise<T>{
 let response:Response;try{response=await fetch(path,{...options,credentials:'same-origin',redirect:'error',signal:options.signal??AbortSignal.timeout(20000)});}catch{throw new ApiError('TRANSPORT_UNKNOWN','连接中断。请核对原请求，不要重复提交。');}
 if(!response.headers.get('content-type')?.startsWith('application/json')||!response.body)throw new ApiError('INVALID_RESPONSE','服务返回了无法识别的响应。');
 const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>262144)throw new ApiError('RESPONSE_LIMIT','服务响应超出读取上限。');parts.push(part.value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}let value:{result?:T;error?:{code?:string;message?:string}};
 try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as typeof value;}catch{throw new ApiError('INVALID_RESPONSE','服务响应不完整。');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError('INVALID_RESPONSE','服务响应结构无效。');
 if(!response.ok||value.error)throw new ApiError(value.error?.code??'REQUEST_FAILED',value.error?.message??'请求未完成。',response.status);
 if(!Object.hasOwn(value,'result'))throw new ApiError('INVALID_RESPONSE','服务未返回结果。');return value.result as T;
}
export const currentSession=()=>json<Session>('/api/v1/dashboard/session');
export async function connect(code:string):Promise<Session>{await json('/api/v1/dashboard/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code})});return currentSession();}
export const disconnect=(s:Session)=>json('/api/v1/dashboard/logout',{method:'POST',headers:{'content-type':'application/json','x-runtime-csrf':s.csrf},body:'{}'});
export const call=<T>(s:Session,operation:string,input:Record<string,unknown>={},extra:Record<string,unknown>={},signal?:AbortSignal)=>json<T>('/api/v1/dashboard/request',{method:'POST',headers:{'content-type':'application/json','x-runtime-csrf':s.csrf},body:JSON.stringify({operation,projectId:s.projectId,input,...extra}),signal});
export async function source(s:Session,revisionId:string):Promise<string>{let offset=0;const parts:Uint8Array[]=[];let total=0;for(let n=0;n<9;n++){
 const page=await call<{revisionId:string;data:string;nextOffset:number|null;totalBytes:number}>(s,'lifecycle.definition.source.read',{revisionId,offset});
 if(page.revisionId!==revisionId||page.totalBytes>262144||page.totalBytes<0)throw new ApiError('SOURCE_CHANGED','源码读取与选定修订不一致。');
 const bytes=Uint8Array.from(atob(page.data),c=>c.charCodeAt(0));total+=bytes.length;if(total>page.totalBytes||page.nextOffset!==null&&page.nextOffset!==total)throw new ApiError('SOURCE_CHANGED','源码分块不连续。');parts.push(bytes);
 if(page.nextOffset===null){if(total!==page.totalBytes)throw new ApiError('SOURCE_CHANGED','源码分块不完整。');const all=new Uint8Array(total);let at=0;for(const part of parts){all.set(part,at);at+=part.length;}return new TextDecoder('utf-8',{fatal:true}).decode(all);}offset=page.nextOffset;
 }throw new ApiError('SOURCE_LIMIT','源码分块超过上限。');}
export const monitor=(after?:string,revision?:number)=>json<MonitorPage>('/api/v1/dashboard/monitor'+(after?'?'+new URLSearchParams({after,revision:String(revision)}).toString():''));
const pendingKey=(s:Session)=>'evopilot.pending.'+s.serviceId+'.'+s.projectId+'.'+s.principalId;
export function savePending(s:Session,operation:string):Pending{const pending={projectId:s.projectId,principalId:s.principalId,serviceId:s.serviceId,requestId:crypto.randomUUID(),operation};sessionStorage.setItem(pendingKey(s),JSON.stringify(pending));return pending;}
export function loadPending(s:Session):Pending|null{try{const value=JSON.parse(sessionStorage.getItem(pendingKey(s))??'null') as Pending|null;return value&&value.serviceId===s.serviceId&&value.projectId===s.projectId&&value.principalId===s.principalId&&typeof value.requestId==='string'?value:null;}catch{return null;}}
export const clearPending=(s:Session)=>sessionStorage.removeItem(pendingKey(s));
