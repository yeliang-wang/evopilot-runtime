import {canonical,exact,record,reject,string,evidenceValueDigest} from '../server/errors.js';
import {valueDigest} from '../lifecycle/base.js';
import {containsInlineSecret} from '../lifecycle/compiler.js';
import {artifactPath,readArtifactArchive,verifyCiArtifact,type VerifiedCiArtifact} from './artifacts.js';
import type {PlatformArtifactArchive,PlatformRunRequest} from './platforms.js';
import type {InstallationObservation} from './installation.js';
import {isAbsolute,resolve} from 'node:path';

export const DELIVERY_SMOKE_CHECK='base.closure.delivery-acceptance';
export const DELIVERY_SMOKE_PATH='evidence/delivery-smoke.json';
export type DeliveryTarget=
  {mode:'distribution';bindingDigest:string;commit:string;tag:string;descriptionDigest:string}|
  {mode:'local-install'|'approved-deployment';directory:string;manifestDigest:string};
export interface DeliveryInput {schema:'runtime-delivery-input/v1';target:DeliveryTarget;manifestArtifact:string|null;}
export function validateDeliveryInput(value:DeliveryInput,request:Pick<PlatformRunRequest,'stageId'|'candidateInput'>):DeliveryInput{
  const v=record(value);exact(v,['schema','target','manifestArtifact']);const t=record(v.target);
  if(v.schema!=='runtime-delivery-input/v1'||request.stageId!=='closure'||!request.candidateInput||Buffer.byteLength(canonical(v))>8192)reject('DELIVERY_INPUT','Closure requires its bounded exact delivery target',409);
  if(t.mode==='distribution'){
    exact(t,['mode','bindingDigest','commit','tag','descriptionDigest']);hash(t.bindingDigest);hash(t.descriptionDigest);if(!/^[a-f0-9]{40}$/.test(string(t.commit,40))||!['','v'].some(prefix=>t.tag===prefix+request.candidateInput!.manifest.version)||v.manifestArtifact!==null)reject('DELIVERY_INPUT','Distribution target must bind the original candidate version',409);
  }else if(t.mode==='local-install'||t.mode==='approved-deployment'){
    exact(t,['mode','directory','manifestDigest']);const path=string(t.directory,4096);hash(t.manifestDigest);if(!isAbsolute(path)||resolve(path)!==path||!request.candidateInput.manifest.artifacts.some(a=>a.name===v.manifestArtifact))reject('DELIVERY_INPUT','Installation target requires its configured exact directory and candidate manifest artifact',409);
  }else reject('DELIVERY_INPUT','Unsupported delivery mode',409);
  if(containsInlineSecret(canonical(v)))reject('DELIVERY_INPUT','Delivery input cannot contain credentials',409);return value;
}
export interface DeliverySmoke {
  schema:'runtime-delivery-smoke/v1';requestId:string;inputDigest:string;candidateDigest:string;
  target:DeliveryTarget;installation:{directoryIdentity:string;factsDigest:string}|null;
  probe:{kind:'candidate-smoke'|'installed-smoke'|'deployed-smoke';status:'PASS'|'FAIL'|'UNKNOWN';evidencePaths:string[];values:Record<string,unknown>};
}
export interface VerifiedDeliverySmoke {
  schema:'runtime-verified-delivery-smoke/v1';ci:VerifiedCiArtifact;smoke:DeliverySmoke;
  status:'PASSED'|'FAILED'|'UNKNOWN';installationFactsDigest:string|null;digest:string;
}
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const hash=(v:unknown)=>{const s=string(v,71);if(!/^sha256:[a-f0-9]{64}$/.test(s))reject('DELIVERY_SMOKE_INVALID','Exact delivery evidence digest is required',409);return s;};
/** The only smoke input is an independently downloaded original CI artifact.
 * A local delivery also binds the same physical directory and exact manifest
 * readback. A remote runner without access to that target cannot satisfy it. */
