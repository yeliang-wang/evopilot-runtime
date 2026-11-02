import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { canonical, digest, exact, record, reject, slug, string } from './errors.js';
import { authorize, ensurePrivateRoot, privateFile, type Principal, type Permission } from './security.js';

export interface Mutation { projectId: string; operation: string; requestId: string; expectedRevision: number; input: unknown; permission: Permission; }
export interface StoredObject { kind: string; id: string; value: unknown; }
export interface MutationResult { value: unknown; objects?: StoredObject[]; event: { type: string; data: unknown }; }
export interface Receipt { projectId: string; requestId: string; operation: string; principalId: string; revision: number; requestDigest: string; result: unknown; at: string; }

/** Owns one local writer. The OS releases the separate SQLite exclusive lock after process death. */
export class RuntimeStore {
  private lock: DatabaseSync;
  private db: DatabaseSync;
  private closed = false;
  readonly serviceId: string;
  private cursorKey: Buffer;
  constructor(readonly root: string, readonly workspaceId: string) {
    slug(workspaceId); ensurePrivateRoot(root);
    const lockPath = join(root, 'writer-lock.sqlite'); privateFile(lockPath, true);
    this.lock = new DatabaseSync(lockPath);
    try { this.lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;'); }
    catch { this.lock.close(); reject('WRITER_ACTIVE', 'This state directory already has a writer', 409); }
    let database: DatabaseSync | undefined;
    try {
      const path = join(root, 'service.sqlite'); privateFile(path, true);
      for (const suffix of ['-wal','-shm','-journal']) if (existsSync(path + suffix)) privateFile(path + suffix);
      database = new DatabaseSync(path); this.db = database;
      const version = Number(database.prepare('PRAGMA user_version').get()!.user_version);
      if (![0, 1].includes(version)) reject('INCOMPATIBLE_STATE', 'Unsupported service state schema', 409);
      if (version === 0 && Number(database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()!.n) !== 0) reject('INCOMPATIBLE_STATE', 'Existing unrecognized database will not be adopted', 409);
      if (version === 1) {
        const tables=database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>String(r.name));
        if (tables.join(',') !== 'audit,events,objects,project_revisions,receipts,service_meta') reject('CORRUPT_STATE','Required service tables are missing or unexpected',503);
        if(database.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok')reject('CORRUPT_STATE','Service database integrity check failed',503);
      }
      database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; BEGIN IMMEDIATE;');
      database.exec(`CREATE TABLE IF NOT EXISTS service_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), workspace_id TEXT NOT NULL, service_id TEXT NOT NULL, cursor_key TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS project_revisions (project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS objects (project_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(project_id,kind,id));
        CREATE TABLE IF NOT EXISTS receipts (project_id TEXT NOT NULL, principal_id TEXT NOT NULL, request_id TEXT NOT NULL, request_digest TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(project_id,principal_id,request_id));
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, revision INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_project_seq ON events(project_id,seq);
        CREATE TABLE IF NOT EXISTS audit (project_id TEXT NOT NULL, revision INTEGER NOT NULL, principal_id TEXT NOT NULL, request_id TEXT NOT NULL, request_digest TEXT NOT NULL, receipt_digest TEXT NOT NULL, event_digest TEXT NOT NULL, PRIMARY KEY(project_id,revision));`);
      database.prepare('INSERT OR IGNORE INTO service_meta VALUES(1,?,?,?)').run(workspaceId, randomUUID(), randomBytes(32).toString('hex'));
      const meta = database.prepare('SELECT * FROM service_meta WHERE singleton=1').get()!;
      if (meta.workspace_id !== workspaceId || typeof meta.service_id !== 'string' || typeof meta.cursor_key !== 'string' || !/^[a-f0-9]{64}$/.test(meta.cursor_key)) reject('WRONG_WORKSPACE', 'State identity does not match the requested workspace', 409);
      this.serviceId = meta.service_id; this.cursorKey = Buffer.from(meta.cursor_key, 'hex');
      this.verifyLedger();
      database.exec('PRAGMA user_version=1; COMMIT;');
    } catch (e) { database?.close(); this.lock.close(); throw e; }
  }
  private guard(): void { if (this.closed) reject('CLOSED', 'Service store is closed', 503); }
  private verifyLedger(): void {
    const totals=this.db.prepare('SELECT (SELECT count(*) FROM audit) AS audit,(SELECT count(*) FROM receipts) AS receipts,(SELECT count(*) FROM events) AS events,COALESCE((SELECT sum(revision) FROM project_revisions),0) AS revision').get()!;
    if(totals.audit!==totals.receipts || totals.audit!==totals.events || totals.audit!==totals.revision)reject('CORRUPT_STATE','Receipt, audit and event counts disagree',503);
    for(const row of this.db.prepare('SELECT * FROM receipts').all()) {
      const receipt=record(JSON.parse(String(row.data)) as unknown);
      exact(receipt,['projectId','requestId','operation','principalId','revision','requestDigest','result','at']);
      if(receipt.projectId!==row.project_id || receipt.principalId!==row.principal_id || receipt.requestId!==row.request_id || receipt.requestDigest!==row.request_digest || !Number.isSafeInteger(receipt.revision) || Number(receipt.revision)<1)reject('CORRUPT_STATE','Receipt identity mismatch',503);
      const audit=this.db.prepare('SELECT * FROM audit WHERE project_id=? AND revision=?').get(String(row.project_id),Number(receipt.revision));
      if(!audit || audit.principal_id!==row.principal_id || audit.request_id!==row.request_id || audit.request_digest!==row.request_digest || audit.receipt_digest!==digest(receipt))reject('CORRUPT_STATE','Receipt audit mismatch',503);
      if(this.db.prepare('SELECT count(*) AS n FROM events WHERE project_id=? AND revision=?').get(String(row.project_id),Number(receipt.revision))!.n!==1 || this.revision(String(row.project_id))<Number(receipt.revision))reject('CORRUPT_STATE','Receipt event/revision mismatch',503);
      const event=this.db.prepare('SELECT type,data,at FROM events WHERE project_id=? AND revision=?').get(String(row.project_id),Number(receipt.revision))!;
      if(audit.event_digest!==digest({projectId:row.project_id,revision:receipt.revision,type:event.type,data:JSON.parse(String(event.data)) as unknown,at:event.at}))reject('CORRUPT_STATE','Event audit mismatch',503);
    }
  }
  revision(projectId: string): number { this.guard(); slug(projectId); return Number(this.db.prepare('SELECT revision FROM project_revisions WHERE project_id=?').get(projectId)?.revision ?? 0); }
  object(projectId: string, kind: string, id: string): unknown | null {
    this.guard(); slug(projectId); slug(kind); string(id);
    const row = this.db.prepare('SELECT data FROM objects WHERE project_id=? AND kind=? AND id=?').get(projectId,kind,id);
    return row ? JSON.parse(String(row.data)) as unknown : null;
  }
  /** Internal bounded scan for the owned observation worker, never an HTTP
   * cross-project read. The worker may inspect an existing request, not dispatch. */
  pendingStageRequests(after?:{projectId:string;id:string}):{rows:{projectId:string;id:string}[];next:{projectId:string;id:string}|null}{
    this.guard();if(after){slug(after.projectId);string(after.id);}
    const rows=this.db.prepare("SELECT project_id,id FROM objects WHERE kind='stage-progress' AND json_extract(data,'$.terminal')=0 AND (project_id>? OR (project_id=? AND id>?)) ORDER BY project_id,id LIMIT 50").all(after?.projectId??'',after?.projectId??'',after?.id??'').map(r=>({projectId:String(r.project_id),id:String(r.id)}));
    return{rows,next:rows.length===50?rows.at(-1)!:null};
  }
  projects(principal: Principal): { projectId: string; revision: number }[] {
    this.guard();
    return principal.projects.filter(p => principal.permissions.includes('read')).slice(0,50).map(projectId => ({ projectId, revision: this.revision(projectId) }));
  }
  receipt(principal: Principal, projectId: string, requestId: string): Receipt {
    const saved=this.findReceipt(principal,projectId,requestId);
    if(!saved)return reject('NOT_FOUND','Receipt not found',404);
    return saved;
  }
  findReceipt(principal: Principal, projectId: string, requestId: string): Receipt|null {
    this.guard(); authorize(principal, projectId, 'read'); string(requestId);
    const row = this.db.prepare('SELECT data FROM receipts WHERE project_id=? AND principal_id=? AND request_id=?').get(projectId, principal.id, requestId);
    return row?JSON.parse(String(row.data)) as Receipt:null;
  }
  mutate(principal: Principal, request: Mutation, operation: () => MutationResult, reauthorize?: () => Principal): Receipt {
    this.guard(); authorize(principal, request.projectId, request.permission);
    string(request.operation); string(request.requestId); canonical(request.input);
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) reject('INVALID_REVISION', 'Expected a nonnegative revision');
    const requestDigest = digest({ operation: request.operation, projectId: request.projectId, input: request.input });
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const old = this.db.prepare('SELECT request_digest,data FROM receipts WHERE project_id=? AND principal_id=? AND request_id=?').get(request.projectId, principal.id, request.requestId);
      if (old) {
        if (old.request_digest !== requestDigest) reject('REQUEST_CONFLICT', 'Request ID already binds different content', 409);
        if(reauthorize){const current=reauthorize();authorize(current,request.projectId,request.permission);if(current.id!==principal.id || current.revision!==principal.revision)reject('AUTHORITY_CHANGED','Authority changed during this request',409);}
        this.db.exec('COMMIT;'); return JSON.parse(String(old.data)) as Receipt;
      }
      const revision = this.revision(request.projectId);
      if (revision !== request.expectedRevision) reject('REVISION_CONFLICT', 'Project revision changed', 409);
      const result = operation();
      if (!result || typeof result !== 'object' || 'then' in result) reject('INVALID_TRANSACTION', 'Transaction callback must be synchronous');
      canonical(result.value); slug(result.event.type); const eventData = canonical(result.event.data);
      if (Buffer.byteLength(eventData) > 65536) reject('EVENT_LIMIT', 'Event exceeds 64 KiB', 413);
      for (const item of result.objects ?? []) {
        slug(item.kind); string(item.id);
        this.db.prepare('INSERT INTO objects VALUES(?,?,?,?) ON CONFLICT(project_id,kind,id) DO UPDATE SET data=excluded.data').run(request.projectId,item.kind,item.id,canonical(item.value));
      }
      if (reauthorize) {
        const current = reauthorize(); authorize(current, request.projectId, request.permission);
        if (current.id !== principal.id || current.revision !== principal.revision) reject('AUTHORITY_CHANGED', 'Authority changed during this request', 409);
      }
      const at = new Date().toISOString();
      const receipt: Receipt = { projectId: request.projectId, requestId: request.requestId, operation: request.operation, principalId: principal.id, revision: revision+1, requestDigest, result: result.value, at };
      this.db.prepare('INSERT INTO project_revisions VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision').run(request.projectId, revision+1);
      this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?)').run(request.projectId,principal.id,request.requestId,requestDigest,canonical(receipt));
      this.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?)').run(request.projectId,revision+1,principal.id,request.requestId,requestDigest,digest(receipt),digest({projectId:request.projectId,revision:revision+1,type:result.event.type,data:result.event.data,at}));
      this.db.prepare('INSERT INTO events(project_id,revision,type,data,at) VALUES(?,?,?,?,?)').run(request.projectId,revision+1,result.event.type,eventData,at);
      this.db.exec('COMMIT;'); return receipt;
    } catch (e) { this.db.exec('ROLLBACK;'); throw e; }
  }
  events(principal: Principal, projectId: string, cursor?: string): { events: unknown[]; cursor: string } {
    this.guard(); authorize(principal,projectId,'read');
    let after = 0;
    if (cursor) {
      string(cursor, 1024); const [body, signature, extra] = cursor.split('.');
      const expected = createHmac('sha256', this.cursorKey).update(body).digest('base64url');
      if (extra || !signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature),Buffer.from(expected))) reject('INVALID_CURSOR', 'Cursor is invalid');
      let decoded: Record<string, unknown>;
      try { decoded = record(JSON.parse(Buffer.from(body,'base64url').toString('utf8'))); } catch { return reject('INVALID_CURSOR', 'Cursor is invalid'); }
      exact(decoded, ['projectId','after','serviceId']);
      if (decoded.projectId !== projectId || decoded.serviceId !== this.serviceId || !Number.isSafeInteger(decoded.after) || Number(decoded.after) < 0) reject('INVALID_CURSOR', 'Cursor belongs to a different scope');
      after = Number(decoded.after);
    }
    const rows = this.db.prepare('SELECT seq,revision,type,data,at FROM events WHERE project_id=? AND seq>? ORDER BY seq LIMIT 50').all(projectId,after);
    const events: unknown[] = []; let bytes = 1024;
    for (const row of rows) {
      const item = { seq: Number(row.seq), revision: Number(row.revision), type: String(row.type), data: JSON.parse(String(row.data)) as unknown, at: String(row.at) };
      const size = Buffer.byteLength(canonical(item)); if (bytes + size > 262144) break;
      events.push(item); bytes += size; after = item.seq;
    }
    const body = Buffer.from(canonical({projectId,after,serviceId:this.serviceId})).toString('base64url');
    return { events, cursor: body + '.' + createHmac('sha256',this.cursorKey).update(body).digest('base64url') };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.db.close(); } finally { this.lock.close(); }
  }
}
