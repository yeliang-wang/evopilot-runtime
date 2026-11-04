import { isCurrentBase, loadPublisherBase, requireCurrentBase, valueDigest } from './base.js';
import { atPath, containsInlineSecret, type EffectiveDefinition, type Issue } from './compiler.js';
import { canonical, exact, record, string } from '../server/errors.js';
import type { Principal } from '../server/security.js';

export interface BindingRequirement { path:string; value:unknown; inputDigest:string; }
export interface BindingCheck { path:string; inputDigest:string; status:'VALID'|'MISSING'|'INVALID'|'UNKNOWN'; revision:string; factsDigest:string; evidenceRef:string; expiresAt:string; }
/** Trusted in-process owner/platform adapter. Project YAML cannot register or choose callbacks. */
export type DefinitionBindingProvider=(definition:EffectiveDefinition,principal:Principal,requirements:readonly BindingRequirement[],signal:AbortSignal)=>Promise<readonly BindingCheck[]>;
export interface BindingValidation { ready:boolean; issues:Issue[]; stamp:string|null; expiresAt:string|null; checks:readonly BindingCheck[]; }
export function bindingRequirements(definition:EffectiveDefinition):BindingRequirement[]{
  requireCurrentBase(definition.base);
  const requirements:BindingRequirement[]=[];
  const add=(path:string,value:unknown)=>{requirements.push({path,value,inputDigest:valueDigest(value)});};
  for(const f of loadPublisherBase().base.fields){const value=atPath(definition.semantic,f.path);if(value!==undefined&&['bindingRef','credentialRef','bindingList'].includes(f.type))add(f.path,value);}
  for(const owner of ['ontology','harness'])add('assets.'+owner,atPath(definition.semantic,'assets.'+owner));
  add('config.implementation.connection',atPath(definition.semantic,'config.implementation'));
  for(const node of definition.nodes.filter(n=>n.source==='project'))add('extensions.'+node.id,node.action);
  return requirements;
}
export async function validateBindings(definition:EffectiveDefinition,principal:Principal,provider?:DefinitionBindingProvider,now=Date.now(),timeoutMs=5000):Promise<BindingValidation>{
  const issues:Issue[]=[];
  const fail=(path:string,code:string,message:string)=>issues.push({code,path,rule:'binding.current-scoped-evidence',message,remedy:'Complete or repair the owning configuration/asset/credential binding, then validate this exact revision again.'});
  if(!isCurrentBase(definition.base)){fail('extends','HISTORICAL_BASE_READ_ONLY','Historical definitions cannot obtain current binding admission');return{ready:false,issues,stamp:null,expiresAt:null,checks:[]};}
  if(!provider){fail('$','BINDINGS_UNAVAILABLE','Published owner and platform adapters are not configured');return{ready:false,issues,stamp:null,expiresAt:null,checks:[]};}
  const required=bindingRequirements(definition);let checks:readonly BindingCheck[];
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{checks=await Promise.race([provider(definition,principal,required,controller.signal),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Binding timeout'));},timeoutMs);})]);}catch{fail('$','BINDINGS_UNKNOWN','Binding verification did not complete');return{ready:false,issues,stamp:null,expiresAt:null,checks:[]};}finally{if(timer)clearTimeout(timer);}
  if(!Array.isArray(checks)||checks.length!==required.length||new Set(checks.map(c=>c?.path)).size!==checks.length){fail('$','BINDINGS_INCOMPLETE','Binding result does not cover the exact required references');return{ready:false,issues,stamp:null,expiresAt:null,checks:[]};}
  try{
    for(const check of checks){
      exact(record(check),['path','inputDigest','status','revision','factsDigest','evidenceRef','expiresAt']);
      string(check.path,512);string(check.revision,128);string(check.evidenceRef,1024);string(check.expiresAt,128);
      if(containsInlineSecret(canonical(check)))throw new Error('Unexpected secret in binding metadata');
    }
  }catch{fail('$','BINDINGS_INVALID','Adapter returned invalid public binding metadata');return{ready:false,issues,stamp:null,expiresAt:null,checks:[]};}
  let expiration=Infinity;
  for(const expected of required){
    const found=checks.find(c=>c?.path===expected.path);
    if(!found||found.inputDigest!==expected.inputDigest||found.status!=='VALID'||typeof found.revision!=='string'||!found.revision.length||found.revision.length>128||!/^sha256:[a-f0-9]{64}$/.test(found.factsDigest??'')||typeof found.evidenceRef!=='string'||!found.evidenceRef.length||found.evidenceRef.length>1024||!Number.isFinite(Date.parse(found.expiresAt))||Date.parse(found.expiresAt)<=Math.max(now,Date.now()))fail(expected.path,'BINDING_NOT_READY','Reference is missing, stale, mismatched or not currently valid');
    else expiration=Math.min(expiration,Date.parse(found.expiresAt));
  }
  const ready=issues.length===0;
  // Verification times/receipt IDs can change on read. Stable facts + revisions
  // identify the reviewed configuration; freshness is independently enforced.
  const stamp=ready?valueDigest([...checks].sort((a,b)=>a.path.localeCompare(b.path)).map(c=>({path:c.path,inputDigest:c.inputDigest,revision:c.revision,factsDigest:c.factsDigest,status:c.status}))):null;
  return{ready,issues,stamp,expiresAt:ready?new Date(expiration).toISOString():null,checks:ready?checks:[]};
}
