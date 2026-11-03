/** Runtime-owned compatibility migrated from EvoPilot 0.8.3. See provenance/project-compatibility.json. */
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import { canonicalJSON, canonicalPath, fail } from './files.js';

function safe(filename: string, directory: boolean) {
  canonicalPath(filename);
  const st = fs.lstatSync(filename);
  if (st.uid !== process.getuid!() || (st.mode & 0o777) !== (directory ? 0o700 : 0o600)
    || (directory ? !st.isDirectory() : !st.isFile() || st.nlink !== 1)) fail('PROJECT_PERMISSIONS');
}
/** Separate from the outer Workspace lease; process death releases this transaction. */
export async function withProjectLock<T>(directory: string, workspaceId: string, projectId: string, callback: (staging: string) => T): Promise<T> {
  safe(directory, true);
  const root = path.join(directory, '.project-control');
  try { fs.mkdirSync(root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  safe(root, true);
  const filename = path.join(root, 'lease.db');
  try { fs.closeSync(fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  safe(filename, false);
  const db = new DatabaseSync(filename, { timeout: 0, allowExtension: false }); db.enableDefensive(true);
  let held = false; const deadline = Date.now() + 10000;
  try {
    while (!held) {
      for (const name of fs.readdirSync(root)) {
        if (!['lease.db', 'lease.db-journal'].includes(name) && !/^pending-[a-f0-9]{24}$/.test(name)) fail('PROJECT_PERMISSIONS');
        try { safe(path.join(root, name), false); } catch (error) { if (name !== 'lease.db-journal' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      try { db.exec('BEGIN IMMEDIATE'); held = true; }
      catch (error) {
        if (!error || typeof error !== 'object' || !('errcode' in error) || ![5, 6].includes(Number(error.errcode))) throw error;
        if (Date.now() >= deadline) fail('PROJECT_BUSY');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    db.exec('CREATE TABLE IF NOT EXISTS project_lease (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL)');
    // Project files are portable through verified maintenance; the ID remains fixed.
    const identity = canonicalJSON({ workspaceId, projectId });
    const row = db.prepare('SELECT identity FROM project_lease WHERE id=1').get();
    if (row && row.identity !== identity) fail('PROJECT_IDENTITY');
    db.prepare('INSERT OR IGNORE INTO project_lease(id,identity) VALUES(1,?)').run(identity);
    for (const name of fs.readdirSync(root)) if (/^pending-[a-f0-9]{24}$/.test(name)) { safe(path.join(root, name), false); fs.unlinkSync(path.join(root, name)); }
    const result = callback(root);
    db.exec('COMMIT'); held = false;
    return result;
  } finally { if (held) { try { db.exec('ROLLBACK'); } catch {} } db.close(); }
}
