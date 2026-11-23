import { closeSync, existsSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exact, record, reject } from './errors.js';
import { ensurePrivateRoot, readPrivateJson, type Permission } from './security.js';

const metadata = record(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')));
const profile = metadata.evopilotDistributionProfile;
if (profile !== undefined && profile !== 'limited-preview') throw new Error('Unknown Runtime distribution profile');
export const limitedPreview = profile === 'limited-preview';

const allowed = new Set([
  'runtime.status', 'runtime.projects.list', 'runtime.events.read', 'runtime.receipt.read',
  'lifecycle.base.inspect', 'lifecycle.definition.inspect', 'lifecycle.definition.read',
  'lifecycle.definition.source.read', 'lifecycle.definition.validate', 'lifecycle.draft.save',
]);

export function supportedOperations<T extends string>(operations: readonly T[]): T[] {
  return limitedPreview ? operations.filter(operation => allowed.has(operation)) : [...operations];
}

export function previewAllows(operation: string): void {
  if (limitedPreview && !allowed.has(operation)) previewUnavailable();
}

export function previewUnavailable(): never {
  return reject('LIMITED_PREVIEW', 'This operation is unavailable in the isolated Runtime Preview', 403);
}

export function previewRole(role: string): void {
  if (limitedPreview && role !== 'reader' && role !== 'editor') previewUnavailable();
}

export function visiblePermissions(permissions: readonly Permission[]): readonly Permission[] {
  return limitedPreview ? permissions.filter(p => p === 'read' || p === 'draft.write') : permissions;
}

export function previewState(root: string, workspaceId: string, initialize = false): void {
  if (!limitedPreview) return;
  const file = join(root, 'limited-preview.json');
  if (initialize) {
    ensurePrivateRoot(root);
    if (!existsSync(file)) {
      if (readdirSync(root).length) previewUnavailable();
      let fd: number | undefined;
      try {
        fd = openSync(file, 'wx', 0o600);
        writeFileSync(fd, JSON.stringify({ schema: 'runtime-limited-state/v1', workspaceId }) + '\n');
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
  }
  if (!existsSync(file)) previewUnavailable();
  const marker = record(readPrivateJson(file));
  exact(marker, ['schema','workspaceId']);
  if (marker.schema !== 'runtime-limited-state/v1' || marker.workspaceId !== workspaceId) previewUnavailable();
}
