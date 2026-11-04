/** Explicit local Host online controls. HTTP never loads this operator; a
 * protected grant, current session and original journal remain distinct. */
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import {canonicalEvidence,digest,exact,record,reject,slug,string} from '../../server/errors.js';
import {readRegular} from '../../compat/project/files.js';
import {withWorkspaceLease} from '../../compat/workspace-lease.js';
import {readLegacyOwnerHostConfiguration} from '../../host/legacy-owners.js';
import {readOnlineConfiguration,validateOnlineSettings} from '../../host/online.js';
import type {WorkspaceOperatorConfiguration,WorkspaceOperatorRoutes} from '../../host/workspace.js';
import {stopUserService,type UserServiceSpecification} from '../service.js';
import {mkdir,save} from '../workspace/backup.js';
import {requireRecoveryServicesStopped} from '../workspace/snapshot.js';
import {prepareOnlineConfiguration,type OnlineConfigurationMaterial} from './configuration.js';
import {applyOnlineConfiguration,inspectOnlineApplication} from './application.js';
import {selectOnlineWorker,type OnlineWorkerSelection} from './selection.js';
import {onlineWorkerRoot,readOnlineWorkerOwner,inspectOnlineWorker,startOnlineWorker,stopOnlineWorker} from './lifecycle.js';

