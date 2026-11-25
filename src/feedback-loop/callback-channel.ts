import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { reject, ServiceError } from '../server/errors.js';
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
