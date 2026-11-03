import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {canonical,digest,exact,record,reject,ServiceError,slug,string} from '../server/errors.js';
import {ensurePrivateRoot,hostHeaders,privateFile,readPrivateJson,type HostConnection} from '../server/security.js';
import {readLegacyBinding} from '../compat/gateway.js';
import {readLegacyProviderConfiguration} from '../compat/registered-providers.js';

/** Operator-only process management. This module is never imported by the HTTP
 * dispatcher, an execution adapter or the MCP service. No project can select a
 * program, shell command, launchd label or process id through a service request. */
export interface UserServiceSpecification {
  schema:'runtime-user-service/v1';root:string;packageRoot:string;version:string;
  nodeExecutable:string;nodeSha256:string;workspaceId:string;projectId:string;
  principalId:string;tokenRef:string;port:number;integrationsRef:string|null;
  legacyRef?:string|null;
  legacyProviders?:{ref:string;digest:string}|null;
}
export interface LaunchdObservation {registered:boolean;running:boolean;pid:number|null;lastExitCode:number|null;label:string;}
export interface UserServiceObservation extends LaunchdObservation {identity:Record<string,unknown>|null;url:string;}
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const xml=(v:string)=>v.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const path=(v:string)=>{string(v,4096);if(!isAbsolute(v)||resolve(v)!==v||realpathSync(v)!==v)reject('INSTALLATION_PATH','Use canonical existing installation paths');return v;};
export function userServiceLabel(spec:UserServiceSpecification):string{return'io.evopilot.runtime.'+slug(spec.workspaceId)+'.'+sha(spec.root).slice(0,16);}
function validate(spec:UserServiceSpecification):void{
  exact(record(spec),['schema','root','packageRoot','version','nodeExecutable','nodeSha256','workspaceId','projectId','principalId','tokenRef','port','integrationsRef'],['legacyRef','legacyProviders']);
  if(spec.schema!=='runtime-user-service/v1'||process.platform!=='darwin'||!Number.isSafeInteger(spec.port)||spec.port<1024||spec.port>65535)reject('SERVICE_PLATFORM','This user service requires macOS and an explicit unprivileged port');
  ensurePrivateRoot(path(spec.root));path(spec.packageRoot);path(spec.nodeExecutable);path(spec.tokenRef);
  slug(spec.workspaceId);slug(spec.projectId);slug(spec.principalId);string(spec.version,128);
  const node=lstatSync(spec.nodeExecutable);if(!node.isFile()||(node.mode&0o022)!==0||(node.mode&0o111)===0||node.size>268435456||sha(readFileSync(spec.nodeExecutable))!==spec.nodeSha256)reject('SERVICE_EXECUTABLE_CHANGED','The selected Node executable has changed');
  const cli=join(spec.packageRoot,'dist/server/cli.js');path(cli);if(!lstatSync(cli).isFile()||!readFileSync(cli,'utf8').startsWith('#!/usr/bin/env node\n'))reject('SERVICE_EXECUTABLE_CHANGED','The compiled Runtime service entry is missing');
  const pkg=record(JSON.parse(readFileSync(join(spec.packageRoot,'package.json'),'utf8')));if(pkg.name!=='@evopilot-next/runtime'||pkg.version!==spec.version)reject('SERVICE_VERSION','The Runtime package version differs from the installation');
  if(spec.integrationsRef!==null){path(spec.integrationsRef);readPrivateJson(spec.integrationsRef);}
  // Stop/inspection must still identify our own launchd job if the binding was
  // lost or changed. Validate its contents only before startup/live readback.
  if(spec.legacyRef!=null){string(spec.legacyRef,4096);if(!isAbsolute(spec.legacyRef)||resolve(spec.legacyRef)!==spec.legacyRef)reject('INSTALLATION_PATH','Use a canonical legacy binding reference');}
  if(spec.legacyProviders!=null){const p=record(spec.legacyProviders);exact(p,['ref','digest']);string(p.ref,4096);if(!spec.legacyRef||!isAbsolute(String(p.ref))||resolve(String(p.ref))!==p.ref||!/^[a-f0-9]{64}$/.test(string(p.digest,64)))reject('INSTALLATION_PLAN','Original providers require an exact migration binding and pinned configuration');}
  // Validate the scoped credential without returning or recording its value.
  hostHeaders(connection(spec,'installation-pending'));
}
function connection(spec:UserServiceSpecification,serviceId:string):HostConnection{return{schema:'runtime-host-connection/v1',origin:'http://127.0.0.1:'+spec.port,workspaceId:spec.workspaceId,projectId:spec.projectId,principalId:spec.principalId,serviceId,version:spec.version,tokenRef:spec.tokenRef};}
function args(spec:UserServiceSpecification):string[]{return[spec.nodeExecutable,join(spec.packageRoot,'dist/server/cli.js'),'serve','--state-root',join(spec.root,'data'),'--workspace-id',spec.workspaceId,'--port',String(spec.port),...(spec.integrationsRef===null?[]:['--integrations-ref',spec.integrationsRef]),...(spec.legacyRef==null?[]:['--legacy-ref',spec.legacyRef]),...(spec.legacyProviders==null?[]:['--legacy-providers-ref',spec.legacyProviders.ref,'--legacy-providers-digest',spec.legacyProviders.digest])];}
function selectedProviders(spec:UserServiceSpecification):void{
  if(!spec.legacyProviders)return;
  const selected=readLegacyProviderConfiguration(spec.legacyProviders.ref);
  if(digest(selected)!==spec.legacyProviders.digest)reject('LEGACY_PROVIDER_CHANGED','Original provider selection differs from the immutable service specification',409);
  if(selected.workspaceId!==spec.workspaceId||!selected.projects.includes(spec.projectId)||selected.legacyBindingRef!==spec.legacyRef)reject('LEGACY_PROVIDER_SCOPE','Original provider selection belongs to a different service migration',403);
}
export function userServicePlist(spec:UserServiceSpecification):string{
  validate(spec);
  return renderUserServicePlist(spec);
}
/** Pure material renderer for an operator-validated configuration transition.
 * It grants no startup authority; every live service entry still validates. */
