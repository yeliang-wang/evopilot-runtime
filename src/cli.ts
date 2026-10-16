#!/usr/bin/env node
import { constants, realpathSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT, VERSION } from './index.js';
import { createRuntimeService } from './service.js';
import { operations, validateRequest } from './operations.js';
import { errorCode, bounded, fail, LIMITS, slug } from './state.js';
import { exactFields, textField, validateReference } from '../vendor/compatibility/v1/reference.mjs';

import type { Request, Composition, ExternalRequest } from './types.js';
import type { NativeRequest } from './native-types.js';
import { NATIVE_RUNTIME_OPERATIONS, NATIVE_RUNTIME_LIMITS } from './native.js';
import { nativeAssertJSON, nativeExact } from '../vendor/compatibility/v1/native.mjs';
type InputStream = AsyncIterable<string | Uint8Array>;
const serviceCodes = new Set(('CLOSED NOT_INITIALIZED REQUEST_CONFLICT CORRUPT_STATE REVISION_CONFLICT NOT_FOUND LIMIT INVALID_ENCODING INVALID_REQUEST INVALID_INPUT INVALID_OPERATION INVALID_SCOPE EXISTS MISSING_RESOLVER ASYNC_RESOLVER MATERIAL_SCOPE INVALID_MATERIAL MISSING_EXECUTOR APPROVAL_REQUIRED PIN_DRIFT REVIEW_MISMATCH TERMINAL DECISION_CONFLICT NO_CLAIM CLAIM_MISMATCH UNSAFE_WORKSPACE UNSUPPORTED_PLATFORM UNKNOWN_WORKSPACE IDENTITY_MISMATCH STATE_ERROR').split(' '));
for(const code of ['HISTORICAL_READ_ONLY','STANDARD_MISMATCH','REQUIREMENTS_MISMATCH','MISSING_REQUIREMENTS_READER','MISSING_SOURCE_READER','MISSING_COLLECTOR','MISSING_RECEIPT_READER','MISSING_EVIDENCE','EVIDENCE_DRIFT','REVIEW_REQUIRED','INCOMPLETE','CONTRACT_MISMATCH','INVALID_RECEIPT','INVALID_PROVIDER_RECEIPT'])serviceCodes.add(code);
const asyncOperations = ['run.dispatch', 'run.reconcile'];
const help = {
  usage: ['evopilot-next-runtime capabilities', 'evopilot-next-runtime help', 'evopilot-next-runtime version', 'evopilot-next-runtime request --workspace <canonicalAbsoluteRoot> --workspace-id <slug> [--request-file <absoluteJSONpath>]', 'evopilot-next-runtime native-request --workspace <canonicalAbsoluteRoot> --workspace-id <slug> [--request-file <absoluteJSONpath>]'],
  input: 'One bounded JSON request from stdin or the exact explicit regular file.',
  exitCodes: { success: 0, serviceFailure: 1, invalidInput: 2 },
};
// CLI-only preflight; public service validation and scope rules remain unchanged.
function validateCLIRequest(request: Request) {
  bounded(request);
  if (!request || ![...operations, ...asyncOperations].includes(request.operation)) fail('INVALID_OPERATION', 'Unsupported operation');
  validateRequest(request);
  const { operation: op, input: i, scope } = request;
  const shapes = {
    'workspace.inspect': [], 'receipt.inspect': ['requestId'],
    'project.create': ['name'], 'project.inspect': [], 'project.list': [],
    'goal.create': ['id','description'], 'goal.inspect': ['id'], 'goal.list': [],
    'run.prepare': ['id','goalId','ontology','harness','input'],
    'run.decide': ['id','reviewDigest','humanEvidenceRef','decision'],
    'run.cancel': ['id','reviewDigest','humanEvidenceRef'],
    'run.inspect': ['id'], 'run.list': [], 'run.dispatch': ['id'], 'run.reconcile': ['id'],
  };
  exactFields(i, shapes[op]);
  if (Object.hasOwn(i, 'id')) slug(('id' in i) ? i.id : undefined);
  if (op === 'receipt.inspect') slug(i.requestId);
  if (op === 'project.create') textField(i.name);
  if (op === 'goal.create') textField(i.description);
  if (op === 'run.prepare') {
    slug(i.goalId);
    for (const product of (['ontology','harness'] as const)) validateReference(i[product], { product, visibility: scope.visibility });
    composition(i.input);
  }
  if (op === 'run.decide' || op === 'run.cancel') {
    textField(i.humanEvidenceRef);
    if (typeof i.reviewDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(i.reviewDigest)) fail('INVALID_INPUT', 'Exact review digest required');
    if (op === 'run.decide' && !['APPROVE','REJECT'].includes(i.decision)) fail('INVALID_INPUT', 'Explicit decision required');
  }
}

