import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

type RecordValue = Record<string, unknown>;
export type GateStatus = 'ALIGNED' | 'VALID' | 'UNKNOWN' | 'DEVIATION' | 'BOUNDARY_CHANGE' | 'BLOCKED';
export interface GateResult {
  status: GateStatus;
  reasons: string[];
  productAcceptance: 'NOT_EVALUATED';
  releaseAuthorized: false;
}
const result = (status: GateStatus, ...reasons: string[]): GateResult => ({ status, reasons, productAcceptance: 'NOT_EVALUATED', releaseAuthorized: false });
const fail = (message: string): never => { throw new Error(message); };
const object = (v: unknown): RecordValue => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fail('Expected object');
  return v as RecordValue;
};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : fail('Expected array');
const text = (v: unknown): string => typeof v === 'string' && v.length > 0 ? v : fail('Expected nonempty string');
export const governanceDigest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const ids = (v: unknown): string[] => list(v).map(item => text(object(item).id));
const sameIds = (actual: string[], expected: string[], label: string): void => {
  if (new Set(actual).size !== actual.length || [...actual].sort().join(',') !== [...expected].sort().join(',')) fail(label);
};
const numbered = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, i) => prefix + String(i + 1).padStart(2, '0'));

/** Structural acceptance consistency only; no test outcome is inferred. */
export function validateAcceptanceCatalog(value: unknown): void {
  const catalog = object(value);
  if (catalog.schema !== 'runtime-v090-acceptance-catalog/v1') fail('Unknown acceptance schema');
  const requirements = [...numbered('L', 16), ...numbered('D', 8), ...numbered('S', 8), ...numbered('I', 6), ...numbered('P', 4), ...numbered('X', 8), ...numbered('N', 14)];
  sameIds(ids(catalog.requirements), requirements, 'Required acceptance groups changed');
  const scenarios = list(catalog.scenarios).map(object);
  sameIds(ids(scenarios), numbered('E', 22), 'Required scenarios changed');
  const covered = new Set<string>();
  const pre = new Set<string>();
  for (const scenario of scenarios) {
    const id = text(scenario.id);
    const expectedPhase = ['E21', 'E22'].includes(id) ? 'POST_RELEASE' : 'PRE_RELEASE';
    if (scenario.phase !== expectedPhase || scenario.required !== true) fail('Invalid required scenario phase: ' + id);
    if (!list(scenario.steps).length || !list(scenario.requiredEvidence).length) fail('Missing steps/evidence: ' + id);
    text(scenario.expected);
    const groups = list(scenario.groups).map(text);
    if (!groups.length || new Set(groups).size !== groups.length) fail('Empty or duplicate groups: ' + id);
    for (const group of groups) {
      if (!requirements.includes(group)) fail('Unknown requirement: ' + group);
      if ((group === 'P03' && id !== 'E21') || (group === 'P04' && id !== 'E22')) fail('Post-release requirement mapped before actual delivery: ' + group);
      covered.add(group);
      if (scenario.phase === 'PRE_RELEASE') pre.add(group);
    }
  }
  sameIds([...covered], requirements, 'Unmapped requirements');
  sameIds([...pre], requirements.filter(id => !['P03', 'P04'].includes(id)), 'Pre-release denominator must be 62');
  for (const [key, prefix, count, reverseKey] of [
    ['extensions', 'EX', 12, 'requiredExtensionSubcases'],
    ['closure', 'MC', 6, 'requiredMinimalClosureVariants'],
    ['coverage', 'CV', 8, 'requiredCoverageVariants'],
  ] as const) {
    const variants = list(catalog[key]).map(object);
    sameIds(ids(variants), numbered(prefix, count), 'Missing mandatory ' + key);
    for (const variant of variants) {
      if (variant.required !== true) fail('Variant made optional');
      const forward = list(variant.mainCases ?? variant.cases).map(text);
      const reverse = scenarios.filter(c => list(c[reverseKey] ?? []).includes(variant.id)).map(c => text(c.id));
      sameIds(forward, reverse, 'Variant mapping differs: ' + text(variant.id));
    }
    for (const scenario of scenarios) {
      for (const id of list(scenario[reverseKey] ?? []).map(text)) if (!ids(variants).includes(id)) fail('Unknown variant: ' + id);
    }
  }
}

function readBoundedJson(path: string): { bytes: Buffer; value: RecordValue } {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) fail('Invalid governance input file');
  const bytes = readFileSync(path);
  return { bytes, value: object(JSON.parse(bytes.toString('utf8')) as unknown) };
}

