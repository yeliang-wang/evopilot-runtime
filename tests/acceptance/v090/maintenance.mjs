// Installed-package maintenance evidence. Every mutation is limited to explicit
// new acceptance roots; neither the daily installation nor its Host is selected.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const sha=value=>createHash('sha256').update(value).digest('hex');
const object=(value,required,optional=[])=>{assert(value&&typeof value==='object'&&!Array.isArray(value));assert(required.every(k=>Object.hasOwn(value,k)));assert(Object.keys(value).every(k=>required.includes(k)||optional.includes(k)));};
function canonical(filename,missing=false){assert(path.isAbsolute(filename)&&path.resolve(filename)===filename);assert.equal(fs.realpathSync(missing?path.dirname(filename):filename),missing?path.dirname(filename):filename);return filename;}
function protectedBytes(filename,maximum=131072){canonical(filename);const stat=fs.lstatSync(filename);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.uid===process.getuid()&&(stat.mode&0o777)===0o600&&stat.size<=maximum,'Expected a bounded protected reference');return fs.readFileSync(filename);}
const json=filename=>JSON.parse(protectedBytes(filename));
function put(filename,value){fs.writeFileSync(filename,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});}
function credentialValues(installedRoot){const ref=path.join(installedRoot,'client.json');if(!fs.existsSync(ref))return[];const value=json(ref);return typeof value.token==='string'?[value.token]:[];}
function safe(value,installedRoot){let text=JSON.stringify(value);for(const secret of credentialValues(installedRoot))text=text.replaceAll(secret,'[REDACTED]');text=text.replace(/(authorization|cookie|set-cookie|x-runtime-csrf)(\s*:\s*)[^\r\n"}]+/gi,'$1$2[REDACTED]');assert(Buffer.byteLength(text)<=2097152,'Maintenance evidence record exceeds 2 MiB');return JSON.parse(text);}
function recorder(run,installedRoot){return(name,value)=>run.artifact(name,safe(value,installedRoot));}
function isolatedHome(run,codexHome,installedRoot){
 canonical(codexHome,true);assert(codexHome!==installedRoot&&!codexHome.startsWith(installedRoot+path.sep));
 const marker={schema:'runtime-acceptance-host-home/v1',runId:run.selection.runId,candidateDigest:run.candidateDigest,installedRoot},ref=path.join(codexHome,'runtime-acceptance-owner.json');
 if(fs.existsSync(codexHome)){canonical(codexHome);assert.equal(fs.lstatSync(codexHome).mode&0o777,0o700);assert.deepEqual(json(ref),marker,'Only this original acceptance Host home may be reused');}
 else{fs.mkdirSync(codexHome,{mode:0o700});put(ref,marker);}
 return{...process.env,CODEX_HOME:codexHome};
}
async function execute(executable,args,{cwd,env,timeout=45000}={}){
 return new Promise(resolve=>execFile(executable,args,{cwd,env,encoding:'utf8',timeout,maxBuffer:2097152,shell:false},(error,stdout,stderr)=>resolve({exitCode:error?typeof error.code==='number'?error.code:null:0,signal:error?.signal??null,timedOut:!!error?.killed,stdout,stderr})));
}
async function selectedHost(codex){
 const executable=canonical(codex.executable),pin=codex.executableSha256??codex.sha256;assert(/^[a-f0-9]{64}$/.test(pin));const stat=fs.lstatSync(executable);assert(stat.isFile()&&(stat.mode&0o022)===0&&stat.size<=268435456);assert.equal(sha(fs.readFileSync(executable)),pin);
 const observed=await execute(executable,['--version'],{timeout:10000});assert.equal(observed.exitCode,0);assert.equal(observed.signal,null);const version=observed.stdout.trim();assert(/^codex-cli [A-Za-z0-9.+-]+$/.test(version));if(codex.version)assert.equal(version,'codex-cli '+codex.version);
 return{executable,sha256:pin,version:version.slice('codex-cli '.length)};
}

/** Real App Server plugin discovery and tool invocation, without a model turn.
 * Credentials remain in the installed header helper and protected Host home.
 * Unsupported authority requests are rejected rather than automatically approved. */
export async function openInstalledHost(run,{installedRoot,codexHome,codex,nodeExecutable,projectId,workspaceId,serviceId,version,expectedServers=['evopilot_runtime'],allowLegacyGoalCreate=false}){
 canonical(installedRoot);const host=await selectedHost(codex),env=isolatedHome(run,codexHome,installedRoot),save=recorder(run,installedRoot);
 assert.equal(host.version,JSON.parse(fs.readFileSync(new URL('../../../governance/environment-contract-v090.json',import.meta.url))).hostVersion);
 assert(expectedServers.length>0&&expectedServers.every(v=>['evopilot_runtime','evopilot_runtime_legacy'].includes(v))&&new Set(expectedServers).size===expectedServers.length);
 const connection=json(path.join(installedRoot,'connection.json'));assert.equal(connection.projectId,projectId);assert.equal(connection.workspaceId,workspaceId);assert.equal(connection.serviceId,serviceId);assert.equal(connection.version,version);
 const plugin=path.join(installedRoot,'plugin'),marketplacePath=path.join(installedRoot,'.agents/plugins/marketplace.json'),market=json(marketplacePath),pluginId='evopilot-runtime@'+market.name;
 const child=spawn(host.executable,['app-server','-c','mcp_servers={}','-c','features.apps=false','-c','features.multi_agent=false'],{cwd:codexHome,env,stdio:['pipe','pipe','pipe']});
 const pending=new Map(),frames=[];let serial=0,bytes=0,stderr='',fatal=null,closing=false,closed=false,threadId,inspection;
 const retain=value=>{const cleaned=safe(value,installedRoot),length=Buffer.byteLength(JSON.stringify(cleaned));bytes+=length;assert(bytes<=8388608,'Actual Host transcript exceeds 8 MiB');frames.push(cleaned);};
 const abort=error=>{fatal??=Error('Actual isolated Codex Host failed ('+String(error?.code??error?.name??'transport')+')');for(const item of pending.values()){clearTimeout(item.timer);item.reject(fatal);}pending.clear();};
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>{if(!closing)abort(Error('Host exited'));resolve({code,signal});}));
 child.on('error',abort);child.stdin.on('error',error=>{if(!closing)abort(error);});
 child.stderr.on('data',chunk=>{stderr+=chunk.toString();if(Buffer.byteLength(stderr)>131072){stderr=stderr.slice(-32768);abort(Error('Host stderr bound exceeded'));}});
 const lines=createInterface({input:child.stdout});
 lines.on('line',line=>{try{assert(Buffer.byteLength(line)<=2097152,'Host frame exceeds 2 MiB');const message=JSON.parse(line);
  if(message.id!==undefined&&pending.has(message.id)){const item=pending.get(message.id);pending.delete(message.id);clearTimeout(item.timer);retain({direction:'response',method:item.method,...message});if(message.error)item.reject(Error('Actual Host API rejected '+item.method+' ('+String(message.error.code??'unknown')+')'));else item.resolve(message.result);}
  else if(message.id!==undefined){retain({direction:'host-request',method:message.method,accepted:false});child.stdin.write(JSON.stringify({id:message.id,error:{code:-32601,message:'This exact isolated maintenance probe grants no additional authority'}})+'\n');}
  else retain({direction:'notification',method:message.method});
 }catch(error){abort(error);}});
 const call=async(method,params)=>{
  assert(['initialize','plugin/read','thread/start','mcpServerStatus/list','mcpServer/tool/call'].includes(method),'Only discovery and selected tool calls are available');if(fatal)throw fatal;
  const id=++serial;retain({direction:'request',id,method,params});return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('Actual Host request timeout: '+method));},45000);pending.set(id,{resolve,reject,timer,method});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 };
 const inspect=async()=>{
  const deadline=Date.now()+30000;let observations=0;
  for(;;){
   const discovery=await call('mcpServerStatus/list',{threadId,detail:'full'}),servers=(discovery.data??[]).filter(row=>Object.keys(row.tools??{}).length).map(row=>({name:row.name,pluginId:row.pluginId,runtimeStatus:row.runtimeStatus,httpOrigin:row.httpOrigin??null,serverInfo:row.serverInfo??null,tools:Object.keys(row.tools??{}).sort()}));
   observations++;assert(servers.every(row=>expectedServers.includes(row.name)&&row.pluginId===pluginId),'No unrelated Host capability may participate');
   const ready=expectedServers.every(name=>servers.some(row=>row.name===name&&row.runtimeStatus==='connected'));
   if(ready||Date.now()>=deadline){const result={...inspection,servers,threadId,actualCodexHost:true,actualModelTurn:false,registeredPluginIdentity:pluginId,discoveryObservations:observations};save('maintenance-host-discovery.json',result);assert(ready,'Selected Host servers did not become connected within the bounded read-only discovery wait');return result;}
   // Host discovery is asynchronous. Observe the original startup, never
   // reinstall, re-register or dispatch a tool to manufacture readiness.
   await new Promise(resolve=>setTimeout(resolve,250));
  }
 };
 const tool=async(server,name,args)=>{
  assert(expectedServers.includes(server));
  if(server==='evopilot_runtime'){assert.equal(name,'runtime_read');assert.equal(args.projectId,projectId);assert(!args.requestId);}
  else{
   assert(['evopilot_v01_inspect','evopilot_v01_activate','evopilot_v01_deactivate','evopilot_v01_capabilities','evopilot_v01_request','evopilot_v01_native'].includes(name));
   if(name.endsWith('_request')||name.endsWith('_native')){const e=args.envelope;assert.equal(e.scope.projectId,projectId);const reading=['workspace.inspect','project.inspect','goal.inspect','run.inspect','receipt.inspect','native.package.readback','native.receipt.inspect','standard.inspect','readiness.assessment.read'].includes(e.operation),validate=['ontology','harness'].includes(args.owner)&&e.operation==='native.package.validate',goal=allowLegacyGoalCreate&&args.owner==='runtime'&&name==='evopilot_v01_request'&&e.operation==='goal.create';assert(reading||validate||goal,'The exact E15 read/technical validation or explicitly selected synthetic goal is required');}
  }
  const result=await call('mcpServer/tool/call',{threadId,server,tool:name,arguments:args});save('maintenance-host-tool.json',{server,tool:name,arguments:args,result,actualModelTurn:false});return result;
 };
 const close=async()=>{if(closed)return;closed=true;closing=true;for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('Host closing'));}pending.clear();
  let timer,hardTimer;try{if(child.exitCode===null&&child.signalCode===null){child.stdin.end();timer=setTimeout(()=>child.kill('SIGTERM'),3000);hardTimer=setTimeout(()=>child.kill('SIGKILL'),8000);}const outcome=await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(Error('Owned Host exit was not observed')),12000).unref())]);save('maintenance-host-cleanup.json',{hostStopped:true,outcome,frames,stderr,fatal:fatal?.message??null,dailyHostChanged:false,actualModelTurn:false});}
  finally{clearTimeout(timer);clearTimeout(hardTimer);lines.close();}
 };
 try{
  const identity=await call('initialize',{clientInfo:{name:'runtime-e14-e15-installed-maintenance',version:'1'},capabilities:{experimentalApi:true}});retain({kind:'host-identity',identity});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized',params:{}})+'\n');
  const details=await call('plugin/read',{marketplacePath,pluginName:'evopilot-runtime'});assert.equal(details.plugin.summary.id,pluginId);assert.equal(details.plugin.summary.source.path,plugin);assert.equal(details.plugin.summary.localVersion,version);
  const skill=details.plugin.skills.find(value=>value.path===path.join(plugin,'skills/evopilot-runtime-expert/SKILL.md'));assert(skill?.enabled,'Actual Host must resolve the installed Expert Skill');
  const skillBytes=protectedBytes(skill.path,65536),published=fs.readFileSync(path.join(installedRoot,'package/plugins/codex/skills/evopilot-runtime-expert/SKILL.md'));assert.deepEqual(skillBytes,published);
  inspection={pluginId,host:{...host},skill:{name:skill.name,path:skill.path,sha256:sha(skillBytes),enabled:true},skillResolvedByActualHost:true,skillBytesVerifiedAgainstPackage:true,expertDialogueCompleted:false};
  const started=await call('thread/start',{cwd:codexHome,ephemeral:true,approvalPolicy:'on-request',sandbox:'read-only',selectedCapabilityRoots:[{id:pluginId,location:{type:'environment',environmentId:'local',path:plugin}}],developerInstructions:'Exact installed Runtime acceptance transport probe. No model turn, shell, business execution, publication or daily installation change. Use only the selected plugin and this isolated project; preserve all original receipts.'});threadId=started.thread.id;
  await inspect();return{inspect,call,tool,close};
 }catch(error){await close();throw error;}
}