function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT','Expected JSON object');
}
function evidence(value: unknown) {
  exactFields(value,['id','version','source','values']);
  textField(value.id); textField(value.version);
  exactFields(value.source,(['locator','revision','digest'] as const));
  for (const key of (['locator','revision','digest'] as const)) textField(value.source[key]);
  object(value.values);
}
function composition(input: unknown): asserts input is Composition {
  bounded(input);
  exactFields(input,['schema','ontologyInstance','harness']);
  if (input.schema !== 'runtime-composition/v1') fail('INVALID_INPUT','Unsupported composition');
  exactFields(input.ontologyInstance,(['entities','relations'] as const));
  for (const key of (['entities','relations'] as const)) {
    if (!Array.isArray(input.ontologyInstance[key]) || input.ontologyInstance[key].length > 1000) fail('INVALID_INPUT','Expected bounded entity/relation arrays');
  }
  for (const entity of input.ontologyInstance.entities as unknown[]) {
    exactFields(entity,['id','conceptRef','properties']);
    textField(entity.id); textField(entity.conceptRef); object(entity.properties);
    for (const [key,values] of Object.entries(entity.properties)) {
      textField(key);
      if (!Array.isArray(values) || values.some(v => v !== null && !['string','boolean','number'].includes(typeof v))) fail('INVALID_INPUT','Expected JSON primitive property values');
    }
  }
  for (const relation of input.ontologyInstance.relations as unknown[]) {
    exactFields(relation,(['id','relationRef','from','to'] as const));
    for (const key of (['id','relationRef','from','to'] as const)) textField(relation[key]);
  }
  exactFields(input.harness,['mode','evidence','configuration']);
  object(input.harness.configuration);
  if (input.harness.mode === 'component') evidence(input.harness.evidence);
  else if (input.harness.mode === 'composed') {
    object(input.harness.evidence);
    for (const [reference,value] of Object.entries(input.harness.evidence)) { textField(reference); evidence(value); }
  } else fail('INVALID_INPUT','Expected component or composed Harness mode');
  // Product adapters own reference resolution, model semantics and evidence rules.
  // All strings (including source locators) remain inert JSON descriptors.
}

function parseArgs(args: string[]) {
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) fail('USAGE', 'Invalid arguments');
  const [raw, ...rest] = args;
  const command = raw === '--help' ? 'help' : raw === '--version' ? 'version' : raw;
  if (['capabilities', 'help', 'version'].includes(command)) {
    if (rest.length) fail('USAGE', 'Unexpected arguments');
    return { command: command as 'capabilities'|'help'|'version' };
  }
  if (command !== 'request' && command !== 'native-request') fail('USAGE', 'Expected a supported command');
  const flags: Record<string,string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i], value = rest[i + 1];
    if (!['--workspace', '--workspace-id', '--request-file'].includes(key) || Object.hasOwn(flags, key) || !value || value.startsWith('--')) fail('USAGE', 'Invalid request flags');
    flags[key] = value;
  }
  const root = flags['--workspace'];
  if (!root || !isAbsolute(root) || resolve(root) !== root || !flags['--workspace-id']) fail('USAGE', 'Explicit canonical workspace and workspace id required');
  slug(flags['--workspace-id']);
  const file = flags['--request-file'];
  if (file && !isAbsolute(file)) fail('USAGE', 'Absolute request file required');
  return { command, root, id: flags['--workspace-id'], file };
}
async function readInput(file: string | undefined, stdin: InputStream, native = false): Promise<Request | NativeRequest> {
  const chunks: Buffer[] = []; let size = 0;
  const add = (chunk: string | Uint8Array) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > LIMITS.requestBytes) fail('LIMIT', 'Request byte limit');
    chunks.push(bytes);
  };
  if (file) {
    let handle;
    try {
      const before = await lstat(file);
      if (!before.isFile() || before.isSymbolicLink()) fail('INPUT_FILE', 'Regular request file required');
      if (before.size > LIMITS.requestBytes) fail('LIMIT', 'Request byte limit');
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const actual = await handle.stat();
      if (!actual.isFile() || actual.dev !== before.dev || actual.ino !== before.ino) fail('INPUT_FILE', 'Request file changed');
      if (actual.size > LIMITS.requestBytes) fail('LIMIT', 'Request byte limit');
      while (true) {
        const buffer = Buffer.alloc(Math.min(65536, LIMITS.requestBytes + 1 - size));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        add(buffer.subarray(0, bytesRead));
      }
    } catch (error) {
      if (errorCode(error) === 'LIMIT') throw error;
      fail('INPUT_FILE', 'Cannot read regular request file');
    } finally { await handle?.close(); }
  } else {
    for await (const chunk of stdin) add(chunk);
  }
  const bytes = Buffer.concat(chunks), text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail('INVALID_ENCODING', 'Invalid UTF-8');
  let request: Request;
  try { request = JSON.parse(text); } catch { fail('INVALID_REQUEST', 'Expected one JSON request'); }
  if(native){nativeAssertJSON(request);nativeExact(request,['operation','scope','input'],['requestId','expectedRevision']);if(!NATIVE_RUNTIME_OPERATIONS.includes(request.operation as NativeRequest['operation']))fail('INVALID_OPERATION','Unknown native operation');}
  else validateCLIRequest(request);
  return request;
}

