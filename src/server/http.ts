import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonical, exact, record, reject, ServiceError, slug, string } from './errors.js';
import { authenticate, authorize, assertCredentials, currentPrincipal } from './security.js';
import { RuntimeStore } from './store.js';
import { handleMcp, HTTP_PROTOCOLS, READ_OPERATIONS, WRITE_OPERATIONS } from './mcp.js';
import { createDefinitionService, DEFINITION_READS } from '../lifecycle/service.js';
import type { DefinitionBindingProvider } from '../lifecycle/bindings.js';
import type { AuthorityResolver } from '../lifecycle/instance.js';
import { createAuthorityService, AUTHORITY_READS, AUTHORITY_WRITES, type AuthorityPolicyProvider } from '../adapters/authority.js';

const VERSION = String(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
export interface ServerOptions { stateRoot: string; workspaceId: string; port?: number; }
export async function startRuntimeServer(options: ServerOptions, trustedBindings?:DefinitionBindingProvider, trustedAuthorities?:AuthorityResolver, trustedPolicy?:AuthorityPolicyProvider) {
  const config = record(options); exact(config,['stateRoot','workspaceId'],['port']);
  string(options.stateRoot,4096); slug(options.workspaceId);
  if (options.port !== undefined && (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535)) reject('INVALID_PORT','Invalid loopback port');
  assertCredentials(options.stateRoot,options.workspaceId);
  const store = new RuntimeStore(options.stateRoot, options.workspaceId);
  const authorities=createAuthorityService(store,trustedPolicy,id=>currentPrincipal(options.stateRoot,options.workspaceId,id));
  const definitions=createDefinitionService(store,trustedBindings,trustedAuthorities??authorities.resolveExecution,trustedAuthorities?undefined:authorities.verifyExecution,authorities.resolveRelease);
  const streams = new Set<ServerResponse>();
  let port = 0, closing = false;
  const status = () => ({ product: 'evopilot-runtime', version: VERSION, developmentTarget: '0.9.0', contract: 'runtime-service/v1', workspaceId: options.workspaceId, serviceId: store.serviceId, transport: 'streamable-http', protocols: HTTP_PROTOCOLS, operations: [...READ_OPERATIONS,...WRITE_OPERATIONS], independentLlm: false, productAcceptance: 'NOT_EVALUATED' });
  function principal(req: IncomingMessage) { return authenticate(options.stateRoot,options.workspaceId,req.headers.authorization); }
  async function dispatch(req: IncomingMessage, value: unknown): Promise<unknown> {
    const envelope = record(value); exact(envelope,['operation','projectId','input'],['requestId','expectedRevision']);
    const projectId = slug(envelope.projectId), operation = string(envelope.operation), input = record(envelope.input);
    const actor = principal(req); authorize(actor,projectId,'read');
    if(WRITE_OPERATIONS.includes(operation as typeof WRITE_OPERATIONS[number])){
      exact(envelope,['operation','projectId','input','requestId','expectedRevision']);if(!Number.isSafeInteger(envelope.expectedRevision)||Number(envelope.expectedRevision)<0)reject('INVALID_REVISION','Expected a nonnegative revision');
      const service=AUTHORITY_WRITES.includes(operation as typeof AUTHORITY_WRITES[number])?authorities:definitions;
      return service.write(actor,projectId,operation,input,string(envelope.requestId),Number(envelope.expectedRevision),()=>principal(req));
    }
    exact(envelope,['operation','projectId','input']);
    if(DEFINITION_READS.includes(operation as typeof DEFINITION_READS[number]))return definitions.read(actor,projectId,operation,input);
    if(AUTHORITY_READS.includes(operation as typeof AUTHORITY_READS[number]))return authorities.read(actor,projectId,operation,input);
    switch (operation) {
      case 'runtime.status': exact(input,[]); return { ...status(), projectId, revision: store.revision(projectId) };
      case 'runtime.projects.list': exact(input,[]); return { projects: store.projects(actor) };
      case 'runtime.events.read': exact(input,[],['cursor']); return store.events(actor,projectId,input.cursor === undefined ? undefined : string(input.cursor,1024));
      case 'runtime.receipt.read': exact(input,['requestId']); return store.receipt(actor,projectId,string(input.requestId));
      default: return reject('UNKNOWN_OPERATION','Unsupported Runtime operation',404);
    }
  }
  function json(res: ServerResponse, code: number, value: unknown) {
    const body = canonical(value); res.writeHead(code,{ 'content-type':'application/json; charset=utf-8','cache-control':'no-store' }); res.end(body);
  }
  async function body(req: IncomingMessage): Promise<unknown> {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) return reject('CONTENT_TYPE','JSON content type required',415);
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length;
      if (size > 262144) return reject('INPUT_LIMIT','Request exceeds 256 KiB',413);
      chunks.push(bytes);
    }
    let result: unknown;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject('INVALID_JSON','Malformed JSON'); }
    canonical(result); return result;
  }
  function boundary(req: IncomingMessage): URL {
    const host = req.headers.host;
    if (!['127.0.0.1:'+port,'localhost:'+port].includes(host ?? '')) reject('INVALID_HOST','Loopback Host required',403);
    const counts = new Map<string,number>();
    for (let i=0;i<req.rawHeaders.length;i+=2) { const name=req.rawHeaders[i].toLowerCase(); counts.set(name,(counts.get(name)??0)+1); }
    if (['host','authorization','origin'].some(k => (counts.get(k)??0)>1)) reject('INVALID_HEADERS','Duplicate security header');
    if (req.headers.origin && req.headers.origin !== 'http://'+host) reject('INVALID_ORIGIN','Same-origin access required',403);
    const url = new URL(req.url ?? '/','http://'+host);
    if (url.origin !== 'http://'+host) reject('INVALID_HOST','Absolute request target does not match the listener',403);
    if (url.username || url.password || [...url.searchParams.keys()].some(k => /token|secret|password|key/i.test(k))) reject('SECRET_IN_URL','Credentials must not be placed in URLs');
    if (req.headers['sec-fetch-site'] === 'cross-site') reject('CROSS_SITE','Cross-site access is not allowed',403);
    return url;
  }
  function stream(req: IncomingMessage, res: ServerResponse, projectId: string, initial?: string) {
    if (streams.size >= 32) reject('STREAM_LIMIT','Too many event streams',429);
    let cursor = initial, stopped = false, timer: ReturnType<typeof setInterval> | undefined;
    const first = store.events(principal(req), projectId, cursor); cursor = first.cursor;
    res.writeHead(200,{ 'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive','x-accel-buffering':'no' });
    streams.add(res);
    const stop = () => { if(stopped)return;stopped=true;if(timer)clearInterval(timer);streams.delete(res);res.end(); };
    const send = (event: string, data: unknown) => {
      if (res.writableLength > 262144) { stop(); return; }
      res.write('event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n');
    };
    send('snapshot',first);
    timer = setInterval(() => {
      try {
        const next = store.events(principal(req),projectId,cursor); cursor=next.cursor;
        send(next.events.length ? 'events' : 'heartbeat',next);
      } catch (e) { send('error',{ code: e instanceof ServiceError ? e.code : 'SERVICE_UNAVAILABLE' }); stop(); }
    },1000);
    timer.unref(); req.once('close',stop); res.once('close',stop);
  }
  const server = createServer(async (req,res) => {
    const requestId = randomUUID();
    res.setHeader('x-request-id',requestId); res.setHeader('x-content-type-options','nosniff');
    res.setHeader('content-security-policy',"default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      if(closing)reject('STOPPING','Service is stopping',503);
      const url=boundary(req); principal(req);
      if (url.pathname === '/mcp') {
        const protocol=req.headers['mcp-protocol-version'];
        if (protocol !== undefined && (Array.isArray(protocol) || !HTTP_PROTOCOLS.includes(protocol as typeof HTTP_PROTOCOLS[number]))) reject('UNSUPPORTED_PROTOCOL','Unsupported MCP protocol version');
        if (req.method !== 'POST') { res.setHeader('allow','POST'); json(res,405,{ error:{code:'METHOD_NOT_ALLOWED',message:'This stateless MCP endpoint accepts POST'} }); return; }
        const message=await body(req);
        if (protocol === undefined && (!message || typeof message !== 'object' || Array.isArray(message) || record(message).method !== 'initialize')) reject('UNSUPPORTED_PROTOCOL','MCP protocol header is required after initialization');
        await handleMcp(req,res,message,VERSION,v=>dispatch(req,v),requestId); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/request') { json(res,200,{ requestId,result:await dispatch(req,await body(req)) }); return; }
      if (req.method === 'GET' && url.pathname === '/api/v1/status') { json(res,200,{requestId,result:await dispatch(req,{operation:'runtime.status',projectId:url.searchParams.get('projectId'),input:{}})});return; }
      if (req.method === 'GET' && url.pathname === '/api/v1/events') {
        const projectId=slug(url.searchParams.get('projectId')); stream(req,res,projectId,url.searchParams.get('cursor') ?? undefined);return;
      }
      reject('NOT_FOUND','Endpoint not found',404);
    } catch (e) {
      const error=e instanceof ServiceError?e:new ServiceError('INTERNAL','Request could not be completed',500);
      if(!res.headersSent)json(res,error.status,{requestId,error:{code:error.code,message:error.message}});else res.end();
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=100;
  try { await new Promise<void>((resolve,reject) => {server.once('error',reject);server.listen(options.port ?? 0,'127.0.0.1',() => {server.removeListener('error',reject);resolve();});}); }
  catch(e){store.close();throw e;}
  const address=server.address(); if(!address || typeof address==='string'){store.close();reject('START_FAILED','No loopback listener',500);}
  port=address.port;
  return Object.freeze({ url:'http://127.0.0.1:'+port,port,identity:status(), async close(){
    if(closing)return;closing=true;for(const res of streams)res.end();streams.clear();
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();
  }});
}
