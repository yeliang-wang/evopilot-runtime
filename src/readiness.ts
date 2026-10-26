import {nativeSha256,nativeFrozenClone,nativeDigest,nativeText,nativeStableSerialize} from '../vendor/compatibility/v1/native.mjs';
import {verifyDecisionEvidence} from '../vendor/compatibility/v1/decision-evidence.mjs';
import {createFeedbackStore,feedbackScope,feedbackBounded} from '../vendor/compatibility/feedback/v1/feedback.mjs';
import type {FeedbackEnvelope} from '../vendor/compatibility/feedback/v1/feedback.mjs';
import {readinessExact as nativeExact,READINESS_STANDARD,READINESS_STANDARD_DIGEST,validateReadinessIntent,boundedReadiness,assertReadinessVersion,readinessFail as fail,readinessId} from '../vendor/compatibility/usability/v2/contract.mjs';
import type {ReadinessIntent,ReadinessIntentRecord,ReadinessResult} from '../vendor/compatibility/usability/v2/contract.mjs';
import type {Store,Scope} from './types.js';
export interface ReadinessRuntimeProviders {readReadinessAssessment?:(context:{workspaceId:string;scope:Scope;id:string})=>Promise<ReadinessResult>}
export const READINESS_RUNTIME_OPERATIONS=['readiness.standard.inspect','readiness.inspect','readiness.intent.review','readiness.intent.record','readiness.intent.read','readiness.intent.list','readiness.project.complete','readiness.project.inspect','readiness.receipt.inspect'] as const;
export interface ReadinessCompletion {schema:'evopilot-asset-content-completion/v2';workspaceId:string;scope:Scope;intentDigest:string;assessmentDigest:string;assessmentId:string;assetLevel:string;reconstructionStatus:string;meaning:'ASSET_CONTENT_ONLY';digest:string;softwareRelease:false;authority:false}
export function createRuntimeReadiness(store:Store,providers:ReadinessRuntimeProviders){
  const records=createFeedbackStore(store,'runtime');
  const get=<T>(scope:Scope,kind:string,id:string):T=>{const r=records.get<T>(scope,'readiness-'+kind,id);if(!r)fail('READINESS_NOT_FOUND');return r;};
  function intent(scope:Scope,digest:string){nativeDigest(digest);const r=get<ReadinessIntentRecord>(scope,'intent',digest);if(nativeSha256(r.definition)!==digest||r.definition.workspaceId!==store.identity.id||nativeStableSerialize(r.definition.scope)!==nativeStableSerialize(scope))fail('READINESS_INTEGRITY');return r;}
  function current(scope:Scope,digest:string){const r=intent(scope,digest),head=get<{digest:string}>(scope,'intent-head',r.definition.id);if(head.digest!==digest)fail('READINESS_INTENT_STALE');return r;}
  function mutate(request:FeedbackEnvelope,fn:()=>unknown){return records.mutate(request,()=>{store.db.exec('PRAGMA user_version=8');return fn();});}
  function validateAssessment(assessment:ReadinessResult,scope:Scope,intentDigest:string){
    boundedReadiness(assessment);const {digest,...body}=assessment;
    if(digest!==nativeSha256(body)||assessment.schema!=='evopilot-asset-readiness-result/v2'||assessment.standardVersion!=='v2'||assessment.standardDigest!==READINESS_STANDARD_DIGEST||assessment.workspaceId!==store.identity.id||nativeStableSerialize(assessment.scope)!==nativeStableSerialize(scope)||assessment.intentDigest!==intentDigest||assessment.authority!==false||assessment.softwareRelease!==false)fail('READINESS_INTEGRITY');
  }
  async function readiness(request:FeedbackEnvelope):Promise<unknown>{
    boundedReadiness(request);feedbackScope(request.scope);const {operation,input,scope}=request;assertReadinessVersion(input.standardVersion);
    if(['readiness.intent.record','readiness.project.complete'].includes(operation)&&request.requestId&&records.receipt(scope,request.requestId))return records.mutate(request,()=>fail('READINESS_RECEIPT_INTEGRITY'));
    if(!['readiness.intent.record','readiness.project.complete'].includes(operation))nativeExact(request,['operation','scope','input']);
    if(!READINESS_RUNTIME_OPERATIONS.includes(operation as typeof READINESS_RUNTIME_OPERATIONS[number]))fail('READINESS_OPERATION');
    if(operation==='readiness.standard.inspect'){nativeExact(input,['standardVersion']);return {...READINESS_STANDARD,standardDigest:READINESS_STANDARD_DIGEST,authority:false};}
    if(operation==='readiness.inspect'){nativeExact(input,['standardVersion']);return records.inspect(scope);}
    if(operation==='readiness.receipt.inspect'){nativeExact(input,['standardVersion','requestId']);nativeText(input.requestId);return records.receipt(scope,input.requestId);}
    if(operation==='readiness.intent.list'){nativeExact(input,['standardVersion']);return {items:records.list<{id:string;digest:string}>(scope,'readiness-intent-head'),authority:false};}
    if(operation==='readiness.intent.read'){nativeExact(input,['standardVersion','digest']);const r=intent(scope,String(input.digest));return {...r,current:get<{digest:string}>(scope,'intent-head',r.definition.id).digest===r.digest};}
    if(operation==='readiness.intent.review'||operation==='readiness.intent.record'){
      nativeExact(input,operation.endsWith('.record')?['standardVersion','definition','previousDigest','humanEvidenceRef']:['standardVersion','definition','previousDigest']);
      const definition=validateReadinessIntent(input.definition);if(definition.workspaceId!==store.identity.id||nativeStableSerialize(definition.scope)!==nativeStableSerialize(scope))fail('READINESS_SCOPE');
      if(input.previousDigest!==null)nativeDigest(input.previousDigest);
      const digest=nativeSha256(definition),head=records.get<{digest:string}>(scope,'readiness-intent-head',definition.id);
      if((head?.digest??null)!==input.previousDigest)fail('READINESS_INTENT_STALE');
      if(operation.endsWith('.review'))return {definition,reviewDigest:digest,previousDigest:input.previousDigest,authority:false,assetLevel:null};
      nativeText(input.humanEvidenceRef);
      verifyDecisionEvidence(input.humanEvidenceRef,{owner:'runtime',operation,workspaceId:store.identity.id,scope,reviewDigest:digest,decision:'ACCEPT'});
      return mutate(request,()=>{const again=records.get<{digest:string}>(scope,'readiness-intent-head',definition.id);if((again?.digest??null)!==input.previousDigest)fail('READINESS_INTENT_STALE');
        const record:ReadinessIntentRecord={definition,humanEvidenceRef:input.humanEvidenceRef as string,digest,authority:false};
        records.put(scope,'readiness-intent',digest,record);records.put(scope,'readiness-intent-head',definition.id,{id:definition.id,digest});return record;});
    }
    if(operation==='readiness.project.inspect'){
      nativeExact(input,['standardVersion','intentDigest']);nativeDigest(input.intentDigest);const completion=records.get<ReadinessCompletion>(scope,'readiness-completion',input.intentDigest);if(!completion)return null;
      let currentStatus:'CURRENT'|'STALE'|'UNKNOWN'='UNKNOWN';let assessment:ReadinessResult|null=null;
      try{current(scope,input.intentDigest);if(!providers.readReadinessAssessment)fail('READINESS_PROVIDER_REQUIRED');assessment=await feedbackBounded(()=>providers.readReadinessAssessment!({workspaceId:store.identity.id,scope,id:completion.assessmentId}));validateAssessment(assessment,scope,input.intentDigest);currentStatus=assessment.assetAssessment.status==='QUALIFIED'&&assessment.assetAssessment.freshness==='CURRENT'?'CURRENT':'STALE';}catch(error){currentStatus=(error as {code?:string}).code==='READINESS_INTENT_STALE'?'STALE':'UNKNOWN';}
      return {completion,currentStatus,assessment,authority:false};
    }
    nativeExact(input,['standardVersion','intentDigest','assessmentId']);nativeDigest(input.intentDigest);readinessId(input.assessmentId);const r=current(scope,input.intentDigest);
    if(!providers.readReadinessAssessment)fail('READINESS_PROVIDER_REQUIRED');
    const assessment=await feedbackBounded(()=>providers.readReadinessAssessment!({workspaceId:store.identity.id,scope,id:input.assessmentId as string}));
    validateAssessment(assessment,scope,r.digest);
    if(assessment.schema!=='evopilot-asset-readiness-result/v2'||assessment.workspaceId!==store.identity.id||nativeStableSerialize(assessment.scope)!==nativeStableSerialize(scope)||assessment.intentDigest!==r.digest||assessment.assetAssessment.status!=='QUALIFIED'||assessment.assetAssessment.freshness!=='CURRENT'||assessment.assetAssessment.level!==r.definition.targetLevel)fail('READINESS_INCOMPLETE');
    return mutate(request,()=>{current(scope,r.digest);const body={schema:'evopilot-asset-content-completion/v2' as const,workspaceId:store.identity.id,scope,intentDigest:r.digest,assessmentDigest:assessment.digest,assessmentId:input.assessmentId as string,assetLevel:assessment.assetAssessment.level!,reconstructionStatus:assessment.reconstructionVerification.status,meaning:'ASSET_CONTENT_ONLY' as const,softwareRelease:false as const,authority:false as const};const result={...body,digest:nativeSha256(body)};records.put(scope,'readiness-completion',r.digest,result);return result;});
  }
  return {readiness};
}
export type {ReadinessIntent,ReadinessIntentRecord};