/** Additive engineering coverage; does not gate a consuming project's reports. */
export function validateTokenUsageAddendum(value:unknown):void {
  const addendum=object(value),acceptance=object(addendum.acceptance);
  if(addendum.schema!=='runtime-token-usage-addendum/v1'||addendum.id!=='v090-token-usage'||addendum.owner!=='runtime'||addendum.targetVersion!=='0.9.0')fail('Wrong token usage addendum');
  sameIds(list(addendum.baseStages).map(text),['scope','plan','implementation','candidate','verification','release-decision','publication','closure'],'Usage must reuse the eight Base stages');
  if(acceptance.originalRequiredInstances!==664||acceptance.originalPreRelease!==655||acceptance.originalPostRelease!==9||acceptance.additionalPreRelease!==23||acceptance.additionalPostRelease!==1||acceptance.combinedRequiredInstances!==688)fail('Usage addendum cannot replace or shrink original acceptance');
  if(acceptance.collector!=='tests/acceptance/v090/usage.test.mjs')fail('Usage collector binding differs');
  const cases=list(acceptance.cases).map(object);sameIds(ids(cases),numbered('UT',24),'Missing token usage acceptance instances');
  for(const c of cases){if(c.required!==true||c.phase!==(c.id==='UT24'?'POST_RELEASE':'PRE_RELEASE'))fail('Usage acceptance phase/requirement differs');text(c.expected);}
  if(!list(addendum.requiredBehavior).length||!list(addendum.exclusions).length)fail('Usage behavior and boundary must be explicit');
}

export interface GovernanceRequest {
  mode: 'check' | 'gate' | 'release';
  intent?: string;
  authorization?: string;
  files?: string[];
}

