/** Runtime-owned compatibility migrated from EvoPilot 0.8.3. See provenance/project-compatibility.json. */
import {validateReadinessIntent, type ReadinessIntent} from '../../../vendor/compatibility/usability/v2/contract.mjs';
import {nativeAssertJSON, nativeExact, nativeSha256, nativeText, nativeFrozenClone} from '../../../vendor/compatibility/v1/native.mjs';
import {verifyDecisionEvidence} from '../../../vendor/compatibility/v1/decision-evidence.mjs';
import {USABILITY_STANDARD_DIGEST, BEHAVIOR_FACETS, type UsabilityLevel} from '../../../vendor/usability/v1/contract.mjs';
import type {NativeScope} from '../../native-types.js';

export const MODELING_PROFILES = Object.freeze({
  L1: {includes: [], content: ['domain questions', 'concepts', 'relations', 'constraints', 'sources', 'gaps']},
  L2: {includes: ['L1'], content: [...BEHAVIOR_FACETS]},
  L3: {includes: ['L1', 'L2'], content: ['specification-only input', 'independent oracle', 'two clean attempts', 'environment and limits']},
});
export interface ModelingIntentDefinition {
  schema: 'evopilot-modeling-intent/v1'; workspaceId: string; scope: NativeScope;
  source: {root: string; direction: 'reverse'; revision: string};
  purpose: string; useCase: 'understand'|'implement'|'reconstruct'; functionalScope: string; exclusions: string[];
  targetLevel: UsabilityLevel; standardDigest: string; requirementsDigest: string;
  acceptance: {criterionId: string; variantIds: string[]; expected: string}[];
  questions: string[]; behaviors: string[]; unresolvedQuestions: string[];
  reconstruction: {inputMode: 'SPECIFICATION_ONLY'; independentAttempts: 2; oraclePlan: string; environment: string}|null;
  userIntentOrigin: 'explicit-request'|'retained-context';
}
export interface ModelingIntentV1 {definition: ModelingIntentDefinition; humanEvidenceRef: string}
export interface ModelingIntentV2 {definition: ReadinessIntent; humanEvidenceRef:string}
export type ModelingIntent=ModelingIntentV1|ModelingIntentV2;
export interface ModelingIntentContext {
  workspaceId: string; scope: NativeScope; sourceRoot: string; revision: string;
  direction?:'forward'|'reverse';sourceDigest?:string;
  requirements: {ownerRequirements: {criterionId: string; variantIds: string[]}[]};
}
function fail(code: string, message: string): never {throw Object.assign(new Error(message),{code});}
const same=(a: unknown,b: unknown)=>nativeSha256(a)===nativeSha256(b);
function strings(value: unknown, nonempty=false): asserts value is string[] {
  if(!Array.isArray(value)||value.length>256||(nonempty&&!value.length))fail('MODELING_INTENT_INVALID','A bounded explicit inventory is required');
  for(const item of value)nativeText(item);
  if(new Set(value).size!==value.length)fail('MODELING_INTENT_INVALID','Duplicate inventory entries');
}
/** Admission checks evidence binding and completeness, never semantic truth or a verified level. */
export function assertModelingIntent(value: unknown, context: ModelingIntentContext): ModelingIntent {
  try {
    if(value&&typeof value==='object'&&'definition' in value&&(value.definition as {schema?:string})?.schema==='evopilot-modeling-intent/v2')return validateModelingIntentV2(value,context);
    return validateModelingIntent(value,context);
  }
  catch(error) {
    if(error instanceof TypeError)fail('MODELING_INTENT_INVALID','Complete the required modeling intent profile and evidence binding');
    throw error;
  }
}
function validateModelingIntent(value: unknown, context: ModelingIntentContext): ModelingIntent {
  if(value===undefined||value===null)fail('MODELING_INTENT_REQUIRED','Resolve purpose, scope, target level and acceptance before formal reverse modeling');
  nativeAssertJSON(value);nativeExact(value,['definition','humanEvidenceRef']);
  const d=value.definition;
  nativeExact(d,['schema','workspaceId','scope','source','purpose','useCase','functionalScope','exclusions','targetLevel','standardDigest','requirementsDigest','acceptance','questions','behaviors','unresolvedQuestions','reconstruction','userIntentOrigin']);
  if(d.schema!=='evopilot-modeling-intent/v1'||!Object.hasOwn(MODELING_PROFILES,String(d.targetLevel)))fail('MODELING_INTENT_INVALID','Supported modeling profile required');
  for(const key of ['purpose','functionalScope','workspaceId'] as const)nativeText(d[key]);
  strings(d.exclusions);strings(d.questions,true);strings(d.behaviors);strings(d.unresolvedQuestions);
  if(d.unresolvedQuestions.length)fail('MODELING_INTENT_AMBIGUOUS','Resolve mandatory intent questions before modeling');
  if(!['explicit-request','retained-context'].includes(String(d.userIntentOrigin)))fail('MODELING_INTENT_INVALID','Traceable user intent origin required');
  const minimum={understand:1,implement:2,reconstruct:3} as const;
  if(!Object.hasOwn(minimum,String(d.useCase))||Number(String(d.targetLevel).slice(1))<minimum[d.useCase as keyof typeof minimum])fail('MODELING_INTENT_LEVEL','Target level does not meet the stated use');
  nativeExact(d.source,['root','direction','revision']);
  if(d.workspaceId!==context.workspaceId||!same(d.scope,context.scope)||!same(d.source,{root:context.sourceRoot,direction:'reverse',revision:context.revision})||d.requirementsDigest!==nativeSha256(context.requirements)||d.standardDigest!==USABILITY_STANDARD_DIGEST)fail('MODELING_INTENT_STALE','Source, scope, standard or requirements changed; a new intent binding is required');
  if(!Array.isArray(d.acceptance)||!d.acceptance.length||d.acceptance.length>256)fail('MODELING_INTENT_INVALID','Fixed acceptance inventory required');
  const pairs:string[]=[];
  for(const row of d.acceptance){nativeExact(row,['criterionId','variantIds','expected']);nativeText(row.criterionId);nativeText(row.expected);strings(row.variantIds,true);for(const variant of row.variantIds)pairs.push(String(row.criterionId)+'\0'+variant);}
  const expected=context.requirements.ownerRequirements.flatMap(r=>r.variantIds.map(v=>r.criterionId+'\0'+v)).sort();
  if(new Set(pairs).size!==pairs.length||!same(pairs.sort(),expected))fail('MODELING_INTENT_ACCEPTANCE','Acceptance must retain the complete independent requirement inventory');
  if(d.targetLevel!=='L1'&&!d.behaviors.length)fail('MODELING_INTENT_INVALID','Implementation and reconstruction require a behavior inventory');
  if(d.targetLevel==='L3'){
    nativeExact(d.reconstruction,['inputMode','independentAttempts','oraclePlan','environment']);
    if(d.reconstruction.inputMode!=='SPECIFICATION_ONLY'||d.reconstruction.independentAttempts!==2)fail('MODELING_INTENT_INVALID','L3 requires two independent specification-only attempts');
    nativeText(d.reconstruction.oraclePlan);nativeText(d.reconstruction.environment);
  }else if(d.reconstruction!==null)fail('MODELING_INTENT_INVALID','Reconstruction configuration belongs to an L3 target');
  nativeText(value.humanEvidenceRef);
  verifyDecisionEvidence(value.humanEvidenceRef,{owner:'project',operation:'modeling.intent',workspaceId:context.workspaceId,scope:context.scope,reviewDigest:nativeSha256(d),decision:'ACCEPT'});
  return nativeFrozenClone(value) as unknown as ModelingIntent;
}