export function openMaintenance(run){
 const selection=run.selection.maintenance;object(selection,['root','casePlans']);canonical(selection.root,true);assert(!fs.existsSync(selection.root),'Use a new maintenance campaign root');assert(!selection.root.startsWith(run.selection.installedRoot+path.sep));const parent=fs.lstatSync(path.dirname(selection.root));assert(parent.isDirectory()&&parent.uid===process.getuid()&&(parent.mode&0o022)===0,'Select an owned non-writable-by-others maintenance parent');
 assert(Object.keys(selection.casePlans).length===run.cases.length&&run.cases.every(c=>Object.hasOwn(selection.casePlans,c.caseInstanceId)));
 fs.mkdirSync(selection.root,{mode:0o700});put(path.join(selection.root,'campaign.json'),{schema:'runtime-e14-maintenance-campaign/v1',runId:run.selection.runId,candidateDigest:run.candidateDigest,caseIds:run.cases.map(c=>c.caseInstanceId)});
 return{async create(c){
  const item=selection.casePlans[c.caseInstanceId];object(item,['planRef','planSha256','codexHome']);const bytes=protectedBytes(item.planRef);assert.equal(sha(bytes),item.planSha256);const plan=JSON.parse(bytes),caseRoot=path.join(selection.root,c.caseInstanceId);assert.equal(plan.schema,'runtime-install-plan/v1');assert.equal(plan.root,path.join(caseRoot,'installation'));assert.equal(item.codexHome,path.join(caseRoot,'codex'));assert(!item.planRef.startsWith(selection.root+path.sep));
  assert(plan.codex,'E14 requires real installer plugin registration; codex:null is not qualification');assert(['editor','activator','operator'].includes(plan.role),'Retention verification needs the declared isolated draft-write permission');assert.equal(plan.distribution.manifestDigest,run.candidate.manifestDigest);assert.equal(plan.distribution.archiveDigest,run.candidate.archiveDigest);assert(!plan.legacyMigration&&!plan.legacyOwnerHost&&!plan.legacyProviders&&!plan.workspaceOperator&&!plan.workspaceSetup,'E14 may not adopt historical state');
  const selected=await selectedHost(plan.codex);assert.equal(selected.version,JSON.parse(fs.readFileSync(new URL('../../../governance/environment-contract-v090.json',import.meta.url))).hostVersion);canonical(plan.nodeExecutable);assert.equal(sha(fs.readFileSync(plan.nodeExecutable)),plan.nodeSha256);
  fs.mkdirSync(caseRoot,{mode:0o700});const env=isolatedHome(run,item.codexHome,plan.root),save=recorder(run,plan.root),hosts=new Set();let lastInstallation=null,closed=false;
  const command=async(command,allowFailure=false)=>{assert(['stage','install','start','stop','inspect','uninstall'].includes(command));assert.equal(sha(protectedBytes(item.planRef)),item.planSha256);const result=await execute(plan.nodeExecutable,[path.join(plan.distribution.packageRoot,'dist/installation/installer.js'),command,'--plan-ref',item.planRef],{cwd:caseRoot,env,timeout:90000});save('maintenance-installer.json',{command,planRef:item.planRef,planSha256:item.planSha256,result});assert.equal(result.signal,null,'Installer interrupted; inspect original audit before retry');assert.equal(result.timedOut,false);let value;try{value=JSON.parse(result.stdout);}catch{throw Error('Installer did not return its bounded JSON receipt');}if(!allowFailure)assert.equal(result.exitCode,0,'Native installer failed: '+String(value.error?.code));if(result.exitCode===0&&value.service?.identity)lastInstallation=value;return{...result,body:value};};
  const module=async name=>{assert(['host/client','host/plugin','installation/service','installation/service-control'].includes(name));assert(fs.existsSync(path.join(plan.root,'distribution-manifest.json')));assert.equal(sha(protectedBytes(path.join(plan.root,'distribution-manifest.json'),8388608)),run.candidate.manifestDigest);return import(pathToFileURL(path.join(plan.root,'package/dist',name+'.js')).href);};
  const client=async(ref=path.join(plan.root,'connection.json'))=>(await module('host/client')).createRuntimeHttpClient(ref);
  const read=async(operation,input={})=>{const result=await(await client()).request({operation,projectId:plan.projectId,input});save('maintenance-native-read.json',{operation,input,result});return result.result;};
  const write=async(operation,input,requestId,expectedRevision)=>{assert.equal(operation,'lifecycle.draft.save');const result=await(await client()).request({operation,projectId:plan.projectId,input,requestId,expectedRevision});save('maintenance-native-write.json',{operation,input,requestId,expectedRevision,result});return result.result;};
  const host=async()=>{assert(lastInstallation?.service?.identity);const opened=await openInstalledHost(run,{installedRoot:plan.root,codexHome:item.codexHome,codex:plan.codex,nodeExecutable:plan.nodeExecutable,projectId:plan.projectId,workspaceId:plan.workspaceId,serviceId:lastInstallation.service.identity.serviceId,version:run.candidate.version});hosts.add(opened);return opened;};
  const closeHosts=async()=>{for(const opened of hosts)await opened.close();hosts.clear();};
  const fingerprints=()=>{const paths=['data/service.sqlite','client.json','data/auth.json','installation-plan.json','distribution-manifest.json'];return Object.fromEntries(paths.filter(name=>fs.existsSync(path.join(plan.root,name))).map(name=>[name,sha(fs.readFileSync(path.join(plan.root,name)))]));};
  const close=async()=>{if(closed)return;closed=true;await closeHosts();if(!fs.existsSync(path.join(plan.root,'service-specification.json')))return;
   if(fs.existsSync(path.join(plan.root,'connection.json'))){const current=(await module('installation/service-control')).inspectInstalledServiceSelection(plan.root);assert.equal(current.distributionManifestDigest,run.candidate.manifestDigest);assert.equal(current.serviceRoot,plan.root);save('maintenance-final-installed-selection.json',{current,packageBytesVerified:true});}
   await command('stop');const before=fingerprints(),auditBefore=fs.readdirSync(path.join(plan.root,'installation-audit')).sort();const removed=await command('uninstall');assert.equal(removed.body.phase,'UNINSTALLED');assert.equal(removed.body.dataRetained,true);assert.equal(removed.body.auditRetained,true);assert.equal(removed.body.service.registered,false);assert.deepEqual(fingerprints(),before);assert(auditBefore.every(name=>fs.existsSync(path.join(plan.root,'installation-audit',name))));
   const inventory=await execute(plan.codex.executable,['-c','mcp_servers={}','plugin','list','--marketplace','evopilot-runtime-'+sha(plan.root).slice(0,16),'--json'],{cwd:caseRoot,env});assert.equal(inventory.exitCode,0);assert.deepEqual(JSON.parse(inventory.stdout).installed,[]);save('maintenance-retained-uninstall.json',{before,after:fingerprints(),originalAuditRetained:true,registeredPluginRemoved:true,ownedServiceStopped:true,rootsPreserved:true});
  };
  save('maintenance-exact-plan.json',{planRef:item.planRef,planSha256:item.planSha256,plan,hostHome:item.codexHome,candidateDigest:run.candidateDigest,syntheticIsolatedMaintenance:true,dailyInstallationChanged:false});
  return{plan,caseRoot,codexHome:item.codexHome,save,command,module,client,read,write,host,closeHosts,close,fingerprints,execute:async(args)=>{const result=await execute(plan.nodeExecutable,args,{cwd:caseRoot,env,timeout:15000});save('maintenance-owned-command.json',{executable:plan.nodeExecutable,args,result});return result;}};
 }};
}
