import {canonical,exact,record,reject,ServiceError,string} from '../server/errors.js';
import {readHostConnection,hostHeaders,type HostConnection} from '../server/security.js';
export {readHostConnection,hostHeaders,localOrigin,type HostConnection} from '../server/security.js';
import {READ_OPERATIONS,WRITE_OPERATIONS} from '../server/mcp.js';

function validateEnvelope(connection:HostConnection,value:unknown){
  const v=record(value),operation=string(v.operation,128),read=(READ_OPERATIONS as readonly string[]).includes(operation),write=(WRITE_OPERATIONS as readonly string[]).includes(operation);
  if(!read&&!write)reject('UNKNOWN_OPERATION','Unsupported Runtime operation',404);
  exact(v,read?['operation','projectId','input']:['operation','projectId','input','requestId','expectedRevision']);
  if(v.projectId!==connection.projectId)reject('CREDENTIAL_SCOPE','Request belongs to another project',403);record(v.input);
  if(write){string(v.requestId,128);if(!Number.isSafeInteger(v.expectedRevision)||Number(v.expectedRevision)<0)reject('INVALID_REVISION','Use the current project revision');}
  return{envelope:v,write};
}
async function boundedJson(response:Response,signal:AbortSignal):Promise<Record<string,unknown>>{
  if(!response.headers.get('content-type')?.startsWith('application/json')||!response.body)reject('INVALID_SERVICE_RESPONSE','Runtime must return bounded JSON',502);
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){signal.throwIfAborted();const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>16*1024*1024)reject('SERVICE_RESPONSE_LIMIT','Runtime response exceeds the readback limit',502);chunks.push(next.value);}}catch(error){await reader.cancel();throw error;}finally{reader.releaseLock();}
  try{return record(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}catch{return reject('INVALID_SERVICE_RESPONSE','Runtime returned invalid JSON',502);}
}
export interface RuntimeHttpClient {
  readonly connection:Readonly<HostConnection>;
  status(signal?:AbortSignal):Promise<Record<string,unknown>>;
  request(value:unknown,signal?:AbortSignal):Promise<Record<string,unknown>>;
}
/** A transport adapter only. It does not open Runtime/owner databases, change
 * CAS, retry a write or start a service when the selected one is unavailable. */
export function createRuntimeHttpClient(connectionRef:string):RuntimeHttpClient{
  const connection=readHostConnection(connectionRef),original=canonical(connection);
  function headers(){if(canonical(readHostConnection(connectionRef))!==original)reject('CONNECTION_CHANGED','Reconnect after an explicit connection change',409);return hostHeaders(connection);}
  async function status(externalSignal?:AbortSignal){
    const signal=externalSignal?AbortSignal.any([externalSignal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000);
    const response=await fetch(connection.origin+'/api/v1/status?projectId='+encodeURIComponent(connection.projectId),{headers:headers(),signal,redirect:'error'}),body=await boundedJson(response,signal);
    if(!response.ok){const error=record(body.error);reject(string(error.code),string(error.message),response.status);}
    const identity=record(body.result);
    if(identity.product!=='evopilot-runtime'||identity.contract!=='runtime-service/v1'||identity.workspaceId!==connection.workspaceId||identity.projectId!==connection.projectId||identity.serviceId!==connection.serviceId||identity.version!==connection.version||identity.independentLlm!==false)reject('SERVICE_IDENTITY_CHANGED','Runtime identity differs from the installed connection',409);
    return body;
  }
  return{connection:Object.freeze(connection),status,async request(value,externalSignal){
    const {envelope,write}=validateEnvelope(connection,value);
    // Stage admission/preparation can include several fresh provider reads.
    // Its bounded 18s server window plus the separate 10s identity check fit
    // inside this transport allowance. This neither renews execution authority
    // nor changes other operations, and caller cancellation remains shorter.
    const timeout=AbortSignal.timeout(envelope.operation==='lifecycle.stage.request'?30000:15000),signal=externalSignal?AbortSignal.any([externalSignal,timeout]):timeout;
    await status(signal);signal.throwIfAborted();const authorization=headers(),body=canonical(envelope);let response:Response,result:Record<string,unknown>;
    try{
      response=await fetch(connection.origin+'/api/v1/request',{method:'POST',headers:{...authorization,'content-type':'application/json'},body,signal,redirect:'error'});result=await boundedJson(response,signal);
      string(result.requestId,256);if(response.ok){exact(result,['requestId','result']);}else{exact(result,['requestId','error']);const e=record(result.error);string(e.code);string(e.message);}
    }catch{
      throw new ServiceError(write?'REQUEST_OUTCOME_UNKNOWN':'SERVICE_UNAVAILABLE',write?'Inspect the original request receipt; no automatic retry was made.':'The selected Runtime service is unavailable.',503);
    }
    if(!response.ok){const e=record(result.error);throw new ServiceError(string(e.code),string(e.message),response.status);}return result;
  }};
}
