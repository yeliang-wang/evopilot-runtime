import {nativeStableSerialize as canonical,type NativeScope} from '../../vendor/compatibility/v1/native.mjs';
import {responseReference,validateResolvedResponseRunbook,validateResponseProblem,validateResponseEvidence,validateResponseRecovery} from '../../vendor/compatibility/response/v1/response.mjs';
import {validateOnlineFinding} from '../../vendor/compatibility/online/v1/online.mjs';
import {reject} from '../server/errors.js';
import type {Providers} from '../service.js';
import type {LegacyNativeComposition} from './native-providers.js';
import {readRuntimeResponseEvidence,readWorkspaceResponseEvidence,requestResponseCollectionCancellation} from './response-evidence.js';

type Context=Pick<LegacyNativeComposition,'workspaceId'|'workspaceRoot'|'owners'|'current'|'context'>&{projectRoot:string};
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
/** Consume existing public findings/runbooks only. Telemetry collection,
 * online worker startup and owner review are not enabled by this composition. */
export function createLegacyResponseProviders(c:Context):Pick<Providers,'resolveResponseRunbook'|'readResponseProblem'|'readResponseEvidence'|'readResponseRecovery'|'cancelResponseCollection'|'readOnlineFinding'>{
  async function read(scope:NativeScope,operation:string,input:Record<string,unknown>){const ctx=c.current(scope),value=await c.owners.harness.read(ctx.actor,ctx.projectId,{operation,scope,input});c.current(scope);return value;}
  const nativeRead=(scope:NativeScope)=>(request:{operation:string;scope:NativeScope;input:Record<string,unknown>})=>{c.current(scope);if(!same(scope,request.scope))reject('LEGACY_PROVIDER_SCOPE','Response read cannot cross the original scope',403);return c.context.read('native',request);};
  function scoped(value:{workspaceId:string;scope:NativeScope},scope:NativeScope){if(value.workspaceId!==c.workspaceId||!same(value.scope,scope))reject('RESPONSE_SCOPE','Response evidence belongs to another project',403);c.current(scope);}
  return{
    async resolveResponseRunbook({scope,pin}){const value=await read(scope,'response.runbook.inspect',{pin});validateResolvedResponseRunbook(value);if(value.workspaceId!==c.workspaceId||!same(value.pin,pin)||value.scope.visibility==='private'&&!same(value.scope,scope))reject('RESPONSE_RUNBOOK_STALE','Runbook differs from its exact published reference');return value;},
    async readResponseProblem({scope,id}){const value=await read(scope,'response.problem.inspect',{id});validateResponseProblem(value);scoped(value,scope);if(value.id!==id)reject('RESPONSE_PROBLEM','Problem identity differs');return value;},
    async readResponseEvidence({scope,reference}){c.current(scope);responseReference(reference);let value;
      if(reference.owner==='runtime')value=await readRuntimeResponseEvidence({workspaceId:c.workspaceId},nativeRead(scope),scope,reference);
      else if(reference.owner==='workspace')value=readWorkspaceResponseEvidence(c,scope,reference);
      else if(reference.owner==='harness')value=await read(scope,'response.evidence.inspect',{reference});
      else return reject('RESPONSE_EVIDENCE_UNSUPPORTED','No original reader for this evidence owner');
      validateResponseEvidence(value);scoped(value,scope);if(!same(value.reference,reference))reject('RESPONSE_EVIDENCE_DRIFT','Original evidence reference changed');return value;
    },
    async readResponseRecovery({scope,reference}){c.current(scope);responseReference(reference);if(reference.owner!=='harness')reject('RESPONSE_EVIDENCE_OWNER','Recovery belongs to Harness');const value=await read(scope,'response.recovery.inspect',{id:reference.id});validateResponseRecovery(value);scoped(value,scope);if(!same(value.reference,reference))reject('RESPONSE_EVIDENCE_DRIFT','Recovery reference changed');return value;},
    async cancelResponseCollection({scope,collectionId,claimId}){return requestResponseCollectionCancellation({workspaceId:c.workspaceId,workspaceRoot:c.workspaceRoot,assertCurrent:()=>{c.current(scope);}},nativeRead(scope),scope,collectionId,claimId);},
    async readOnlineFinding({scope,id}){const value=await read(scope,'online.finding.inspect',{id});validateOnlineFinding(value);scoped(value,scope);if(value.id!==id)reject('ONLINE_FINDING_SCOPE','Original finding identity differs');return value;},
  };
}