// Injected streams are trusted test/host code, never request-configurable providers.
export async function main(args: string[], { stdin = process.stdin, stdout = process.stdout }: {stdin?: InputStream; stdout?: {write(value: string): unknown}} = {}) {
  let response, exitCode = 0, executing = false;
  try {
    const parsed = parseArgs(args);
    let result;
    if (parsed.command === 'help') result = help;
    else if (parsed.command === 'version') result = { product: PRODUCT, version: VERSION };
    else if (parsed.command === 'capabilities') result = {
      product: PRODUCT, version: VERSION, stage: 'NATIVE_STANDARDS_CLI', operations: operations.filter(op => !['run.prepare', 'run.decide'].includes(op)), asyncOperations: ['run.reconcile'], historicalRunsReadOnly: true,
      nativeOperations:NATIVE_RUNTIME_OPERATIONS,nativeLimits:NATIVE_RUNTIME_LIMITS,
      limits: LIMITS, authority: false, softwareRelease: false,
      pending: ['exact-candidate acceptance'],
      providers: { resolveOntology: false, resolveHarness: false, execute: false, inspectReceipt: false },
    };
    else {
      const request = await readInput(parsed.file, stdin, parsed.command==='native-request');
      const service = createRuntimeService({ workspaceRoot: parsed.root!, workspaceId: parsed.id! });
      try {
        executing = true;
        service.initialize();
        if(parsed.command==='native-request')result=await service.native(request as NativeRequest);
        else if (request.operation === 'run.dispatch' || request.operation === 'run.reconcile') {
          const { scope, input: { id }, requestId, expectedRevision } = request;
          const args = { scope, id, requestId, expectedRevision };
          result = await (request.operation === 'run.dispatch' ? service.dispatch(args as ExternalRequest) : service.reconcile(args as ExternalRequest));
        } else result = service.execute(request as Request<Exclude<Request['operation'],'run.dispatch'|'run.reconcile'>>);
      } finally { service.close(); }
    }
    response = { ok: true, product: PRODUCT, version: VERSION, result, authority: false };
  } catch (error) {
    const code = ['USAGE', 'INPUT_FILE'].includes(errorCode(error)!) || serviceCodes.has(errorCode(error)!) ? errorCode(error)! : executing ? 'STATE_ERROR' : 'INVALID_REQUEST';
    // Never echo exception messages, paths, parser excerpts or caller-controlled fields.
    const message = code === 'USAGE' ? 'Invalid command arguments; use help.'
      : code === 'INPUT_FILE' ? 'Cannot read a bounded regular request file.'
      : ['MISSING_RESOLVER', 'MISSING_EXECUTOR'].includes(code) ? 'Required trusted Runtime provider is not configured.'
      : executing ? 'Runtime service request failed.' : 'Invalid or oversized request input.';
    response = { ok: false, error: { code, message }, authority: false };
    exitCode = executing ? 1 : 2;
  }
  stdout.write(JSON.stringify(response) + '\n');
  return exitCode;
}

// Resolve the argv entry so an installed package-manager bin symlink also works.
function isEntry() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}
if (isEntry()) process.exitCode = await main(process.argv.slice(2));
