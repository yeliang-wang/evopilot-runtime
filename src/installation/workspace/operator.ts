/** Local operator implementation. Only the explicitly configured installation
 * bootstrap injects these routes into stdio; Runtime HTTP cannot import them. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import {canonical,digest,exact,record,reject,ServiceError,string} from '../../server/errors.js';
import {readHostConnection,readPrivateJson} from '../../server/security.js';
import {readLegacyBinding} from '../../compat/gateway.js';
import {withWorkspaceLease} from '../../compat/workspace-lease.js';
import {acquireQuiescentManagedContext} from '../../compat/managed-store.js';
import {canonicalPath,readRegular} from '../../compat/project/files.js';
import {readWorkspaceOperatorConfiguration,type WorkspaceCall,type WorkspaceOperatorConfiguration,type WorkspaceOperatorRoutes} from '../../host/workspace.js';
import {inspectUserService,stopUserService,type UserServiceSpecification} from '../service.js';
import {inspectManagedWorkspace,maintenanceLocation,present,separateRoots,validateSelection,requireRecoveryServicesStopped} from './snapshot.js';
import {createManagedWorkspaceBackup,verifyManagedWorkspaceBackup,restoreManagedWorkspaceBackup,mkdir,save,type ManagedBackup} from './backup.js';
import {relocateManagedWorkspace} from './relocation.js';
import {inspectMaintenanceTree,maintenanceJSONDigest,MAINTENANCE_BUDGET} from './stream.js';
import {inspectWorkspaceToolchain,startToolchainPreparation} from '../toolchain/preparation.js';

const prefix='evopilot_v01_',hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const roots=(c:WorkspaceOperatorConfiguration)=>[c.selection.projectRoot,c.selection.workspaceRoot,c.selection.serviceRoot];
const slug=(v:unknown)=>{const s=string(v,64);if(!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(s))reject('INVALID_REQUEST','Expected a stable request ID');return s;};
const errorCode=(error:unknown)=>error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^[A-Z_]{1,64}$/.test(error.code)?error.code:'WORKSPACE_OPERATION_FAILED';
const summary=(b:ManagedBackup)=>({schema:b.schema,requestId:b.requestId,backupRoot:b.backupRoot,backupDigest:b.backupDigest,snapshotDigest:b.snapshot.snapshotDigest,selection:b.snapshot.selection,coverage:b.snapshot.coverage,requiredKeyIds:b.snapshot.requiredKeyIds,files:Object.fromEntries(Object.entries(b.snapshot.roots).map(([r,entries])=>[r,{entries:entries.length,bytes:entries.reduce((n,e)=>n+e.bytes,0)}])),authority:false});
interface OperationJournal {
  schema:'runtime-workspace-operator-request/v1';intentDigest:string;status:'PREPARED'|'STOPPED'|'EXECUTING'|'INTERRUPTED'|'VERIFIED';
  snapshotDigest:string|null;backupRoot:string|null;backupDigest:string|null;result:Record<string,unknown>|null;lastError:string|null;
}
function definitions(config:WorkspaceOperatorConfiguration):Tool[]{
  const value={type:'string' as const,minLength:1,maxLength:4096},id={type:'string' as const,pattern:'^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$'},object=(properties:Record<string,object>,required=Object.keys(properties))=>({type:'object' as const,properties,required,additionalProperties:false});
  const schemas={workspace_inspect:object({}),workspace_capacity:object({}),workspace_backup:object({destinationRoot:value,requestId:id}),workspace_backup_inspect:object({backupRoot:value,requestId:id}),workspace_restore:object({backupRoot:value,requestId:id}),workspace_migrate:object({destinationProjectRoot:value,destinationStateRoot:value,destinationServiceRoot:value,requestId:id},['destinationProjectRoot','destinationStateRoot','requestId']),toolchain_inspect:object({}),toolchain_prepare:object({requestId:{type:'string',pattern:'^[a-z0-9][a-z0-9-]{0,63}$'}})};
  const descriptions={workspace_inspect:'Inspect the configured local installation and Workspace without starting a service or creating files. This is not a consistent preservation snapshot.',workspace_capacity:'Read bounded selected project, owner-state and service file counts/digests. A live inventory is not a consistent backup.',workspace_backup:'Stop the exact configured Runtime service and create a consistent three-root backup. The original request is retained; the compatibility session is deactivated. Does not restart or dispatch business work.',workspace_backup_inspect:'Verify the exact backup against its retained external anchor without starting services. Only backups of this selected Workspace are accepted.',workspace_restore:'Restore an anchored backup only into its missing/empty original roots. A rescue entry can operate while Runtime is offline. Retain original requests; never restart or redispatch.',workspace_migrate:'Stop the configured Runtime, retain a consistent backup, and relocate all three selected roots. For the original two-destination call, the service copy defaults to destinationStateRoot + .evopilot-runtime. Explicit destinationServiceRoot overrides that default. Preserve original history; attachment/start is separate.'};
  const allDescriptions={...descriptions,toolchain_inspect:'Passively verify the bundled lock and selected local dependency bytes; inspect the original preparation without downloads or service activation.',toolchain_prepare:'Stop the exact selected Runtime and prepare only bundled pinned dependencies. Returns a retained status before downloads finish and deactivates this session. Inspect progress; never replace a RUNNING/UNKNOWN request. Does not restart the service or dispatch business work.'};
  return config.calls.map(call=>({name:prefix+call,description:allDescriptions[call],inputSchema:schemas[call],annotations:{readOnlyHint:['workspace_inspect','workspace_capacity','workspace_backup_inspect','toolchain_inspect'].includes(call),destructiveHint:['workspace_backup','workspace_restore','workspace_migrate','toolchain_prepare'].includes(call),idempotentHint:true,openWorldHint:call==='toolchain_prepare'}}));
}
/** Digest is pinned in the installed entry. Editing a file is not permission to
 * widen an already connected Host. The selection is rechecked after awaits. */