const prefix='evopilot_v01_',same=(a:unknown,b:unknown)=>canonicalEvidence(a)===canonicalEvidence(b);
type Action='online_configure'|'online_worker';
interface Journal {schema:'runtime-online-operator-request/v1';configurationDigest:string;intentDigest:string;action:Action;args:Record<string,unknown>;state:'PREPARED'|'DISPATCHING'|'COMPLETE'|'UNKNOWN';material?:OnlineConfigurationMaterial;worker?:OnlineWorkerSelection;nonce?:string;before?:Record<string,unknown>;result?:Record<string,unknown>;lastError?:string;}
export function openOnlineOperator(selected:WorkspaceOperatorConfiguration,configurationDigest:string,fresh:()=>WorkspaceOperatorConfiguration,specification:(c:WorkspaceOperatorConfiguration)=>UserServiceSpecification):WorkspaceOperatorRoutes {
  const control=path.join(selected.selection.serviceRoot+'.evopilot-operations','online'),requestRef=(id:string)=>path.join(control,id+'.json');
  const id={type:'string' as const,pattern:'^[a-z0-9][a-z0-9-]{0,63}$'},object=(properties:Record<string,object>)=>({type:'object' as const,properties,required:Object.keys(properties),additionalProperties:false});
  const definitions:Tool[]=selected.calls.filter(v=>v==='online_configure'||v==='online_worker').map(v=>({name:prefix+v,description:v==='online_configure'?'Configure the explicitly granted project online connections. Requires an active session for a new request and a stopped worker; stops the selected Runtime and deactivates this session. Resume the same retained request after interruption. Does not select or start monitoring.':'Inspect the independent owned worker passively, or start/stop/uninstall it from an active session. Original interrupted operations are inspected without redispatch; findings remain review-required.',inputSchema:v==='online_configure'?object({settings:{type:'object'},expectedDigest:{type:['string','null']},requestId:id}):object({operation:{enum:['inspect','start','stop','uninstall']},requestId:id}),annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false}}));
  function parse(name:string,input:unknown){
    if(!definitions.some(t=>t.name===name))reject('WORKSPACE_OPERATOR_FORBIDDEN','This online operation is not granted',403);
    const action=name.slice(prefix.length) as Action,args=record(input);exact(args,action==='online_configure'?['settings','expectedDigest','requestId']:['operation','requestId']);slug(args.requestId);
    if(action==='online_configure'){validateOnlineSettings(args.settings);if(args.expectedDigest!==null&&(typeof args.expectedDigest!=='string'||!/^sha256:[a-f0-9]{64}$/.test(args.expectedDigest)))reject('ONLINE_CONFIGURATION_EXPECTATION','Use the original native configuration digest or null');}
    else if(!['inspect','start','stop','uninstall'].includes(String(args.operation)))reject('ONLINE_WORKER_ARGUMENTS','Use inspect, start, stop or uninstall');
    return{action,args};
  }
  function prior(action:Action,args:Record<string,unknown>):Journal|null{
    const ref=requestRef(String(args.requestId));if(!fs.existsSync(ref))return null;
    const raw=record(JSON.parse(readRegular(ref,8388608,true).toString()));exact(raw,['schema','configurationDigest','intentDigest','action','args','state','journalDigest'],['material','worker','nonce','before','result','lastError']);
    const {journalDigest,...j}=raw;if(digest(j)!==journalDigest)reject('ONLINE_OPERATION_JOURNAL','The retained original online request changed',409);
    if(j.schema!=='runtime-online-operator-request/v1'||j.action!==action||!same(j.args,args)||j.intentDigest!==digest({configurationDigest:j.configurationDigest,action,args})||!['PREPARED','DISPATCHING','COMPLETE','UNKNOWN'].includes(String(j.state)))reject('REQUEST_CONFLICT','The original online request contains different input',409);
    if(j.state==='COMPLETE'&&(!j.result||typeof j.result!=='object'||Array.isArray(j.result)))reject('ONLINE_OPERATION_JOURNAL','The completed operation lacks its original result',409);
    if(j.configurationDigest!==configurationDigest){
      // A just-published successor Host may read the exact original configure
      // receipt. Other grants/requests cannot borrow this recovery authority.
      const m=j.material as OnlineConfigurationMaterial|undefined;
      if(action!=='online_configure'||!m||m.hostAfter.workspaceConfigDigest!==configurationDigest||m.selection.serviceRoot!==selected.selection.serviceRoot||m.selection.serviceId!==selected.selection.serviceId)reject('REQUEST_CONFLICT','This request belongs to another operator binding',409);
      inspectOnlineApplication(m);
    }
    return j as unknown as Journal;
  }
  const persist=(j:Journal)=>{mkdir(path.dirname(control));mkdir(control);save(requestRef(String(j.args.requestId)),{...j,journalDigest:digest(j)});};
  function currentWorker(c:WorkspaceOperatorConfiguration):OnlineWorkerSelection {
    const primary=c.online!.hosts.find(h=>h.connectionRef===c.connectionRef);if(!primary)reject('ONLINE_CONFIGURATION_SCOPE','The exact primary Host must be included in the operator grant');
    const owner=readLegacyOwnerHostConfiguration(primary.ownerConfigRef);if(digest(owner)!==primary.ownerConfigDigest||!owner.online)reject('ONLINE_CONFIGURATION_REQUIRED','Configure the original project online connections first',409);
    return selectOnlineWorker({serviceRoot:c.selection.serviceRoot,configuration:owner.online,hosts:c.online!.hosts});
  }
  function retainedWorker(c:WorkspaceOperatorConfiguration):OnlineWorkerSelection|null {
    const ref=path.join(c.selection.workspaceRoot+'.evopilot-online-worker','runtime-owner.json');if(!fs.existsSync(ref))return null;
    const s=readOnlineWorkerOwner(ref).selection;
    if(s.installation.serviceRoot!==c.selection.serviceRoot||s.installation.serviceId!==c.selection.serviceId||s.installation.workspaceId!==c.selection.workspaceId||s.installation.binding?.workspaceRoot!==c.selection.workspaceRoot||s.hosts.some(h=>!c.online!.hosts.some(g=>g.connectionRef===h.connectionRef)))reject('ONLINE_WORKER_SCOPE','The original worker is outside this explicit operator grant',403);
    return s;
  }
  async function observation(c:WorkspaceOperatorConfiguration){
    let configuration:ReturnType<typeof readOnlineConfiguration>|null=null,diagnostic:string|null=null,s=retainedWorker(c);
    try{const current=currentWorker(c);configuration=readOnlineConfiguration(current.configuration,c.selection.workspaceId);s??=current;}catch(e){diagnostic=e&&typeof e==='object'&&'code'in e?String(e.code):'ONLINE_CONFIGURATION_UNAVAILABLE';}
    return{configurationDigest:configuration?.digest??null,providerIds:configuration?.settings.prometheus.map(v=>v.id)??[],alertSourceIds:configuration?.settings.alertmanager.map(v=>v.id)??[],worker:s?await inspectOnlineWorker(s):null,diagnostic,authority:false};
  }
  async function recoverWorker(j:Journal):Promise<Record<string,unknown>>{
    if(!j.worker||!j.before||!j.nonce)reject('ONLINE_OPERATION_JOURNAL','The original operation is missing its selected worker');
    const o=await inspectOnlineWorker(j.worker),ref=path.join(onlineWorkerRoot(j.worker),'runtime-owner.json'),owner=fs.existsSync(ref)?readOnlineWorkerOwner(ref):null;
    if(j.args.operation==='start'){
      const expectedNonce=j.before.registered?j.before.nonce:j.nonce;
      if(o.registered&&o.matchesSelection&&owner?.nonce===expectedNonce)return{status:'VERIFIED',recovered:true,redispatched:false,operation:'start',worker:o,authority:false};
    }else if(!o.registered){
      let alive=false;if(typeof j.before.pid==='number')try{process.kill(j.before.pid,0);alive=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
      if(!alive)return{status:'VERIFIED',recovered:true,redispatched:false,operation:j.args.operation,worker:o,authority:false};
    }
    return{status:'UNKNOWN',operation:j.args.operation,worker:o,redispatched:false,nextAction:'inspect-original',authority:false};
  }
  return{definitions,has:name=>definitions.some(t=>t.name===name),requiresActiveSession(name,input){
    fresh();const {action,args}=parse(name,input);if(action==='online_worker'&&args.operation==='inspect')return false;return prior(action,args)===null;
  },deactivatesSession:name=>name===prefix+'online_configure',refreshesBinding:name=>name===prefix+'online_configure',async call(name,input,signal){
    signal?.throwIfAborted();const c=fresh(),{action,args}=parse(name,input);if(!c.online)reject('WORKSPACE_OPERATOR_FORBIDDEN','Online project bindings were not granted',403);
    if(action==='online_worker'&&args.operation==='inspect'){const result=await observation(c);fresh();return result;}
    const leaseContext={workspaceRoot:selected.selection.serviceRoot+'.evopilot-operations',workspaceId:c.selection.workspaceId};
    return withWorkspaceLease(leaseContext,String(args.requestId),async()=>{
      fresh();signal?.throwIfAborted();let j=prior(action,args);
      if(j?.state==='COMPLETE')return{...j.result,reused:true,currentEnvironmentVerified:false};
      if(action==='online_configure'){
        if(!j){
          const material=await prepareOnlineConfiguration({serviceRoot:c.selection.serviceRoot,settings:args.settings as never,expectedDigest:args.expectedDigest as string|null,requestId:String(args.requestId),hosts:c.online!.hosts});fresh();
          j={schema:'runtime-online-operator-request/v1',configurationDigest,intentDigest:digest({configurationDigest,action,args}),action,args,state:'PREPARED',material};persist(j);
        }
        if(!j.material)reject('ONLINE_OPERATION_JOURNAL','Retain the original configuration material');
        try{
          const already=inspectOnlineApplication(j.material);
          if(already.status!=='APPLIED'){
            // Refuse the worker before stopping Runtime. A loaded unknown job
            // must not be silently booted out as part of configuration.
            try{await requireRecoveryServicesStopped(c.selection);}catch(error){if(!error||typeof error!=='object'||!('code'in error)||error.code!=='SERVICE_ACTIVE')throw error;}
            fresh();signal?.throwIfAborted();await stopUserService(specification(c));fresh();
          }
          const result=await applyOnlineConfiguration(j.material,signal);fresh();j.state='COMPLETE';j.result={...result,requestId:args.requestId,sessionDeactivated:true};persist(j);return j.result;
        }catch(error){j.lastError=error&&typeof error==='object'&&'code'in error?String(error.code):'ONLINE_CONFIGURATION_FAILED';persist(j);throw error;}
      }
      if(j){const result=await recoverWorker(j);fresh();j.state=result.status==='VERIFIED'?'COMPLETE':'UNKNOWN';j.result=result;persist(j);return result;}
      const worker=args.operation==='start'?currentWorker(c):retainedWorker(c)??currentWorker(c),before=await inspectOnlineWorker(worker),ref=path.join(onlineWorkerRoot(worker),'runtime-owner.json'),owner=fs.existsSync(ref)?readOnlineWorkerOwner(ref):null;fresh();
      j={schema:'runtime-online-operator-request/v1',configurationDigest,intentDigest:digest({configurationDigest,action,args}),action,args,state:'DISPATCHING',worker,nonce:randomUUID(),before:{registered:before.registered,pid:before.pid,nonce:owner?.nonce??null}};persist(j);
      try{
        signal?.throwIfAborted();const result=args.operation==='start'?await startOnlineWorker(worker,j.nonce):await stopOnlineWorker(worker,args.operation==='uninstall');fresh();
        j.state='COMPLETE';j.result={status:'VERIFIED',operation:args.operation,worker:result,requestId:args.requestId,reused:false,authority:false};persist(j);return j.result;
      }catch(error){j.state='UNKNOWN';j.lastError=error&&typeof error==='object'&&'code'in error?String(error.code):'ONLINE_WORKER_OPERATION_UNKNOWN';persist(j);throw error;}
    },signal);
  }};
}
