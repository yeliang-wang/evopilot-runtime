/** Runtime-owned compatibility migrated from EvoPilot 0.8.3. See provenance/project-compatibility.json. */
import path from 'node:path';
import { fail } from './files.js';

export interface CampaignEvidencePin { root: 'project' | 'state'; path: string; sha256: string }
export interface CampaignCriterion { id: string; status: 'PASS' | 'FAIL' | 'PENDING' | 'UNKNOWN'; evidence: CampaignEvidencePin[] }
export interface CampaignLoop { id: string; observation: string; action: string; result: string }
export interface CampaignInput {
  projectId: string; id: string; goal: string; sourceDigest: string;
  criteria: CampaignCriterion[]; loops: CampaignLoop[]; status: 'IN_PROGRESS' | 'COMPLETE';
}
export interface CampaignDocument extends CampaignInput { schema: 'evopilot-private-campaign/v1'; authority: false }
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).sort().join('|') !== keys.sort().join('|')) fail('PROJECT_SCHEMA');
}
function slug(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) fail('PROJECT_ID');
  return value;
}
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 8192;

/** Shared structure for writer and retained reference reader. No authority or freshness inferred. */
export function validateCampaignInput(value: unknown): asserts value is CampaignInput {
  exact(value, ['projectId', 'id', 'goal', 'sourceDigest', 'criteria', 'loops', 'status']);
  const projectId = slug(value.projectId); slug(value.id);
  if (!text(value.goal) || typeof value.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceDigest)
    || !Array.isArray(value.criteria) || !value.criteria.length || value.criteria.length > 100
    || !Array.isArray(value.loops) || value.loops.length > 200 || !['IN_PROGRESS', 'COMPLETE'].includes(String(value.status))) fail('CAMPAIGN_SCHEMA');
  const loops = new Set<string>(), criteria = new Set<string>();
  for (const loop of value.loops) {
    exact(loop, ['id', 'observation', 'action', 'result']); const id = slug(loop.id);
    if (loops.has(id) || !text(loop.observation) || !text(loop.action) || !text(loop.result)) fail('CAMPAIGN_LOOP');
    loops.add(id);
  }
  for (const criterion of value.criteria) {
    exact(criterion, ['id', 'status', 'evidence']); const id = slug(criterion.id);
    if (criteria.has(id) || !['PASS', 'FAIL', 'PENDING', 'UNKNOWN'].includes(String(criterion.status)) || !Array.isArray(criterion.evidence) || criterion.evidence.length > 100) fail('CAMPAIGN_CRITERION');
    criteria.add(id);
    if (criterion.status === 'PASS' && !criterion.evidence.length) fail('CAMPAIGN_EVIDENCE_REQUIRED');
    if (value.status === 'COMPLETE' && criterion.status !== 'PASS') fail('CAMPAIGN_INCOMPLETE');
    for (const evidence of criterion.evidence) {
      exact(evidence, ['root', 'path', 'sha256']);
      if (!['project', 'state'].includes(String(evidence.root)) || typeof evidence.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.sha256)) fail('CAMPAIGN_EVIDENCE');
      const relative = evidence.path;
      if (typeof relative !== 'string' || !relative || relative.length > 1024 || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..' || p === '.git')) fail('PROJECT_PATH');
      if (!relative.startsWith('public/') && !relative.startsWith('private/projects/' + projectId + '/')) fail('CAMPAIGN_EVIDENCE_SCOPE');
      if (relative.split('/').some(part => part.startsWith('.') || /\.db(?:-(?:wal|shm|journal))?$/.test(part))) fail('CAMPAIGN_EVIDENCE_SCOPE');
    }
  }
}
export function validateCampaignDocument(value: unknown): asserts value is CampaignDocument {
  exact(value, ['schema', 'projectId', 'id', 'goal', 'sourceDigest', 'criteria', 'loops', 'status', 'authority']);
  if (value.schema !== 'evopilot-private-campaign/v1' || value.authority !== false) fail('CAMPAIGN_SCHEMA');
  const { schema: _schema, authority: _authority, ...input } = value;
  validateCampaignInput(input);
}
