/** Runtime-owned original native composition; provenance/legacy-execution.json. */
import type {Providers,NativeRun,NativeRunClaim,NativeMaterial,NativeOwnerReceipt,NativeProviderReceipt,NativeCriterionResult} from '../service.js';
import type {ReadinessResult} from '../../vendor/compatibility/usability/v2/contract.mjs';
import {nativeSha256,nativeStableSerialize,nativePackageDigest,nativeExact,NATIVE_CONTRACT_DIGEST,type NativeReference,type NativeScope,type NativePackage,type NativeToolchain,type StandardPins,type NativeJSON} from '../../vendor/compatibility/v1/native.mjs';
import {record,reject} from '../server/errors.js';
import {authorize} from '../server/security.js';
import {ownerRequestDigest,type Owner,type PublishedOwnerAdapter,type OwnerRequest} from '../adapters/published-owners.js';
import type {LegacyProviderContext} from './provider-context.js';
import {validateFeedbackEvent,validateFeedbackReceipt,type FeedbackEvent,type FeedbackInbox} from '../../vendor/compatibility/feedback/v1/feedback.mjs';
interface Published {reference:NativeReference;scope:NativeScope;package:NativePackage;materialDigest:string;}
export interface LegacyNativeComposition {
  workspaceId:string;workspaceRoot:string;expiresAt:string;toolchain:NativeToolchain;
  owners:Record<Owner,PublishedOwnerAdapter>;standards:Record<Owner,StandardPins>;
  parameters(pkg:NativePackage):{parameters:Record<string,NativeJSON>;effectiveConfigDigest:string};
  current(scope:NativeScope):ReturnType<LegacyProviderContext['current']>;
  context:LegacyProviderContext;
}
const same=(a:unknown,b:unknown)=>nativeStableSerialize(a)===nativeStableSerialize(b);
export function createLegacyNativeProviders(c:LegacyNativeComposition):Providers{
  async function read(owner:Owner,scope:NativeScope,operation:string,input:Record<string,unknown>){const ctx=c.current(scope),out=await c.owners[owner].read(ctx.actor,ctx.projectId,{scope,operation,input});c.current(scope);return out;}
  async function published(reference:NativeReference,consumer:NativeScope):Promise<Published>{
    const ctx=c.current(consumer);if(consumer.visibility==='public'&&reference.visibility==='private')reject('MATERIAL_SCOPE','Private material cannot satisfy public scope');
    if(!same({standardDigest:reference.standardDigest,standardLockDigest:reference.standardLockDigest},c.standards[reference.product]))reject('STANDARD_MISMATCH','Original published standard pins required');
    const scopes=reference.visibility==='private'?[consumer]:[...new Set([consumer.projectId,'shared'])].map(projectId=>({projectId,visibility:'public' as const})),found:Published[]=[];
    for(const scope of scopes){let value:Record<string,unknown>;try{value=await c.owners[reference.product].readPackage(ctx.actor,ctx.projectId,scope,reference);}catch(error){if(['NOT_FOUND','NOT_PUBLISHED'].includes(String((error as {code?:string}).code)))continue;throw error;}
      c.current(consumer);const pkg=value.package as NativePackage;if(reference.product==='ontology'&&record(value.workspace).canonicalRoot!==c.workspaceRoot)reject('MATERIAL_SCOPE','Published material belongs to another store');found.push({reference,scope,package:pkg,materialDigest:nativePackageDigest(pkg)});
    }
    if(found.length!==1)reject(found.length?'MATERIAL_AMBIGUOUS':'MATERIAL_UNAVAILABLE','One exact published material required');return found[0];
  }
  async function claimInputs(claim:Readonly<NativeRunClaim>){
    c.current(claim.scope);const run=await c.context.read('native',{operation:'run.inspect',scope:claim.scope,input:{id:claim.id}}) as NativeRun;
    if(!same(run.claim,claim)||claim.inputDigest!==nativeSha256(claim.input))reject('CLAIM_MISMATCH','Original retained Run claim required');
    const ontology=await published(claim.pins.ontology,claim.scope),harness=await published(claim.pins.harness,claim.scope);
    nativeExact(claim.input.nativeInputs.ontology,['packageDigest']);if(record(claim.input.nativeInputs.ontology).packageDigest!==nativePackageDigest(ontology.package))reject('CLAIM_INPUT_MISMATCH','Ontology input changed');nativeExact(claim.input.nativeInputs.harness,['observation']);
    const p=c.parameters(harness.package);if(!same(claim.input.effectiveConfig,{params:p.parameters})||claim.context.effectiveConfigDigest!==p.effectiveConfigDigest)reject('CONFIGURATION_MISMATCH','Published Harness parameters changed');return{ontology,harness};
  }
  const validationId=(claim:Readonly<NativeRunClaim>,owner:Owner)=>'native-'+owner+'-'+nativeSha256({claimId:claim.claimId}).slice(7,47);
  function validationInput(claim:Readonly<NativeRunClaim>,owner:Owner){const identity={id:claim.pins[owner].id,version:claim.pins[owner].version,context:claim.context};return owner==='ontology'?identity:{...identity,observation:record(claim.input.nativeInputs.harness).observation};}
  const readOwnerReceipt:NonNullable<Providers['readOwnerReceipt']>=async({owner,requestId,scope,claim})=>{
    if(!same(scope,claim.scope)||requestId!==validationId(claim,owner))reject('RECEIPT_MISMATCH','Original owner request identity required');const materials=await claimInputs(claim),actualScope=materials[owner].scope;
    const ctx=c.current(scope),original=record(await c.owners[owner].read(ctx.actor,ctx.projectId,{operation:'native.receipt.inspect',scope:actualScope,input:{requestId}}));c.current(scope);
    if(original.requestId!==requestId||original.operation!=='native.package.validate'||!same(original.scope,actualScope)||original.requestDigest!==nativeSha256({operation:'native.package.validate',scope:actualScope,input:validationInput(claim,owner)}))reject('RECEIPT_MISMATCH','Original validation receipt differs');
    const report=record(original.result);if(!same(report.context,claim.context)||report.toolchainLockDigest!==c.toolchain.lockDigest)reject('RECEIPT_MISMATCH','Original validator context differs');const{reportDigest,...body}=report;if(reportDigest!==nativeSha256(body))reject('REPORT_INTEGRITY','Original native report changed');
    let executionStatus:NativeOwnerReceipt['executionStatus'],qualityStatus:NativeOwnerReceipt['qualityStatus'];
    if(owner==='harness'){if(!same(report.reference,claim.pins.harness))reject('RECEIPT_MISMATCH','Harness reference changed');executionStatus=report.executionStatus as typeof executionStatus;qualityStatus=report.qualityStatus as typeof qualityStatus;}
    else{if(report.packageDigest!==nativePackageDigest(materials.ontology.package)||!same(report.standardPins,claim.input.standardPins.ontology))reject('RECEIPT_MISMATCH','Ontology reference changed');executionStatus=report.status==='UNKNOWN'?'UNKNOWN':report.status==='ERROR'?'ERROR':'SUCCEEDED';qualityStatus=report.status==='CONFORMS'?'PASS':report.status==='NONCONFORMING'?'FAIL':report.status==='UNSUPPORTED'?'UNSUPPORTED':report.status==='UNKNOWN'?'INDETERMINATE':'ERROR';}
    c.current(scope);return{owner,requestId,receiptDigest:nativeSha256(original),reference:claim.pins[owner],context:claim.context,executionStatus,qualityStatus,reportDigest:String(reportDigest),criteria:report.criteria as NativeCriterionResult[]};
  };
  async function receipt(claim:Readonly<NativeRunClaim>):Promise<NativeProviderReceipt>{const ontology=await readOwnerReceipt({owner:'ontology',requestId:validationId(claim,'ontology'),scope:claim.scope,claim}),harness=await readOwnerReceipt({owner:'harness',requestId:validationId(claim,'harness'),scope:claim.scope,claim});return{schema:'runtime-receipt/v1',contractDigest:NATIVE_CONTRACT_DIGEST,producer:{product:'runtime',version:'0.3.0'},claimId:claim.claimId,inputDigest:claim.inputDigest,projectCandidateDigest:claim.input.projectCandidateDigest,pins:claim.pins,standardPins:claim.input.standardPins,ownerReceipts:{ontology,harness}};}
  return{
    ...createLegacyFeedbackProviders(c),
    nativeStandards:c.standards,
    async resolveNative(request):Promise<NativeMaterial>{if(request.workspace.id!==c.workspaceId||request.workspace.canonicalRoot!==c.workspaceRoot||request.workspace.schema!=='evopilot-workspace/v1')reject('MATERIAL_SCOPE','Exact original Runtime workspace required');const value=await published(request.reference,request.scope);return{reference:value.reference,workspace:request.workspace,scope:value.scope,published:true,materialDigest:value.materialDigest,descriptor:{kind:request.reference.product==='ontology'?'ontology-composition/v1':'harness-composition/v1',digest:value.materialDigest}};},
    async executeNative({claim,signal}){signal.throwIfAborted();const materials=await claimInputs(claim);for(const owner of ['ontology','harness'] as const){const ctx=c.current(claim.scope);authorize(ctx.actor,ctx.projectId,'execution.request');signal.throwIfAborted();const scope=materials[owner].scope,state=record(await c.owners[owner].read(ctx.actor,ctx.projectId,{operation:'workspace.inspect',scope,input:{}}));c.current(claim.scope);signal.throwIfAborted();const request:OwnerRequest={operation:'native.package.validate',scope,input:validationInput(claim,owner),requestId:validationId(claim,owner),expectedRevision:Number(state.revision)};await c.owners[owner].mutate(ctx.actor,ctx.projectId,request,{projectId:ctx.projectId,owner,requestDigest:ownerRequestDigest(owner,request),expiresAt:new Date(Math.min(Date.parse(c.expiresAt),Date.now()+60000)).toISOString(),authorityRef:'legacy-run:'+claim.claimId});c.current(claim.scope);}signal.throwIfAborted();return receipt(claim);},
    async inspectNative({claim,signal}){signal.throwIfAborted();return receipt(claim);},readOwnerReceipt,
    async readReadinessAssessment(request){if(request.workspaceId!==c.workspaceId)reject('READINESS_SCOPE','Exact workspace required');const value=record(await read('harness',request.scope,'readiness.assessment.read',{standardVersion:'v2',id:request.id}));return value.result as ReadinessResult;},
  };
}