export function evaluateGovernance(root: string, request: GovernanceRequest): GateResult {
  try {
    const roadmap = readBoundedJson(resolve(root, 'governance/roadmap.json'));
    const target = readBoundedJson(resolve(root, 'governance/target-v090.json'));
    const acceptance = readBoundedJson(resolve(root, 'governance/acceptance-v090.json'));
    if (roadmap.value.schema !== 'runtime-roadmap/v1' || target.value.schema !== 'evopilot-evolution-target/v1') fail('Unknown governance schema');
    if (roadmap.value.owner !== 'runtime' || target.value.id !== 'runtime-v090-independent-lifecycle' || roadmap.value.targetVersion !== '0.9.0' || target.value.targetVersion !== '0.9.0') fail('Wrong owner/target/version');
    if (target.value.roadmapDigest !== governanceDigest(roadmap.bytes)) fail('Roadmap digest drift requires review');
    const acceptanceDigest = governanceDigest(acceptance.bytes);
    if (target.value.acceptanceDigest !== acceptanceDigest || roadmap.value.acceptanceDigest !== acceptanceDigest) fail('Acceptance digest drift requires review');
    validateAcceptanceCatalog(acceptance.value);
    const usage=readBoundedJson(resolve(root,'governance/token-usage-v090.json'));validateTokenUsageAddendum(usage.value);
    const usageDigest=governanceDigest(usage.bytes);
    for(const owner of [roadmap.value,target.value]){
      const entries=list(owner===roadmap.value?owner.addenda:owner.approvedAddenda).map(object);sameIds(ids(entries),['v090-token-usage'],'Usage addendum must remain declared');
      const a=entries[0];if(a.contract!=='governance/token-usage-v090.json'||a.contractDigest!==usageDigest||a.implementationRequired!==true||a.originalAcceptanceUnchanged!==true||a.additionalRequiredInstances!==24||a.releaseAuthorityUnchanged!==true)fail('Usage addendum binding drift');
    }
    if(object(target.value.implementationBindings)['governance/token-usage-v090.json']!==usageDigest)fail('Usage implementation binding missing');
    if (target.value.implementationBindings) {
      for (const [path, digest] of Object.entries(object(target.value.implementationBindings))) {
        if (!/^governance\/[a-z0-9-]+\.json$/.test(path)) fail('Unsafe implementation binding path');
        if (governanceDigest(readBoundedJson(resolve(root, path)).bytes) !== digest) fail('Implementation binding drift: ' + path);
      }
      const matrix = readBoundedJson(resolve(root, 'governance/parameter-matrix-v090.json')).value;
      const fields = readBoundedJson(resolve(root, 'governance/lifecycle-contract-v090.json'));
      const environment = readBoundedJson(resolve(root, 'governance/environment-contract-v090.json')).value;
      if(environment.packageLockDigest !== governanceDigest(readBoundedJson(resolve(root,'package-lock.json')).bytes))fail('Pinned package lock changed');
      const cases = list(matrix.caseInstances).map(object);
      if (matrix.schema !== 'runtime-v090-parameter-matrix/v1' || matrix.status !== 'FROZEN_IMPLEMENTATION_BASELINE' || matrix.sourceAcceptanceDigest !== acceptanceDigest || matrix.fieldContractDigest !== governanceDigest(fields.bytes)) fail('Parameter matrix binding mismatch');
      if (matrix.count !== cases.length || new Set(cases.map(c => text(c.caseInstanceId))).size !== cases.length) fail('Parameter denominator mismatch');
      for (const c of cases) {
        const id = text(c.scenario);
        if (!numbered('E', 22).includes(id) || c.required !== true || c.phase !== (['E21','E22'].includes(id) ? 'POST_RELEASE' : 'PRE_RELEASE')) fail('Invalid required parameter instance');
        if (c.collector !== 'tests/acceptance/v090/' + id.toLowerCase() + '.test.mjs') fail('Parameter collector mismatch');
        text(c.expected);
      }
      const caseIds=new Set(cases.map(c=>text(c.caseInstanceId)));
      for(const scenario of list(acceptance.value.scenarios).map(object)) {
        const id=text(scenario.id);
        if(!caseIds.has(id+'.journey'))fail('Primary scenario missing from parameters');
        for(let i=0;i<list(scenario.requiredVariants??[]).length;i++)if(!caseIds.has(id+'.variant.'+String(i+1).padStart(2,'0')))fail('Required scenario variant missing from parameters');
      }
      for(const key of ['extensions','closure','coverage'])for(const variant of list(acceptance.value[key]).map(object))for(const id of list(variant.mainCases??variant.cases).map(text))if(!caseIds.has(id+'.'+text(variant.id)))fail('Required EX/MC/CV parameter missing');
      for (const field of list(fields.value.fields).map(object)) for (const provider of list(field.providers).map(text)) for (const fault of ['missing','invalid-value']) {
        if (!cases.some(c => c.caseInstanceId === 'E03.field.' + provider + '.' + text(field.id) + '.' + fault)) fail('Required field case missing');
      }
    }
    sameIds(ids(roadmap.value.milestones), ['M0','M1','M2','M3','M4','M5','M6'], 'Roadmap milestones changed');
    sameIds(list(target.value.milestones).map(text), ['M0','M1','M2','M3','M4','M5','M6'], 'Target milestones changed');
    if (request.mode === 'check') return result('VALID', 'Scope and coverage structure are consistent; product results are not evaluated.');
    if (request.mode === 'release') return result('BLOCKED', 'Governance structure is valid, but this scope-only command has no exact candidate evidence or authenticated release decision. Prepare the native review with node scripts/release-gate.mjs preflight <private-input.json> <new-private-output>; the trusted local publication entry rechecks this governance and verifies the existing exact release decision. No CLI flag or implementation authorization grants publication.');
    const match = /^runtime-v0\.9\/(M[0-6]):\s*\S.+$/.exec(request.intent ?? '');
    if (!match) return result('UNKNOWN', 'Use a scoped runtime-v0.9/Mn: concrete intent.');
    const packet = object(target.value.workPackets)[match[1]];
    if (!packet) return result('BLOCKED', 'Milestone work packet and prerequisite evidence have not been frozen.');
    if (!request.authorization) return result('BLOCKED', 'Actual implementation decision reference is required.');
    const authority = readBoundedJson(request.authorization).value;
    if (authority.schema !== 'runtime-evolution-authorization/v1' || authority.decision !== 'IMPLEMENT' || authority.targetId !== target.value.id || authority.targetDigest !== governanceDigest(target.bytes) || authority.approvedPlanDigest !== target.value.approvedPlanDigest) fail('Authorization binding mismatch');
    if(authority.addendumDigest!==usageDigest)fail('User-requested usage addendum authorization binding differs');
    if (!list(authority.implementationMilestones).includes(match[1])) return result('BLOCKED', 'Milestone is not covered by this implementation binding.');
    if (!request.files?.length) return result('BLOCKED', 'Exact proposed file paths are required.');
    const permitted = list(object(packet).paths).map(text);
    for (const file of request.files) {
      if (isAbsolute(file) || file.includes('\\') || file.split('/').some(p => !p || p === '.' || p === '..') || !permitted.includes(file)) return result('BOUNDARY_CHANGE', 'File outside the frozen work packet: ' + file);
    }
    return result('ALIGNED', 'Only the requested files in ' + match[1] + ' align; a decision-file hash is not human authentication, product acceptance, or release authority.');
  } catch (error) {
    return result('DEVIATION', error instanceof Error ? error.message : 'Governance validation failed');
  }
}

export function governanceMain(root: string, argv: string[]): void {
  try {
    let mode: GovernanceRequest['mode'] | undefined;
    const request: GovernanceRequest = { mode: 'check', files: [] };
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (['--check', '--gate', '--release'].includes(arg)) {
        if (mode) fail('Choose one mode');
        mode = arg.slice(2) as GovernanceRequest['mode']; request.mode = mode;
      } else if (arg === '--intent' || arg === '--authorization' || arg === '--file') {
        const value = argv[++i]; if (!value || value.startsWith('--')) fail('Missing argument');
        if (arg === '--file') request.files!.push(value);
        else if (arg === '--intent') request.intent = value;
        else request.authorization = value;
      } else if (arg !== '--json') fail('Unknown argument');
    }
    if (!mode) fail('Mode required');
    const outcome = evaluateGovernance(root, request);
    process.stdout.write(JSON.stringify(outcome) + '\n');
    process.exitCode = ['ALIGNED', 'VALID'].includes(outcome.status) ? 0 : 1;
  } catch (error) {
    process.stdout.write(JSON.stringify(result('UNKNOWN', error instanceof Error ? error.message : 'Invalid request')) + '\n');
    process.exitCode = 1;
  }
}
