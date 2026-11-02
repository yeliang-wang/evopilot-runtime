import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { canonical, exact, record, reject, slug, string } from '../server/errors.js';
import { authorize, privateFile, readPrivateJson, type Principal } from '../server/security.js';
import { valueDigest } from '../lifecycle/base.js';
import type { OwnerConfiguration } from './published-owners.js';
import { containsInlineSecret } from '../lifecycle/compiler.js';

export type Platform = 'github'|'gitlab';
export interface PlatformRegistration {
  ref:string; workspaceId:string; projectId:string; provider:Platform; host:string;
  repository:string; repositoryId:string; defaultBranch:string; credentialRef:string;
  workflowPath?:string; pipelinePath?:string; runner:string;
  revision:number; expiresAt:string;
}
export interface CredentialRegistration {
  ref:string; workspaceId:string; projectId:string; provider:Platform; host:string;
  tokenFile:string; revision:number; expiresAt:string;
}
export interface RegisteredOwner extends OwnerConfiguration { ref:string; }
export interface ResourceRegistration {
  ref:string; workspaceId:string; projectId:string; role:string; revision:number; expiresAt:string;
  definition:Record<string,unknown>;
}
export interface IntegrationConfiguration {
  schema:'runtime-integrations/v1'; workspaceId:string; revision:number;
  platforms:PlatformRegistration[]; credentials:CredentialRegistration[]; owners:RegisteredOwner[]; resources:ResourceRegistration[];
}
function immutable<T>(v:T):T{if(v&&typeof v==='object'){for(const item of Object.values(v))immutable(item);Object.freeze(v);}return v;}
function reference(v:unknown,prefix:'binding'|'credential'):string{
  const s=string(v,256);if(!new RegExp('^'+prefix+':[a-z0-9][a-z0-9/._-]*$').test(s))reject('INVALID_REGISTRATION','Invalid registered reference');return s;
}
function revision(v:unknown):void{if(!Number.isSafeInteger(v)||Number(v)<1)reject('INVALID_REGISTRATION','Registration revision must be positive');}
function expiry(v:unknown):void{if(!Number.isFinite(Date.parse(string(v,128))))reject('INVALID_REGISTRATION','Registration expiry is required');}
function absolute(v:unknown):string{const p=string(v,4096);if(!isAbsolute(p)||resolve(p)!==p)reject('INVALID_REGISTRATION','Canonical absolute operator path is required');return p;}
export function platformOrigin(v:unknown):string{
  const s=string(v,256);let url:URL;try{url=new URL(s);}catch{return reject('INVALID_REGISTRATION','Invalid platform origin');}
  if(url.protocol!=='https:'||url.origin!==s||url.username||url.password||url.hash||url.search||url.pathname!=='/')reject('INVALID_REGISTRATION','An exact HTTPS platform origin is required');return s;
}
function scope(v:Record<string,unknown>,workspaceId:string):void{
  if(v.workspaceId!==workspaceId)reject('INTEGRATION_SCOPE','Integration belongs to another workspace',403);
  slug(v.projectId);if(!['github','gitlab'].includes(String(v.provider)))reject('INVALID_REGISTRATION','Only GitHub and GitLab are registered providers');
  platformOrigin(v.host);revision(v.revision);expiry(v.expiresAt);
  if(v.provider==='github'&&v.host!=='https://github.com')reject('UNSUPPORTED_PLATFORM_HOST','This adapter supports GitHub.com; it does not infer an enterprise API route');
}
export function validatePlatformRegistration(value:unknown):PlatformRegistration{
  const p=record(value);const provider=p.provider;
  exact(p,['ref','workspaceId','projectId','provider','host','repository','repositoryId','defaultBranch','credentialRef','revision','expiresAt','runner',...(provider==='github'?['workflowPath']:['pipelinePath'])]);
  slug(p.workspaceId);scope(p,String(p.workspaceId));reference(p.ref,'binding');reference(p.credentialRef,'credential');
  const repository=string(p.repository,512);
  if(!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(repository)||repository.split('/').some(x=>x==='.'||x==='..')||provider==='github'&&repository.split('/').length!==2)reject('INVALID_REGISTRATION','Repository needs its exact provider namespace/path');
  if(!/^[1-9][0-9]{0,19}$/.test(string(p.repositoryId,20)))reject('INVALID_REGISTRATION','Exact numeric repository identity is required');
  const branch=string(p.defaultBranch,256);if(branch.startsWith('/')||branch.endsWith('/')||branch.endsWith('.')||/\.\.|[~^:?*\[\\\s@{}]/.test(branch)||branch.includes('//'))reject('INVALID_REGISTRATION','Invalid default branch');
  const path=string(p.workflowPath??p.pipelinePath,512);
  if(path.startsWith('/')||path.split('/').some(x=>!x||x==='.'||x==='..')||!/^[-A-Za-z0-9_./]+\.ya?ml$/.test(path)||provider==='github'&&!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path))reject('INVALID_REGISTRATION','Invalid registered workflow path');
  if(provider==='gitlab'&&!/^[1-9][0-9]{0,19}$/.test(string(p.runner,20)))reject('INVALID_REGISTRATION','GitLab runner must be registered by exact numeric identity');
  if(provider==='github'&&!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(string(p.runner,128)))reject('INVALID_REGISTRATION','GitHub runner requires an exact configured label');
  return immutable(JSON.parse(canonical(p)) as PlatformRegistration);
}
/** This protected operator file registers existing integrations. It grants no
 * execution/release authority and cannot register code, arbitrary API routes or
 * inline secrets. Project YAML can only reference these scoped registrations. */
