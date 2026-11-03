/** Retained original template upgrade, adapted from EvoPilot 0.8.3.
 * See provenance/project-template-v02/manifest.json; never grants asset approval. */
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectContext } from './ledger.js';
import { withProjectLock } from './project-lock.js';
import {inspectProjectTemplate} from './templates.js';
import { canonicalJSON, canonicalPath, digest, fail, fields, readRegular } from './files.js';

export interface TemplateUpgradeInput { requestId: string; expectedTemplateVersion: string; targetTemplateVersion: '0.2.0' }
interface UpgradePlan {
  schema: 'runtime-template-upgrade/v1'; requestId: string; workspaceId: string;
  templateDigest: string; previousVersion: string; targetVersion: '0.2.0';
  originalMarkerDigest: string; upgradedMarkerDigest: string;
  created: string[]; customized: string[]; unchanged: string[]; authority: false;
}
const exists = (filename: string): boolean => { try { fs.lstatSync(filename); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } };
function directory(root: string): void {
  canonicalPath(root); const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o077)) fail('TEMPLATE_UPGRADE_PATH');
}
function synchronize(root: string): void { const fd = fs.openSync(root, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function createFile(filename: string, bytes: Buffer, stagingRoot: string): void {
  // Reserved request staging is disposable; final user paths never contain partial writes.
  const pending = path.join(stagingRoot, digest(filename) + '.pending');
  if (exists(pending)) { readRegular(pending, 8 * 1024 * 1024, true); fs.unlinkSync(pending); synchronize(stagingRoot); }
  const fd = fs.openSync(pending, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (exists(filename)) {
    if (digest(readRegular(filename)) !== digest(bytes)) fail('TEMPLATE_UPGRADE_CONFLICT');
    fs.unlinkSync(pending);
  } else {
    // Atomic no-replace publication: a user-created file appearing after the
    // preflight must not be overwritten by rename. A crash may retain the two
    // exact links; recoverPublication completes only that owned staging link.
    try { fs.linkSync(pending, filename); }
    catch(error) {
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      if(digest(readRegular(filename))!==digest(bytes))fail('TEMPLATE_UPGRADE_CONFLICT');
    }
    fs.unlinkSync(pending);
  }
  synchronize(stagingRoot); synchronize(path.dirname(filename));
}
function recoverPublication(context:ProjectContext,requestId:string):void {
  const recordRoot=path.join(context.projectRoot,'.evopilot-template-upgrades'),staging=path.join(recordRoot,'.staging-'+requestId);
  if(!exists(staging))return;directory(staging);
  const destinations=[path.join(recordRoot,requestId+'.json'),path.join(recordRoot,requestId+'.workspace-project.json'),path.join(context.projectRoot,'.workspace-project-'+requestId+'.tmp'),...inspectProjectTemplate().files.map(f=>path.join(context.projectRoot,f.relative))];
  const allowed=new Map(destinations.map(file=>[digest(file)+'.pending',file]));
  for(const name of fs.readdirSync(staging)){
    const target=allowed.get(name);if(!target)fail('TEMPLATE_UPGRADE_CONFLICT');
    const file=path.join(staging,name);canonicalPath(file);const pending=fs.lstatSync(file);
    if(!pending.isFile()||pending.uid!==process.getuid!()||(pending.mode&0o777)!==0o600||pending.size>8*1024*1024||![1,2].includes(pending.nlink))fail('TEMPLATE_UPGRADE_CONFLICT');
    if(pending.nlink===1)continue;
    canonicalPath(target);const published=fs.lstatSync(target);
    if(!published.isFile()||published.dev!==pending.dev||published.ino!==pending.ino||published.nlink!==2)fail('TEMPLATE_UPGRADE_CONFLICT');
    fs.unlinkSync(file);synchronize(staging);synchronize(path.dirname(target));
  }
}
function parentDirectories(root: string, relative: string, create: boolean): void {
  let current = root;
  for (const segment of relative.split('/').slice(0, -1)) {
    current = path.join(current, segment);
    if (!exists(current)) { if (!create) return; fs.mkdirSync(current, { mode: 0o700 }); synchronize(path.dirname(current)); }
    directory(current);
  }
}

/** Explicit template upgrade; product installation and business state are never changed. */
export async function upgradeWorkspaceProject(context: ProjectContext, input: TemplateUpgradeInput) {
  fields(input, ['requestId', 'expectedTemplateVersion', 'targetTemplateVersion']);
  if (typeof input.requestId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.requestId)
    || !['0.1.1', '0.2.0'].includes(input.expectedTemplateVersion) || input.targetTemplateVersion !== '0.2.0') fail('TEMPLATE_VERSION');
  current(context);
  // The Host already holds the shared Workspace lease. This inner project-file
  // transaction also protects direct module callers; it never starts a service.
  inspectProjectTemplate();
  const root=path.join(context.projectRoot,'.evopilot-template-upgrades');
  if(!exists(root)){fs.mkdirSync(root,{mode:0o700});synchronize(context.projectRoot);}
  directory(root);
  return withProjectLock(root,context.workspaceId,'workspace-template',()=>upgradeUnderLease(context,input));
}

function current(context:ProjectContext):void {
  context.assertCurrent?.();directory(context.projectRoot);directory(context.stateRoot);
  for(const other of [context.stateRoot,context.installationRoot]){
    canonicalPath(other);
    if(context.projectRoot===other||context.projectRoot.startsWith(other+path.sep)||other.startsWith(context.projectRoot+path.sep))fail('TEMPLATE_UPGRADE_IDENTITY');
  }
  const state=JSON.parse(readRegular(path.join(context.stateRoot,'workspace.json'),8192,true).toString());
  fields(state,['schema','id','canonicalRoot','ownerUid']);
  if(state.schema!=='evopilot-workspace/v1'||state.id!==context.workspaceId||state.canonicalRoot!==context.stateRoot||state.ownerUid!==process.getuid!())fail('TEMPLATE_UPGRADE_IDENTITY');
  const marker=JSON.parse(readRegular(path.join(context.projectRoot,'workspace-project.json'),8192,true).toString());
  fields(marker,['schema','id','templateVersion','specifications']);fields(marker.specifications,['ontology','harness']);
  if(marker.schema!=='evopilot-workspace-project/v1'||marker.id!==context.workspaceId||!['0.1.1','0.2.0'].includes(String(marker.templateVersion))||marker.specifications.ontology!=='v1'||marker.specifications.harness!=='v1')fail('TEMPLATE_SCHEMA');
}
function upgradeUnderLease(context:ProjectContext,input:TemplateUpgradeInput) {
  current(context);
  recoverPublication(context,input.requestId);
  directory(context.projectRoot);
  const markerPath = path.join(context.projectRoot, 'workspace-project.json');
  const markerBytes = readRegular(markerPath, 8192, true);
  const marker: unknown = JSON.parse(markerBytes.toString());
  fields(marker, ['schema', 'id', 'templateVersion', 'specifications']); fields(marker.specifications, ['ontology', 'harness']);
  if (marker.schema !== 'evopilot-workspace-project/v1' || marker.id !== context.workspaceId
    || !['0.1.1', '0.2.0'].includes(String(marker.templateVersion)) || marker.specifications.ontology !== 'v1'
    || marker.specifications.harness !== 'v1') fail('TEMPLATE_SCHEMA');
  const upgradedBytes = Buffer.from(JSON.stringify({ ...marker, templateVersion: '0.2.0' }, null, 2) + '\n');
  const template=inspectProjectTemplate(),files=template.files;
  // All existing destinations are validated before writes. Templates never replace user bytes.
  const created: string[] = [], customized: string[] = [], unchanged: string[] = [];
  for (const file of files) {
    parentDirectories(context.projectRoot, file.relative, false);
    const target = path.join(context.projectRoot, file.relative);
    if (!exists(target)) created.push(file.relative);
    else if (digest(readRegular(target)) === file.sha256) unchanged.push(file.relative);
    else customized.push(file.relative);
  }
  const recordRoot = path.join(context.projectRoot, '.evopilot-template-upgrades');
  if (exists(recordRoot)) directory(recordRoot);
  const planPath = path.join(recordRoot, input.requestId + '.json');
  const backupPath = path.join(recordRoot, input.requestId + '.workspace-project.json');
  const plan: UpgradePlan = { schema: 'runtime-template-upgrade/v1', requestId: input.requestId, workspaceId: context.workspaceId,
    templateDigest: template.digest, previousVersion: input.expectedTemplateVersion,
    targetVersion: '0.2.0', originalMarkerDigest: digest(markerBytes), upgradedMarkerDigest: digest(upgradedBytes),
    created, customized, unchanged, authority: false };
  let original = plan, reused = false;
  if (exists(planPath)) {
    const prior: unknown = JSON.parse(readRegular(planPath, 1024 * 1024, true).toString());
    fields(prior, Object.keys(plan));
    if (prior.schema !== plan.schema || prior.requestId !== input.requestId || prior.workspaceId !== context.workspaceId
      || prior.templateDigest !== plan.templateDigest || prior.previousVersion !== input.expectedTemplateVersion
      || prior.targetVersion !== input.targetTemplateVersion || prior.authority !== false
      || typeof prior.originalMarkerDigest !== 'string' || typeof prior.upgradedMarkerDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(prior.originalMarkerDigest) || !/^[a-f0-9]{64}$/.test(prior.upgradedMarkerDigest)) fail('TEMPLATE_UPGRADE_CONFLICT');
    const flattened: string[] = [];
    for (const key of ['created', 'customized', 'unchanged'] as const) {
      if (!Array.isArray(prior[key]) || prior[key].some(item => typeof item !== 'string' || !files.some(file => file.relative === item))) fail('TEMPLATE_UPGRADE_CONFLICT');
      flattened.push(...prior[key] as string[]);
    }
    if (flattened.length !== files.length || new Set(flattened).size !== files.length) fail('TEMPLATE_UPGRADE_CONFLICT');
    if (digest(readRegular(backupPath, 8192, true)) !== prior.originalMarkerDigest) fail('TEMPLATE_UPGRADE_CONFLICT');
    if (![prior.originalMarkerDigest, prior.upgradedMarkerDigest].includes(digest(markerBytes))) fail('TEMPLATE_UPGRADE_CONFLICT');
    original = prior as unknown as UpgradePlan; reused = true;
  } else if (marker.templateVersion !== input.expectedTemplateVersion) fail('TEMPLATE_VERSION_CONFLICT');

  current(context);
  if (digest(readRegular(markerPath, 8192, true)) !== digest(markerBytes)) fail('TEMPLATE_UPGRADE_CONFLICT');
  if (!exists(recordRoot)) { fs.mkdirSync(recordRoot, { mode: 0o700 }); synchronize(context.projectRoot); }
  directory(recordRoot);
  const stagingRoot = path.join(recordRoot, '.staging-' + input.requestId);
  if (!exists(stagingRoot)) { fs.mkdirSync(stagingRoot, { mode: 0o700 }); synchronize(recordRoot); }
  directory(stagingRoot);
  if (!reused) {
    if (exists(backupPath)) { if (digest(readRegular(backupPath, 8192, true)) !== original.originalMarkerDigest) fail('TEMPLATE_UPGRADE_CONFLICT'); }
    else createFile(backupPath, markerBytes, stagingRoot);
    createFile(planPath, Buffer.from(canonicalJSON(original) + '\n'), stagingRoot);
  }
  for (const relative of original.created) {
    current(context);
    const file = files.find(item => item.relative === relative)!;
    parentDirectories(context.projectRoot, relative, true);
    const target = path.join(context.projectRoot, relative);
    if (exists(target)) { if (digest(readRegular(target)) !== file.sha256) fail('TEMPLATE_UPGRADE_CONFLICT'); }
    else createFile(target, file.bytes, stagingRoot);
  }
  current(context);
  if (digest(readRegular(markerPath, 8192, true)) === original.originalMarkerDigest) {
    const newBytes = Buffer.from(JSON.stringify({ ...JSON.parse(readRegular(backupPath, 8192, true).toString()), templateVersion: '0.2.0' }, null, 2) + '\n');
    if (digest(newBytes) !== original.upgradedMarkerDigest) fail('TEMPLATE_UPGRADE_CONFLICT');
    const temporary = path.join(context.projectRoot, '.workspace-project-' + input.requestId + '.tmp');
    if (exists(temporary)) { if (digest(readRegular(temporary, 8192, true)) !== digest(newBytes)) fail('TEMPLATE_UPGRADE_CONFLICT'); }
    else createFile(temporary, newBytes, stagingRoot);
    fs.renameSync(temporary, markerPath); synchronize(context.projectRoot);
  }
  if (fs.readdirSync(stagingRoot).length === 0) { fs.rmdirSync(stagingRoot); synchronize(recordRoot); }
  return { ...original, status: original.previousVersion === '0.2.0' ? 'CURRENT' : 'UPGRADED', reused, markerBackupPath: backupPath,
    conflicts: original.customized.map(relative => ({ path: relative, resolution: 'PRESERVED_CUSTOMIZED' })), authority: false as const };
}
