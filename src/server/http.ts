import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonical, canonicalReadback, exact, record, reject, ServiceError, slug, string } from './errors.js';
import { authenticate, authorize, assertCredentials, currentPrincipal } from './security.js';
import { RuntimeStore,type DashboardEventPage } from './store.js';
import { handleMcp, HTTP_PROTOCOLS, READ_OPERATIONS, WRITE_OPERATIONS } from './mcp.js';
import { createDefinitionService, DEFINITION_READS } from '../lifecycle/service.js';
import type { DefinitionBindingProvider } from '../lifecycle/bindings.js';
import type { AuthorityResolver } from '../lifecycle/instance.js';
import { createAuthorityService, AUTHORITY_READS, AUTHORITY_WRITES, type AuthorityPolicyProvider } from '../adapters/authority.js';
import { createExecutionService, EXECUTION_READS, EXECUTION_WRITES, type StageAdapter, type StageServices } from '../lifecycle/execution.js';
import { createPreparationService, PREPARATION_READS, PREPARATION_WRITES, type PreparationValidator } from '../lifecycle/preparation.js';
import { createAgentService, AGENT_READS, AGENT_WRITES } from '../lifecycle/agent.js';
import { createImplementationReviewService, IMPLEMENTATION_REVIEW_READS, IMPLEMENTATION_REVIEW_WRITES, type ImplementationReviewBindings } from '../lifecycle/implementation-review.js';

import {createExtensionReviewService,EXTENSION_REVIEW_READS,EXTENSION_REVIEW_WRITES,type ExtensionReviewBindings} from '../lifecycle/extension-review.js';
import {createLegacyGateway,readLegacyBinding} from '../compat/gateway.js';
import {LEGACY_READ,LEGACY_WRITE} from '../compat/catalog.js';
import type {Providers as LegacyProviders} from '../service.js';
import type {LegacyProviderFactory} from '../compat/provider-context.js';
import {createBrowserSessions} from './browser-session.js';
import {dashboardEnvelope,monitorEvents,monitorSnapshot} from './dashboard.js';
import {serveDashboard} from './static-ui.js';
import {createUsageService,USAGE_READS,USAGE_WRITES} from '../usage/service.js';
import {createUsageWorker} from '../usage/worker.js';

