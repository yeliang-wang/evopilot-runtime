import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { evaluateV010 } from '../../scripts/roadmap-v010.mjs';
import { verifyV010AcceptanceCoverage } from '../../scripts/release-gate-v010.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = name => JSON.parse(readFileSync(new URL('../../governance/' + name, import.meta.url)));
const inventory = read('acceptance-v010.json');
const boundary = read('roadmap-v010.json').acceptanceBoundary;

function exampleReport() {
  return {
    liveEntry: 'codex-expert',
    deferred: ['CHANNEL-REAL'],
    cases: inventory.cases.filter(row => row.phase === 'pre').map(row => ({
      id: row.id, status: 'PASS', evidenceKind: row.verification, artifacts: [{}],
    })),
  };
}

test('only installed Codex Expert usage is live before release and after public download', () => {
  assert.equal(evaluateV010(root, { mode: 'check' }).status, 'VALID');
  const live = inventory.cases.filter(row => row.verification === 'CODEX_DESKTOP_E2E');
  assert.deepEqual(live.map(row => [row.id, row.phase]), [['EXPERT-REAL', 'pre'], ['FRESH-REPLAY', 'post']]);
  assert.equal(evaluateV010(root, { mode: 'release' }).releaseAuthorized, false);
  verifyV010AcceptanceCoverage(exampleReport(), inventory, boundary);
});

test('release review rejects missing checks, misclassified Expert evidence and unapproved live provider evidence', () => {
  for (const { change, reason } of [
    { change: report => report.cases.shift(), reason: /deep-equal/ },
    { change: report => report.cases[0].evidenceKind = 'LOCAL_AUTOMATED', reason: /EXPERT-REAL/ },
    { change: report => report.cases.find(row => row.id === 'AGENT-ACTUAL').evidenceKind = 'CODEX_DESKTOP_E2E', reason: /AGENT-ACTUAL/ },
    { change: report => report.cases.find(row => row.id === 'DOCS-CI').status = 'SKIP', reason: /DOCS-CI/ },
    { change: report => report.cases[0].artifacts = [], reason: /EXPERT-REAL/ },
    { change: report => report.liveEntry = 'callback-reference', reason: /codex-expert/ },
  ]) {
    const report = exampleReport();
    change(report);
    assert.throws(() => verifyV010AcceptanceCoverage(report, inventory, boundary), reason);
  }
});