export async function verifyDeliverySmoke(archive:PlatformArtifactArchive,request:PlatformRunRequest,target:DeliveryTarget,installation:InstallationObservation|null,signal:AbortSignal):Promise<VerifiedDeliverySmoke>{
  if(request.stageId!=='closure'||!request.candidateDigest)reject('DELIVERY_SMOKE_SCOPE','Smoke requires the exact closure candidate',409);
  const ci=await verifyCiArtifact(archive,request,[DELIVERY_SMOKE_CHECK],signal),files=await readArtifactArchive(archive.bytes,signal),raw=files.get(DELIVERY_SMOKE_PATH);
  if(!raw||raw.length>1048576||!ci.checks[0]?.evidence.some(e=>e.path===DELIVERY_SMOKE_PATH))reject('DELIVERY_SMOKE_MISSING','The required closure check must retain its exact smoke receipt',409);
  let value:Record<string,unknown>;try{value=record(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)));}catch{return reject('DELIVERY_SMOKE_INVALID','Smoke evidence must be bounded UTF-8 JSON',409);}
  exact(value,['schema','requestId','inputDigest','candidateDigest','target','installation','probe']);
  if(value.schema!=='runtime-delivery-smoke/v1'||value.requestId!==request.requestId||value.inputDigest!==request.inputDigest||value.candidateDigest!==request.candidateDigest||!same(value.target,target)||containsInlineSecret(canonical(value)))reject('DELIVERY_SMOKE_SCOPE','Smoke evidence differs from the original candidate, target or request',409);
  const probe=record(value.probe);exact(probe,['kind','status','evidencePaths','values']);record(probe.values);
  const kind=target.mode==='distribution'?'candidate-smoke':target.mode==='local-install'?'installed-smoke':'deployed-smoke';
  if(probe.kind!==kind||!['PASS','FAIL','UNKNOWN'].includes(String(probe.status))||!Array.isArray(probe.evidencePaths)||!probe.evidencePaths.length||probe.evidencePaths.length>64)reject('DELIVERY_SMOKE_INVALID','Selected delivery mode requires its fixed smoke procedure and original evidence',409);
  const seen=new Set<string>();for(const path of probe.evidencePaths){const p=artifactPath(path);if(p===DELIVERY_SMOKE_PATH||!p.startsWith('evidence/')||seen.has(p)||!files.has(p)||!files.get(p)!.length||!ci.checks[0]!.evidence.some(e=>e.path===p))reject('DELIVERY_SMOKE_MISSING','Every smoke evidence path must be nonempty and bound by the original CI check',409);seen.add(p);}
  let installationFactsDigest:string|null=null,installed=true;
  if(target.mode==='distribution'){
    if(value.installation!==null||installation!==null)reject('DELIVERY_SMOKE_SCOPE','Distribution evidence cannot invent an installed target',409);
  }else{
    const stated=record(value.installation);exact(stated,['directoryIdentity','factsDigest']);hash(stated.directoryIdentity);hash(stated.factsDigest);
    if(!installation||installation.directory!==target.directory||installation.manifestDigest!==target.manifestDigest||installation.candidateDigest!==request.candidateDigest)reject('DELIVERY_SMOKE_SCOPE','Independent readback of the exact selected installation is required',409);
    const{schema,factsDigest,observedAt,softwareExecuted,deploymentAccepted,...facts}=installation;
    if(schema!=='runtime-installation-observation/v1'||factsDigest!==evidenceValueDigest(facts)||softwareExecuted!==false||deploymentAccepted!==false)reject('DELIVERY_SMOKE_SCOPE','Installation evidence must come from the fixed independent file verifier',409);
    installationFactsDigest=factsDigest;
    installed=installation.status==='PASSED'&&stated.directoryIdentity===installation.directoryIdentity&&stated.factsDigest===factsDigest;
  }
  const status=ci.status==='FAILED'||probe.status==='FAIL'||!installed?'FAILED':ci.status==='PASSED'&&probe.status==='PASS'?'PASSED':'UNKNOWN';
  const body={schema:'runtime-verified-delivery-smoke/v1' as const,ci,smoke:value as unknown as DeliverySmoke,status:status as VerifiedDeliverySmoke['status'],installationFactsDigest};
  signal.throwIfAborted();return{...body,digest:valueDigest(body)};
}
