import { spawnSync } from 'node:child_process';
import { chmodSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Remove only this compiler's generated output, so stale files cannot ship.
rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
const result = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
else chmodSync(new URL('../dist/cli.js', import.meta.url), 0o755);
