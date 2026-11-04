#!/usr/bin/env node
/** Independent selected-schedule observer. Uses published owner Host APIs and
 * the existing authenticated Runtime HTTP service; never opens Runtime state. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {canonical,record,reject} from '../../server/errors.js';
import {readRegular} from '../../compat/project/files.js';
import {createRuntimeHttpClient} from '../../host/client.js';
import {openLegacyOwnerRoutes,type LegacyOwnerRoutes} from '../../host/legacy-owners.js';
import {readOnlineConfiguration} from '../../host/online.js';
import {ONLINE_LIMITS,type OnlineBinding,type OnlineAlertBatch} from '../../../vendor/compatibility/online/v1/online.mjs';
import type {NativeScope} from '../../../vendor/compatibility/v1/native.mjs';
import {requireCurrentOnlineWorkerSelection} from './selection.js';
import {readOnlineWorkerOwner,onlineWorkerRoot,inspectOnlineWorker,writeOnlineStatus} from './lifecycle.js';

const errorCode=(e:unknown)=>e&&typeof e==='object'&&'code'in e&&typeof e.code==='string'&&/^[A-Z_0-9]{1,80}$/.test(e.code)?e.code:'ONLINE_WORKER_ERROR';
export async function runOnlineWorker(ownerRef:string,nonce:string):Promise<{stop():Promise<void>}> {
  const owner=readOnlineWorkerOwner(ownerRef),selection=owner.selection,root=onlineWorkerRoot(selection);
  if(owner.nonce!==nonce||ownerRef!==path.join(root,'attempts',nonce,'owner.json')||fs.realpathSync(process.execPath)!==owner.nodeExecutable||createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex')!==owner.nodeSha256||fileURLToPath(new URL('../../../',import.meta.url)).replace(/\/$/,'')!==path.join(selection.installation.serviceRoot,'package'))reject('ONLINE_WORKER_IDENTITY','The worker must run from its exact installed owner record');
  const observed=await inspectOnlineWorker(selection);if(observed.pid!==process.pid||observed.matchesSelection!==true)reject('ONLINE_WORKER_NOT_OWNED','Only the currently owned launchd process can run this worker');
  requireCurrentOnlineWorkerSelection(selection);const configuration=readOnlineConfiguration(selection.configuration,selection.installation.workspaceId);
  const lockRef=path.join(root,'runtime-worker-lock.sqlite');if(fs.existsSync(lockRef))readRegular(lockRef,1048576,true);else fs.writeFileSync(lockRef,'',{mode:0o600,flag:'wx'});
  const lock=new DatabaseSync(lockRef,{allowExtension:false});try{lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}catch{lock.close();reject('ONLINE_WORKER_ACTIVE','Another original online worker still owns this identity',409);}
  const hosts=new Map<string,LegacyOwnerRoutes>();let stopping=false,queued=0,ticking=false,tail:Promise<unknown>=Promise.resolve(),stopPromise:Promise<void>|undefined;
  const status={nonce,selectionDigest:selection.selectionDigest,pid:process.pid,state:'STARTING',heartbeatAt:Date.now(),lastTickAt:null as number|null,scopes:[] as unknown[],diagnostic:null as string|null,authority:false};
  const original=()=>{if(readOnlineWorkerOwner(path.join(root,'runtime-owner.json')).ownerDigest!==owner.ownerDigest)reject('ONLINE_WORKER_IDENTITY','The current worker owner changed');};
  const save=()=>{original();status.heartbeatAt=Date.now();writeOnlineStatus(path.join(root,'runtime-status.json'),status);};
  const fresh=()=>{original();requireCurrentOnlineWorkerSelection(selection);};
  const enqueue=<T>(fn:()=>Promise<T>):Promise<T>=>{
    if(stopping||queued>=16)reject('ONLINE_WORKER_BUSY','The bounded worker queue is unavailable',503);queued++;
    const next=tail.then(async()=>{fresh();const value=await fn();fresh();return value;});tail=next.catch(()=>{}).finally(()=>{queued--;});return next;
  };
  async function ensureHosts():Promise<void>{
    if(hosts.size)return;const opened:LegacyOwnerRoutes[]=[];
    try{for(const h of selection.hosts){const route=await openLegacyOwnerRoutes(h.ownerConfigRef,createRuntimeHttpClient(h.connectionRef),h.ownerConfigDigest);opened.push(route);if(!route.online||route.online.configurationDigest!==configuration.digest)reject('ONLINE_WORKER_SCOPE','Owner online configuration differs');hosts.set(h.projectId,route);}}
    catch(error){hosts.clear();await Promise.allSettled(opened.map(h=>h.close()));throw error;}
  }
  async function call(scope:NativeScope,operation:string,input:Record<string,unknown>={},meta:Record<string,unknown>={}):Promise<unknown>{
    fresh();const host=hosts.get(scope.projectId);if(!host)reject('ONLINE_WORKER_SCOPE','A configured project connection is unavailable');
    return host.call('harness','native',{operation,scope,input,...meta});
  }
  async function ingest(sourceId:string,authorization:string|undefined,body:Buffer):Promise<unknown>{
    await ensureHosts();const first=hosts.values().next().value as LegacyOwnerRoutes;
    return first.online!.receive(sourceId,authorization,body,async batch=>{
      const matches:NativeScope[]=[];
      for(const scope of configuration.settings.scopes){const state=record(await call(scope,'online.inspect'));
        if((batch.alerts as OnlineAlertBatch['alerts']).every(alert=>(state.bindings as OnlineBinding[]).some(b=>b.selected&&b.decision?.decision==='APPROVE'&&b.spec.alertSourceId===batch.sourceId&&b.spec.serviceId===alert.labels.service&&b.spec.environment===alert.labels.environment&&b.spec.deploymentRevision===alert.labels.deployment)))matches.push(scope);
      }
      if(matches.length!==1)reject('ALERT_SCOPE_AMBIGUOUS','Authenticated alerts must match exactly one selected project scope',409);
      const scope=matches[0],host=hosts.get(scope.projectId)!;
      const consume=async(verified:OnlineAlertBatch)=>{
        if(verified.digest!==batch.digest)reject('ALERT_RECEIPT_MISMATCH','Authenticated alert identity changed');
        const state=record(await call(scope,'online.inspect'));
        const receipt=await call(scope,'online.alert.ingest',{sourceId:verified.sourceId,digest:verified.digest},{requestId:'online-alert-'+verified.digest.slice(7),expectedRevision:state.revision});
        return{accepted:true,batchDigest:verified.digest,scope,receipt};
      };
      // Each per-project Host keeps its own trusted transient receiver. For a
      // different selected project, reauthenticate the original bytes there.
      return host===first?consume(batch):host.online!.receive(sourceId,authorization,body,consume);
    });
  }
  const server=http.createServer({maxHeaderSize:8192,requestTimeout:5000,headersTimeout:5000,keepAliveTimeout:1000},async(req,res)=>{
    const send=(statusCode:number,value:unknown)=>{if(!res.destroyed){res.writeHead(statusCode,{'content-type':'application/json','cache-control':'no-store',connection:'close'});res.end(canonical(value));}};
    if(stopping||req.method!=='POST'||req.headers.host!=='127.0.0.1:'+configuration.settings.receiverPort||req.headers.origin!==undefined||req.headers['content-type']!=='application/json'||!/^\/alerts\/[a-z0-9][a-z0-9-]{0,63}$/.test(req.url??'')){send(403,{error:'ALERT_REQUEST'});return;}
    const timer=setTimeout(()=>req.destroy(),5000);
    try{const chunks:Buffer[]=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>ONLINE_LIMITS.responseBytes)reject('ALERT_BODY_LIMIT','Alert request exceeds the fixed bound',413);chunks.push(chunk);}clearTimeout(timer);
      const sourceId=req.url!.slice('/alerts/'.length);send(200,await enqueue(()=>ingest(sourceId,req.headers.authorization,Buffer.concat(chunks))));
    }catch(error){const code=errorCode(error);send(code==='ALERT_UNAUTHORIZED'?403:code==='ALERT_BODY_LIMIT'?413:['ONLINE_WORKER_BUSY','ALERT_IN_PROGRESS'].includes(code)?503:400,{error:code});}
    finally{clearTimeout(timer);}
  });
  server.maxConnections=16;server.on('clientError',(_error,socket)=>socket.destroy());
  try{await new Promise<void>((resolve,rejectPromise)=>{server.once('error',rejectPromise);server.listen(configuration.settings.receiverPort,'127.0.0.1',resolve);});}
  catch(error){lock.close();await Promise.allSettled([...hosts.values()].map(h=>h.close()));throw error;}
  async function tick(){
    if(stopping||ticking)return;ticking=true;
    try{status.scopes=await enqueue(async()=>{await ensureHosts();const result=[];for(const scope of configuration.settings.scopes)result.push({scope,result:await call(scope,'online.tick')});return result;});status.lastTickAt=Date.now();status.state='READY';status.diagnostic=null;}
    catch(error){status.state='BLOCKED';status.diagnostic=errorCode(error);}
    finally{ticking=false;if(!stopping)save();}
  }
  const timer=setInterval(()=>void tick(),configuration.settings.tickSeconds*1000),heartbeat=setInterval(()=>{try{save();}catch{void stop();}},3000);
  async function stop():Promise<void>{
    if(stopPromise)return stopPromise;stopping=true;clearInterval(timer);clearInterval(heartbeat);status.state='STOPPING';try{save();}catch{}
    const closed=new Promise<void>(resolve=>server.close(()=>resolve()));server.closeIdleConnections();
    stopPromise=(async()=>{try{await tail;await Promise.allSettled([...hosts.values()].map(h=>h.close()));await closed;status.state='STOPPED';try{save();}catch{}}finally{lock.close();}})();return stopPromise;
  }
  for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>{void stop().then(()=>process.exit(0),()=>process.exit(1));});
  server.on('error',()=>{status.diagnostic='ONLINE_RECEIVER_ERROR';void stop().then(()=>process.exit(1));});
  save();void tick();return{stop};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{if(process.argv.length!==4)reject('ONLINE_WORKER_ARGUMENTS','Use the fixed retained owner reference and nonce');await runOnlineWorker(process.argv[2],process.argv[3]);}
  catch(error){process.stderr.write(JSON.stringify({error:errorCode(error),authority:false})+'\n');process.exitCode=1;}
}
