import {randomUUID} from 'node:crypto';
import type {CallToolResult,Tool} from '@modelcontextprotocol/sdk/types.js';
import type {RuntimeHttpClient} from './client.js';
import {canonicalEvidence,exact,record,reject,ServiceError,string} from '../server/errors.js';
import {LEGACY_READ,LEGACY_WRITE,legacyNativeFamily,legacyOperation,type LegacyFamily} from '../compat/catalog.js';
import type {LegacyOwnerRoutes} from './legacy-owners.js';

/** Translate an original Runtime envelope only. No local DB, service startup,
 * owner source, automatic retry or receipt/revision translation is involved. */
export async function forwardLegacyRuntime(client:RuntimeHttpClient,family:LegacyFamily,value:unknown,signal?:AbortSignal):Promise<Record<string,unknown>> {
  const envelope=record(value),operation=string(envelope.operation,128),entry=legacyOperation(family,operation);
  if(!entry)reject('LEGACY_OPERATION','Unsupported Runtime compatibility operation',404);
  exact(envelope,entry.write?['operation','scope','input','requestId','expectedRevision']:['operation','scope','input']);
  const scope=record(envelope.scope);exact(scope,['visibility','projectId']);record(envelope.input);
  if(scope.projectId!==client.connection.projectId)reject('CREDENTIAL_SCOPE','Legacy envelope belongs to another project',403);
  return client.request({operation:entry.write?LEGACY_WRITE:LEGACY_READ,projectId:client.connection.projectId,input:{family,envelope:{operation,scope,input:envelope.input}},...(entry.write?{requestId:envelope.requestId,expectedRevision:envelope.expectedRevision}:{})},signal);
}
export function createLegacyTools(client:RuntimeHttpClient,owners?:LegacyOwnerRoutes) {
  const prefix='evopilot_v01_',sessionId=randomUUID();let active=false;
  const envelope={type:'object' as const,properties:{operation:{type:'string'},scope:{type:'object'},input:{type:'object'},requestId:{type:'string'},expectedRevision:{type:'integer',minimum:0}},required:['operation','scope','input'],additionalProperties:false};
  const empty={type:'object' as const,properties:{},additionalProperties:false};
  const definitions:Tool[]=[
    ...['inspect','activate','deactivate','capabilities'].map(name=>({name:prefix+name,description:'Runtime compatibility '+name+'. Activation is local session intent only; the independently installed service must already be running. No authority or service startup is granted.',inputSchema:empty,annotations:{readOnlyHint:name==='inspect'||name==='capabilities',destructiveHint:false,idempotentHint:true,openWorldHint:false}})),
    ...['request','native'].map(name=>({name:prefix+name,description:'Forward an original '+name+' envelope. Runtime uses the same independent HTTP service; separately configured historical owner routes delegate directly to their exact published public APIs. Preserve original family/owner revision, request ID and domain approvals. No lifecycle stage or software release is approved by this transport.',inputSchema:{type:'object' as const,properties:{owner:{type:'string',enum:['runtime',...(owners?['ontology','harness']:[])]},envelope},required:['owner','envelope'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true}})),
    ...['dispatch','reconcile'].map(name=>({name:prefix+name,description:'Forward the original legacy Runtime '+name+' request without changing its ID or retrying. Retired JSON dispatch still fails under its original contract.',inputSchema:{type:'object' as const,properties:{args:{type:'object',properties:{scope:{type:'object'},id:{type:'string'},requestId:{type:'string'},expectedRevision:{type:'integer',minimum:0}},required:['scope','id','requestId','expectedRevision'],additionalProperties:false}},required:['args'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true}})),
    ...(owners?.project?['native_project','workspace_project'].map(name=>({name:prefix+name,description:'Use the explicitly registered historical project helper. Retain original scope, fixed source inventory, exact review and private ledger identity. Preparation or ledger status grants no domain approval or software release.',inputSchema:{type:'object' as const,properties:{operation:{type:'string'},input:{type:'object'},...(name==='workspace_project'?{requestId:{type:'string'}}:{})},required:['operation','input',...(name==='workspace_project'?['requestId']:[])],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false}})):[]),
  ];
  function reply(result:unknown,error?:ServiceError,correlation?:string,owner?:'ontology'|'harness'):CallToolResult {
    const data={namespace:'evopilot-runtime-legacy',sessionId,sessionActive:active,connection:{workspaceId:client.connection.workspaceId,projectId:client.connection.projectId,serviceId:client.connection.serviceId,version:client.connection.version},authority:false,migrationNotice:'Runtime calls now use the independent HTTP service. Configured owner calls use the published owner API in this Host process; legacy records do not activate a Project Lifecycle.',...(owner?{delegation:{owner,transport:'local-published-owner-api',runtimeHttpAuthoring:false}}:{}),...(correlation?{correlation}:{}) ,...(error?{error:{code:error.code,message:error.message}}:{result})};
    return{content:[{type:'text',text:canonicalEvidence(data)}],structuredContent:data,...(error?{isError:true}:{})};
  }
  return{definitions,sessionActive:()=>active,deactivate:()=>{active=false;},has:(name:string)=>definitions.some(tool=>tool.name===name),async call(name:string,value:unknown,signal?:AbortSignal):Promise<CallToolResult>{
    try{
      const args=record(value),action=name.slice(prefix.length);
      if(!definitions.some(tool=>tool.name===name))reject('UNKNOWN_TOOL','Unknown legacy tool',404);
      if(['inspect','activate','deactivate','capabilities'].includes(action))exact(args,[]);
      if(action==='deactivate'){active=false;return reply({deactivated:true,serviceStopped:false});}
      if(action==='inspect'){
        try{const response=await client.status(signal);return reply({connected:true,identity:response.result},undefined,String(response.requestId));}
        catch(error){return reply({connected:false,code:error instanceof ServiceError?error.code:'SERVICE_UNAVAILABLE',serviceStarted:false});}
      }
      if(action==='activate'){const response=await client.status(signal);if(!record(response.result).legacy)reject('LEGACY_NOT_BOUND','No verified legacy migration is bound to this service',409);active=true;return reply({activated:true,identity:response.result,serviceStarted:false},undefined,String(response.requestId));}
      if(!active)reject('SESSION_INACTIVE','Activate this compatibility session explicitly',409);
      if(action==='native_project'||action==='workspace_project'){
        exact(args,['operation','input',...(action==='workspace_project'?['requestId']:[])]);if(!owners?.project)reject('OWNER_ENTRY_REQUIRED','Configure the historical project Host entry');
        return reply(await owners.project.call(action==='native_project'?'native':'workspace',string(args.operation),args.input,action==='workspace_project'?string(args.requestId):undefined,signal));
      }
      let response:Record<string,unknown>;
      if(action==='capabilities'){response=await client.request({operation:LEGACY_READ,projectId:client.connection.projectId,input:{inspect:true}},signal);if(owners)response={...response,result:{...record(response.result),ownerEntries:owners.capabilities()}};}
      else if(action==='request'||action==='native'){
        exact(args,['owner','envelope']);if(args.owner!=='runtime'){
          if(!owners||!['ontology','harness'].includes(String(args.owner)))reject('OWNER_ENTRY_REQUIRED','Configure the historical owner Host entry; Runtime HTTP does not host owner authoring APIs',409);
          return reply(await owners.call(args.owner as 'ontology'|'harness',action,args.envelope,signal),undefined,undefined,args.owner as 'ontology'|'harness');
        }
        const original=record(args.envelope),family=action==='request'?'request':legacyNativeFamily(string(original.operation));
        response=await forwardLegacyRuntime(client,family,original,signal);
      }else{
        exact(args,['args']);const original=record(args.args);exact(original,['scope','id','requestId','expectedRevision']);
        response=await forwardLegacyRuntime(client,'request',{operation:'run.'+action,scope:original.scope,input:{id:original.id},requestId:original.requestId,expectedRevision:original.expectedRevision},signal);
      }
      return reply(response.result,undefined,String(response.requestId));
    }catch(error){return reply(null,error instanceof ServiceError?error:new ServiceError('LEGACY_OPERATION_FAILED','Inspect the original Runtime request; no automatic retry was made.',503));}
  }};
}
