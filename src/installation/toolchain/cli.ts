import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectBundledToolchainLock, inspectNativeToolchain, prepareNativeToolchain } from './locked.js';

/** Pipe writes may be partial. Await the stream callback so a full dependency
 * inventory reaches the caller before this command can report completion. */
export async function writeToolchainResult(value:unknown):Promise<void> {
  await new Promise<void>((resolve,reject)=>process.stdout.write(JSON.stringify(value)+'\n',error=>error?reject(error):resolve()));
}

/** Standalone preparation for a fixed bundled lock, never a caller-selected URL or executable. */
export async function toolchainCommand(args: string[]): Promise<unknown> {
  const [operation, ...rest] = args;
  if (operation === 'lock' && !rest.length) return inspectBundledToolchainLock();
  if (!['inspect', 'prepare'].includes(operation)) throw new Error('Usage: lock | inspect --cache DIR | prepare --cache DIR [--offline] [--mirror DIR]');
  const values = new Map<string, string>(); let offline = false;
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (key === '--offline' && operation === 'prepare' && !offline) { offline = true; continue; }
    if (!['--cache', ...(operation === 'prepare' ? ['--mirror'] : [])].includes(key) || values.has(key)) throw new Error('Unknown or repeated option');
    const value = rest[++i];
    if (!value || !path.isAbsolute(value) || path.normalize(value) !== value) throw new Error('Expected canonical absolute directory');
    values.set(key, value);
  }
  const cacheRoot = values.get('--cache'); if (!cacheRoot) throw new Error('Missing --cache');
  if (operation === 'inspect') return inspectNativeToolchain({ cacheRoot });
  return prepareNativeToolchain({ cacheRoot, ...(values.has('--mirror') ? { downloadCache: values.get('--mirror') } : {}), offline });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await writeToolchainResult(await toolchainCommand(process.argv.slice(2))); }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : 'Toolchain operation failed') + '\n'); process.exitCode = 1; }
}
