#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {createRuntimeHttpClient,type RuntimeHttpClient} from './client.js';
import {canonicalReadback,record,ServiceError} from '../server/errors.js';
import {READ_OPERATIONS,WRITE_OPERATIONS,runtimeToolDefinitions} from '../server/mcp.js';
import {createLegacyTools} from './legacy-tools.js';

/** Optional transport compatibility only. The bridge has no store, executor,
 * service launcher or separate approval state. HTTP is the primary entry. */
export function createStdioBridge(client:RuntimeHttpClient):Server{
  const legacy=createLegacyTools(client);
  const server=new Server({name:'evopilot-runtime-stdio-bridge',version:client.connection.version},{capabilities:{tools:{}},instructions:'Compatibility transport to the same independent Runtime service. Prefer the Runtime HTTP plugin. No state or execution authority is created by this bridge.'});
  server.setRequestHandler(ListToolsRequestSchema,async()=>{const status=await client.status();return{tools:[...runtimeToolDefinitions(),...(record(status.result).legacy?legacy.definitions:[])]};});
  server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
    if(legacy.has(request.params.name))return legacy.call(request.params.name,request.params.arguments,extra.signal);
    try{const args=record(request.params.arguments),read=request.params.name==='runtime_read',write=request.params.name==='runtime_write';if(!read&&!write||!(read?READ_OPERATIONS:WRITE_OPERATIONS).includes(args.operation as never))throw new ServiceError('UNKNOWN_TOOL','Tool does not permit this operation',404);const result=await client.request(args,extra.signal);return{content:[{type:'text',text:canonicalReadback(String(args.operation),result)}]};}
    catch(error){const e=error instanceof ServiceError?error:new ServiceError('SERVICE_UNAVAILABLE','The selected Runtime service is unavailable.',503);return{isError:true,content:[{type:'text',text:JSON.stringify({error:{code:e.code,message:e.message}})}]};}
  });return server;
}
export async function bridgeMain(argv:string[]):Promise<void>{
  if(argv.length!==2||argv[0]!=='--connection-ref')throw new ServiceError('INVALID_ARGUMENT','Expected the protected connection reference');
  const server=createStdioBridge(createRuntimeHttpClient(argv[1]));await server.connect(new StdioServerTransport());
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{await bridgeMain(process.argv.slice(2));}catch{process.stderr.write('Runtime compatibility bridge could not connect. Inspect the protected connection and original service.\n');process.exitCode=1;}}
