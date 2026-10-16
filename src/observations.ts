/** Deliberately restricted raw-evidence readers. No XPath, DTD, entities or code execution. */
import { nativeAssertJSON } from '../vendor/compatibility/v1/native.mjs';
import type { NativeJSON } from './native-types.js';
import { fail } from './state.js';

export const OBSERVATION_KINDS = ['json-pointer', 'exit-code', 'junit-total', 'junit-failures', 'junit-errors', 'junit-skipped', 'json-lines-count'] as const;
function utf8(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return fail('INVALID_EVIDENCE', 'Raw evidence must be UTF-8'); }
}
function pointer(value: NativeJSON, path: string): NativeJSON {
  let result = value;
  for (const part of path === '' ? [] : path.slice(1).split('/')) {
    if (/~(?![01])/.test(part)) fail('INVALID_EVIDENCE', 'Invalid JSON pointer');
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!result || typeof result !== 'object' || !Object.hasOwn(result, key)) fail('MISSING_EVIDENCE', 'JSON pointer missing');
    result = (result as Record<string, NativeJSON>)[key];
  }
  return result;
}
interface Counts { total: number; failures: number; errors: number; skipped: number }
interface Element { name: string; attributes: Record<string, string>; counts: Counts; outcome: string | null }
const zero = (): Counts => ({ total: 0, failures: 0, errors: 0, skipped: 0 });
const childTags: Record<string, string[]> = {
  testsuites: ['testsuite'], testsuite: ['testsuite', 'testcase', 'properties', 'system-out', 'system-err'],
  testcase: ['failure', 'error', 'skipped', 'system-out', 'system-err', 'properties'], properties: ['property'],
  property: [], failure: [], error: [], skipped: [], 'system-out': [], 'system-err': [],
};
function checkEntities(text: string): void {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(text)) fail('INVALID_EVIDENCE', 'Unsupported XML entity');
  for (const match of text.matchAll(/&#(x[\da-fA-F]+|\d+);/g)) {
    const value = match[1].startsWith('x') ? parseInt(match[1].slice(1), 16) : Number(match[1]);
    if (!(value === 9 || value === 10 || value === 13 || value >= 32 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff))) fail('INVALID_EVIDENCE', 'Invalid XML character reference');
  }
}
/** Counts actual testcase outcomes, then checks all declared suite totals against those counts. */
function junit(text: string): Counts {
  if (/<!DOCTYPE|<!ENTITY|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/i.test(text)) fail('INVALID_EVIDENCE', 'Unsafe XML declaration/character');
  const stack: Element[] = []; let cursor = 0, tokens = 0, roots = 0, result: Counts | null = null;
  function finish(): void {
    const node = stack.pop()!;
    if (node.name === 'testcase') { node.counts.total = 1; if (node.outcome) node.counts[node.outcome as keyof Counts] = 1; }
    if (node.name === 'testsuite' || node.name === 'testsuites') {
      for (const [attribute, key] of [['tests', 'total'], ['failures', 'failures'], ['errors', 'errors'], ['skipped', 'skipped']] as const) {
        const declared = node.attributes[attribute];
        if (declared !== undefined && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) !== node.counts[key])) fail('INVALID_EVIDENCE', 'JUnit declared totals differ from testcase evidence');
      }
    }
    const parent = stack.at(-1);
    if (parent) for (const key of Object.keys(node.counts) as (keyof Counts)[]) parent.counts[key] += node.counts[key];
    else result = node.counts;
  }
  while (cursor < text.length) {
    if (++tokens > 250000) fail('LIMIT', 'JUnit token bound');
    if (text[cursor] !== '<') {
      const end = text.indexOf('<', cursor), next = end < 0 ? text.length : end, content = text.slice(cursor, next);
      checkEntities(content);
      if ((!stack.length || ['testsuite', 'testsuites', 'testcase', 'properties'].includes(stack.at(-1)!.name)) && content.trim()) fail('INVALID_EVIDENCE', 'Unexpected JUnit text');
      cursor = next; continue;
    }
    if (text.startsWith('<!--', cursor)) {
      const end = text.indexOf('-->', cursor + 4); if (end < 0 || text.slice(cursor + 4, end).includes('--')) fail('INVALID_EVIDENCE', 'Invalid XML comment'); cursor = end + 3; continue;
    }
    if (text.startsWith('<![CDATA[', cursor)) {
      if (!stack.length || !['failure', 'error', 'skipped', 'system-out', 'system-err'].includes(stack.at(-1)!.name)) fail('INVALID_EVIDENCE', 'Unexpected CDATA');
      const end = text.indexOf(']]>', cursor + 9); if (end < 0) fail('INVALID_EVIDENCE', 'Unclosed CDATA'); cursor = end + 3; continue;
    }
    if (text.startsWith('<?', cursor)) {
      const end = text.indexOf('?>', cursor + 2);
      if (end < 0 || roots || text.slice(0, cursor).trim() || !/^<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']UTF-8["'])?(?:\s+standalone=["'](?:yes|no)["'])?\s*\?>$/i.test(text.slice(cursor, end + 2))) fail('INVALID_EVIDENCE', 'Unsupported XML processing instruction');
      cursor = end + 2; continue;
    }
    const match = /^<(\/)?([A-Za-z][A-Za-z0-9-]*)(\s+(?:[^<>"']|"[^"<]*"|'[^'<]*')*?)?\s*(\/?)>/.exec(text.slice(cursor));
    if (!match) fail('INVALID_EVIDENCE', 'Malformed/unsupported JUnit XML');
    const [, closing, name, rawAttributes = '', selfClosing] = match;
    cursor += match[0].length;
    if (closing) { if (rawAttributes.trim() || selfClosing || stack.at(-1)?.name !== name) fail('INVALID_EVIDENCE', 'Mismatched XML close'); finish(); continue; }
    const attributes: Record<string, string> = Object.create(null); let remaining = rawAttributes;
    while (remaining.trim()) {
      const attribute = /^\s+([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(remaining);
      if (!attribute || Object.hasOwn(attributes, attribute[1])) fail('INVALID_EVIDENCE', 'Invalid/duplicate XML attribute');
      const value = attribute[2] ?? attribute[3]; checkEntities(value); attributes[attribute[1]] = value; remaining = remaining.slice(attribute[0].length);
    }
    const parent = stack.at(-1);
    if (!parent) { if (++roots !== 1 || !['testsuite', 'testsuites'].includes(name)) fail('INVALID_EVIDENCE', 'JUnit root required'); }
    else if (!childTags[parent.name]?.includes(name)) fail('INVALID_EVIDENCE', 'Unsupported JUnit structure');
    if (parent?.name === 'testcase' && ['failure', 'error', 'skipped'].includes(name)) {
      if (parent.outcome) fail('INVALID_EVIDENCE', 'Ambiguous testcase outcome'); parent.outcome = name === 'failure' ? 'failures' : name === 'error' ? 'errors' : 'skipped';
    }
    stack.push({ name, attributes, counts: zero(), outcome: null }); if (stack.length > 64) fail('LIMIT', 'JUnit depth bound');
    if (selfClosing) finish();
  }
  if (stack.length || !result || roots !== 1) fail('INVALID_EVIDENCE', 'Incomplete JUnit report');
  return result;
}
export function parseObservation(kind: string, path: string, bytes: Buffer, exitCode: number | null): NativeJSON {
  if (kind === 'exit-code') return exitCode;
  const text = utf8(bytes);
  if (kind === 'json-pointer') { const value: unknown = JSON.parse(text); nativeAssertJSON(value); return pointer(value, path); }
  if (kind === 'json-lines-count') {
    const lines = text.split(/\r?\n/).filter(line => line.trim()); if (lines.length > 100000) fail('LIMIT', 'Structured log line bound');
    for (const line of lines) { const value: unknown = JSON.parse(line); nativeAssertJSON(value); if (!value || Array.isArray(value) || typeof value !== 'object') fail('INVALID_EVIDENCE', 'Structured log records must be JSON objects'); }
    return lines.length;
  }
  const key = ({'junit-total':'total','junit-failures':'failures','junit-errors':'errors','junit-skipped':'skipped'} as const)[kind as 'junit-total'];
  if (key) return junit(text)[key];
  return fail('INVALID_EVIDENCE', 'Unsupported evidence selector');
}