export function renderUserServicePlist(spec:UserServiceSpecification):string{
  return'<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n'+
    '<key>Label</key><string>'+xml(userServiceLabel(spec))+'</string>\n<key>ProgramArguments</key><array>'+args(spec).map(v=>'<string>'+xml(v)+'</string>').join('')+'</array>\n'+
    '<key>WorkingDirectory</key><string>'+xml(spec.packageRoot)+'</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><false/>\n<key>Umask</key><integer>63</integer>\n'+
    '<key>StandardOutPath</key><string>'+xml(join(spec.root,'service.stdout.log'))+'</string>\n<key>StandardErrorPath</key><string>'+xml(join(spec.root,'service.stderr.log'))+'</string>\n</dict></plist>\n';
}
interface CommandResult {code:number;stdout:string;stderr:string;}
function launchctl(argv:string[]):Promise<CommandResult>{
  return new Promise((resolve,rejectPromise)=>execFile('/bin/launchctl',argv,{encoding:'utf8',timeout:10000,maxBuffer:262144,shell:false},(error,stdout,stderr)=>{
    if(error&&(error.killed||typeof error.code!=='number')){rejectPromise(new ServiceError('SERVICE_OPERATION_UNKNOWN','Inspect the original launchd operation before retrying',503));return;}
    resolve({code:error?Number(error.code):0,stdout,stderr});
  }));
}
const domain=()=>'gui/'+process.getuid!();
const target=(spec:UserServiceSpecification)=>domain()+'/'+userServiceLabel(spec);
const plistPath=(spec:UserServiceSpecification)=>join(spec.root,'service.plist');
export async function inspectUserService(spec:UserServiceSpecification):Promise<LaunchdObservation>{
  validate(spec);const label=userServiceLabel(spec),result=await launchctl(['print',target(spec)]);
  if(result.code!==0){
    if(/Could not find service/.test(result.stderr)&&result.stderr.includes('"'+label+'"'))return{label,registered:false,running:false,pid:null,lastExitCode:null};
    return reject('SERVICE_INSPECTION_FAILED','Could not establish the selected launchd service identity',503);
  }
  const lines=result.stdout.split('\n').map(v=>v.trim()),start=lines.indexOf('arguments = {'),end=lines.indexOf('}',start);
  if(!lines.includes('path = '+plistPath(spec))||!lines.includes('program = '+spec.nodeExecutable)||start<0||end<start||canonical(lines.slice(start+1,end))!==canonical(args(spec)))reject('SERVICE_IDENTITY_CONFLICT','The launchd label belongs to a different service',409);
  const read=(key:string)=>{const line=lines.find(v=>v.startsWith(key+' = '));return line?line.slice(key.length+3):null;},pid=read('pid'),exit=read('last exit code');
  return{label,registered:true,running:read('state')==='running',pid:pid&&/^\d+$/.test(pid)?Number(pid):null,lastExitCode:exit&&/^-?\d+$/.test(exit)?Number(exit):null};
}
/** A live read proves service readiness only. Actual Codex plugin loading is a
 * separate installation check and cannot be inferred from this observation. */
