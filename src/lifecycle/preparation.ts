import { canonical, exact, record, reject, ServiceError, slug, string } from '../server/errors.js';
import { authorize, type Principal } from '../server/security.js';
import { RuntimeStore, type Receipt } from '../server/store.js';
import { valueDigest } from './base.js';
import { containsInlineSecret, type EffectiveDefinition } from './compiler.js';
import { requiredChecksDigest } from './instance.js';

export const PREPARATION_READS=['lifecycle.preparation.read','lifecycle.scope.evidence.read','lifecycle.plan.evidence.read'] as const;
export const PREPARATION_WRITES=['lifecycle.preparation.save'] as const;
export interface DocumentPin {path:string;digest:string;}
export interface PreparationInput {
  definitionRevisionId:string; goalRef:string; loopRef:string;
  target:{id:string;version:string;title:string;scope:string[];exclusions:string[]};
  source:{provider:'github'|'gitlab';repositoryId:string;commit:string};
  compatibility:'unchanged'|'compatible'|'migration-required';
  documents:{plan:DocumentPin;impact:DocumentPin;verification:DocumentPin;rollback:DocumentPin;migration:DocumentPin|null};
  verification:{requirementsDigest:string;checks:{stageId:string;checkId:string;source:string;procedure:string}[]};
}
export interface PreparationPacket {
  schema:'runtime-preparation/v1'; workspaceId:string; projectId:string;
  semanticDigest:string; input:PreparationInput; digest:string;
}
export interface PreparationFacts {reviewerIds:string[];evidence:Record<string,unknown>;}
/** Only the fixed operator registration adapter supplies this function. */
export type PreparationValidator=(packet:PreparationPacket,definition:EffectiveDefinition,actor:Principal)=>PreparationFacts;
export type PreparationVerifier=(ref:string,definition:EffectiveDefinition,actor:Principal)=>{packet:PreparationPacket;facts:PreparationFacts};
export const isPreparationRef=(v:unknown):v is string=>typeof v==='string'&&/^preparation:sha256:[a-f0-9]{64}$/.test(v);
const hash=(v:unknown)=>{const s=string(v,71);if(!/^sha256:[a-f0-9]{64}$/.test(s))reject('INVALID_PREPARATION','An exact content digest is required');return s;};
function list(value:unknown,empty=false):unknown[]{if(!Array.isArray(value)||(!empty&&!value.length)||value.length>1024)reject('INVALID_PREPARATION','A bounded explicit list is required');return value;}
function input(value:unknown):PreparationInput{
  const i=record(value);exact(i,['definitionRevisionId','goalRef','loopRef','target','source','compatibility','documents','verification']);
  if(containsInlineSecret(canonical(i)))reject('INLINE_SECRET','Preparation uses references, not inline credentials');
  hash(i.definitionRevisionId);string(i.goalRef,512);string(i.loopRef,512);
  const target=record(i.target);exact(target,['id','version','title','scope','exclusions']);slug(target.id);string(target.title,1024);
  string(target.version,128);
  for(const key of ['scope','exclusions']){const values=list(target[key],key==='exclusions').map(v=>string(v,2048));if(new Set(values).size!==values.length)reject('INVALID_PREPARATION','Duplicate scope or exclusion');}
  const source=record(i.source);exact(source,['provider','repositoryId','commit']);
  if(!['github','gitlab'].includes(String(source.provider))||!/^\d{1,20}$/.test(string(source.repositoryId,20))||! /^[a-f0-9]{40}$/.test(string(source.commit,40)))reject('INVALID_PREPARATION','Exact supported repository and baseline commit are required');
  if(!['unchanged','compatible','migration-required'].includes(String(i.compatibility)))reject('INVALID_PREPARATION','Explicit compatibility impact is required');
  const documents=record(i.documents);exact(documents,['plan','impact','verification','rollback','migration']);
  for(const [role,value] of Object.entries(documents)){
    if(role==='migration'&&value===null){if(i.compatibility==='migration-required')reject('MIGRATION_PLAN_REQUIRED','Migration impact needs a pinned migration plan');continue;}
    const pin=record(value);exact(pin,['path','digest']);string(pin.path,4096);hash(pin.digest);
  }
  const verification=record(i.verification);exact(verification,['requirementsDigest','checks']);hash(verification.requirementsDigest);
  for(const raw of list(verification.checks)){const row=record(raw);exact(row,['stageId','checkId','source','procedure']);string(row.stageId);string(row.checkId);string(row.procedure,2048);if(!['ci-artifact','owner-receipt','decision','delivery-readback'].includes(String(row.source)))reject('INVALID_PREPARATION','Unsupported verification evidence source');}
  return JSON.parse(canonical(i)) as PreparationInput;
}
function forDefinition(packet:PreparationPacket,definition:EffectiveDefinition):void{
  if(packet.projectId!==definition.projectId||packet.semanticDigest!==definition.semanticDigest||packet.input.verification.requirementsDigest!==requiredChecksDigest(definition))reject('PREPARATION_SCOPE','Preparation does not match the exact definition and fixed requirements',409);
  const expected=definition.nodes.flatMap(n=>n.checks.map(check=>n.id+'\0'+check)).sort(),actual=packet.input.verification.checks.map(c=>c.stageId+'\0'+c.checkId).sort();
  if(canonical(actual)!==canonical(expected))reject('PREPARATION_COVERAGE','Verification plan must contain every fixed stage/check exactly once',409);
}
export function readPreparationPacket(store:RuntimeStore,projectId:string,ref:string):PreparationPacket{
  if(!isPreparationRef(ref))reject('PREPARATION_REQUIRED','Use the exact retained per-instance preparation reference',409);
  const raw=store.object(projectId,'lifecycle-preparation',ref);if(!raw)reject('NOT_FOUND','Preparation not found in this project',404);
  const p=record(raw);exact(p,['schema','workspaceId','projectId','semanticDigest','input','digest']);const{digest,...body}=p;
  if(p.schema!=='runtime-preparation/v1'||p.workspaceId!==store.workspaceId||p.projectId!==projectId||digest!==valueDigest(body)||ref!=='preparation:'+digest)reject('CORRUPT_PREPARATION','Retained preparation content changed',503);
  input(p.input);hash(p.semanticDigest);return JSON.parse(canonical(p)) as PreparationPacket;
}
/** Immutable material only: no PASS, human decision, stage outcome or implicit
 * execution can be written by saving a packet. */
