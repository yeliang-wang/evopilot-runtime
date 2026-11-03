/** First-use operator composition. Exact installed permission, retained setup,
 * original backup, binding and selected service state; no lifecycle activation
 * or business work. Only the local installation entry can expose these tools. */
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import {canonical,canonicalEvidence,digest,exact,record,reject,ServiceError,string} from '../../server/errors.js';
import {readHostConnection,readPrivateJson} from '../../server/security.js';
import {readRegular} from '../../compat/project/files.js';
import {withWorkspaceLease} from '../../compat/workspace-lease.js';
import {acquireLegacyWriterLease} from '../../compat/managed-store.js';
import {readWorkspaceSetupConfiguration,type WorkspaceSetupConfiguration} from '../../host/setup.js';
import type {WorkspaceOperatorRoutes,HostConnectionSelection} from '../../host/workspace.js';
import {verifyInstalledRuntimePackage,type RuntimeInstallPlan} from '../installer.js';
import {inspectUserService,stopUserService,startUserService,type UserServiceSpecification} from '../service.js';
import {inspectLegacyWorkspace,verifyLegacyBackup,type LegacyBackup} from '../migration.js';
import {prepareWorkspaceSetup} from './bootstrap.js';
import {bindPreparedWorkspace,type WorkspaceBindingRequest} from './binding.js';
import {openWorkspaceOperator} from './operator.js';
import {copyInventory,mkdir,save} from './backup.js';
import {maintenanceLocation,present,requireRecoveryServicesStopped,separateRoots} from './snapshot.js';