/** Original delivery IDs and Runtime outbox remain authoritative. Owners only
 * ingest a retained event; their review/decision APIs remain outside this API. */
export function createLegacyFeedbackProviders(c:Pick<LegacyNativeComposition,'workspaceId'|'expiresAt'|'owners'|'current'|'context'>):Pick<Providers,'deliverFeedback'|'readFeedbackInbox'>{
  function adapter(owner:Owner){if(!Object.hasOwn(c.owners,owner))reject('UNSUPPORTED_OWNER','Exact original feedback owner required');return c.owners[owner];}
  async function event(scope:NativeScope,id:string):Promise<FeedbackEvent>{
    c.current(scope);const value=await c.context.read('feedback',{operation:'feedback.event',scope,input:{id}});c.current(scope);validateFeedbackEvent(value);
    if(value.id!==id||value.workspaceId!==c.workspaceId||!same(value.scope,scope))reject('LEGACY_FEEDBACK_SCOPE','Feedback differs from the retained scoped Runtime event',403);return value;
  }
  const readFeedbackInbox:NonNullable<Providers['readFeedbackInbox']>=async({owner,scope,id})=>{
    const original=await event(scope,id),ctx=c.current(scope);let result:FeedbackInbox;
    try{result=await adapter(owner).read(ctx.actor,ctx.projectId,{operation:'feedback.read',scope,input:{id}}) as FeedbackInbox;}catch(error){c.current(scope);if((error as {code?:string}).code==='NOT_FOUND')return null;throw error;}
    c.current(scope);if(!same(result.event,original))reject('LEGACY_FEEDBACK_CHANGED','Owner feedback differs from its original Runtime event');validateFeedbackReceipt(result.receipt,original,owner);return result;
  };
  return{readFeedbackInbox,async deliverFeedback({owner,event:requested}){
    const original=await event(requested.scope,requested.id);if(!same(original,requested))reject('LEGACY_FEEDBACK_CHANGED','Only the exact retained feedback event may be delivered');
    const existing=await readFeedbackInbox({owner,scope:original.scope,id:original.id});if(existing)return existing;
    let ctx=c.current(original.scope);authorize(ctx.actor,ctx.projectId,'execution.request');
    const state=record(await adapter(owner).read(ctx.actor,ctx.projectId,{operation:'feedback.inspect',scope:original.scope,input:{}}));ctx=c.current(original.scope);authorize(ctx.actor,ctx.projectId,'execution.request');
    if(state.owner!==owner||state.workspaceId!==c.workspaceId||!same(state.scope,original.scope)||!Number.isSafeInteger(state.revision)||Number(state.revision)<0)reject('LEGACY_FEEDBACK_SCOPE','Owner feedback revision differs from its original scope',403);
    const request:OwnerRequest={operation:'feedback.ingest',scope:original.scope,input:{id:original.id,digest:original.digest},requestId:'feedback-'+original.id.slice(7,55),expectedRevision:Number(state.revision)};
    await adapter(owner).mutate(ctx.actor,ctx.projectId,request,{projectId:ctx.projectId,owner,requestDigest:ownerRequestDigest(owner,request),expiresAt:new Date(Math.min(Date.parse(c.expiresAt),Date.now()+60000)).toISOString(),authorityRef:'legacy-feedback:'+original.id});c.current(original.scope);
    const result=await readFeedbackInbox({owner,scope:original.scope,id:original.id});if(!result)reject('FEEDBACK_RECEIPT_UNAVAILABLE','Inspect the retained original owner delivery');return result;
  }};
}
