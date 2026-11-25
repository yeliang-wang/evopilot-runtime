import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const read = ref => JSON.parse(readFileSync(ref, 'utf8'));
const check = (status, reason) => ({ status, reasons: [reason], productAcceptance: 'NOT_EVALUATED', releaseAuthorized: false });
const required = {
  M1: ['EXPERT-REAL', 'DASH-01'],
  M2: ['CHANNEL-REAL', 'CHANNEL-REFERENCE', 'NEEDS-INFO'],
  M3: ['AGENT-ACTUAL', 'VERIFY-REPAIR'],
  M4: ['TIMED-MERGE', 'VETO-RACE'],
  M5: ['UNKNOWN-RECOVERY', 'LOOP-INTEGRATED', 'DASH-02'],
  M6: ['DOCS-CI', 'PUBLIC-READBACK', 'FRESH-REPLAY'],
};

function privateJSON(ref) {
  assert(path.isAbsolute(ref) && realpathSync(ref) === ref, 'Canonical authorization path required');
  const info = lstatSync(ref);
  assert(info.isFile() && info.nlink === 1 && info.size <= 131072 && info.uid === process.getuid() &&
    !(info.mode & 0o077), 'Authorization must be an owner-only regular file');
  return read(ref);
}

export function evaluateV010(root, request) {
  try {
    const targetPath = path.join(root, 'governance/target-v010.json');
    const target = read(targetPath);
    const roadmap = read(path.join(root, 'governance/roadmap-v010.json'));
    const inventory = read(path.join(root, 'governance/acceptance-v010.json'));
    assert.equal(roadmap.schema, 'runtime-roadmap/v2');
    assert.equal(roadmap.owner, 'runtime');
    assert.equal(target.schema, 'evopilot-evolution-target/v1');
    assert.equal(target.id, 'runtime-v010-feedback-loop');
    assert.equal(target.targetVersion, '0.10.0');
    assert.equal(roadmap.targetVersion, target.targetVersion);
    assert.equal(inventory.scope, target.targetVersion);
    assert.equal(roadmap.baseline, target.sourceBaseline);
    for (const [file, expected] of Object.entries(target.pins)) {
      assert.match(file, /^(governance|docs)\/[a-z0-9/.-]+$/);
      assert(!file.split('/').includes('..'));
      assert.equal(digest(readFileSync(path.join(root, file))), expected, 'Frozen contract changed: ' + file);
    }
    for (const file of ['governance/roadmap-v010.json','governance/acceptance-v010.json','docs/architecture/runtime-v010-feedback-loop.md','docs/runtime-v010-preview-plan.md']) {
      assert(Object.hasOwn(target.pins, file), 'Missing required contract pin: ' + file);
    }
    assert.equal(target.roadmapDigest, target.pins['governance/roadmap-v010.json']);
    assert.deepEqual(roadmap.milestones, Object.keys(required));
    assert.deepEqual(Object.keys(target.workPackets), Object.keys(required));
    assert.deepEqual(inventory.cases.map(entry => entry.id), Object.values(required).flat());
    for (const [milestone, ids] of Object.entries(required)) {
      assert.deepEqual(inventory.cases.filter(entry => entry.milestone === milestone).map(entry => entry.id), ids);
      assert.deepEqual(target.workPackets[milestone].acceptance, ids);
    }
    assert.deepEqual(inventory.cases.filter(entry => entry.phase === 'deferred').map(entry => entry.id), ['CHANNEL-REAL']);
    assert.deepEqual(roadmap.acceptanceBoundary.deferred, ['CHANNEL-REAL']);
    assert.deepEqual(inventory.cases.filter(entry => entry.phase === 'post').map(entry => entry.id), ['PUBLIC-READBACK','FRESH-REPLAY']);
    assert.deepEqual(Object.keys(inventory.design).sort(), ['DASH-01', 'DASH-02']);
    for (const value of Object.values(inventory.design)) assert.match(value, /^[a-f0-9]{64}$/);
    if (request.mode === 'check') return check('VALID', 'Exact v0.10 scope and acceptance inventory are consistent.');
    if (request.mode === 'release') return check('BLOCKED', 'Exact candidate and authenticated release decision remain required.');
    if (request.mode !== 'gate') return check('UNKNOWN', 'Use check, release or gate.');
    const match = /^runtime-v0\.10\/(M[1-6]):\s*\S.+$/.exec(request.intent ?? '');
    if (!match) return check('UNKNOWN', 'Use runtime-v0.10/Mn: concrete intent.');
    if (!request.authorization || !request.files?.length) return check('BLOCKED', 'Exact files and the private approval binding are required.');
    const approval = privateJSON(request.authorization);
    assert.equal(approval.schema, 'runtime-v010-implementation-authorization/v1');
    assert.equal(approval.decision, 'IMPLEMENT');
    assert.equal(approval.targetId, target.id);
    assert.equal(approval.targetDigest, digest(readFileSync(targetPath)));
    assert.equal(approval.releaseAuthorized, false);
    assert(approval.milestones.includes(match[1]), 'Milestone is outside the implementation grant');
    const origin = privateJSON(approval.reviewTurn.ref);
    assert.equal(digest(readFileSync(approval.reviewTurn.ref)), approval.reviewTurn.sha256);
    assert.equal(origin.message.type, 'userMessage');
    assert.equal(origin.message.id, approval.approvedMessageId);
    assert.equal(origin.review.id, approval.reviewMessageId);
    assert.equal(origin.message.content.map(item => item.text).join('').trim(), '确认，请开始执行');
    const deferral = privateJSON(approval.slackDeferral.ref);
    assert.equal(digest(readFileSync(approval.slackDeferral.ref)), approval.slackDeferral.sha256);
    const change = deferral.items.find(item => item.id === approval.slackDeferral.messageId);
    assert.equal(change?.type, 'userMessage');
    assert(change.content.some(item => item.text.includes('没有Slack 测试频道，可以直接跳过这部分的E2E。')));
    for (const file of request.files) {
      if (!target.workPackets[match[1]].paths.includes(file)) return check('BOUNDARY_CHANGE', 'Outside exact work packet: ' + file);
    }
    return check('ALIGNED', 'Exact file scope aligned; product acceptance and release remain separate.');
  } catch (error) {
    return check('DEVIATION', error instanceof Error ? error.message : 'Invalid governance.');
  }
}

export function mainV010(root, argv) {
  const request = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') continue;
    if (['--gate','--release','--check'].includes(arg) && !request.mode) request.mode = arg.slice(2);
    else if (arg === '--version' && argv[i+1] === '0.10.0') i++;
    else if (['--intent','--file','--authorization'].includes(arg) && argv[i+1] && !argv[i+1].startsWith('--')) {
      const value = argv[++i];
      if (arg === '--file') request.files.push(value);
      else request[arg.slice(2)] = value;
    } else return output(check('UNKNOWN','Invalid v0.10 gate arguments.'));
  }
  return output(evaluateV010(root, request));
}
function output(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = ['ALIGNED','VALID'].includes(result.status) ? 0 : 1;
}
