import { constants, closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { canonical, exact, record, reject, slug, string } from './errors.js';

export const PERMISSIONS = ['read','draft.write','definition.activate','execution.request','decision.record','release.request'] as const;
export type Permission = typeof PERMISSIONS[number];
export interface Principal { readonly id: string; readonly projects: readonly string[]; readonly permissions: readonly Permission[]; readonly revision: number; readonly expiresAt: string; }
export const tokenDigest = (token: string): string => createHash('sha256').update(token).digest('hex');

export function ensurePrivateRoot(root: string): void {
  if (!isAbsolute(root) || resolve(root) !== root || root === parse(root).root) reject('UNSAFE_STATE', 'A canonical absolute private directory is required');
  const parent = dirname(root);
  if (realpathSync(parent) !== parent) reject('UNSAFE_STATE', 'State ancestors must not be symlinks');
  try { mkdirSync(root, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) reject('UNSAFE_STATE', 'State directory must be private and owned by this OS user');
}
export function privateFile(path: string, create = false): void {
  if (create) {
    try { const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); closeSync(fd); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) reject('UNSAFE_STATE', 'Private regular owned file required');
}
export function readPrivateJson(path: string): unknown {
  privateFile(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (stat.size > 131072 || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) reject('UNSAFE_AUTH', 'Invalid protected credential configuration');
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } catch { return reject('UNSAFE_AUTH', 'Protected credential configuration could not be read', 503); }
  finally { closeSync(fd); }
}
export interface Credential extends Principal { readonly tokenDigest: string; }
function credentials(value: unknown, workspaceId: string): readonly Credential[] {
  const config = record(value); exact(config, ['schema','workspaceId','principals']);
  if (config.schema !== 'runtime-auth/v1' || config.workspaceId !== workspaceId || !Array.isArray(config.principals) || config.principals.length > 128) reject('UNSAFE_AUTH', 'Credential configuration does not match this workspace', 503);
  const ids = new Set<string>(), tokens = new Set<string>();
  return config.principals.map(v => {
    const p = record(v); exact(p, ['id','projects','permissions','revision','expiresAt','tokenDigest']);
    const id = slug(p.id), hash = string(p.tokenDigest);
    if (ids.has(id) || tokens.has(hash) || !/^[a-f0-9]{64}$/.test(hash)) reject('UNSAFE_AUTH', 'Duplicate or invalid principal', 503);
    ids.add(id); tokens.add(hash);
    if (!Array.isArray(p.projects) || !p.projects.length || p.projects.length > 1000 || !Array.isArray(p.permissions) || !p.permissions.length || !Number.isSafeInteger(p.revision) || Number(p.revision) < 1) reject('UNSAFE_AUTH', 'Invalid principal scope', 503);
    const projects = p.projects.map(slug);
    const permissions = p.permissions.map(v => {
      if (!PERMISSIONS.includes(v as Permission)) return reject('UNSAFE_AUTH', 'Unknown permission', 503);
      return v as Permission;
    });
    const expiresAt = string(p.expiresAt);
    if (new Set(projects).size !== projects.length || new Set(permissions).size !== permissions.length || !Number.isFinite(Date.parse(expiresAt))) reject('UNSAFE_AUTH', 'Invalid principal metadata', 503);
    return Object.freeze({ id, tokenDigest: hash, projects: Object.freeze(projects), permissions: Object.freeze(permissions), revision: Number(p.revision), expiresAt });
  });
}
/** Operator-only bootstrap; no remote endpoint can create credentials or widen scope. */
export function initializeCredentials(root: string, workspaceId: string, principals: readonly Credential[]): void {
  ensurePrivateRoot(root); slug(workspaceId);
  const value = { schema: 'runtime-auth/v1', workspaceId, principals };
  credentials(value, workspaceId);
  const fd = openSync(join(root, 'auth.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, canonical(value)); fsyncSync(fd); } finally { closeSync(fd); }
}
export function assertCredentials(root: string, workspaceId: string): void { credentials(readPrivateJson(join(root,'auth.json')),workspaceId); }
export function authenticate(root: string, workspaceId: string, authorization: string | undefined, now = Date.now()): Principal {
  if (!authorization || !/^Bearer [a-zA-Z0-9_-]{32,256}$/.test(authorization)) return reject('UNAUTHENTICATED', 'A valid service credential is required', 401);
  const actual = Buffer.from(tokenDigest(authorization.slice(7)), 'hex');
  const principal = credentials(readPrivateJson(join(root, 'auth.json')), workspaceId).find(p => timingSafeEqual(actual, Buffer.from(p.tokenDigest, 'hex')));
  if (!principal || Date.parse(principal.expiresAt) <= now) return reject('UNAUTHENTICATED', 'A valid service credential is required', 401);
  const { tokenDigest: unused, ...publicPrincipal } = principal;
  return Object.freeze(publicPrincipal);
}
export function authorize(principal: Principal, projectId: string, permission: Permission, now = Date.now()): void {
  slug(projectId);
  if (Date.parse(principal.expiresAt) <= now || !principal.projects.includes(projectId) || !principal.permissions.includes(permission)) reject('FORBIDDEN', 'Current project permission is required', 403);
}
