/** Retained Runtime collector from EvoPilot 0.8.3; see provenance/legacy-execution.json. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { CollectionContext, CollectionClaim, CollectionProviderResult } from '../../native-types.js';
import { nativeSha256, nativeStableSerialize } from '../../../vendor/compatibility/v1/native.mjs';
import { checkDirectory, verifyBinding } from './worker.js';
import type { CollectionExecutionBinding, CollectionWorkerRequest } from './types.js';

export interface LocalCollectionProviders {
  resolveExecution: (claim: Readonly<CollectionClaim>) => Promise<CollectionExecutionBinding> | CollectionExecutionBinding;
  assertCurrent?:()=>void;
}
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
function read(filename: string) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid!() || stat.mode & 0o077 || stat.size > 32 * 1024 * 1024) fail('COLLECTOR_JOURNAL');
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
export function createLocalCollector(providers: LocalCollectionProviders) {
  async function request(context: CollectionContext): Promise<CollectionWorkerRequest> {
    providers.assertCurrent?.();
    const binding = await providers.resolveExecution(context.claim);
    providers.assertCurrent?.();
    const result: CollectionWorkerRequest = { schema: 'evopilot-collection-worker/v1', claim: context.claim, artifactRoot: context.artifactRoot, binding };
    verifyBinding(result); return result;
  }
  async function inspectCollection(context: CollectionContext): Promise<CollectionProviderResult | null> {
    const current = await request(context), journal = path.join(context.artifactRoot, '.collector');
    if (!fs.existsSync(journal)) return null;
    checkDirectory(journal);
    const retained = read(path.join(journal, 'request.json'));
    if (nativeSha256(retained) !== nativeSha256(current)) fail('COLLECTOR_CLAIM_MISMATCH');
    const filename = path.join(journal, 'result.json');
    if (!fs.existsSync(filename)) return null;
    const result = read(filename);
    if (result.requestDigest !== nativeSha256(current)) fail('COLLECTOR_CLAIM_MISMATCH');
    return result.result as CollectionProviderResult;
  }
  async function collect(context: CollectionContext): Promise<CollectionProviderResult> {
    const current = await request(context), journal = path.join(context.artifactRoot, '.collector');
    if (context.signal.aborted) fail('ABORTED');
    if (fs.existsSync(journal)) fail('COLLECTION_ALREADY_ATTEMPTED');
    fs.mkdirSync(journal, { mode: 0o700 });
    const filename = path.join(journal, 'request.json'), fd = fs.openSync(filename, 'wx', 0o600);
    try { fs.writeFileSync(fd, nativeStableSerialize(current) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const worker = spawn(process.execPath, [fileURLToPath(new URL('./worker.js', import.meta.url)), filename], { detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
    let workerError: Error | null = null; worker.on('error', e => { workerError = e; }); worker.unref();
    const start = Date.now();
    for (;;) {
      try { providers.assertCurrent?.(); } catch(error) { fs.writeFileSync(path.join(journal,'cancel'),'cancel\n',{mode:0o600}); throw error; }
      if (workerError) fail('COLLECTOR_START_FAILED');
      if (fs.existsSync(path.join(journal, 'result.json'))) {
        const result = await inspectCollection(context); if (result) return result;
      }
      if (context.signal.aborted) { fs.writeFileSync(path.join(journal, 'cancel'), 'cancel\n', { mode: 0o600 }); fail('ABORTED'); }
      if (Date.now() - start > context.claim.recipe.timeoutMs + 1500) fail('COLLECTION_UNKNOWN');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  return { collect, inspectCollection };
}