const prefix='evopilot_v01_',setupNames=[prefix+'workspace_initialize',prefix+'workspace_attach'];
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const json=(file:string)=>record(JSON.parse(readRegular(file,33554432,true).toString()));
const code=(error:unknown)=>error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^[A-Z_]{1,64}$/.test(error.code)?error.code:'WORKSPACE_SETUP_FAILED';
interface Journal {
  schema:'runtime-workspace-onboarding/v1';configurationDigest:string;intentDigest:string;
  requestId:string;coreId:string;mode:'initialize'|'attach';status:'PREPARED'|'SETUP'|'BACKUP'|'BINDING'|'BOUND'|'VERIFIED'|'INTERRUPTED';
  prepared:Record<string,unknown>|null;backup:LegacyBackup|null;binding:WorkspaceBindingRequest|null;
  bound:Record<string,unknown>|null;result:Record<string,unknown>|null;lastError:string|null;
}
const empty={type:'object' as const,properties:{},additionalProperties:false};
function setupDefinitions():Tool[]{
  const p={type:'string' as const,minLength:1,maxLength:4096},requestId={type:'string' as const,pattern:'^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$'};
  return[
    ...['initialize','attach'].map(mode=>({name:prefix+'workspace_'+mode,description:'Explicitly '+mode+' the exact protected project and owner Workspace. Stop the selected independent service, retain the original backup and binding, then apply its preselected running/stopped state. Does not activate this session or dispatch business work. Preserve the original request after interruption.',inputSchema:{type:'object' as const,properties:{projectRoot:p,stateRoot:p,workspaceId:p,requestId},required:mode==='attach'?['projectRoot','stateRoot','workspaceId','requestId']:['requestId'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false}})),
    {name:prefix+'workspace_inspect',description:'Passively inspect this installed first-use selection and retained binding. Never initialize, start a service or activate a session.',inputSchema:empty,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
  ];
}
function scope(c:WorkspaceSetupConfiguration,name:string,input:unknown){
  const args=record(input),mode=name===setupNames[0]?'initialize':'attach';
  exact(args,mode==='attach'?['projectRoot','stateRoot','workspaceId','requestId']:['requestId'],mode==='initialize'?['projectRoot','stateRoot','workspaceId']:[]);
  const requestId=string(args.requestId,64);if(!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(requestId))reject('INVALID_REQUEST','Use the retained setup request ID');
  if((args.projectRoot??c.projectRoot)!==c.projectRoot||(args.stateRoot??c.workspaceRoot)!==c.workspaceRoot||(args.workspaceId??c.workspaceId)!==c.workspaceId)reject('SETUP_SCOPE','This installation cannot switch its selected project or Workspace',403);
  return{requestId,mode:mode as 'initialize'|'attach',projectRoot:c.projectRoot,stateRoot:c.workspaceRoot,workspaceId:c.workspaceId};
}
function boundResult(value:unknown,c:WorkspaceSetupConfiguration):Record<string,unknown>{
  const result=record(value),{resultDigest,reused,currentEnvironmentVerified,...body}=result,binding=record(body.binding);
  if(body.schema!=='runtime-workspace-binding-result/v1'||digest(body)!==resultDigest||body.status!=='BOUND'||binding.workspaceRoot!==c.workspaceRoot||binding.workspaceId!==c.workspaceId||binding.serviceId!==c.serviceId||body.originalInstallationPlanDigest!==c.installationPlanDigest||body.connectionDigest!==c.connectionDigest)reject('SETUP_RECEIPT_CHANGED','Original binding receipt differs');return result;
}
/** Recover a partial original Runtime backup from its retained inventory. No
 * rebasing to newer source bytes and no deleting a foreign partial are allowed. */
async function backup(c:WorkspaceSetupConfiguration,j:Journal,control:string,persist:()=>void,fresh:()=>void,signal?:AbortSignal):Promise<LegacyBackup>{
  const root=path.join(control,'backup-'+j.coreId),payload=path.join(root,'payload');
  return withWorkspaceLease({workspaceRoot:c.workspaceRoot,workspaceId:c.workspaceId},j.coreId,async()=>{
    fresh();signal?.throwIfAborted();await requireRecoveryServicesStopped(c);fresh();const lease=acquireLegacyWriterLease(c.workspaceRoot,c.workspaceId);
    try{
      if(!j.backup){const snapshot=inspectLegacyWorkspace(c.workspaceRoot,c.workspaceId),body={schema:'runtime-legacy-backup/v1' as const,snapshot};j.backup={...body,backupDigest:sha(canonicalEvidence(body))};persist();}
      const selected=j.backup;
      if(inspectLegacyWorkspace(c.workspaceRoot,c.workspaceId).snapshotDigest!==selected.snapshot.snapshotDigest)reject('SNAPSHOT_DRIFT','Original Workspace changed during the retained backup',409);
      mkdir(root);
      const entries=selected.snapshot.entries.map(e=>({...e,sha256:e.sha256??'',mode:e.kind==='directory'?0o700:0o600})).sort((a,b)=>a.path.localeCompare(b.path));
      copyInventory(c.workspaceRoot,payload,entries,j.coreId);fresh();signal?.throwIfAborted();
      if(inspectLegacyWorkspace(c.workspaceRoot,c.workspaceId).snapshotDigest!==selected.snapshot.snapshotDigest)reject('SNAPSHOT_DRIFT','Original Workspace changed during backup',409);
      save(path.join(root,'manifest.json'),selected,false);return verifyLegacyBackup(root,selected.backupDigest);
    }finally{lease.close();}
  },signal);
}

export function openWorkspaceSetupOperator(ref:string,expectedDigest:string):WorkspaceOperatorRoutes&{connectionSelection:()=>HostConnectionSelection}{
  const selected=readWorkspaceSetupConfiguration(ref);if(digest(selected)!==expectedDigest)reject('SETUP_CONFIGURATION_CHANGED','Installed setup grant changed');
  const control=selected.serviceRoot+'.evopilot-onboarding';maintenanceLocation(control,true);separateRoots([selected.projectRoot,selected.workspaceRoot,selected.serviceRoot,control]);
  const fresh=()=>{const c=readWorkspaceSetupConfiguration(ref);if(digest(c)!==expectedDigest)reject('SETUP_CONFIGURATION_CHANGED','Installed setup grant changed',409);if(Date.parse(c.expiresAt)<=Date.now())reject('SETUP_EXPIRED','Installed setup permission expired',403);if(digest(readHostConnection(c.connectionRef))!==c.connectionDigest)reject('SETUP_SCOPE','Installed connection identity changed',409);return c;};
  const latest=():Journal|null=>{if(!present(path.join(control,'selection.json')))return null;const s=json(path.join(control,'selection.json'));if(s.configurationDigest!==expectedDigest||typeof s.requestId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(s.requestId))reject('SETUP_RECEIPT_CHANGED','Retained setup selection differs');const j=json(path.join(control,'requests',s.requestId+'.json')) as unknown as Journal;if(j.schema!=='runtime-workspace-onboarding/v1'||j.configurationDigest!==expectedDigest||j.intentDigest!==s.intentDigest||j.requestId!==s.requestId)reject('SETUP_RECEIPT_CHANGED','Retained setup request differs');return j;};
  const maintenance=():WorkspaceOperatorRoutes|null=>{const c=fresh(),j=latest();if(!j?.bound||!c.workspaceOperator)return null;const b=boundResult(j.bound,c),owner=record(b.ownerHost);return openWorkspaceOperator(string(owner.workspaceConfigRef,4096),string(owner.workspaceConfigDigest,64));};
  const specification=(c:WorkspaceSetupConfiguration):UserServiceSpecification=>{
    const plan=readPrivateJson(path.join(c.serviceRoot,'installation-plan.json')) as RuntimeInstallPlan;
    if(digest(plan)!==c.installationPlanDigest)reject('SETUP_SCOPE','Original installation plan differs',409);
    const initial=verifyInstalledRuntimePackage(plan),spec=readPrivateJson(path.join(c.serviceRoot,'service-specification.json')) as UserServiceSpecification;
    if(digest(initial)!==c.specificationDigest||![c.specificationDigest,digest({...initial,legacyRef:path.join(c.serviceRoot,'legacy-binding.json')})].includes(digest(spec)))reject('SETUP_SCOPE','Current installation specification differs',409);return spec;
  };
  const tools=setupDefinitions();
  return{
    get definitions(){let extra:Tool[]=[];try{extra=maintenance()?.definitions??[];}catch{}return[...tools,...extra.filter(t=>t.name!==prefix+'workspace_inspect')];},
    has(name){return tools.some(t=>t.name===name)||Boolean(maintenance()?.has(name));},
    requiresActiveSession(name,input){return tools.some(t=>t.name===name)?false:maintenance()?.requiresActiveSession(name,input)??false;},
    deactivatesSession:name=>setupNames.includes(name)||Boolean(maintenance()?.deactivatesSession(name)),
    refreshesBinding:name=>setupNames.includes(name),
    connectionSelection(){const c=fresh(),j=latest();if(j?.bound)boundResult(j.bound,c);return{connectionRef:c.connectionRef,...(j?.bound&&c.ownerHost?{ownerConfigRef:c.ownerHost.ref,ownerConfigDigest:c.ownerHost.digest}:{})};},
    async call(name,input,signal){
      try{
        const c=fresh();signal?.throwIfAborted();
        if(name===prefix+'workspace_inspect'){
          exact(record(input),[]);const m=maintenance();if(m)return m.call(name,input,signal);
          const service=await inspectUserService(specification(c));fresh();const j=latest();return{schema:'runtime-workspace-setup-inspection/v1',configured:true,bound:Boolean(j?.bound),projectRoot:c.projectRoot,stateRoot:c.workspaceRoot,workspaceId:c.workspaceId,service,setupStatus:j?.status??'NOT_STARTED',serviceAfterSetup:c.serviceAfterSetup,serviceStarted:false,authority:false};
        }
        if(!setupNames.includes(name)){const m=maintenance();if(m?.has(name))return m.call(name,input,signal);reject('WORKSPACE_OPERATOR_FORBIDDEN','Operation was not selected',403);}
        const args=scope(c,name,input),intentDigest=digest({configurationDigest:expectedDigest,...args}),coreId='setup-'+intentDigest.slice(0,40);
        return await withWorkspaceLease({workspaceRoot:control,workspaceId:c.workspaceId},args.requestId,async()=>{
          fresh();signal?.throwIfAborted();let j=latest();
          if(j?.result&&j.status==='VERIFIED'){
            const result=record(j.result),{resultDigest,...body}=result;if(digest(body)!==resultDigest||body.intentDigest!==j.intentDigest)reject('SETUP_RECEIPT_CHANGED','Completed setup result changed');return{...result,reused:true,currentEnvironmentVerified:false};
          }
          if(j&&j.intentDigest!==intentDigest)reject('WORKSPACE_SETUP_PENDING','Continue the original setup request before choosing another',409);
          mkdir(control);mkdir(path.join(control,'requests'));const journalRef=path.join(control,'requests',args.requestId+'.json');
          if(!j){j={schema:'runtime-workspace-onboarding/v1',configurationDigest:expectedDigest,intentDigest,requestId:args.requestId,coreId,mode:args.mode,status:'PREPARED',prepared:null,backup:null,binding:null,bound:null,result:null,lastError:null};save(journalRef,j,false);save(path.join(control,'selection.json'),{schema:'runtime-workspace-onboarding-selection/v1',configurationDigest:expectedDigest,requestId:args.requestId,intentDigest,authority:false},false);}
          const journal=j,persist=()=>save(journalRef,journal);
          try{
            if(!journal.bound){
              await stopUserService(specification(c));fresh();signal?.throwIfAborted();
              if(!journal.prepared){journal.prepared=await prepareWorkspaceSetup({requestId:coreId,mode:journal.mode,projectRoot:c.projectRoot,workspaceRoot:c.workspaceRoot,workspaceId:c.workspaceId,serviceRoot:c.serviceRoot,owners:c.owners},signal,fresh);journal.status='SETUP';persist();}
              if(!journal.binding){
                const original=await backup(c,journal,control,persist,fresh,signal);journal.backup=original;journal.status='BACKUP';persist();
                journal.binding={schema:'runtime-workspace-binding/v1',requestId:coreId,serviceRoot:c.serviceRoot,setupRequestId:string(journal.prepared.requestId,64),setupResultDigest:string(journal.prepared.resultDigest,64),installationPlanDigest:c.installationPlanDigest,specificationDigest:c.specificationDigest,connectionDigest:c.connectionDigest,backupRoot:path.join(control,'backup-'+coreId),backupDigest:original.backupDigest,ownerHost:c.ownerHost,workspaceOperator:c.workspaceOperator,setupHost:{ref,digest:expectedDigest}};journal.status='BINDING';persist();
              }
              journal.bound=await bindPreparedWorkspace(journal.binding,signal,fresh);boundResult(journal.bound,c);journal.status='BOUND';persist();
            }
            fresh();signal?.throwIfAborted();const spec=specification(c),bound=boundResult(journal.bound,c);if(digest(spec)!==bound.specificationDigest)reject('SETUP_SCOPE','Bound service configuration differs');
            const service=c.serviceAfterSetup==='running'?await startUserService(spec):await inspectUserService(spec);fresh();signal?.throwIfAborted();
            if(c.serviceAfterSetup==='stopped'&&service.registered)reject('SERVICE_ACTIVE','Selected post-setup state requires a stopped service');
            const body={schema:'runtime-workspace-onboarding-result/v1',requestId:args.requestId,intentDigest,status:c.serviceAfterSetup==='running'?'READY':'BOUND',mode:journal.mode,projectRoot:c.projectRoot,stateRoot:c.workspaceRoot,workspaceId:c.workspaceId,serviceId:c.serviceId,binding:bound.binding,bindingResultDigest:bound.resultDigest,service,serviceAfterSetup:c.serviceAfterSetup,sessionActivated:false,businessWorkDispatched:false,authority:false,at:new Date().toISOString()},result={...body,resultDigest:digest(body)};
            journal.status='VERIFIED';journal.result=result;journal.lastError=null;persist();return{...result,reused:false,currentEnvironmentVerified:true};
          }catch(error){
            const failedPhase=journal.status;journal.status='INTERRUPTED';journal.lastError=code(error);persist();
            mkdir(path.join(control,'failures'));save(path.join(control,'failures',randomBytes(12).toString('hex')+'.json'),{schema:'runtime-workspace-onboarding-failure/v1',requestId:journal.requestId,intentDigest,phase:failedPhase,code:journal.lastError,at:new Date().toISOString(),automaticRedispatch:false},false);throw error;
          }
        },signal);
      }catch(error){if(error instanceof ServiceError)throw error;throw new ServiceError(code(error),'Inspect the retained first-use request and continue that exact request after repair; no business work was dispatched.',409);}
    },
  };
}
