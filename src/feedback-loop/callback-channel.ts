import { createHmac, timingSafeEqual } from 'node:crypto';
import { reject } from '../server/errors.js';

/** Reference adapter authentication for the loopback/test callback harness.
 * Transport supplies the original bytes and an operator-configured key. */
export function authenticateReferenceCallback(
  body: Buffer,
  timestamp: string,
  signature: string,
  key: Buffer,
  now = Date.now(),
): unknown {
  if (body.length > 64 * 1024) reject('INPUT_LIMIT', 'Callback body exceeds its byte limit.', 413);
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
