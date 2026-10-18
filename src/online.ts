import {nativeAssertJSON,nativeExact,nativeDigest,nativeSha256,nativeFrozenClone} from '../vendor/compatibility/v1/native.mjs';
import {createFeedbackStore,feedbackScope,feedbackBounded} from '../vendor/compatibility/feedback/v1/feedback.mjs';
import {onlineFail,onlineEqual,validateOnlineFinding} from '../vendor/compatibility/online/v1/online.mjs';
import type {OnlineEnvelope,OnlineRuntimeProviders,OnlineRepairCandidate,OnlineFinding} from '../vendor/compatibility/online/v1/online.mjs';
import type {Store} from './types.js';
export type * from '../vendor/compatibility/online/v1/online.mjs';
export const ONLINE_RUNTIME_OPERATIONS=['online.inspect','online.repair.ingest','online.repair.inspect','online.receipt.inspect'];
export function createOnlineRuntime(store:Store,providers:OnlineRuntimeProviders){
 const records=createFeedbackStore(store,'runtime',4);
 async function online(request:OnlineEnvelope):Promise<unknown>{
  nativeAssertJSON(request);const {operation,scope,input}=request;
  if(!ONLINE_RUNTIME_OPERATIONS.includes(operation))onlineFail('ONLINE_OPERATION');
  nativeExact(request,['operation','scope','input',...(operation==='online.repair.ingest'?['requestId','expectedRevision']:[])]);feedbackScope(scope);store.guard();
  nativeExact(input,operation==='online.inspect'?[]:operation==='online.receipt.inspect'?['requestId']:['id']);
  if(operation==='online.inspect')return nativeFrozenClone({...records.inspect(scope),repairCandidates:records.list<OnlineRepairCandidate>(scope,'online-repair'),softwareRelease:false,ontologyMutation:false});
  if(operation==='online.receipt.inspect'){if(typeof input.requestId!=='string')onlineFail('ONLINE_REQUEST');return records.receipt(scope,input.requestId);}
  nativeDigest(input.id);
  if(operation==='online.repair.inspect')return nativeFrozenClone(records.get<OnlineRepairCandidate>(scope,'online-repair',input.id));
  if(!providers.readOnlineFinding)onlineFail('ONLINE_HARNESS_UNAVAILABLE');
  const finding:OnlineFinding=await feedbackBounded(()=>providers.readOnlineFinding!({scope,id:input.id as string}));validateOnlineFinding(finding);
  if(finding.id!==input.id||finding.workspaceId!==store.identity.id||!onlineEqual(finding.scope,scope))onlineFail('ONLINE_FINDING_SCOPE');
  return records.mutate(request,()=>{
   const prior=records.get<OnlineRepairCandidate>(scope,'online-repair',finding.incidentId);
   if(prior?.history.some(f=>f.id===finding.id)){if(!prior.history.some(f=>f.digest===finding.digest))onlineFail('ONLINE_FINDING_CONFLICT');return {id:prior.id,digest:prior.digest};}
   const history=[...(prior?.history??[]),finding].sort((a,b)=>a.at-b.at||(a.state===b.state?a.id.localeCompare(b.id):a.state==='RESOLVED'?1:-1));
   const body:Omit<OnlineRepairCandidate,'digest'>={id:finding.incidentId,workspaceId:store.identity.id,scope,bindingId:finding.bindingId,incidentId:finding.incidentId,history,state:history.at(-1)!.state,status:'REVIEW_REQUIRED',requestedVersion:null,softwareRelease:false,ontologyMutation:false};
   const candidate={...body,digest:nativeSha256(body)};records.put(scope,'online-repair',candidate.id,candidate);return {id:candidate.id,digest:candidate.digest};
  });
 }
 return Object.freeze({online});
}
