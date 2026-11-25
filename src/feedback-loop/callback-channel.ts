import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { digest, record, reject, ServiceError } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import type { RuntimeStore } from '../server/store.js';
import {
  readChannelScope, readFeedbackDeliveryIntent, readFeedbackDeliveryReceipt,
  type ChannelScope, type FeedbackDeliveryIntent, type FeedbackDeliveryResult,
} from './channel.js';
import { retainFeedbackChannelEvent } from './ingress.js';
import { retainFeedbackVeto } from './service.js';

const maxCallbackBytes = 64 * 1024;

/** Reference adapter authentication for the loopback/test callback harness.
 * Transport supplies the original bytes and an operator-configured key. */
export function authenticateReferenceCallback(
  body: Buffer,
  timestamp: string,
  signature: string,
  key: Buffer,
  now = Date.now(),
): unknown {
  if (body.length > maxCallbackBytes) reject('INPUT_LIMIT', 'Callback body exceeds its byte limit.', 413);
  if (key.length < 32) reject('CALLBACK_CONFIG', 'Reference callback requires a configured key.', 503);
  if (!/^[1-9][0-9]{12}$/.test(timestamp) || !Number.isSafeInteger(now) || Math.abs(now - Number(timestamp)) > 300_000) {
    return reject('CALLBACK_UNAUTHENTICATED', 'Callback timestamp is invalid or stale.', 401);
  }
  if (!/^sha256=[a-f0-9]{64}$/.test(signature)) {
    return reject('CALLBACK_UNAUTHENTICATED', 'Callback signature is invalid.', 401);
  }
  const expected = createHmac('sha256', key).update(timestamp + '.').update(body).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) {
    return reject('CALLBACK_UNAUTHENTICATED', 'Callback signature is invalid.', 401);
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(body)) as unknown;
  } catch {
    return reject('INVALID_JSON', 'Callback body must be UTF-8 JSON.');
  }
}

interface ReferenceChannelOptions {
  port?: number;
  feedback: {
    key: Buffer;
    route: Parameters<typeof retainFeedbackChannelEvent>[1];
  };
  review: {
    key: Buffer;
    route: Parameters<typeof retainFeedbackVeto>[2];
  };
  store: Parameters<typeof retainFeedbackChannelEvent>[0];
  receiverPrincipal: () => Parameters<typeof retainFeedbackChannelEvent>[2];
}

function singleHeader(request: IncomingMessage, name: string) {
  const values = request.headersDistinct[name];
  if (values?.length !== 1) reject('CALLBACK_HEADERS', 'Exactly one callback authentication header is required.', 401);
  return values[0];
}

async function callbackBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({destroyOnReturn:false})) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxCallbackBytes) reject('INPUT_LIMIT','Callback body exceeds its byte limit.',413);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/** Operator composition for the isolated reference adapter. The Runtime MCP
 * listener stays separate; no feedback mutation is callable as an MCP write. */
