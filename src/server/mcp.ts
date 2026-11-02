import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { record, ServiceError } from './errors.js';

export const HTTP_PROTOCOLS = ['2025-06-18','2025-11-25'] as const;
export const READ_OPERATIONS = ['runtime.status','runtime.projects.list','runtime.events.read','runtime.receipt.read'] as const;
/** The same scoped dispatcher serves HTTP and MCP; the transport never opens state itself. */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, body: unknown, version: string, dispatch: (value: unknown) => unknown, requestId: string): Promise<void> {
  const server = new Server({ name: 'evopilot-runtime', version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: 'runtime_read', description: 'Read authenticated project lifecycle service state. This operation cannot activate definitions, execute work, or authorize a release.',
    inputSchema: { type: 'object', properties: { operation: { type: 'string', enum: [...READ_OPERATIONS] }, projectId: { type: 'string' }, input: { type: 'object' } }, required: ['operation','projectId','input'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      if (request.params.name !== 'runtime_read') throw new ServiceError('UNKNOWN_TOOL', 'Unsupported Runtime tool', 404);
      const result = dispatch(request.params.arguments);
      return { content: [{ type: 'text', text: JSON.stringify({ requestId, result }) }] };
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
