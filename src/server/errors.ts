import { createHash } from 'node:crypto';

export class ServiceError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}
export function reject(code: string, message: string, status = 400): never { throw new ServiceError(code, message, status); }
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return reject('INVALID_INPUT', 'Expected a plain object');
  return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) reject('INVALID_FIELDS', 'Missing or unsupported field');
}
export function string(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f]/.test(value)) return reject('INVALID_INPUT', 'Expected a bounded string');
  return value;
}
export function slug(value: unknown): string {
  const s = string(value, 64);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s)) reject('INVALID_ID', 'Expected a stable lower-case identifier');
  return s;
}
function serialize(value: unknown, maxBytes: number, maxNodes: number): string {
  let nodes = 0;
  function visit(v: unknown, depth: number): unknown {
    if (++nodes > maxNodes || depth > 32) return reject('INPUT_LIMIT', 'JSON structure exceeds the limit', 413);
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map(item => visit(item, depth + 1));
    const obj = record(v), out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(obj).sort()) {
      const d = Object.getOwnPropertyDescriptor(obj, key)!;
      if (!Object.hasOwn(d, 'value') || ['__proto__', 'constructor', 'prototype'].includes(key)) reject('INVALID_INPUT', 'Unsafe object member');
      out[key] = visit(d.value, depth + 1);
    }
    return out;
  }
  const text = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(text) > maxBytes) reject('INPUT_LIMIT', 'JSON exceeds its bounded profile', 413);
  return text;
}
export const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

/** Public requests, definitions and monitor pages retain the 256 KiB profile.
 * Original native receipts and release reviews include bounded original text;
 * their trusted retention/readback uses an 8 MiB profile, never the request parser. */
export const canonical=(value:unknown):string=>serialize(value,262144,20000);
export const EVIDENCE_MAX_BYTES=8388608;
export const canonicalEvidence=(value:unknown):string=>serialize(value,EVIDENCE_MAX_BYTES,200000);
export const evidenceValueDigest=(value:unknown):string=>'sha256:'+createHash('sha256').update(canonicalEvidence(value)).digest('hex');
const EVIDENCE_READS=new Set(['lifecycle.plan.evidence.read','lifecycle.implementation.evidence.read','lifecycle.release.evidence.read','lifecycle.publication.evidence.read','lifecycle.closure.evidence.read','lifecycle.verification.feedback.read','lifecycle.authority.preview','lifecycle.extension.evidence.read','lifecycle.extension.review.preview']);
export const canonicalReadback=(operation:unknown,value:unknown):string=>EVIDENCE_READS.has(String(operation))||operation==='runtime.legacy.read'||operation==='runtime.legacy.write'?canonicalEvidence(value):canonical(value);