export async function startReferenceChannel(options: ReferenceChannelOptions) {
  const {feedback, review, store} = options;
  if (feedback.route.scope.provider !== 'callback' || review.route.channel.provider !== 'callback' ||
      feedback.route.workspaceId !== store.workspaceId || review.route.workspaceId !== store.workspaceId ||
      feedback.key.length < 32 || review.key.length < 32) {
    reject('CALLBACK_CONFIG', 'Registered reference channel scope and key are required.',503);
  }
  if (timingSafeEqualKey(options.feedback.key, options.review.key)) {
    reject('CALLBACK_CONFIG', 'Feedback intake and review callbacks require separate keys.',503);
  }
  // Copy operator keys so subsequent writes to the caller buffer do not change
  // the identity accepted by an already started listener.
  const keys = {feedback:Buffer.from(options.feedback.key),review:Buffer.from(options.review.key)};
  let port = 0;
  const server = createServer({requestTimeout:15000,headersTimeout:10000}, async (request,response) => {
    const reply = (status: number, payload: unknown) => {
      response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
      response.end(JSON.stringify(payload));
    };
    try {
      if (request.headers.host !== '127.0.0.1:'+port || request.headers.origin !== undefined) {
        reject('CALLBACK_SCOPE', 'Reference callback must originate through its exact loopback listener.',403);
      }
      if (request.method !== 'POST' || !['/feedback','/review'].includes(request.url ?? '')) {
        reject('CALLBACK_ROUTE', 'Unknown callback route.',404);
      }
      if (request.headers['content-type'] !== 'application/json' || request.headers['content-encoding'] !== undefined) {
        reject('CONTENT_TYPE', 'Uncompressed application/json is required.',415);
      }
      const action = request.url === '/feedback' ? 'feedback' : 'review';
      const timestamp = singleHeader(request,'x-runtime-callback-timestamp');
      const signature = singleHeader(request,'x-runtime-callback-signature');
      const body = await callbackBody(request);
      const input = authenticateReferenceCallback(body,timestamp,signature,keys[action]);
      const principal = options.receiverPrincipal();
      if (action === 'feedback') {
        const result = retainFeedbackChannelEvent(options.store,options.feedback.route,principal,input);
        return reply(result.status === 'RETAINED' ? 201 : 200,result);
      }
      const window = retainFeedbackVeto(options.store,principal,options.review.route,input);
      return reply(200,{status:'VETO_RETAINED',windowId:window.id});
    } catch (error) {
      const failure = error instanceof ServiceError ? error : new ServiceError('CALLBACK_UNAVAILABLE','Callback could not be retained.',503);
      reply(failure.status,{error:failure.code});
    }
  });
  const listen = once(server,'listening');
  server.listen(options.port ?? 0,'127.0.0.1');
  await listen;
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    return reject('CALLBACK_UNAVAILABLE', 'Loopback listener has no TCP address.',503);
  }
  port = address.port;
  return {
    url:'http://127.0.0.1:'+port,
    close:() => new Promise<void>((resolve,rejectClose) => server.close(error => {
      keys.feedback.fill(0);
      keys.review.fill(0);
      if (error) rejectClose(error);
      else resolve();
    })),
  };
}

function timingSafeEqualKey(a: Buffer,b: Buffer) {
  return a.length === b.length && timingSafeEqual(a,b);
}

function signedHeaders(body: Buffer,key: Buffer) {
  const timestamp = String(Date.now());
  return {
    'content-type':'application/json',
    'x-runtime-callback-timestamp':timestamp,
    'x-runtime-callback-signature':'sha256='+createHmac('sha256',key).update(timestamp+'.').update(body).digest('hex'),
  };
}

function deliveryKey(key: Buffer,direction: 'request' | 'response',path: string) {
  return createHmac('sha256',key).update('runtime-reference-delivery/v1:'+direction+':'+path).digest();
}

/** Deliveries cross a separate authenticated loopback peer. A lost delivery
 * response is resolved by inspecting the retained original request. */
export function createReferenceDeliveryAdapter(endpoint: string, scope: ChannelScope, key: Buffer,fetcher: typeof fetch = fetch) {
  const url = new URL(endpoint);
  const selected = readChannelScope(scope);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.pathname !== '/' || url.search || url.hash || url.username || url.password ||
      selected.provider !== 'callback' || key.length < 32) {
    reject('CALLBACK_CONFIG','An exact loopback reference delivery endpoint and authentication key are required.',503);
  }
  const signingKey = Buffer.from(key);
  async function send(path: '/deliver' | '/inspect',retained: FeedbackDeliveryIntent): Promise<FeedbackDeliveryResult> {
    const intent = readFeedbackDeliveryIntent(retained,selected);
    const unknown = {status:'UNKNOWN' as const,requestId:intent.requestId,intentDigest:intent.intentDigest};
    try {
      const body = Buffer.from(JSON.stringify(intent));
      const response = await fetcher(new URL(path,url),{
        method:'POST',body,headers:signedHeaders(body,deliveryKey(signingKey,'request',path)),
        redirect:'error',signal:AbortSignal.timeout(5000),
      });
      if (!response.ok || !response.body) {
        void response.body?.cancel().catch(() => {});
        return unknown;
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maxCallbackBytes) {
            await reader.cancel().catch(() => {});
            return unknown;
          }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const payload = authenticateReferenceCallback(Buffer.concat(chunks,size),
        response.headers.get('x-runtime-callback-timestamp') ?? '',
        response.headers.get('x-runtime-callback-signature') ?? '',deliveryKey(signingKey,'response',path));
      const {receipt} = record(payload);
      return {status:'DELIVERED',receipt:readFeedbackDeliveryReceipt(receipt,intent,'REFERENCE_CALLBACK')};
    } catch {
      return unknown;
    }
  }
  return {
    source:'REFERENCE_CALLBACK' as const,
    dispatch(intent: FeedbackDeliveryIntent,reservation: 'RESERVED') {
      if (reservation !== 'RESERVED') return reject('FEEDBACK_DELIVERY_RECONCILE','Inspect the original delivery.',409);
      return send('/deliver',intent);
    },
    reconcile:(intent: FeedbackDeliveryIntent) => send('/inspect',intent),
    close:() => signingKey.fill(0),
  };
}