export function createPreparationService(store:RuntimeStore,validator?:PreparationValidator){
  function definition(projectId:string,id:string):EffectiveDefinition{
    const raw=store.object(projectId,'definition-revision',hash(id));if(!raw)reject('NOT_FOUND','Definition revision not found',404);
    const r=record(raw),c=record(r.compilation);
    if(r.id!==id||valueDigest({yaml:r.yaml,compilation:r.compilation})!==id||c.valid!==true||!c.effective)reject('CORRUPT_DEFINITION','Preparation requires an intact valid definition',409);
    const d=c.effective as EffectiveDefinition;if(d.projectId!==projectId||valueDigest(d.semantic)!==d.semanticDigest)reject('CORRUPT_DEFINITION','Definition identity changed',503);return d;
  }
  function validate(packet:PreparationPacket,d:EffectiveDefinition,actor:Principal):PreparationFacts{
    authorize(actor,packet.projectId,'read');forDefinition(packet,d);
    if(!validator)reject('PREPARATION_VALIDATION_UNAVAILABLE','Register scoped preparation locations and policies first',409);
    const facts=validator(packet,d,actor);if(!Array.isArray(facts.reviewerIds)||!facts.reviewerIds.length)reject('PREPARATION_REVIEW_REQUIRED','Plan reviewer policy is unavailable',409);facts.reviewerIds.forEach(slug);canonical(facts);return facts;
  }
  const verify:PreparationVerifier=(ref,d,actor)=>{
    const packet=readPreparationPacket(store,d.projectId,ref);const selected=definition(d.projectId,packet.input.definitionRevisionId);
    if(selected.semanticDigest!==d.semanticDigest)reject('PREPARATION_SCOPE','Preparation belongs to another definition',409);
    return{packet,facts:validate(packet,d,actor)};
  };
  function read(actor:Principal,projectId:string,operation:string,request:Record<string,unknown>):unknown{
    authorize(actor,projectId,'read');
    if(operation==='lifecycle.plan.evidence.read'){
      exact(request,['stageRequestId']);const id=string(request.stageRequestId),raw=store.object(projectId,'plan-stage-input',id),original=store.object(projectId,'stage-request',id);
      if(!raw||!original)reject('NOT_FOUND','Original plan input is unavailable',404);
      const evidence=record(raw),r=record(original),{digest,...body}=evidence;
      if(digest!==valueDigest(body)||r.projectId!==projectId||r.workspaceId!==store.workspaceId||r.stageId!=='plan'||evidence.requestDigest!==r.digest||evidence.planDigest!==r.planDigest)reject('CORRUPT_STAGE_EVIDENCE','Plan evidence does not match its retained request',503);
      const owners=Object.fromEntries(['ontology','harness'].map(kind=>{
        const action=store.object(projectId,'plan-stage-native-action',id+':'+kind),receipt=store.object(projectId,'plan-stage-native-receipt',id+':'+kind);
        if(action){const a=record(action),{digest,...body}=a;if(digest!==valueDigest(body))reject('CORRUPT_STAGE_ACTION','Original plan action changed',503);}
        return[kind,{action,receipt}];
      }));
      return{stageRequestId:id,evidence,owners,historical:true,authorityGranted:false};
    }
    if(operation==='lifecycle.scope.evidence.read'){
      exact(request,['stageRequestId']);const id=string(request.stageRequestId),raw=store.object(projectId,'scope-stage-evidence',id),original=store.object(projectId,'stage-request',id);
      if(!raw||!original)reject('NOT_FOUND','Original scope evidence is unavailable',404);
      const evidence=record(raw),r=record(original),{digest,...body}=evidence;
      if(digest!==valueDigest(body)||r.projectId!==projectId||r.workspaceId!==store.workspaceId||r.stageId!=='scope'||evidence.requestDigest!==r.digest||evidence.planDigest!==r.planDigest)reject('CORRUPT_STAGE_EVIDENCE','Scope evidence does not match its retained request',503);
      return{stageRequestId:id,evidence,historical:true,authorityGranted:false};
    }
    if(operation!=='lifecycle.preparation.read')reject('UNKNOWN_OPERATION','Unsupported preparation read',404);exact(request,['preparationRef']);
    const ref=string(request.preparationRef,128),packet=readPreparationPacket(store,projectId,ref);let current=false,reason:string|null=null;
    try{validate(packet,definition(projectId,packet.input.definitionRevisionId),actor);current=true;}catch(e){reason=e instanceof ServiceError?e.code:'PREPARATION_UNAVAILABLE';}
    return{preparationRef:ref,packet,current,reason,executionAuthorized:false,releaseAuthorized:false,projectRevision:store.revision(projectId)};
  }
  function write(actor:Principal,projectId:string,operation:string,request:Record<string,unknown>,requestId:string,expectedRevision:number,reauthorize:()=>Principal):Receipt{
    authorize(actor,projectId,'draft.write');if(operation!=='lifecycle.preparation.save')reject('UNKNOWN_OPERATION','Unsupported preparation write',404);
    const mutation={projectId,operation,requestId,expectedRevision,input:request,permission:'draft.write' as const};
    if(store.findReceipt(actor,projectId,requestId))return store.mutate(actor,mutation,()=>{throw Error('Unreachable replay');},reauthorize);
    const data=input(request),d=definition(projectId,data.definitionRevisionId),body={schema:'runtime-preparation/v1' as const,workspaceId:store.workspaceId,projectId,semanticDigest:d.semanticDigest,input:data},packet={...body,digest:valueDigest(body)},ref='preparation:'+packet.digest;
    return store.mutate(actor,mutation,()=>{
      const current=reauthorize();authorize(current,projectId,'draft.write');
      if((store.object(projectId,'definition-pointer','active') as {revisionId:string}|null)?.revisionId!==data.definitionRevisionId)reject('DEFINITION_NOT_ACTIVE','Preparation requires the selected active definition',409);
      validate(packet,d,current);const previous=store.object(projectId,'lifecycle-preparation',ref);
      if(previous&&canonical(previous)!==canonical(packet))reject('CORRUPT_PREPARATION','An immutable packet cannot be replaced',503);
      return{objects:previous?[]:[{kind:'lifecycle-preparation',id:ref,value:packet}],value:{preparationRef:ref,digest:packet.digest,executionAuthorized:false,releaseAuthorized:false},event:{type:'lifecycle-preparation-saved',data:{preparationRef:ref,definitionRevisionId:data.definitionRevisionId,createdBy:current.id}}};
    },reauthorize);
  }
  return{read,write,verify};
}
