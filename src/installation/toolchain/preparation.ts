/** Retained first-party toolchain maintenance. This operator module is not an
 * HTTP executor. The caller holds the exact stopped-service Workspace lease
 * for the entire task. Losing the Host never grants permission to redispatch. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalPath,readRegular} from '../../compat/project/files.js';
import {canonicalEvidence,exact,record,reject,string} from '../../server/errors.js';
import {save} from '../workspace/backup.js';
import {inspectBundledToolchainLock,inspectNativeToolchain,prepareNativeToolchain} from './locked.js';

export interface ToolchainPreparationContext {workspaceRoot:string;workspaceId:string;installationDigest:string;historicalRecordsDigest?:string;}
interface Preparation extends Omit<ToolchainPreparationContext,'historicalRecordsDigest'> {
  schema:'evopilot-toolchain-preparation/v1';requestId:string;lockDigest:string;
  status:'RUNNING'|'SUCCEEDED'|'FAILED';startedAt:string;completedAt:string|null;diagnostic:string|null;
}
type Maintenance=(work:()=>Promise<void>)=>Promise<void>;
const active=new Map<string,{admission:Promise<void>;task:Promise<void>}>();
const slug=(value:unknown)=>{const id=string(value,64);if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))reject('INVALID_REQUEST','Use a stable toolchain request ID');return id;};
const diagnostic=(error:unknown)=>error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^TOOLCHAIN_[A-Z0-9_]+$/.test(error.code)?error.code:'TOOLCHAIN_PREPARATION_FAILED';
function directory(root:string,create=false):void {
  canonicalPath(root,create);
  if(create&&!fs.existsSync(root))fs.mkdirSync(root,{mode:0o700});
  const stat=fs.lstatSync(root);
  if(!stat.isDirectory()||stat.uid!==process.getuid!()||(stat.mode&0o777)!==0o700)reject('TOOLCHAIN_PREPARATION_UNSAFE','Expected a protected toolchain journal');
}
function rootFor(c:ToolchainPreparationContext):string {
  exact(record(c),['workspaceRoot','workspaceId','installationDigest'],['historicalRecordsDigest']);slug(c.workspaceId);canonicalPath(c.workspaceRoot);
  if(c.historicalRecordsDigest!==undefined&&!/^[a-f0-9]{64}$/.test(c.historicalRecordsDigest))reject('TOOLCHAIN_PREPARATION_IDENTITY','Expected the exact retained history binding');
  if(!/^[a-f0-9]{64}$/.test(c.installationDigest))reject('TOOLCHAIN_PREPARATION_IDENTITY','Select an exact installation');
  directory(c.workspaceRoot);return path.join(c.workspaceRoot,'native-toolchain-preparation');
}
const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
function historyDigest(root:string,rows:Preparation[]):string {
  return sha(canonicalEvidence(rows.map(r=>({requestId:r.requestId,sha256:sha(readRegular(path.join(root,r.requestId+'.json'),16384,true))})).sort((a,b)=>a.requestId.localeCompare(b.requestId))));
}
function records(root:string,c:ToolchainPreparationContext):Preparation[] {
  canonicalPath(root,true);if(!fs.existsSync(root)){if(c.historicalRecordsDigest)reject('TOOLCHAIN_PREPARATION_IDENTITY','Retained history is missing');return[];}directory(root);
  const names=fs.readdirSync(root);if(names.length>1000)reject('TOOLCHAIN_PREPARATION_LIMIT','Retained preparation limit reached');
  const rows=names.map(name=>{
    if(!/^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(name))reject('TOOLCHAIN_PREPARATION_UNSAFE','Unexpected preparation entry');
    const r=record(JSON.parse(readRegular(path.join(root,name),16384,true).toString()));
    exact(r,['schema','requestId','workspaceId','workspaceRoot','installationDigest','lockDigest','status','startedAt','completedAt','diagnostic']);
    if(r.schema!=='evopilot-toolchain-preparation/v1'||name!==r.requestId+'.json'||!['RUNNING','SUCCEEDED','FAILED'].includes(String(r.status))||!Number.isFinite(Date.parse(String(r.startedAt)))||!/^sha256:[a-f0-9]{64}$/.test(String(r.lockDigest))||!/^[a-f0-9]{64}$/.test(String(r.installationDigest))||
      (r.status==='RUNNING'?(r.completedAt!==null||r.diagnostic!==null):!Number.isFinite(Date.parse(String(r.completedAt))))||
      (r.status==='FAILED'?!/^TOOLCHAIN_[A-Z0-9_]+$/.test(String(r.diagnostic)):r.diagnostic!==null))reject('TOOLCHAIN_PREPARATION_INVALID','Malformed retained preparation');
    if(r.workspaceId!==c.workspaceId||typeof r.workspaceRoot!=='string'||!path.isAbsolute(r.workspaceRoot)||path.normalize(r.workspaceRoot)!==r.workspaceRoot)reject('TOOLCHAIN_PREPARATION_IDENTITY','Retained preparation belongs to another Workspace');
    return r as unknown as Preparation;
  }).sort((a,b)=>a.startedAt.localeCompare(b.startedAt)||a.requestId.localeCompare(b.requestId));
  const historical=rows.filter(r=>r.workspaceRoot!==c.workspaceRoot);
  if((historical.length||c.historicalRecordsDigest)&&historyDigest(root,historical)!==c.historicalRecordsDigest)reject('TOOLCHAIN_PREPARATION_IDENTITY','Historical preparation differs from the selected relocation binding');
  return rows;
}
/** Only the verified relocation assembler places this read-only byte binding
 * into the new protected operator configuration. No receipt is rewritten. */
