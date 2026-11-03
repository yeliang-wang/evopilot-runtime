import type {CallToolResult,Tool} from '@modelcontextprotocol/sdk/types.js';
import {canonicalEvidence,exact,record,ServiceError,string} from '../server/errors.js';
import {getGuide,scenarios} from './guidance/guide.js';

export const GUIDE_TOOL_NAME='evopilot_v01_guide';
export const GUIDE_TOOL:Tool={
  name:GUIDE_TOOL_NAME,
  description:'Read current scenario guidance offline, without credentials, activation, product state or service startup. Historical scenario identifiers grant no acceptance or execution authority.',
  inputSchema:{type:'object',properties:{scenario:{type:'string',enum:[...scenarios]}},required:['scenario'],additionalProperties:false},
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
};
/** No client, store, filesystem or provider is reachable from this entry. */
export function callGuide(value:unknown):CallToolResult {
  try{
    const input=record(value);exact(input,['scenario']);const result=getGuide(string(input.scenario,128));
    const data={namespace:'evopilot-runtime-legacy',authority:false,passive:true,connectionAccessed:false,result};
    return{content:[{type:'text',text:canonicalEvidence(data)}],structuredContent:data};
  }catch(error){
    const e=error instanceof ServiceError?error:new ServiceError('INVALID_REQUEST','Unknown guide scenario');
    const data={namespace:'evopilot-runtime-legacy',authority:false,passive:true,connectionAccessed:false,error:{code:e.code,message:e.message}};
    return{isError:true,content:[{type:'text',text:canonicalEvidence(data)}],structuredContent:data};
  }
}
