import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { record, ServiceError, canonicalReadback } from './errors.js';
import { DEFINITION_READS, DEFINITION_WRITES } from '../lifecycle/service.js';
import { AUTHORITY_READS, AUTHORITY_WRITES } from '../adapters/authority.js';
import { EXECUTION_READS, EXECUTION_WRITES } from '../lifecycle/execution.js';
import { PREPARATION_READS, PREPARATION_WRITES } from '../lifecycle/preparation.js';
import { AGENT_READS, AGENT_WRITES } from '../lifecycle/agent.js';
import { IMPLEMENTATION_REVIEW_READS, IMPLEMENTATION_REVIEW_WRITES } from '../lifecycle/implementation-review.js';

export const HTTP_PROTOCOLS = ['2025-06-18','2025-11-25'] as const;
export const READ_OPERATIONS = ['runtime.status','runtime.projects.list','runtime.events.read','runtime.receipt.read',...DEFINITION_READS,...AUTHORITY_READS,...EXECUTION_READS,...PREPARATION_READS,...AGENT_READS,...IMPLEMENTATION_REVIEW_READS] as const;
export const WRITE_OPERATIONS=[...DEFINITION_WRITES,...AUTHORITY_WRITES,...EXECUTION_WRITES,...PREPARATION_WRITES,...AGENT_WRITES,...IMPLEMENTATION_REVIEW_WRITES] as const;
/** The same scoped dispatcher serves HTTP and MCP; the transport never opens state itself. */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, body: unknown, version: string, dispatch: (value: unknown) => unknown|Promise<unknown>, requestId: string): Promise<void> {
  const server = new Server({ name: 'evopilot-runtime', version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: 'runtime_read', description: 'Read authenticated project lifecycle service state. This operation cannot activate definitions, execute work, or authorize a release.',
    inputSchema: { type: 'object', properties: { operation: { type: 'string', enum: [...READ_OPERATIONS] }, projectId: { type: 'string' }, input: { type: 'object' } }, required: ['operation','projectId','input'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },{
    name:'runtime_write',description:'Use exact scoped mutations: save/activate definitions, retain evidence-bound decisions, create authorized instances, explicitly request a governed stage, or inspect its original provider request. Stage requests may dispatch external work only after separate current execution/release authority and fixed gates. Unknown outcomes cannot be blindly retried.',
    inputSchema:{type:'object',properties:{operation:{type:'string',enum:[...WRITE_OPERATIONS]},projectId:{type:'string'},input:{type:'object'},requestId:{type:'string'},expectedRevision:{type:'integer',minimum:0}},required:['operation','projectId','input','requestId','expectedRevision'],additionalProperties:false},
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true},
  }] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const argumentsValue=record(request.params.arguments),operation=argumentsValue.operation;
      if(request.params.name==='runtime_read'&&!READ_OPERATIONS.includes(operation as typeof READ_OPERATIONS[number])||request.params.name==='runtime_write'&&!WRITE_OPERATIONS.includes(operation as typeof WRITE_OPERATIONS[number])||!['runtime_read','runtime_write'].includes(request.params.name))throw new ServiceError('UNKNOWN_TOOL','Tool does not permit this operation',404);
      const result = await dispatch(argumentsValue);
      return { content: [{ type: 'text', text: canonicalReadback(operation,{ requestId, result }) }] };
    } catch (e) {
      const error = e instanceof ServiceError ? e : new ServiceError('INTERNAL', 'Request could not be completed', 500);
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ requestId, error: { code: error.code, message: error.message } }) }] };
    }
  });
  // Constrain negotiation to the Runtime-tested versions, rather than accidentally
  // advertising every legacy protocol the upstream SDK can speak.
  let message = body;
  if (body && typeof body === 'object' && !Array.isArray(body) && record(body).method === 'initialize') {
    const obj = record(body);
    if (obj.params && typeof obj.params === 'object' && !Array.isArray(obj.params)) {
      const params = record(obj.params);
      if (typeof params.protocolVersion === 'string' && !HTTP_PROTOCOLS.includes(params.protocolVersion as typeof HTTP_PROTOCOLS[number])) message = { ...obj, params: { ...params, protocolVersion: HTTP_PROTOCOLS[1] } };
    }
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  res.once('close', () => { void transport.close(); void server.close(); });
  try { await transport.handleRequest(req,res,message); }
  catch (e) { await transport.close(); await server.close(); throw e; }
}
