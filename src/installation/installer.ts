#!/usr/bin/env node
import {execFile} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {constants,copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,readlinkSync,realpathSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {canonical,canonicalEvidence,digest,exact,record,reject,ServiceError,slug,string} from '../server/errors.js';
import {authenticate,ensurePrivateRoot,initializeCredentials,privateFile,readPrivateJson,tokenDigest,type Permission} from '../server/security.js';
import {runtimePluginMaterial} from '../host/plugin.js';
import {RuntimeStore} from '../server/store.js';
import {readLegacyBinding} from '../compat/gateway.js';
import {readLegacyOwnerHostConfiguration} from '../host/legacy-owners.js';
import {readLegacyProviderConfiguration} from '../compat/registered-providers.js';
import {adoptLegacyWorkspace,verifyLegacyBackup} from './migration.js';
import {inspectUserService,observeUserService,startUserService,stopUserService,type UserServiceSpecification} from './service.js';

type FilePin={type:'file';sha256:string;bytes:number;mode:number}|{type:'symlink';target:string};
interface Distribution {schema:'runtime-standalone-distribution/v1';version:string;archiveDigest:string;files:Record<string,FilePin>;}
export interface RuntimeInstallPlan {
  schema:'runtime-install-plan/v1';root:string;
  distribution:{packageRoot:string;manifestRef:string;manifestDigest:string;archiveRef:string;archiveDigest:string};
  nodeExecutable:string;nodeSha256:string;workspaceId:string;projectId:string;principalId:string;
  role:'reader'|'editor'|'activator';credentialExpiresAt:string;port:number;integrationsRef:string|null;
  codex:{executable:string;sha256:string;version:string}|null;
  legacyMigration?:{workspaceRoot:string;expectedSnapshotDigest:string;backupRoot:string;expectedBackupDigest:string}|null;
  legacyOwnerHost?:{ref:string;digest:string}|null;
  legacyProviders?:{ref:string;digest:string}|null;
}
export type InstallerCommand='stage'|'install'|'start'|'stop'|'inspect'|'uninstall';
const ROLES:Record<RuntimeInstallPlan['role'],Permission[]>={reader:['read'],editor:['read','draft.write'],activator:['read','draft.write','definition.activate']};
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
function absolute(path:string):string{string(path,4096);if(!isAbsolute(path)||resolve(path)!==path)reject('INSTALLATION_PATH','Use a canonical absolute path');return path;}
function existing(path:string):string{absolute(path);if(realpathSync(path)!==path)reject('INSTALLATION_PATH','Installation ancestors cannot be links');return path;}
function hash(value:unknown):string{const s=string(value,64);if(!/^[a-f0-9]{64}$/.test(s))reject('INSTALLATION_DIGEST','A SHA256 digest is required');return s;}
function entryExists(path:string):boolean{try{lstatSync(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
function exactFile(path:string,bytes:Buffer|string):void{
  if(existsSync(path)){privateFile(path);if(!readFileSync(path).equals(Buffer.from(bytes)))reject('INSTALLATION_CHANGED','Retained installation material differs; it will not be overwritten',409);}
  else writeFileSync(path,bytes,{mode:0o600,flag:'wx'});
}
function readDistribution(plan:RuntimeInstallPlan):Distribution{
  const config=plan.distribution;exact(record(config),['packageRoot','manifestRef','manifestDigest','archiveRef','archiveDigest']);
  existing(config.packageRoot);existing(config.manifestRef);existing(config.archiveRef);hash(config.manifestDigest);hash(config.archiveDigest);
  privateFile(config.manifestRef);const ms=lstatSync(config.manifestRef),archive=lstatSync(config.archiveRef);
  if(ms.size>8388608||!archive.isFile()||archive.nlink!==1||archive.size>268435456||(archive.mode&0o022)!==0)reject('INSTALLATION_DISTRIBUTION','Invalid bounded distribution material');
  const bytes=readFileSync(config.manifestRef);if(sha(bytes)!==config.manifestDigest||sha(readFileSync(config.archiveRef))!==config.archiveDigest)reject('INSTALLATION_DIGEST','Distribution or archive digest mismatch',409);
  const m=record(JSON.parse(bytes.toString('utf8')));exact(m,['schema','version','archiveDigest','files']);
  if(m.schema!=='runtime-standalone-distribution/v1'||m.archiveDigest!==config.archiveDigest)reject('INSTALLATION_DISTRIBUTION','The manifest must bind the selected original archive');
  string(m.version,128);const files=record(m.files),names=Object.keys(files);if(!names.length||names.length>20000)reject('INSTALLATION_DISTRIBUTION','Expected a bounded complete file inventory');
  for(const [name,value] of Object.entries(files)){
    if(!/^[A-Za-z0-9_@. /+-]+$/.test(name)||isAbsolute(name)||name.split('/').some(v=>!v||v==='.'||v==='..'))reject('INSTALLATION_DISTRIBUTION','Unsafe distribution path');
    const pin=record(value);
    if(pin.type==='file'){exact(pin,['type','sha256','bytes','mode']);hash(pin.sha256);if(!Number.isSafeInteger(pin.bytes)||Number(pin.bytes)<0||Number(pin.bytes)>33554432||![0o644,0o755].includes(Number(pin.mode)))reject('INSTALLATION_DISTRIBUTION','Invalid file inventory');}
    else if(pin.type==='symlink'){exact(pin,['type','target']);const target=string(pin.target,4096);if(isAbsolute(target)||!resolve(dirname(join(config.packageRoot,name)),target).startsWith(config.packageRoot+sep))reject('INSTALLATION_DISTRIBUTION','Distribution link escapes its package');}
    else reject('INSTALLATION_DISTRIBUTION','Unsupported distribution entry');
  }
  for(const required of ['package.json','dist/server/cli.js','dist/host/header-helper.js','plugins/codex/.codex-plugin/plugin.json','plugins/codex/mcp.template.json'])if(!files[required]||record(files[required]).type!=='file')reject('INSTALLATION_DISTRIBUTION','Required Runtime delivery entry is missing');
  const distribution=m as unknown as Distribution;verifyDistribution(config.packageRoot,distribution);return distribution;
}
function verifyDistribution(root:string,manifest:Distribution,allowMissing=false):void{
  existing(root);let count=0,total=0;
  function walk(dir:string):void{
    const ds=lstatSync(dir);if(!ds.isDirectory()||ds.isSymbolicLink()||(ds.mode&0o022)!==0)reject('INSTALLATION_DISTRIBUTION','Unsafe distribution directory');
    for(const name of readdirSync(dir)){
      const path=join(dir,name),key=relative(root,path).split(sep).join('/'),stat=lstatSync(path);
      if(stat.isDirectory()&&!stat.isSymbolicLink()){if(!Object.keys(manifest.files).some(v=>v.startsWith(key+'/')))reject('INSTALLATION_DISTRIBUTION','Unexpected installed directory');walk(path);continue;}
      const pin=manifest.files[key];if(!pin||++count>20000)reject('INSTALLATION_DISTRIBUTION','Unexpected installed file');
      if(pin.type==='symlink'){
        if(!stat.isSymbolicLink()||readlinkSync(path)!==pin.target)reject('INSTALLATION_DISTRIBUTION','Installed link differs from its manifest');
        if(existsSync(path)){if(!realpathSync(path).startsWith(root+sep))reject('INSTALLATION_DISTRIBUTION','Installed link escapes its package');}
        else if(!allowMissing)reject('INSTALLATION_DISTRIBUTION','Installed link has no target');
      }else{
        total+=stat.size;if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size!==pin.bytes||(stat.mode&0o777)!==pin.mode||total>536870912||sha(readFileSync(path))!==pin.sha256)reject('INSTALLATION_DISTRIBUTION','Installed file differs from its manifest');
      }
    }
  }
  walk(root);if(!allowMissing&&count!==Object.keys(manifest.files).length)reject('INSTALLATION_DISTRIBUTION','Installed distribution is incomplete');
  if(!allowMissing){const p=record(JSON.parse(readFileSync(join(root,'package.json'),'utf8')));if(p.name!=='@evopilot-next/runtime'||p.version!==manifest.version)reject('INSTALLATION_DISTRIBUTION','Installed package identity mismatch');}
}
function validatePlan(plan:RuntimeInstallPlan):void{
  exact(record(plan),['schema','root','distribution','nodeExecutable','nodeSha256','workspaceId','projectId','principalId','role','credentialExpiresAt','port','integrationsRef','codex'],['legacyMigration','legacyOwnerHost','legacyProviders']);
  if(plan.schema!=='runtime-install-plan/v1'||!Object.hasOwn(ROLES,plan.role)||!Number.isSafeInteger(plan.port)||plan.port<1024||plan.port>65535)reject('INSTALLATION_PLAN','Invalid installation parameters');
  absolute(plan.root);existing(plan.nodeExecutable);hash(plan.nodeSha256);slug(plan.workspaceId);slug(plan.projectId);slug(plan.principalId);
  if(!Number.isFinite(Date.parse(plan.credentialExpiresAt)))reject('INSTALLATION_PLAN','Choose an explicit credential expiration');
  if(plan.integrationsRef!==null){existing(plan.integrationsRef);readPrivateJson(plan.integrationsRef);}
  if(plan.codex!==null){exact(record(plan.codex),['executable','sha256','version']);existing(plan.codex.executable);hash(plan.codex.sha256);string(plan.codex.version,128);}
  if(plan.legacyMigration!=null){
    const migration=plan.legacyMigration;exact(record(migration),['workspaceRoot','expectedSnapshotDigest','backupRoot','expectedBackupDigest']);
    absolute(migration.workspaceRoot);absolute(migration.backupRoot);hash(migration.expectedSnapshotDigest);hash(migration.expectedBackupDigest);
    const roots=[plan.root,migration.workspaceRoot,migration.backupRoot];
    if(roots.some((a,i)=>roots.some((b,j)=>i!==j&&(a===b||a.startsWith(b+sep)))))reject('MIGRATION_BACKUP_PATH','Installation, original workspace and backup must be separate');
  }
  if(plan.legacyOwnerHost!=null){exact(record(plan.legacyOwnerHost),['ref','digest']);absolute(plan.legacyOwnerHost.ref);hash(plan.legacyOwnerHost.digest);if(!plan.legacyMigration)reject('MIGRATION_REQUIRED','Owner compatibility requires explicit migrated Runtime selection');}
  if(plan.legacyProviders!=null){exact(record(plan.legacyProviders),['ref','digest']);absolute(plan.legacyProviders.ref);hash(plan.legacyProviders.digest);if(!plan.legacyMigration)reject('MIGRATION_REQUIRED','Original providers require explicit migrated Runtime selection');}
}
function selectedBackup(plan:RuntimeInstallPlan):void{
  const migration=plan.legacyMigration;if(!migration)return;
  existing(migration.workspaceRoot);existing(migration.backupRoot);
  const backup=verifyLegacyBackup(migration.backupRoot,migration.expectedBackupDigest);
  if(backup.snapshot.workspaceRoot!==migration.workspaceRoot||backup.snapshot.workspaceId!==plan.workspaceId||backup.snapshot.snapshotDigest!==migration.expectedSnapshotDigest)reject('MIGRATION_BACKUP_CHANGED','Selected backup does not belong to this installation migration');
}
/** Adoption and its immutable seal belong to the operator. Holding the new
 * store's writer lock prevents an independent launch while we seal the old one.
 * A retry recovers the existing seal, never restores the original snapshot. */
async function prepareMigration(plan:RuntimeInstallPlan,spec:UserServiceSpecification):Promise<void>{
  const migration=plan.legacyMigration;if(!migration)return;selectedBackup(plan);
  const receiptRef=join(plan.root,'legacy-adoption.json'),bindingRef=spec.legacyRef!;
  if((await inspectUserService(spec)).running){
    const receipt=record(readPrivateJson(receiptRef)),seal=record(receipt.seal),binding=readLegacyBinding(bindingRef);
    exact(receipt,['binding','seal','authority']);
    exact(seal,['schema','workspaceRoot','workspaceId','serviceId','sourceSchemaVersion','sourceSnapshotDigest','backupRoot','backupDigest','sealedAt','migrationDigest']);
    const {migrationDigest,...body}=seal;
    if(seal.schema!=='runtime-legacy-adoption/v1'||digest(body)!==migrationDigest)reject('MIGRATION_BINDING_CHANGED','Retained adoption record integrity differs',409);
    if(receipt.authority!==false||canonical(receipt.binding)!==canonical(binding)||seal.workspaceRoot!==migration.workspaceRoot||seal.workspaceId!==plan.workspaceId||seal.sourceSnapshotDigest!==migration.expectedSnapshotDigest||seal.backupRoot!==migration.backupRoot||seal.backupDigest!==migration.expectedBackupDigest||seal.serviceId!==binding.serviceId||seal.migrationDigest!==binding.migrationDigest)reject('MIGRATION_BINDING_CHANGED','Running service has different retained migration material',409);
    await observeUserService(spec);return;
  }
  const store=new RuntimeStore(join(plan.root,'data'),plan.workspaceId);
  try{
    const adopted=adoptLegacyWorkspace({...migration,workspaceId:plan.workspaceId,serviceId:store.serviceId});
    exactFile(receiptRef,canonical(adopted)+'\n');
    exactFile(bindingRef,canonical(adopted.binding)+'\n');
  }finally{store.close();}
}
function bootstrap(plan:RuntimeInstallPlan):void{
  const tokenRef=join(plan.root,'client.json'),state=join(plan.root,'data');ensurePrivateRoot(state);
  if(!existsSync(tokenRef)){
    if(existsSync(join(state,'auth.json')))reject('INSTALLATION_CREDENTIAL','Existing authority has no matching retained client credential');
    if(Date.parse(plan.credentialExpiresAt)<=Date.now()||Date.parse(plan.credentialExpiresAt)>Date.now()+30*86400000)reject('INSTALLATION_CREDENTIAL','A new credential must expire within thirty days');
    exactFile(tokenRef,canonical({schema:'runtime-client-credential/v1',workspaceId:plan.workspaceId,projectId:plan.projectId,principalId:plan.principalId,token:randomBytes(32).toString('base64url')})+'\n');
  }
  const credential=record(readPrivateJson(tokenRef));exact(credential,['schema','workspaceId','projectId','principalId','token']);
  if(credential.schema!=='runtime-client-credential/v1'||credential.workspaceId!==plan.workspaceId||credential.projectId!==plan.projectId||credential.principalId!==plan.principalId)reject('INSTALLATION_CREDENTIAL','Retained client scope differs');
  const token=string(credential.token);if(!existsSync(join(state,'auth.json')))initializeCredentials(state,plan.workspaceId,[{id:plan.principalId,projects:[plan.projectId],permissions:ROLES[plan.role],revision:1,expiresAt:plan.credentialExpiresAt,tokenDigest:tokenDigest(token)}]);
  const principal=authenticate(state,plan.workspaceId,'Bearer '+token);if(principal.id!==plan.principalId||canonical(principal.projects)!==canonical([plan.projectId])||canonical(principal.permissions)!==canonical(ROLES[plan.role])||principal.expiresAt!==plan.credentialExpiresAt)reject('INSTALLATION_CREDENTIAL','Retained authority differs; installer will not replace it');
}
function stage(plan:RuntimeInstallPlan):UserServiceSpecification{
  selectedBackup(plan);
  if(plan.legacyProviders){const selected=readLegacyProviderConfiguration(plan.legacyProviders.ref);if(digest(selected)!==plan.legacyProviders.digest)reject('LEGACY_PROVIDER_CHANGED','Original provider selection differs from this immutable installation plan',409);if(selected.workspaceId!==plan.workspaceId||!selected.projects.includes(plan.projectId)||selected.legacyBindingRef!==join(plan.root,'legacy-binding.json'))reject('LEGACY_PROVIDER_SCOPE','Original provider selection must bind this exact installation migration',403);}
  if(plan.legacyOwnerHost){const selected=readLegacyOwnerHostConfiguration(plan.legacyOwnerHost.ref);if(digest(selected)!==plan.legacyOwnerHost.digest)reject('OWNER_HOST_CHANGED','Owner Host selection differs from this immutable installation plan',409);if(selected.workspaceId!==plan.workspaceId||selected.projectId!==plan.projectId||selected.legacyBindingRef!==join(plan.root,'legacy-binding.json'))reject('OWNER_HOST_SCOPE','Owner Host selection must bind this exact installation migration',403);}
  const manifest=readDistribution(plan),dest=join(plan.root,'package');
  if(!existsSync(dest))mkdirSync(dest,{mode:0o700});verifyDistribution(dest,manifest,true);
  const entries=Object.entries(manifest.files).sort((a,b)=>Number(a[1].type==='symlink')-Number(b[1].type==='symlink'));
  for(const [name,pin] of entries){const target=join(dest,name);if(entryExists(target))continue;mkdirSync(dirname(target),{recursive:true,mode:0o700});if(pin.type==='symlink')symlinkSync(pin.target,target);else copyFileSync(join(plan.distribution.packageRoot,name),target,constants.COPYFILE_EXCL);}
  verifyDistribution(dest,manifest);exactFile(join(plan.root,'distribution-manifest.json'),readFileSync(plan.distribution.manifestRef));bootstrap(plan);
  const spec=specification(plan,manifest.version);
  exactFile(join(plan.root,'service-specification.json'),canonical(spec)+'\n');return spec;
}
function specification(plan:RuntimeInstallPlan,version:string):UserServiceSpecification{return{schema:'runtime-user-service/v1',root:plan.root,packageRoot:join(plan.root,'package'),version,nodeExecutable:plan.nodeExecutable,nodeSha256:plan.nodeSha256,workspaceId:plan.workspaceId,projectId:plan.projectId,principalId:plan.principalId,tokenRef:join(plan.root,'client.json'),port:plan.port,integrationsRef:plan.integrationsRef,...(plan.legacyMigration?{legacyRef:join(plan.root,'legacy-binding.json')} :{}),...(plan.legacyProviders?{legacyProviders:plan.legacyProviders}:{})};}
function marketplaceName(root:string):string{return'evopilot-runtime-'+sha(root).slice(0,16);}
async function codex(plan:RuntimeInstallPlan,args:string[]):Promise<Record<string,unknown>>{
  const host=plan.codex;if(!host)reject('HOST_NOT_CONFIGURED','A specific Codex installation is required');
  const stat=lstatSync(host.executable);if(!stat.isFile()||(stat.mode&0o022)!==0||stat.size>268435456||sha(readFileSync(host.executable))!==host.sha256)reject('HOST_IDENTITY_CHANGED','Selected Codex executable changed');
  await new Promise<void>((resolve,rejectPromise)=>execFile(host.executable,['--version'],{encoding:'utf8',timeout:10000,maxBuffer:4096,shell:false},(error,stdout)=>{
    if(error||stdout.trim()!=='codex-cli '+host.version){rejectPromise(new ServiceError('HOST_IDENTITY_CHANGED','Selected Codex version differs from the installation plan'));return;}resolve();
  }));
  return new Promise((resolve,rejectPromise)=>execFile(host.executable,['-c','mcp_servers={}','plugin',...args,'--json'],{encoding:'utf8',timeout:30000,maxBuffer:2097152,shell:false},(error,stdout)=>{
    if(error){rejectPromise(new ServiceError('HOST_REGISTRATION_UNKNOWN','Inspect the existing plugin registration before repeating an installation',503));return;}
    try{resolve(record(JSON.parse(stdout)));}catch{rejectPromise(new ServiceError('HOST_RESPONSE_INVALID','Codex did not return the supported installation response',503));}
  }));
}
async function installedPlugin(plan:RuntimeInstallPlan):Promise<Record<string,unknown>|null>{
  const name=marketplaceName(plan.root),list=await codex(plan,['list','--marketplace',name]);
  if(!Array.isArray(list.installed))reject('HOST_RESPONSE_INVALID','Expected the supported installed-plugin inventory');
  const rows=list.installed.map(record);if(rows.length>1)reject('HOST_PLUGIN_CONFLICT','The Runtime marketplace contains unexpected installed entries');
  if(!rows.length)return null;const row=rows[0],source=record(row.source),market=record(row.marketplaceSource);
  if(row.pluginId!=='evopilot-runtime@'+name||row.name!=='evopilot-runtime'||source.source!=='local'||source.path!==join(plan.root,'plugin')||market.sourceType!=='local'||market.source!==plan.root)reject('HOST_PLUGIN_CONFLICT','An existing plugin registration belongs to a different installation');
  return row;
}
async function registerPlugin(plan:RuntimeInstallPlan,version:string):Promise<void>{
  let found=await installedPlugin(plan);
  if(!found){
    const inventory=await codex(plan,['marketplace','list']);if(!Array.isArray(inventory.marketplaces))reject('HOST_RESPONSE_INVALID','Expected the supported marketplace inventory');
    const selected=inventory.marketplaces.map(record).filter(v=>v.name===marketplaceName(plan.root));
    if(selected.length>1||selected.length===1&&(selected[0].root!==plan.root||record(selected[0].marketplaceSource).source!==plan.root))reject('HOST_PLUGIN_CONFLICT','The marketplace belongs to a different installation');
    if(!selected.length)await codex(plan,['marketplace','add',plan.root]);
    await codex(plan,['add','evopilot-runtime@'+marketplaceName(plan.root)]);found=await installedPlugin(plan);
  }
  if(!found||found.version!==version||found.installed!==true||found.enabled!==true)reject('HOST_PLUGIN_NOT_READY','Codex has not registered the matching enabled Runtime plugin',503);
}
function preparePlugin(plan:RuntimeInstallPlan,spec:UserServiceSpecification,serviceId:string):void{
  const connectionRef=join(plan.root,'connection.json');exactFile(connectionRef,canonical({schema:'runtime-host-connection/v1',origin:'http://127.0.0.1:'+plan.port,workspaceId:plan.workspaceId,projectId:plan.projectId,principalId:plan.principalId,serviceId,version:spec.version,tokenRef:spec.tokenRef})+'\n');
  const material=runtimePluginMaterial(spec.packageRoot,connectionRef,plan.nodeExecutable,plan.legacyMigration?(plan.legacyOwnerHost?{ownerConfigRef:plan.legacyOwnerHost.ref,ownerConfigDigest:plan.legacyOwnerHost.digest}:{}):undefined);
  for(const [name,bytes] of material.files){const p=join(plan.root,'plugin',name);mkdirSync(dirname(p),{recursive:true,mode:0o700});exactFile(p,bytes);}
  const catalog=join(plan.root,'.agents/plugins/marketplace.json');mkdirSync(dirname(catalog),{recursive:true,mode:0o700});exactFile(catalog,canonical({name:marketplaceName(plan.root),plugins:[{name:'evopilot-runtime',source:{source:'local',path:'./plugin'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'}}]})+'\n');
}
/** This is an explicit local operator entry, never a Runtime operation. A plan
 * is configuration, not release approval. Calling install may register exactly
 * this plugin when codex is selected; a null codex stages it without claiming a
 * Host installation. Neither branch marks actual Host acceptance complete. */
export async function runInstaller(plan:RuntimeInstallPlan,command:InstallerCommand):Promise<Record<string,unknown>>{
  validatePlan(plan);if(!['stage','install','start','stop','inspect','uninstall'].includes(command))reject('INSTALLER_COMMAND','Unsupported installer command');
  ensurePrivateRoot(plan.root);const planRef=join(plan.root,'installation-plan.json');
  if(!existsSync(planRef)&&readdirSync(plan.root).length)reject('INSTALLATION_NOT_OWNED','An unrecognized directory will not be adopted');
  exactFile(planRef,canonical(plan)+'\n');privateFile(join(plan.root,'installer-lock.sqlite'),true);const lock=new DatabaseSync(join(plan.root,'installer-lock.sqlite'));
  try{lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');}catch{lock.close();return reject('INSTALLER_ACTIVE','Another installer owns this directory',409);}
  const operation=randomUUID(),journal=join(plan.root,'installation-audit');
  const save=(name:string,value:unknown)=>exactFile(join(journal,operation+'-'+name+'.json'),canonicalEvidence(value)+'\n');
  try{
    ensurePrivateRoot(journal);save('request',{schema:'runtime-installation-operation/v1',operation,command,planDigest:sha(canonical(plan)),at:new Date().toISOString()});
    let spec:UserServiceSpecification;
    if(['stage','install','start'].includes(command))spec=stage(plan);else{
      spec=readPrivateJson(join(plan.root,'service-specification.json')) as UserServiceSpecification;
      if(canonical(spec)!==canonical(specification(plan,string(spec.version))))reject('INSTALLATION_CHANGED','Retained service specification differs from this installation');
    }
    let result:Record<string,unknown>;
    if(command==='stage')result={phase:'STAGED',version:spec.version,serviceStarted:false,hostRegistered:false};
    else if(command==='stop'||command==='uninstall'){
      const stopped=await stopUserService(spec);
      if(command==='uninstall'){
        if(plan.codex&&await installedPlugin(plan)){await codex(plan,['remove','evopilot-runtime@'+marketplaceName(plan.root)]);if(await installedPlugin(plan))reject('HOST_REMOVAL_UNKNOWN','Plugin registration remains after removal',503);}
        const plist=join(plan.root,'service.plist');if(existsSync(plist)){privateFile(plist);unlinkSync(plist);}
      }
      result={phase:command==='stop'?'STOPPED':'UNINSTALLED',service:stopped,dataRetained:true,packageRetained:true,auditRetained:true};
    }else if(command==='inspect')result={phase:'OBSERVED',service:await observeUserService(spec),hostRegistered:plan.codex?Boolean(await installedPlugin(plan)):false};
    else{
      await prepareMigration(plan,spec);
      const service=await startUserService(spec);preparePlugin(plan,spec,string(service.identity!.serviceId));
      if(command==='install'&&plan.codex)await registerPlugin(plan,spec.version);
      result={phase:'AWAITING_HOST_VERIFICATION',service,plugin:{path:join(plan.root,'plugin'),name:'evopilot-runtime',version:spec.version,transport:'streamable-http'},hostRegistered:command==='install'&&plan.codex!==null?true:null,hostVerification:'NOT_EVALUATED'};
    }
    const outcome={...result,operation,independentLlm:false,productAcceptance:'NOT_EVALUATED'};save('result',outcome);return outcome;
  }catch(error){save('failure',{operation,code:error instanceof ServiceError?error.code:'INSTALLATION_FAILED',at:new Date().toISOString(),retained:true,automaticRetry:false});throw error;}
  finally{lock.close();}
}
export async function installerMain(argv:string[],output:{write(v:string):unknown}=process.stdout):Promise<number>{
  try{
    const [command,flag,ref,...extra]=argv;if(extra.length||flag!=='--plan-ref'||!ref||!['stage','install','start','stop','inspect','uninstall'].includes(command))reject('INSTALLER_ARGUMENT','Use stage|install|start|stop|inspect|uninstall --plan-ref <protected exact plan>');
    existing(ref);const result=await runInstaller(readPrivateJson(ref) as RuntimeInstallPlan,command as InstallerCommand);output.write(canonicalEvidence(result)+'\n');return 0;
  }catch(error){output.write(canonical({error:{code:error instanceof ServiceError?error.code:'INSTALLATION_FAILED',message:error instanceof ServiceError?error.message:'Inspect the retained installation evidence before continuing'}})+'\n');return 1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await installerMain(process.argv.slice(2));
