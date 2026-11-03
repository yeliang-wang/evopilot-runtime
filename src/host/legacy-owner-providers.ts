/** Historical Host wiring only. Runtime reads use the authenticated HTTP
 * gateway; published owner public APIs retain all asset algorithms and stores. */
import {canonical,exact,record,reject,string} from '../server/errors.js';
import type {Owner} from '../adapters/published-owners.js';
import type {RuntimeHttpClient} from './client.js';
import {forwardLegacyRuntime} from './legacy-tools.js';
import type {LegacyFamily} from '../compat/catalog.js';
import {nativePackageDigest,nativeSha256,referenceForPackage,validateNativeReference,type NativePackage,type NativeReference,type NativeScope} from '../../vendor/compatibility/v1/native.mjs';
import {validateFeedbackEvent} from '../../vendor/compatibility/feedback/v1/feedback.mjs';
import {validateReadinessIntent,verifyReadinessProjection,type ReadinessProjection} from '../../vendor/compatibility/usability/v2/contract.mjs';
import {responseReference,validateResponseEvidence,type ResponseEvidence,type ResponseEvidenceRef} from '../../vendor/compatibility/response/v1/response.mjs';
import type {CollectionRecord,NativeRun} from '../native-types.js';

interface Context {
  workspaceId:string;projectId:string;client:RuntimeHttpClient;
  guard():{scope:NativeScope;signal?:AbortSignal};
  readOwner(owner:Owner,envelope:Record<string,unknown>):Promise<unknown>;
}
export function createLegacyOwnerProviders(context:Context,owner:Owner='harness'):Record<string,unknown>{
  const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
  function scope(request:{workspaceId?:string;scope:NativeScope}):void {
    const call=context.guard();if(request.workspaceId!==undefined&&request.workspaceId!==context.workspaceId||!same(request.scope,call.scope))reject('OWNER_HOST_SCOPE','Provider request differs from the active workspace/project',403);call.signal?.throwIfAborted();
  }
  async function runtime(family:LegacyFamily,operation:string,request:{scope:NativeScope},input:Record<string,unknown>):Promise<unknown>{
    scope(request);const value=await forwardLegacyRuntime(context.client,family,{operation,scope:request.scope,input},context.guard().signal);scope(request);return value.result;
  }
  async function published(reference:NativeReference,consumer:NativeScope){
    scope({scope:consumer});validateNativeReference(reference);
    if(consumer.visibility==='public'&&reference.visibility==='private')reject('OWNER_HOST_SCOPE','Public owner material cannot consume private dependencies',403);
    const scopes=reference.visibility==='private'?[consumer]:[...new Set([consumer.projectId,'shared'])].map(projectId=>({visibility:'public' as const,projectId}));
    const found:{reference:NativeReference;scope:NativeScope;package:NativePackage;materialDigest:string}[]=[];
    for(const selected of scopes){
      let output:Record<string,unknown>;try{output=record(await context.readOwner(reference.product,{operation:'native.package.readback',scope:selected,input:{id:reference.id,version:reference.version}}));}catch(error){if(error&&typeof error==='object'&&'code'in error&&['NOT_FOUND','NOT_PUBLISHED'].includes(String(error.code)))continue;throw error;}
      const pkg=output.package as NativePackage;
      if(!same(output.reference,reference)||!same(output.scope,selected)||!same(referenceForPackage(pkg),reference)||reference.product==='harness'&&(output.workspaceId!==context.workspaceId||output.published!==true)||reference.product==='ontology'&&record(output.workspace).id!==context.workspaceId)reject('OWNER_REFERENCE_CHANGED','Published owner dependency differs from the exact selected reference',409);
      found.push({reference,scope:selected,package:pkg,materialDigest:nativePackageDigest(pkg)});
    }
    if(found.length!==1)reject('OWNER_REFERENCE_CHANGED','Dependency must resolve to one exact published owner package',409);scope({scope:consumer});return found[0];
  }
  async function responseEvidence(request:{scope:NativeScope;reference:ResponseEvidenceRef}):Promise<ResponseEvidence>{
    scope(request);responseReference(request.reference);const {reference}=request;
    if(reference.owner==='harness'){
      const value=await context.readOwner('harness',{operation:'response.evidence.inspect',scope:request.scope,input:{reference}});scope(request);validateResponseEvidence(value);
      if(value.workspaceId!==context.workspaceId||!same(value.scope,request.scope)||!same(value.reference,reference))reject('RESPONSE_EVIDENCE_DRIFT','Evidence differs from its exact owner reference');return value;
    }
    if(reference.owner!=='runtime')reject('RESPONSE_EVIDENCE_UNSUPPORTED','No registered evidence reader for this owner');
    let actualDigest:string,observedAt:number,status:ResponseEvidence['status'];
    if(reference.id.startsWith('collection:')){
      const id=string(reference.id.slice(11)),collection=await runtime('native','collection.inspect',request,{id}) as CollectionRecord;
      if(!collection.receipt||!collection.claim||collection.id!==id||collection.workspace.id!==context.workspaceId||!same(collection.scope,request.scope))reject('RESPONSE_EVIDENCE_INCOMPLETE','Original collection claim and receipt are required');
      const {digest,...subject}=collection.receipt;
      if(nativeSha256(subject)!==digest||collection.receipt.claimId!==collection.claim.claimId)reject('RESPONSE_EVIDENCE_INTEGRITY','Collection receipt no longer matches its original claim');
      actualDigest=digest;observedAt=Math.floor(Date.parse(collection.receipt.result.endedAt)/1000);
      if(!Number.isSafeInteger(observedAt)||observedAt<1)reject('RESPONSE_EVIDENCE_TIME','Use the original receipt observation time');
      status=collection.stage==='SUCCEEDED'?'PASS':collection.stage==='FAILED'?'FAIL':'UNKNOWN';
    }else if(reference.id.startsWith('run:')){
      const id=string(reference.id.slice(4)),run=await runtime('native','run.inspect',request,{id}) as NativeRun;
      if(!run.receipt||!run.claim||run.plan.id!==id||run.plan.workspace.id!==context.workspaceId||!same(run.plan.scope,request.scope))reject('RESPONSE_EVIDENCE_INCOMPLETE','Original Run claim and receipt are required');
      actualDigest=nativeSha256(run.receipt);
      if(!Array.isArray(run.plan.input.collectionReceipts)||!run.plan.input.collectionReceipts.length)reject('RESPONSE_EXECUTION_EVIDENCE_REQUIRED','A Run needs its retained collection evidence');
      const times:number[]=[];
      for(const ref of run.plan.input.collectionReceipts)times.push((await responseEvidence({scope:request.scope,reference:{owner:'runtime',id:'collection:'+ref.id,digest:ref.digest}})).observedAt);
      observedAt=Math.min(...times);
      const reports=run.receipt.ownerReceipts;exact(record(reports),['ontology','harness']);
      const owners=Object.values(reports);
      status=run.stage==='SUCCEEDED'&&owners.every(r=>r.executionStatus==='SUCCEEDED'&&r.qualityStatus==='PASS')?'PASS':run.stage==='FAILED'||owners.some(r=>r.qualityStatus==='FAIL')?'FAIL':'UNKNOWN';
    }else reject('RESPONSE_EVIDENCE_UNSUPPORTED','Unsupported original Runtime evidence reference');
    if(actualDigest!==reference.digest)reject('RESPONSE_EVIDENCE_DRIFT','Evidence digest differs from the original reference');
    const value={workspaceId:context.workspaceId,scope:request.scope,reference,status,observedAt};validateResponseEvidence(value);scope(request);return value;
  }
  const providers={
    resolveNativeDependency:async(request:{workspaceId:string;scope:NativeScope;reference:NativeReference})=>{scope(request);const value=await published(request.reference,request.scope);return{reference:value.reference,published:true,workspaceId:context.workspaceId,scope:value.scope};},
    resolveFeedbackMaterial:async(request:{scope:NativeScope;reference:NativeReference})=>({...await published(request.reference,request.scope),workspaceId:context.workspaceId,published:true}),
    readFeedback:async(request:{scope:NativeScope;id:string})=>{const value=await runtime('feedback','feedback.event',request,{id:request.id});validateFeedbackEvent(value);const event=record(value);if(event.workspaceId!==context.workspaceId||event.projectId!==context.projectId||event.id!==request.id||!same(event.scope,request.scope))reject('OWNER_REFERENCE_CHANGED','Runtime feedback differs from its original owner request');return value;},
    readReadinessIntent:async(request:{workspaceId:string;scope:NativeScope;digest:string})=>{
      scope(request);const value=record(await runtime('readiness','readiness.intent.read',request,{standardVersion:'v2',digest:request.digest}));validateReadinessIntent(value.definition);
      const definition=record(value.definition);if(value.digest!==request.digest||nativeSha256(value.definition)!==request.digest||value.authority!==false||typeof value.current!=='boolean'||definition.workspaceId!==context.workspaceId||!same(definition.scope,request.scope))reject('OWNER_REFERENCE_CHANGED','Runtime intent differs from its exact original request');return value;
    },
    readReadinessProjection:async(request:{workspaceId:string;scope:NativeScope;reference:NativeReference})=>{
      scope(request);if(request.reference.product!=='ontology')reject('OWNER_REFERENCE_CHANGED','Readiness projection requires Ontology');const selected=await published(request.reference,request.scope);
      const projection=await context.readOwner('ontology',{operation:'readiness.package.inspect',scope:selected.scope,input:{standardVersion:'v2',id:request.reference.id,version:request.reference.version}}) as ReadinessProjection;verifyReadinessProjection(projection);
      if(!projection.published||projection.workspaceId!==context.workspaceId||!same(projection.reference,request.reference)||!same(projection.scope,selected.scope))reject('OWNER_REFERENCE_CHANGED','Readiness projection differs from its exact published package');return projection;
    },
    readOnlineRepair:async(request:{scope:NativeScope;id:string})=>runtime('online','online.repair.inspect',request,{id:request.id}),
    readResponseEvidence:responseEvidence,
    readResponseRecovery:async(request:{scope:NativeScope;reference:{owner:string;id:string}})=>{
      scope(request);if(request.reference.owner!=='harness')reject('OWNER_REFERENCE_CHANGED','Response recovery belongs to Harness');const value=record(await context.readOwner('harness',{operation:'response.recovery.inspect',scope:request.scope,input:{id:request.reference.id}}));if(!same(value.reference,request.reference))reject('OWNER_REFERENCE_CHANGED','Recovery reference differs');return value;
    },
    readResponseExecution:async(request:{scope:NativeScope;reference:{owner:string;id:string}})=>{
      scope(request);if(request.reference.owner!=='runtime'||!string(request.reference.id).startsWith('response:'))reject('OWNER_REFERENCE_CHANGED','Response execution belongs to Runtime');const value=record(await runtime('response','response.execution.inspect',request,{id:request.reference.id.slice(9)}));if(!same(value.reference,request.reference))reject('OWNER_REFERENCE_CHANGED','Execution reference differs');return value;
    },
    readReconstructionEvidence:async(request:{workspaceId:string;scope:NativeScope;attemptId:string},signal:AbortSignal)=>{signal.throwIfAborted();scope(request);const value=await runtime('reconstruction','reconstruction.evidence',request,{id:request.attemptId});signal.throwIfAborted();return value;},
  };
  // The public Ontology factory validates its exact provider descriptors. Do
  // not pass Harness-only callbacks to it, even when both owners are loaded.
  return owner==='ontology'?{readFeedback:providers.readFeedback,resolveFeedbackMaterial:providers.resolveFeedbackMaterial}:providers;
}