export function readIntegrationConfiguration(path:string,workspaceId:string):Readonly<IntegrationConfiguration>{
  try{
    absolute(path);if(realpathSync(path)!==path)reject('UNSAFE_INTEGRATION_CONFIG','Symlinked integration configuration is not allowed');
    const config=record(readPrivateJson(path));exact(config,['schema','workspaceId','revision','platforms','credentials','owners'],['resources']);
    if(config.schema!=='runtime-integrations/v1'||config.workspaceId!==workspaceId)reject('INTEGRATION_SCOPE','Integration configuration belongs to another workspace',403);
    slug(workspaceId);revision(config.revision);
    for(const key of ['platforms','credentials','owners'])if(!Array.isArray(config[key])||config[key].length>128)reject('INVALID_REGISTRATION','Integration collections must be bounded arrays');
    const refs=new Set<string>();const unique=(ref:string)=>{if(refs.has(ref))reject('DUPLICATE_REGISTRATION','Integration references must be unique');refs.add(ref);};
    const platforms=(config.platforms as unknown[]).map(p=>{const item=validatePlatformRegistration(p);scope(record(item),workspaceId);unique(item.ref);return item;});
    const credentials=(config.credentials as unknown[]).map(v=>{
      const c=record(v);exact(c,['ref','workspaceId','projectId','provider','host','tokenFile','revision','expiresAt']);scope(c,workspaceId);unique(reference(c.ref,'credential'));absolute(c.tokenFile);return c as unknown as CredentialRegistration;
    });
    const owners=(config.owners as unknown[]).map(v=>{
      const o=record(v);exact(o,['ref','owner','packageRoot','workspaceRoot','workspaceId','projects']);unique(reference(o.ref,'binding'));
      if(o.workspaceId!==workspaceId||!['ontology','harness'].includes(String(o.owner))||!Array.isArray(o.projects)||!o.projects.length||o.projects.length>1000||new Set(o.projects).size!==o.projects.length)reject('INTEGRATION_SCOPE','Invalid owner scope');
      o.projects.forEach(slug);absolute(o.packageRoot);absolute(o.workspaceRoot);return o as unknown as RegisteredOwner;
    });
    if(config.resources!==undefined&&(!Array.isArray(config.resources)||config.resources.length>256))reject('INVALID_REGISTRATION','Resource registrations must be a bounded array');
    const resources=((config.resources??[]) as unknown[]).map(v=>{
      const r=record(v);exact(r,['ref','workspaceId','projectId','role','revision','expiresAt','definition']);unique(reference(r.ref,'binding'));slug(r.projectId);revision(r.revision);expiry(r.expiresAt);string(r.role,256);record(r.definition);
      if(r.workspaceId!==workspaceId)reject('INTEGRATION_SCOPE','Resource belongs to another workspace',403);
      if(containsInlineSecret(canonical(r.definition)))reject('INLINE_SECRET','Use a registered credential reference, not inline secrets');
      return r as unknown as ResourceRegistration;
    });
    for(const p of platforms){const c=credentials.find(c=>c.ref===p.credentialRef);if(!c||c.projectId!==p.projectId||c.provider!==p.provider||c.host!==p.host)reject('CREDENTIAL_SCOPE','Platform and credential registrations must have identical project/provider/host scope',403);}
    return immutable({schema:'runtime-integrations/v1',workspaceId,revision:Number(config.revision),platforms,credentials,owners,resources});
  }catch(e){if(e&&typeof e==='object'&&'code'in e&&typeof e.code==='string'&&!/^E[A-Z]+$/.test(e.code))throw e;return reject('UNSAFE_INTEGRATION_CONFIG','Protected integration configuration is unavailable',503);}
}
export function configuredPlatform(configuration:Readonly<IntegrationConfiguration>,actor:Principal,projectId:string,ref:string,now=Date.now()):PlatformRegistration{
  authorize(actor,projectId,'read',now);const p=configuration.platforms.find(p=>p.ref===ref&&p.projectId===projectId);
  if(!p||Date.parse(p.expiresAt)<=now)reject('PLATFORM_NOT_REGISTERED','Current scoped platform registration is required',409);return p;
}
/** Reload on every request so revocation, expiry and binding edits take effect.
 * The token exists only inside the credential/HTTP adapter; it is never a fact
 * returned by a binding check, a request parameter or a persistent receipt. */
export function readPlatformToken(path:string,expected:PlatformRegistration,actor:Principal,now=Date.now()):string{
  const config=readIntegrationConfiguration(path,expected.workspaceId),current=configuredPlatform(config,actor,expected.projectId,expected.ref,now);
  if(valueDigest(current)!==valueDigest(expected))reject('PLATFORM_BINDING_CHANGED','Revalidate the changed platform binding',409);
  const credential=config.credentials.find(c=>c.ref===current.credentialRef)!;
  if(Date.parse(credential.expiresAt)<=now)reject('CREDENTIAL_EXPIRED','Repair the expired platform credential binding',403);
  let fd:number|undefined;
  try{
    if(realpathSync(credential.tokenFile)!==credential.tokenFile)reject('UNSAFE_PLATFORM_CREDENTIAL','Credential symlinks are not allowed');
    privateFile(credential.tokenFile);fd=openSync(credential.tokenFile,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=fstatSync(fd);if(!stat.isFile()||stat.uid!==process.getuid?.()||stat.nlink!==1||(stat.mode&0o777)!==0o600||stat.size>4096)reject('UNSAFE_PLATFORM_CREDENTIAL','Invalid protected credential');
    const token=readFileSync(fd,'utf8').trim();if(!/^[A-Za-z0-9_.-]{16,4096}$/.test(token))reject('UNSAFE_PLATFORM_CREDENTIAL','Invalid protected credential');return token;
  }catch{return reject('UNSAFE_PLATFORM_CREDENTIAL','Scoped platform credential is unavailable',503);}finally{if(fd!==undefined)closeSync(fd);}
}
