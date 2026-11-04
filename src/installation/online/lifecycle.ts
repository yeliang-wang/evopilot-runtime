/** Local-only ownership of the independent online worker. No HTTP operation
 * imports this launcher; a descriptor cannot start Runtime or select a policy. */
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {canonical,digest,exact,record,reject,ServiceError,string} from '../../server/errors.js';
import {readPrivateJson} from '../../server/security.js';
import {canonicalPath,readRegular} from '../../compat/project/files.js';
import {withWorkspaceLease} from '../../compat/workspace-lease.js';
import {createRuntimeHttpClient} from '../../host/client.js';
import {maintenanceLocation} from '../workspace/snapshot.js';
import {mkdir,save,syncDirectory} from '../workspace/backup.js';
import type {UserServiceSpecification} from '../service.js';
import {selectOnlineWorker,validateOnlineWorkerSelection,requireCurrentOnlineWorkerSelection,type OnlineWorkerSelection,type OnlineWorkerInput} from './selection.js';

const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const xml=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const code=(e:unknown)=>e&&typeof e==='object'&&'code'in e&&typeof e.code==='string'&&/^[A-Z_0-9]{1,80}$/.test(e.code)?e.code:'ONLINE_WORKER_ERROR';
export const onlineWorkerRoot=(s:OnlineWorkerSelection)=>s.installation.binding!.workspaceRoot+'.evopilot-online-worker';
export const onlineWorkerLabel=(s:OnlineWorkerSelection)=>'io.evopilot.online.'+sha(s.installation.binding!.workspaceRoot+'\0'+s.installation.workspaceId).slice(0,24);
const domain=()=>'gui/'+process.getuid!();
const target=(s:OnlineWorkerSelection)=>domain()+'/'+onlineWorkerLabel(s);
export interface OnlineWorkerOwner {schema:'runtime-online-worker-owner/v1';selection:OnlineWorkerSelection;nodeExecutable:string;nodeSha256:string;entry:string;nonce:string;plistDigest:string;ownerDigest:string;}
const attemptRoot=(o:Pick<OnlineWorkerOwner,'selection'|'nonce'>)=>path.join(onlineWorkerRoot(o.selection),'attempts',o.nonce);
const args=(o:OnlineWorkerOwner)=>[o.nodeExecutable,o.entry,path.join(attemptRoot(o),'owner.json'),o.nonce];
export function writeOnlineStatus(ref:string,value:unknown):void {
  canonicalPath(ref,true);if(fs.existsSync(ref))readRegular(ref,8388608,true);
  const temporary=path.join(path.dirname(ref),'.online-'+randomUUID()),fd=fs.openSync(temporary,'wx',0o600);
  try{fs.writeFileSync(fd,canonical(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temporary,ref);syncDirectory(path.dirname(ref));
}
export function readOnlineWorkerOwner(ref:string):OnlineWorkerOwner {
  const o=record(JSON.parse(readRegular(ref,8388608,true).toString()));exact(o,['schema','selection','nodeExecutable','nodeSha256','entry','nonce','plistDigest','ownerDigest']);
  validateOnlineWorkerSelection(o.selection);const s=o.selection;
  const {ownerDigest,...body}=o;
  if(o.schema!=='runtime-online-worker-owner/v1'||digest(body)!==ownerDigest||!/^[-a-zA-Z0-9]{36}$/.test(string(o.nonce,36))||![path.join(onlineWorkerRoot(s),'runtime-owner.json'),path.join(onlineWorkerRoot(s),'attempts',String(o.nonce),'owner.json')].includes(ref)||o.entry!==path.join(s.installation.serviceRoot,'package/dist/installation/online/worker.js')||!/^[a-f0-9]{64}$/.test(string(o.nodeSha256,64)))reject('ONLINE_WORKER_OWNER','The retained worker identity is invalid');
  string(o.nodeExecutable,4096);
  if(sha(readRegular(path.join(onlineWorkerRoot(s),'attempts',String(o.nonce),'job.plist'),1048576,true))!==o.plistDigest)reject('ONLINE_WORKER_OWNER','The retained worker job differs');
  return o as unknown as OnlineWorkerOwner;
}
function plist(o:Omit<OnlineWorkerOwner,'plistDigest'|'ownerDigest'>):string {
  const root=onlineWorkerRoot(o.selection),argv=[o.nodeExecutable,o.entry,path.join(attemptRoot(o),'owner.json'),o.nonce];
  return'<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>'+[
    '<key>Label</key><string>'+xml(onlineWorkerLabel(o.selection))+'</string>',
    '<key>ProgramArguments</key><array>'+argv.map(v=>'<string>'+xml(v)+'</string>').join('')+'</array>',
    '<key>WorkingDirectory</key><string>'+xml(path.join(o.selection.installation.serviceRoot,'package'))+'</string>',
    '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>ExitTimeOut</key><integer>30</integer><key>Umask</key><integer>63</integer>',
    '<key>StandardOutPath</key><string>'+xml(path.join(root,'runtime-stdout.log'))+'</string>',
    '<key>StandardErrorPath</key><string>'+xml(path.join(root,'runtime-stderr.log'))+'</string>',
  ].join('')+'</dict></plist>\n';
}
function launch(argv:string[]):Promise<{code:number;stdout:string;stderr:string}> {
  if(process.platform!=='darwin')reject('ONLINE_SUPERVISOR_UNSUPPORTED','This independent worker requires macOS launchd');
  return new Promise((resolve,rejectPromise)=>execFile('/bin/launchctl',argv,{encoding:'utf8',timeout:10000,maxBuffer:262144,shell:false},(error,stdout,stderr)=>{
    if(error&&(error.killed||typeof error.code!=='number')){rejectPromise(new ServiceError('ONLINE_WORKER_OPERATION_UNKNOWN','Inspect the original owned job before repeating the operation',503));return;}
    resolve({code:error?Number(error.code):0,stdout,stderr});
  }));
}
async function observed(s:OnlineWorkerSelection){
  validateOnlineWorkerSelection(s);const root=onlineWorkerRoot(s);maintenanceLocation(root,true);
  const ownerRef=path.join(root,'runtime-owner.json'),owner=fs.existsSync(ownerRef)?readOnlineWorkerOwner(ownerRef):null,label=onlineWorkerLabel(s),result=await launch(['print',target(s)]);
  if(result.code!==0){if(result.stderr.includes('Could not find service')&&result.stderr.includes('"'+label+'"'))return{label,registered:false,running:false,pid:null as number|null,lastExitCode:null as number|null,owner};return reject('ONLINE_WORKER_INSPECTION','Could not determine the selected worker state',503);}
  const lines=result.stdout.split('\n').map(v=>v.trim()),start=lines.indexOf('arguments = {'),end=lines.indexOf('}',start);
  if(!owner||!lines.includes('path = '+path.join(attemptRoot(owner),'job.plist'))||!lines.includes('program = '+owner.nodeExecutable)||start<0||end<start||canonical(lines.slice(start+1,end))!==canonical(args(owner)))reject('ONLINE_WORKER_NOT_OWNED','The launchd label belongs to a different worker; no process was controlled',409);
  const field=(key:string)=>lines.find(v=>v.startsWith(key+' = '))?.slice(key.length+3),pid=field('pid'),exit=field('last exit code');
  return{label,registered:true,running:field('state')==='running',pid:pid&&/^\d+$/.test(pid)?Number(pid):null,lastExitCode:exit&&/^-?\d+$/.test(exit)?Number(exit):null,owner};
}
export async function inspectOnlineWorker(s:OnlineWorkerSelection):Promise<Record<string,unknown>> {
  const o=await observed(s),ref=path.join(onlineWorkerRoot(s),'runtime-status.json');let status:Record<string,unknown>|null=null;
  if(fs.existsSync(ref))status=record(JSON.parse(readRegular(ref,8388608,true).toString()));
  const statusCurrent=!!o.owner&&status?.nonce===o.owner.nonce&&status?.selectionDigest===o.owner.selection.selectionDigest;
  let configurationCurrent=true,configurationError:string|null=null;try{requireCurrentOnlineWorkerSelection(s);}catch(error){configurationCurrent=false;configurationError=code(error);}
  const matchesSelection=!o.owner||o.owner.selection.selectionDigest===s.selectionDigest;
  return{label:o.label,registered:o.registered,running:o.running,pid:o.pid,lastExitCode:o.lastExitCode,matchesSelection,configurationCurrent,configurationError,statusCurrent,ready:!!o.pid&&o.running&&matchesSelection&&configurationCurrent&&statusCurrent&&status?.pid===o.pid&&status.state==='READY'&&typeof status.heartbeatAt==='number'&&Date.now()-status.heartbeatAt<15000,status,authority:false};
}
export async function startOnlineWorker(s:OnlineWorkerSelection,attemptId:string=randomUUID()):Promise<Record<string,unknown>> {
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(attemptId))reject('ONLINE_WORKER_ARGUMENTS','Use the original local worker attempt identity');
  requireCurrentOnlineWorkerSelection(s);const b=s.installation.binding!;
  return withWorkspaceLease({workspaceRoot:b.workspaceRoot,workspaceId:b.workspaceId},'online-start-'+randomUUID(),async()=>{
    requireCurrentOnlineWorkerSelection(s);const before=await observed(s);
    if(before.registered){if(before.owner?.selection.selectionDigest!==s.selectionDigest)reject('ONLINE_WORKER_SELECTION_CHANGED','Inspect or stop the original worker before selecting different configuration',409);return{started:false,...await inspectOnlineWorker(s)};}
    for(const h of s.hosts)await createRuntimeHttpClient(h.connectionRef).status();
    requireCurrentOnlineWorkerSelection(s);
    const root=onlineWorkerRoot(s);mkdir(root);mkdir(path.join(root,'attempts'));
    const specification=readPrivateJson(path.join(s.installation.serviceRoot,'service-specification.json')) as UserServiceSpecification;
    canonicalPath(specification.nodeExecutable);const node=fs.lstatSync(specification.nodeExecutable);
    if(!node.isFile()||(node.mode&0o022)!==0||sha(fs.readFileSync(specification.nodeExecutable))!==specification.nodeSha256)reject('ONLINE_WORKER_EXECUTABLE','The installed Node interpreter changed');
    if(fs.existsSync(path.join(root,'attempts',attemptId)))reject('ONLINE_WORKER_ATTEMPT_USED','Inspect the retained attempt instead of dispatching it again',409);
    const body={schema:'runtime-online-worker-owner/v1' as const,selection:structuredClone(s),nodeExecutable:specification.nodeExecutable,nodeSha256:specification.nodeSha256,entry:path.join(s.installation.serviceRoot,'package/dist/installation/online/worker.js'),nonce:attemptId};
    const material=plist(body),withPlist={...body,plistDigest:sha(material)},owner={...withPlist,ownerDigest:digest(withPlist)},attempt=path.join(root,'attempts',owner.nonce);mkdir(attempt);
    save(path.join(attempt,'owner.json'),owner);fs.writeFileSync(path.join(attempt,'job.plist'),material,{mode:0o600,flag:'wx',flush:true});syncDirectory(attempt);
    // Retain every attempt before replacing only the current worker pointers.
    writeOnlineStatus(path.join(root,'runtime-owner.json'),owner);
    const job=path.join(attempt,'job.plist');syncDirectory(attempt);syncDirectory(root);
    writeOnlineStatus(path.join(root,'runtime-status.json'),{nonce:owner.nonce,selectionDigest:s.selectionDigest,state:'STARTING',pid:null,heartbeatAt:Date.now(),lastTickAt:null,scopes:[],diagnostic:null,authority:false});
    for(const name of ['runtime-stdout.log','runtime-stderr.log']){const file=path.join(root,name);if(fs.existsSync(file))readRegular(file,8388608,true);else fs.writeFileSync(file,'',{mode:0o600,flag:'wx'});}
    save(path.join(attempt,'start.json'),{operation:'bootstrap',selectionDigest:s.selectionDigest,nonce:owner.nonce,authority:false});
    try{const result=await launch(['bootstrap',domain(),job]);if(result.code!==0)reject('ONLINE_WORKER_START','launchd did not confirm startup; inspect the retained job',503);const resultValue={started:true,label:onlineWorkerLabel(s),selectionDigest:s.selectionDigest,nonce:owner.nonce,independentOfCodex:true,runtimeStarted:false,monitoringSelected:false,authority:false};save(path.join(attempt,'start-result.json'),resultValue);return resultValue;}
    catch(error){save(path.join(attempt,'start-error.json'),{code:code(error),outcome:'INSPECT_ORIGINAL',automaticRetry:false});throw error;}
  });
}
export async function stopOnlineWorker(s:OnlineWorkerSelection,uninstall=false):Promise<Record<string,unknown>> {
  const before=await observed(s);if(before.registered&&before.owner?.selection.selectionDigest!==s.selectionDigest)reject('ONLINE_WORKER_SELECTION_CHANGED','Use the original retained worker selection to stop its job',409);
  if(!before.registered)return{stopped:false,uninstalled:uninstall,registered:false,label:before.label,evidencePreserved:true,authority:false};
  const root=onlineWorkerRoot(s);mkdir(path.join(root,'operations'));const request=path.join(root,'operations',randomUUID());mkdir(request);save(path.join(request,'request.json'),{operation:uninstall?'uninstall':'stop',selectionDigest:s.selectionDigest,nonce:before.owner!.nonce,pid:before.pid,authority:false});
  try{
    const result=await launch(['bootout',target(s)]);if(result.code!==0)reject('ONLINE_WORKER_STOP_UNKNOWN','Inspect the original worker before repeating stop',503);
    const deadline=Date.now()+35000;
    for(;;){const current=await observed(s);let alive=false;if(before.pid)try{process.kill(before.pid,0);alive=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
      if(!current.registered&&!alive){const value={stopped:true,uninstalled:uninstall,registered:false,label:before.label,evidencePreserved:true,authority:false};save(path.join(request,'result.json'),value);return value;}
      if(Date.now()>deadline)reject('ONLINE_WORKER_STOP_UNKNOWN','Original worker has not exited; retain its identity',503);await new Promise(resolve=>setTimeout(resolve,100));
    }
  }catch(error){save(path.join(request,'error.json'),{code:code(error),outcome:'INSPECT_ORIGINAL',automaticRetry:false});throw error;}
}
export async function onlineWorkerCommand(argv:string[]):Promise<unknown>{
  const [operation,flag,ref,...rest]=argv;
  if(rest.length||!ref||!['select','inspect','start','stop','uninstall'].includes(operation)||flag!==(operation==='select'?'--input-ref':'--selection-ref'))reject('ONLINE_WORKER_ARGUMENTS','Use select --input-ref or inspect|start|stop|uninstall --selection-ref with a protected exact descriptor');
  const value=readPrivateJson(ref);if(operation==='select')return selectOnlineWorker(value as OnlineWorkerInput);validateOnlineWorkerSelection(value);
  return operation==='inspect'?inspectOnlineWorker(value):operation==='start'?startOnlineWorker(value):stopOnlineWorker(value,operation==='uninstall');
}