const VERSION = String(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
export interface ServerOptions { stateRoot: string; workspaceId: string; port?: number; legacyBindingRef?:string; }
export async function startRuntimeServer(options: ServerOptions, trustedBindings?:DefinitionBindingProvider, trustedAuthorities?:AuthorityResolver, trustedPolicy?:AuthorityPolicyProvider, trustedExecutor?:StageAdapter|((store:RuntimeStore,services:StageServices)=>StageAdapter), trustedPreparation?:PreparationValidator, trustedImplementationReview?:ImplementationReviewBindings, trustedExtensionReview?:((store:RuntimeStore)=>ExtensionReviewBindings), trustedLegacyProviders?:LegacyProviders|LegacyProviderFactory) {
  const config = record(options); exact(config,['stateRoot','workspaceId'],['port','legacyBindingRef']);
  string(options.stateRoot,4096); slug(options.workspaceId);
  if(options.legacyBindingRef!==undefined)string(options.legacyBindingRef,4096);
  if (options.port !== undefined && (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535)) reject('INVALID_PORT','Invalid loopback port');
  assertCredentials(options.stateRoot,options.workspaceId);
  const store = new RuntimeStore(options.stateRoot, options.workspaceId);
  const preparations=createPreparationService(store,trustedPreparation);
  const authorities=createAuthorityService(store,trustedPolicy,id=>currentPrincipal(options.stateRoot,options.workspaceId,id),preparations.verify);
  const definitions=createDefinitionService(store,trustedBindings,trustedAuthorities??authorities.resolveExecution,trustedAuthorities?undefined:authorities.verifyExecution,authorities.resolveRelease);
  const extensionReviews=createExtensionReviewService(store,trustedExtensionReview?.(store),id=>currentPrincipal(options.stateRoot,options.workspaceId,id));
  let execution:ReturnType<typeof createExecutionService>;
  try{execution=createExecutionService(store,{bindings:trustedBindings,authorities:trustedAuthorities??authorities.resolveExecution,verifyAuthority:trustedAuthorities?undefined:authorities.verifyExecution,releaseAuthority:authorities.resolveRelease,principal:id=>currentPrincipal(options.stateRoot,options.workspaceId,id),verifyProjectReviews:extensionReviews.verifyPassed,verifyProjectReviewState:extensionReviews.verifyCurrentDecisions,adapter:typeof trustedExecutor==='function'?trustedExecutor(store,{releaseAuthority:authorities.resolveRelease,authorityPolicy:trustedPolicy,extensionReviews}):trustedExecutor});}
  catch(e){store.close();throw e;}
  const agents=createAgentService(store,(actor,projectId,id)=>execution.authorizeOriginal(actor,projectId,id));
  const implementationReviews=createImplementationReviewService(store,trustedImplementationReview,id=>currentPrincipal(options.stateRoot,options.workspaceId,id));
  let legacy:ReturnType<typeof createLegacyGateway>|undefined;
  try{if(options.legacyBindingRef)legacy=createLegacyGateway(store,readLegacyBinding(options.legacyBindingRef),trustedLegacyProviders);}
  catch(error){await execution.close();store.close();throw error;}
  const streams = new Set<ServerResponse>();
  const browserSessions=createBrowserSessions(id=>currentPrincipal(options.stateRoot,options.workspaceId,id));
  const usage=createUsageService(store),usageWorker=createUsageWorker(store,id=>currentPrincipal(options.stateRoot,options.workspaceId,id));
  let port = 0, closing = false;
  const status = () => ({ product: 'evopilot-runtime', version: VERSION, developmentTarget: '0.9.0', contract: 'runtime-service/v1', workspaceId: options.workspaceId, serviceId: store.serviceId, transport: 'streamable-http', protocols: HTTP_PROTOCOLS, operations: [...READ_OPERATIONS,...WRITE_OPERATIONS], legacy:legacy?{bound:true,migrationDigest:legacy.inspect().migrationDigest,revisionNamespace:'original-family'}:null, independentLlm: false, productAcceptance: 'NOT_EVALUATED' });
  function principal(req: IncomingMessage) { return authenticate(options.stateRoot,options.workspaceId,req.headers.authorization); }
  async function dispatch(req: IncomingMessage, value: unknown,reauthenticate=()=>principal(req)): Promise<unknown> {
    const envelope = record(value); exact(envelope,['operation','projectId','input'],['requestId','expectedRevision']);
    const projectId = slug(envelope.projectId), operation = string(envelope.operation), input = record(envelope.input);
    const actor = reauthenticate(); authorize(actor,projectId,'read');
    if(operation===LEGACY_READ||operation===LEGACY_WRITE){
      if(!legacy)reject('LEGACY_NOT_BOUND','No verified legacy migration is bound to this service',409);
      if(operation===LEGACY_READ){exact(envelope,['operation','projectId','input']);return legacy.read(actor,projectId,input,reauthenticate);}
      exact(envelope,['operation','projectId','input','requestId','expectedRevision']);
      if(!Number.isSafeInteger(envelope.expectedRevision)||Number(envelope.expectedRevision)<0)reject('INVALID_REVISION','Use the original legacy family revision');
      return legacy.write(actor,projectId,input,string(envelope.requestId),Number(envelope.expectedRevision),reauthenticate);
    }
    if(WRITE_OPERATIONS.includes(operation as typeof WRITE_OPERATIONS[number])){
      exact(envelope,['operation','projectId','input','requestId','expectedRevision']);if(!Number.isSafeInteger(envelope.expectedRevision)||Number(envelope.expectedRevision)<0)reject('INVALID_REVISION','Expected a nonnegative revision');
      if(USAGE_WRITES.includes(operation as typeof USAGE_WRITES[number]))return usage.write(actor,projectId,operation,input,string(envelope.requestId),Number(envelope.expectedRevision),reauthenticate);
      const service=EXTENSION_REVIEW_WRITES.includes(operation as typeof EXTENSION_REVIEW_WRITES[number])?extensionReviews:IMPLEMENTATION_REVIEW_WRITES.includes(operation as typeof IMPLEMENTATION_REVIEW_WRITES[number])?implementationReviews:AGENT_WRITES.includes(operation as typeof AGENT_WRITES[number])?agents:PREPARATION_WRITES.includes(operation as typeof PREPARATION_WRITES[number])?preparations:AUTHORITY_WRITES.includes(operation as typeof AUTHORITY_WRITES[number])?authorities:EXECUTION_WRITES.includes(operation as typeof EXECUTION_WRITES[number])?execution:definitions;
      return service.write(actor,projectId,operation,input,string(envelope.requestId),Number(envelope.expectedRevision),reauthenticate);
    }
    exact(envelope,['operation','projectId','input']);
    if(USAGE_READS.includes(operation as typeof USAGE_READS[number]))return usage.read(actor,projectId,operation,input);
    if(DEFINITION_READS.includes(operation as typeof DEFINITION_READS[number]))return definitions.read(actor,projectId,operation,input);
    if(AUTHORITY_READS.includes(operation as typeof AUTHORITY_READS[number]))return authorities.read(actor,projectId,operation,input);
    if(EXECUTION_READS.includes(operation as typeof EXECUTION_READS[number]))return execution.read(actor,projectId,operation,input);
    if(PREPARATION_READS.includes(operation as typeof PREPARATION_READS[number]))return preparations.read(actor,projectId,operation,input);
    if(AGENT_READS.includes(operation as typeof AGENT_READS[number]))return agents.read(actor,projectId,operation,input);
    if(EXTENSION_REVIEW_READS.includes(operation as typeof EXTENSION_REVIEW_READS[number]))return extensionReviews.read(actor,projectId,operation,input);
    if(IMPLEMENTATION_REVIEW_READS.includes(operation as typeof IMPLEMENTATION_REVIEW_READS[number]))return implementationReviews.read(actor,projectId,operation,input);
    switch (operation) {
      case 'runtime.status': exact(input,[]); return { ...status(), projectId, revision: store.revision(projectId),observationWorker:execution.health(projectId),usageWorker:usageWorker.health(projectId) };
      case 'runtime.projects.list': exact(input,[],['cursor','limit']); return store.projects(actor,input.cursor===undefined?undefined:string(input.cursor,2048),input.limit===undefined?50:input.limit as number);
      case 'runtime.events.read': exact(input,[],['cursor']); return store.events(actor,projectId,input.cursor === undefined ? undefined : string(input.cursor,1024));
      case 'runtime.receipt.read': exact(input,['requestId']); return store.receipt(actor,projectId,string(input.requestId));
      default: return reject('UNKNOWN_OPERATION','Unsupported Runtime operation',404);
    }
  }
  function json(res: ServerResponse, code: number, value: unknown, operation?:unknown) {
    const body = canonicalReadback(operation,value); res.writeHead(code,{ 'content-type':'application/json; charset=utf-8','cache-control':'no-store' }); res.end(body);
  }
  async function body(req: IncomingMessage): Promise<unknown> {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) return reject('CONTENT_TYPE','JSON content type required',415);
    let size = 0; const chunks: Buffer[] = [];
    // Keep the response socket alive long enough to deliver a bounded rejection.
    // The default async iterator destroys IncomingMessage when the loop throws.
    for await (const chunk of req.iterator({destroyOnReturn:false})) {
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
    if (['host','authorization','origin','cookie','x-runtime-csrf'].some(k => (counts.get(k)??0)>1)) reject('INVALID_HEADERS','Duplicate security header');
    if (req.headers.origin && req.headers.origin !== 'http://'+host) reject('INVALID_ORIGIN','Same-origin access required',403);
    const url = new URL(req.url ?? '/','http://'+host);
    if (url.origin !== 'http://'+host) reject('INVALID_HOST','Absolute request target does not match the listener',403);
    if (url.username || url.password || [...url.searchParams.keys()].some(k => /token|secret|password|key/i.test(k))) reject('SECRET_IN_URL','Credentials must not be placed in URLs');
    if (req.headers['sec-fetch-site'] === 'cross-site') reject('CROSS_SITE','Cross-site access is not allowed',403);
    return url;
  }
  function stream(req: IncomingMessage, res: ServerResponse, projectId: string, initial?: string,reauthenticate=()=>principal(req),monitor=false) {
    if (streams.size >= 32) reject('STREAM_LIMIT','Too many event streams',429);
    let cursor = initial, stopped = false, timer: ReturnType<typeof setInterval> | undefined;
    const readPage=()=>monitor?store.dashboardEvents(reauthenticate(),projectId,cursor):store.events(reauthenticate(),projectId,cursor);
    let first:ReturnType<RuntimeStore['events']>|DashboardEventPage|null=null,invalidCursor=false;
    try{first=readPage();cursor=first.cursor;}
    catch(error){
      // EventSource cannot inspect a non-2xx response body. Only after current
      // Dashboard authentication succeeded, surface this rejected cursor as an
      // explicit error frame so the client can reconnect at the current tip.
      // Scope/credential failures and the generic Agent stream keep HTTP errors.
      if(!monitor||!(error instanceof ServiceError)||error.code!=='INVALID_CURSOR')throw error;
      invalidCursor=true;
    }
    res.writeHead(200,{ 'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive','x-accel-buffering':'no' });
    streams.add(res);
    const stop = () => { if(stopped)return;stopped=true;if(timer)clearInterval(timer);streams.delete(res);res.end(); };
    const send = (event: string, data: unknown) => {
      if (res.writableLength > 262144) { stop(); return; }
      const output=monitor&&['snapshot','events','heartbeat','reset'].includes(event)?monitorEvents(data as DashboardEventPage):data;
      res.write('event: '+event+'\ndata: '+JSON.stringify(output)+'\n\n');
    };
    if(invalidCursor){send('error',{code:'INVALID_CURSOR'});stop();return;}
    if(!first){stop();return;}
    send(monitor&&'gap' in first&&first.gap?'reset':'snapshot',first);
    timer = setInterval(() => {
      try {
        const next=readPage();cursor=next.cursor;
        send(monitor&&'gap' in next&&next.gap?'reset':next.events.length?'events':'heartbeat',next);
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
      const url=boundary(req);
      if(serveDashboard(url.pathname,req.method,res))return;
      if(url.pathname==='/api/v1/dashboard-code'&&req.method==='POST'){
        const actor=principal(req),input=record(await body(req));exact(input,['projectId']);
        const authorization=req.headers.authorization;
        json(res,200,{requestId,result:browserSessions.issue(actor,slug(input.projectId),url.origin,()=>authenticate(options.stateRoot,options.workspaceId,authorization))});return;
      }
      if(url.pathname.startsWith('/api/v1/dashboard/')){
        const origin=url.origin;
        if(req.method==='POST'&&req.headers.origin!==origin)reject('CSRF','Dashboard POST requires its exact browser Origin',403);
        if(url.pathname==='/api/v1/dashboard/session'&&req.method==='POST'){
          const input=record(await body(req));exact(input,['code']);const result=browserSessions.exchange(input.code,origin),{cookie,...view}=result;
          res.setHeader('set-cookie',cookie);json(res,200,{requestId,result:view});return;
        }
        const authenticated=()=>browserSessions.authenticate(req.headers.cookie,origin);
        const session=authenticated();
        if(url.pathname==='/api/v1/dashboard/session'&&req.method==='GET'){
          json(res,200,{requestId,result:{projectId:session.projectId,principalId:session.actor.id,permissions:session.actor.permissions.filter(p=>['read','draft.write','definition.activate'].includes(p)),csrf:session.csrf,expiresAt:session.expiresAt,serviceId:store.serviceId,workspaceId:store.workspaceId}});return;
        }
        if(req.method==='POST')browserSessions.authenticate(req.headers.cookie,origin,session.projectId,string(req.headers['x-runtime-csrf'],128));
        if(url.pathname==='/api/v1/dashboard/logout'&&req.method==='POST'){
          exact(record(await body(req)),[]);res.setHeader('set-cookie',browserSessions.close(req.headers.cookie,origin,string(req.headers['x-runtime-csrf'],128)));json(res,200,{requestId,result:{disconnected:true}});return;
        }
        if(url.pathname==='/api/v1/dashboard/request'&&req.method==='POST'){
          const envelope=dashboardEnvelope(await body(req),session.projectId),result=await dispatch(req,envelope,()=>authenticated().actor);
          authenticated();json(res,200,{requestId,result},envelope.operation);return;
        }
        if(url.pathname==='/api/v1/dashboard/monitor'&&req.method==='GET'){
          const input=Object.fromEntries(url.searchParams);exact(input,[],['after','revision']);
          const result=monitorSnapshot(store,session.actor,session.projectId,{...(input.after?{after:input.after}:{}),...(input.revision!==undefined?{revision:Number(input.revision)}:{})});
          json(res,200,{requestId,result});return;
        }
        if(url.pathname==='/api/v1/dashboard/events'&&req.method==='GET'){
          exact(Object.fromEntries(url.searchParams),[],['cursor']);stream(req,res,session.projectId,url.searchParams.get('cursor')??undefined,()=>authenticated().actor,true);return;
        }
        reject('NOT_FOUND','Dashboard endpoint not found',404);
      }
      principal(req);
      if (url.pathname === '/mcp') {
        const protocol=req.headers['mcp-protocol-version'];
        if (protocol !== undefined && (Array.isArray(protocol) || !HTTP_PROTOCOLS.includes(protocol as typeof HTTP_PROTOCOLS[number]))) reject('UNSUPPORTED_PROTOCOL','Unsupported MCP protocol version');
        if (req.method !== 'POST') { res.setHeader('allow','POST'); json(res,405,{ error:{code:'METHOD_NOT_ALLOWED',message:'This stateless MCP endpoint accepts POST'} }); return; }
        const message=await body(req);
        if (protocol === undefined && (!message || typeof message !== 'object' || Array.isArray(message) || record(message).method !== 'initialize')) reject('UNSUPPORTED_PROTOCOL','MCP protocol header is required after initialization');
        await handleMcp(req,res,message,VERSION,v=>dispatch(req,v),requestId); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/request') { const input=await body(req); const result=await dispatch(req,input); json(res,200,{requestId,result},record(input).operation); return; }
      if (req.method === 'GET' && url.pathname === '/api/v1/status') { json(res,200,{requestId,result:await dispatch(req,{operation:'runtime.status',projectId:url.searchParams.get('projectId'),input:{}})});return; }
      if (req.method === 'GET' && url.pathname === '/api/v1/events') {
        const projectId=slug(url.searchParams.get('projectId')); stream(req,res,projectId,url.searchParams.get('cursor') ?? undefined);return;
      }
      reject('NOT_FOUND','Endpoint not found',404);
    } catch (e) {
      const error=e instanceof ServiceError?e:new ServiceError('INTERNAL','Request could not be completed',500);
      // Preserve the negotiated connection while returning 413 before EOF.
      // Forcing close here can reset a client still uploading before it reads
      // the rejection. Discard remaining bytes without buffering; the existing
      // request timeout still bounds an unfinished upload.
      if(error.status===413)req.resume();
      if(!res.headersSent)json(res,error.status,{requestId,error:{code:error.code,message:error.message}});else res.end();
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=100;
  try { await new Promise<void>((resolve,reject) => {server.once('error',reject);server.listen(options.port ?? 0,'127.0.0.1',() => {server.removeListener('error',reject);resolve();});}); }
  catch(e){usageWorker.close();await legacy?.close();await execution.close();store.close();throw e;}
  const address=server.address(); if(!address || typeof address==='string'){usageWorker.close();await legacy?.close();await execution.close();store.close();reject('START_FAILED','No loopback listener',500);}
  port=address.port;
  const legacyIntentSource=legacy?.intentSource(actor=>{const current=currentPrincipal(options.stateRoot,options.workspaceId,actor.id);if(!current)reject('UNAUTHENTICATED','Original principal is no longer available',401);return current;});
  return Object.freeze({ url:'http://127.0.0.1:'+port,port,identity:status(),legacyIntentSource, async close(){
    if(closing)return;closing=true;usageWorker.close();browserSessions.clear();for(const res of streams)res.end();streams.clear();
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await legacy?.close();await execution.close();store.close();
  }});
}
