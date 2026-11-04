import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { canonical, digest, reject } from '../server/errors.js';

export interface BasePin { id: string; version: string; digest: string; schemaVersion: string; }
export interface FieldRule { id: string; path: string; stage: string; type: string; policy: 'CONFIGURABLE'|'CONSTRAINED'|'ADDITIVE'|'LOCKED'; required: boolean; providers: string[]; question: string; rules: Record<string,unknown>; }
export interface BaseStage { id: string; requires: string[]; checks: string[]; required: true; policy: 'LOCKED'; }
export interface BaseSlot { predecessor: string; successor: string; types: string[]; }
export interface BaseAction { id: string; version: string; type: string; parameterSchema: Record<string,string>; candidateReadOnly: boolean; permission: string; }
export interface PublisherBase { schema: string; id: string; version: string; publisher: string; fields: FieldRule[]; stages: BaseStage[]; slots: Record<string,BaseSlot>; actions: BaseAction[]; extensionRequiredFields: string[]; }
const MANIFEST_DIGEST = '6f832321c1043bd056b433d3975602ef8a2e401ca9a3cf6ed4d4d29bfe81e476';
export const byteDigest=(bytes:string|Buffer):string=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
export const valueDigest=(value:unknown):string=>'sha256:'+digest(value);
function freeze<T>(value:T):T { if(value && typeof value==='object'){Object.freeze(value);for(const v of Object.values(value))freeze(v);}return value; }
/** Anchor is owned by the installed Runtime build, never supplied by project YAML. */
export function verifyBaseDistribution(manifestBytes:Buffer,baseBytes:Buffer):Readonly<{pin:BasePin;base:PublisherBase}> {
  if(byteDigest(manifestBytes)!=='sha256:'+MANIFEST_DIGEST)reject('UNTRUSTED_BASE','Installed publisher manifest has changed',409);
  const manifest=JSON.parse(manifestBytes.toString('utf8')) as {bases:(BasePin & {file:string})[]};
  const entry=manifest.bases[0];
  if(byteDigest(baseBytes)!==entry.digest)reject('UNTRUSTED_BASE','Installed Base bytes do not match the publisher manifest',409);
  const {file:unused,...pin}=entry;
  return freeze({pin,base:JSON.parse(baseBytes.toString('utf8')) as PublisherBase});
}
export function loadPublisherBase():Readonly<{pin:BasePin;base:PublisherBase}> {
  const manifest=new URL('../../lifecycle/base/manifest.json',import.meta.url);
  const source=new URL('../../lifecycle/base/software-release-0.9.0.json',import.meta.url);
  for(const path of [manifest,source]){const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>131072)reject('UNTRUSTED_BASE','Invalid installed Base resource',409);}
  return verifyBaseDistribution(readFileSync(manifest),readFileSync(source));
}
export function isCurrentBase(pin:BasePin):boolean{return canonical(pin)===canonical(loadPublisherBase().pin);}
export function requireCurrentBase(pin:BasePin):void{if(!isCurrentBase(pin))reject('HISTORICAL_BASE_READ_ONLY','Historical Base records are read-only; validate and activate a new revision against the current publisher Base',409);}
