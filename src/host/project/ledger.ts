/** Runtime-owned compatibility migrated from EvoPilot 0.8.3. See provenance/project-compatibility.json. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validateCampaignInput } from './campaign.js';
import { withProjectLock } from './project-lock.js';
import { canonicalPath, readRegular, canonicalJSON, fail } from './files.js';

export interface ProjectContext { projectRoot: string; stateRoot: string; workspaceId: string; installationRoot: string; assertCurrent?:()=>void }
interface FilePin { path: string; sha256: string; bytes: number }
interface SourceBaseline { root: string; revision: string | null; files: FilePin[]; digest: string }
interface ProjectRecord { schema: 'evopilot-project-baseline/v1'; workspaceId: string; projectId: string; baseline: SourceBaseline; authority: false }
interface EvidencePin { root: 'project' | 'state'; path: string; sha256: string }
interface Criterion { id: string; status: 'PASS' | 'FAIL' | 'PENDING' | 'UNKNOWN'; evidence: EvidencePin[] }
interface Campaign { schema: 'evopilot-private-campaign/v1'; projectId: string; id: string; goal: string; sourceDigest: string; criteria: Criterion[]; loops: unknown[]; status: 'IN_PROGRESS' | 'COMPLETE'; authority: false }
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const slug = (v: unknown): string => { if (typeof v !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(v)) fail('PROJECT_ID'); return v; };
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).sort().join('|') !== keys.sort().join('|')) fail('PROJECT_SCHEMA');
}
function relative(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || path.isAbsolute(value) || value.includes('\\') || value.split('/').some(x => !x || x === '.' || x === '..' || x === '.git')) fail('PROJECT_PATH');
  return value;
}
function safeRoot(context: ProjectContext) {
  context.assertCurrent?.();
  canonicalPath(context.projectRoot); canonicalPath(context.stateRoot); slug(context.workspaceId);
  const st = fs.lstatSync(context.projectRoot);
  if (!st.isDirectory() || st.uid !== process.getuid!() || (st.mode & 0o077)) fail('PROJECT_PERMISSIONS');
  const marker = JSON.parse(readRegular(path.join(context.projectRoot, 'workspace-project.json'), 8192, true).toString());
  if (marker.schema !== 'evopilot-workspace-project/v1' || marker.id !== context.workspaceId) fail('PROJECT_IDENTITY');
  for (const forbidden of [context.installationRoot, context.stateRoot]) if (context.projectRoot === forbidden || context.projectRoot.startsWith(forbidden + path.sep) || forbidden.startsWith(context.projectRoot + path.sep)) fail('PROJECT_LOCATION');
}
function folder(root: string, rel: string, create = false): string {
  let current = root;
  for (const part of relative(rel).split('/')) {
    current = path.join(current, part);
    if (!fs.existsSync(current) && create) { try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
    canonicalPath(current);
    const st = fs.lstatSync(current);
    if (!st.isDirectory() || st.uid !== process.getuid!() || (st.mode & 0o077)) fail('PROJECT_PERMISSIONS');
  }
  return current;
}
function jsonFile(filename: string): unknown { return JSON.parse(readRegular(filename, 1048576, true).toString()); }
function putNew(filename: string, value: unknown, staging: string) {
  const bytes = canonicalJSON(value) + '\n';
  if (fs.existsSync(filename)) { if (readRegular(filename, 1048576, true).toString() !== bytes) fail('PROJECT_CONFLICT'); return; }
  const temporary = path.join(staging, 'pending-' + randomBytes(12).toString('hex'));
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // All writers hold the project transaction. Only a complete file enters history.
    if (fs.existsSync(filename)) fail('PROJECT_CONFLICT');
    fs.renameSync(temporary, filename);
    for (const root of [path.dirname(filename), staging]) { const dir = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function source(root: unknown, files: unknown): SourceBaseline {
  if (typeof root !== 'string' || !Array.isArray(files) || !files.length || files.length > 2000 || new Set(files).size !== files.length) fail('PROJECT_SOURCE');
  canonicalPath(root);
  if (!fs.lstatSync(root).isDirectory()) fail('PROJECT_SOURCE');
  let total = 0;
  const pins = files.map(item => {
    const rel = relative(item); const filename = path.join(root, rel); canonicalPath(filename);
    const st = fs.lstatSync(filename);
    if (!st.isFile() || st.nlink !== 1 || st.size > 16 * 1048576 || (total += st.size) > 128 * 1048576) fail('PROJECT_SOURCE_LIMIT');
    const bytes = fs.readFileSync(filename);
    if (bytes.length !== st.size) fail('PROJECT_SOURCE_CHANGED');
    return { path: rel, sha256: hash(bytes), bytes: bytes.length };
  }).sort((a,b) => a.path.localeCompare(b.path));
  let revision: string | null = null;
  try { revision = execFileSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'], timeout: 5000, maxBuffer: 1024 }).trim(); }
  catch { /* A requirements-only directory need not be a Git repository. */ }
  if (revision !== null && !/^[a-f0-9]{40,64}$/.test(revision)) fail('PROJECT_SOURCE_REVISION');
  return { root, revision, files: pins, digest: hash(canonicalJSON({ root, revision, files: pins })) };
}
function readProjectHistory(context: ProjectContext, projectId: string): { record: ProjectRecord; revision: string | null } {
  const directory = folder(context.projectRoot, 'private/projects/' + projectId);
  const value = jsonFile(path.join(directory, 'project.json'));
  exact(value, ['schema','workspaceId','projectId','baseline','authority']);
  if (value.schema !== 'evopilot-project-baseline/v1' || value.workspaceId !== context.workspaceId || value.projectId !== projectId || value.authority !== false) fail('PROJECT_IDENTITY');
  const b = value.baseline; exact(b, ['root','revision','files','digest']);
  if (b.digest !== hash(canonicalJSON({root:b.root,revision:b.revision,files:b.files}))) fail('PROJECT_BASELINE_CORRUPT');
  let record = value as unknown as ProjectRecord; let revision: string | null = null;
  const history = path.join(directory, 'baselines');
  if (fs.existsSync(history)) {
    folder(context.projectRoot, 'private/projects/' + projectId + '/baselines');
    const events = fs.readdirSync(history).map(name => {
      if (!/^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(name)) fail('PROJECT_BASELINE_CORRUPT');
      const event = jsonFile(path.join(history, name));
      exact(event, ['previousDigest','previousRevision','record','reviewReason','authority']);
      if (event.previousRevision !== null && !/^[a-f0-9]{64}$/.test(String(event.previousRevision))) fail('PROJECT_BASELINE_CORRUPT');
      const next = event.record; exact(next, ['schema','workspaceId','projectId','baseline','authority']);
      const baseline = next.baseline; exact(baseline, ['root','revision','files','digest']);
      if (next.schema !== record.schema || next.workspaceId !== record.workspaceId || next.projectId !== projectId || next.authority !== false || event.authority !== false || baseline.digest !== hash(canonicalJSON({root:baseline.root,revision:baseline.revision,files:baseline.files}))) fail('PROJECT_BASELINE_CORRUPT');
      return event;
    });
    while (events.length) {
      const next = events.filter(event => event.previousRevision === revision);
      if (next.length !== 1 || next[0].previousDigest !== record.baseline.digest) fail('PROJECT_BASELINE_CORRUPT');
      revision = hash(canonicalJSON(next[0]));
      record = next[0].record as unknown as ProjectRecord;
      events.splice(events.indexOf(next[0]), 1);
    }
  }
  return { record, revision };
}
function readProject(context: ProjectContext, projectId: string): ProjectRecord { return readProjectHistory(context, projectId).record; }
type ProjectOperation = 'bind' | 'inspect' | 'drift' | 'baseline.accept' | 'campaign.write' | 'campaign.inspect';
export async function projectOperation(context: ProjectContext, operation: ProjectOperation, input: unknown, requestId: string): Promise<unknown> {
  safeRoot(context); slug(requestId);
  if (['bind','baseline.accept','campaign.write'].includes(operation)) {
    if (!input || typeof input !== 'object' || !('projectId' in input)) fail('PROJECT_SCHEMA');
    const projectId = slug(input.projectId);
    const directory = folder(context.projectRoot, 'private/projects/' + projectId, operation === 'bind');
    return withProjectLock(directory, context.workspaceId, projectId, staging => projectOperationUnlocked(context, operation, input, requestId, staging));
  }
  return projectOperationUnlocked(context, operation, input, requestId, '');
}
function projectOperationUnlocked(context: ProjectContext, operation: 'bind' | 'inspect' | 'drift' | 'baseline.accept' | 'campaign.write' | 'campaign.inspect', input: unknown, requestId: string, staging: string): unknown {
  safeRoot(context); slug(requestId);
  if (operation === 'bind') {
    exact(input, ['projectId','sourceRoot','files']); const projectId = slug(input.projectId);
    const baseline = source(input.sourceRoot, input.files);
    const record: ProjectRecord = { schema:'evopilot-project-baseline/v1',workspaceId:context.workspaceId,projectId,baseline,authority:false };
    const directory = folder(context.projectRoot, 'private/projects/' + projectId, true);
    putNew(path.join(directory,'project.json'), record, staging);
    return { requestId, operation, record, authority:false };
  }
  if (operation === 'inspect' || operation === 'drift') {
    exact(input, ['projectId']); const record = readProject(context, slug(input.projectId));
    if (operation === 'inspect') return { requestId, operation, record, authority:false };
    let current: SourceBaseline;
    try { current = source(record.baseline.root, record.baseline.files.map(f => f.path)); }
    catch (error) { return { requestId, operation, status:'UNKNOWN', baselineDigest:record.baseline.digest, reason:error instanceof Error ? error.message : 'SOURCE_UNAVAILABLE', authority:false }; }
    const changed = current.files.filter(f => record.baseline.files.find(old => old.path === f.path)?.sha256 !== f.sha256).map(f=>f.path);
    return { requestId, operation, status:current.digest === record.baseline.digest ? 'ALIGNED' : 'REVIEW_REQUIRED', baselineDigest:record.baseline.digest,current,changed,authority:false };
  }
  if (operation === 'baseline.accept') {
    exact(input, ['projectId','previousDigest','newDigest','reviewReason']);
    const projectId = slug(input.projectId);
    if (typeof input.reviewReason !== 'string' || !input.reviewReason.trim() || input.reviewReason.length > 8192 || !/^[a-f0-9]{64}$/.test(String(input.previousDigest)) || !/^[a-f0-9]{64}$/.test(String(input.newDigest)) || input.previousDigest === input.newDigest) fail('PROJECT_REVIEW_REQUIRED');
    const history = folder(context.projectRoot, 'private/projects/' + projectId + '/baselines', true);
    const filename = path.join(history, requestId + '.json');
    if (fs.existsSync(filename)) {
      const previous = jsonFile(filename) as {previousDigest:string;record:ProjectRecord;reviewReason:string};
      if (previous.previousDigest !== input.previousDigest || previous.record.baseline.digest !== input.newDigest || previous.reviewReason !== input.reviewReason) fail('PROJECT_CONFLICT');
      return {requestId,operation,record:previous.record,reused:true,authority:false};
    }
    const { record, revision } = readProjectHistory(context, projectId);
    if (record.baseline.digest !== input.previousDigest) fail('PROJECT_CONFLICT');
    const baseline = source(record.baseline.root, record.baseline.files.map(f=>f.path));
    if (baseline.digest !== input.newDigest) fail('PROJECT_SOURCE_CHANGED');
    const next: ProjectRecord = {...record,baseline};
    putNew(filename,{previousDigest:input.previousDigest,previousRevision:revision,record:next,reviewReason:input.reviewReason,authority:false},staging);
    return {requestId,operation,record:next,reused:false,authority:false};
  }
  if (operation === 'campaign.inspect') {
    exact(input, ['projectId','id']); const projectId=slug(input.projectId), id=slug(input.id);
    readProject(context, projectId);
    const directory=folder(context.projectRoot,'private/projects/'+projectId+'/targets/'+id);
    const revisions=fs.readdirSync(directory).filter(x=>/^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(x)).sort().map(x=>jsonFile(path.join(directory,x)));
    return { requestId, operation, revisions, authority:false };
  }
  if (operation !== 'campaign.write') fail('PROJECT_OPERATION');
  exact(input, ['projectId','id','goal','sourceDigest','criteria','loops','status']);
  const projectId=slug(input.projectId), id=slug(input.id), record=readProject(context,projectId);
  validateCampaignInput(input);
  if (input.sourceDigest !== record.baseline.digest) fail('CAMPAIGN_SCHEMA');
  for (const item of input.criteria) {
    for (const evidence of item.evidence) {
      const relativePath = evidence.path;
      const filename=path.join(evidence.root==='project'?context.projectRoot:context.stateRoot,relativePath);
      if (hash(readRegular(filename,16*1048576,true)) !== evidence.sha256) fail('CAMPAIGN_EVIDENCE_CHANGED');
    }
  }
  if (input.status === 'COMPLETE' && source(record.baseline.root, record.baseline.files.map(f=>f.path)).digest !== record.baseline.digest) fail('PROJECT_SOURCE_CHANGED');
  const campaign: Campaign = {schema:'evopilot-private-campaign/v1',...(input as unknown as Omit<Campaign,'schema'|'authority'>),authority:false};
  if (Buffer.byteLength(canonicalJSON(campaign))>1048576) fail('CAMPAIGN_LIMIT');
  const directory=folder(context.projectRoot,'private/projects/'+projectId+'/targets/'+id,true);
  putNew(path.join(directory,requestId+'.json'),campaign,staging);
  return {requestId,operation,campaign,meaning:'Private evidence ledger; not a native Goal completion, approval or release decision',authority:false};
}