/** Dedicated fixture/representative delivery peer with its own durable
 * receipt ledger. The application ingress listeners never grant it access. */
export async function startReferenceDeliveryInbox(options: {
  store:RuntimeStore;projectId:string;scope:ChannelScope;key:Buffer;principal:()=>Principal;port?:number;
}) {
  const {store,projectId,principal} = options;
  const scope = readChannelScope(options.scope);
  if (scope.provider !== 'callback' || options.key.length < 32) {
    reject('CALLBACK_CONFIG','A registered reference delivery scope and authentication key are required.',503);
  }
  const key = Buffer.from(options.key);
  let port = 0;
  const server = createServer({requestTimeout:15000,headersTimeout:10000}, async (req,res) => {
    const reply = (status: number,payload: unknown) => {
      const bytes = Buffer.from(JSON.stringify(payload));
      res.writeHead(status,{...signedHeaders(bytes,deliveryKey(key,'response',req.url ?? '')),'cache-control':'no-store'});
      res.end(bytes);
    };
    try {
      if (req.headers.host !== '127.0.0.1:'+port || req.headers.origin !== undefined ||
          req.method !== 'POST' || !['/deliver','/inspect'].includes(req.url ?? '')) {
        return reject('CALLBACK_ROUTE','Unknown reference delivery route.',404);
      }
      if (req.headers['content-type'] !== 'application/json' || req.headers['content-encoding'] !== undefined) {
        return reject('CONTENT_TYPE','Uncompressed application/json is required.',415);
      }
      const timestamp = singleHeader(req,'x-runtime-callback-timestamp');
      const signature = singleHeader(req,'x-runtime-callback-signature');
      const requestKey = deliveryKey(key,'request',req.url!);
      const intent = readFeedbackDeliveryIntent(authenticateReferenceCallback(await callbackBody(req),timestamp,signature,requestKey),scope);
      const actor = principal();
      authorize(actor,projectId,req.url==='/inspect'?'read':'execution.request');
      const id = digest({scope,requestId:intent.requestId});
      const retained = store.object(projectId,'feedback-reference-delivery',id);
      if (retained) return reply(200,{receipt:readFeedbackDeliveryReceipt(retained,intent,'REFERENCE_CALLBACK')});
      if (req.url === '/inspect') return reply(404,{error:'DELIVERY_UNKNOWN'});
      const receipt = {
        intentDigest:intent.intentDigest,requestId:intent.requestId,messageId:'callback-message:'+id,
        deliveredAt:Date.now(),source:'REFERENCE_CALLBACK',
      };
      store.mutate(actor,{
        projectId,operation:'feedback.reference.deliver',requestId:'callback-delivery:'+id,
        expectedRevision:store.revision(projectId),permission:'execution.request',input:{intentDigest:intent.intentDigest},
      },() => ({
        value:receipt,
        objects:[
          {kind:'feedback-reference-delivery',id,value:receipt},
          {kind:'feedback-reference-message',id,value:intent},
        ],
        event:{type:'feedback-reference-delivered',data:{messageId:receipt.messageId}},
      }));
      return reply(201,{receipt});
    } catch (error) {
      const status = error instanceof ServiceError ? error.status : 503;
      reply(status,{error:error instanceof ServiceError ? error.code : 'CALLBACK_UNAVAILABLE'});
    }
  });
  const listening = once(server,'listening');
  server.listen(options.port ?? 0,'127.0.0.1');
  await listening;
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    return reject('CALLBACK_UNAVAILABLE','Loopback delivery peer has no TCP address.',503);
  }
  port = address.port;
  return {
    url:'http://127.0.0.1:'+port,
    close:() => new Promise<void>((resolve,rejectClose) => server.close(error => {
      key.fill(0);
      if (error) rejectClose(error);
      else resolve();
    })),
  };
}