export function openWorkspaceOperator(ref:string,expectedDigest:string):WorkspaceOperatorRoutes {
  if(!/^[a-f0-9]{64}$/.test(expectedDigest))reject('WORKSPACE_OPERATOR_CONFIGURATION','Expected the exact selected operator digest');
  const selected=readWorkspaceOperatorConfiguration(ref);
  if(digest(selected)!==expectedDigest)reject('WORKSPACE_OPERATOR_CHANGED','Workspace operator configuration changed',409);
  const control=selected.selection.serviceRoot+'.evopilot-operations';
  maintenanceLocation(control,true);separateRoots([...roots(selected),control,selected.selection.workspaceRoot+'.evopilot-maintenance']);
  const fresh=()=>{
    const c=readWorkspaceOperatorConfiguration(ref);
    if(digest(c)!==expectedDigest)reject('WORKSPACE_OPERATOR_CHANGED','Workspace operator configuration changed',409);
    if(Date.parse(c.expiresAt)<=Date.now())reject('WORKSPACE_OPERATOR_EXPIRED','The selected local operator permission expired',403);
    return c;
  };
  const specification=(c:WorkspaceOperatorConfiguration):UserServiceSpecification=>{
    const file=path.join(c.selection.serviceRoot,'service-specification.json'),spec=readPrivateJson(file) as UserServiceSpecification;
    if(digest(spec)!==c.specificationDigest||spec.root!==c.selection.serviceRoot||spec.workspaceId!==c.selection.workspaceId||spec.legacyRef!==path.join(c.selection.serviceRoot,'legacy-binding.json'))reject('WORKSPACE_OPERATOR_SCOPE','Selected installation specification changed',409);
    const connection=readHostConnection(c.connectionRef),binding=readLegacyBinding(spec.legacyRef);
    if(connection.serviceId!==c.selection.serviceId||connection.workspaceId!==c.selection.workspaceId||connection.projectId!==spec.projectId||connection.principalId!==spec.principalId||connection.tokenRef!==spec.tokenRef||connection.origin!=='http://127.0.0.1:'+spec.port)reject('WORKSPACE_OPERATOR_SCOPE','Selected installation identity differs',409);
    for(const key of ['workspaceRoot','workspaceId','serviceId','migrationDigest'] as const)if(binding[key]!==c.selection[key])reject('WORKSPACE_OPERATOR_SCOPE','Selected managed binding differs',409);
    return spec;
  };
  const backup=(c:WorkspaceOperatorConfiguration,root:string)=>{
    maintenanceLocation(root);const anchor=record(JSON.parse(readRegular(path.join(c.selection.workspaceRoot+'.evopilot-maintenance','known-backups',hash(root)+'.json'),32768,true).toString()));
    exact(anchor,['schema','requestId','backupRoot','backupDigest','snapshotDigest']);
    if(anchor.schema!=='runtime-managed-backup-anchor/v1'||anchor.backupRoot!==root)reject('MAINTENANCE_BACKUP_UNKNOWN','This backup has no matching original anchor');
    const verified=verifyManagedWorkspaceBackup(root,string(anchor.backupDigest,64));
    if(canonical(verified.snapshot.selection)!==canonical(c.selection)||verified.requestId!==anchor.requestId||verified.snapshot.snapshotDigest!==anchor.snapshotDigest)reject('MAINTENANCE_BACKUP_UNKNOWN','Backup belongs to a different selected Workspace');return verified;
  };
  const destination=(c:WorkspaceOperatorConfiguration,value:unknown)=>{
    const root=string(value,4096);maintenanceLocation(root,true);separateRoots([...roots(c),control,c.selection.workspaceRoot+'.evopilot-maintenance',root]);return root;
  };
  const tools=definitions(selected);
  return{definitions:tools,has:name=>tools.some(t=>t.name===name),requiresActiveSession(name,input){
      if(![prefix+'workspace_backup',prefix+'workspace_migrate'].includes(name))return false;
      fresh();const args=record(input),requestId=slug(args.requestId),file=path.join(control,'requests',requestId+'.json');
      if(!present(file))return true;
      const prior=record(JSON.parse(readRegular(file,2097152,true).toString()));
      if(prior.schema!=='runtime-workspace-operator-request/v1'||prior.intentDigest!==maintenanceJSONDigest({configurationDigest:expectedDigest,name,args}))reject('MAINTENANCE_CONFLICT','Retained request differs');
      return false;
    },deactivatesSession:name=>[prefix+'workspace_backup',prefix+'workspace_migrate',prefix+'workspace_restore',prefix+'toolchain_prepare'].includes(name),
    async call(name,input,signal){
      try{
        signal?.throwIfAborted();const c=fresh(),action=name.slice(prefix.length) as WorkspaceCall,args=record(input);
        if(!tools.some(t=>t.name===name))reject('WORKSPACE_OPERATOR_FORBIDDEN','This local operation was not selected',403);
        if(action==='toolchain_inspect'||action==='toolchain_prepare'){
          exact(args,action==='toolchain_prepare'?['requestId']:[]);validateSelection(c.selection);const spec=specification(c);
          const context={workspaceRoot:c.selection.workspaceRoot,workspaceId:c.selection.workspaceId,installationDigest:digest({specificationDigest:c.specificationDigest,configurationDigest:expectedDigest})};
          if(action==='toolchain_inspect'){const result=inspectWorkspaceToolchain(context);fresh();return result;}
          const result=await startToolchainPreparation(context,string(args.requestId,64),work=>withWorkspaceLease({workspaceRoot:context.workspaceRoot,workspaceId:context.workspaceId},String(args.requestId),async()=>{
            fresh();signal?.throwIfAborted();await stopUserService(spec);fresh();await requireRecoveryServicesStopped(c.selection);fresh();signal?.throwIfAborted();
            const {workspaceRoot,workspaceId,serviceId,migrationDigest}=c.selection;
            const lease=acquireQuiescentManagedContext({workspaceRoot,workspaceId,serviceId,migrationDigest});
            try{await work();}finally{lease.close();}
          },signal));
          return{...result,serviceStarted:false,businessWorkDispatched:false};
        }
        if(['workspace_inspect','workspace_capacity'].includes(action)){
          exact(args,[]);
          if(action==='workspace_inspect'){
            const presentRoots=Object.fromEntries(['projectRoot','workspaceRoot','serviceRoot'].map(key=>[key,present(c.selection[key as 'projectRoot'])]));
            const service=present(path.join(c.selection.serviceRoot,'service-specification.json'))?await inspectUserService(specification(c)):null;fresh();
            return{schema:'runtime-workspace-inspection/v1',selection:c.selection,roots:presentRoots,service,configured:true,consistentSnapshot:false,serviceStarted:false,authority:false};
          }
          validateSelection(c.selection);specification(c);
          const inventory=(root:string)=>{const entries=inspectMaintenanceTree(root);return{entries:entries.length,bytes:entries.reduce((n,e)=>n+e.bytes,0),largestFileBytes:entries.reduce((n,e)=>e.kind==='file'?Math.max(n,e.bytes):n,0),links:entries.filter(e=>e.kind==='symlink').length,inventoryDigest:maintenanceJSONDigest(entries)};};
          const result={schema:'runtime-workspace-capacity/v1',project:inventory(c.selection.projectRoot),state:inventory(c.selection.workspaceRoot),service:inventory(c.selection.serviceRoot),limits:MAINTENANCE_BUDGET,consistentSnapshot:false,requiresQuiescentMaintenance:true,authority:false};fresh();return result;
        }
        if(action==='workspace_backup_inspect'){exact(args,['backupRoot','requestId']);slug(args.requestId);const result=summary(backup(c,string(args.backupRoot,4096)));fresh();return result;}
        if(action==='workspace_backup')exact(args,['destinationRoot','requestId']);
        else if(action==='workspace_restore')exact(args,['backupRoot','requestId']);
        else exact(args,['destinationProjectRoot','destinationStateRoot','requestId'],['destinationServiceRoot']);
        const requestId=slug(args.requestId),intentDigest=maintenanceJSONDigest({configurationDigest:expectedDigest,name,args}),core='operator-'+intentDigest.slice(0,40);
        // A separate local-command lease must not nest the owner workspace's
        // shared lease, which the actual maintenance primitives acquire.
        return await withWorkspaceLease({workspaceRoot:control,workspaceId:c.selection.workspaceId},requestId,async()=>{
          fresh();mkdir(control);mkdir(path.join(control,'requests'));const journalPath=path.join(control,'requests',requestId+'.json');let journal:OperationJournal;
          if(present(journalPath)){
            journal=JSON.parse(readRegular(journalPath,2097152,true).toString()) as OperationJournal;
            exact(record(journal),['schema','intentDigest','status','snapshotDigest','backupRoot','backupDigest','result','lastError']);
            if(journal.schema!=='runtime-workspace-operator-request/v1'||journal.intentDigest!==intentDigest||!['PREPARED','STOPPED','EXECUTING','INTERRUPTED','VERIFIED'].includes(journal.status))reject('MAINTENANCE_CONFLICT','Retained request has different input');
            if(journal.status==='VERIFIED'){const result=record(journal.result),{resultDigest,...body}=result;if(resultDigest!==maintenanceJSONDigest(body)||body.intentDigest!==intentDigest)reject('MAINTENANCE_CONFLICT','Retained result differs');return result;}
          }else{journal={schema:'runtime-workspace-operator-request/v1',intentDigest,status:'PREPARED',snapshotDigest:null,backupRoot:null,backupDigest:null,result:null,lastError:null};save(journalPath,journal,false);}
          try{
            let value:unknown;
            if(action==='workspace_restore'){
              const verified=backup(c,string(args.backupRoot,4096));
              try{await requireRecoveryServicesStopped(c.selection);}catch(error){if(errorCode(error)!=='SERVICE_ACTIVE')throw error;await stopUserService(specification(c));await requireRecoveryServicesStopped(c.selection);}
              fresh();signal?.throwIfAborted();
              journal.status='EXECUTING';save(journalPath,journal);value=await restoreManagedWorkspaceBackup(verified.backupRoot,verified.backupDigest,core+'-restore',signal);
            }else{
              const backupRoot=action==='workspace_backup'?destination(c,args.destinationRoot):path.join(control,'backups',core);
              const targets=action==='workspace_migrate'?{projectRoot:destination(c,args.destinationProjectRoot),workspaceRoot:destination(c,args.destinationStateRoot),serviceRoot:destination(c,args.destinationServiceRoot??string(args.destinationStateRoot,4096)+'.evopilot-runtime')}:null;
              if(targets)separateRoots(Object.values(targets));
              await stopUserService(specification(c));fresh();signal?.throwIfAborted();journal.status='STOPPED';save(journalPath,journal);
              if(!journal.snapshotDigest){journal.snapshotDigest=(await inspectManagedWorkspace(c.selection,core+'-inspect',signal)).snapshotDigest;save(journalPath,journal);}
              if(action==='workspace_migrate')mkdir(path.join(control,'backups'));
              journal.status='EXECUTING';save(journalPath,journal);
              const saved=await createManagedWorkspaceBackup(c.selection,core+'-backup',journal.snapshotDigest,backupRoot,signal);fresh();journal.backupRoot=backupRoot;journal.backupDigest=saved.backupDigest;save(journalPath,journal);
              value=targets?await relocateManagedWorkspace({source:c.selection,destination:targets,requestId:core+'-migrate',backupRoot,backupDigest:saved.backupDigest,owners:c.owners,ownerHost:{...c.ownerHost,workspaceConfigRef:ref,workspaceConfigDigest:expectedDigest}},signal):summary(saved);
            }
            fresh();const body={schema:'runtime-workspace-operator-result/v1',requestId,intentDigest,action,value,completedAt:new Date().toISOString(),serviceStarted:false,businessWorkDispatched:false,authority:false};
            const result={...body,resultDigest:maintenanceJSONDigest(body)};save(journalPath,{...journal,status:'VERIFIED',result,lastError:null});return result;
          }catch(error){journal.status='INTERRUPTED';journal.lastError=errorCode(error);save(journalPath,journal);throw error;}
        },signal);
      }catch(error){if(error instanceof ServiceError)throw error;throw new ServiceError(errorCode(error),'Inspect the original local maintenance request and retained result before retrying; no automatic restart or business redispatch occurred.',409);}
    }
  };
}