function validateModelingIntentV2(value:unknown,context:ModelingIntentContext):ModelingIntentV2 {
  nativeExact(value,['definition','humanEvidenceRef']);const d=validateReadinessIntent(value.definition);
  if(d.workspaceId!==context.workspaceId||!same(d.scope,context.scope)||!d.sources.some(s=>s.reference===context.sourceRoot&&s.revision===context.revision&&(!context.sourceDigest||s.digest===context.sourceDigest)))fail('MODELING_INTENT_STALE','The fixed source and scope must match the v2 intent');
  if((context.direction??'reverse')==='reverse'?d.mode!=='SOURCE_REVERSE':d.mode==='SOURCE_REVERSE')fail('MODELING_INTENT_INVALID','The modeling mode must match the source direction');
  if(context.requirements.ownerRequirements.some(r=>!d.requirements.some(q=>q.id===r.criterionId&&same([...(q.acceptanceVariants??[])].sort(),[...r.variantIds].sort()))))fail('MODELING_INTENT_ACCEPTANCE','Every fixed native requirement and variant must remain in the v2 inventory');
  nativeText(value.humanEvidenceRef);verifyDecisionEvidence(value.humanEvidenceRef,{owner:'runtime',operation:'readiness.intent.record',workspaceId:context.workspaceId,scope:context.scope,reviewDigest:nativeSha256(d),decision:'ACCEPT'});
  return nativeFrozenClone({definition:d,humanEvidenceRef:value.humanEvidenceRef});
}