export async function observeUserService(spec:UserServiceSpecification):Promise<UserServiceObservation>{
  selectedProviders(spec);
  const observed=await inspectUserService(spec),url=connection(spec,'installation-pending').origin;
  if(!observed.running)return{...observed,identity:null,url};
  const response=await fetch(url+'/api/v1/status?projectId='+encodeURIComponent(spec.projectId),{headers:hostHeaders(connection(spec,'installation-pending')),signal:AbortSignal.timeout(3000),redirect:'error'});
  if(!response.ok)reject('SERVICE_NOT_READY','The owned Runtime service is not ready',503);
  if(!response.headers.get('content-type')?.startsWith('application/json')||!response.body)reject('SERVICE_NOT_READY','The owned service did not return JSON',503);
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>65536)reject('SERVICE_IDENTITY_CONFLICT','Unexpected service response',503);chunks.push(next.value);}}catch(error){await reader.cancel();throw error;}finally{reader.releaseLock();}
  const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
  const identity=record(record(JSON.parse(text)).result);
  if(identity.product!=='evopilot-runtime'||identity.contract!=='runtime-service/v1'||identity.workspaceId!==spec.workspaceId||identity.projectId!==spec.projectId||identity.version!==spec.version||identity.independentLlm!==false)reject('SERVICE_IDENTITY_CONFLICT','Live Runtime identity differs from the selected installation',409);
  if(spec.legacyRef!=null){
    const binding=readLegacyBinding(spec.legacyRef),legacy=record(identity.legacy);
    if(binding.workspaceId!==spec.workspaceId||binding.serviceId!==identity.serviceId||legacy.bound!==true||legacy.migrationDigest!==binding.migrationDigest||legacy.revisionNamespace!=='original-family')reject('SERVICE_IDENTITY_CONFLICT','Live Runtime migration differs from the selected binding',409);
  }else if(identity.legacy!==null)reject('SERVICE_IDENTITY_CONFLICT','An unselected legacy workspace is bound to this service',409);
  const log=join(spec.root,'service.stdout.log');privateFile(log);if(lstatSync(log).size>1048576)reject('SERVICE_LOG_LIMIT','Service startup log exceeds the inspection limit');
  const ready=readFileSync(log,'utf8').split('\n').filter(Boolean).map(line=>{try{return record(JSON.parse(line));}catch{return{};}}).filter(v=>v.ready===true).at(-1);
  if(!ready||ready.serviceId!==identity.serviceId||ready.workspaceId!==identity.workspaceId||ready.version!==identity.version||ready.url!==url)reject('SERVICE_IDENTITY_CONFLICT','Live service lacks the matching owned startup receipt',409);
  return{...observed,identity,url};
}
function retainExact(path:string,bytes:string):void{
  if(existsSync(path)){privateFile(path);if(readFileSync(path,'utf8')!==bytes)reject('INSTALLATION_CHANGED','Existing service material differs; do not overwrite it',409);}
  else writeFileSync(path,bytes,{mode:0o600,flag:'wx'});
}
export async function startUserService(spec:UserServiceSpecification):Promise<UserServiceObservation>{
  validate(spec);retainExact(join(spec.root,'service-specification.json'),canonical(spec)+'\n');
  if(spec.legacyRef!=null&&readLegacyBinding(spec.legacyRef).workspaceId!==spec.workspaceId)reject('SERVICE_IDENTITY_CONFLICT','Legacy binding belongs to another workspace',409);
  selectedProviders(spec);
  const before=await inspectUserService(spec);if(before.running)return observeUserService(spec);
  retainExact(plistPath(spec),userServicePlist(spec));for(const name of ['service.stdout.log','service.stderr.log'])privateFile(join(spec.root,name),true);
  const result=await launchctl(before.registered?['kickstart',target(spec)]:['bootstrap',domain(),plistPath(spec)]);
  if(result.code!==0)reject('SERVICE_START_FAILED','launchd did not confirm startup; inspect the retained service before retrying',503);
  const deadline=Date.now()+10000;let observation:UserServiceObservation|undefined;
  while(Date.now()<deadline){
    try{observation=await observeUserService(spec);if(observation.running&&observation.identity)return observation;}catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='SERVICE_IDENTITY_CONFLICT')throw error;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  return reject('SERVICE_NOT_READY','The owned service has not produced matching live readiness; preserve its logs',503);
}
export async function stopUserService(spec:UserServiceSpecification):Promise<LaunchdObservation>{
  const before=await inspectUserService(spec);if(!before.registered)return before;
  const result=await launchctl(['bootout',target(spec)]);if(result.code!==0)reject('SERVICE_STOP_UNKNOWN','Inspect the original service before repeating a stop',503);
  const after=await inspectUserService(spec);if(after.registered)reject('SERVICE_STOP_UNKNOWN','The service is still registered',503);
  if(before.pid){
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){try{process.kill(before.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return after;return reject('SERVICE_STOP_UNKNOWN','Cannot verify the original process exit',503);}await new Promise(resolve=>setTimeout(resolve,50));}
    return reject('SERVICE_STOP_UNKNOWN','The original service process has not exited',503);
  }
  return after;
}