export function prepareToolchainHistoryDigest(c:ToolchainPreparationContext):string|undefined {
  const root=rootFor(c),all=records(root,c);return all.length?historyDigest(root,all):undefined;
}
const publicRecord=(root:string,r:Preparation)=>({...r,historical:r.workspaceRoot!==path.dirname(root),status:r.status==='RUNNING'&&!active.has(path.join(root,r.requestId))?'UNKNOWN':r.status,nextAction:r.status==='FAILED'?'review_failure_before_new_request':'toolchain_inspect',authority:false});
export function inspectToolchainPreparation(c:ToolchainPreparationContext){
  const root=rootFor(c),all=records(root,c);return all.length?publicRecord(root,all.at(-1)!):null;
}
/** Inspection is passive: no download, service start, owner mutation or journal
 * write. A historical successful request does not substitute for current bytes. */
export function inspectWorkspaceToolchain(c:ToolchainPreparationContext){
  const lock=inspectBundledToolchainLock(),preparation=inspectToolchainPreparation(c);
  try{return{ready:true,lock,toolchain:inspectNativeToolchain({cacheRoot:path.join(c.workspaceRoot,'native-toolchain')}),preparation,authority:false};}
  catch(error){
    const code=error&&typeof error==='object'&&'code' in error?error.code:undefined;
    if(!['ENOENT','TOOLCHAIN_NOT_READY'].includes(String(code)))throw error;
    return{ready:false,lock,preparation,diagnostic:'TOOLCHAIN_NOT_READY',nextAction:preparation&&['RUNNING','UNKNOWN'].includes(preparation.status)?'toolchain_inspect':'toolchain_prepare',authority:false};
  }
}
/** The immutable request is acknowledged before bounded downloads complete.
 * The owning Host retains the promise; an independent reader reports UNKNOWN
 * until the original terminal receipt exists, without resubmitting downloads. */
export async function startToolchainPreparation(c:ToolchainPreparationContext,requestId:string,maintain:Maintenance){
  c=structuredClone(c);slug(requestId);const root=rootFor(c),lock=inspectBundledToolchainLock(),key=path.join(root,requestId);
  const prior=records(root,c),previous=prior.find(r=>r.requestId===requestId);
  if(previous){
    if(previous.installationDigest!==c.installationDigest||previous.lockDigest!==lock.lockDigest)reject('REQUEST_CONFLICT','Original preparation belongs to another installation or lock');
    return{preparation:publicRecord(root,previous),reused:true,authority:false};
  }
  if(prior.some(r=>r.status==='RUNNING'))reject('TOOLCHAIN_PREPARATION_UNCERTAIN','Inspect the retained preparation; do not select a replacement request');
  const pending=active.get(key);
  if(pending){await pending.admission;return{preparation:publicRecord(root,records(root,c).find(r=>r.requestId===requestId)!),reused:true,authority:false};}
  let admit!:()=>void,deny!:(error:unknown)=>void;
  const admission=new Promise<void>((resolve,rejectPromise)=>{admit=resolve;deny=rejectPromise;});
  // Start on the next microtask so the in-process handle exists before any
  // admission callback, including an immediately ready verified cache.
  const task=Promise.resolve().then(()=>maintain(async()=>{
    directory(root,true);const current=records(root,c);
    if(current.some(r=>r.status==='RUNNING'))reject('TOOLCHAIN_PREPARATION_UNCERTAIN','Another original preparation remains unresolved');
    if(current.some(r=>r.requestId===requestId))reject('REQUEST_CONFLICT','Preparation was concurrently recorded');
    if(current.length>=1000)reject('TOOLCHAIN_PREPARATION_LIMIT','Retained preparation limit reached');
    const r:Preparation={schema:'evopilot-toolchain-preparation/v1',workspaceRoot:c.workspaceRoot,workspaceId:c.workspaceId,installationDigest:c.installationDigest,requestId,lockDigest:lock.lockDigest,status:'RUNNING',startedAt:new Date().toISOString(),completedAt:null,diagnostic:null};
    save(path.join(root,requestId+'.json'),r,false);admit();
    try{await prepareNativeToolchain({cacheRoot:path.join(c.workspaceRoot,'native-toolchain')});r.status='SUCCEEDED';}
    catch(error){r.status='FAILED';r.diagnostic=diagnostic(error);}
    r.completedAt=new Date().toISOString();save(path.join(root,requestId+'.json'),r);
  })).catch(deny).finally(()=>active.delete(key));
  active.set(key,{admission,task});await admission;
  return{preparation:publicRecord(root,records(root,c).find(r=>r.requestId===requestId)!),reused:false,authority:false};
}
