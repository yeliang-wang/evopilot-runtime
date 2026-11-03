#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {createRuntimeHttpClient,type RuntimeHttpClient} from './client.js';
import {canonicalReadback,record,ServiceError} from '../server/errors.js';
import {READ_OPERATIONS,WRITE_OPERATIONS,runtimeToolDefinitions} from '../server/mcp.js';
import {createLegacyTools} from './legacy-tools.js';
import {openLegacyOwnerRoutes,type LegacyOwnerRoutes} from './legacy-owners.js';
import type {WorkspaceOperatorRoutes} from './workspace.js';
import {GUIDE_TOOL,GUIDE_TOOL_NAME,callGuide} from './guide.js';

interface BridgeBinding {client:RuntimeHttpClient;owners?:LegacyOwnerRoutes;}

/** Optional transport compatibility only. The bridge has no store, executor,
 * service launcher or separate approval state. HTTP is the primary entry. */
export function createStdioBridge(client:RuntimeHttpClient,owners?:LegacyOwnerRoutes,legacyOnly=false,workspace?:WorkspaceOperatorRoutes):Server{
  return createBridge(async()=>({client,owners}),client.connection.version,legacyOnly,owners,workspace);
}
/** Resolve connection/owner state only for service discovery or a service call.
 * MCP initialization and guide calls remain possible with no Workspace at all.
 * A failed binding is retained; reconnect explicitly after configuration repair. */
function createBridge(load:()=>Promise<BridgeBinding|null>,version:string,legacyOnly:boolean,preopenedOwners?:LegacyOwnerRoutes,workspace?:WorkspaceOperatorRoutes):Server{
  let pending:Promise<{client:RuntimeHttpClient;owners?:LegacyOwnerRoutes;legacy:ReturnType<typeof createLegacyTools>}|null>|undefined;
  let openedOwners=preopenedOwners,closed=false,legacySession:ReturnType<typeof createLegacyTools>|undefined;
  const closeOwners=async()=>{const owners=openedOwners;openedOwners=undefined;await owners?.close();};
  const binding=()=>pending??=(async()=>{const selected=await load();if(!selected)return null;openedOwners=selected.owners;if(closed){await closeOwners();throw new ServiceError('CLOSED','Compatibility Host is closed',503);}legacySession=createLegacyTools(selected.client,selected.owners);return{...selected,legacy:legacySession};})();
  const server=new Server({name:'evopilot-runtime-stdio-bridge',version},{capabilities:{tools:{}},instructions:'Compatibility transport to the same independent Runtime service. Prefer the Runtime HTTP plugin. Guides are offline. No state or execution authority is created by this bridge.'});
  server.setRequestHandler(ListToolsRequestSchema,async()=>{
    const base=[GUIDE_TOOL,...(legacyOnly?[]:runtimeToolDefinitions()),...(workspace?.definitions??[])];
    try{const selected=await binding();if(!selected)return{tools:base};const status=await selected.client.status();return{tools:[...base,...(record(status.result).legacy?selected.legacy.definitions:[])]};}
    catch{return{tools:base};}
  });
  server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
    if(request.params.name===GUIDE_TOOL_NAME)return callGuide(request.params.arguments);
    try{
      if(workspace?.has(request.params.name)){
        if(workspace.requiresActiveSession(request.params.name,request.params.arguments)){
          const selected=await binding();if(!selected?.legacy.sessionActive())throw new ServiceError('SESSION_INACTIVE','Activate this compatibility session before local workspace maintenance',409);
          await selected.client.status(extra.signal);
        }
        try{const result=await workspace.call(request.params.name,request.params.arguments,extra.signal);const data={namespace:'evopilot-runtime-workspace',authority:false,result};return{content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};}
        finally{if(workspace.deactivatesSession(request.params.name))legacySession?.deactivate();}
      }
      const selected=await binding();if(!selected)throw new ServiceError('CONNECTION_REQUIRED','Select a verified Runtime connection before service operations',409);
      if(selected.legacy.has(request.params.name))return selected.legacy.call(request.params.name,request.params.arguments,extra.signal);
      const args=record(request.params.arguments),read=request.params.name==='runtime_read',write=request.params.name==='runtime_write';if(legacyOnly||!read&&!write||!(read?READ_OPERATIONS:WRITE_OPERATIONS).includes(args.operation as never))throw new ServiceError('UNKNOWN_TOOL','Tool does not permit this operation',404);const result=await selected.client.request(args,extra.signal);return{content:[{type:'text',text:canonicalReadback(String(args.operation),result)}]};}
    catch(error){const e=error instanceof ServiceError?error:new ServiceError('SERVICE_UNAVAILABLE','The selected Runtime service is unavailable.',503);return{isError:true,content:[{type:'text',text:JSON.stringify({error:{code:e.code,message:e.message}})}]};}
  });server.onclose=()=>{closed=true;void closeOwners().catch(()=>{});};return server;
}
export async function bridgeMain(argv:string[],workspace?:WorkspaceOperatorRoutes):Promise<void>{
  const flags=new Map<string,string>();let legacyOnly=false;
  for(let i=0;i<argv.length;i++){
    const key=argv[i];if(key==='--legacy-only'&&!legacyOnly){legacyOnly=true;continue;}
    if(!['--connection-ref','--owner-config-ref','--owner-config-digest'].includes(key)||flags.has(key)||!argv[i+1]||argv[i+1].startsWith('--'))throw new ServiceError('INVALID_ARGUMENT','Expected a protected connection and optional exact owner configuration');flags.set(key,argv[++i]);
  }
  if(flags.has('--owner-config-ref')&&!flags.has('--connection-ref')||flags.has('--owner-config-digest')&&(!flags.has('--owner-config-ref')||!/^[a-f0-9]{64}$/.test(flags.get('--owner-config-digest')!)))throw new ServiceError('INVALID_ARGUMENT','Expected a connection and matching owner configuration digest');
  const version=String(JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')).version);
  const server=createBridge(async()=>{
    if(!flags.has('--connection-ref'))return null;
    const client=createRuntimeHttpClient(flags.get('--connection-ref')!),owners=flags.has('--owner-config-ref')?await openLegacyOwnerRoutes(flags.get('--owner-config-ref')!,client,flags.get('--owner-config-digest')):undefined;
    return{client,owners};
  },version,legacyOnly||!flags.has('--connection-ref'),undefined,workspace);
  try{await server.connect(new StdioServerTransport());}catch(error){await server.close();throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{await bridgeMain(process.argv.slice(2));}catch(error){const code=error instanceof ServiceError?error.code:'BRIDGE_START_FAILED';process.stderr.write('Runtime compatibility bridge could not connect ('+code+'). Inspect the protected connection and original service.\n');process.exitCode=1;}}
